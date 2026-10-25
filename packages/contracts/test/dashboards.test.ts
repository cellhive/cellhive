import { describe, expect, it } from 'vitest';

import {
  checkLayout,
  compactLayout,
  isRectInBounds,
  layoutBottom,
  placeAtBottom,
  rectsOverlap,
  type GridItem,
} from '../src/dashboard-layout.js';
import {
  createWidgetRequestSchema,
  updateWidgetRequestSchema,
  WIDGET_CONFIG_SCHEMAS,
  widgetLayoutSchema,
} from '../src/dashboard-widgets.js';
import {
  createDashboardRequestSchema,
  dashboardGlobalFiltersSchema,
  dashboardIfMatchHeaderSchema,
  updateDashboardLayoutRequestSchema,
  updateDashboardRequestSchema,
} from '../src/dashboards.js';
import { DASHBOARD_DETAIL_CODES, ERROR_DETAIL_CODES } from '../src/error-details.js';
import { EVENT_TYPES } from '../src/events.js';

const TBL = 'tbl_A1b2C3d4E5f6G7h8';
const FLD = 'fld_A1b2C3d4E5f6G7h8';
const FLD2 = 'fld_B1b2C3d4E5f6G7h8';
const WGT = 'wgt_A1b2C3d4E5f6G7h8';

const item = (id: string, x: number, y: number, w: number, h: number): GridItem => ({
  id,
  x,
  y,
  w,
  h,
});

describe('dashboard layout (CONTRACTS §28.1)', () => {
  it.each([
    ['full width', { x: 0, y: 0, w: 12, h: 2 }, true],
    ['last column', { x: 11, y: 5, w: 1, h: 24 }, true],
    ['past column 12', { x: 7, y: 0, w: 6, h: 4 }, false],
    ['negative x', { x: -1, y: 0, w: 2, h: 4 }, false],
    ['too narrow', { x: 0, y: 0, w: 0, h: 4 }, false],
    ['too wide', { x: 0, y: 0, w: 13, h: 4 }, false],
    ['too short', { x: 0, y: 0, w: 4, h: 1 }, false],
    ['too tall', { x: 0, y: 0, w: 4, h: 25 }, false],
    ['fractional', { x: 0.5, y: 0, w: 4, h: 4 }, false],
    ['row too far', { x: 0, y: 1001, w: 4, h: 4 }, false],
  ])('bounds: %s', (_name, rect, expected) => {
    expect(isRectInBounds(rect)).toBe(expected);
    expect(widgetLayoutSchema.safeParse(rect).success).toBe(expected);
  });

  it.each([
    ['side by side', [0, 0, 6, 4], [6, 0, 6, 4], false],
    ['stacked', [0, 0, 6, 4], [0, 4, 6, 4], false],
    ['same cell', [0, 0, 6, 4], [5, 3, 2, 2], true],
    ['inside', [0, 0, 12, 10], [3, 3, 2, 2], true],
    ['corner touch', [0, 0, 6, 4], [6, 4, 6, 4], false],
  ] as const)('overlap: %s', (_name, a, b, expected) => {
    const [ax, ay, aw, ah] = a;
    const [bx, by, bw, bh] = b;
    const first = { x: ax, y: ay, w: aw, h: ah };
    const second = { x: bx, y: by, w: bw, h: bh };
    expect(rectsOverlap(first, second)).toBe(expected);
    expect(rectsOverlap(second, first)).toBe(expected);
  });

  it('reports items outside the grid, then overlaps with the earlier item', () => {
    expect(
      checkLayout([
        item('a', 0, 0, 6, 4),
        item('b', 8, 0, 6, 4),
        item('c', 3, 2, 6, 4),
        item('d', 6, 3, 6, 2),
      ]),
    ).toEqual([
      { code: 'LAYOUT_OUT_OF_BOUNDS', id: 'b' },
      { code: 'LAYOUT_OVERLAP', id: 'c', other: 'a' },
      { code: 'LAYOUT_OVERLAP', id: 'd', other: 'c' },
    ]);
    expect(checkLayout([item('a', 0, 0, 6, 4), item('b', 6, 0, 6, 4)])).toEqual([]);
    expect(checkLayout([])).toEqual([]);
  });

  it.each([
    ['moves a lone item to the top', [item('a', 3, 9, 4, 2)], [item('a', 3, 0, 4, 2)]],
    [
      'stops under the item above',
      [item('a', 0, 0, 6, 4), item('b', 0, 10, 6, 2)],
      [item('a', 0, 0, 6, 4), item('b', 0, 4, 6, 2)],
    ],
    [
      'keeps columns, fills a gap beside',
      [item('a', 0, 0, 6, 8), item('b', 6, 5, 6, 2), item('c', 6, 9, 6, 2)],
      [item('a', 0, 0, 6, 8), item('b', 6, 0, 6, 2), item('c', 6, 2, 6, 2)],
    ],
    [
      'already compact layouts stay',
      [item('a', 0, 0, 12, 2), item('b', 0, 2, 4, 3), item('c', 4, 2, 8, 6)],
      [item('a', 0, 0, 12, 2), item('b', 0, 2, 4, 3), item('c', 4, 2, 8, 6)],
    ],
  ])('vertical compaction: %s', (_name, input, expected) => {
    const compacted = compactLayout(input);
    expect(compacted).toEqual(expected);
    expect(checkLayout(compacted)).toEqual([]);
  });

  it('places a new widget at column 0 below everything', () => {
    expect(layoutBottom([])).toBe(0);
    expect(placeAtBottom([], 6, 6)).toEqual({ x: 0, y: 0, w: 6, h: 6 });
    expect(placeAtBottom([item('a', 0, 0, 6, 4), item('b', 6, 2, 6, 5)], 6, 6)).toEqual({
      x: 0,
      y: 7,
      w: 6,
      h: 6,
    });
  });
});

