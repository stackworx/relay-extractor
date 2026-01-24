# Read Me

This project is meant to extract all the GraphQL operations from a relay project
and clean them so that a client can be generated

## Issues

- Remove Relay Compiler Directives
- Remove Relay Interla fields (`__id`)
- Handle missing arguments that relay handles with `argumentDefinitions`

## Testing: Vitest + GraphQL fix

- Background: When running Vitest with GraphQL-related tooling, you may see errors like:
	"Cannot use GraphQLSchema ... from another module or realm" due to how module resolution handles `graphql` subpath imports.
- Fix: Add aliases so Vitest resolves the ESM entry points consistently. This is configured in `vitest.config.ts`:

	```ts
	import { defineConfig } from 'vitest/config'

	export default defineConfig({
		resolve: {
			alias: {
				'graphql/language/printer': 'graphql/language/printer.js',
				'graphql/language': 'graphql/language/index.js',
				graphql: 'graphql/index.js',
			},
		},
	})
	```

- Reference: https://github.com/vitest-dev/vitest/issues/4605#issuecomment-1847658160
- Run tests:
	```bash
	npm run test -- --run
	```