import {
  baseMemberListSchema,
  dashboardListSchema,
  dashboardSchema,
  dashboardTrashSchema,
  widgetDataSchema,
  widgetOptionsSchema,
  widgetRecordsSchema,
  widgetSchema,
  type DashboardGlobalFilter,
  type DashboardTheme,
  type WidgetDataRequest,
  type WidgetLayout,
  type WidgetOptionsRequest,
  type WidgetRecordsRequest,
  type WidgetType,
} from '@cellhive/contracts';

import { apiRequest, apiRequestVoid, UNCHECKED_SCHEMA } from './client';

const id = encodeURIComponent;
const DEV = import.meta.env.DEV;

/** `If-Match` with the dashboard version the screen showed (CONTRACTS §28.1). */
function ifMatch(version: number | undefined): Readonly<Record<string, string>> | undefined {
  return version === undefined ? undefined : { 'If-Match': `"${String(version)}"` };
}

/**
 * Dashboards of a base (CONTRACTS §28, T805–T807). Loaded on first use: the
 * sidebar (app shell) reads the list through `lib/query/dashboards.ts`
 * without carrying these schemas, which are only checked in development
 * (FRONTEND §3.1, T700).
 */
export const dashboardsApi = {
  list: (baseId: string, signal?: AbortSignal) =>
    apiRequest(`/bases/${id(baseId)}/dashboards`, DEV ? dashboardListSchema : UNCHECKED_SCHEMA, {
      signal,
    }),
  create: (baseId: string, body: { name: string }) =>
    apiRequest(`/bases/${id(baseId)}/dashboards`, DEV ? dashboardSchema : UNCHECKED_SCHEMA, {
      method: 'POST',
      body,
    }),
  get: (dashboardId: string, signal?: AbortSignal) =>
    apiRequest(`/dashboards/${id(dashboardId)}`, DEV ? dashboardSchema : UNCHECKED_SCHEMA, {
      signal,
    }),
  rename: (dashboardId: string, name: string, version?: number) =>
    apiRequest(`/dashboards/${id(dashboardId)}`, DEV ? dashboardSchema : UNCHECKED_SCHEMA, {
      method: 'PATCH',
      body: { name },
      headers: ifMatch(version),
    }),
  duplicate: (dashboardId: string) =>
    apiRequest(
      `/dashboards/${id(dashboardId)}/duplicate`,
      DEV ? dashboardSchema : UNCHECKED_SCHEMA,
      { method: 'POST', body: {} },
    ),
  remove: (dashboardId: string) =>
    apiRequestVoid(`/dashboards/${id(dashboardId)}`, { method: 'DELETE' }),
  trash: (baseId: string, signal?: AbortSignal) =>
    apiRequest(
      `/bases/${id(baseId)}/dashboards/trash`,
      DEV ? dashboardTrashSchema : UNCHECKED_SCHEMA,
      { signal },
    ),
  restore: (dashboardId: string) =>
    apiRequest(`/dashboards/${id(dashboardId)}/restore`, DEV ? dashboardSchema : UNCHECKED_SCHEMA, {
      method: 'POST',
    }),
  /** (T812) `PUT /dashboards/:id/layout`: the place of every widget, in one write. */
  putLayout: (dashboardId: string, layout: Record<string, WidgetLayout>, version: number) =>
    apiRequest(`/dashboards/${id(dashboardId)}/layout`, DEV ? dashboardSchema : UNCHECKED_SCHEMA, {
      method: 'PUT',
      body: { layout },
      headers: ifMatch(version),
    }),
  /** (T812) The theme of a dashboard (the whole block, CONTRACTS §28.1). */
  updateTheme: (dashboardId: string, theme: DashboardTheme, version: number) =>
    apiRequest(`/dashboards/${id(dashboardId)}`, DEV ? dashboardSchema : UNCHECKED_SCHEMA, {
      method: 'PATCH',
      body: { theme },
      headers: ifMatch(version),
    }),
  /** (T812) `POST /dashboards/:id/widgets`. */
  createWidget: (
    dashboardId: string,
    body: {
      type: WidgetType;
      title: string;
      config: Record<string, unknown>;
      layout: WidgetLayout;
    },
    version: number,
  ) =>
    apiRequest(`/dashboards/${id(dashboardId)}/widgets`, DEV ? widgetSchema : UNCHECKED_SCHEMA, {
      method: 'POST',
      body,
      headers: ifMatch(version),
    }),
  /** (T812) `PATCH /widgets/:id`: title and the whole config. */
  updateWidget: (
    widgetId: string,
    body: { title: string; config: Record<string, unknown> },
    version: number,
  ) =>
    apiRequest(`/widgets/${id(widgetId)}`, DEV ? widgetSchema : UNCHECKED_SCHEMA, {
      method: 'PATCH',
      body,
      headers: ifMatch(version),
    }),
  /** (T812) `DELETE /widgets/:id`. */
  removeWidget: (widgetId: string, version: number) =>
    apiRequestVoid(`/widgets/${id(widgetId)}`, { method: 'DELETE', headers: ifMatch(version) }),
  /** `POST /widgets/:id/data` (CONTRACTS §28.3): aggregated numbers with the viewer's permissions. */
  widgetData: (widgetId: string, body: WidgetDataRequest, signal?: AbortSignal) =>
    apiRequest(`/widgets/${id(widgetId)}/data`, DEV ? widgetDataSchema : UNCHECKED_SCHEMA, {
      method: 'POST',
      body,
      signal,
    }),
  /** (T813) Global filters of a dashboard (the whole list, CONTRACTS §28.1). */
  updateGlobalFilters: (
    dashboardId: string,
    globalFilters: readonly DashboardGlobalFilter[],
    version: number,
  ) =>
    apiRequest(`/dashboards/${id(dashboardId)}`, DEV ? dashboardSchema : UNCHECKED_SCHEMA, {
      method: 'PATCH',
      body: { global_filters: globalFilters },
      headers: ifMatch(version),
    }),
  /** (T813) People of a base (`GET /bases/:id/members`): the values of a global `user` filter. */
  baseMembers: (baseId: string, signal?: AbortSignal) =>
    apiRequest(`/bases/${id(baseId)}/members`, DEV ? baseMemberListSchema : UNCHECKED_SCHEMA, {
      signal,
    }),
  /** (T813) `POST /widgets/:id/options`: values of a filter control (CONTRACTS §28.4). */
  widgetOptions: (widgetId: string, body: WidgetOptionsRequest, signal?: AbortSignal) =>
    apiRequest(`/widgets/${id(widgetId)}/options`, DEV ? widgetOptionsSchema : UNCHECKED_SCHEMA, {
      method: 'POST',
      body,
      signal,
    }),
  /** (T813) `POST /widgets/:id/records`: click-through (CONTRACTS §28.4). */
  widgetRecords: (widgetId: string, body: WidgetRecordsRequest, signal?: AbortSignal) =>
    apiRequest(`/widgets/${id(widgetId)}/records`, DEV ? widgetRecordsSchema : UNCHECKED_SCHEMA, {
      method: 'POST',
      body,
      signal,
    }),
};
