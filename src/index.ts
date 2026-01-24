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
} from 'graphql';
// moved optimization into transform wrapper

import {processRelaySourceFile} from './extract.js';
import {stripRelayClientFields} from './strip.js';
import { optimizeAndFlatten, stripUnknownArgsAndUnusedVars } from './transform.js';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

/**
 * Extracts GraphQL operations from a folder
 */
class GraphQLOperationExtractor {
  private sourceFolder: string;
  private outDir: string;
  private schemaPath?: string;

  constructor(sourceFolder: string, outDir: string, schemaPath?: string) {
    this.sourceFolder = sourceFolder;
    this.outDir = outDir;
    this.schemaPath = schemaPath;
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


// Main execution via yargs CLI
const argv = yargs(hideBin(process.argv))
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
  .strict()
  .help()
  .parseSync();

const extractor = new GraphQLOperationExtractor(argv.src, argv.out, argv.schema);
extractor.extractOperations();

