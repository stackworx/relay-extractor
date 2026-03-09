import { expect, test } from 'vitest';
import { buildSchema, parse, Kind, type DocumentNode, type DirectiveNode } from 'graphql';
import { readFileSync } from 'node:fs';
import { annotateSchemaSDLWithUnusedFields, unused } from '../src/unused';

const schemaSDL = readFileSync(`${__dirname}/schema.graphql`, 'utf8');
const schema = buildSchema(schemaSDL);

function getFieldDirective(
  doc: DocumentNode,
  typeName: string,
  fieldName: string,
  directiveName: string,
): DirectiveNode | undefined {
  for (const def of doc.definitions) {
    if (
      (def.kind === Kind.OBJECT_TYPE_DEFINITION || def.kind === Kind.OBJECT_TYPE_EXTENSION) &&
      def.name.value === typeName
    ) {
      const field = (def.fields ?? []).find((f) => f.name.value === fieldName);
      if (!field) continue;
      return (field.directives ?? []).find((d) => d.name.value === directiveName);
    }
  }
  return undefined;
}

test('annotates unused fields in SDL via @deprecated', () => {
  const op = parse(/* GraphQL */ `
    query Mixed {
      user(id: "1") {
        id
        name
        username
        friends(first: 1) { edges { node { id } } }
        profileImage { url }
      }
    }
  `);

  const report = unused(schema, [op]);
  const annotatedSDL = annotateSchemaSDLWithUnusedFields(schemaSDL, report.unusedFieldsByType, {
    mode: 'deprecated',
    reason: 'relay-extractor: unused',
  });

  const annotatedDoc = parse(annotatedSDL);

  const createdAtDep = getFieldDirective(annotatedDoc, 'User', 'createdAt', 'deprecated');
  expect(createdAtDep).toBeTruthy();
  const createdAtReason = createdAtDep?.arguments?.find((a) => a.name.value === 'reason')?.value;
  expect(createdAtReason && createdAtReason.kind === Kind.STRING ? createdAtReason.value : undefined).toBe(
    'relay-extractor: unused',
  );

  // bio is declared in an `extend type User { ... }` block in the test schema
  const bioDep = getFieldDirective(annotatedDoc, 'User', 'bio', 'deprecated');
  expect(bioDep).toBeTruthy();
});

test('does not annotate fields excluded from unused reporting (pageInfo when edges used)', () => {
  const op = parse(/* GraphQL */ `
    query Q($first: Int!) {
      users(first: $first) {
        edges { node { id } }
        # pageInfo intentionally omitted
      }
    }
  `);

  const report = unused(schema, [op]);
  const annotatedSDL = annotateSchemaSDLWithUnusedFields(schemaSDL, report.unusedFieldsByType, {
    mode: 'deprecated',
    reason: 'relay-extractor: unused',
  });
  const annotatedDoc = parse(annotatedSDL);

  const pageInfoDep = getFieldDirective(annotatedDoc, 'UserConnection', 'pageInfo', 'deprecated');
  expect(pageInfoDep).toBeFalsy();
});
