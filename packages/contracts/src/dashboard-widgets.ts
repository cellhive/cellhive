import { z } from 'zod';

import { isoDateTimeSchema } from './common.js';
import {
  DASHBOARD_GRID_COLUMNS,
  MAX_WIDGET_HEIGHT,
  MAX_WIDGET_ROW,
  MAX_WIDGET_WIDTH,
  MIN_WIDGET_HEIGHT,
  MIN_WIDGET_WIDTH,
} from './dashboard-layout.js';
import { idOf } from './ids.js';

/**
 * Dashboard widgets (SPEC §10.2–§10.3, CONTRACTS §28.2, BACKLOG T805,
 * "Quyết định S7" #6). The config of a widget depends on its `type`; the
 * API fills the defaults and stores the parsed config, and checks it
 * against the base on every save (tables, fields, dimension kinds, filter,
 * bindings).
 */

/** Widget types of S7 (Phase 2 types of SPEC §10.2 are not accepted). */
export const WIDGET_TYPES = [
  'kpi',
  'bar',
  'line',
  'pie',
  'combo',
  'table',
  'text',
  'filter_control',
] as const;
export const widgetTypeSchema = z.enum(WIDGET_TYPES);
export type WidgetType = z.infer<typeof widgetTypeSchema>;

/** Widget types that read records of a table (every type but `text`). */
export const DATA_WIDGET_TYPES = [
  'kpi',
  'bar',
  'line',
  'pie',
  'combo',
  'table',
] as const satisfies readonly WidgetType[];

// --- Limits (CONTRACTS §28.7) ------------------------------------------------------------

/** Widgets of one dashboard. */
export const MAX_WIDGETS_PER_DASHBOARD = 30;
/** Metrics of one widget. */
export const MAX_WIDGET_METRICS = 5;
/** Groups a chart shows by default (`limit`), and at most (plus "Other"). */
export const DEFAULT_WIDGET_LIMIT = 20;
export const MAX_WIDGET_LIMIT = 100;
/** Rows of a table widget. */
export const DEFAULT_TABLE_WIDGET_ROWS = 10;
export const MAX_TABLE_WIDGET_ROWS = 500;
/** Fields of a record-list table widget. */
export const MAX_TABLE_WIDGET_FIELDS = 20;
/** Markdown of a text widget, in characters. */
export const MAX_TEXT_WIDGET_LENGTH = 10_000;
export const MAX_WIDGET_TITLE_LENGTH = 200;
export const MAX_WIDGET_DESCRIPTION_LENGTH = 500;
/** Filter controls one widget follows (`filter_bindings`). */
export const MAX_WIDGET_FILTER_BINDINGS = MAX_WIDGETS_PER_DASHBOARD;
/** Values of a filter control default. */
export const MAX_FILTER_CONTROL_VALUES = 200;
/** Default size of a new widget placed by the server. */
export const DEFAULT_WIDGET_WIDTH = 6;
export const DEFAULT_WIDGET_HEIGHT = 6;

// --- Building blocks ---------------------------------------------------------------------

export const METRIC_AGGREGATIONS = ['count', 'count_distinct', 'sum', 'avg', 'min', 'max'] as const;
export const metricAggregationSchema = z.enum(METRIC_AGGREGATIONS);
export type MetricAggregation = z.infer<typeof metricAggregationSchema>;

export const DATE_BUCKETS = ['day', 'week', 'month', 'quarter', 'year'] as const;
export const dateBucketSchema = z.enum(DATE_BUCKETS);
export type DateBucket = z.infer<typeof dateBucketSchema>;

export const WIDGET_SORTS = [
  'metric_desc',
  'metric_asc',
  'dimension_asc',
  'dimension_desc',
] as const;
export const widgetSortSchema = z.enum(WIDGET_SORTS);
export type WidgetSort = z.infer<typeof widgetSortSchema>;

/** `#rrggbb`. */
export const colorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/u, { message: 'Expected a #rrggbb color' })
  .meta({ description: 'Color `#rrggbb`', example: '#2f6fed' });

const shortTextSchema = (max: number) => z.string().max(max);

/** A place on the 12-column grid. */
export const widgetLayoutSchema = z
  .strictObject({
    x: z
      .int()
      .min(0)
      .max(DASHBOARD_GRID_COLUMNS - 1),
    y: z.int().min(0).max(MAX_WIDGET_ROW),
    w: z.int().min(MIN_WIDGET_WIDTH).max(MAX_WIDGET_WIDTH),
    h: z.int().min(MIN_WIDGET_HEIGHT).max(MAX_WIDGET_HEIGHT),
  })
  .refine((layout) => layout.x + layout.w <= DASHBOARD_GRID_COLUMNS, {
    message: 'The widget goes past the last column',
    path: ['w'],
  })
  .meta({
    id: 'WidgetLayout',
    description:
      'Column `x` (0–11), row `y`, width `w` (1–12 columns, `x + w ≤ 12`), height `h` (2–24 rows)',
  });
