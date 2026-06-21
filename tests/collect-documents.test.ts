import { expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kind, type DocumentNode } from 'graphql';
import { collectDocuments } from '../src/extract';

function definitionNames(docs: DocumentNode[]): string[] {
  const names: string[] = [];
  for (const doc of docs) {
    for (const def of doc.definitions) {
      if (def.kind === Kind.OPERATION_DEFINITION || def.kind === Kind.FRAGMENT_DEFINITION) {
        if (def.name) names.push(def.name.value);
      }
    }
  }
  return names;
}

test('collects standalone .graphql document files (StrawberryShake/Apollo style)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relayx-graphql-'));
  writeFileSync(join(dir, 'GetThing.graphql'), 'query GetThing { thing { id } }');
  writeFileSync(join(dir, 'ThingFields.graphql'), 'fragment ThingFields on Thing { id name }');

  const names = definitionNames(collectDocuments(dir));

  expect(names).toContain('GetThing');
  expect(names).toContain('ThingFields');
});

test('collects .graphql documents recursively from nested folders', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relayx-nested-'));
  writeFileSync(join(dir, 'Top.graphql'), 'query Top { a }');
  const nested = join(dir, 'queries');
  mkdirSync(nested);
  writeFileSync(join(nested, 'Nested.graphql'), 'query Nested { b }');

  const names = definitionNames(collectDocuments(dir));

  expect(names).toContain('Top');
  expect(names).toContain('Nested');
});

test('skips the schema file when it lives inside the source folder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relayx-schema-'));
  const schemaPath = join(dir, 'schema.graphql');
  writeFileSync(schemaPath, 'type Query { a: String }');
  writeFileSync(join(dir, 'Op.graphql'), 'query OnlyOp { a }');

  // Without the guard the schema's type definitions would be parsed as an extra document.
  expect(collectDocuments(dir, schemaPath).length).toBe(1);
  expect(definitionNames(collectDocuments(dir, schemaPath))).toContain('OnlyOp');
});
