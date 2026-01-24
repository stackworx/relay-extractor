import {
	Kind,
	type DocumentNode,
	type SelectionNode,
	type SelectionSetNode,
	type FieldNode,
	type GraphQLSchema,
	visit,
	TypeInfo,
	visitWithTypeInfo,
	getNamedType,
	isCompositeType,
} from 'graphql';
import { optimizeDocuments } from '@graphql-tools/relay-operation-optimizer';

function argKey(field: FieldNode): string {
	const name = field.alias?.value ?? field.name.value;
	if (!field.arguments || field.arguments.length === 0) return name;
	const parts = field.arguments.map(a => {
		const v = a.value.kind;
		return `${a.name.value}:${v}`;
	}).sort();
	return `${name}(${parts.join(',')})`;
}

function mergeDirectives(a?: ReadonlyArray<any>, b?: ReadonlyArray<any>) {
	if (!a && !b) return undefined;
	const out: any[] = [];
	const seen = new Set<string>();
	for (const d of [...(a ?? []), ...(b ?? [])]) {
		const key = d.name?.value;
		if (key && !seen.has(key)) {
			seen.add(key);
			out.push(d);
		}
	}
	return out.length ? out : undefined;
}

function mergeSelectionSets(a?: SelectionSetNode, b?: SelectionSetNode): SelectionSetNode | undefined {
	if (!a && !b) return undefined;
	if (a && !b) return a;
	if (!a && b) return b;
	const fieldMap = new Map<string, FieldNode>();
	const others: SelectionNode[] = [];

	const pushSelection = (sel: SelectionNode) => {
		if (sel.kind === Kind.FIELD) {
			const key = argKey(sel);
			const existing = fieldMap.get(key);
			if (existing) {
				fieldMap.set(key, {
					...existing,
					directives: mergeDirectives(existing.directives, sel.directives),
					selectionSet: mergeSelectionSets(existing.selectionSet, sel.selectionSet),
				});
			} else {
				fieldMap.set(key, sel);
			}
		} else {
			others.push(sel);
		}
	};

	for (const s of a!.selections) pushSelection(s);
	for (const s of b!.selections) pushSelection(s);

	return {
		kind: Kind.SELECTION_SET,
		selections: [...fieldMap.values(), ...others],
	};
}

function dedupeSelectionSet(ss: SelectionSetNode): SelectionSetNode {
	const fieldMap = new Map<string, FieldNode>();
	const others: SelectionNode[] = [];

	const pushSelection = (sel: SelectionNode) => {
		if (sel.kind === Kind.FIELD) {
			const key = argKey(sel);
			const existing = fieldMap.get(key);
			if (existing) {
				fieldMap.set(key, {
					...existing,
					directives: mergeDirectives(existing.directives, sel.directives),
					selectionSet: mergeSelectionSets(existing.selectionSet, sel.selectionSet),
				});
			} else {
				fieldMap.set(key, sel);
			}
		} else {
			others.push(sel);
		}
	};

	for (const s of ss.selections) pushSelection(s);

	return { kind: Kind.SELECTION_SET, selections: [...fieldMap.values(), ...others] };
}

function flattenSameTypeInlineFragmentsInSelectionSet(
	selectionSet: SelectionSetNode,
	currentTypeName: string | null,
): SelectionSetNode {
	const flattened: SelectionNode[] = [];
	for (const sel of selectionSet.selections) {
		if (sel.kind === Kind.INLINE_FRAGMENT) {
			const condName = sel.typeCondition?.name?.value ?? null;
			if (condName && currentTypeName && condName === currentTypeName) {
				// flatten by lifting selections to parent
				for (const child of sel.selectionSet.selections) {
					flattened.push(child);
				}
				continue;
			}
		}
		flattened.push(sel);
	}

	// Merge duplicate field selections produced by flattening
	return dedupeSelectionSet({ kind: Kind.SELECTION_SET, selections: flattened });
}

export function flattenInlineFragmentsSameType(
	doc: DocumentNode,
	schema: GraphQLSchema,
): DocumentNode {
	const typeInfo = new TypeInfo(schema);
	return visit(
		doc,
		visitWithTypeInfo(typeInfo, {
			SelectionSet(node) {
				const t = typeInfo.getType();
				const named = t ? getNamedType(t) : null;
				const typeName = named && isCompositeType(named) ? named.name : null;
				return flattenSameTypeInlineFragmentsInSelectionSet(node, typeName);
			},
		}),
	);
}

export function optimizeAndFlatten(
	schema: GraphQLSchema,
	doc: DocumentNode,
): DocumentNode {
	let out: DocumentNode = doc;

	try {
		const optimizedResults = optimizeDocuments(schema, [doc]) as Array<{ document?: DocumentNode } | DocumentNode>;
		if (!Array.isArray(optimizedResults) || optimizedResults.length === 0) {
			// Optimizer returned nothing; proceed with original doc
			out = doc;
		} else {
			if (optimizedResults.length !== 1) {
				throw new Error('optimizeDocuments returned multiple documents for a single input. Expected exactly one.');
			}
			const first = optimizedResults[0];
			const maybeDoc = (first as any).document ?? first;
			out = maybeDoc as DocumentNode;
		}
	} catch {
		// On optimizer failure, continue with original doc
		out = doc;
	}

	out = flattenInlineFragmentsSameType(out, schema);

	return out;
}

