import { expect, test } from 'vitest';
import { parse } from 'graphql';
import { stripRelayCompilerDirectives } from '../src/strip';

function getOp(cleaned: any) {
  return cleaned.definitions.find((d: any) => d.kind === 'OperationDefinition');
}

function getFrag(cleaned: any, name: string) {
  return cleaned.definitions.find((d: any) => d.kind === 'FragmentDefinition' && d.name?.value === name);
}

test('removes Relay compiler directives (@relay, @connection)', () => {
  const doc = parse(/* GraphQL */`
    fragment UserFrag on User @relay(mask: false) {
      id
      name
      friends(first: 5) @connection(key: "UserFrag_friends") {
        edges { node { id } }
      }
    }
  `);

  const cleaned: any = stripRelayCompilerDirectives(doc);
  const frag = getFrag(cleaned, 'UserFrag');

  // Fragment-level Relay directive removed
  expect(frag.directives?.length ?? 0).toBe(0);

  // Field-level @connection removed
  const friendsField = frag.selectionSet.selections.find((s: any) => s.kind === 'Field' && s.name.value === 'friends');
  expect(friendsField.directives?.length ?? 0).toBe(0);
});

test('removes @stream_connection custom directive', () => {
  const doc = parse(/* GraphQL */`
    query UsersQuery($first: Int!) {
      users(first: $first) @stream_connection(initial_count: 2, key: "Users_users") {
        edges { cursor }
        pageInfo { hasNextPage }
      }
    }
  `);

  const cleaned: any = stripRelayCompilerDirectives(doc);
  const op = getOp(cleaned);
  const usersField = op.selectionSet.selections.find((s: any) => s.kind === 'Field' && s.name.value === 'users');
  expect(usersField.directives?.length ?? 0).toBe(0);
});

test('keeps non-Relay directives (@defer, @stream)', () => {
  const doc = parse(/* GraphQL */`
    query Q($id: ID!) {
      user(id: $id) {
        id
        ...F @defer(label: "UserFrag")
        friends(first: 10) @stream(initial_count: 2, label: "Friends") {
          edges { node { id } }
        }
      }
    }
    fragment F on User { id }
  `);

  const cleaned: any = stripRelayCompilerDirectives(doc);
  const op = getOp(cleaned);
  const userField = op.selectionSet.selections.find((s: any) => s.kind === 'Field' && s.name.value === 'user');

  const fragSpread = userField.selectionSet.selections.find((s: any) => s.kind === 'FragmentSpread');
  expect(fragSpread.directives?.some((d: any) => d.name.value === 'defer')).toBe(true);

  const friendsField = userField.selectionSet.selections.find((s: any) => s.kind === 'Field' && s.name.value === 'friends');
  expect(friendsField.directives?.some((d: any) => d.name.value === 'stream')).toBe(true);
});

test('strips location data (loc) from AST', () => {
  const doc = parse(/* GraphQL */`query Q { user(id: "1") { id } }`);
  const cleaned: any = stripRelayCompilerDirectives(doc);

  expect(cleaned.loc).toBeUndefined();
  const op = getOp(cleaned);
  expect(op.loc).toBeUndefined();
});
