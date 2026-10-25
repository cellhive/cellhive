import { z } from 'zod';

import {
  ATTACHMENT_DOWNLOAD_URL_SECONDS,
  ATTACHMENT_THUMBNAIL_MAX_PIXELS,
  thumbnailQuerySchema,
} from '../../attachments.js';
import { SHARE_CSRF_HEADER } from '../../client-constants.js';
import { widgetDataSchema, widgetOptionsSchema } from '../../dashboard-data.js';
import { TABLE_EXPORT_MEDIA_TYPES } from '../../exports.js';
import {
  recordGroupCountsResponseSchema,
  recordListResponseSchema,
  recordReadParamsSchema,
  recordSchema,
  recordSummariesResponseSchema,
} from '../../records.js';
import { SHARE_EMBED_PAGE_PATH } from '../../share-embed.js';
import {
  sharedDashboardSchema,
  shareExportQuerySchema,
  SHARE_FILE_RATE_LIMIT,
  SHARE_FILE_RATE_WINDOW_SECONDS,
  shareFileParamsSchema,
  shareMetaSchema,
  shareRecordGetQuerySchema,
  shareRecordGroupCountsRequestSchema,
  shareRecordQueryRequestSchema,
  shareRecordSummariesRequestSchema,
  shareTokenParamsSchema,
  shareUnlockRequestSchema,
  shareUnlockResponseSchema,
  SHARE_WIDGET_RATE_LIMIT,
  SHARE_WIDGET_RATE_WINDOW_SECONDS,
  shareWidgetDataRequestSchema,
  shareWidgetExportQuerySchema,
  shareWidgetOptionsRequestSchema,
  shareWidgetParamsSchema,
} from '../../shares.js';
import { problemResponse, type RouteRegistrar } from '../types.js';

import { SESSION_SECURITY_SCHEME } from './auth.js';
import { register, type RouteSpec } from './route-spec.js';

const recordParams = shareTokenParamsSchema.extend({
  recordId: z.string().meta({ description: 'Record id (`rec_…`)' }),
});

const shareCsrfHeaders = z.object({
  [SHARE_CSRF_HEADER]: z
    .string()
    .optional()
    .meta({
      description:
        'CSRF token of the unlock cookie (from `unlock` or `meta`); required on `POST` when the ' +
        'request carries a valid unlock cookie of the link (CONTRACTS §12.0)',
    }),
});

const ACCESS =
  'Public route (CONTRACTS §16A). Unknown or malformed token → `404`. Every response carries ' +
  '`X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer` and ' +
  '`Cache-Control: no-store`.';
const GONE =
  '`SHARE_LINK_GONE`: revoked, turned off, expired, blocked by the organization policy, target ' +
  'deleted or creator without access (one code, no reason)';
const UNAUTH = '`UNAUTHENTICATED`: audience `org` and no session';
const FORBIDDEN_READ = '`SHARE_PASSWORD_REQUIRED` (link with a password, no valid unlock cookie)';
const NOT_FOUND =
  '`NOT_FOUND`: unknown token, audience `org` and the caller is not a member of its ' +
  'organization';
const LIMIT = '`RATE_LIMITED` with `Retry-After`: more than 20 requests/s from the IP';
const FILE_LIMIT =
  '`RATE_LIMITED` with `Retry-After`: more than ' +
  `${String(SHARE_FILE_RATE_LIMIT)} file requests per ${String(SHARE_FILE_RATE_WINDOW_SECONDS)} s ` +
  'from the IP';
const WIDGET_LIMIT =
  '`RATE_LIMITED` with `Retry-After`: more than ' +
  `${String(SHARE_WIDGET_RATE_LIMIT)} widget requests per ` +
  `${String(SHARE_WIDGET_RATE_WINDOW_SECONDS)} s from the IP`;
const DASHBOARD_ONLY =
  'Dashboard links only (T809): a view or form link, or a widget of another dashboard, is ' +
  '`404`.';
const AS_LINK =
  "Read as the link: the creator's **current** access ∩ the tables of the dashboard, read " +
  "only, with the creator's record rules and rule variables (P71) — a widget naming a table " +
  'or field outside that scope answers `status = no_permission` without numbers.';