export type WidgetLayout = z.infer<typeof widgetLayoutSchema>;

export const widgetMetricSchema = z
  .strictObject({
    id: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,32}$/u)
      .meta({ description: 'Unique in the widget, e.g. `m1`' }),
    aggregation: metricAggregationSchema,
    field: idOf('fld')
      .nullable()
      .default(null)
      .meta({
        description:
          '`null` for `count`; a numeric field for `sum`, `avg`, `min`, `max`; any groupable ' +
          'field for `count_distinct`',
      }),
    label: shortTextSchema(100).nullable().default(null),
    color: colorSchema.nullable().default(null),
    chart: z
      .enum(['bar', 'line'])
      .optional()
      .meta({ description: '`combo` only: drawn as bars or a line (default `bar`)' }),
    axis: z
      .enum(['left', 'right'])
      .optional()
      .meta({ description: '`combo` only: value axis (default `left`)' }),
  })
  .superRefine((metric, context) => {
    if ((metric.aggregation === 'count') !== (metric.field === null)) {
      context.addIssue({
        code: 'custom',
        path: ['field'],
        message:
          metric.aggregation === 'count'
            ? '`count` takes no field'
            : 'This aggregation needs a field',
      });
    }
  })
  .meta({ id: 'WidgetMetric' });
export type WidgetMetric = z.infer<typeof widgetMetricSchema>;

export const widgetDimensionSchema = z
  .strictObject({
    field: idOf('fld'),
    date_bucket: dateBucketSchema
      .nullable()
      .default(null)
      .meta({ description: 'Required for date fields (`DATE_BUCKET_REQUIRED`); `null` otherwise' }),
    bucket_width: z
      .number()
      .positive()
      .max(1e12)
      .nullable()
      .default(null)
      .meta({ description: 'Number fields only: group into ranges of this width (optional)' }),
  })
  .meta({
    id: 'WidgetDimension',
    description:
      'Group by a field: text, select (multi: one group per option), user, checkbox, date ' +
      '(with `date_bucket`), number (optional `bucket_width`) or link',
  });
export type WidgetDimension = z.infer<typeof widgetDimensionSchema>;

const numberFormatSchema = z
  .strictObject({
    style: z.enum(['number', 'currency', 'percent']).default('number'),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/u)
      .nullable()
      .default(null),
    decimals: z.int().min(0).max(6).nullable().default(null),
    compact: z.boolean().default(false),
  })
  .meta({ id: 'WidgetNumberFormat' });

/**
 * Display settings shared by charts. Unknown keys are dropped; every key is
 * optional (the web editor fills its defaults).
 */
const chartDisplayShape = {
  show_legend: z.boolean().optional(),
  show_values: z.boolean().optional(),
  number_format: numberFormatSchema.nullable().optional(),
  empty_text: shortTextSchema(200).nullable().optional(),
  x_axis_label: shortTextSchema(100).nullable().optional(),
  y_axis_label: shortTextSchema(100).nullable().optional(),
  colors: z
    .record(z.string().max(64), colorSchema)
    .refine((colors) => Object.keys(colors).length <= 100, { message: 'At most 100 colors' })
    .optional()
    .meta({ description: 'Color by series key or option id' }),
};

const widgetSortField = widgetSortSchema.default('metric_desc');
const chartLimit = z.int().min(1).max(MAX_WIDGET_LIMIT).default(DEFAULT_WIDGET_LIMIT);

/** Keys of every widget that reads records. */
const dataShape = {
  table_id: idOf('tbl'),
  filter: z
    .record(z.string(), z.unknown())
    .nullable()
    .default(null)
    .meta({
      description:
        'Saved filter (DSL or tuple form, CONTRACTS §3), validated against the table in mode ' +
        '`standard` and stored as DSL; returned only to base admins (`null` for other viewers)',
    }),
  filter_bindings: z
    .array(idOf('wgt'))
    .max(MAX_WIDGET_FILTER_BINDINGS)
    .default([])
    .meta({ description: '`filter_control` widgets of the same dashboard this widget follows' }),
  description: shortTextSchema(MAX_WIDGET_DESCRIPTION_LENGTH).nullable().default(null),
};

