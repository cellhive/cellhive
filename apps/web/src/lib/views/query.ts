import { sameValue, type EffectiveViewConfig } from './config';

import type { EffectiveRecordQuery } from '../query/keys';

/**
 * The record query of a view on screen (FRONTEND §3.2, T311): always
 * through the view (`view_id`), plus what the user changed on top of the
 * saved config and the search box.
 *
 * - `filter`: sent only when it differs from the saved one, with
 *   `filter_mode: replace` — it takes the place of the part of the saved
 *   filter the user sees; saved conditions on fields they cannot read keep
 *   applying on the server (CONTRACTS §1.4, BACKLOG S3 decision 3).
 * - `sort`: the effective sort is always sent (it is part of `queryHash`, and
 *   decides where a new row goes); when it differs from the saved sort,
 *   `sort_mode: replace` sets the view's sort aside. When equal, the server
 *   sorts by the view's keys then the same keys again (harmless), which keeps
 *   saved sort keys on fields the user cannot read.
 * - `group`: sent only when it differs (a request group replaces the view's;
 *   `[]` = none).
 * - `search`: trimmed, only when not empty.
 */
export function viewRecordQuery(
  viewId: string,
  saved: EffectiveViewConfig,
  effective: EffectiveViewConfig,
  search = '',
): EffectiveRecordQuery {
  const text = search.trim();
  const filterChanged = !sameValue(effective.filter, saved.filter);
  return {
    view_id: viewId,
    ...(filterChanged ? { filter: effective.filter, filter_mode: 'replace' as const } : {}),
    ...(effective.sort.length === 0 ? {} : { sort: effective.sort }),
    ...(sameValue(effective.sort, saved.sort) ? {} : { sort_mode: 'replace' as const }),
    ...(sameValue(effective.group, saved.group) ? {} : { group: effective.group }),
    ...(text === '' ? {} : { search: text }),
  };
}

/** Number of conditions of a filter (the count on the toolbar's filter button). */
export function countConditions(filter: unknown): number {
  if (typeof filter !== 'object' || filter === null) return 0;
  const node = filter as { items?: unknown; item?: unknown; field?: unknown };
  if (Array.isArray(node.items)) {
    return node.items.reduce<number>((sum, item) => sum + countConditions(item), 0);
  }
  if (node.item !== undefined) return countConditions(node.item);
  return typeof node.field === 'string' ? 1 : 0;
}