const LINK_FILTERS =
  'Live `filters` need `settings.dashboard.allow_filter_controls` (else `403 ' +
  'PERMISSION_DENIED`, `errors[].code = NOT_ALLOWED`, path `filters`) and may only name the ' +
  "dashboard's own sources: a global filter or widget the dashboard does not declare is " +
  '`403 NOT_ALLOWED` too (path `filters[i]…`).';
const WIDGET_TIMEOUT =
  '`QUERY_TIMEOUT` with `Retry-After`: the query took more than 10 s (or waited that long)';
const FILE_SCOPE =
  'The attachment must be in a cell (not removed) of a record of the view (the view filter and ' +
  "the creator's record rule apply) in a field of the link (not hidden in the view), else " +
  '`404`; a form link has no files (`404`).';

/** Public access through share links (SPEC §15A.3, CONTRACTS §16A; BACKLOG T305). */
export const registerShareRoutes: RouteRegistrar = (registry, components) => {
  const problem = (description: string) => problemResponse(components, description);
  const add = (spec: RouteSpec) => {
    register(registry, problem, spec);
  };

  add({
    method: 'get',
    path: '/api/v1/shares/{token}/meta',
    operationId: 'getShareMeta',
    tag: 'shares',
    summary: 'What a share link shows: table, view, fields in scope and settings',
    description:
      `${ACCESS} The view config is restricted to the fields of the link and never contains ` +
      'the view filter; field `options` carry only display keys (no linked table or field ids, ' +
      '`record_filter`, expressions or default users; T409); nothing about the organization, the ' +
      'creator or other users. Counts one access of the link.',
    public: true,
    params: shareTokenParamsSchema,
    status: 200,
    response: shareMetaSchema,
    errors: {
      401: UNAUTH,
      403: FORBIDDEN_READ,
      404:
        `${NOT_FOUND}; a dashboard link (once every other check passed): ` +
        '`errors[0].code = DASHBOARD_LINK`, read `GET /shares/{token}/dashboard` instead (T809)',
      410: GONE,
      429: LIMIT,
    },
  });
  add({
    method: 'get',
    path: '/api/v1/shares/{token}/dashboard',
    operationId: 'getSharedDashboard',
    tag: 'shares',
    summary: 'What a dashboard link shows: dashboard, widgets, fields in scope and settings',
    description:
      `${ACCESS} ${DASHBOARD_ONLY} Widgets in reading order; one the link cannot read is ` +
      '`status = no_permission`, one naming a deleted table or field `broken` — both without ' +
      '`config`. A `config` never carries the saved `filter` (always `null`; still applied by ' +
      'the server). Global filters keep only targets the link reads; `fields` lists the ' +
      'fields the configuration names, with display options only (as `meta`). ' +
      '`settings.allow_export` is the link setting and the creator’s current ' +
      '`base_rule.download`. No realtime: the page polls the widgets every ' +
      '`settings.refresh_seconds`. Counts one access of the link.',
    public: true,
    params: shareTokenParamsSchema,
    status: 200,
    response: sharedDashboardSchema,
    errors: { 401: UNAUTH, 403: FORBIDDEN_READ, 404: NOT_FOUND, 410: GONE, 429: LIMIT },
  });
  add({
    method: 'post',
    path: '/api/v1/shares/{token}/widgets/{widgetId}/data',
    operationId: 'sharedWidgetData',
    tag: 'shares',
    summary: 'Numbers of a widget of the shared dashboard',
    description:
      `${ACCESS} ${DASHBOARD_ONLY} \`POST /widgets/{widgetId}/data\` through the link. ` +
      `${AS_LINK} ${LINK_FILTERS} User values carry \`id\` and \`name\` only; a linked record ` +
      'the creator cannot read is `{ "id": null, "title": null }` (a group value: `null`). ' +
      'Widget queries of one link wait in one line (at most 4 at once).',
    public: true,
    params: shareWidgetParamsSchema,
    headers: shareCsrfHeaders,
    body: shareWidgetDataRequestSchema,
    bodyOptional: true,
    status: 200,
    response: widgetDataSchema,
    forbidden: `${FORBIDDEN_READ}, \`PERMISSION_DENIED\` (\`NOT_ALLOWED\`), or \`CSRF_INVALID\``,
    errors: {
      401: UNAUTH,
      404: `${NOT_FOUND}; not a widget of the link's dashboard`,
      410: GONE,
      422:
        '`VALIDATION_FAILED`: `UNKNOWN_WIDGET` (a `text` or `filter_control` widget), ' +
        '`WIDGET_TOO_LARGE`, `INVALID_FILTER_VALUE` under `filters`',
      429: WIDGET_LIMIT,
      504: WIDGET_TIMEOUT,
    },
  });
  add({
    method: 'post',
    path: '/api/v1/shares/{token}/widgets/{widgetId}/options',
    operationId: 'sharedWidgetOptions',
    tag: 'shares',
    summary: 'Values a filter control of the shared dashboard offers',
    description:
      `${ACCESS} ${DASHBOARD_ONLY} \`POST /widgets/{widgetId}/options\` through the link. ` +
      `${AS_LINK} Needs \`settings.dashboard.allow_filter_controls\` (else \`403 ` +
      'PERMISSION_DENIED`, `errors[].code = NOT_ALLOWED`).',
    public: true,
    params: shareWidgetParamsSchema,
    headers: shareCsrfHeaders,
    body: shareWidgetOptionsRequestSchema,
    bodyOptional: true,
    status: 200,
    response: widgetOptionsSchema,
    forbidden: `${FORBIDDEN_READ}, \`PERMISSION_DENIED\` (\`NOT_ALLOWED\`), or \`CSRF_INVALID\``,
    errors: {
      401: UNAUTH,
      404: `${NOT_FOUND}; not a widget of the link's dashboard`,
      410: GONE,
      422:
        '`VALIDATION_FAILED`: `UNKNOWN_WIDGET` (not a `select`/`user`/`text` filter control), ' +
        '`INVALID_FILTER_VALUE` under `filters`',
      429: WIDGET_LIMIT,
      504: WIDGET_TIMEOUT,
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/v1/shares/{token}/widgets/{widgetId}/export',
    operationId: 'exportSharedWidget',
    tags: ['shares'],
    summary: 'Export the numbers of a widget of the shared dashboard as CSV',
    description:
      `${ACCESS} ${DASHBOARD_ONLY} \`GET /widgets/{widgetId}/export\` through the link (same ` +
      `file). ${AS_LINK} Needs \`allow_export\` and the creator's **current** ` +
      '`base_rule.download` (else `403`); live `filters` as the widget data. One running ' +
      'export per link and per IP. Audited as `export.created` (actor `share_link`, ' +
      '`via.share_link_id`, `after.share_link_id`; no token, no value).',
    security: [{ [SESSION_SECURITY_SCHEME]: [] }, {}],
    request: { params: shareWidgetParamsSchema, query: shareWidgetExportQuerySchema },
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
          'text/csv; charset=utf-8': { schema: { type: 'string', format: 'binary' } },
        },
      },
      401: problem(UNAUTH),
      403: problem(
        `${FORBIDDEN_READ}, or \`PERMISSION_DENIED\`: \`allow_export = false\` or live filters ` +
          'not allowed (`errors[].code = NOT_ALLOWED`), or the creator has no ' +
          '`base_rule.download` now',
      ),
      404: problem(`${NOT_FOUND}; not a widget of the link's dashboard`),
      410: problem(GONE),
      422: problem(
        '`VALIDATION_FAILED`: `WIDGET_NOT_EXPORTABLE`, `MALFORMED_JSON` (`filters`), ' +
          '`INVALID_FILTER_VALUE` under `filters`',
      ),
      429: problem(`${WIDGET_LIMIT}, or another export of the link or from the IP is running`),
      504: problem(WIDGET_TIMEOUT),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/v1/shares/{token}/page',
    operationId: 'getSharePageHeaders',
    tags: ['shares'],
    summary: 'Headers of an embedded share page (internal to the web server)',
    description:
      'Asked by the web server for `/s/{token}?embed=1` (T809): an empty `text/html` answer ' +
      `with \`X-Accel-Redirect: ${SHARE_EMBED_PAGE_PATH}\` and the page's ` +
      "`Content-Security-Policy`: `frame-ancestors` lists the link's " +
      '`settings.embed.allowed_origins` when the link works now, is `public`, has no ' +
      'password and has `settings.embed.enabled`; anything else (unknown, revoked, ' +
      "expired link, rate limit…) is `frame-ancestors 'none'` and `X-Frame-Options: DENY`. " +
      'Always `200`, never any data of the link.',
    security: [{}],
    request: { params: shareTokenParamsSchema },
    responses: {
      200: {
        description: 'Empty; the headers of the page',
        headers: {
          'Content-Security-Policy': {
            description: "Policy of the web client with the link's `frame-ancestors`",
            schema: { type: 'string' },
          },
          'X-Frame-Options': {
            description: '`DENY` when the page may not be framed; absent otherwise',
            schema: { type: 'string' },
          },
          'X-Accel-Redirect': {
            description: `\`${SHARE_EMBED_PAGE_PATH}\``,
            schema: { type: 'string' },
          },
        },
        content: { 'text/html; charset=utf-8': { schema: { type: 'string' } } },
      },
    },
  });
  add({
    method: 'post',
    path: '/api/v1/shares/{token}/records/query',
    operationId: 'queryShareRecords',
    tag: 'shares',
    summary: 'Records of the shared view',
    description:
      `${ACCESS} The record query of CONTRACTS §1.4 through the view of the link: its filter ` +
      'always applies, fields hidden in the view do not exist (unknown in `fields`, `filter`, ' +
      '`sort`, `group` → `422` like a missing field). `filter`, `sort` and `group` need ' +
      '`allow_viewer_filter_sort`, `search` needs `allow_search` (else `403 PERMISSION_DENIED`, ' +
      '`errors[].code = NOT_ALLOWED`). A form link has no records (`404`). User values carry ' +
      "`id` and `name` only. Link values carry titles the link's creator reads; a linked " +
      'record they cannot read is `{ "id": null, "title": null }` (T409). Attachment `url` / ' +
      '`thumbnail_url` are the share file routes. Ignores `Idempotency-Key`.',
    public: true,
    params: shareTokenParamsSchema,
    query: recordReadParamsSchema,
    headers: shareCsrfHeaders,
    body: shareRecordQueryRequestSchema,
    status: 200,
    response: recordListResponseSchema,
    forbidden:
      `${FORBIDDEN_READ}, \`PERMISSION_DENIED\` (viewer filter/sort/group/search not allowed), ` +
      'or `CSRF_INVALID`',
    errors: {
      401: UNAUTH,
      404: NOT_FOUND,
      410: GONE,
      422: '`VALIDATION_FAILED`, `INVALID_FILTER`, `INVALID_SORT`',
      429: LIMIT,
    },
  });
  add({
    method: 'post',
    path: '/api/v1/shares/{token}/records/group-counts',
    operationId: 'countShareRecordGroups',
    tag: 'shares',
    summary: 'Count the records of the shared view per group',
    description:
      `${ACCESS} The group counts of CONTRACTS §1.4 through the view of the link (T317): same ` +
      "WHERE as the link's `records/query`, grouped by the view's saved group (levels on " +
      'fields outside the link left out) or by `group`. `filter` and `group` need ' +
      '`allow_viewer_filter_sort`, except `group` = exactly the `kanban.group_field` of a ' +
      'kanban view (the columns of the board); `search` needs `allow_search` (else ' +
      '`403 PERMISSION_DENIED`, `errors[].code = NOT_ALLOWED`). A form link has no records ' +
      '(`404`). User values carry `id` and `name` only. Ignores `Idempotency-Key`.',
    public: true,
    params: shareTokenParamsSchema,
    query: recordReadParamsSchema,
    headers: shareCsrfHeaders,
    body: shareRecordGroupCountsRequestSchema,
    status: 200,
    response: recordGroupCountsResponseSchema,
    forbidden:
      `${FORBIDDEN_READ}, \`PERMISSION_DENIED\` (viewer filter/group/search not allowed), ` +
      'or `CSRF_INVALID`',
    errors: {
      401: UNAUTH,
      404: NOT_FOUND,
      410: GONE,
      422: '`VALIDATION_FAILED`, `INVALID_FILTER`, `INVALID_SORT`',
      429: LIMIT,
    },
  });
  add({
    method: 'post',
    path: '/api/v1/shares/{token}/records/summaries',
    operationId: 'summarizeShareRecords',
    tag: 'shares',
    summary: 'Summarize the records of the shared view',
    description:
      `${ACCESS} The summary bar of CONTRACTS §1.4 through the view of the link (T472): same ` +
      "WHERE as the link's `records/query`, the view's saved `summaries` on fields inside the " +
      'link and not locked for it (others left out), grouped like `records/group-counts` of ' +
      'the link. A request `summaries` on a field outside the link or locked for it is ' +
      '`422 VALIDATION_FAILED` / `UNKNOWN_FIELD` (T501). `summaries`, ' +
      '`filter` and `group` need `allow_viewer_filter_sort`; `search` needs `allow_search` ' +
      '(else `403 PERMISSION_DENIED`, `errors[].code = NOT_ALLOWED`). A form link has no ' +
      'records (`404`). User values carry `id` and `name` only. Ignores `Idempotency-Key`.',
    public: true,
    params: shareTokenParamsSchema,
    query: recordReadParamsSchema,
    headers: shareCsrfHeaders,
    body: shareRecordSummariesRequestSchema,
    status: 200,
    response: recordSummariesResponseSchema,
    forbidden:
      `${FORBIDDEN_READ}, \`PERMISSION_DENIED\` (viewer summaries/filter/group/search not ` +
      'allowed), or `CSRF_INVALID`',
    errors: {
      401: UNAUTH,
      404: NOT_FOUND,
      410: GONE,
      422: '`VALIDATION_FAILED`, `INVALID_FILTER`, `INVALID_SORT`',
      429: LIMIT,
      504: '`QUERY_TIMEOUT`',
    },
  });
  add({
    method: 'get',
    path: '/api/v1/shares/{token}/records/{recordId}',
    operationId: 'getShareRecord',
    tag: 'shares',
    summary: 'One record of the shared view',
    description:
      `${ACCESS} Only with \`show_record_detail\` (else \`404\`); a record outside the view ` +
      'filter is `404`. Fields as in the query.',
    public: true,
    params: recordParams,
    query: shareRecordGetQuerySchema,
    status: 200,
    response: recordSchema,
    errors: {
      401: UNAUTH,
      403: FORBIDDEN_READ,
      404: `${NOT_FOUND}; \`show_record_detail = false\`; record not found or outside the view`,
      410: GONE,
      429: LIMIT,
    },
  });
  add({
    method: 'post',
    path: '/api/v1/shares/{token}/unlock',
    operationId: 'unlockShare',
    tag: 'shares',
    summary: 'Unlock a link that has a password',
    description:
      `${ACCESS} Sets the HttpOnly cookie \`ob_share_<link id>\` (\`SameSite=Strict\`, ` +
      '`Path=/api/v1/shares/`, 24 h, bound to the link and its current password) and returns ' +
      'its CSRF token. 5 wrong passwords within 15 minutes from one IP lock that IP out of the ' +
      'link for 15 minutes (`429`, audit `share_link.unlock_failed`). A link without password ' +
      'answers `200` with `null`s and no cookie. Ignores `Idempotency-Key`.',
    public: true,
    params: shareTokenParamsSchema,
    body: shareUnlockRequestSchema,
    status: 200,
    response: shareUnlockResponseSchema,
    forbidden: '`SHARE_PASSWORD_INVALID` (wrong password) or `CSRF_INVALID` (session cookie)',
    errors: {
      401: UNAUTH,
      404: NOT_FOUND,
      410: GONE,
      429: `${LIMIT}, or the IP is locked out of the link after wrong passwords`,
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/v1/shares/{token}/export',
    operationId: 'exportShareView',
    tags: ['shares'],
    summary: 'Export the shared view as CSV or XLSX',
    description:
      `${ACCESS} Same checks, in the same order, as the other share routes (rate limit, token, ` +
      'audience, password), then: a form link has no records (`404`); the link needs ' +
      "`allow_export` and the creator's **current** `base_rule.download` (else `403`); one " +
      'running export per link and per IP (`429`); more rows than `EXPORT_MAX_ROWS` → `422`. ' +
      "Rows and columns are the link's (T810): the creator's current access ∩ the view — the " +
      'view filter always applies, fields hidden in the view and fields the creator cannot read ' +
      "are never exported, the creator's record rule applies; the saved view only (no filter, " +
      'sort or search of the viewer). File format, columns and CSV injection guard as ' +
      '`GET /tables/{tableId}/export`; values as `cell_format=text` in the locale of ' +
      '`Accept-Language` and the zone `tz` (default: the organization zone), user values by ' +
      'name, linked records the creator cannot read left out. Audited as `export.created` ' +
      '(actor `share_link`, `via.share_link_id`; no token, no value). An error after the first ' +
      'byte aborts the connection.',
    security: [{ [SESSION_SECURITY_SCHEME]: [] }, {}],
    request: { params: shareTokenParamsSchema, query: shareExportQuerySchema },
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
          [`${TABLE_EXPORT_MEDIA_TYPES.csv}; charset=utf-8`]: {
            schema: { type: 'string', format: 'binary' },
          },
          [TABLE_EXPORT_MEDIA_TYPES.xlsx]: { schema: { type: 'string', format: 'binary' } },
        },
      },
      401: problem(UNAUTH),
      403: problem(
        `${FORBIDDEN_READ}, or \`PERMISSION_DENIED\`: \`allow_export = false\` ` +
          '(`errors[].code = NOT_ALLOWED`) or the creator has no `base_rule.download` now',
      ),
      404: problem(`${NOT_FOUND}; a form link`),
      410: problem(GONE),
      422: problem(
        '`VALIDATION_FAILED`: bad `format` or `tz`, or `EXPORT_TOO_LARGE` (`params.limit`)',
      ),
      429: problem(`${LIMIT}, or another export of the link or from the IP is running`),
      504: problem('`QUERY_TIMEOUT`: counting the rows took longer than the statement timeout'),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/v1/shares/{token}/files/{attachmentId}',
    operationId: 'downloadShareAttachment',
    tags: ['shares'],
    summary: 'Download an attachment of the shared view',
    description:
      `${ACCESS} Same checks, in the same order, as the other share routes (rate limit, token, ` +
      `audience, password), then: ${FILE_SCOPE} Downloading needs \`allow_download\` and the ` +
      "field among the creator's `file_download_fields` (else `403`). Redirects to a storage " +
      `URL valid ${String(ATTACHMENT_DOWNLOAD_URL_SECONDS)} seconds with the same ` +
      '`Content-Disposition` rules and headers as `GET /files/{attachmentId}` (the storage key ' +
      'never appears). Each download is audited (`share_link.file_downloaded`).',
    security: [{ [SESSION_SECURITY_SCHEME]: [] }, {}],
    request: { params: shareFileParamsSchema },
    responses: {
      302: {
        description: 'Redirect to the signed storage URL',
        headers: {
          Location: { description: 'Signed URL, valid 60 seconds', schema: { type: 'string' } },
        },
      },
      401: problem(UNAUTH),
      403: problem(
        `${FORBIDDEN_READ}, or \`PERMISSION_DENIED\`: \`allow_download = false\` or the field ` +
          "is not among the creator's `file_download_fields`",
      ),
      404: problem(`${NOT_FOUND}; attachment outside the link`),
      410: problem(GONE),
      422: problem('`VALIDATION_FAILED`: malformed attachment id'),
      429: problem(FILE_LIMIT),
    },
  });
  registry.registerPath({
    method: 'get',
    path: '/api/v1/shares/{token}/files/{attachmentId}/thumbnail',
    operationId: 'shareAttachmentThumbnail',
    tags: ['shares'],
    summary: 'Thumbnail of an image attachment of the shared view',
    description:
      `${ACCESS} Like \`GET /files/{attachmentId}/thumbnail\` (T407: PNG, JPEG, GIF, WebP up to ` +
      `${String(ATTACHMENT_THUMBNAIL_MAX_PIXELS / 1_000_000)} megapixels) through the link: ` +
      `${FILE_SCOPE} Needs neither \`allow_download\` nor \`file_download_fields\`. While the ` +
      'thumbnail is not rendered (or was skipped): a `302` to the original image when the link ' +
      'may download it, else `404`. Not audited.',
    security: [{ [SESSION_SECURITY_SCHEME]: [] }, {}],
    request: { params: shareFileParamsSchema, query: thumbnailQuerySchema },
    responses: {
      200: {
        description: 'The thumbnail',
        content: { 'image/webp': { schema: { type: 'string', format: 'binary' } } },
      },
      302: {
        description: 'No thumbnail (yet): redirect to the original image (download allowed)',
        headers: {
          Location: { description: 'Signed URL, valid 60 seconds', schema: { type: 'string' } },
        },
      },
      401: problem(UNAUTH),
      403: problem(FORBIDDEN_READ),
      404: problem(
        `${NOT_FOUND}; attachment outside the link, not an image, or no thumbnail (yet) and no ` +
          'download allowed',
      ),
      410: problem(GONE),
      422: problem('`VALIDATION_FAILED`: malformed attachment id or `size`'),
      429: problem(FILE_LIMIT),
    },
  });
};
