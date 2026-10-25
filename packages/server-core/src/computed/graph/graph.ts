/**
 * The dependency graph of the computed fields of a base (SPEC §5.9, BACKLOG
 * T456), as pure functions over its edges `field → field it reads`. Only
 * computed fields have outgoing edges, so every cycle goes through computed
 * fields only.
 */

export interface GraphEdge {
  readonly fieldId: string;
  readonly dependsOnFieldId: string;
}

function outgoing(edges: readonly GraphEdge[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const edge of edges) {
    const list = out.get(edge.fieldId) ?? [];
    list.push(edge.dependsOnFieldId);
    out.set(edge.fieldId, list);
  }
  for (const list of out.values()) list.sort();
  return out;
}

/**
 * A reference cycle through `start` (a field whose definition changes), as
 * the chain `[start, …, start]` of field ids, or `null`. Edges of fields
 * outside `active` (deleted fields, T460) are ignored. Deterministic: the
 * shortest cycle, ties broken by field id.
 */
export function findCycle(
  start: string,
  edges: readonly GraphEdge[],
  active: ReadonlySet<string>,
): string[] | null {
  const out = outgoing(
    edges.filter((e) => active.has(e.fieldId) && active.has(e.dependsOnFieldId)),
  );
  // Breadth-first from the fields `start` reads, back to `start`.
  const previous = new Map<string, string>();
  const queue: string[] = [];
  for (const next of out.get(start) ?? []) {
    if (next === start) return [start, start];
    if (!previous.has(next)) {
      previous.set(next, start);
      queue.push(next);
    }
  }
  for (let index = 0; index < queue.length; index += 1) {
    const node = queue[index] as string;
    for (const next of out.get(node) ?? []) {
      if (next === start) {
        const chain = [start];
        for (
          let at: string | undefined = node;
          at !== undefined && at !== start;
          at = previous.get(at)
        ) {
          chain.push(at);
        }
        chain.push(start);
        // `chain` walks back from the end: start ← node ← … ← start.
        return chain.reverse();
      }
      if (!previous.has(next)) {
        previous.set(next, node);
        queue.push(next);
      }
    }
  }
  return null;
}

/**
 * `start` and every field that reads it, directly or not, in an order where
 * a field comes after everything it reads among them (topological; ties by
 * field id). Only fields in `active` are listed. The graph has no cycle
 * among active fields (checked on every save), but a cycle left by a
 * restore (T460 `#REF`/`#CIRCLE`) is broken arbitrarily instead of looping.
 */
export function dependentsInOrder(
  start: string,
  edges: readonly GraphEdge[],
  active: ReadonlySet<string>,
): string[] {
  const live = edges.filter((e) => active.has(e.fieldId) && active.has(e.dependsOnFieldId));
  const readers = new Map<string, string[]>();
  for (const edge of live) {
    const list = readers.get(edge.dependsOnFieldId) ?? [];
    list.push(edge.fieldId);
    readers.set(edge.dependsOnFieldId, list);
  }
  const reached = new Set<string>([start]);
  const stack = [start];
  while (stack.length > 0) {
    const node = stack.pop() as string;
    for (const reader of readers.get(node) ?? []) {
      if (!reached.has(reader)) {
        reached.add(reader);
        stack.push(reader);
      }
    }
  }
  // Kahn's algorithm on the reached subgraph.
  const indegree = new Map<string, number>([...reached].map((id) => [id, 0]));
  for (const edge of live) {
    if (reached.has(edge.fieldId) && reached.has(edge.dependsOnFieldId) && edge.fieldId !== start) {
      indegree.set(edge.fieldId, (indegree.get(edge.fieldId) ?? 0) + 1);
    }
  }
  indegree.set(start, 0);
  const order: string[] = [];
  const ready = [...reached].filter((id) => indegree.get(id) === 0).sort();
  const done = new Set<string>();
  while (order.length < reached.size) {
    const next = ready.shift() ?? [...reached].filter((id) => !done.has(id)).sort()[0];
    if (next === undefined) break;
    if (done.has(next)) continue;
    done.add(next);
    order.push(next);
    for (const reader of (readers.get(next) ?? []).filter((id) => reached.has(id)).sort()) {
      if (done.has(reader) || reader === start) continue;
      const left = (indegree.get(reader) ?? 1) - 1;
      indegree.set(reader, left);
      if (left === 0) {
        ready.push(reader);
        ready.sort();
      }
    }
  }
  // `start` first: everything else reads it.
  return [start, ...order.filter((id) => id !== start)];
}
