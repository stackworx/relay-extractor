import { GraphQLSchema, type DocumentNode, concatAST, visit, TypeInfo, visitWithTypeInfo, isObjectType, isScalarType, getNamedType } from 'graphql';
import { optimizeAndFlatten } from './transform.js';

export interface FieldUsageResult {
  usedFieldsByType: Record<string, string[]>;
  aliasesByType: Record<string, Record<string, string[]>>;
  unusedFieldsByType: Record<string, string[]>;
}

export function unused(schema: GraphQLSchema, documents: DocumentNode[]): FieldUsageResult {
  const merged = concatAST(documents);
  const optimized = optimizeAndFlatten(schema, merged);
  const usedMap = new Map<string, Set<string>>();
  const aliasMap = new Map<string, Map<string, Set<string>>>();

  const typeInfo = new TypeInfo(schema);
  visit(
    optimized,
    visitWithTypeInfo(typeInfo, {
      Field(node) {
        const parent = typeInfo.getParentType();

        // Only track field usage on concrete object types.
        // Interfaces, unions, and other non-object parent types are ignored
        // intentionally, since the report focuses on GraphQLObjectType fields.
        if (!parent || !isObjectType(parent)) {
            return;
        }
        const typeName = parent.name;
        const fieldName = node.name.value;
        // Ignore Relay/GraphQL meta fields such as __typename and other __*
        if (fieldName.startsWith('__')) {
          return;
        }
        const aliasName = node.alias?.value;

        let typeFields = usedMap.get(typeName);
        if (!typeFields) {
          typeFields = new Set<string>();
          usedMap.set(typeName, typeFields);
        }
        typeFields.add(fieldName);

        if (aliasName) {
          let typeAliases = aliasMap.get(typeName);
          if (!typeAliases) {
            typeAliases = new Map<string, Set<string>>();
            aliasMap.set(typeName, typeAliases);
          }
          let fieldAliases = typeAliases.get(fieldName);
          if (!fieldAliases) {
            fieldAliases = new Set<string>();
            typeAliases.set(fieldName, fieldAliases);
          }
          fieldAliases.add(aliasName);
        }
      },
    }),
  );

  const usedFieldsByType: Record<string, string[]> = {};
  for (const [typeName, fields] of usedMap.entries()) {
    usedFieldsByType[typeName] = Array.from(fields);
  }

  const aliasesByType: Record<string, Record<string, string[]>> = {};
  for (const [typeName, fieldsMap] of aliasMap.entries()) {
    const inner: Record<string, string[]> = {};
    for (const [fieldName, aliases] of fieldsMap.entries()) {
      inner[fieldName] = Array.from(aliases);
    }
    aliasesByType[typeName] = inner;
  }

  const unusedFieldsByType: Record<string, string[]> = {};
  const typeMap = schema.getTypeMap();
  for (const typeName in typeMap) {
    if (!Object.prototype.hasOwnProperty.call(typeMap, typeName)) continue;
    const type = typeMap[typeName];
    if (!isObjectType(type)) continue;
    if (typeName.startsWith('__')) continue;
    const fields = type.getFields();
    const allFieldNames = Object.keys(fields);
    const usedSet = usedMap.get(typeName) ?? new Set<string>();
    const edgesUsed = usedSet.has('edges');
    const unused = allFieldNames.filter((f) => {
      // If edges are used on a connection, do not report pageInfo as unused
      if (edgesUsed && f === 'pageInfo') return false;
      // Do not report scalar 'cursor' fields as unused
      if (f === 'cursor') {
        const field = fields[f];
        const named = getNamedType(field.type);
        if (isScalarType(named)) return false;
      }
      return !usedSet.has(f);
    });
    unusedFieldsByType[typeName] = unused;
  }

  return { usedFieldsByType, aliasesByType, unusedFieldsByType };
}
