import { createContext, useContext } from 'react';

import type { WidgetDataContext } from '../api';
import type {
  FieldDto,
  WidgetDataDto,
  WidgetDto,
  WidgetLiveFilterInput,
  WidgetOptionsDto,
} from '@cellhive/contracts';
import type { QueryKey, UseQueryOptions } from '@tanstack/react-query';

/** Query options of one entry read by the widgets (key + fetch + freshness). */
export type SourceQuery<T> = UseQueryOptions<T, Error, T>;

/** People a global `user` filter offers. */
export interface SourceMember {
  readonly id: string;
  readonly display_name: string;
}

/**
 * (T814) Where the widgets of a dashboard read from: the member API
 * (`/widgets/:id/…`, the default) or a dashboard share link
 * (`/shares/:token/widgets/:id/…`, `features/dashboard/share`). The cards,
 * filter bar and controls only go through this, so a shared dashboard draws
 * with the same components and never reads the member routes.
 */
export interface DashboardDataSource {
  readonly widgetData: (
    widget: WidgetDto,
    context: WidgetDataContext,
    filters: readonly WidgetLiveFilterInput[],
  ) => SourceQuery<WidgetDataDto>;
  readonly widgetOptions: (
    widget: Pick<WidgetDto, 'id' | 'updated_at'>,
    context: WidgetDataContext,
    filters: readonly WidgetLiveFilterInput[],
    search: string,
  ) => SourceQuery<WidgetOptionsDto>;
  /** Fields of a table (labels, options, number styles). */
  readonly fields: (tableId: string) => SourceQuery<{ readonly items: readonly FieldDto[] }>;
  /** People of the base for a global `user` filter; `null`: such filters are not offered. */
  readonly members:
    ((baseId: string) => SourceQuery<{ readonly items: readonly SourceMember[] }>) | null;
  /** What to read again when a widget went away (`404`): the dashboard. */
  readonly dashboardKey: (dashboardId: string) => QueryKey;
  /**
   * Why filter controls do not filter when live filters are off: the editor
   * (default) or a link that does not allow them.
   */
  readonly filtersOff: 'editing' | 'link';
}

/**
 * The data source of the widgets below: `memberDataSource`
 * (`member-data-source.ts`) on the member routes, `sharedDataSource` on a
 * share link. No default: the member one would pull the member API (and its
 * zod schemas) into the shared dashboard's chunks (T1000, FRONTEND §11.1).
 */
export const DashboardDataSourceContext = createContext<DashboardDataSource | null>(null);

/** The data source of the dashboard on screen. */
export function useDashboardDataSource(): DashboardDataSource {
  const source = useContext(DashboardDataSourceContext);
  if (source === null) throw new Error('useDashboardDataSource outside a dashboard data source');
  return source;
}
