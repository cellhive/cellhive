import { queryOptions } from '@tanstack/react-query';

import { keys } from './keys';

/**
 * The dashboard API, loaded on first use: the sidebar entry of the app
 * shell lists dashboards without carrying the dashboard schemas
 * (FRONTEND §11.1).
 */
export const loadDashboardsApi = () =>
  import('../api/dashboards').then((module) => module.dashboardsApi);

/**
 * (T811) Dashboards of a base the caller can read (CONTRACTS §28.1), in
 * order: the sidebar group, its menu actions and the dashboard page read
 * this one entry. Under the base prefix: `permission.changed` asks again.
 */
export const dashboardsQuery = (baseId: string) =>
  queryOptions({
    queryKey: keys.dashboards(baseId),
    queryFn: async ({ signal }) => (await loadDashboardsApi()).list(baseId, signal),
    staleTime: 60_000,
  });

/** (T811) Dashboards in the base trash (base admins; others get `403`). */
export const dashboardTrashQuery = (baseId: string) =>
  queryOptions({
    queryKey: keys.dashboardTrash(baseId),
    queryFn: async ({ signal }) => (await loadDashboardsApi()).trash(baseId, signal),
  });

/** (T811) One dashboard with its widgets (CONTRACTS §28.1). */
export const dashboardQuery = (dashboardId: string) =>
  queryOptions({
    queryKey: keys.dashboard(dashboardId),
    queryFn: async ({ signal }) => (await loadDashboardsApi()).get(dashboardId, signal),
  });

/** Path of a dashboard's page. */
export function dashboardPath(baseId: string, dashboardId: string): string {
  return `/b/${encodeURIComponent(baseId)}/d/${encodeURIComponent(dashboardId)}`;
}
