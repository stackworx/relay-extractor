
import * as fs from 'fs';
import * as path from 'path';
import {
  parse as gqlParse,
  type DocumentNode,
} from 'graphql';
import { parse as babelParse } from '@babel/parser';
import {default as traverse, NodePath } from '@babel/traverse';
import type {
  File as BabelFile,
  ImportDeclaration,
  TaggedTemplateExpression,
} from '@babel/types';
import { stripRelayCompilerDirectives } from './strip.js';

  export function processRelaySourceFile(filePath: string): DocumentNode[] {
    const code = fs.readFileSync(filePath, 'utf-8');
    let ast: BabelFile;
    try {
      ast = babelParse(code, {
        sourceType: 'module',
        plugins: [
          'typescript',
          'jsx',
          'classProperties',
          'decorators-legacy',
          'objectRestSpread',
          'dynamicImport',
          'optionalChaining',
          'nullishCoalescingOperator',
          'topLevelAwait',
        ],
      });
    } catch (e) {
      // Skip files that fail to parse with our plugin set
      return [];
    }

    const allowedModules = new Set([
      'react-relay',
      'relay-runtime',
      'babel-plugin-relay/macro',
      'relay-hooks',
    ]);

    const allowedGraphQLIdentifiers = new Set<string>();

    // https://github.com/babel/babel/discussions/13093
    // @ts-expect-error - Babel types
    traverse.default(ast as any, {
      ImportDeclaration: (p: NodePath<ImportDeclaration>) => {
        const src = p.node.source.value;
        if (typeof src === 'string' && allowedModules.has(src)) {
          for (const spec of p.node.specifiers) {
            if (spec.type === 'ImportSpecifier' && spec.imported.type === 'Identifier' && spec.imported.name === 'graphql') {
              const localName = spec.local.name;
              allowedGraphQLIdentifiers.add(localName);
            }
          }
        }
      },
    });

    const templates: { content: string; loc: { line: number; column: number } | null }[] = [];

    // @ts-expect-error - Babel types
    traverse.default(ast as any, {
      TaggedTemplateExpression: (p: NodePath<TaggedTemplateExpression>) => {
        const tag = p.node.tag;
        if (tag.type === 'Identifier' && (allowedGraphQLIdentifiers.has(tag.name) || tag.name === 'graphql')) {
          // Only accept Relay-compatible static templates (no expressions)
          if (p.node.quasi.expressions.length === 0) {
            const text = p.node.quasi.quasis.map(q => q.value.cooked ?? q.value.raw).join('');
            templates.push({ content: text, loc: p.node.loc ? { line: p.node.loc.start.line, column: p.node.loc.start.column } : null });
          }
        }
      },
    });

    if (templates.length === 0) return [];

    // console.log(`\nProcessed: ${filePath}`);
    // console.log(`  Relay graphql templates: ${templates.length}`);
    const documents: DocumentNode[] = [];
    for (const t of templates) {
      try {
        const doc = gqlParse(t.content);
        // Strip Relay compiler directives at extraction time
        const cleaned = stripRelayCompilerDirectives(doc) as DocumentNode;
        documents.push(cleaned);
      } catch (e) {
        console.error('  Error parsing Relay graphql template', t.loc ? `at ${t.loc.line}:${t.loc.column}` : '', e instanceof Error ? e.message : e);
      }
    }
    return documents;
  }

/** Source file extensions scanned for embedded Relay `graphql` tagged templates. */
export const RELAY_SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];

/** Standalone GraphQL document extensions (e.g. StrawberryShake / Apollo `.graphql` operations). */
export const GRAPHQL_DOCUMENT_EXTENSIONS = ['.graphql', '.gql'];

/**
 * Parse a standalone GraphQL document file (a `.graphql`/`.gql` operations file, as used by
 * StrawberryShake, Apollo, urql, etc.). Unlike {@link processRelaySourceFile} the operations are not
 * embedded in `graphql` tagged templates — the whole file is a GraphQL document.
 */
export function processGraphQLDocumentFile(filePath: string): DocumentNode[] {
  const code = fs.readFileSync(filePath, 'utf-8');
  try {
    // Strip Relay compiler directives for parity with the tagged-template path (a no-op for the
    // typical non-Relay document, but keeps downstream handling identical).
    const cleaned = stripRelayCompilerDirectives(gqlParse(code)) as DocumentNode;
    return [cleaned];
  } catch (e) {
    console.error('  Error parsing GraphQL document', filePath, e instanceof Error ? e.message : e);
    return [];
  }
}

/** Recursively collect files under `dir` whose name ends with one of `extensions`. */
export function getSourceFiles(dir: string, extensions: string[]): string[] {
  const found: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...getSourceFiles(fullPath, extensions));
    } else if (entry.isFile() && extensions.some(ext => entry.name.endsWith(ext))) {
      found.push(fullPath);
    }
  }
  return found;
}

/**
 * Collect every GraphQL document under `srcDir`, supporting both Relay `graphql` tagged templates in
 * `.ts/.tsx/.js/.jsx` source and standalone `.graphql`/`.gql` document files. Pass `schemaPath` to skip
 * the schema file if it happens to live inside `srcDir` (so it isn't parsed as an operations document).
 */
export function collectDocuments(srcDir: string, schemaPath?: string): DocumentNode[] {
  const skip = schemaPath ? path.resolve(schemaPath) : undefined;
  const files = getSourceFiles(srcDir, [
    ...RELAY_SOURCE_EXTENSIONS,
    ...GRAPHQL_DOCUMENT_EXTENSIONS,
  ]);
  const documents: DocumentNode[] = [];
  for (const file of files) {
    if (skip && path.resolve(file) === skip) continue;
    const isGraphQLDocument = GRAPHQL_DOCUMENT_EXTENSIONS.some(ext => file.endsWith(ext));
    const docs = isGraphQLDocument
      ? processGraphQLDocumentFile(file)
      : processRelaySourceFile(file);
    if (docs && docs.length > 0) documents.push(...docs);
  }
  return documents;
}