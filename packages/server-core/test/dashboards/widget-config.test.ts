import { describe, expect, it } from 'vitest';

import {
  buildWidgetConfig,
  checkGlobalFilters,
  remapWidgetIds,
  widgetBrokenReasonOf,
  widgetFieldKindOf,
  type SiblingWidget,
  type WidgetCheckContext,
  type WidgetTableMeta,
} from '../../src/dashboards/index.js';
import { AppError } from '../../src/errors/app-error.js';

import type { WidgetType } from '@cellhive/contracts';

const ORDERS = 'tbl_DashCfgOrders001';
const OTHER = 'tbl_DashCfgOther0001';
const F = {
  title: 'fld_DashCfgTitle0001',
  amount: 'fld_DashCfgAmount001',
  status: 'fld_DashCfgStatus001',
  tags: 'fld_DashCfgTags00001',
  owner: 'fld_DashCfgOwner0001',
  done: 'fld_DashCfgDone00001',
  due: 'fld_DashCfgDue000001',
  customer: 'fld_DashCfgCustomer1',
  files: 'fld_DashCfgFiles0001',
  total: 'fld_DashCfgTotal0001',
  names: 'fld_DashCfgNames0001',
  otherName: 'fld_DashCfgOtherName',
} as const;
const W = {
  self: 'wgt_DashCfgSelf00001',
  control: 'wgt_DashCfgControl01',
  child: 'wgt_DashCfgChild0001',
  otherControl: 'wgt_DashCfgOtherCtl1',
  chart: 'wgt_DashCfgChart0001',
} as const;

const orders: WidgetTableMeta = {
  id: ORDERS,
  fields: [
    { id: F.title, name: 'title', type: 'text', options: {} },
    { id: F.amount, name: 'amount', type: 'number', options: {} },
    {
      id: F.status,
      name: 'status',
      type: 'select',
      options: { options: [{ id: 'opt_DashCfgOptNew001', name: 'New' }] },
    },
    { id: F.tags, name: 'tags', type: 'select', options: { multiple: true, options: [] } },
    { id: F.owner, name: 'owner', type: 'user', options: {} },
    { id: F.done, name: 'done', type: 'checkbox', options: {} },
    { id: F.due, name: 'due', type: 'datetime', options: {} },
    { id: F.customer, name: 'customer', type: 'link', options: { link_table: OTHER } },
    { id: F.files, name: 'files', type: 'attachment', options: {} },
    { id: F.total, name: 'total', type: 'formula', options: {}, result_type: { kind: 'number' } },
    {
      id: F.names,
      name: 'names',
      type: 'lookup',
      options: {},
      result_type: { kind: 'list', element: { kind: 'text' } },
    },
  ],
};
const other: WidgetTableMeta = {
  id: OTHER,
  fields: [{ id: F.otherName, name: 'name', type: 'text', options: {} }],
};

function context(siblings: Record<string, SiblingWidget> = {}): WidgetCheckContext {
  return {
    tables: new Map([
      [ORDERS, orders],
      [OTHER, other],
    ]),
    siblings: new Map(Object.entries(siblings)),
    widgetId: W.self,
  };
}

const controls: Record<string, SiblingWidget> = {
  [W.control]: {
    type: 'filter_control',
    config: { table_id: ORDERS, field: F.status, control: 'select', parent_control_id: null },
  },
  [W.otherControl]: {
    type: 'filter_control',
    config: { table_id: OTHER, field: F.otherName, control: 'text', parent_control_id: null },
  },
  [W.chart]: { type: 'bar', config: {} },
};

/** `[top-level code, detail code, path]` of the problem, or `null` when it saves. */
function problemOf(
  type: WidgetType,
  config: unknown,
  siblings: Record<string, SiblingWidget> = controls,
): [string, string | undefined, string | undefined] | null {
  try {
    buildWidgetConfig(type, config, context(siblings));
    return null;
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    const first = error.errors?.[0];
    return [error.code, first?.code, first?.path];
  }
}

const count = { id: 'm1', aggregation: 'count' };
const sum = (field: string) => ({ id: 'm1', aggregation: 'sum', field });
const bar = (dimension: object, metrics: object[] = [count], extra: object = {}) => ({
  table_id: ORDERS,
  dimension,
  metrics,
  ...extra,
});

