import {
  aggregateRecordsInputSchema,
  type AggregatePlan,
  type AggregateRecordsInput,
  type AggregateRecordsResult,
  type McpAggregateColumn,
  type ProblemErrorItem,
  type WidgetDataColumn,
} from '@cellhive/contracts';
import {
  AppError,
  groupLabelOf,
  loadBaseSchemaRows,
  planFieldsOf,
  readabilityOfAccess,
  strictComputedPermissionsOf,
  widgetConfigOfPlan,
  widgetQueryOf,
  type PlanByNameResult,
  type WidgetAggregateResult,
  type WidgetTableMeta,
} from '@cellhive/server-core';

import { recordAccessContextOf } from '../../../common/access/record-access-context.js';
import { withRetryAfter } from '../../dashboard/widget-query-limiter.js';
import { defineTool, type McpTool } from '../tool-context.js';

import { auditRead, DATA_NOTE } from './records.js';

import type { McpToolServices } from './index.js';

type Widget = Extract<PlanByNameResult, { ok: true }>;

/**
 * The widgets of an `aggregate_records` call (CONTRACTS §30.4): with
 * `group_by` one `bar`, else one `kpi` per metric (a KPI takes one metric),
 * checked like a saved widget on the fields of `table` (`widgetConfigOfPlan`).
 * Problems carry the paths of the input; a field missing from `table` — one
 * the caller cannot read included — is `UNKNOWN_FIELD`.
 */
export function aggregateWidgetsOf(input: AggregateRecordsInput, table: WidgetTableMeta): Widget[] {
  const common = { series: null, filter: input.filter ?? null, compare: null };
  const plans: AggregatePlan[] =
    input.group_by === undefined
      ? input.metrics.map((metric) => ({
          ...common,
          type: 'kpi',
          metrics: [metric],
          dimension: null,
          sort: null,
          limit: null,
        }))
      : [
          {
            ...common,
            type: 'bar',
            metrics: input.metrics,
            dimension: input.group_by,
            sort: input.sort ?? null,
            limit: input.limit,
          },
        ];
  const results = plans.map((plan) => widgetConfigOfPlan(plan, table));
  const problems = results.flatMap((result, index): ProblemErrorItem[] =>
    result.ok
      ? []
      : result.problems.flatMap((item) => {
          // KPI `index` holds metric `index` alone; the rest is the same in every KPI.
          if (item.path.startsWith('metrics[0]')) {
            return [
              { ...item, path: item.path.replace('metrics[0]', `metrics[${String(index)}]`) },
            ];
          }
          return index === 0
            ? [{ ...item, path: item.path.replace(/^dimension/u, 'group_by') }]
            : [];
        }),
  );
  if (problems.length > 0) {
    throw new AppError(
      problems.every((item) => item.path.startsWith('filter'))
        ? 'INVALID_FILTER'
        : 'VALIDATION_FAILED',
      { detail: 'The aggregate does not fit the fields of the table.', errors: problems },
    );
  }
  return results.filter((result): result is Widget => result.ok);
}

/**
 * Widget data as the model reads it (CONTRACTS §30.4): field names instead
 * of ids, group cells as labels, the KPIs of an ungrouped call as one row.
 */
export function aggregateResultOf(
  answers: readonly WidgetAggregateResult[],
  fieldNames: ReadonlyMap<string, string>,
  grouped: boolean,
): AggregateRecordsResult {
  const raw = answers.flatMap((answer) => answer.columns);
  const columns = raw.map((column: WidgetDataColumn): McpAggregateColumn => ({
    role: column.role === 'metric' ? 'metric' : 'group',
    field: column.field_id === null ? null : (fieldNames.get(column.field_id) ?? null),
    aggregation: column.aggregation,
    date_bucket: column.date_bucket,
    bucket_width: column.bucket_width,
  }));
  if (!grouped) {
    const empty = answers.some((answer) => answer.rows.length === 0);
    const values = answers.map((answer) => (answer.rows[0]?.[0] ?? null) as number | null);
    return { columns, rows: empty ? [] : [values], other: null, total: empty ? null : values };
  }
  const [answer] = answers as [WidgetAggregateResult];
  const rowOf = (row: readonly unknown[]) =>
    row.map((cell, index) => (raw[index]?.role === 'metric' ? cell : groupLabelOf(cell)));
  return {
    columns,
    rows: answer.rows.map(rowOf),
    other:
      answer.other === undefined
        ? null
        : { groups: answer.other.groups, rows: answer.other.rows.map(rowOf) },
    total: answer.total ?? null,
  };
}

/**
 * `aggregate_records` (CONTRACTS §30.4, BACKLOG T922): a plan by name on
 * the fields the widget engine reads for the caller (`planFieldsOf`) → the
 * config of a temporary widget → `widgetQueryOf` → the dashboards' query
 * line (`WidgetQueryLimiter`) → `RecordQueryService.widgetData` with the
 * caller's access (read rule, field rule — P21, P100). Nothing is cached;
 * a successful call is audited like a record read.
 */
export function aggregateRecordsTool(services: McpToolServices): McpTool {
  return defineTool({
    name: 'aggregate_records',
    title: 'Aggregate records',
    description:
      'Counts, sums, averages, minimums or maximums over the records of a table this API ' +
      'token can read, in total or by group of a field, with an optional filter — field names ' +
      'from describe_table. Computed by the server like a dashboard chart: up to 100 groups, ' +
      `the rest in "other". ${DATA_NOTE}`,
    scope: 'records:read',
    writes: false,
    input: aggregateRecordsInputSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
    resource: (input) => ({ tableId: input.table_id }),
    async run(input, context) {
      const { principal } = context;
      const { schemaAccess, groupMembers, config, db } = services;
      const { base, table } = await schemaAccess.requireTable(principal, input.table_id, 'read');
      const scope = base.org.scope;
      const access = await recordAccessContextOf({ groupMembers, config }, principal.user, base);
      const fields = planFieldsOf(
        await loadBaseSchemaRows(db, scope, base.base.id),
        table.id,
        readabilityOfAccess(access),
        strictComputedPermissionsOf(base.base.settings),
      ).map((field) => field.meta);
      const widgets = aggregateWidgetsOf(input, { id: table.id, fields });
      const timeZone = input.timezone ?? access.timeZone;
      const answers = await Promise.all(
        widgets.map(({ type, config: widget }) => {
          // "Other" sums up the groups past `limit`.
          const query = widgetQueryOf(
            type,
            type === 'bar' ? { ...widget, group_others: true } : widget,
          );
          if (query === null || query === 'invalid') {
            throw new AppError('INTERNAL', { detail: 'A checked plan makes a widget query.' });
          }
          return services.limiter
            .run(principal.userId, () =>
              services.recordQuery.widgetData(scope, access, query, { timeZone }),
            )
            .catch((error: unknown) => {
              throw withRetryAfter(error);
            });
        }),
      );
      // Only if the schema changed meanwhile; never tells which field.
      if (
        answers.some((answer) => answer.status === 'no_permission' || answer.status === 'broken')
      ) {
        throw new AppError('NOT_FOUND');
      }
      const names = new Map(fields.map((field) => [field.id, field.name]));
      const result = aggregateResultOf(answers, names, input.group_by !== undefined);
      await auditRead(db, 'aggregate_records', table.id, result.rows.length, context);
      return result;
    },
  });
}
