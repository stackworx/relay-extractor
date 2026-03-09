import {
  GraphQLSchema,
  type DocumentNode,
  visit,
  TypeInfo,
  visitWithTypeInfo,
  isObjectType,
  isScalarType,
  getNamedType,
  parse,
  print,
  printSchema,
  lexicographicSortSchema,
  Kind,
  type FieldDefinitionNode,
  type DirectiveDefinitionNode,
  type DirectiveNode,
  type StringValueNode,
} from 'graphql';

export interface FieldUsageResult {
  usedFieldsByType: Record<string, string[]>;
  aliasesByType: Record<string, Record<string, string[]>>;
  unusedFieldsByType: Record<string, string[]>;
}

export interface AnnotateUnusedSchemaOptions {
  /**
   * How to annotate unused fields.
   * - `deprecated`: adds `@deprecated(reason: ...)` (default)
   * - `directive`: adds a custom directive (e.g. `@unused(reason: ...)`)
   */
  mode?: 'deprecated' | 'directive';

  /** Used when `mode === 'directive'`. */
  directiveName?: string;

  /** Reason string stored in the annotation. */
  reason?: string;

  /** When `mode === 'directive'`, add the directive definition to the SDL if missing. */
  addDirectiveDefinition?: boolean;
}

const DEFAULT_UNUSED_REASON = 'relay-extractor: unused';

function makeStringValue(value: string): StringValueNode {
  return { kind: Kind.STRING, value };
}

function makeDirective(name: string, reason?: string): DirectiveNode {
  return {
    kind: Kind.DIRECTIVE,
    name: { kind: Kind.NAME, value: name },
    arguments: reason
      ? [
          {
            kind: Kind.ARGUMENT,
            name: { kind: Kind.NAME, value: 'reason' },
            value: makeStringValue(reason),
          },
        ]
      : [],
  };
}

function hasDirective(node: FieldDefinitionNode, directiveName: string): boolean {
  return (node.directives ?? []).some((d) => d.name.value === directiveName);
}

function makeUnusedDirectiveDefinition(name: string): DirectiveDefinitionNode {
  return {
    kind: Kind.DIRECTIVE_DEFINITION,
    name: { kind: Kind.NAME, value: name },
    repeatable: false,
    arguments: [
      {
        kind: Kind.INPUT_VALUE_DEFINITION,
        name: { kind: Kind.NAME, value: 'reason' },
        type: {
          kind: Kind.NAMED_TYPE,
          name: { kind: Kind.NAME, value: 'String' },
        },
        directives: [],
      },
    ],
    locations: [
      {
        kind: Kind.NAME,
        value: 'FIELD_DEFINITION',
      },
    ],
    directives: [],
  };
}

/**
 * Returns schema SDL with unused fields annotated.
 *
 * This does not attempt to preserve original schema formatting; it prints and re-parses SDL.
 */
export function annotateSchemaSDLWithUnusedFields(
  schemaSDL: string,
  unusedFieldsByType: Record<string, string[]>,
  options: AnnotateUnusedSchemaOptions = {},
): string {
  const mode = options.mode ?? 'deprecated';
  const reason = options.reason ?? DEFAULT_UNUSED_REASON;
  const directiveName = mode === 'directive' ? options.directiveName ?? 'unused' : 'deprecated';
  const addDirectiveDefinition = options.addDirectiveDefinition ?? true;

  const unusedSetByType = new Map<string, Set<string>>(
    Object.entries(unusedFieldsByType).map(([typeName, fields]) => [typeName, new Set(fields)]),
  );

  const schemaDoc = parse(schemaSDL);
  const updatedDoc = visit(schemaDoc, {
    ObjectTypeDefinition(node) {
      const typeUnused = unusedSetByType.get(node.name.value);
      if (!typeUnused || !node.fields || node.fields.length === 0) return;

      const fields = node.fields.map((field) => {
        if (!typeUnused.has(field.name.value)) return field;
        if (mode === 'deprecated') {
          if (hasDirective(field, 'deprecated')) return field;
          return {
            ...field,
            directives: [...(field.directives ?? []), makeDirective('deprecated', reason)],
          };
        }

        if (hasDirective(field, directiveName)) return field;
        return {
          ...field,
          directives: [...(field.directives ?? []), makeDirective(directiveName, reason)],
        };
      });

      return {
        ...node,
        fields,
      };
    },
    ObjectTypeExtension(node) {
      const typeUnused = unusedSetByType.get(node.name.value);
      if (!typeUnused || !node.fields || node.fields.length === 0) return;

      const fields = node.fields.map((field) => {
        if (!typeUnused.has(field.name.value)) return field;
        if (mode === 'deprecated') {
          if (hasDirective(field, 'deprecated')) return field;
          return {
            ...field,
            directives: [...(field.directives ?? []), makeDirective('deprecated', reason)],
          };
        }

        if (hasDirective(field, directiveName)) return field;
        return {
          ...field,
          directives: [...(field.directives ?? []), makeDirective(directiveName, reason)],
        };
      });

      return {
        ...node,
        fields,
      };
    },
  });

  if (mode === 'directive' && addDirectiveDefinition) {
    const hasDef = updatedDoc.definitions.some(
      (d) => d.kind === Kind.DIRECTIVE_DEFINITION && d.name.value === directiveName,
    );
    if (!hasDef) {
      return print({
        ...updatedDoc,
        definitions: [makeUnusedDirectiveDefinition(directiveName), ...updatedDoc.definitions],
      });
    }
  }

  return print(updatedDoc);
}

/**
 * Convenience: compute unused fields from documents and return annotated schema SDL.
 */
export function annotateSchemaWithUnusedFields(
  schema: GraphQLSchema,
  documents: DocumentNode[],
  options: AnnotateUnusedSchemaOptions = {},
): string {
  const report = unused(schema, documents);
  const baseSDL = printSchema(lexicographicSortSchema(schema));
  return annotateSchemaSDLWithUnusedFields(baseSDL, report.unusedFieldsByType, options);
}

/**
 * Mutates the given schema in-place by setting `deprecationReason` on unused fields.
 * Useful if you already have a `GraphQLSchema` instance and want tooling to surface unused fields.
 */
export function alterSchema(
  schema: GraphQLSchema,
  documents: DocumentNode[],
  options: Pick<AnnotateUnusedSchemaOptions, 'reason'> = {},
): GraphQLSchema {
  const reason = options.reason ?? DEFAULT_UNUSED_REASON;
  const report = unused(schema, documents);

  const typeMap = schema.getTypeMap();
  for (const [typeName, fieldNames] of Object.entries(report.unusedFieldsByType)) {
    const type: any = typeMap[typeName];
    if (!type || !isObjectType(type)) continue;
    const fields = type.getFields?.();
    if (!fields) continue;
    for (const fieldName of fieldNames) {
      const field = fields[fieldName];
      if (!field) continue;
      if (field.deprecationReason) continue;
      (field as any).deprecationReason = reason;
    }
  }

  return schema;
}

export function unused(schema: GraphQLSchema, documents: DocumentNode[]): FieldUsageResult {
  const usedMap = new Map<string, Set<string>>();
  const aliasMap = new Map<string, Map<string, Set<string>>>();

  for (const doc of documents) {
    const typeInfo = new TypeInfo(schema);
    visit(
      doc,
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
  }

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
    const isConnectionType = typeName.endsWith('Connection');
    const unused = allFieldNames.filter((f) => {
      // For Connection types, do not report these common fields
      if (isConnectionType && (f === 'edges' || f === 'nodes' || f === 'pageInfo' || f === 'totalCount')) {
        return false;
      }
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
