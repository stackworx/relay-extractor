import { expect, test } from 'vitest';
import { Kind, buildSchema, parse, print } from 'graphql';
import { readFileSync } from 'node:fs';
import { flattenInlineFragmentsSameType, optimizeAndFlatten } from '../src/transform';

const schemaSDL = readFileSync(`${__dirname}/schema.graphql`, 'utf8');
const schema = buildSchema(schemaSDL);

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function findField(selectionSet: any, name: string) {
  return selectionSet.selections.find((s: any) => s.kind === Kind.FIELD && s.name.value === name);
}

function hasInlineFragmentOn(selectionSet: any, typeName: string) {
  return selectionSet.selections.some((s: any) => s.kind === Kind.INLINE_FRAGMENT && s.typeCondition?.name?.value === typeName);
}

test('flattens same-type inline fragments and merges fields', () => {
  const docText = readFileSync(`${__dirname}/operations/UsersQueryFragmentIssue.graphql`, 'utf8');
  const doc = parse(docText);

  const transformed = flattenInlineFragmentsSameType(doc, schema);

  const op = transformed.definitions.find(d => d.kind === Kind.OPERATION_DEFINITION);
  const usersField: any = findField(op.selectionSet, 'users');
  const edgesField: any = findField(usersField.selectionSet, 'edges');
  const nodeField: any = findField(edgesField.selectionSet, 'node');

  // Inline fragment on User should be flattened away
  expect(hasInlineFragmentOn(nodeField.selectionSet, 'User')).toBe(false);

  // profileImage should be a single field with merged sub-selections
  const profileImage: any = findField(nodeField.selectionSet, 'profileImage');
  expect(profileImage).toBeTruthy();
  const subSelections = profileImage.selectionSet.selections.filter((s: any) => s.kind === Kind.FIELD).map((f: any) => f.name.value).sort();
  expect(subSelections).toEqual(['height', 'url', 'width']);
});

test('respects type extensions on User while flattening', () => {
  const doc = parse(/* GraphQL */`
    query Q($first: Int!) {
      users(first: $first) {
        edges { node {
          name
          ... on User { bio }
        } }
      }
    }
  `);

  const transformed = flattenInlineFragmentsSameType(doc, schema);
  const op = transformed.definitions.find(d => d.kind === Kind.OPERATION_DEFINITION);
  const usersField: any = findField(op.selectionSet, 'users');
  const edgesField: any = findField(usersField.selectionSet, 'edges');
  const nodeField: any = findField(edgesField.selectionSet, 'node');

  // Inline fragment on User should be flattened (same-type), but `bio` must remain selected
  expect(hasInlineFragmentOn(nodeField.selectionSet, 'User')).toBe(false);

  const bioField: any = findField(nodeField.selectionSet, 'bio');
  expect(bioField).toBeTruthy();
});

test('flattens two-level nested same-type inline fragments', () => {
  const doc = parse(/* GraphQL */`
    query Q($first: Int!) {
      users(first: $first) {
        edges { node {
          profileImage { height }
          ... on User {
            profileImage {
              url
              ... on Image { width }
            }
          }
        } }
      }
    }
  `);

  const transformed = flattenInlineFragmentsSameType(doc, schema);
  const op = transformed.definitions.find(d => d.kind === Kind.OPERATION_DEFINITION);
  const usersField: any = findField(op.selectionSet, 'users');
  const edgesField: any = findField(usersField.selectionSet, 'edges');
  const nodeField: any = findField(edgesField.selectionSet, 'node');

  // First-level inline fragment on User should be flattened
  expect(hasInlineFragmentOn(nodeField.selectionSet, 'User')).toBe(false);

  const profileImage: any = findField(nodeField.selectionSet, 'profileImage');
  expect(profileImage).toBeTruthy();

  // Second-level inline fragment on Image should also be flattened/merged
  expect(hasInlineFragmentOn(profileImage.selectionSet, 'Image')).toBe(false);

  const subSelections = profileImage.selectionSet.selections
    .filter((s: any) => s.kind === Kind.FIELD)
    .map((f: any) => f.name.value)
    .sort();
  expect(subSelections).toEqual(['height', 'url', 'width']);
});

