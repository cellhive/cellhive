import { z } from 'zod';

import { timeZoneSchema } from './auth.js';
import { isoDateTimeSchema } from './common.js';
import {
  dateBucketSchema,
  filterControlDefaultSchema,
  metricAggregationSchema,
} from './dashboard-widgets.js';
import { idOf } from './ids.js';
import { jsonQueryParam, recordSchema } from './records.js';

/**
 * Data of a dashboard widget (SPEC §10.3, CONTRACTS §28.3, BACKLOG T806,
 * "Quyết định S7" #3, #7): `POST /widgets/:widgetId/data`. The server reads
 * the widget's table with the **viewer's** permissions (table access, read
 * rule, field rules — P21) in one aggregate statement and returns only
 * aggregated numbers.
 */

// --- Limits (CONTRACTS §28.7) ------------------------------------------------------------

/** Groups (dimension × series) one widget may compute; more is `WIDGET_TOO_LARGE`. */
export const MAX_WIDGET_GROUPS = 1_000;
/** `statement_timeout` of one widget query, in milliseconds. */
export const WIDGET_QUERY_TIMEOUT_MS = 10_000;
/** Widget queries running at once per user, and per api instance (the rest wait in line). */
export const MAX_WIDGET_QUERIES_PER_USER = 4;
export const MAX_WIDGET_QUERIES_PER_INSTANCE = 20;
/** Seconds a client should wait before retrying a timed-out widget (`Retry-After`). */
export const WIDGET_RETRY_AFTER_SECONDS = 5;

// --- Cache and realtime (CONTRACTS §28.5, BACKLOG T807) -----------------------------------

/**
 * Lifetime of a cached widget result (±`WIDGET_CACHE_TTL_JITTER`): only to
 * clean up — the key holds the tables' `data_version`, so a write never
 * serves an older number.
 */
export const WIDGET_CACHE_TTL_MS = 300_000;
export const WIDGET_CACHE_TTL_JITTER = 0.1;
/** Largest cached result (JSON bytes); a larger one is not cached. */
export const WIDGET_CACHE_MAX_BYTES = 256 * 1024;
/** Lifetime of the lock that lets one request compute a cold entry (`SET NX PX`). */
export const WIDGET_CACHE_LOCK_MS = 10_000;
/** How long a request waits for the entry another one is computing, then computes it itself. */
export const WIDGET_CACHE_WAIT_MS = 2_000;
/** Record changes of a dashboard's tables are gathered this long into one `dashboard.data_changed`. */
export const DASHBOARD_DATA_CHANGED_GATHER_MS = 5_000;

// --- Detail codes (`VALIDATION_FAILED`, CONTRACTS §6, §28.3) ------------------------------

/** More than `MAX_WIDGET_GROUPS` groups (`params.groups`, `params.limit`). */
export const WIDGET_TOO_LARGE = 'WIDGET_TOO_LARGE';
/** A live filter naming a global filter the dashboard does not declare (T808). */
export const UNKNOWN_FILTER = 'UNKNOWN_FILTER';
/**
 * A live filter value that does not fit its control kind, or a cross-filter /
 * click-through value that does not fit the dimension (T808).
 */
export const INVALID_FILTER_VALUE = 'INVALID_FILTER_VALUE';
/** CSV export of a widget without an aggregate table (`text`, `filter_control`, a record list). */
export const WIDGET_NOT_EXPORTABLE = 'WIDGET_NOT_EXPORTABLE';

// --- Live filters (CONTRACTS §28.4, BACKLOG T808, "Quyết định S7" #9, #11) -----------------

/** Live filters one request may carry. */
export const MAX_LIVE_FILTERS = 50;
/** Values a filter control offers (`POST /widgets/:id/options`). */
export const MAX_CONTROL_OPTIONS = 200;
/** Longest search text of `POST /widgets/:id/options`. */
export const MAX_CONTROL_SEARCH_LENGTH = 100;
/** Records of one click-through page (`POST /widgets/:id/records`). */
export const DEFAULT_WIDGET_RECORDS_LIMIT = 50;
export const MAX_WIDGET_RECORDS_LIMIT = 200;
/** Deepest click-through offset. */
export const MAX_WIDGET_RECORDS_OFFSET = 100_000;

