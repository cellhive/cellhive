import { z } from 'zod';

import {
  widgetDataRequestSchema,
  widgetDataSchema,
  widgetExportQuerySchema,
  widgetOptionsRequestSchema,
  widgetOptionsSchema,
  widgetRecordsRequestSchema,
  widgetRecordsSchema,
} from '../../dashboard-data.js';
import {
  createWidgetRequestSchema,
  updateWidgetRequestSchema,
  widgetSchema,
} from '../../dashboard-widgets.js';
import {
  createDashboardRequestSchema,
  dashboardIfMatchHeaderSchema,
  dashboardListSchema,
  dashboardSchema,
  dashboardTrashSchema,
  duplicateDashboardRequestSchema,
  updateDashboardLayoutRequestSchema,
  updateDashboardRequestSchema,
} from '../../dashboards.js';
import { idOf } from '../../ids.js';
import { problemResponse, type RouteRegistrar } from '../types.js';

import { SESSION_SECURITY_SCHEME } from './auth.js';
import { register, type RouteSpec } from './route-spec.js';

const baseParams = z.object({ baseId: idOf('bse') });
const dashboardParams = z.object({ dashboardId: idOf('dsh') });
const widgetParams = z.object({ widgetId: idOf('wgt') });

const READ =
  'Readable by base owners/admins, system `editor`/`reader` roles, and custom roles with ' +
  '`dashboards.<id> = read_only`; anyone else gets `404` (SPEC §10). API tokens: `schema:read`.';
const MANAGE =
  'Base owners/admins only: others who can see the dashboard get `403 PERMISSION_DENIED`, ' +
  'others `404`. API tokens: `schema:write`.';
const CONFLICT =
  '`VERSION_CONFLICT`: `If-Match` / `version` is not the current dashboard version ' +
  '(`errors[0].params.current_version`)';
const NAME_CONFLICT =
  '`NAME_CONFLICT` (`params.kind = dashboard`): another dashboard of the base outside the ' +
  'trash has this name, ignoring case';
const VERSION =
  'Bumps the dashboard `version`; the expected one may be sent as `If-Match` or `version`.';
const WIDGET_CONFIG =
  '`VALIDATION_FAILED` under `config`: `UNKNOWN_TABLE`, `UNKNOWN_FIELD` (not an active field ' +
  'of `table_id`), `INVALID_DIMENSION`, `DATE_BUCKET_REQUIRED`, `INVALID_METRIC`, ' +
  '`INVALID_FILTER`, `MAX_CONDITIONS_EXCEEDED`, `UNKNOWN_WIDGET` (`filter_bindings`, ' +
  '`parent_control_id`), `INVALID_FILTER_CONTROL`';
const LAYOUT =
  '`LAYOUT_OUT_OF_BOUNDS` (outside the 12-column grid), `LAYOUT_OVERLAP` (`params.other`)';
const LIVE =
  'Live `filters` (CONTRACTS §28.4): only sources the dashboard declares — a global filter, ' +
  'a `filter_control` widget, a cross-filter on a grouped widget’s dimension; the server ' +
  'builds every condition from the declared field. Filters that do not concern the widget ' +
  '(another table, a control it does not follow, its own cross-filter) or name a field the ' +
  'caller cannot read are not applied and listed in `ignored_filters`.';
const LIVE_ERRORS =
  'under `filters`: `UNKNOWN_FILTER` (not a global filter of the dashboard), ' +
  '`UNKNOWN_WIDGET` (not a filter control / grouped widget of the dashboard), ' +
  '`INVALID_FILTER_VALUE` (a value that does not fit the control or the dimension), ' +
  'a key other than `source`, `id`/`widget_id`, `value`';
const TIMEOUT =
  '`QUERY_TIMEOUT` with `Retry-After`: the query took more than 10 s (or waited that long)';

