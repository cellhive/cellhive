import { z } from 'zod';

import { timeZoneSchema } from './auth.js';
import { SHARE_CSRF_HEADER } from './client-constants.js';
import { isoDateTimeSchema } from './common.js';
import { COMPUTE_ERROR_CODES, computedResultTypeSchema } from './computed-fields.js';
import {
  widgetDataRequestSchema,
  widgetExportQuerySchema,
  widgetOptionsRequestSchema,
} from './dashboard-data.js';
import { widgetLayoutSchema, widgetTypeSchema } from './dashboard-widgets.js';
import { dashboardGlobalFilterSchema, dashboardThemeSchema } from './dashboards.js';
import { tableExportFormatSchema } from './exports.js';
import { idOf } from './ids.js';
import {
  recordGetQuerySchema,
  recordGroupCountsRequestSchema,
  recordQueryRequestSchema,
  recordSummariesRequestSchema,
} from './records.js';
import { SHARE_LINK_PASSWORD_MAX_LENGTH } from './share-links.js';
import { fieldTypeNameSchema, type FieldTypeName } from './tables.js';
import { colorRuleSchema, viewConfigSchema, viewTypeSchema } from './views.js';

/**
 * Public access through a share link (SPEC §15A.2–15A.3, CONTRACTS §16A;
 * BACKLOG T305): `/shares/{token}/meta`, `/records/query`,
 * `/records/group-counts` (T317), `/records/{recordId}` and `/unlock`. Form
 * submission (`/shares/{token}/submit`) belongs to T306.
 */

/** CSRF header of an unlocked link (CONTRACTS §12.0), defined apart from the schemas. */
export { SHARE_CSRF_HEADER } from './client-constants.js';
/** Name prefix of the unlock cookie of a link: `ob_share_<shl_…>`. */
export const SHARE_UNLOCK_COOKIE_PREFIX = 'ob_share_';
/** Path of the unlock cookies: only the share API receives them. */
export const SHARE_UNLOCK_COOKIE_PATH = '/api/v1/shares/';
/** Lifetime of an unlock cookie (SPEC §15A.3: 24 h). */
export const SHARE_UNLOCK_TTL_SECONDS = 24 * 60 * 60;
/** Read requests per second and IP on `/shares/*` (BACKLOG S3 decision 5). */
export const SHARE_READ_RATE_LIMIT_PER_SECOND = 20;
/**
 * File requests (download and thumbnail, T409) per IP and window on
 * `/shares/{token}/files/…`, counted apart from the read limit: a page of images
 * loads many thumbnails at once. Unknown tokens count too.
 */
export const SHARE_FILE_RATE_LIMIT = 120;
/** Window of `SHARE_FILE_RATE_LIMIT`, in seconds. */
export const SHARE_FILE_RATE_WINDOW_SECONDS = 10;
/**
 * Widget requests (data, filter control values, CSV — T809) per IP and window
 * on `/shares/{token}/widgets/…`, counted apart from the read limit: a shared
 * dashboard loads up to 30 widgets at once and polls them. Unknown tokens
 * count too.
 */
export const SHARE_WIDGET_RATE_LIMIT = 120;
/** Window of `SHARE_WIDGET_RATE_LIMIT`, in seconds. */
export const SHARE_WIDGET_RATE_WINDOW_SECONDS = 10;
/** Wrong passwords per link and IP within the window before a temporary lock. */
export const SHARE_UNLOCK_MAX_FAILURES = 5;
/** Window of the failures and length of the lock, in seconds (15 minutes). */
export const SHARE_UNLOCK_WINDOW_SECONDS = 15 * 60;

/** `token` path parameter: a malformed or unknown token is `404`, never `422`. */
export const shareTokenParamsSchema = z.object({
  token: z.string().meta({ description: 'Token of the link (43 characters, base64url)' }),
});

