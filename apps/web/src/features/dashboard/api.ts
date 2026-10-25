import { queryOptions } from '@tanstack/react-query';

import { isApiError } from '../../lib/api/client';
import { shouldRetry } from '../../lib/query/client';
import { loadDashboardsApi } from '../../lib/query/dashboards';
import { keys } from '../../lib/query/keys';

import { widgetRequests } from './model/limit';

import type { WidgetDto, WidgetLiveFilterInput } from '@cellhive/contracts';

const NO_FILTERS: readonly WidgetLiveFilterInput[] = [];

/** What else, besides the widget's saved config, decides its numbers. */
export interface WidgetDataContext {
  /** `permission_version` of the base: a permission change is new data (FRONTEND §3.2). */
  readonly permissionVersion: number;
  /** The viewer's IANA zone for date buckets (`null`: the organization's). */
  readonly timezone: string | null;
}

/**
 * Stable hash of the effective query of a widget on this client: the
 * config (its `updated_at` changes with every save), the base's permission
 * version, the zone and (T813) the live filters the request carries — the
 * server's cache is keyed by them too (CONTRACTS §28.5).
 */
export function widgetDataHash(
  widget: Pick<WidgetDto, 'updated_at'>,
  context: WidgetDataContext,
  filters: readonly WidgetLiveFilterInput[] = NO_FILTERS,
) {
  return JSON.stringify([widget.updated_at, context.permissionVersion, context.timezone, filters]);
}

/** A timed-out widget (`504 QUERY_TIMEOUT`) waits for "Try again": no automatic retry. */
export function shouldRetryWidget(failureCount: number, error: unknown): boolean {
  if (isApiError(error) && (error.status === 504 || error.code === 'QUERY_TIMEOUT')) return false;
  return shouldRetry(failureCount, error);
}

/**
 * (T811) One TanStack query per widget, keyed by widget and effective
 * query (FRONTEND §3.2 `keys.widgetData`); at most four requests of the tab
 * run at once (`widgetRequests`), the others wait in line. (T813) With the
 * live filters that apply to the widget (`filters/filter-state.ts`).
 */
export const widgetDataQuery = (
  widget: WidgetDto,
  context: WidgetDataContext,
  filters: readonly WidgetLiveFilterInput[] = NO_FILTERS,
) =>
  queryOptions({
    queryKey: keys.widgetData(widget.id, widgetDataHash(widget, context, filters)),
    queryFn: ({ signal }) =>
      widgetRequests.run(
        async () =>
          (await loadDashboardsApi()).widgetData(
            widget.id,
            { filters: [...filters], timezone: context.timezone },
            signal,
          ),
        signal,
      ),
    retry: shouldRetryWidget,
    // The cache key carries the data version server-side; refetches come from realtime.
    staleTime: 5 * 60_000,
  });

/**
 * (T813) Values of a `select` / `user` / `text` filter control (`POST
 * /widgets/:id/options`): with the viewer's permissions, narrowed by the
 * parent controls' values and the search text — all in the key, under the
 * widget's prefix so realtime refreshes it with the widget.
 */
export const widgetOptionsQuery = (
  widget: Pick<WidgetDto, 'id' | 'updated_at'>,
  context: WidgetDataContext,
  filters: readonly WidgetLiveFilterInput[],
  search: string,
) =>
  queryOptions({
    queryKey: [
      ...keys.widgetData(widget.id, widgetDataHash(widget, context, filters)),
      'options',
      search,
    ] as const,
    queryFn: ({ signal }) =>
      widgetRequests.run(
        async () =>
          (await loadDashboardsApi()).widgetOptions(
            widget.id,
            {
              filters: [...filters],
              timezone: context.timezone,
              ...(search === '' ? {} : { search }),
            },
            signal,
          ),
        signal,
      ),
    retry: shouldRetryWidget,
    staleTime: 60_000,
  });