/**
 * The value a viewer picked in a filter control or global filter, shaped by
 * its kind (`select`, `user`, `text`: `values`; `number_range`: `range` of
 * numbers; `date_range`: `range` of `YYYY-MM-DD` or `relative`) — the shape
 * of a control `default`. An empty `values` or a `range` without bounds
 * filters nothing.
 */
export const filterControlValueSchema = filterControlDefaultSchema;
export type FilterControlValue = z.infer<typeof filterControlValueSchema>;

/** A group value of a widget (a dimension or series cell `value`). */
export const widgetGroupKeySchema = z
  .union([z.string().max(1000), z.number(), z.boolean()])
  .nullable()
  .meta({ description: 'A group `value` as `POST …/data` returns it; `null` = the empty group' });
export type WidgetGroupKey = z.infer<typeof widgetGroupKeySchema>;

export const LIVE_FILTER_SOURCES = ['global', 'control', 'cross'] as const;
export type LiveFilterSource = (typeof LIVE_FILTER_SOURCES)[number];

/**
 * A live filter of the dashboard (CONTRACTS §28.4). The server accepts only
 * sources the dashboard declares and builds the condition itself: a global
 * filter (`id` of `global_filters`) on the field it targets in the widget's
 * table, a `filter_control` widget on its field, or a cross-filter on the
 * dimension of a grouped widget. No free filter is accepted.
 */
export const widgetLiveFilterSchema = z
  .discriminatedUnion('source', [
    z.strictObject({
      source: z.literal('global'),
      id: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/u),
      value: filterControlValueSchema,
    }),
    z.strictObject({
      source: z.literal('control'),
      widget_id: idOf('wgt'),
      value: filterControlValueSchema,
    }),
    z.strictObject({
      source: z.literal('cross'),
      widget_id: idOf('wgt'),
      value: widgetGroupKeySchema.meta({
        description: 'The dimension value clicked in the source widget',
      }),
    }),
  ])
  .meta({ id: 'WidgetLiveFilter' });
export type WidgetLiveFilterInput = z.infer<typeof widgetLiveFilterSchema>;

/** The global filter id or the widget id of a live filter. */
export const liveFilterIdOf = (filter: WidgetLiveFilterInput): string =>
  filter.source === 'global' ? filter.id : filter.widget_id;

export const widgetLiveFiltersSchema = z
  .array(widgetLiveFilterSchema)
  .max(MAX_LIVE_FILTERS)
  .superRefine((filters, context) => {
    const seen = new Set<string>();
    for (const [index, filter] of filters.entries()) {
      const key = `${filter.source}:${liveFilterIdOf(filter)}`;
      if (seen.has(key)) {
        context.addIssue({ code: 'custom', path: [index], message: 'Duplicate filter source' });
      }
      seen.add(key);
    }
  })
  .meta({
    description:
      'Live filters (global filters, filter controls, cross-filters), one per source; at most 50',
  });

export const IGNORED_FILTER_REASONS = [
  'other_table',
  'not_bound',
  'self',
  'no_permission',
  'broken',
] as const;
export type IgnoredFilterReason = (typeof IGNORED_FILTER_REASONS)[number];

/** A live filter the server did not apply to this widget, and why. */
export const ignoredFilterSchema = z
  .strictObject({
    source: z.enum(LIVE_FILTER_SOURCES),
    id: z.string().meta({ description: 'Global filter id or widget id, as sent' }),
    reason: z.enum(IGNORED_FILTER_REASONS).meta({
      description:
        '`other_table`: it filters another table; `not_bound`: the widget does not follow ' +
        'this control (`filter_bindings`; for options: not a parent control); `self`: a ' +
        'cross-filter of the widget itself; `no_permission`: its field is one the viewer ' +
        'cannot read; `broken`: its field was deleted or no longer fits it',
    }),
  })
  .meta({ id: 'IgnoredFilter' });
export type IgnoredFilterDto = z.infer<typeof ignoredFilterSchema>;

// --- Request -----------------------------------------------------------------------------

/** `POST /widgets/:widgetId/data`. */
export const widgetDataRequestSchema = z
  .strictObject({
    filters: widgetLiveFiltersSchema.default([]),
    timezone: timeZoneSchema
      .nullable()
      .optional()
      .meta({
        description:
          "Viewer's IANA zone for date buckets of fields without a zone of their own; default " +
          'the organization zone',
      }),
  })
  .meta({ id: 'WidgetDataRequest' });
