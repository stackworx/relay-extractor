import { expect, test } from 'vitest';
import { parse, print, buildSchema } from 'graphql';
import { stripUnknownArgsAndUnusedVars } from '../src/transform';

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

test('strips unknown field args and unused variables using schema', () => {
  const schemaSDL = `
    type Mutation {
      createMaintenances(input: [CreateMaintenancesInput!]!): CreateMaintenancesPayload
    }
    type CreateMaintenancesPayload { maintenance: Maintenance }
    type Maintenance { id: ID }
    input CreateMaintenancesInput { id: ID }
  `;
  const schema = buildSchema(schemaSDL);

  const doc = parse(/* GraphQL */`
    mutation M($input: [CreateMaintenancesInput!]!, $connections: [ID!]!, $unused: String) {
      createMaintenances(input: $input, connections: $connections, unused: $unused) {
        maintenance { id }
      }
    }
  `);

  const transformed = stripUnknownArgsAndUnusedVars(schema, doc);
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