describe('widgetFieldKindOf (SPEC §10.3)', () => {
  it.each([
    ['text', {}, 'text'],
    ['auto_number', {}, 'text'],
    ['number', {}, 'number'],
    ['select', {}, 'select'],
    ['user', {}, 'user'],
    ['created_by', {}, 'user'],
    ['checkbox', {}, 'checkbox'],
    ['datetime', {}, 'date'],
    ['created_at', {}, 'date'],
    ['link', {}, 'link'],
    ['attachment', {}, null],
    ['button', {}, null],
    ['parent', {}, null],
    ['formula', { result_type: { kind: 'number' } }, 'number'],
    ['formula', { result_type: { kind: 'date' } }, 'date'],
    ['formula', { result_type: { kind: 'boolean' } }, 'checkbox'],
    ['formula', { result_type: { kind: 'any' } }, null],
    ['lookup', { result_type: { kind: 'list', element: { kind: 'number' } } }, null],
    ['lookup', { result_type: { kind: 'user' } }, 'user'],
  ] as const)('%s %j → %s', (type, extra, kind) => {
    expect(widgetFieldKindOf({ type, ...extra })).toBe(kind);
  });
});

describe('buildWidgetConfig (CONTRACTS §28.2)', () => {
  it.each([
    ['bar by select', 'bar', bar({ field: F.status }), null],
    ['bar by multi select', 'bar', bar({ field: F.tags }), null],
    ['bar by user', 'bar', bar({ field: F.owner }), null],
    ['bar by checkbox', 'bar', bar({ field: F.done }), null],
    ['bar by link', 'bar', bar({ field: F.customer }), null],
    ['bar by month', 'bar', bar({ field: F.due, date_bucket: 'month' }), null],
    ['bar by number range', 'bar', bar({ field: F.amount, bucket_width: 100 }), null],
    ['bar by number formula', 'bar', bar({ field: F.total }), null],
    [
      'date without bucket',
      'bar',
      bar({ field: F.due }),
      ['VALIDATION_FAILED', 'DATE_BUCKET_REQUIRED', 'config.dimension.date_bucket'],
    ],
    [
      'bucket on text',
      'line',
      bar({ field: F.title, date_bucket: 'day' }),
      ['VALIDATION_FAILED', 'INVALID_DIMENSION', 'config.dimension.date_bucket'],
    ],
    [
      'width on select',
      'line',
      bar({ field: F.status, bucket_width: 5 }),
      ['VALIDATION_FAILED', 'INVALID_DIMENSION', 'config.dimension.bucket_width'],
    ],
    [
      'attachment dimension',
      'pie',
      bar({ field: F.files }),
      ['VALIDATION_FAILED', 'INVALID_DIMENSION', 'config.dimension.field'],
    ],
    [
      'list lookup dimension',
      'pie',
      bar({ field: F.names }),
      ['VALIDATION_FAILED', 'INVALID_DIMENSION', 'config.dimension.field'],
    ],
    [
      'field of another table',
      'bar',
      bar({ field: F.otherName }),
      ['VALIDATION_FAILED', 'UNKNOWN_FIELD', 'config.dimension.field'],
    ],
    [
      'unknown table',
      'kpi',
      { table_id: 'tbl_DashCfgMissing01', metrics: [count] },
      ['VALIDATION_FAILED', 'UNKNOWN_TABLE', 'config.table_id'],
    ],
    ['sum of number', 'kpi', { table_id: ORDERS, metrics: [sum(F.amount)] }, null],
    [
      'sum of text',
      'kpi',
      { table_id: ORDERS, metrics: [sum(F.title)] },
      ['VALIDATION_FAILED', 'INVALID_METRIC', 'config.metrics[0].field'],
    ],
    [
      'count distinct of user',
      'kpi',
      { table_id: ORDERS, metrics: [{ id: 'm1', aggregation: 'count_distinct', field: F.owner }] },
      null,
    ],
    [
      'count distinct of attachment',
      'kpi',
      { table_id: ORDERS, metrics: [{ id: 'm1', aggregation: 'count_distinct', field: F.files }] },
      ['VALIDATION_FAILED', 'INVALID_METRIC', 'config.metrics[0].field'],
    ],
    [
      'compare on a date',
      'kpi',
      {
        table_id: ORDERS,
        metrics: [count],
        compare: { mode: 'previous_period', date_field: F.due, range: 'month' },
      },
      null,
    ],
    [
      'compare on a number',
      'kpi',
      {
        table_id: ORDERS,
        metrics: [count],
        compare: { mode: 'previous_period', date_field: F.amount, range: 'month' },
      },
      ['VALIDATION_FAILED', 'INVALID_DIMENSION', 'config.compare.date_field'],
    ],
    [
      'six metrics',
      'bar',
      bar(
        { field: F.status },
        Array.from({ length: 6 }, (_, index) => ({
          id: `m${String(index)}`,
          aggregation: 'count',
        })),
      ),
      ['VALIDATION_FAILED', 'TOO_BIG', 'config.metrics'],
    ],
    [
      'series dimension by user',
      'bar',
      bar({ field: F.status }, [count], { series_dimension: { field: F.owner } }),
      null,
    ],
    [
      'bad filter',
      'bar',
      bar({ field: F.status }, [count], {
        filter: { op: 'and', items: [{ field: F.amount, operator: 'contains', value: 'x' }] },
      }),
      ['INVALID_FILTER', undefined, undefined],
    ],
    [
      'filter on another table',
      'bar',
      bar({ field: F.status }, [count], {
        filter: { op: 'and', items: [{ field: F.otherName, operator: 'is_empty' }] },
      }),
      ['INVALID_FILTER', undefined, undefined],
    ],
    [
      'binding to a control',
      'bar',
      bar({ field: F.status }, [count], { filter_bindings: [W.control] }),
      null,
    ],
    [
      'binding to a chart',
      'bar',
      bar({ field: F.status }, [count], { filter_bindings: [W.chart] }),
      ['VALIDATION_FAILED', 'UNKNOWN_WIDGET', 'config.filter_bindings[0]'],
    ],
    [
      'binding to a missing widget',
      'kpi',
      { table_id: ORDERS, metrics: [count], filter_bindings: ['wgt_DashCfgMissing01'] },
      ['VALIDATION_FAILED', 'UNKNOWN_WIDGET', 'config.filter_bindings[0]'],
    ],
    [
      'table records',
      'table',
      { table_id: ORDERS, table: { mode: 'records', fields: [F.title, F.amount] } },
      null,
    ],
    [
      'table records duplicate',
      'table',
      { table_id: ORDERS, table: { mode: 'records', fields: [F.title, F.title] } },
      ['VALIDATION_FAILED', 'DUPLICATE_FIELD', 'config.table.fields[1]'],
    ],
    [
      'table pivot by date without bucket',
      'table',
      { table_id: ORDERS, table: { mode: 'pivot', dimension: { field: F.due }, metrics: [count] } },
      ['VALIDATION_FAILED', 'DATE_BUCKET_REQUIRED', 'config.table.dimension.date_bucket'],
    ],
    ['text', 'text', { markdown: '**hi**' }, null],
    [
      'select control',
      'filter_control',
      { table_id: ORDERS, field: F.status, control: 'select' },
      null,
    ],
    [
      'select control with a default',
      'filter_control',
      { table_id: ORDERS, field: F.status, control: 'select', default: { values: ['opt_a'] } },
      null,
    ],
    [
      'date control with a relative default',
      'filter_control',
      {
        table_id: ORDERS,
        field: F.due,
        control: 'date_range',
        default: { relative: 'this_month' },
      },
      null,
    ],
    [
      'date control with a range of numbers (T808)',
      'filter_control',
      {
        table_id: ORDERS,
        field: F.due,
        control: 'date_range',
        default: { range: { from: 1, to: 2 } },
      },
      ['VALIDATION_FAILED', 'INVALID_FILTER_CONTROL', 'config.default'],
    ],
    [
      'select control with a relative default (T808)',
      'filter_control',
      { table_id: ORDERS, field: F.status, control: 'select', default: { relative: 'today' } },
      ['VALIDATION_FAILED', 'INVALID_FILTER_CONTROL', 'config.default'],
    ],
    [
      'date control on text',
      'filter_control',
      { table_id: ORDERS, field: F.title, control: 'date_range' },
      ['VALIDATION_FAILED', 'INVALID_FILTER_CONTROL', 'config.field'],
    ],
    [
      'cascading control',
      'filter_control',
      { table_id: ORDERS, field: F.owner, control: 'user', parent_control_id: W.control },
      null,
    ],
    [
      'parent on another table',
      'filter_control',
      { table_id: ORDERS, field: F.owner, control: 'user', parent_control_id: W.otherControl },
      ['VALIDATION_FAILED', 'INVALID_FILTER_CONTROL', 'config.parent_control_id'],
    ],
    [
      'parent is a chart',
      'filter_control',
      { table_id: ORDERS, field: F.owner, control: 'user', parent_control_id: W.chart },
      ['VALIDATION_FAILED', 'UNKNOWN_WIDGET', 'config.parent_control_id'],
    ],
    [
      'wrong shape',
      'pie',
      { table_id: ORDERS },
      ['VALIDATION_FAILED', undefined, 'config.dimension'],
    ],
  ] as const)('%s', (_name, type, config, expected) => {
    const problem = problemOf(type, config);
    if (expected === null) {
      expect(problem).toBeNull();
    } else {
      expect(problem?.[0]).toBe(expected[0]);
      if (expected[1] !== undefined) expect(problem?.[1]).toBe(expected[1]);
      if (expected[2] !== undefined) expect(problem?.[2]).toBe(expected[2]);
    }
  });

  it('refuses a loop of parent controls', () => {
    const siblings: Record<string, SiblingWidget> = {
      [W.control]: {
        type: 'filter_control',
        config: { table_id: ORDERS, field: F.status, control: 'select', parent_control_id: W.self },
      },
    };
    expect(
      problemOf(
        'filter_control',
        { table_id: ORDERS, field: F.owner, control: 'user', parent_control_id: W.control },
        siblings,
      ),
    ).toEqual(['VALIDATION_FAILED', 'INVALID_FILTER_CONTROL', 'config.parent_control_id']);
  });

  it('stores the filter as DSL and drops duplicate bindings', () => {
    const config = buildWidgetConfig(
      'bar',
      bar({ field: F.status }, [count], {
        filter: { logic: 'and', conditions: [[F.amount, '>', 5]] },
        filter_bindings: [W.control, W.control],
      }),
      context(controls),
    );
    expect(config).toMatchObject({
      filter: { op: 'and', items: [{ field: F.amount, operator: 'gt', value: 5 }] },
      filter_bindings: [W.control],
      limit: 20,
      sort: 'metric_desc',
    });
  });
});

