import { defineConfig } from 'vitest/config'

// Fix for Vitest + GraphQL duplicate realm issues:
// See https://github.com/vitest-dev/vitest/issues/4605#issuecomment-1847658160
export default defineConfig({
  resolve: {
    alias: {
      'graphql/language/printer': 'graphql/language/printer.js',
      'graphql/language': 'graphql/language/index.js',
      graphql: 'graphql/index.js',
    },
  },
  test: {},
})