test('optimizeAndFlatten returns a single, flattened document', () => {
  const doc = parse(/* GraphQL */`
    query Q($first: Int!) {
      users(first: $first) {
        edges { node {
          profileImage { height }
          ... on User {
            profileImage {
              url
              ... on Image { width }
            }
          }
        } }
      }
    }
  `);

  const transformed = optimizeAndFlatten(schema, doc);

  // Assert printed query after flattening has no inline fragments and merged fields
  const printed = print(transformed);
  const expected = `
    query Q($first: Int!) {
      users(first: $first) {
        edges {
          node {
            profileImage {
              height
              url
              width
            }
          }
        }
      }
    }
  `;
  expect(normalize(printed)).toBe(normalize(expected));

  const op = transformed.definitions.find(d => d.kind === Kind.OPERATION_DEFINITION);
  const usersField: any = findField(op.selectionSet, 'users');
  const edgesField: any = findField(usersField.selectionSet, 'edges');
  const nodeField: any = findField(edgesField.selectionSet, 'node');

  // No inline fragments should remain on User or Image
  expect(hasInlineFragmentOn(nodeField.selectionSet, 'User')).toBe(false);
  const profileImage: any = findField(nodeField.selectionSet, 'profileImage');
  expect(profileImage).toBeTruthy();
  expect(hasInlineFragmentOn(profileImage.selectionSet, 'Image')).toBe(false);

  const subSelections = profileImage.selectionSet.selections
    .filter((s: any) => s.kind === Kind.FIELD)
    .map((f: any) => f.name.value)
    .sort();
  expect(subSelections).toEqual(['height', 'url', 'width']);
});

test('optimizeAndFlatten merges fields; fragment may be inlined', () => {
  const doc = parse(/* GraphQL */`
    query Q {
      user(id: "1") {
        profileImage { height }
        ...UF
        ... on User { profileImage { url } }
      }
    }
    fragment UF on User {
      profileImage { width }
    }
  `);

  const transformed = optimizeAndFlatten(schema, doc);

  const op = transformed.definitions.find(d => d.kind === Kind.OPERATION_DEFINITION) as any;
  const userField: any = findField(op.selectionSet, 'user');

  // Inline fragment on User should be flattened
  expect(hasInlineFragmentOn(userField.selectionSet, 'User')).toBe(false);

  // Fragment spread may be preserved or inlined depending on optimizer behavior.
  const hasFragSpread = userField.selectionSet.selections.some((s: any) => s.kind === Kind.FRAGMENT_SPREAD);

  // Merged fields should include height, url, and width regardless.
  const profileImage: any = findField(userField.selectionSet, 'profileImage');
  expect(profileImage).toBeTruthy();
  const subSelections = profileImage.selectionSet.selections
    .filter((s: any) => s.kind === Kind.FIELD)
    .map((f: any) => f.name.value)
    .sort();
  expect(subSelections).toEqual(['height', 'url', 'width']);

  // If fragment is preserved, its definition should exist; otherwise inlined.
  const hasFragmentDef = transformed.definitions.some(d => d.kind === Kind.FRAGMENT_DEFINITION);
  if (hasFragSpread) {
    expect(hasFragmentDef).toBe(true);
  }

  // Printed query should include merged fields and the expected blocks.
  const printed = print(transformed);
  const normalizedPrinted = normalize(printed);
  expect(normalizedPrinted).toContain('query Q {');
  expect(normalizedPrinted).toContain('user(id: "1") {');
  expect(normalizedPrinted).toContain('profileImage {');
  expect(normalizedPrinted).toContain('height');
  expect(normalizedPrinted).toContain('url');
  expect(normalizedPrinted).toContain('width');
  if (hasFragSpread) {
    expect(normalizedPrinted).toContain('...UF');
    expect(normalizedPrinted).toContain('fragment UF on User {');
  }
});

test('removes aliases on leaf fields (scalars) and nested leaves', () => {
  const doc = parse(/* GraphQL */`
    query Q {
      user(id: "1") {
        idAlias: id
        nameAlias: name
        profileImage { urlAlias: url }
      }
    }
  `);

  const transformed = optimizeAndFlatten(schema, doc);
  const printed = normalize(print(transformed));
  // Aliases should be removed
  expect(printed).toContain('id');
  expect(printed).toContain('name');
  expect(printed).toContain('profileImage {');
  expect(printed).toContain('url');
  // Aliased names should not appear
  expect(printed).not.toContain('idAlias');
  expect(printed).not.toContain('nameAlias');
  expect(printed).not.toContain('urlAlias');
});

test('dedupes duplicates created after alias removal', () => {
  const doc = parse(/* GraphQL */`
    query Q {
      user(id: "1") {
        idAlias: id
        id
        profileImage {
          widthAlias: width
          width
        }
      }
    }
  `);

  const transformed = optimizeAndFlatten(schema, doc);
  const op = transformed.definitions.find(d => d.kind === Kind.OPERATION_DEFINITION) as any;
  const userField: any = findField(op.selectionSet, 'user');
  const userSubFields = userField.selectionSet.selections.filter((s: any) => s.kind === Kind.FIELD);
  const idOccurrences = userSubFields.filter((f: any) => f.name.value === 'id').length;
  expect(idOccurrences).toBe(1);

  const profileImage: any = findField(userField.selectionSet, 'profileImage');
  const imageSubFields = profileImage.selectionSet.selections.filter((s: any) => s.kind === Kind.FIELD);
  const widthOccurrences = imageSubFields.filter((f: any) => f.name.value === 'width').length;
  expect(widthOccurrences).toBe(1);
});