/** `/shares/{token}/files/{attachmentId}[/thumbnail]` (T409). */
export const shareFileParamsSchema = shareTokenParamsSchema.extend({
  attachmentId: idOf('att'),
});

/**
 * `url` / `thumbnail_url` of an attachment read through a link (T409): the
 * share routes of the file instead of `/api/v1/files/…`, which need a
 * session.
 */
export function shareFileUrl(token: string, attachmentId: string, thumbnail = false): string {
  return `/api/v1/shares/${encodeURIComponent(token)}/files/${attachmentId}${thumbnail ? '/thumbnail' : ''}`;
}

/**
 * Keys of `meta.fields[].options` a share link returns, per field type
 * (CONTRACTS §16A, BACKLOG T409): only what the public page needs to show
 * values. Everything else is left out — ids of linked tables and fields
 * (`link_table`, `symmetric_field_id`), `record_filter`, expressions and
 * source tables/fields of formulas/lookups (only their `style`, T462),
 * default users. A type missing from the table returns `{}` (fail closed).
 */
export const SHARED_FIELD_OPTION_KEYS: Readonly<Record<FieldTypeName, readonly string[]>> = {
  text: ['style'],
  number: ['style'],
  select: ['multiple', 'options'],
  datetime: ['style', 'timezone'],
  checkbox: [],
  user: ['multiple'],
  created_at: ['style', 'timezone'],
  updated_at: ['style', 'timezone'],
  created_by: [],
  updated_by: [],
  auto_number: ['style'],
  link: ['allow_multiple'],
  parent: [],
  lookup: ['style'],
  formula: ['style'],
  attachment: [],
  // T517: a button never runs through a share link (its cell reads `disabled`).
  button: ['label', 'color'],
};

/**
 * Keys a **form** link returns on top of {@link SHARED_FIELD_OPTION_KEYS}:
 * what its questions need (defaults; file limits for T410 uploads).
 * `default_value` of `user` fields is never returned (it names members).
 */
export const SHARED_FORM_FIELD_OPTION_KEYS: Readonly<
  Partial<Record<FieldTypeName, readonly string[]>>
> = {
  text: ['default_value'],
  number: ['default_value'],
  select: ['default_value'],
  datetime: ['default_value'],
  attachment: ['accept', 'max_files', 'blocked_extensions'],
};

/**
 * The options of a field as a share link returns them: only the keys of
 * {@link SHARED_FIELD_OPTION_KEYS} (plus {@link SHARED_FORM_FIELD_OPTION_KEYS}
 * for a form link) that are present. Unknown types and non-object options
 * give `{}`.
 */
export function sharedFieldOptions(
  type: string,
  options: unknown,
  target: 'view' | 'form',
): Record<string, unknown> {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) return {};
  if (!Object.hasOwn(SHARED_FIELD_OPTION_KEYS, type)) return {};
  const name = type as FieldTypeName;
  const keys = [
    ...SHARED_FIELD_OPTION_KEYS[name],
    ...(target === 'form' ? (SHARED_FORM_FIELD_OPTION_KEYS[name] ?? []) : []),
  ];
  const source = options as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  for (const key of keys) if (Object.hasOwn(source, key)) kept[key] = source[key];
  return kept;
}

/** A field reachable through the link (never fields outside its scope). */
export const sharedFieldSchema = z
  .object({
    id: idOf('fld'),
    name: z.string(),
    type: fieldTypeNameSchema,
    options: z.record(z.string(), z.unknown()).meta({
      description:
        'Only the display keys of the type (`SHARED_FIELD_OPTION_KEYS`; form links also ' +
        '`SHARED_FORM_FIELD_OPTION_KEYS`): never ids of linked tables/fields, `record_filter`, ' +
        'formula expressions or default users (CONTRACTS §16A, T409)',
    }),
    is_primary: z.boolean(),
    description: z.string().nullable(),
    result_type: computedResultTypeSchema.optional().meta({
      description: 'Only on `formula`/`lookup` fields: the type of their value (T462)',
    }),
    compute_error: z
      .strictObject({ code: z.enum(COMPUTE_ERROR_CODES) })
      .nullable()
      .optional()
      .meta({
        description:
          'Only on `formula`/`lookup` fields: `null`, or the code of the field-level error ' +
          '(T462: never `refs` — no table or field outside the link is named)',
      }),
    locked: z
      .boolean()
      .optional()
      .meta({
        description:
          'Only on `formula`/`lookup` fields: `true` when the creator of the link cannot read ' +
          'what the value is computed from (T457 rules with the link as reader); its cells ' +
          'read `null` and viewer filters/sorts on it answer like an unknown field',
      }),
  })
  .meta({ id: 'SharedField' });
