# Read Me

This project is meant to extract all the GraphQL operations from a relay project
and clean them so that a client can be generated

## Issues

- Remove Relay Compiler Directives
- Remove Relay Interla fields (`__id`)
- Handle missing arguments that relay handles with `argumentDefinitions`