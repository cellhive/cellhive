import { describe, expect, it } from 'vitest';

import {
  periodInterval,
  widgetQueryFieldIds,
  widgetQueryOf,
  type WidgetQuery,
} from '../../src/records/index.js';

import type { WidgetType } from '@cellhive/contracts';

const TABLE = 'tbl_WidgetQryTable01';
const F = {
  status: 'fld_WidgetQryStatus1',
  tags: 'fld_WidgetQryTags001',
  amount: 'fld_WidgetQryAmount1',
  due: 'fld_WidgetQryDue0001',
  title: 'fld_WidgetQryTitle01',
  region: 'fld_WidgetQryRegion1',
} as const;

const filter = { op: 'and', items: [{ field: F.region, operator: 'eq', value: 'north' }] };

describe('widgetQueryOf (T806)', () => {
  const cases: {
    name: string;
    type: WidgetType;
    config: unknown;
    expected: WidgetQuery | null | 'invalid';
  }[] = [
    { name: 'text has no data', type: 'text', config: { markdown: 'x' }, expected: null },
    {
      name: 'filter control has no data',
      type: 'filter_control',
      config: {},
      expected: null,
    },
    {
      name: 'a config that no longer parses',
      type: 'bar',
      config: { table_id: 1 },
      expected: 'invalid',
    },
    {
      name: 'kpi without comparison',
      type: 'kpi',
      config: { table_id: TABLE, metrics: [{ id: 'm1', aggregation: 'count' }] },
      expected: {
        kind: 'kpi',
        tableId: TABLE,
        filter: null,
        metric: { id: 'm1', aggregation: 'count', field: null },
        compare: null,
      },
    },
    {
      name: 'kpi compared with the previous month',
      type: 'kpi',
      config: {
        table_id: TABLE,
        filter,
        metrics: [{ id: 'm1', aggregation: 'sum', field: F.amount }],
        compare: { mode: 'previous_period', date_field: F.due, range: 'month' },
      },
      expected: {
        kind: 'kpi',
        tableId: TABLE,
        filter,
        metric: { id: 'm1', aggregation: 'sum', field: F.amount },
        compare: { dateField: F.due, period: 'month' },
      },
    },
    {
      name: 'bar with a series',
      type: 'bar',
      config: {
        table_id: TABLE,
        dimension: { field: F.due, date_bucket: 'week' },
        series_dimension: { field: F.status },
        metrics: [{ id: 'm1', aggregation: 'count' }],
        sort: 'dimension_asc',
        limit: 5,
        group_others: true,
      },
      expected: {
        kind: 'grouped',
        tableId: TABLE,
        filter: null,
        dimension: { field: F.due, dateBucket: 'week', bucketWidth: null },
        series: { field: F.status, dateBucket: null, bucketWidth: null },
        metrics: [{ id: 'm1', aggregation: 'count', field: null }],
        sort: 'dimension_asc',
        limit: 5,
        groupOthers: true,
      },
    },
    {
      name: 'pie groups the rest by default',
      type: 'pie',
      config: {
        table_id: TABLE,
        dimension: { field: F.tags },
        metrics: [{ id: 'm1', aggregation: 'avg', field: F.amount }],
      },
      expected: {
        kind: 'grouped',
        tableId: TABLE,
        filter: null,
        dimension: { field: F.tags, dateBucket: null, bucketWidth: null },
        series: null,
        metrics: [{ id: 'm1', aggregation: 'avg', field: F.amount }],
        sort: 'metric_desc',
        limit: 20,
        groupOthers: true,
      },
    },
    {
      name: 'table pivot (no "Other")',
      type: 'table',
      config: {
        table_id: TABLE,
        table: {
          mode: 'pivot',
          dimension: { field: F.amount, bucket_width: 100 },
          metrics: [{ id: 'm1', aggregation: 'count' }],
          limit: 30,
        },
      },
      expected: {
        kind: 'grouped',
        tableId: TABLE,
        filter: null,
        dimension: { field: F.amount, dateBucket: null, bucketWidth: 100 },
        series: null,
        metrics: [{ id: 'm1', aggregation: 'count', field: null }],
        sort: 'metric_desc',
        limit: 30,
        groupOthers: false,
      },
    },
    {
      name: 'table records',
      type: 'table',
      config: {
        table_id: TABLE,
        table: {
          mode: 'records',
          fields: [F.title, F.amount],
          sort: { field: F.amount, direction: 'desc' },
          limit: 5,
        },
      },
      expected: {
        kind: 'records',
        tableId: TABLE,
        filter: null,
        fields: [F.title, F.amount],
        sort: { field: F.amount, direction: 'desc' },
        limit: 5,
      },
    },
  ];

  it.each(cases)('$name', ({ type, config, expected }) => {
    const query = widgetQueryOf(type, config);
    if (
      typeof expected === 'object' &&
      expected !== null &&
      query !== null &&
      query !== 'invalid'
    ) {
      expect(query).toMatchObject(expected);
    } else {
      expect(query).toEqual(expected);
    }
  });
});

describe('widgetQueryFieldIds (T806)', () => {
  it('collects every field the widget reads, saved filter included', () => {
    const query = widgetQueryOf('bar', {
      table_id: TABLE,
      filter,
      dimension: { field: F.status },
      series_dimension: { field: F.tags },
      metrics: [{ id: 'm1', aggregation: 'sum', field: F.amount }],
    }) as WidgetQuery;
    expect(widgetQueryFieldIds(query).sort()).toEqual(
      [F.status, F.tags, F.amount, F.region].sort(),
    );
    const kpi = widgetQueryOf('kpi', {
      table_id: TABLE,
      metrics: [{ id: 'm1', aggregation: 'count' }],
      compare: { mode: 'previous_period', date_field: F.due, range: 'year' },
    }) as WidgetQuery;
    expect(widgetQueryFieldIds(kpi)).toEqual([F.due]);
    const records = widgetQueryOf('table', {
      table_id: TABLE,
      table: { mode: 'records', fields: [F.title], sort: { field: F.amount, direction: 'asc' } },
    }) as WidgetQuery;
    expect(widgetQueryFieldIds(records)).toEqual([F.title, F.amount]);
  });

  it('periodInterval', () => {
    expect(periodInterval('quarter')).toBe('3 months');
    expect(periodInterval('week')).toBe('1 week');
  });
});
