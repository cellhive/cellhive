import { z } from 'zod';

import {
  dateBucketSchema,
  MAX_WIDGET_LIMIT,
  MAX_WIDGET_METRICS,
  metricAggregationSchema,
  PREVIOUS_PERIOD_RANGES,
  widgetSortSchema,
} from './dashboard-widgets.js';

/**
 * An aggregate question by name (CONTRACTS §29.4; BACKLOG T909, T922): fields
 * and options by name, the filter as one level of tuples (CONTRACTS §3).
 * The server turns it into a widget config with ids
 * (`server-core` `widgetConfigOfPlan`) and runs it through the widget
 * engine with the caller's permissions. Shared by AI Q&A and the MCP tool
 * `aggregate_records`: nothing here is specific to either.
 */

/** Widget types a plan can become (no `combo`, `text`, `filter_control`). */
export const AGGREGATE_PLAN_TYPES = ['kpi', 'bar', 'line', 'pie', 'table'] as const;
export const aggregatePlanTypeSchema = z.enum(AGGREGATE_PLAN_TYPES);
export type AggregatePlanType = z.infer<typeof aggregatePlanTypeSchema>;

const fieldName = z.string().min(1);

export const aggregatePlanMetricSchema = z.strictObject({
  aggregation: metricAggregationSchema,
  /** `null` for `count`. */
  field: fieldName.nullable().default(null),
});

export const aggregatePlanDimensionSchema = z.strictObject({
  field: fieldName,
  /** Required for a date field. */
  date_bucket: dateBucketSchema.nullable().default(null),
  /** Number fields only: ranges of this width. */
  bucket_width: z.number().positive().max(1e12).nullable().default(null),
});

/** `{ logic, conditions: [[field name, operator, value?], …] }` (CONTRACTS §3). */
export const aggregatePlanFilterSchema = z.strictObject({
  logic: z.enum(['and', 'or']),
  conditions: z
    .array(
      z.union([z.tuple([fieldName, z.string()]), z.tuple([fieldName, z.string(), z.unknown()])]),
    )
    .min(1),
});

export const aggregatePlanSchema = z.strictObject({
  type: aggregatePlanTypeSchema,
  metrics: z.array(aggregatePlanMetricSchema).min(1).max(MAX_WIDGET_METRICS),
  /** Required by every type but `kpi`, which takes none. */
  dimension: aggregatePlanDimensionSchema.nullable().default(null),
  /** `bar` and `line` only, with one metric. */
  series: aggregatePlanDimensionSchema.nullable().default(null),
  filter: aggregatePlanFilterSchema.nullable().default(null),
  /** `null`: dates in time order for a date dimension, else the largest metric first. */
  sort: widgetSortSchema.nullable().default(null),
  /** Groups returned; `null`: the widget default. */
  limit: z.int().min(1).max(MAX_WIDGET_LIMIT).nullable().default(null),
  /** `kpi` only: compare with the previous period. */
  compare: z
    .strictObject({ date_field: fieldName, range: z.enum(PREVIOUS_PERIOD_RANGES) })
    .nullable()
    .default(null),
});
export type AggregatePlan = z.output<typeof aggregatePlanSchema>;
