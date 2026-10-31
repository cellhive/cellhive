import {
  buildWidgetConfig,
  widgetFieldKindOf,
  type WidgetFieldMeta,
  type WidgetTableMeta,
} from '../../dashboards/widget-config.js';
import { AppError } from '../../errors/app-error.js';

import type {
  AggregatePlan,
  AggregatePlanType,
  ProblemErrorItem,
  WidgetConfig,
} from '@cellhive/contracts';

/**
 * An aggregate plan by name → the config of a widget with ids (CONTRACTS
 * §29.4; BACKLOG T909, T922): names resolved against the fields the caller
 * reads, the filter tuple kept as a tuple of ids, then the save check of a
 * dashboard widget (`buildWidgetConfig`: groupable dimension, date bucket,
 * aggregation that fits its field, filter in mode `standard`). Pure; shared
 * by AI Q&A and the MCP tool `aggregate_records` — nothing here knows
 * either.
 *
 * `table.fields` are the fields the caller reads and may use: a hidden
 * field is a field that does not exist (same problem, same message), so a
 * plan can never tell one from the other.
 */

export type PlanByNameResult =
  | { readonly ok: true; readonly type: AggregatePlanType; readonly config: WidgetConfig }
  | { readonly ok: false; readonly problems: readonly ProblemErrorItem[] };

/** A path of the widget config check as a path of the plan. */
function planPathOf(configPath: string): string {
  return configPath
    .replace(/^config\.table\./u, '')
    .replace(/^config\.series_dimension/u, 'series')
    .replace(/^config\.?/u, '');
}

function problem(path: string, code: string, message: string): ProblemErrorItem {
  return { path, code, message };
}

export function widgetConfigOfPlan(plan: AggregatePlan, table: WidgetTableMeta): PlanByNameResult {
  const problems: ProblemErrorItem[] = [];
  const byName = new Map(table.fields.map((field) => [field.name, field]));
  const fieldOf = (name: string, path: string): WidgetFieldMeta | undefined => {
    const field = byName.get(name);
    if (field === undefined) {
      problems.push({
        path,
        code: 'UNKNOWN_FIELD',
        message: 'The table has no field with this name',
        params: { field: name },
      });
    }
    return field;
  };
  const idOf = (name: string, path: string): string => fieldOf(name, path)?.id ?? '';

  const { type } = plan;
  if (type === 'kpi' && plan.dimension !== null) {
    problems.push(problem('dimension', 'UNRECOGNIZED_KEY', 'A kpi takes no dimension: use null'));
  }
  if (type !== 'kpi' && plan.dimension === null) {
    problems.push(problem('dimension', 'REQUIRED', `A ${type} needs a dimension`));
  }
  if (plan.series !== null && type !== 'bar' && type !== 'line') {
    problems.push(problem('series', 'UNRECOGNIZED_KEY', 'Only bar and line take a series'));
  }
  if (plan.compare !== null && type !== 'kpi') {
    problems.push(problem('compare', 'UNRECOGNIZED_KEY', 'Only a kpi takes a comparison'));
  }

  const metrics = plan.metrics.map((metric, index) => ({
    id: `m${String(index + 1)}`,
    aggregation: metric.aggregation,
    field: metric.field === null ? null : idOf(metric.field, `metrics[${String(index)}].field`),
  }));
  const dimensionOf = (dimension: AggregatePlan['dimension'], path: string) =>
    dimension === null
      ? null
      : {
          field: idOf(dimension.field, `${path}.field`),
          date_bucket: dimension.date_bucket,
          bucket_width: dimension.bucket_width,
        };
  const dimension = type === 'kpi' ? null : dimensionOf(plan.dimension, 'dimension');
  const series = dimensionOf(plan.series, 'series');
  const filter =
    plan.filter === null
      ? null
      : {
          logic: plan.filter.logic,
          conditions: plan.filter.conditions.map(([name, ...rest], index) => [
            idOf(name, `filter.conditions[${String(index)}][0]`),
            ...rest,
          ]),
        };
  const compare =
    plan.compare === null
      ? null
      : {
          mode: 'previous_period',
          date_field: idOf(plan.compare.date_field, 'compare.date_field'),
          range: plan.compare.range,
        };
  if (problems.length > 0) return { ok: false, problems };

  // Dates read in time order unless the plan sorts otherwise.
  const dateDimension =
    plan.dimension !== null &&
    widgetFieldKindOf(byName.get(plan.dimension.field) as WidgetFieldMeta) === 'date';
  const sort = plan.sort ?? (dateDimension ? 'dimension_asc' : null);
  const order = {
    ...(sort === null ? {} : { sort }),
    ...(plan.limit === null ? {} : { limit: plan.limit }),
  };
  const data = { table_id: table.id, filter };
  const input =
    type === 'kpi'
      ? { ...data, metrics, compare }
      : type === 'table'
        ? { ...data, table: { mode: 'pivot', dimension, metrics, ...order } }
        : {
            ...data,
            dimension,
            ...(type === 'pie' ? {} : { series_dimension: series }),
            metrics,
            ...order,
          };
  try {
    const config = buildWidgetConfig(type, input, {
      tables: new Map([[table.id, table]]),
      siblings: new Map(),
      widgetId: '',
    });
    return { ok: true, type, config };
  } catch (error) {
    if (
      !(error instanceof AppError) ||
      (error.code !== 'VALIDATION_FAILED' && error.code !== 'INVALID_FILTER')
    ) {
      throw error;
    }
    return {
      ok: false,
      problems: (error.errors ?? []).map((item) => ({ ...item, path: planPathOf(item.path) })),
    };
  }
}
