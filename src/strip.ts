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