export type WidgetDataRequest = z.infer<typeof widgetDataRequestSchema>;

// --- Response ----------------------------------------------------------------------------

export const WIDGET_DATA_STATUSES = ['ok', 'no_permission', 'broken', 'empty'] as const;
export const widgetDataStatusSchema = z.enum(WIDGET_DATA_STATUSES).meta({
  description:
    '`no_permission`: the widget names a table or field the viewer cannot read (also a field ' +
    'removed from their permissions); no number is returned. `broken`: a table or field it ' +
    'names was deleted. `empty`: no record of the viewer matches.',
});
export type WidgetDataStatus = z.infer<typeof widgetDataStatusSchema>;

export const WIDGET_DATA_COLUMN_ROLES = [
  'dimension',
  'series',
  'metric',
  'record_id',
  'field',
] as const;

export const widgetDataColumnSchema = z
  .strictObject({
    key: z.string().meta({
      description:
        '`dimension`, `series`, the metric `id`, `record_id`, or the field id of a record column',
    }),
    role: z.enum(WIDGET_DATA_COLUMN_ROLES),
    field_id: idOf('fld').nullable().meta({ description: '`null` for `count` and `record_id`' }),
    field_type: z
      .string()
      .nullable()
      .meta({ description: 'Type of the field (`select`, `datetime`, `formula`…)' }),
    aggregation: metricAggregationSchema.nullable(),
    date_bucket: dateBucketSchema.nullable(),
    bucket_width: z.number().nullable(),
  })
  .meta({ id: 'WidgetDataColumn' });
export type WidgetDataColumn = z.infer<typeof widgetDataColumnSchema>;

/**
 * A group value (dimension or series cell). `value`: text; number (the lower
 * bound of a `bucket_width` range); option id (select); user id; `true` /
 * `false` (checkbox); `YYYY-MM-DD`, the first day of the bucket in the
 * effective zone (date); linked record id (link); `null` for the empty
 * group "(Empty)". `label`: option name, member name, title of the linked
 * record (`null` when the viewer cannot read that record), else `null`.
 */
export const widgetGroupValueSchema = z
  .strictObject({
    value: z.union([z.string(), z.number(), z.boolean()]).nullable(),
    label: z.string().nullable(),
  })
  .meta({ id: 'WidgetGroupValue' });
export type WidgetGroupValue = z.infer<typeof widgetGroupValueSchema>;

/** A period of a KPI comparison: `from` inclusive, `to` exclusive (`YYYY-MM-DD` or ISO instant). */
export const widgetPeriodSchema = z
  .strictObject({ from: z.string(), to: z.string() })
  .meta({ id: 'WidgetPeriod' });

export const widgetDataSchema = z
  .strictObject({
    status: widgetDataStatusSchema,
    columns: z.array(widgetDataColumnSchema).meta({ description: '`[]` unless `ok` or `empty`' }),
    rows: z.array(z.array(z.unknown())).meta({
      description:
        'One array per row, in `columns` order: group values (`WidgetGroupValue`) then metric ' +
        'values (numbers, `null` when nothing to aggregate); for a record table, the record id ' +
        'then cells as in `records/query`. Sorted as the widget asks (select by option order, ' +
        'dates by time, the empty group last). `[]` unless `ok`.',
    }),
    other: z
      .strictObject({
        groups: z.int().min(1).meta({ description: 'Dimension groups folded into "Other"' }),
        rows: z.array(z.array(z.unknown())).meta({
          description: 'Rows of "Other" (one per series), dimension cell `null`',
        }),
      })
      .optional()
      .meta({ description: 'With `group_others` and more groups than `limit`' }),
    total: z
      .array(z.number().nullable())
      .optional()
      .meta({ description: 'Grouped widgets: each metric over every matching record' }),
    compare: z
      .strictObject({
        previous: z.number().nullable(),
        change: z
          .number()
          .nullable()
          .meta({ description: '(current − previous) / |previous|; `null` when previous is 0' }),
        current_period: widgetPeriodSchema,
        previous_period: widgetPeriodSchema,
      })
      .optional()
      .meta({ description: 'KPI with `compare`: the value of the previous period' }),
    computed_at: isoDateTimeSchema,
    cache: z.enum(['hit', 'miss']).meta({
      description:
        '`hit`: read from the cache entry of the same query, permissions (resolved for the viewer) and data version (§28.5)',
    }),
    ignored_filters: z
      .array(ignoredFilterSchema)
      .meta({ description: 'Live filters of the request not applied to this widget' }),
  })
  .meta({ id: 'WidgetData' });
