
import * as fs from 'fs';
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
        documents.push(doc);
      } catch (e) {
        console.error('  Error parsing Relay graphql template', t.loc ? `at ${t.loc.line}:${t.loc.column}` : '', e instanceof Error ? e.message : e);
      }
    }
    return documents;
  }