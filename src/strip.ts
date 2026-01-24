import { Kind } from "graphql";

/**
 * Remove Relay internal fields (like __id) that are not part of the server schema.
 */
export function stripRelayClientFields<T>(node: T): T {
  if (node === null) {
    return node
  };

  if (Array.isArray(node)) {
    return node.map(stripRelayClientFields) as any;
  }

  if (typeof node !== 'object') {
    return node;
  }

  const anyNode: any = node;

  // Drop Field nodes named "__id"
  if (anyNode.kind === Kind.FIELD && anyNode.name?.value === '__id') {
    return null as any;
  }

  const out: any = {};
  for (const [k, v] of Object.entries(anyNode)) {
    if (k === 'loc') continue;

    if (Array.isArray(v)) {
      const cleaned = v
        .map(stripRelayClientFields)
        .filter(x => x != null);
      out[k] = cleaned;
      continue;
    }

    out[k] = stripRelayClientFields(v as any);
  }

  return out;
}

/**
 * Remove custom Relay compiler directives from the AST so outputs are schema-clean.
 */
export function stripRelayCompilerDirectives<T>(node: T): T {
  if (node == null) return node;

  if (Array.isArray(node)) {
    return node
      .map(stripRelayCompilerDirectives)
      .filter(x => x != null) as any;
  }

  if (typeof node !== 'object') {
    return node;
  }

  const anyNode: any = node;

  const relayDirectiveNames = new Set<string>([
    'relay',
    'refetchable',
    'connection',
    'appendNode',
    'prependNode',
    'appendEdge',
    'prependEdge',
    'deleteRecord',
    'deleteEdge',
    'stream_connection',
  ]);

  if (anyNode.kind === Kind.DIRECTIVE) {
    const name = anyNode.name?.value as string | undefined;
    if (name && relayDirectiveNames.has(name)) {
      return null as any;
    }
    return anyNode;
  }

  const out: any = {};
  for (const [k, v] of Object.entries(anyNode)) {
    if (k === 'loc') continue;

    if (Array.isArray(v)) {
      const cleaned = v
        .map(stripRelayCompilerDirectives)
        .filter(x => x != null);
      out[k] = cleaned;
      continue;
    }

    out[k] = stripRelayCompilerDirectives(v as any);
  }

  return out;
}

/**
 * For mutation operations, strip variable `$connections` and any field arguments named `connections`.
 */
export function stripMutationConnectionsArgs<T>(node: T): T {
  if (node == null) return node;

  if (Array.isArray(node)) {
    return node.map(stripMutationConnectionsArgs) as any;
  }

  if (typeof node !== 'object') {
    return node;
  }

  const anyNode: any = node;

  // Remove from field arguments
  if (anyNode.kind === Kind.FIELD && Array.isArray(anyNode.arguments)) {
    const args = anyNode.arguments
      .map(stripMutationConnectionsArgs)
      .filter((arg: any) => arg && arg.name?.value !== 'connections');
    const outField: any = { ...anyNode, arguments: args };
    // Recurse into remaining properties
    const out: any = {};
    for (const [k, v] of Object.entries(outField)) {
      if (k === 'loc') continue;
      out[k] = stripMutationConnectionsArgs(v as any);
    }
    return out;
  }

  // For OperationDefinition of type mutation, filter variableDefinitions
  if (anyNode.kind === Kind.OPERATION_DEFINITION && anyNode.operation === 'mutation') {
    const out: any = {};
    for (const [k, v] of Object.entries(anyNode)) {
      if (k === 'loc') continue;
      if (k === 'variableDefinitions' && Array.isArray(v)) {
        out[k] = v
          .map(stripMutationConnectionsArgs)
          .filter((vd: any) => vd && vd.variable?.name?.value !== 'connections');
        continue;
      }
      out[k] = stripMutationConnectionsArgs(v as any);
    }
    return out;
  }

  const out: any = {};
  for (const [k, v] of Object.entries(anyNode)) {
    if (k === 'loc') continue;
    out[k] = stripMutationConnectionsArgs(v as any);
  }

  return out;
}