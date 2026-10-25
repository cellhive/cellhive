import { hiddenFilterOf } from '@cellhive/server-core';

import type { SubscriberView } from './realtime-connection.js';

/**
 * The view filter one subscriber's record messages follow (T313, ADR-0031,
 * CONTRACTS §7), in stored form (field ids), before validation:
 *
 * - `filter_mode: and` — the view's whole saved filter, conditions on
 *   fields hidden from the subscriber included (they apply to queries
 *   through the view too, BACKLOG S3 decision 3);
 * - `filter_mode: replace` — the client shows a temporary filter instead of
 *   the part it sees, so only the hidden part (conditions on active fields
 *   the subscriber cannot read, and whole `or`/`not` nodes holding one)
 *   applies here; the client checks its own filter and search by `ids`.
 *
 * `active` are the fields of the table known to the envelope: every active
 * field a view filter names is captured in the images (`RecordRuleFields`),
 * so a filter field missing from it is a deleted one. `null` = no filter.
 */
export function subscriberViewFilter(
  view: SubscriberView,
  visible: ReadonlySet<string>,
  active: ReadonlySet<string>,
): unknown {
  if (view.filter === null || view.filter === undefined) return null;
  if (view.filterMode === 'and') return view.filter;
  return hiddenFilterOf(view.filter, (fieldId) => active.has(fieldId) && !visible.has(fieldId));
}

type FilterJson = Record<string, unknown>;

function isObject(value: unknown): value is FilterJson {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `node` without the leaves `keep` rejects; `and`/`or` groups left empty and
 * `not` nodes left without their item disappear (`null` when nothing is
 * left). Saved conditions that no longer validate (deleted field, option or
 * operand gone) are ignored for members, like `records/query` does
 * (CONTRACTS §1.4).
 */
export function pruneFilterLeaves(
  node: unknown,
  keep: (leaf: FilterJson) => boolean,
): FilterJson | null {
  if (!isObject(node)) return null;
  if (node['op'] === 'and' || node['op'] === 'or') {
    const items = Array.isArray(node['items']) ? (node['items'] as unknown[]) : [];
    const kept = items
      .map((item) => pruneFilterLeaves(item, keep))
      .filter((item): item is FilterJson => item !== null);
    return kept.length === 0 ? null : { ...node, items: kept };
  }
  if (node['op'] === 'not') {
    const item = pruneFilterLeaves(node['item'], keep);
    return item === null ? null : { ...node, item };
  }
  return keep(node) ? node : null;
}