/** Dashboards and widgets (SPEC §10, CONTRACTS §28; BACKLOG T805). */
export const registerDashboardRoutes: RouteRegistrar = (registry, components) => {
  const problem = (description: string) => problemResponse(components, description);
  const add = (spec: RouteSpec) => {
    register(registry, problem, spec);
  };

  add({
    method: 'get',
    path: '/api/v1/bases/{baseId}/dashboards',
    operationId: 'listDashboards',
    tag: 'dashboards',
    summary: 'Dashboards of a base the caller can read',
    description: `By position. Dashboards the caller cannot read are not listed. ${READ}`,
    params: baseParams,
    status: 200,
    response: dashboardListSchema,
  });
  add({
    method: 'post',
    path: '/api/v1/bases/{baseId}/dashboards',
    operationId: 'createDashboard',
    tag: 'dashboards',
    summary: 'Create a dashboard',
    description:
      `${MANAGE} Placed last. Custom roles do not get it until an admin adds ` +
      '`dashboards.<id> = read_only` to them. Emits `dashboard.created` with its audit entry.',
    params: baseParams,
    body: createDashboardRequestSchema,
    status: 201,
    response: dashboardSchema,
    errors: {
      409: NAME_CONFLICT,
      422:
        '`VALIDATION_FAILED` / `DASHBOARD_LIMIT_EXCEEDED` (50 per base); `UNKNOWN_TABLE`, ' +
        '`UNKNOWN_FIELD`, `INVALID_FILTER_CONTROL` under `global_filters`',
    },
  });
  add({
    method: 'get',
    path: '/api/v1/bases/{baseId}/dashboards/trash',
    operationId: 'listDashboardTrash',
    tag: 'dashboards',
    summary: 'Dashboards in the base trash',
    description:
      'Base owners/admins only. Most recently deleted first; each is deleted for good 30 days ' +
      'after `deleted_at` (`purge_at`).',
    params: baseParams,
    status: 200,
    response: dashboardTrashSchema,
  });
  add({
    method: 'get',
    path: '/api/v1/dashboards/{dashboardId}',
    operationId: 'getDashboard',
    tag: 'dashboards',
    summary: 'A dashboard and its widgets',
    description:
      `${READ} A widget whose table or field was deleted keeps its config and reads as ` +
      '`status: broken`. Viewers who are not base admins get `config.filter = null`.',
    params: dashboardParams,
    status: 200,
    response: dashboardSchema,
  });
  add({
    method: 'patch',
    path: '/api/v1/dashboards/{dashboardId}',
    operationId: 'updateDashboard',
    tag: 'dashboards',
    summary: 'Rename, describe, theme, reorder or set the global filters',
    description: `${MANAGE} ${VERSION} Emits \`dashboard.updated\` with its audit entry.`,
    params: dashboardParams,
    headers: dashboardIfMatchHeaderSchema,
    body: updateDashboardRequestSchema,
    status: 200,
    response: dashboardSchema,
    errors: {
      409: `${NAME_CONFLICT}; ${CONFLICT}`,
      422: '`UNKNOWN_TABLE`, `UNKNOWN_FIELD`, `INVALID_FILTER_CONTROL` under `global_filters`',
    },
  });
  add({
    method: 'delete',
    path: '/api/v1/dashboards/{dashboardId}',
    operationId: 'deleteDashboard',
    tag: 'dashboards',
    summary: 'Move a dashboard to the base trash',
    description: `${MANAGE} Kept 30 days. Emits \`dashboard.deleted\` with its audit entry.`,
    params: dashboardParams,
    headers: dashboardIfMatchHeaderSchema,
    status: 204,
    errors: { 409: CONFLICT },
  });
  add({
    method: 'post',
    path: '/api/v1/dashboards/{dashboardId}/restore',
    operationId: 'restoreDashboard',
    tag: 'dashboards',
    summary: 'Take a dashboard out of the trash',
    description:
      'Base owners/admins only. Placed last, with its widgets. Emits `dashboard.restored` with ' +
      'its audit entry.',
    params: dashboardParams,
    status: 200,
    response: dashboardSchema,
    errors: {
      409: NAME_CONFLICT,
      422: '`VALIDATION_FAILED` / `DASHBOARD_LIMIT_EXCEEDED`',
    },
  });
  add({
    method: 'post',
    path: '/api/v1/dashboards/{dashboardId}/duplicate',
    operationId: 'duplicateDashboard',
    tag: 'dashboards',
    summary: 'Copy a dashboard with its widgets',
    description:
      `${MANAGE} The copy is placed last; widget ids are new and filter bindings follow the ` +
      'copies. Emits `dashboard.duplicated` (`data.duplicated_from`) with its audit entry.',
    params: dashboardParams,
    body: duplicateDashboardRequestSchema,
    bodyOptional: true,
    status: 201,
    response: dashboardSchema,
    errors: { 409: NAME_CONFLICT, 422: '`VALIDATION_FAILED` / `DASHBOARD_LIMIT_EXCEEDED`' },
  });
  add({
    method: 'put',
    path: '/api/v1/dashboards/{dashboardId}/layout',
    operationId: 'updateDashboardLayout',
    tag: 'dashboards',
    summary: 'Place every widget in one write',
    description:
      `${MANAGE} Every widget of the dashboard needs a place; the layout is checked on the ` +
      '12-column grid, then stored compacted upwards (react-grid-layout `vertical`, shared ' +
      `\`compactLayout\` of the contracts). ${VERSION} Emits \`dashboard.updated\`.`,
    params: dashboardParams,
    headers: dashboardIfMatchHeaderSchema,
    body: updateDashboardLayoutRequestSchema,
    status: 200,
    response: dashboardSchema,
    errors: {
      409: CONFLICT,
      422: `\`VALIDATION_FAILED\` under \`layout.<widget id>\`: ${LAYOUT}, \`UNKNOWN_WIDGET\`; \`LAYOUT_INCOMPLETE\` (\`params.missing\`)`,
    },
  });
  add({
    method: 'post',
    path: '/api/v1/dashboards/{dashboardId}/widgets',
    operationId: 'createWidget',
    tag: 'dashboards',
    summary: 'Add a widget',
    description:
      `${MANAGE} The config is checked against the base when saved. Without \`layout\`: 6 × 6 ` +
      `at column 0 below every widget. ${VERSION} Emits \`dashboard.widget_created\`.`,
    params: dashboardParams,
    headers: dashboardIfMatchHeaderSchema,
    body: createWidgetRequestSchema,
    status: 201,
    response: widgetSchema,
    errors: {
      409: CONFLICT,
      422: `${WIDGET_CONFIG}; ${LAYOUT} under \`layout\`; \`WIDGET_LIMIT_EXCEEDED\` (30)`,
    },
  });
  add({
    method: 'patch',
    path: '/api/v1/widgets/{widgetId}',
    operationId: 'updateWidget',
    tag: 'dashboards',
    summary: 'Change the title, config or place of a widget',
    description: `${MANAGE} ${VERSION} Emits \`dashboard.widget_updated\`.`,
    params: widgetParams,
    headers: dashboardIfMatchHeaderSchema,
    body: updateWidgetRequestSchema,
    status: 200,
    response: widgetSchema,
    errors: { 409: CONFLICT, 422: `${WIDGET_CONFIG}; ${LAYOUT} under \`layout\`` },
  });
  add({
    method: 'delete',
    path: '/api/v1/widgets/{widgetId}',
    operationId: 'deleteWidget',
    tag: 'dashboards',
    summary: 'Delete a widget',
    description:
      `${MANAGE} Deleting a \`filter_control\` unbinds the widgets that followed it ` +
      `(\`data.unbound_widget_ids\`). ${VERSION} Emits \`dashboard.widget_deleted\`.`,
    params: widgetParams,
    headers: dashboardIfMatchHeaderSchema,
    status: 204,
    errors: { 409: CONFLICT },
  });
  add({
    method: 'post',
    path: '/api/v1/widgets/{widgetId}/duplicate',
    operationId: 'duplicateWidget',
    tag: 'dashboards',
    summary: 'Copy a widget on the same dashboard',
    description:
      `${MANAGE} Same title, config and size, placed below every widget. ${VERSION} Emits ` +
      '`dashboard.widget_created` (`data.duplicated_from`).',
    params: widgetParams,
    status: 201,
    response: widgetSchema,
    errors: { 422: '`VALIDATION_FAILED` / `WIDGET_LIMIT_EXCEEDED`' },
  });
  add({
    method: 'post',
    path: '/api/v1/widgets/{widgetId}/data',
    operationId: 'widgetData',
    tag: 'dashboards',
    summary: 'Numbers of a widget for the caller',
    description:
      'Who can read the dashboard can read its widgets’ data (others get `404`). The ' +
      'widget’s table is read with the **caller’s** permissions — table access, record read ' +
      'rule, field rules (P21) — in one aggregate statement; only aggregated numbers are ' +
      'returned. A widget naming a table or field the caller cannot read (dimension, metric, ' +
      'saved filter, comparison date, record columns) answers `status = no_permission` ' +
      'without numbers; a deleted one `broken`. Date buckets use the field’s zone, else ' +
      '`timezone`, else the organization zone; weeks start on Monday (ISO). Not for `text` ' +
      'and `filter_control` widgets. At most 4 widget queries per user and 20 per instance ' +
      'run at once (the rest wait). ' +
      LIVE +
      ' API tokens: `records:read`.',
    params: widgetParams,
    body: widgetDataRequestSchema,
    bodyOptional: true,
    read: true,
    status: 200,
    response: widgetDataSchema,
    errors: {
      422:
        '`VALIDATION_FAILED`: `UNKNOWN_WIDGET` (a `text` or `filter_control` widget), ' +
        `\`WIDGET_TOO_LARGE\` (more than 1 000 groups, \`params.groups\`); ${LIVE_ERRORS}`,
      504: TIMEOUT,
    },
  });
  add({
    method: 'post',
    path: '/api/v1/widgets/{widgetId}/options',
    operationId: 'widgetOptions',
    tag: 'dashboards',
    summary: 'Values a filter control offers the caller',
    description:
      'For a `select`, `user` or `text` `filter_control` widget of a dashboard the caller ' +
      'reads: distinct non-empty values of its field among the records the caller reads ' +
      '(read rule, field rules), narrowed by the values of its **parent controls** ' +
      '(`parent_control_id`, transitively — cascading slicers; other filters are ignored) ' +
      'and `search` (text: part of the value; select: of the option name; user: of the ' +
      'member name), at most 200 in natural order (`has_more`). `status = no_permission` ' +
      'without any value when the caller cannot read the field or its table. API tokens: ' +
      '`records:read`.',
    params: widgetParams,
    body: widgetOptionsRequestSchema,
    bodyOptional: true,
    read: true,
    status: 200,
    response: widgetOptionsSchema,
    errors: {
      422:
        '`VALIDATION_FAILED`: `UNKNOWN_WIDGET` (not a `select`/`user`/`text` filter control); ' +
        LIVE_ERRORS,
      504: TIMEOUT,
    },
  });
  add({
    method: 'post',
    path: '/api/v1/widgets/{widgetId}/records',
    operationId: 'widgetRecords',
    tag: 'dashboards',
    summary: 'Records behind a widget or one of its groups (click-through)',
    description:
      'The records the caller reads that the widget counts — read rule, saved filter, live ' +
      'filters — and, with `segment`, only those of that dimension (and series) group, ' +
      'grouped exactly like the widget. Records as `records/query` with ' +
      '`field_key_type=id`: only the fields the caller reads; at most 200 per page. Same ' +
      '`no_permission` / `broken` rule as the widget data. Signed-in callers only: share ' +
      `links have no click-through. ${LIVE} API tokens: \`records:read\`.`,
    params: widgetParams,
    body: widgetRecordsRequestSchema,
    bodyOptional: true,
    read: true,
    status: 200,
    response: widgetRecordsSchema,
    errors: {
      422:
        '`VALIDATION_FAILED`: `UNKNOWN_WIDGET` (a `text` or `filter_control` widget), ' +
        '`INVALID_FILTER_VALUE` under `segment` (a widget without groups or series, a value ' +
        `that cannot be a group); ${LIVE_ERRORS}`,
      504: TIMEOUT,
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/v1/widgets/{widgetId}/export',
    operationId: 'exportWidget',
    tags: ['dashboards'],
    summary: 'Export the numbers of a widget as CSV',
    description:
      'The aggregate table of `POST /widgets/{widgetId}/data` for the caller, with the same ' +
      '`filters` (JSON array) and `timezone` — one line per group (and series), "Other" ' +
      'last — never raw records. Headers: field names, metric labels (or the aggregation ' +
      'and field, in the caller’s language). UTF-8 with BOM, CRLF, cells starting with `=`, ' +
      "`+`, `-`, `@`, tab or CR prefixed with `'` (as table exports). Needs " +
      '`base_rule.download`; one running export per user (shared with table exports). ' +
      'Audited as `export.created` (`entity_type = dashboard_widget`, `after.row_count`). ' +
      'API tokens: `records:read`.',
    security: [{ [SESSION_SECURITY_SCHEME]: [] }],
    request: { params: widgetParams, query: widgetExportQuerySchema },
    responses: {
      200: {
        description: 'The file, with `Content-Disposition: attachment`',
        headers: {
          'Content-Disposition': {
            description: '`attachment; filename="…"; filename*=UTF-8\'\'…`',
            schema: { type: 'string' },
          },
        },
        content: {
          'text/csv; charset=utf-8': { schema: z.string().meta({ format: 'binary' }) },
        },
      },
      401: problem('`UNAUTHENTICATED`'),
      403: problem(
        '`PERMISSION_DENIED`: no `base_rule.download`, or the widget uses a field the caller ' +
          'cannot read; `INSUFFICIENT_SCOPE` for a token without `records:read`',
      ),
      404: problem('`NOT_FOUND`: the dashboard of the widget is not visible to the caller'),
      422: problem(
        '`VALIDATION_FAILED`: `WIDGET_NOT_EXPORTABLE` (`text`, `filter_control`, a record list ' +
          `or a broken widget), \`MALFORMED_JSON\` (\`filters\`); ${LIVE_ERRORS}`,
      ),
      429: problem(
        '`RATE_LIMITED` with `Retry-After`: another export of the caller is running, or the ' +
          'request limits',
      ),
      504: problem(TIMEOUT),
    },
  });
};