function uniqueMetricIds(
  metrics: readonly { readonly id: string }[],
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, metric] of metrics.entries()) {
    if (seen.has(metric.id)) {
      context.addIssue({ code: 'custom', path: ['metrics', index, 'id'], message: 'Duplicate id' });
    }
    seen.add(metric.id);
  }
}

function oneMetricWithSeries(
  config: { readonly series_dimension: unknown; readonly metrics: readonly unknown[] },
  context: z.RefinementCtx,
): void {
  if (config.series_dimension !== null && config.metrics.length > 1) {
    context.addIssue({
      code: 'custom',
      path: ['metrics'],
      message: 'A series dimension takes exactly one metric',
    });
  }
}

const metricsSchema = (min: number, max: number) => z.array(widgetMetricSchema).min(min).max(max);

// --- Configs by type ---------------------------------------------------------------------

export const PREVIOUS_PERIOD_RANGES = ['day', 'week', 'month', 'quarter', 'year'] as const;

export const kpiWidgetConfigSchema = z
  .strictObject({
    ...dataShape,
    metrics: metricsSchema(1, 1),
    compare: z
      .strictObject({
        mode: z.literal('previous_period'),
        date_field: idOf('fld'),
        range: z.enum(PREVIOUS_PERIOD_RANGES),
      })
      .nullable()
      .default(null)
      .meta({ description: 'Compare with the previous period of the same length' }),
    display: z
      .object({
        number_format: numberFormatSchema.nullable().optional(),
        prefix: shortTextSchema(20).nullable().optional(),
        suffix: shortTextSchema(20).nullable().optional(),
        target: z.number().nullable().optional(),
        thresholds: z
          .array(z.strictObject({ below: z.number().nullable(), color: colorSchema }))
          .max(5)
          .optional(),
        empty_text: shortTextSchema(200).nullable().optional(),
      })
      .default({}),
  })
  .superRefine((config, context) => {
    uniqueMetricIds(config.metrics, context);
  })
  .meta({ id: 'KpiWidgetConfig' });

const groupedChartShape = {
  ...dataShape,
  dimension: widgetDimensionSchema,
  series_dimension: widgetDimensionSchema
    .nullable()
    .default(null)
    .meta({ description: 'Second dimension (series); takes exactly one metric' }),
  metrics: metricsSchema(1, MAX_WIDGET_METRICS),
  sort: widgetSortField,
  limit: chartLimit,
  group_others: z
    .boolean()
    .default(false)
    .meta({ description: 'Group the rest into "Other" beyond `limit`' }),
};

export const barWidgetConfigSchema = z
  .strictObject({
    ...groupedChartShape,
    display: z
      .object({
        ...chartDisplayShape,
        orientation: z.enum(['vertical', 'horizontal']).optional(),
        stack: z
          .enum(['grouped', 'stacked', 'percent'])
          .optional()
          .meta({ description: '`percent`: 100 % stacked (normalised by the client)' }),
      })
      .default({}),
  })
  .superRefine((config, context) => {
    uniqueMetricIds(config.metrics, context);
    oneMetricWithSeries(config, context);
  })
  .meta({ id: 'BarWidgetConfig' });

export const lineWidgetConfigSchema = z
  .strictObject({
    ...groupedChartShape,
    display: z
      .object({
        ...chartDisplayShape,
        area: z.boolean().optional(),
        smooth: z.boolean().optional(),
      })
      .default({}),
  })
  .superRefine((config, context) => {
    uniqueMetricIds(config.metrics, context);
    oneMetricWithSeries(config, context);
  })
  .meta({ id: 'LineWidgetConfig' });

export const pieWidgetConfigSchema = z
  .strictObject({
    ...dataShape,
    dimension: widgetDimensionSchema,
    metrics: metricsSchema(1, 1),
    sort: widgetSortField,
    limit: chartLimit,
    group_others: z.boolean().default(true),
    display: z.object({ ...chartDisplayShape, donut: z.boolean().optional() }).default({}),
  })
  .superRefine((config, context) => {
    uniqueMetricIds(config.metrics, context);
  })
  .meta({ id: 'PieWidgetConfig' });

export const comboWidgetConfigSchema = z
  .strictObject({
    ...dataShape,
    dimension: widgetDimensionSchema,
    metrics: metricsSchema(2, MAX_WIDGET_METRICS),
    sort: widgetSortField,
    limit: chartLimit,
    group_others: z.boolean().default(false),
    display: z.object(chartDisplayShape).default({}),
  })
  .superRefine((config, context) => {
    uniqueMetricIds(config.metrics, context);
  })
  .meta({ id: 'ComboWidgetConfig' });