export type WidgetDataDto = z.infer<typeof widgetDataSchema>;

// --- Filter control values (T808) ----------------------------------------------------------

/** `POST /widgets/:widgetId/options` (a `select`, `user` or `text` filter control). */
export const widgetOptionsRequestSchema = z
  .strictObject({
    search: z
      .string()
      .trim()
      .max(MAX_CONTROL_SEARCH_LENGTH)
      .optional()
      .meta({ description: 'Unaccented, case-insensitive part of the value or its label' }),
    filters: widgetLiveFiltersSchema.default([]).meta({
      description:
        'Live filters; only the values of the parent controls (`parent_control_id`, ' +
        'transitively) narrow the options',
    }),
    timezone: timeZoneSchema.nullable().optional(),
  })
  .meta({ id: 'WidgetOptionsRequest' });
export type WidgetOptionsRequest = z.infer<typeof widgetOptionsRequestSchema>;

export const widgetOptionsSchema = z
  .strictObject({
    status: z.enum(['ok', 'no_permission', 'broken']).meta({
      description:
        '`no_permission`: the viewer cannot read the control’s table or field (no value); ' +
        '`broken`: the field was deleted or no longer fits the control',
    }),
    items: z.array(widgetGroupValueSchema).meta({
      description:
        'Distinct non-empty values of the field among the records the viewer reads (and the ' +
        'parent controls select), in natural order: option id + name, user id + name, text',
    }),
    has_more: z.boolean().meta({ description: 'More than 200 values match' }),
    ignored_filters: z.array(ignoredFilterSchema),
  })
  .meta({ id: 'WidgetOptions' });
export type WidgetOptionsDto = z.infer<typeof widgetOptionsSchema>;

// --- Click-through (T808) ------------------------------------------------------------------

/** `POST /widgets/:widgetId/records`: the records behind a widget or one of its groups. */
export const widgetRecordsRequestSchema = z
  .strictObject({
    segment: z
      .strictObject({
        dimension: widgetGroupKeySchema,
        series: widgetGroupKeySchema.optional(),
      })
      .nullable()
      .default(null)
      .meta({
        description:
          'A group of a grouped widget (`series` only with a series dimension); `null`: every ' +
          'record behind the widget',
      }),
    filters: widgetLiveFiltersSchema.default([]),
    timezone: timeZoneSchema.nullable().optional(),
    offset: z.int().min(0).max(MAX_WIDGET_RECORDS_OFFSET).default(0),
    limit: z.int().min(1).max(MAX_WIDGET_RECORDS_LIMIT).default(DEFAULT_WIDGET_RECORDS_LIMIT),
  })
  .meta({ id: 'WidgetRecordsRequest' });
export type WidgetRecordsRequest = z.infer<typeof widgetRecordsRequestSchema>;

export const widgetRecordsSchema = z
  .strictObject({
    status: z.enum(['ok', 'empty', 'no_permission', 'broken']).meta({
      description: 'As `WidgetData.status`; `records` is `[]` unless `ok`',
    }),
    records: z.array(recordSchema).meta({
      description: 'As `records/query` with `field_key_type=id`: fields the viewer reads only',
    }),
    offset: z.int().min(0),
    limit: z.int().min(1),
    total: z.int().min(0).optional(),
    total_estimate: z.int().min(0).optional(),
    ignored_filters: z.array(ignoredFilterSchema),
  })
  .meta({ id: 'WidgetRecords' });
export type WidgetRecordsDto = z.infer<typeof widgetRecordsSchema>;

// --- Widget CSV (T808) ---------------------------------------------------------------------

/** `GET /widgets/:widgetId/export?format=csv&filters=&timezone=`. */
export const widgetExportQuerySchema = z.object({
  format: z.enum(['csv']).default('csv'),
  filters: jsonQueryParam(
    widgetLiveFiltersSchema,
    'Live filters as a JSON array (as in `POST …/data`)',
  ).optional(),
  timezone: timeZoneSchema.optional(),
});
export type WidgetExportQuery = z.infer<typeof widgetExportQuerySchema>;