export type SharedFieldDto = z.infer<typeof sharedFieldSchema>;

/**
 * Config of the shared view: like `ViewConfig`, restricted to the fields of
 * the link, and **without** `filter` (the view filter always applies and is
 * never returned, BACKLOG S3 decision 3) and without `record_detail` (it names
 * fields of linked tables, outside the link's scope; T402).
 */
export const sharedViewConfigSchema = viewConfigSchema
  .omit({ filter: true, record_detail: true, color_rules: true })
  .extend({
    color_rules: z
      .array(colorRuleSchema.omit({ filter: true, broken: true }))
      .optional()
      .meta({
        description:
          'Color rules applied through the link (T816): only rules whose fields are all in ' +
          'the link’s scope, without their filter (the server evaluates them: ' +
          '`record.meta.color` names the rule)',
      }),
  })
  .meta({ id: 'SharedViewConfig' });
export type SharedViewConfigDto = z.infer<typeof sharedViewConfigSchema>;

/** Settings of the link the page needs (SPEC §15A.1). */
export const sharedLinkSettingsSchema = z
  .object({
    allow_copy: z.boolean(),
    allow_download: z.boolean().meta({
      description:
        'Attachments of the link may be downloaded (`GET /shares/{token}/files/{attachmentId}`, ' +
        'T409); thumbnails show without it',
    }),
    allow_export: z.boolean().meta({
      description:
        'The view may be exported through the link (`GET /shares/{token}/export`, T810): ' +
        "`allow_export` of the link and the creator's current `base_rule.download`; `false` " +
        'for a form link',
    }),
    allow_search: z.boolean(),
    allow_viewer_filter_sort: z.boolean(),
    show_record_detail: z.boolean(),
  })
  .meta({ id: 'SharedLinkSettings' });
export type SharedLinkSettings = z.infer<typeof sharedLinkSettingsSchema>;

/** `GET /shares/{token}/meta`: what the share page renders; nothing about the organization or users. */
export const shareMetaSchema = z
  .object({
    target_type: z.enum(['view', 'form']),
    table: z.object({ id: idOf('tbl'), name: z.string(), primary_field_id: idOf('fld') }),
    view: z.object({
      id: idOf('viw'),
      name: z.string(),
      type: viewTypeSchema,
      config: sharedViewConfigSchema,
    }),
    fields: z.array(sharedFieldSchema).meta({ description: 'In the order of the table' }),
    settings: sharedLinkSettingsSchema,
    download_fields: z.array(idOf('fld')).meta({
      description:
        'Attachment fields of the link whose files may be downloaded through it: ' +
        "`allow_download` and the creator's `file_download_fields` (T409); `[]` otherwise",
    }),
    expires_at: isoDateTimeSchema.nullable(),
    csrf_token: z
      .string()
      .nullable()
      .meta({
        description:
          `Link with a password, unlocked: value for the \`${SHARE_CSRF_HEADER}\` header of ` +
          'non-GET requests (CONTRACTS §12.0); `null` otherwise',
      }),
  })
  .meta({ id: 'ShareMeta' });
export type ShareMeta = z.infer<typeof shareMetaSchema>;

// --- Dashboard links (T809) -------------------------------------------------------------

