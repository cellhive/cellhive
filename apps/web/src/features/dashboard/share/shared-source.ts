import { isApiError } from '../../../lib/api/client';
import { shouldRetryWidget } from '../api';
import { widgetRequests } from '../model/limit';

import {
  NO_PERMISSION_DATA,
  NO_PERMISSION_OPTIONS,
  sharedFieldsByTable,
  unreadableWidgets,
} from './shared-model';

import type { SharedDashboardSource } from '../../../lib/share/public-page';
import type { DashboardDataSource } from '../view/data-source';
import type { SharedDashboardDto } from '@cellhive/contracts';

/**
 * Whether a failed request ends the whole page (CONTRACTS §16A): the link
 * is gone (`410`: revoked, turned off, expired, the creator lost access),
 * the unlock expired (`403 SHARE_PASSWORD_REQUIRED`) or an `org` link lost
 * its session (`401`).
 */
export function endsSharedPage(error: unknown): boolean {
  return (
    isApiError(error) &&
    (error.status === 410 || error.status === 401 || error.code === 'SHARE_PASSWORD_REQUIRED')
  );
}

export interface SharedSourceOptions {
  /** Polling period of the widgets (`refresh_seconds`, SPEC §15A.3: no WS for links). */
  readonly refreshMs: number;
  readonly onFatal: (error: unknown) => void;
}

/**
 * (T814) The data source of a dashboard link: widget numbers and filter
 * values through `/shares/:token/widgets/…` (the creator's current access ∩
 * the dashboard, never the viewer's), polled every `refresh_seconds` while
 * the tab is visible (TanStack pauses `refetchInterval` on a hidden
 * document — `visibilitychange`), at most four requests at once like the
 * member page (the link has one server-side queue of four). Fields come
 * with the dashboard; there is no member list (global `user` filters are
 * not offered).
 */
export function sharedDataSource(
  shared: SharedDashboardDto,
  source: SharedDashboardSource,
  { refreshMs, onFatal }: SharedSourceOptions,
): DashboardDataSource {
  const unreadable = unreadableWidgets(shared);
  const fields = sharedFieldsByTable(shared);
  // The dashboard read again (a widget went away) may name other fields.
  const fieldIds = shared.fields.map((field) => field.id).join(',');
  const guard = async <T>(request: Promise<T>): Promise<T> => {
    try {
      return await request;
    } catch (error) {
      if (endsSharedPage(error)) onFatal(error);
      throw error;
    }
  };
  return {
    widgetData: (widget, context, filters) => ({
      queryKey: [...source.widgetsKey, widget.id, 'data', context.timezone, filters],
      queryFn: ({ signal }) =>
        unreadable.has(widget.id)
          ? Promise.resolve(NO_PERMISSION_DATA)
          : widgetRequests.run(
              () =>
                guard(
                  source.widgetData(
                    widget.id,
                    { filters: [...filters], timezone: context.timezone },
                    signal,
                  ),
                ),
              signal,
            ),
      retry: shouldRetryWidget,
      refetchInterval: unreadable.has(widget.id) ? false : refreshMs,
      staleTime: refreshMs,
    }),
    widgetOptions: (widget, context, filters, search) => ({
      queryKey: [...source.widgetsKey, widget.id, 'options', context.timezone, filters, search],
      queryFn: ({ signal }) =>
        unreadable.has(widget.id)
          ? Promise.resolve(NO_PERMISSION_OPTIONS)
          : widgetRequests.run(
              () =>
                guard(
                  source.widgetOptions(
                    widget.id,
                    {
                      filters: [...filters],
                      timezone: context.timezone,
                      ...(search === '' ? {} : { search }),
                    },
                    signal,
                  ),
                ),
              signal,
            ),
      retry: shouldRetryWidget,
      staleTime: refreshMs,
    }),
    fields: (tableId) => ({
      queryKey: [...source.widgetsKey, 'fields', tableId, fieldIds],
      queryFn: () => Promise.resolve({ items: fields.get(tableId) ?? [] }),
      staleTime: Infinity,
    }),
    members: null,
    dashboardKey: () => source.dashboardKey,
    filtersOff: 'link',
  };
}