const tablePivotSchema = z.strictObject({
  mode: z.literal('pivot'),
  dimension: widgetDimensionSchema,
  metrics: metricsSchema(1, MAX_WIDGET_METRICS),
  sort: widgetSortField,
  limit: z.int().min(1).max(MAX_TABLE_WIDGET_ROWS).default(DEFAULT_TABLE_WIDGET_ROWS),
});

const tableRecordsSchema = z.strictObject({
  mode: z.literal('records'),
  fields: z.array(idOf('fld')).min(1).max(MAX_TABLE_WIDGET_FIELDS),
  sort: z
    .strictObject({ field: idOf('fld'), direction: z.enum(['asc', 'desc']) })
    .nullable()
    .default(null),
  limit: z.int().min(1).max(MAX_TABLE_WIDGET_ROWS).default(DEFAULT_TABLE_WIDGET_ROWS),
});

export const tableWidgetConfigSchema = z
  .strictObject({
    ...dataShape,
    table: z.discriminatedUnion('mode', [tablePivotSchema, tableRecordsSchema]).meta({
      description:
        '`pivot`: one dimension and its metrics; `records`: the top N records with chosen fields',
    }),
    display: z
      .object({
        number_format: numberFormatSchema.nullable().optional(),
        empty_text: shortTextSchema(200).nullable().optional(),
      })
      .default({}),
  })
  .superRefine((config, context) => {
    if (config.table.mode === 'pivot') uniqueMetricIds(config.table.metrics, context);
  })
  .meta({ id: 'TableWidgetConfig' });

export const textWidgetConfigSchema = z
  .strictObject({
    markdown: z
      .string()
      .max(MAX_TEXT_WIDGET_LENGTH)
      .default('')
      .meta({ description: 'Markdown rendered through `@cellhive/markdown` (no raw HTML)' }),
  })
  .meta({ id: 'TextWidgetConfig' });

export const FILTER_CONTROL_KINDS = [
  'date_range',
  'select',
  'user',
  'text',
  'number_range',
] as const;
export const filterControlKindSchema = z.enum(FILTER_CONTROL_KINDS);
export type FilterControlKind = z.infer<typeof filterControlKindSchema>;

export const RELATIVE_DATE_RANGES = [
  'today',
  'yesterday',
  'last_7_days',
  'last_30_days',
  'this_week',
  'last_week',
  'this_month',
  'last_month',
  'this_quarter',
  'this_year',
  'last_year',
] as const;

const controlValueSchema = z.union([z.string().max(1000), z.number(), z.boolean()]);

export const filterControlDefaultSchema = z
  .union([
    z.strictObject({ values: z.array(controlValueSchema).max(MAX_FILTER_CONTROL_VALUES) }),
    z.strictObject({
      range: z.strictObject({
        from: z.union([z.string().max(40), z.number()]).nullable(),
        to: z.union([z.string().max(40), z.number()]).nullable(),
      }),
    }),
    z.strictObject({ relative: z.enum(RELATIVE_DATE_RANGES) }),
  ])
  .meta({ id: 'FilterControlDefault' });

export const filterControlWidgetConfigSchema = z
  .strictObject({
    table_id: idOf('tbl'),
    field: idOf('fld'),
    control: filterControlKindSchema.meta({
      description:
        '`date_range` (date field), `select`, `user`, `text` (search) or `number_range` (number)',
    }),
    parent_control_id: idOf('wgt')
      .nullable()
      .default(null)
      .meta({ description: 'Cascading: a `filter_control` of the same dashboard and table' }),
    default: filterControlDefaultSchema.nullable().default(null),
  })
  .meta({ id: 'FilterControlWidgetConfig' });

/** Config schema of each widget type. */
export const WIDGET_CONFIG_SCHEMAS = {
  kpi: kpiWidgetConfigSchema,
  bar: barWidgetConfigSchema,
  line: lineWidgetConfigSchema,
  pie: pieWidgetConfigSchema,
  combo: comboWidgetConfigSchema,
  table: tableWidgetConfigSchema,
  text: textWidgetConfigSchema,
  filter_control: filterControlWidgetConfigSchema,
} as const satisfies Record<WidgetType, z.ZodType>;

export type KpiWidgetConfig = z.infer<typeof kpiWidgetConfigSchema>;
export type BarWidgetConfig = z.infer<typeof barWidgetConfigSchema>;
export type LineWidgetConfig = z.infer<typeof lineWidgetConfigSchema>;
export type PieWidgetConfig = z.infer<typeof pieWidgetConfigSchema>;
export type ComboWidgetConfig = z.infer<typeof comboWidgetConfigSchema>;
export type TableWidgetConfig = z.infer<typeof tableWidgetConfigSchema>;
export type TextWidgetConfig = z.infer<typeof textWidgetConfigSchema>;
export type FilterControlWidgetConfig = z.infer<typeof filterControlWidgetConfigSchema>;

