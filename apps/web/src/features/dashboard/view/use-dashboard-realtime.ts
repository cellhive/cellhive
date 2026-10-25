import { dashboardChannel, isId, type WidgetDto } from '@cellhive/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import { keys } from '../../../lib/query/keys';
import { useRealtimeChannel } from '../../../lib/realtime/channels';
import { RefreshGate } from '../model/refresh-gate';

/** The table a widget reads (`null` for text widgets). */
export function widgetTable(widget: WidgetDto): string | null {
  const tableId = (widget.config as { table_id?: unknown }).table_id;
  return typeof tableId === 'string' ? tableId : null;
}

/**
 * Widgets to refetch for a `dashboard.data_changed { table_ids }`: those
 * reading one of the tables. When none does, the change was on a table they
 * reach through a link (lookup, link titles): every data widget then.
 */
export function widgetsToRefresh(
  widgets: readonly WidgetDto[],
  tableIds: ReadonlySet<string>,
): WidgetDto[] {
  const data = widgets.filter((widget) => widgetTable(widget) !== null);
  const direct = data.filter((widget) => tableIds.has(widgetTable(widget) ?? ''));
  return direct.length > 0 ? direct : data;
}

/**
 * (T811, S7 decision #10, FRONTEND §5) `dashboard:{id}` while the dashboard
 * is on screen (one reference-counted subscription): `dashboard.changed` →
 * the dashboard is read again (layout, widgets, names); `dashboard.data_changed`
 * → the widgets of those tables refetch their data over HTTP with the
 * viewer's own permissions (`RefreshGate`: at once, then at most once per 5 s);
 * `NOT_FOUND` (deleted, permission lost) → read again, the page shows it is
 * gone; after a reconnect everything is read again (messages were missed).
 */
export function useDashboardRealtime(dashboardId: string, widgets: readonly WidgetDto[]): void {
  const queryClient = useQueryClient();
  const current = useRef(widgets);
  useEffect(() => {
    current.current = widgets;
  });
  const gate = useRef<RefreshGate | null>(null);
  useEffect(() => {
    const created = new RefreshGate((tableIds) => {
      for (const widget of widgetsToRefresh(current.current, tableIds)) {
        void queryClient.invalidateQueries({ queryKey: ['widget', widget.id] });
      }
    });
    gate.current = created;
    return () => {
      created.dispose();
      if (gate.current === created) gate.current = null;
    };
  }, [queryClient]);
  const refreshDashboard = () =>
    queryClient.invalidateQueries({ queryKey: keys.dashboard(dashboardId) });
  useRealtimeChannel(isId('dsh', dashboardId) ? dashboardChannel(dashboardId) : null, {
    onMessage: (message) => {
      if (message.type === 'dashboard.changed') {
        void refreshDashboard();
      } else if (message.type === 'dashboard.data_changed') {
        gate.current?.push(message.table_ids);
      }
    },
    onError: (code) => {
      if (code === 'NOT_FOUND') void refreshDashboard();
    },
    onReconnect: () => {
      void refreshDashboard();
      for (const widget of current.current) {
        void queryClient.invalidateQueries({ queryKey: ['widget', widget.id] });
      }
    },
  });
}
