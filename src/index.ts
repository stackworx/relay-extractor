#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import {
  buildClientSchema,
  buildSchema,
  concatAST,
  extendSchema,
  print,
  separateOperations,
  // extendSchema,
  parse as gqlParse,
  isScalarType,
  getNamedType,
} from 'graphql';
// moved optimization into transform wrapper

import {processRelaySourceFile} from './extract.js';
import {stripRelayClientFields} from './strip.js';
import { optimizeAndFlatten, stripUnknownArgsAndUnusedVars } from './transform.js';
import { annotateSchemaSDLWithUnusedFields, annotateSchemaWithUnusedFields, unused } from './unused.js';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

/**
 * Extracts GraphQL operations from a folder
 */
class GraphQLOperationExtractor {
  private sourceFolder: string;
  private outDir: string;
  private schemaPath?: string;
  private excludeSubscriptions: boolean;

  constructor(sourceFolder: string, outDir: string, schemaPath?: string, excludeSubscriptions: boolean = false) {
    this.sourceFolder = sourceFolder;
    this.outDir = outDir;
    this.schemaPath = schemaPath;
    this.excludeSubscriptions = excludeSubscriptions;
  }

  /**
   * Extract all GraphQL operations from files in the source folder
   * 1. Extract all graphql from the source files
   * 2. Separate operations
   * 3. Strip Relay client fields and directives
   * 4. Final Transformations, add missing arguments etc.
   * 5. Write each operation to its own file in the output folder
   */
  public extractOperations(): void {
    if (!fs.existsSync(this.sourceFolder)) {
      console.error(`Source folder does not exist: ${this.sourceFolder}`);
      return;
    }

    this.ensureOutDir();

    const sourceFiles = this.getFiles(this.sourceFolder, ['.ts', '.tsx', '.js', '.jsx']);

    const allDocuments = [] as ReturnType<typeof processRelaySourceFile>;
    sourceFiles.forEach(file => {
      const documents = processRelaySourceFile(file);
      if (!documents || documents.length === 0) return;
      allDocuments.push(...documents);
    });

    if (allDocuments.length === 0) {
      console.log('No GraphQL documents found in source files.');
      return;
    }

    const mergedDoc = concatAST(allDocuments);
    const separated = separateOperations(mergedDoc);
    const opNames = Object.keys(separated);

    if (opNames.length === 0) {
      console.log('No operations found after separation.');
      return;
    }

    // Keep schema loading only for compatibility (no optimization is performed)
    const schemaArg = this.schemaPath;
    let schema = undefined as ReturnType<typeof buildSchema> | ReturnType<typeof buildClientSchema> | undefined;
    if (schemaArg) {
      try {
        const schemaContent = fs.readFileSync(schemaArg, 'utf-8');
        if (schemaArg.endsWith('.graphql') || schemaArg.endsWith('.gql')) {
          schema = buildSchema(schemaContent);
        } else if (schemaArg.endsWith('.json')) {
          const json = JSON.parse(schemaContent);
          const introspection = json.data ?? json; // support both raw and wrapped
          if (introspection && introspection.__schema) {
            schema = buildClientSchema(introspection);
          }
        }

        if (schema) {
          const RELAY_CLIENT_DIRECTIVES_SDL = `
            directive @relay(mask: Boolean, plural: Boolean) on FRAGMENT_SPREAD | FRAGMENT_DEFINITION
            directive @refetchable(queryName: String!) on FRAGMENT_DEFINITION
            directive @connection(key: String!, filters: [String]) on FIELD
            directive @appendNode(connections: [ID!]!, edgeTypeName: String!) on FIELD
            directive @prependNode(connections: [ID!]!, edgeTypeName: String!) on FIELD
            directive @appendEdge(connections: [ID!]!) on FIELD
            directive @prependEdge(connections: [ID!]!) on FIELD
            directive @deleteRecord(id: ID!) on FIELD
            directive @deleteEdge(connections: [ID!]!) on FIELD
            directive @stream_connection(key: String!, initial_count: Int!, if: Boolean) on FIELD
          `;
          try {
            schema = extendSchema(schema, gqlParse(RELAY_CLIENT_DIRECTIVES_SDL));
          } catch (augmentErr) {
            console.warn('Skipping Relay directive augmentation:', augmentErr instanceof Error ? augmentErr.message : augmentErr);
          }
        }
      } catch (e) {
        console.warn('Failed to load schema:', e instanceof Error ? e.message : e);
        return;
      }
    }

    // Write each operation (with its dependent fragments) as its own file.
    // If a schema is provided, optimize each separated document first.
    opNames.forEach((opName, idx) => {
      const opDoc = separated[opName];

      // Optionally skip subscription operations
      if (this.excludeSubscriptions) {
        const isSubscription = (opDoc.definitions ?? []).some((d: any) => d.kind === 'OperationDefinition' && d.operation === 'subscription');
        if (isSubscription) {
          return; // skip writing this operation
        }
      }
      const safeName = opName && opName.length > 0 ? opName : `anonymous_${idx + 1}`;

      let docToWrite: any = opDoc;
      if (schema) {
        try {
          docToWrite = optimizeAndFlatten(schema as any, opDoc as any) as any;
        } catch (e) {
          console.warn(
            `Transform (optimize+flatten) failed for operation ${safeName}:`,
            e instanceof Error ? e.message : e,
          );
        }
      }

      // Relay compiler directives are now stripped during extraction in processRelaySourceFile
      // If schema is available, remove unknown field arguments and unused variables for mutations
      if (schema) {
        try {
          docToWrite = stripUnknownArgsAndUnusedVars(schema as any, docToWrite as any) as any;
        } catch (e) {
          console.warn('Arg/var strip failed:', e instanceof Error ? e.message : e);
        }
      }

      const cleaned = stripRelayClientFields(docToWrite as any) as any;
      const printed = print(cleaned as any);
      const outFile = path.join(
        this.outDir,
        `${safeName.replace(/[^A-Za-z0-9_\-.]/g, '_')}.graphql`,
      );
      fs.writeFileSync(outFile, printed, 'utf-8');
    });
  }

