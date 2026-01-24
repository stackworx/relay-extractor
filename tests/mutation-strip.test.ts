import { expect, test } from 'vitest';
import { parse, print } from 'graphql';
import { stripMutationConnectionsArgs } from '../src/strip';

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

test('strips $connections variable and field arg from mutations', () => {
  const doc = parse(/* GraphQL */`
    mutation M($input: [CreateMaintenancesInput!]!, $connections: [ID!]!) {
      createMaintenances(input: $input, connections: $connections) {
        maintenance { id }
      }
    }
  `);

  const transformed = stripMutationConnectionsArgs(doc);
  const printed = print(transformed);
  const expected = `
    mutation M($input: [CreateMaintenancesInput!]!) {
      createMaintenances(input: $input) {
        maintenance { id }
      }
    }
  `;

  expect(normalize(printed)).toBe(normalize(expected));
});