/** Status of a widget through a dashboard link. */
export const SHARED_WIDGET_STATUSES = ['ok', 'broken', 'no_permission'] as const;

/**
 * A widget of a shared dashboard (CONTRACTS §16A, BACKLOG T809). `config`
 * is the stored config with the saved `filter` set to `null` (the server
 * applies it); `null` altogether when the widget names a table or field the
 * link cannot read (`no_permission`: nothing about it is shown) or no longer
 * exists (`broken`).
 */
export const sharedWidgetSchema = z
  .object({
    id: idOf('wgt'),
    type: widgetTypeSchema,
    title: z.string(),
    layout: widgetLayoutSchema,
    status: z.enum(SHARED_WIDGET_STATUSES),
    config: z.record(z.string(), z.unknown()).nullable(),
  })
  .meta({ id: 'SharedWidget' });
export type SharedWidgetDto = z.infer<typeof sharedWidgetSchema>;

/** A field named by the readable widgets, controls or global filters of a shared dashboard. */
export const sharedDashboardFieldSchema = sharedFieldSchema
  .pick({ id: true, name: true, type: true, options: true, result_type: true })
  .extend({ table_id: idOf('tbl') })
  .meta({ id: 'SharedDashboardField' });

/** Settings of a dashboard link the page needs (SPEC §15A.1). */
export const sharedDashboardSettingsSchema = z
  .object({
    allow_filter_controls: z.boolean().meta({
      description:
        'Live filters (global, controls, cross-filter) may be used; `false` → requests with ' +
        '`filters` and `…/options` answer `403 NOT_ALLOWED`',
    }),
    refresh_seconds: z.int().meta({
      description: 'The page polls `…/data` every so many seconds (no WS for links)',
    }),
    tv_mode: z.boolean(),
    allow_export: z.boolean().meta({
      description:
        "Widget CSV through the link: `allow_export` of the link and the creator's current " +
        '`base_rule.download`',
    }),
  })
  .meta({ id: 'SharedDashboardSettings' });

/**
 * `GET /shares/{token}/dashboard` (T809): what a dashboard link shows —
 * never the saved filters of widgets, a field or table the creator cannot
 * read now, the organization, the creator or other users.
 */
export const sharedDashboardSchema = z
  .object({
    target_type: z.literal('dashboard'),
    dashboard: z.object({
      id: idOf('dsh'),
      name: z.string(),
      description: z.string().nullable(),
      icon: z.string().nullable(),
      theme: dashboardThemeSchema,
      global_filters: z.array(dashboardGlobalFilterSchema).meta({
        description:
          'Targets on fields the link cannot read are left out, and filters without any target',
      }),
    }),
    widgets: z
      .array(sharedWidgetSchema)
      .meta({ description: 'In reading order: row, then column' }),
    fields: z.array(sharedDashboardFieldSchema).meta({
      description:
        'Fields the readable widgets, controls and global filters name (labels, options)',
    }),
    settings: sharedDashboardSettingsSchema,
    expires_at: isoDateTimeSchema.nullable(),
    csrf_token: z
      .string()
      .nullable()
      .meta({
        description: `Link with a password, unlocked: value for \`${SHARE_CSRF_HEADER}\` on \`POST\``,
      }),
  })
  .meta({ id: 'SharedDashboard' });
export type SharedDashboardDto = z.infer<typeof sharedDashboardSchema>;

/** `POST /shares/{token}/widgets/{widgetId}/data`: as for members (CONTRACTS §28.3–§28.4). */
export const shareWidgetDataRequestSchema = widgetDataRequestSchema;
/** `POST /shares/{token}/widgets/{widgetId}/options` (CONTRACTS §28.4). */
export const shareWidgetOptionsRequestSchema = widgetOptionsRequestSchema;
/** `GET /shares/{token}/widgets/{widgetId}/export` (CONTRACTS §28.6). */
export const shareWidgetExportQuerySchema = widgetExportQuerySchema;