const metric = (aggregation: string, field: string | null = FLD) => ({
  id: 'm1',
  aggregation,
  ...(field === null ? {} : { field }),
});

describe('widget configs (CONTRACTS §28.2)', () => {
  it.each([
    ['kpi count', 'kpi', { table_id: TBL, metrics: [metric('count', null)] }, true],
    [
      'kpi two metrics',
      'kpi',
      { table_id: TBL, metrics: [metric('count', null), { ...metric('sum'), id: 'm2' }] },
      false,
    ],
    ['count with a field', 'kpi', { table_id: TBL, metrics: [metric('count')] }, false],
    ['sum without field', 'kpi', { table_id: TBL, metrics: [metric('sum', null)] }, false],
    [
      'kpi compare',
      'kpi',
      {
        table_id: TBL,
        metrics: [metric('sum')],
        compare: { mode: 'previous_period', date_field: FLD2, range: 'month' },
      },
      true,
    ],
    ['bar', 'bar', { table_id: TBL, dimension: { field: FLD }, metrics: [metric('sum')] }, true],
    ['bar no metric', 'bar', { table_id: TBL, dimension: { field: FLD }, metrics: [] }, false],
    [
      'bar six metrics',
      'bar',
      {
        table_id: TBL,
        dimension: { field: FLD },
        metrics: Array.from({ length: 6 }, (_, index) => ({
          ...metric('sum'),
          id: `m${String(index)}`,
        })),
      },
      false,
    ],
    [
      'bar duplicate metric ids',
      'bar',
      { table_id: TBL, dimension: { field: FLD }, metrics: [metric('sum'), metric('avg')] },
      false,
    ],
    [
      'series with two metrics',
      'line',
      {
        table_id: TBL,
        dimension: { field: FLD },
        series_dimension: { field: FLD2 },
        metrics: [metric('sum'), { ...metric('avg'), id: 'm2' }],
      },
      false,
    ],
    [
      'series with one metric',
      'line',
      {
        table_id: TBL,
        dimension: { field: FLD },
        series_dimension: { field: FLD2 },
        metrics: [metric('sum')],
      },
      true,
    ],
    [
      'limit above 100',
      'pie',
      { table_id: TBL, dimension: { field: FLD }, metrics: [metric('sum')], limit: 101 },
      false,
    ],
    [
      'combo one metric',
      'combo',
      { table_id: TBL, dimension: { field: FLD }, metrics: [metric('sum')] },
      false,
    ],
    [
      'table pivot',
      'table',
      {
        table_id: TBL,
        table: {
          mode: 'pivot',
          dimension: { field: FLD },
          metrics: [metric('count', null)],
          limit: 500,
        },
      },
      true,
    ],
    ['table records', 'table', { table_id: TBL, table: { mode: 'records', fields: [FLD] } }, true],
    [
      'table rows above 500',
      'table',
      { table_id: TBL, table: { mode: 'records', fields: [FLD], limit: 501 } },
      false,
    ],
    ['text', 'text', { markdown: '# Hi' }, true],
    ['text too long', 'text', { markdown: 'x'.repeat(10_001) }, false],
    [
      'filter control',
      'filter_control',
      { table_id: TBL, field: FLD, control: 'date_range', default: { relative: 'this_month' } },
      true,
    ],
    [
      'filter control parent',
      'filter_control',
      { table_id: TBL, field: FLD, control: 'select', parent_control_id: WGT },
      true,
    ],
    ['unknown key', 'text', { markdown: '', script: 'x' }, false],
  ] as const)('%s', (_name, type, config, valid) => {
    expect(WIDGET_CONFIG_SCHEMAS[type].safeParse(config).success).toBe(valid);
  });

  it('fills defaults', () => {
    const parsed = WIDGET_CONFIG_SCHEMAS.pie.parse({
      table_id: TBL,
      dimension: { field: FLD },
      metrics: [metric('count', null)],
    });
    expect(parsed).toMatchObject({
      filter: null,
      filter_bindings: [],
      sort: 'metric_desc',
      limit: 20,
      group_others: true,
      dimension: { field: FLD, date_bucket: null, bucket_width: null },
      metrics: [{ id: 'm1', aggregation: 'count', field: null, label: null, color: null }],
      display: {},
    });
  });

  it('checks widget requests', () => {
    expect(createWidgetRequestSchema.safeParse({ type: 'text' }).success).toBe(true);
    expect(createWidgetRequestSchema.safeParse({ type: 'scatter' }).success).toBe(false);
    expect(
      createWidgetRequestSchema.safeParse({ type: 'text', layout: { x: 6, y: 0, w: 6, h: 4 } })
        .success,
    ).toBe(true);
    expect(updateWidgetRequestSchema.safeParse({}).success).toBe(false);
    expect(updateWidgetRequestSchema.safeParse({ title: 'T', version: 2 }).success).toBe(true);
  });
});

