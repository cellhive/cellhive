import type { FilterNode } from '@cellhive/filter-dsl';

/**
 * Filter DSL (SPEC §6.1) as used inside role configs. The schema and tree
 * helpers live in `@cellhive/filter-dsl`; they are re-exported here so the
 * permissions API stays stable. Field visibility, operator/value checks per
 * field type happen when a role is saved (`validateFilter`, T109).
 */
export {
  collectFieldIds,
  filterNodeSchema,
  type FilterCondition,
  type FilterGroup,
  type FilterNode,
  type FilterNot,
} from '@cellhive/filter-dsl';

/**
 * OR-combines filters. `null` means "no restriction", so any `null` input
 * yields `null`. Structurally identical filters are deduplicated.
 */
export function orFilters(filters: readonly (FilterNode | null)[]): FilterNode | null {
  const unique = new Map<string, FilterNode>();
  for (const filter of filters) {
    if (filter === null) return null;
    unique.set(JSON.stringify(filter), filter);
  }
  const items = [...unique.values()];
  if (items.length === 1) return items[0] ?? null;
  return { op: 'or', items };
}

/**
 * AND-combines filters. `null` means "no restriction" and is skipped; no
 * restriction at all yields `null`.
 */
export function andFilters(filters: readonly (FilterNode | null)[]): FilterNode | null {
  const items = filters.filter((filter): filter is FilterNode => filter !== null);
  if (items.length === 0) return null;
  if (items.length === 1) return items[0] ?? null;
  return { op: 'and', items };
}
