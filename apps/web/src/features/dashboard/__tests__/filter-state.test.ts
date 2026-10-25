import { describe, expect, it } from 'vitest';

import {
  EMPTY_FILTER_STATE,
  decodeFilterState,
  defaultState,
  descendantsOf,
  encodeFilterState,
  hasActiveFilters,
  isActiveValue,
  liveFiltersFor,
  parentFiltersFor,
  pruneState,
  readValue,
  removeCross,
  setControlValue,
  setGlobalValue,
  toggleCross,
  type DashboardFilterState,
} from '../filters/filter-state';

import type { DashboardDto, WidgetDto } from '@cellhive/contracts';

const ORDERS = 'tbl_Orders0000000001';
const TICKETS = 'tbl_Tickets000000001';
const id = (name: string) => `wgt_${name.padEnd(16, '0')}` as const;

function widget(name: string, type: string, config: Record<string, unknown>): WidgetDto {
  return {
    id: id(name),
    dashboard_id: 'dsh_Board00000000001',
    type,
    title: name,
    config,
    layout: { x: 0, y: 0, w: 6, h: 4 },
    status: 'ok',
    broken_reason: null,
    created_at: '2026-10-25T00:00:00.000Z',
    updated_at: '2026-10-25T00:00:00.000Z',
  } as WidgetDto;
}

const province = widget('Province', 'filter_control', {
  table_id: ORDERS,
  field: 'fld_Province00000001',
  control: 'select',
  parent_control_id: null,
  default: null,
});
const district = widget('District', 'filter_control', {
  table_id: ORDERS,
  field: 'fld_District00000001',
  control: 'select',
  parent_control_id: id('Province'),
  default: null,
});
const ward = widget('Ward', 'filter_control', {
  table_id: ORDERS,
  field: 'fld_Ward000000000001',
  control: 'text',
  parent_control_id: id('District'),
  default: null,
});
const period = widget('Period', 'filter_control', {
  table_id: ORDERS,
  field: 'fld_Date000000000001',
  control: 'date_range',
  parent_control_id: null,
  default: { relative: 'last_30_days' },
});
const byStatus = widget('ByStatus', 'bar', {
  table_id: ORDERS,
  filter_bindings: [id('Province'), id('District')],
});
const kpi = widget('Kpi', 'kpi', { table_id: ORDERS, filter_bindings: [] });
const tickets = widget('Tickets', 'pie', { table_id: TICKETS, filter_bindings: [id('Province')] });
const notes = widget('Notes', 'text', { markdown: 'Hi' });

const dashboard: Pick<DashboardDto, 'global_filters' | 'widgets'> = {
  global_filters: [
    {
      id: 'when',
      label: 'When',
      kind: 'date_range',
      targets: [{ table_id: ORDERS, field: 'fld_Date000000000001' }],
    },
  ],
  widgets: [province, district, ward, period, byStatus, kpi, tickets, notes],
};

const state = (partial: Partial<DashboardFilterState>): DashboardFilterState => ({
  ...EMPTY_FILTER_STATE,
  ...partial,
});

describe('isActiveValue', () => {
  it.each([
    [null, false],
    [{ values: [] }, false],
    [{ values: ['a'] }, true],
    [{ range: { from: null, to: null } }, false],
    [{ range: { from: 1, to: null } }, true],
    [{ relative: 'today' as const }, true],
  ])('%j → %s', (value, expected) => {
    expect(isActiveValue(value)).toBe(expected);
  });
});

describe('liveFiltersFor', () => {
  const full = state({
    global: { when: { relative: 'this_month' } },
    controls: { [id('Province')]: { values: ['HN'] }, [id('Period')]: { relative: 'today' } },
    cross: [{ widgetId: id('ByStatus'), value: 'opt_Urgent0000000001', label: 'Urgent' }],
  });

  it.each([
    [
      'a bound widget of the same table gets global, its controls and the cross-filter',
      kpi,
      // KPI follows no control.
      {
        filters: [
          { source: 'global', id: 'when', value: { relative: 'this_month' } },
          { source: 'cross', widget_id: id('ByStatus'), value: 'opt_Urgent0000000001' },
        ],
        notApplied: [],
      },
    ],
    [
      'the source of the cross-filter is not filtered by it (self)',
      byStatus,
      {
        filters: [
          { source: 'global', id: 'when', value: { relative: 'this_month' } },
          { source: 'control', widget_id: id('Province'), value: { values: ['HN'] } },
        ],
        notApplied: [],
      },
    ],
    [
      'another table: global and cross do not apply (said), the bound control is sent',
      tickets,
      {
        filters: [{ source: 'control', widget_id: id('Province'), value: { values: ['HN'] } }],
        notApplied: [
          { source: 'global', id: 'when', reason: 'other_table' },
          { source: 'cross', id: id('ByStatus'), reason: 'other_table' },
        ],
      },
    ],
    ['a text widget has no filters', notes, { filters: [], notApplied: [] }],
  ])('%s', (_name, target, expected) => {
    expect(liveFiltersFor(target, full, dashboard)).toEqual(expected);
  });

  it('sends nothing for empty values (one query key with or without them)', () => {
    const empty = state({ controls: { [id('Province')]: { values: [] } } });
    expect(liveFiltersFor(byStatus, empty, dashboard)).toEqual({ filters: [], notApplied: [] });
  });
});