describe('dashboard requests (CONTRACTS §28.1)', () => {
  it('validates names, themes and global filters', () => {
    expect(createDashboardRequestSchema.parse({ name: '  Sales  ' })).toEqual({
      name: 'Sales',
      icon: null,
      description: null,
      theme: {},
      global_filters: [],
    });
    expect(createDashboardRequestSchema.safeParse({ name: '' }).success).toBe(false);
    expect(createDashboardRequestSchema.safeParse({ name: 'x'.repeat(101) }).success).toBe(false);
    expect(
      createDashboardRequestSchema.safeParse({ name: 'D', theme: { mode: 'dim' } }).success,
    ).toBe(false);
    expect(
      createDashboardRequestSchema.safeParse({ name: 'D', theme: { palette: ['#zzzzzz'] } })
        .success,
    ).toBe(false);
    expect(updateDashboardRequestSchema.safeParse({ version: 1 }).success).toBe(false);
    const filter = { id: 'g1', kind: 'date_range', targets: [{ table_id: TBL, field: FLD }] };
    expect(dashboardGlobalFiltersSchema.safeParse([filter]).success).toBe(true);
    expect(dashboardGlobalFiltersSchema.safeParse([filter, filter]).success).toBe(false);
    expect(
      dashboardGlobalFiltersSchema.safeParse([
        { ...filter, targets: [filter.targets[0], { table_id: TBL, field: FLD2 }] },
      ]).success,
    ).toBe(false);
  });

  it('takes the layout as a map of widget ids', () => {
    expect(
      updateDashboardLayoutRequestSchema.safeParse({
        layout: { [WGT]: { x: 0, y: 0, w: 6, h: 4 } },
      }).success,
    ).toBe(true);
    expect(
      updateDashboardLayoutRequestSchema.safeParse({
        layout: { [TBL]: { x: 0, y: 0, w: 6, h: 4 } },
      }).success,
    ).toBe(false);
  });

  it.each([
    ['3', true],
    ['"3"', true],
    ['W/"3"', true],
    ['abc', false],
    ['*', false],
  ])('If-Match %s', (value, valid) => {
    expect(dashboardIfMatchHeaderSchema.safeParse({ 'if-match': value }).success).toBe(valid);
  });

  it('lists its detail codes and events', () => {
    for (const code of DASHBOARD_DETAIL_CODES) expect(ERROR_DETAIL_CODES).toContain(code);
    expect(EVENT_TYPES).toEqual(
      expect.arrayContaining([
        'dashboard.created',
        'dashboard.updated',
        'dashboard.deleted',
        'dashboard.restored',
        'dashboard.duplicated',
        'dashboard.widget_created',
        'dashboard.widget_updated',
        'dashboard.widget_deleted',
      ]),
    );
  });
});
