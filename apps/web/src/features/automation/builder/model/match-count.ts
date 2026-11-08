import { isAutomationOnlyOperator, type DslOperator, type FilterNode } from '@cellhive/filter-dsl';

/**
 * (T1012) The filter behind "N records match now" under an automation
 * condition (FRONTEND §13.2, BACKLOG S9 decision #8): counted with
 * `POST …/records/query` as the person editing, on the records as they are.
 *
 * A `changed` / `changed_to` / `changed_from` condition (a `record.updated`
 * trigger, SPEC §11.3) compares with the value before a change that has not
 * happened yet: it counts as true, so the number is the records that match
 * the rest of the condition. A filter true whatever the records are — no
 * condition, only `changed*` conditions, an `or` holding one — counts
 * nothing (`null`: the number is hidden), and so does a `not` around a
 * `changed*` condition (no meaning on records at rest).
 */
export function countableFilter(filter: unknown): FilterNode | null {
  const result = reduce(filter);
  return result === TRUE || result === UNKNOWN ? null : result;
}

const TRUE = Symbol('true');
const UNKNOWN = Symbol('unknown');
type Reduced = FilterNode | typeof TRUE | typeof UNKNOWN;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reduce(node: unknown): Reduced {
  if (!isObject(node)) return node === null || node === undefined ? TRUE : UNKNOWN;
  // `{}`: the empty condition of a `record.matches` trigger being edited.
  if (Object.keys(node).length === 0) return TRUE;
  const op = node['op'];
  if ((op === 'and' || op === 'or') && Array.isArray(node['items'])) {
    const items: FilterNode[] = [];
    let unknown = false;
    for (const child of node['items'] as unknown[]) {
      const reduced = reduce(child);
      if (reduced === TRUE) {
        if (op === 'or') return TRUE;
        continue;
      }
      if (reduced === UNKNOWN) unknown = true;
      else items.push(reduced);
    }
    if (unknown) return UNKNOWN;
    return items.length === 0 ? TRUE : { op, items };
  }
  if (op === 'not') {
    const reduced = reduce(node['item']);
    return reduced === TRUE || reduced === UNKNOWN ? UNKNOWN : { op: 'not', item: reduced };
  }
  if (typeof node['field'] === 'string' && typeof node['operator'] === 'string') {
    return isAutomationOnlyOperator(node['operator'] as DslOperator)
      ? TRUE
      : (node as unknown as FilterNode);
  }
  return UNKNOWN;
}
