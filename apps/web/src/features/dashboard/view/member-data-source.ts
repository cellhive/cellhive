import { loadDashboardsApi } from '../../../lib/query/dashboards';
import { keys } from '../../../lib/query/keys';
import { fieldsQuery } from '../../../lib/query/queries';
import { widgetDataQuery, widgetOptionsQuery } from '../api';

import type { DashboardDataSource, SourceQuery } from './data-source';
import type { FieldDto, WidgetDataDto, WidgetOptionsDto } from '@cellhive/contracts';

/**
 * The member routes (T811–T813): what `DashboardPage` (view and editor)
 * provides. A module of its own so a shared dashboard does not load it.
 */
export const memberDataSource: DashboardDataSource = {
  widgetData: (widget, context, filters) =>
    widgetDataQuery(widget, context, filters) as unknown as SourceQuery<WidgetDataDto>,
  widgetOptions: (widget, context, filters, search) =>
    widgetOptionsQuery(
      widget,
      context,
      filters,
      search,
    ) as unknown as SourceQuery<WidgetOptionsDto>,
  fields: (tableId) =>
    fieldsQuery(tableId) as unknown as SourceQuery<{ readonly items: readonly FieldDto[] }>,
  members: (baseId) => ({
    queryKey: keys.baseMembers(baseId),
    queryFn: async ({ signal }) => (await loadDashboardsApi()).baseMembers(baseId, signal),
    staleTime: 60_000,
  }),
  dashboardKey: (dashboardId) => keys.dashboard(dashboardId),
  filtersOff: 'editing',
};
