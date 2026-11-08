import { aggregatePlanSchema, type AggregatePlanType } from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import {
  planFieldsOf,
  widgetConfigOfPlan,
} from '../../src/records/dashboard-aggregate/plan-by-name.js';

import type { BaseSchemaRows } from '../../src/computed/index.js';
import type { WidgetTableMeta } from '../../src/dashboards/widget-config.js';
import type { FieldRow } from '../../src/db/schema.js';

const ORDERS = 'tbl_PlanByNameOrders';
const F = {
  title: 'fld_PlanByNameTitle0',
  amount: 'fld_PlanByNameAmount',
  status: 'fld_PlanByNameStatus',
  owner: 'fld_PlanByNameOwner0',
  date: 'fld_PlanByNameDate00',
  files: 'fld_PlanByNameFiles0',
} as const;
const NEW = 'opt_PlanByNameOptNew';

/** Fields the caller reads: `cost` is hidden, so it is not here at all. */
const orders: WidgetTableMeta = {
  id: ORDERS,
  fields: [
    { id: F.title, name: 'title', type: 'text', options: {} },
    { id: F.amount, name: 'amount', type: 'number', options: {} },
    {
      id: F.status,
      name: 'status',
      type: 'select',
      options: { options: [{ id: NEW, name: 'Mới' }] },
    },
    { id: F.owner, name: 'owner', type: 'user', options: {} },
    { id: F.date, name: 'ngày', type: 'datetime', options: {} },
    { id: F.files, name: 'files', type: 'attachment', options: {} },
  ],
};

const plan = (input: Record<string, unknown>) =>
  widgetConfigOfPlan(aggregatePlanSchema.parse(input), orders);
const sumAmount = [{ aggregation: 'sum', field: 'amount' }];
const count = [{ aggregation: 'count' }];

