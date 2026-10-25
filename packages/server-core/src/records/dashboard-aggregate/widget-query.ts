import {
  WIDGET_CONFIG_SCHEMAS,
  type DateBucket,
  type MetricAggregation,
  type WidgetDimension,
  type WidgetMetric,
  type WidgetSort,
  type WidgetType,
  Id,
} from '@cellhive/contracts';

import { filterFieldIds } from '../../views/view-config.js';

/**
 * The query of a dashboard widget (BACKLOG T806, CONTRACTS §28.3), planned
 * from its stored config: pure, no database. `RecordQueryService.widgetData`
 * runs it with the viewer's access.
 */

export interface WidgetDimensionSpec {
  readonly field: Id<'fld'>;
  readonly dateBucket: DateBucket | null;
  readonly bucketWidth: number | null;
}

export interface WidgetMetricSpec {
  readonly id: string;
  readonly aggregation: MetricAggregation;
  /** `null` for `count`. */
  readonly field: Id<'fld'> | null;
}

/** Calendar unit of a KPI comparison (the current one and the one before it). */
export type ComparePeriod = 'day' | 'week' | 'month' | 'quarter' | 'year';

/** Groups by one dimension (and an optional series), with top N and "Other". */
export interface GroupedWidgetQuery {
  readonly kind: 'grouped';
  readonly tableId: Id<'tbl'>;
  /** Saved filter (DSL, field ids) or `null`. */
  readonly filter: Readonly<Record<string, unknown>> | null;
  readonly dimension: WidgetDimensionSpec;
  readonly series: WidgetDimensionSpec | null;
  readonly metrics: readonly WidgetMetricSpec[];
  readonly sort: WidgetSort;
  /** Dimension groups returned (the rest go to "Other" with `groupOthers`). */
  readonly limit: number;
  readonly groupOthers: boolean;
}

/** One metric over every matching record, optionally compared with the previous period. */
export interface KpiWidgetQuery {
  readonly kind: 'kpi';
  readonly tableId: Id<'tbl'>;
  readonly filter: Readonly<Record<string, unknown>> | null;
  readonly metric: WidgetMetricSpec;
  readonly compare: { readonly dateField: Id<'fld'>; readonly period: ComparePeriod } | null;
}

/** The top N records with chosen fields (a `table` widget in `records` mode). */
export interface RecordsWidgetQuery {
  readonly kind: 'records';
  readonly tableId: Id<'tbl'>;
  readonly filter: Readonly<Record<string, unknown>> | null;
  readonly fields: readonly Id<'fld'>[];
  readonly sort: { readonly field: Id<'fld'>; readonly direction: 'asc' | 'desc' } | null;
  readonly limit: number;
}

export type WidgetQuery = GroupedWidgetQuery | KpiWidgetQuery | RecordsWidgetQuery;

const dimensionOf = (dimension: WidgetDimension): WidgetDimensionSpec => ({
  field: dimension.field,
  dateBucket: dimension.date_bucket,
  bucketWidth: dimension.bucket_width,
});

const metricOf = (metric: WidgetMetric): WidgetMetricSpec => ({
  id: metric.id,
  aggregation: metric.aggregation,
  field: metric.field,
});

/**
 * The query of a `type` widget with `config` (as stored: parsed again, a
 * config that no longer parses is `'invalid'`), or `null` for widgets
 * without data (`text`, `filter_control`).
 */
export function widgetQueryOf(type: WidgetType, config: unknown): WidgetQuery | null | 'invalid' {
  if (type === 'text' || type === 'filter_control') return null;
  const parsed = WIDGET_CONFIG_SCHEMAS[type].safeParse(config ?? {});
  if (!parsed.success) return 'invalid';
  const data = parsed.data;
  const base = {
    tableId: data.table_id,
    filter: data.filter,
  };
  if ('compare' in data) {
    const [metric] = data.metrics;
    if (metric === undefined) return 'invalid';
    return {
      kind: 'kpi',
      ...base,
      metric: metricOf(metric),
      compare:
        data.compare === null
          ? null
          : { dateField: data.compare.date_field, period: data.compare.range },
    };
  }
  if ('table' in data) {
    const table = data.table;
    if (table.mode === 'records') {
      return {
        kind: 'records',
        ...base,
        fields: table.fields,
        sort:
          table.sort === null ? null : { field: table.sort.field, direction: table.sort.direction },
        limit: table.limit,
      };
    }
    return {
      kind: 'grouped',
      ...base,
      dimension: dimensionOf(table.dimension),
      series: null,
      metrics: table.metrics.map(metricOf),
      sort: table.sort,
      limit: table.limit,
      groupOthers: false,
    };
  }
  if ('dimension' in data) {
    return {
      kind: 'grouped',
      ...base,
      dimension: dimensionOf(data.dimension),
      series:
        'series_dimension' in data && data.series_dimension !== null
          ? dimensionOf(data.series_dimension as WidgetDimension)
          : null,
      metrics: data.metrics.map(metricOf),
      sort: data.sort,
      limit: data.limit,
      groupOthers: data.group_others,
    };
  }
  return 'invalid';
}

/**
 * Every field a widget query reads: dimension, series, metric fields, the
 * comparison date, record columns and sort, and the fields of its saved
 * filter. The viewer must read all of them, else the widget answers
 * `no_permission` (a saved filter on a hidden field is never set aside:
 * dropping it would show larger numbers).
 */
export function widgetQueryFieldIds(query: WidgetQuery): Id<'fld'>[] {
  const ids = new Set<Id<'fld'>>();
  const add = (id: Id<'fld'> | null | undefined) => {
    if (id !== null && id !== undefined) ids.add(id);
  };
  switch (query.kind) {
    case 'grouped':
      add(query.dimension.field);
      add(query.series?.field);
      for (const metric of query.metrics) add(metric.field);
      break;
    case 'kpi':
      add(query.metric.field);
      add(query.compare?.dateField);
      break;
    case 'records':
      for (const id of query.fields) add(id);
      add(query.sort?.field);
      break;
  }
  for (const id of filterFieldIds(query.filter)) add(id as Id<'fld'>);
  return [...ids];
}

/** `interval` text of one comparison period (`quarter` is three months). */
export function periodInterval(period: ComparePeriod): string {
  return period === 'quarter' ? '3 months' : `1 ${period}`;
}