  /**
   * Get all GraphQL files from the source folder (recursive)
   */
  private getFiles(dir: string, extensions: string[]): string[] {
    const found: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        found.push(...this.getFiles(fullPath, extensions));
      } else if (entry.isFile() && extensions.some(ext => entry.name.endsWith(ext))) {
        found.push(fullPath);
      }
    }
    return found;
}

  private ensureOutDir(): void {
    if (!fs.existsSync(this.outDir)) {
      fs.mkdirSync(this.outDir, { recursive: true });
    }
  }
}


// Main execution via yargs CLI with 'extract' subcommand
yargs(hideBin(process.argv))
  .command(
    'extract',
    'Extract GraphQL operations from source files',
    (y) =>
      y
        .option('src', {
          type: 'string',
          describe: 'Source folder to scan for GraphQL operations',
          default: './graphql',
        })
        .option('out', {
          type: 'string',
          describe: 'Output directory for extracted operations',
          default: './out',
        })
        .option('schema', {
          type: 'string',
          describe: 'Path to GraphQL schema (.graphql or introspection .json)',
        })
        .option('exclude-subscriptions', {
          type: 'boolean',
          describe: 'Exclude subscription operations from output',
          default: false,
        }),
    (argv) => {
      const extractor = new GraphQLOperationExtractor(
        argv.src as string,
        argv.out as string,
        (argv.schema as string | undefined),
        argv['exclude-subscriptions'] as boolean,
      );
      extractor.extractOperations();
    },
  )
  .command(
    'annotate-unused',
    'Output schema SDL annotated to mark unused fields based on operations found in source files',
    (y) =>
      y
        .option('src', {
          type: 'string',
          describe: 'Source folder to scan',
          default: './graphql',
        })
        .option('schema', {
          type: 'string',
          describe: 'Path to GraphQL schema (.graphql/.gql or introspection .json)',
          demandOption: true,
        })
        .option('out', {
          type: 'string',
          describe: 'Output file path (defaults to overwriting --schema). Use "-" to write to stdout.',
        })
        .option('mode', {
          type: 'string',
          choices: ['deprecated', 'directive'] as const,
          describe: 'Annotation mode: use @deprecated(...) or a custom directive',
          default: 'deprecated',
        })
        .option('directive-name', {
          type: 'string',
          describe: 'Directive name when mode=directive (default: unused)',
        })
        .option('reason', {
          type: 'string',
          describe: 'Annotation reason string',
          default: 'relay-extractor: unused',
        })
        .option('add-directive-definition', {
          type: 'boolean',
          describe: 'When mode=directive, prepend directive definition if missing',
          default: true,
        }),
    (argv) => {
      const src = argv.src as string;
      const schemaArg = argv.schema as string;
      const outFile = argv.out as string | undefined;

      if (!fs.existsSync(src)) {
        console.error(`Source folder does not exist: ${src}`);
        return;
      }

      // Gather documents from source files
      const getFiles = (dir: string, extensions: string[]): string[] => {
        const found: string[] = [];
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            found.push(...getFiles(fullPath, extensions));
          } else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
            found.push(fullPath);
          }
        }
        return found;
      };

      const sourceFiles = getFiles(src, ['.ts', '.tsx', '.js', '.jsx']);
      const documents: ReturnType<typeof processRelaySourceFile> = [] as any;
      sourceFiles.forEach((file) => {
        const docs = processRelaySourceFile(file);
        if (docs && docs.length > 0) documents.push(...docs);
      });

      if (!documents || documents.length === 0) {
        console.log('No GraphQL documents found in source files.');
        return;
      }

      // Load schema
      let schema = undefined as ReturnType<typeof buildSchema> | ReturnType<typeof buildClientSchema> | undefined;
      let schemaSDL = undefined as string | undefined;
      try {
        const schemaContent = fs.readFileSync(schemaArg, 'utf-8');
        if (schemaArg.endsWith('.graphql') || schemaArg.endsWith('.gql')) {
          schemaSDL = schemaContent;
          schema = buildSchema(schemaContent);
        } else if (schemaArg.endsWith('.json')) {
          const json = JSON.parse(schemaContent);
          const introspection = json.data ?? json;
          if (introspection && introspection.__schema) {
            schema = buildClientSchema(introspection);
          }
        }
      } catch (e) {
        console.warn('Failed to load schema:', e instanceof Error ? e.message : e);
        return;
      }

      if (!schema) {
        console.error('Failed to construct GraphQL schema from provided path.');
        return;
      }

      const mode = argv.mode as 'deprecated' | 'directive';
      const directiveName = (argv['directive-name'] as string | undefined) ?? undefined;
      const reason = argv.reason as string;
      const addDirectiveDefinition = argv['add-directive-definition'] as boolean;

      // Prefer preserving original SDL (including `extend type ...`) when available
      let annotatedSDL: string;
      if (schemaSDL) {
        const report = unused(schema as any, documents as any);
        annotatedSDL = annotateSchemaSDLWithUnusedFields(schemaSDL, report.unusedFieldsByType, {
          mode,
          directiveName,
          reason,
          addDirectiveDefinition,
        });
      } else {
        annotatedSDL = annotateSchemaWithUnusedFields(schema as any, documents as any, {
          mode,
          directiveName,
          reason,
          addDirectiveDefinition,
        });
      }

      const destination = outFile ?? schemaArg;
      if (destination === '-') {
        process.stdout.write(annotatedSDL);
        if (!annotatedSDL.endsWith('\n')) process.stdout.write('\n');
      } else {
        fs.writeFileSync(destination, annotatedSDL, 'utf-8');
      }
    },
  )
  .command(
    'unused',
    'Identity unused fields in the GraphQL schema based on operations found in source files',
    (y) =>
      y
        .option('src', {
          type: 'string',
          describe: 'Source folder to scan',
          default: './graphql',
        })
        .option('schema', {
          type: 'string',
          describe: 'Path to GraphQL schema (.graphql or introspection .json)',
        })
        .option('include-scalars', {
          type: 'boolean',
          describe: 'Include scalar fields in the unused report',
          default: false,
        })
        .option('ignore-fields', {
          type: 'string',
          describe: 'Comma-separated list of field names to ignore from unused reporting (e.g., createdAt,updatedAt)',
        }),
    (argv) => {
      const src = argv.src as string;
      const schemaArg = argv.schema as string | undefined;

      if (!schemaArg) {
        console.error('Schema path is required for the "unused" command.');
        return;
      }

      if (!fs.existsSync(src)) {
        console.error(`Source folder does not exist: ${src}`);
        return;
      }

      // Load schema (same logic as extract)
      let schema = undefined as ReturnType<typeof buildSchema> | ReturnType<typeof buildClientSchema> | undefined;
      try {
        const schemaContent = fs.readFileSync(schemaArg, 'utf-8');
        if (schemaArg.endsWith('.graphql') || schemaArg.endsWith('.gql')) {
          schema = buildSchema(schemaContent);
        } else if (schemaArg.endsWith('.json')) {
          const json = JSON.parse(schemaContent);
          const introspection = json.data ?? json;
          if (introspection && introspection.__schema) {
            schema = buildClientSchema(introspection);
          }
        }
      } catch (e) {
        console.warn('Failed to load schema:', e instanceof Error ? e.message : e);
        return;
      }

      if (!schema) {
        console.error('Failed to construct GraphQL schema from provided path.');
        return;
      }

      // Gather documents from source files
      const getFiles = (dir: string, extensions: string[]): string[] => {
        const found: string[] = [];
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            found.push(...getFiles(fullPath, extensions));
          } else if (entry.isFile() && extensions.some(ext => entry.name.endsWith(ext))) {
            found.push(fullPath);
          }
        }
        return found;
      };

      const sourceFiles = getFiles(src, ['.ts', '.tsx', '.js', '.jsx']);
      const documents: ReturnType<typeof processRelaySourceFile> = [] as any;
      sourceFiles.forEach(file => {
        const docs = processRelaySourceFile(file);
        if (docs && docs.length > 0) documents.push(...docs);
      });

      if (!documents || documents.length === 0) {
        console.log('No GraphQL documents found in source files.');
        return;
      }

      // Run unused analysis
      const report = unused(schema as any, documents as any);

      // Print summary of unused fields per type (skip empty ones)
      const types = Object.keys(report.unusedFieldsByType).sort();
      const includeScalars = (argv['include-scalars'] as boolean | undefined) ?? false;
      const ignoreArg = (argv['ignore-fields'] as string | undefined) ?? '';
      const ignoreFields = ignoreArg
        .split(',')
        .map(s => s.trim())
        .filter(s => s.length > 0);
      const ignoreSet = new Set<string>(['id', ...ignoreFields]);
      let totalUnused = 0;
      types.forEach(t => {
        const unusedFields = report.unusedFieldsByType[t];
        const filtered = (unusedFields || []).filter(f => {
          if (ignoreSet.has(f)) return false;
          if (!includeScalars) {
            const typeObj: any = schema.getTypeMap()[t];
            const fieldsObj = typeObj?.getFields?.();
            const field = fieldsObj ? fieldsObj[f] : undefined;
            if (field) {
              const named = getNamedType(field.type);
              if (isScalarType(named)) return false;
            }
          }
          return true;
        });
        if (filtered.length > 0) {
          totalUnused += filtered.length;
          console.log(`${t}: ${filtered.sort().join(', ')}`);
        }
      });
      if (totalUnused === 0) {
        console.log('No unused fields detected.');
      }
    },
  )
  .demandCommand(1, 'Please specify a command, e.g. "extract"')
  .strict()
  .help()
  .parse();

