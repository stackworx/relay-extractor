import { expect, test } from 'vitest';
import { Kind, buildSchema, parse } from 'graphql';
import { readFileSync } from 'node:fs';
import { flattenInlineFragmentsSameType, optimizeAndFlatten } from '../src/transform';

const schemaSDL = readFileSync(`${__dirname}/schema.graphql`, 'utf8');
const schema = buildSchema(schemaSDL);

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