/** A widget config of a known type. */
export type WidgetConfigOf<T extends WidgetType> = z.infer<(typeof WIDGET_CONFIG_SCHEMAS)[T]>;
export type WidgetConfig = { [T in WidgetType]: WidgetConfigOf<T> }[WidgetType];

/** Any widget config, as sent and returned (its shape depends on `type`). */
export const widgetConfigSchema = z.record(z.string(), z.unknown()).meta({
  id: 'WidgetConfig',
  description:
    'Depends on `type`: `KpiWidgetConfig`, `BarWidgetConfig`, `LineWidgetConfig`, ' +
    '`PieWidgetConfig`, `ComboWidgetConfig`, `TableWidgetConfig`, `TextWidgetConfig`, ' +
    '`FilterControlWidgetConfig` (CONTRACTS §28.2)',
});

// --- Detail codes (`VALIDATION_FAILED`, CONTRACTS §6, §28.2) -------------------------------

/** The dimension field cannot be grouped (attachment, button, list results…). */
export const INVALID_DIMENSION = 'INVALID_DIMENSION';
/** A date dimension without `date_bucket`. */
export const DATE_BUCKET_REQUIRED = 'DATE_BUCKET_REQUIRED';
/** The aggregation does not fit the field (`sum` of a text…). */
export const INVALID_METRIC = 'INVALID_METRIC';
/** A widget id that is not a widget (of the right type) of this dashboard. */
export const UNKNOWN_WIDGET = 'UNKNOWN_WIDGET';
/** A filter control whose field does not fit its kind, or a parent chain that loops. */
export const INVALID_FILTER_CONTROL = 'INVALID_FILTER_CONTROL';
/** More than `MAX_WIDGETS_PER_DASHBOARD` widgets. */
export const WIDGET_LIMIT_EXCEEDED = 'WIDGET_LIMIT_EXCEEDED';
/** `PUT …/layout` without every widget of the dashboard. */
export const LAYOUT_INCOMPLETE = 'LAYOUT_INCOMPLETE';

// --- Widget DTO -----------------------------------------------------------------------------

/** Why a widget cannot be computed any more (it keeps its config, BACKLOG T805). */
export const WIDGET_BROKEN_REASONS = ['table_deleted', 'field_deleted'] as const;

export const widgetSchema = z
  .strictObject({
    id: idOf('wgt'),
    dashboard_id: idOf('dsh'),
    type: widgetTypeSchema,
    title: z.string(),
    config: widgetConfigSchema,
    layout: widgetLayoutSchema,
    status: z.enum(['ok', 'broken']).meta({
      description:
        '`broken`: the table or a field the widget names was deleted; the config is kept',
    }),
    broken_reason: z.enum(WIDGET_BROKEN_REASONS).nullable(),
    created_at: isoDateTimeSchema,
    updated_at: isoDateTimeSchema,
  })
  .meta({ id: 'Widget' });
export type WidgetDto = z.infer<typeof widgetSchema>;

const titleSchema = z.string().trim().max(MAX_WIDGET_TITLE_LENGTH);
const versionField = z
  .int()
  .min(1)
  .optional()
  .meta({ description: 'Expected dashboard `version` (same as `If-Match`); a mismatch is `409`' });

/** `POST /dashboards/:dashboardId/widgets`. */
export const createWidgetRequestSchema = z
  .strictObject({
    type: widgetTypeSchema,
    title: titleSchema.default(''),
    config: widgetConfigSchema.default({}),
    layout: widgetLayoutSchema.optional().meta({
      description: 'Default: 6 × 6 at column 0 below every widget',
    }),
    version: versionField,
  })
  .meta({ id: 'CreateWidgetRequest' });
export type CreateWidgetRequest = z.infer<typeof createWidgetRequestSchema>;

/** `PATCH /widgets/:widgetId` (the type never changes). */
export const updateWidgetRequestSchema = z
  .strictObject({
    title: titleSchema.optional(),
    config: widgetConfigSchema.optional().meta({ description: 'The whole new config' }),
    layout: widgetLayoutSchema.optional(),
    version: versionField,
  })
  .refine(
    (body) => body.title !== undefined || body.config !== undefined || body.layout !== undefined,
    { message: 'Send title, config or layout', path: [] },
  )
  .meta({ id: 'UpdateWidgetRequest' });
export type UpdateWidgetRequest = z.infer<typeof updateWidgetRequestSchema>;
