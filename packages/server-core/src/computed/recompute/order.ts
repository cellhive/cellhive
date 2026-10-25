import type { GraphEdge } from '../graph/graph.js';

/** A computed field to order: its id and the tie-breaker among fields ready together. */
export interface OrderNode {
  readonly id: string;
  /** Ties are broken by this key (`db_table_name` of the field's table), then `position`, then id. */
  readonly tie: string;
  /** Display position of the field in its table (second tie-breaker; default 0). */
  readonly position?: number;
}

/**
 * Every node in an order where a field comes after the fields it reads
 * among them (topological), ties by `tie`, then `position`, then id (deterministic) — the order in which the
 * incremental recompute updates columns and locks rows: tables by
 * topological order then `db_table_name` (SPEC §5.9, BACKLOG T458).
 * Edges to or from fields outside `nodes` are ignored. The graph of active
 * fields has no cycle (T456); a cycle left by a restore (T460 `#CIRCLE`)
 * is broken by the smallest remaining node instead of looping.
 */
export function recomputeOrder(nodes: readonly OrderNode[], edges: readonly GraphEdge[]): string[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const compare = (a: string, b: string): number => {
    const left = byId.get(a) as OrderNode;
    const right = byId.get(b) as OrderNode;
    if (left.tie !== right.tie) return left.tie < right.tie ? -1 : 1;
    const byPosition = (left.position ?? 0) - (right.position ?? 0);
    if (byPosition !== 0) return byPosition;
    return a < b ? -1 : a > b ? 1 : 0;
  };
  const readers = new Map<string, string[]>();
  const indegree = new Map<string, number>(nodes.map((node) => [node.id, 0]));
  const seen = new Set<string>();
  for (const edge of edges) {
    if (!byId.has(edge.fieldId) || !byId.has(edge.dependsOnFieldId)) continue;
    if (edge.fieldId === edge.dependsOnFieldId) continue;
    const key = `${edge.fieldId}|${edge.dependsOnFieldId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const list = readers.get(edge.dependsOnFieldId) ?? [];
    list.push(edge.fieldId);
    readers.set(edge.dependsOnFieldId, list);
    indegree.set(edge.fieldId, (indegree.get(edge.fieldId) ?? 0) + 1);
  }
  const ready = nodes
    .map((node) => node.id)
    .filter((id) => indegree.get(id) === 0)
    .sort(compare);
  const done = new Set<string>();
  const order: string[] = [];
  while (order.length < nodes.length) {
    let next = ready.shift();
    if (next === undefined) {
      // A cycle: take the smallest node left.
      next = nodes
        .map((node) => node.id)
        .filter((id) => !done.has(id))
        .sort(compare)[0];
      if (next === undefined) break;
    }
    if (done.has(next)) continue;
    done.add(next);
    order.push(next);
    let added = false;
    for (const reader of readers.get(next) ?? []) {
      if (done.has(reader)) continue;
      const left = (indegree.get(reader) ?? 1) - 1;
      indegree.set(reader, left);
      if (left === 0) {
        ready.push(reader);
        added = true;
      }
    }
    if (added) ready.sort(compare);
  }
  return order;
}