/** `/shares/{token}/widgets/{widgetId}/…`. */
export const shareWidgetParamsSchema = shareTokenParamsSchema.extend({ widgetId: idOf('wgt') });

/**
 * `POST /shares/{token}/records/query`: the record query of CONTRACTS §1.4
 * without `view_id` (always the view of the link) and `filter_mode` (the
 * view filter always applies). `filter`, `sort`, `sort_mode: replace` and
 * `group` need `allow_viewer_filter_sort`, `search` needs `allow_search`.
 */
export const shareRecordQueryRequestSchema = recordQueryRequestSchema
  .omit({ view_id: true, filter_mode: true })
  .meta({ id: 'ShareRecordQueryRequest' });
export type ShareRecordQueryRequest = z.infer<typeof shareRecordQueryRequestSchema>;

/**
 * `POST /shares/{token}/records/group-counts` (T317): the group counts of
 * CONTRACTS §1.4 through the view of the link, without `view_id` and
 * `filter_mode`. `filter` and `group` need `allow_viewer_filter_sort`
 * — except `group` = the `kanban.group_field` of a kanban view (the columns
 * of the board, not a viewer grouping) — and `search` needs `allow_search`.
 */
export const shareRecordGroupCountsRequestSchema = recordGroupCountsRequestSchema
  .omit({ view_id: true, filter_mode: true })
  .meta({ id: 'ShareRecordGroupCountsRequest' });
export type ShareRecordGroupCountsRequest = z.infer<typeof shareRecordGroupCountsRequestSchema>;

/**
 * `POST /shares/{token}/records/summaries` (T472): the summary bar of the
 * shared grid through the view of the link, without `view_id` and
 * `filter_mode`. `summaries`, `filter` and `group` need
 * `allow_viewer_filter_sort`; `search` needs `allow_search`.
 */
export const shareRecordSummariesRequestSchema = recordSummariesRequestSchema
  .omit({ view_id: true, filter_mode: true })
  .meta({ id: 'ShareRecordSummariesRequest' });
export type ShareRecordSummariesRequest = z.infer<typeof shareRecordSummariesRequestSchema>;

/** `GET /shares/{token}/records/{recordId}` query string. */
export const shareRecordGetQuerySchema = recordGetQuerySchema;

/**
 * `GET /shares/{token}/export` (T810, CONTRACTS §16A, §18): the saved view
 * of the link as a file. No filter, sort or search of the viewer (like
 * `GET /tables/{tableId}/export`, the saved view only). Values follow the
 * viewer's locale (`Accept-Language`) and `tz`; the rights stay the link's.
 */
export const shareExportQuerySchema = z.object({
  format: tableExportFormatSchema.default('csv'),
  tz: timeZoneSchema.optional().meta({
    description:
      "IANA zone of the date values (`cell_format=text`); default the organization's zone",
  }),
});
export type ShareExportQuery = z.infer<typeof shareExportQuerySchema>;
export type ShareRecordGetQuery = z.infer<typeof shareRecordGetQuerySchema>;

export const shareUnlockRequestSchema = z
  .strictObject({ password: z.string().min(1).max(SHARE_LINK_PASSWORD_MAX_LENGTH) })
  .meta({ id: 'ShareUnlockRequest' });
export type ShareUnlockRequest = z.infer<typeof shareUnlockRequestSchema>;

export const shareUnlockResponseSchema = z
  .object({
    expires_at: isoDateTimeSchema
      .nullable()
      .meta({ description: 'End of the unlock (24 h); `null` for a link without password' }),
    csrf_token: z
      .string()
      .nullable()
      .meta({
        description: `Value for the \`${SHARE_CSRF_HEADER}\` header; \`null\` without password`,
      }),
  })
  .meta({ id: 'ShareUnlockResponse' });
export type ShareUnlockResponse = z.infer<typeof shareUnlockResponseSchema>;