describe('widgetConfigOfPlan: names → a widget config with ids (T909, T922)', () => {
  it('turns "revenue by month" into a bar config with ids, dates in time order', () => {
    const result = plan({
      type: 'bar',
      metrics: sumAmount,
      dimension: { field: 'ngày', date_bucket: 'month' },
      filter: { logic: 'and', conditions: [['status', '==', 'Mới']] },
    });
    expect(result).toMatchObject({
      ok: true,
      type: 'bar',
      config: {
        table_id: ORDERS,
        metrics: [{ id: 'm1', aggregation: 'sum', field: F.amount }],
        dimension: { field: F.date, date_bucket: 'month', bucket_width: null },
        series_dimension: null,
        sort: 'dimension_asc',
        limit: 20,
        filter: { op: 'and', items: [{ field: F.status, operator: 'is', value: NEW }] },
      },
    });
  });

  it.each<[string, AggregatePlanType, Record<string, unknown>, Record<string, unknown>]>([
    [
      'a kpi with a comparison',
      'kpi',
      { metrics: count, compare: { date_field: 'ngày', range: 'month' } },
      {
        metrics: [expect.objectContaining({ aggregation: 'count', field: null })],
        compare: { mode: 'previous_period', date_field: F.date, range: 'month' },
      },
    ],
    [
      'a table becomes a pivot',
      'table',
      { metrics: sumAmount, dimension: { field: 'status' }, limit: 5 },
      {
        table: expect.objectContaining({
          mode: 'pivot',
          dimension: { field: F.status, date_bucket: null, bucket_width: null },
          sort: 'metric_desc',
          limit: 5,
        }),
      },
    ],
    [
      'a pie keeps "Other"',
      'pie',
      { metrics: count, dimension: { field: 'owner' }, sort: 'dimension_desc' },
      { group_others: true, sort: 'dimension_desc' },
    ],
    [
      'a line with a series and number buckets',
      'line',
      {
        metrics: count,
        dimension: { field: 'amount', bucket_width: 100 },
        series: { field: 'status' },
      },
      {
        dimension: { field: F.amount, date_bucket: null, bucket_width: 100 },
        series_dimension: { field: F.status, date_bucket: null, bucket_width: null },
      },
    ],
    [
      'relative dates and the current user in the filter',
      'kpi',
      {
        metrics: count,
        filter: {
          logic: 'or',
          conditions: [
            ['ngày', '>=', 'Today'],
            ['owner', 'intersects', 'CurrentUser'],
            ['files', 'empty', null],
          ],
        },
      },
      {
        filter: {
          op: 'or',
          items: [
            { field: F.date, operator: 'on_or_after', value: { $date: { relative: 'today' } } },
            { field: F.owner, operator: 'has_any_of', value: [{ $var: 'current_user' }] },
            { field: F.files, operator: 'is_empty' },
          ],
        },
      },
    ],
  ])('%s', (_name, type, input, expected) => {
    const result = plan({ type, ...input });
    expect(result).toMatchObject({ ok: true, type, config: expected });
  });

  it.each<[string, Record<string, unknown>, [string, string][]]>([
    [
      'a hidden field is a field that does not exist',
      { type: 'kpi', metrics: [{ aggregation: 'sum', field: 'cost' }] },
      [['metrics[0].field', 'UNKNOWN_FIELD']],
    ],
    [
      'every unknown name, filter included',
      {
        type: 'bar',
        metrics: count,
        dimension: { field: 'nope' },
        filter: {
          logic: 'and',
          conditions: [
            ['status', '==', 'Mới'],
            ['lợi nhuận', '>', 1],
          ],
        },
      },
      [
        ['dimension.field', 'UNKNOWN_FIELD'],
        ['filter.conditions[1][0]', 'UNKNOWN_FIELD'],
      ],
    ],
    [
      'a date dimension without a bucket',
      { type: 'line', metrics: count, dimension: { field: 'ngày' } },
      [['dimension.date_bucket', 'DATE_BUCKET_REQUIRED']],
    ],
    [
      'a numeric aggregation on a field that is not a number',
      { type: 'kpi', metrics: [{ aggregation: 'avg', field: 'status' }] },
      [['metrics[0].field', 'INVALID_METRIC']],
    ],
    [
      'a field that cannot be grouped',
      { type: 'pie', metrics: count, dimension: { field: 'files' } },
      [['dimension.field', 'INVALID_DIMENSION']],
    ],
    ['a chart without a dimension', { type: 'bar', metrics: count }, [['dimension', 'REQUIRED']]],
    [
      'keys the type does not take',
      {
        type: 'kpi',
        metrics: count,
        dimension: { field: 'status' },
        series: { field: 'owner' },
      },
      [
        ['dimension', 'UNRECOGNIZED_KEY'],
        ['series', 'UNRECOGNIZED_KEY'],
      ],
    ],
    [
      'a comparison outside a kpi',
      {
        type: 'bar',
        metrics: count,
        dimension: { field: 'status' },
        compare: { date_field: 'ngày', range: 'week' },
      },
      [['compare', 'UNRECOGNIZED_KEY']],
    ],
    [
      'a comparison on a field that is not a date',
      { type: 'kpi', metrics: count, compare: { date_field: 'amount', range: 'week' } },
      [['compare.date_field', 'INVALID_DIMENSION']],
    ],
    [
      'two metrics on a kpi',
      { type: 'kpi', metrics: [...count, ...sumAmount] },
      [['metrics', 'TOO_BIG']],
    ],
    [
      'a series with two metrics',
      {
        type: 'bar',
        metrics: [...count, ...sumAmount],
        dimension: { field: 'status' },
        series: { field: 'owner' },
      },
      [['metrics', 'INVALID']],
    ],
    [
      'an operator the field does not take',
      {
        type: 'kpi',
        metrics: count,
        filter: { logic: 'and', conditions: [['status', '>', 'Mới']] },
      },
      [['filter.conditions[0][1]', 'OPERATOR_NOT_ALLOWED']],
    ],
    [
      'an option that does not exist',
      {
        type: 'kpi',
        metrics: count,
        filter: { logic: 'and', conditions: [['status', '==', 'Done']] },
      },
      [['filter.conditions[0][2]', 'INVALID_SELECT_OPTION']],
    ],
  ])('%s', (_name, input, expected) => {
    const result = plan(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.map((item) => [item.path, item.code])).toEqual(expected);
    // Problems name what the plan wrote, never an id.
    expect(JSON.stringify(result.problems)).not.toMatch(/(fld|tbl|opt)_/u);
  });
});

describe('planFieldsOf: what a plan may name for one reader (CONTRACTS §29.4, §29.5)', () => {
  const COST = 'fld_PlanByNameCost00';
  const BAND = 'fld_PlanByNameBand00';
  const LABEL = 'fld_PlanByNameLabel0';
  const ai = (prompt: string) => ({
    task: 'classify',
    prompt,
    instructions: null,
    auto_update: false,
    max_output_tokens: 300,
  });
  const row = (id: string, name: string, type: string, options: unknown = {}) =>
    ({ id, table_id: ORDERS, name, type, options, deleted_at: null }) as unknown as FieldRow;
  const rows: BaseSchemaRows = {
    baseId: 'bse_PlanByNameBase00',
    tables: [],
    fields: [
      row(F.title, 'title', 'text'),
      row(COST, 'cost', 'number'),
      // AI selects: one made from `cost`, one from `title`.
      row(BAND, 'ai_band', 'select', { options: [], ai: ai(`{{ [${COST}] }}`) }),
      row(LABEL, 'ai_label', 'select', { options: [], ai: ai(`{{ [${F.title}] }}`) }),
    ],
  };
  const reader = (hidden: string[]) => ({
    table: () => true,
    field: (_tableId: string, id: string) => !hidden.includes(id),
  });
  const names = (hidden: string[]) =>
    planFieldsOf(rows, ORDERS, reader(hidden) as never, false).map((field) => field.meta.name);

  it('leaves out an AI field the reader is locked out of, like a field that does not exist', () => {
    expect(names([])).toEqual(['title', 'cost', 'ai_band', 'ai_label']);
    expect(names([COST])).toEqual(['title', 'ai_label']);
  });
});