describe('cascading controls', () => {
  it('sends the values of every parent up the chain for options', () => {
    const current = state({
      controls: {
        [id('Province')]: { values: ['HN'] },
        [id('District')]: { values: ['Ba Dinh'] },
      },
    });
    expect(parentFiltersFor(ward, current, dashboard.widgets)).toEqual([
      { source: 'control', widget_id: id('District'), value: { values: ['Ba Dinh'] } },
      { source: 'control', widget_id: id('Province'), value: { values: ['HN'] } },
    ]);
    expect(parentFiltersFor(province, current, dashboard.widgets)).toEqual([]);
  });

  it('a new parent value clears its children and grandchildren', () => {
    expect(descendantsOf(id('Province'), dashboard.widgets)).toEqual([id('District'), id('Ward')]);
    const current = state({
      controls: {
        [id('Province')]: { values: ['HN'] },
        [id('District')]: { values: ['Ba Dinh'] },
        [id('Ward')]: { values: ['Kim Ma'] },
        [id('Period')]: { relative: 'today' },
      },
    });
    const next = setControlValue(current, id('Province'), { values: ['HCM'] }, dashboard.widgets);
    expect(next.controls).toEqual({
      [id('Province')]: { values: ['HCM'] },
      [id('Period')]: { relative: 'today' },
    });
  });
});

describe('state changes', () => {
  const urgent = { widgetId: id('ByStatus'), value: 'opt_Urgent0000000001', label: 'Urgent' };

  it('toggles a cross-filter: set, same group again removes, another group replaces', () => {
    const once = toggleCross(EMPTY_FILTER_STATE, urgent);
    expect(once.cross).toEqual([urgent]);
    expect(toggleCross(once, urgent).cross).toEqual([]);
    const other = { ...urgent, value: null, label: '(Empty)' };
    expect(toggleCross(once, other).cross).toEqual([other]);
    expect(removeCross(once, id('ByStatus')).cross).toEqual([]);
  });

  it('opens with the controls’ defaults, nothing else', () => {
    expect(defaultState(dashboard.widgets)).toEqual(
      state({ controls: { [id('Period')]: { relative: 'last_30_days' } } }),
    );
  });

  it('clearing a value drops it', () => {
    const set = setGlobalValue(EMPTY_FILTER_STATE, 'when', { relative: 'today' });
    expect(hasActiveFilters(set)).toBe(true);
    expect(setGlobalValue(set, 'when', null)).toEqual(EMPTY_FILTER_STATE);
  });

  it('prunes values of filters and widgets the dashboard no longer has', () => {
    const stale = state({
      global: { gone: { values: ['x'] }, when: { relative: 'today' } },
      controls: { [id('Deleted')]: { values: ['x'] } },
      cross: [{ widgetId: id('Notes'), value: 'x', label: 'x' }, urgent],
    });
    expect(pruneState(stale, dashboard)).toEqual(
      state({ global: { when: { relative: 'today' } }, cross: [urgent] }),
    );
    const clean = state({ cross: [urgent] });
    expect(pruneState(clean, dashboard)).toBe(clean);
  });
});

describe('URL encoding (?f=)', () => {
  it('round-trips the whole state, Vietnamese labels included', () => {
    const value = state({
      global: { when: { range: { from: '2026-01-01', to: null } } },
      controls: { [id('Province')]: { values: ['Hà Nội'] } },
      cross: [{ widgetId: id('ByStatus'), value: null, label: '(Trống)' }],
    });
    const encoded = encodeFilterState(value);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(decodeFilterState(encoded)).toEqual(value);
  });

  it.each([
    ['not base64 JSON', '%%%'],
    ['an array', btoa('[1,2]')],
    ['a number', btoa('42')],
  ])('reads %s as no filter', (_name, text) => {
    expect(decodeFilterState(text)).toEqual(EMPTY_FILTER_STATE);
  });

  it('drops malformed parts and keeps the rest', () => {
    const text = btoa(
      JSON.stringify({
        g: { when: { relative: 'someday' }, ok: { values: ['a', { bad: 1 }] }, 'bad id!': {} },
        c: { [id('Province')]: { range: { from: 'x', to: [] } } },
        x: [
          [id('ByStatus'), 'v', 'Label'],
          ['not-a-widget', 'v', 'L'],
          [id('ByStatus'), 'again', 'dup'],
          [id('Kpi'), { object: true }, 'L'],
        ],
      }),
    );
    expect(decodeFilterState(text)).toEqual(
      state({
        global: { ok: { values: ['a'] } },
        cross: [{ widgetId: id('ByStatus'), value: 'v', label: 'Label' }],
      }),
    );
  });

  it.each([
    [{ values: ['a', 2, true] }, { values: ['a', 2, true] }],
    [{ range: { from: 1, to: 5 } }, { range: { from: 1, to: 5 } }],
    [{ range: {} }, { range: { from: null, to: null } }],
    [{ relative: 'last_week' }, { relative: 'last_week' }],
    ['text', null],
    [[], null],
  ])('readValue(%j)', (raw, expected) => {
    expect(readValue(raw)).toEqual(expected);
  });
});