describe('checkGlobalFilters', () => {
  const tables = context().tables;
  it('accepts fitting fields and refuses others', () => {
    expect(
      checkGlobalFilters(
        [{ id: 'g1', kind: 'date_range', targets: [{ table_id: ORDERS, field: F.due }] }],
        tables,
      ),
    ).toEqual([
      { id: 'g1', label: null, kind: 'date_range', targets: [{ table_id: ORDERS, field: F.due }] },
    ]);
    expect(() =>
      checkGlobalFilters(
        [{ id: 'g1', kind: 'date_range', targets: [{ table_id: ORDERS, field: F.amount }] }],
        tables,
      ),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    expect(() =>
      checkGlobalFilters(
        [{ id: 'g1', kind: 'text', targets: [{ table_id: ORDERS, field: F.otherName }] }],
        tables,
      ),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });
});

describe('widgetBrokenReasonOf', () => {
  const tables = context().tables;
  it.each([
    ['text widget', 'text', { markdown: '' }, null],
    ['active refs', 'bar', bar({ field: F.status }, [sum(F.amount)]), null],
    [
      'deleted table',
      'kpi',
      { table_id: 'tbl_DashCfgGone00001', metrics: [count] },
      'table_deleted',
    ],
    ['deleted dimension', 'bar', bar({ field: 'fld_DashCfgGone00001' }), 'field_deleted'],
    [
      'deleted filter field',
      'bar',
      bar({ field: F.status }, [count], {
        filter: { op: 'and', items: [{ field: 'fld_DashCfgGone00001', operator: 'is_empty' }] },
      }),
      'field_deleted',
    ],
    [
      'deleted record-list sort',
      'table',
      {
        table_id: ORDERS,
        table: {
          mode: 'records',
          fields: [F.title],
          sort: { field: 'fld_DashCfgGone00001', direction: 'asc' },
        },
      },
      'field_deleted',
    ],
  ] as const)('%s', (_name, type, config, reason) => {
    expect(widgetBrokenReasonOf(type, config, tables)).toBe(reason);
  });
});

describe('remapWidgetIds', () => {
  it('replaces bindings and parents, dropping unknown ids', () => {
    const mapping = new Map([[W.control, 'wgt_DashCfgNewCtl001']]);
    expect(
      remapWidgetIds('bar', { filter_bindings: [W.control, W.chart], limit: 5 }, mapping),
    ).toEqual({ filter_bindings: ['wgt_DashCfgNewCtl001'], limit: 5 });
    expect(remapWidgetIds('filter_control', { parent_control_id: W.control }, mapping)).toEqual({
      parent_control_id: 'wgt_DashCfgNewCtl001',
    });
    expect(remapWidgetIds('filter_control', { parent_control_id: W.chart }, mapping)).toEqual({
      parent_control_id: null,
    });
  });
});
