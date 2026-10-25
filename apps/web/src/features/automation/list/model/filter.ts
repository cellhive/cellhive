import type { AutomationDto, AutomationListItem } from '@cellhive/contracts';

/**
 * The status tabs of the list (board "S5 · Automation list"); `errors`
 * (T523): "Errors in 24 h" — automations with a failed run in the last 24
 * hours (`errors_24h` of the list, T518).
 */
export const STATUS_FILTERS = ['all', 'on', 'off', 'errors'] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

type Filterable = Pick<AutomationDto, 'enabled'> & Partial<Pick<AutomationListItem, 'errors_24h'>>;

/** Case- and accent-insensitive form ("Đơn" finds "don"). */
export function foldText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').replace(/[đĐ]/gu, 'd').toLowerCase().trim();
}

export function matchesStatus(automation: Filterable, status: StatusFilter) {
  switch (status) {
    case 'all':
      return true;
    case 'on':
      return automation.enabled;
    case 'off':
      return !automation.enabled;
    case 'errors':
      return (automation.errors_24h ?? 0) > 0;
  }
}

/** Automations of `status` whose name contains `query`, in the server's order. */
export function filterAutomations<T extends Filterable & Pick<AutomationDto, 'name'>>(
  items: readonly T[],
  status: StatusFilter,
  query: string,
): T[] {
  const needle = foldText(query);
  return items.filter(
    (item) =>
      matchesStatus(item, status) && (needle === '' || foldText(item.name).includes(needle)),
  );
}

export function statusCounts(items: readonly Filterable[]): Record<StatusFilter, number> {
  const on = items.filter((item) => item.enabled).length;
  const errors = items.filter((item) => matchesStatus(item, 'errors')).length;
  return { all: items.length, on, off: items.length - on, errors };
}

/**
 * Automations that the system turned off since `before` (realtime toast,
 * board "S5 · Automation list - trạng thái"): on before, off now with a
 * `disabled_reason`.
 */
export function newlyDisabled<T extends Pick<AutomationDto, 'id' | 'enabled' | 'disabled_reason'>>(
  before: readonly T[],
  after: readonly T[],
): T[] {
  const wasOn = new Set(before.filter((item) => item.enabled).map((item) => item.id));
  return after.filter(
    (item) => wasOn.has(item.id) && !item.enabled && item.disabled_reason !== null,
  );
}
