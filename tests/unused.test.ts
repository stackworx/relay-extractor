import { expect, test } from 'vitest';
import { buildSchema, parse } from 'graphql';
import { readFileSync } from 'node:fs';
import { unused } from '../src/unused';

const schemaSDL = readFileSync(`${__dirname}/schema.graphql`, 'utf8');
const schema = buildSchema(schemaSDL);

function loadOp(relPath: string) {
  const text = readFileSync(`${__dirname}/operations/${relPath}`, 'utf8');
  return parse(text);
}

test('marks used and unused fields on User', () => {
  const doc = parse(/* GraphQL */`
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

  const report = unused(schema, [doc]);

  const used = report.usedFieldsByType['User']?.sort();
  expect(used).toBeTruthy();
  expect(used).toEqual(expect.arrayContaining(['id', 'name', 'username', 'friends', 'profileImage']));

  const unusedFields = report.unusedFieldsByType['User']?.sort();
  expect(unusedFields).toBeTruthy();
  // Fields not selected anywhere in the test docs
  expect(unusedFields).toEqual(expect.arrayContaining(['createdAt', 'bio']));
});

test('tracks aliases on non-leaf fields', () => {
  const doc = parse(/* GraphQL */`
    query Q {
      user(id: "1") {
        profileImageAlias: profileImage { url }
      }
    }
  `);

  const report = unused(schema, [doc]);
  const aliasesForType = report.aliasesByType['User'] || {};
  const aliasesForField = aliasesForType['profileImage'] || [];
  expect(aliasesForField).toContain('profileImageAlias');
});

test('marks fields inside inline fragments as used', () => {
  const doc = parse(/* GraphQL */`
    query Q {
      user(id: "1") {
        ... on User {
          profileImage {
            url
            width
          }
        }
      }
    }
  `);

  const report = unused(schema, [doc]);
  const userUsed = (report.usedFieldsByType['User'] || []).sort();
  expect(userUsed).toContain('profileImage');

  const imageUsed = (report.usedFieldsByType['Image'] || []).sort();
  expect(imageUsed).toEqual(expect.arrayContaining(['url', 'width']));

  const imageUnused = (report.unusedFieldsByType['Image'] || []).sort();
  expect(imageUnused).toEqual(expect.not.arrayContaining(['url', 'width']));
});

test('ignores built-in relay/meta fields like __typename', () => {
  const doc = parse(/* GraphQL */`
    query Q {
      user(id: "1") {
        __typename
        id
      }
    }
  `);

  const report = unused(schema, [doc]);
  const userUsed = report.usedFieldsByType['User'] || [];
  expect(userUsed).toContain('id');
  expect(userUsed).not.toContain('__typename');
});

test('does not report pageInfo as unused when edges are used', () => {
  const doc = parse(/* GraphQL */`
    query Q($first: Int!) {
      users(first: $first) {
        edges { node { id } }
        # pageInfo not selected on purpose
      }
    }
  `);

  const report = unused(schema, [doc]);
  const connUnused = (report.unusedFieldsByType['UserConnection'] || []).sort();
  expect(connUnused).not.toContain('pageInfo');
});

test('does not report scalar cursor as unused', () => {
  const doc = parse(/* GraphQL */`
    query Q($first: Int!) {
      users(first: $first) {
        edges { node { id } }
      }
    }
  `);

  const report = unused(schema, [doc]);
  const edgeUnused = (report.unusedFieldsByType['UserEdge'] || []).sort();
  expect(edgeUnused).not.toContain('cursor');
});
