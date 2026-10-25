import { describe, expect, it, vi } from 'vitest';

import {
  changeFormatter,
  fieldNumberStyle,
  metricFormatter,
  percentFormatter,
} from '../model/format';
import { buildKpiModel, thresholdColor } from '../model/kpi';
import { bucketLabel, groupLabel, type GroupTexts } from '../model/labels';
import { readingOrder, singleColumnHeight, viewLayout } from '../model/layout';
import { Limiter } from '../model/limit';
import { RefreshGate, type Timers } from '../model/refresh-gate';
import { widgetsToRefresh } from '../view/use-dashboard-realtime';

import type { WidgetDto } from '@cellhive/contracts';

const TEXTS: GroupTexts = {
  empty: '(Empty)',
  other: 'Other',
  checked: 'Checked',
  unchecked: 'Unchecked',
  noAccess: '(No access)',
  unknownUser: 'Unknown user',
  weekOf: (date) => `Week of ${date}`,
  quarter: (quarter, year) => `Q${String(quarter)} ${String(year)}`,
};
const plain = (value: number) => value.toLocaleString('en');
const col = (overrides: Record<string, unknown> = {}) => ({
  field_type: null,
  date_bucket: null,
  bucket_width: null,
  ...overrides,
});

describe('groupLabel (T811)', () => {
  it.each([
    [{ value: null, label: null }, col(), '(Empty)'],
    [{ value: 'opt_1', label: 'Won' }, col({ field_type: 'select' }), 'Won'],
    [{ value: true, label: null }, col({ field_type: 'checkbox' }), 'Checked'],
    [{ value: false, label: null }, col({ field_type: 'checkbox' }), 'Unchecked'],
    [{ value: 'rec_1', label: null }, col({ field_type: 'link' }), '(No access)'],
    [{ value: 'usr_1', label: null }, col({ field_type: 'user' }), 'Unknown user'],
    [
      { value: 1000, label: null },
      col({ field_type: 'number', bucket_width: 500 }),
      '1,000 – 1,500',
    ],
    [{ value: 12, label: null }, col({ field_type: 'number' }), '12'],
    [{ value: '2026-04-01', label: null }, col({ date_bucket: 'quarter' }), 'Q2 2026'],
    [{ value: 'Plain', label: null }, col(), 'Plain'],
  ])('%j (%j) → %s', (cell, column, expected) => {
    expect(groupLabel(cell, column as never, 'en', TEXTS, plain)).toBe(expected);
  });

  it.each([
    ['2026-03-09', 'day', 'Mar 9, 2026'],
    ['2026-03-09', 'week', 'Week of Mar 9, 2026'],
    ['2026-03-01', 'month', 'Mar 2026'],
    ['2026-12-01', 'quarter', 'Q4 2026'],
    ['2026-01-01', 'year', '2026'],
    ['not a date', 'day', 'not a date'],
  ] as const)('bucket %s by %s → %s', (value, bucket, expected) => {
    expect(bucketLabel(value, bucket, 'en', TEXTS)).toBe(expected);
  });
});

describe('number formats', () => {
  it.each([
    [{ style: 'currency', currency: 'USD', decimals: 0 }, null, 'sum', 1234.5, '$1,235'],
    [{ style: 'percent', decimals: 1 }, null, 'avg', 0.256, '25.6%'],
    [{ compact: true }, null, 'sum', 1_500_000, '1.5M'],
    [null, { type: 'currency', precision: 2, currency_code: 'EUR' }, 'sum', 3, '€3.00'],
    [null, { type: 'currency', precision: 2, currency_code: 'EUR' }, 'count', 3, '3'],
    [null, null, 'avg', 2 / 3, '0.67'],
    [{ style: 'currency', currency: 'XYZ?' }, null, 'sum', 1, '1'],
  ] as const)('%j / %j / %s: %s → %s', (widget, field, aggregation, value, expected) => {
    expect(metricFormatter('en', widget, field as never, aggregation)(value)).toBe(expected);
  });

  it('reads field styles defensively', () => {
    expect(fieldNumberStyle({ style: { type: 'plain', precision: 1 } })).toEqual({
      type: 'plain',
      precision: 1,
    });
    expect(fieldNumberStyle({ style: { type: 'weird' } })).toBeNull();
    expect(fieldNumberStyle(null)).toBeNull();
  });

  it('formats shares and signed changes', () => {
    expect(percentFormatter('en')(12.34)).toBe('12.3%');
    expect(changeFormatter('en')(0.125)).toBe('+12.5%');
    expect(changeFormatter('en')(-0.5)).toBe('-50%');
    expect(changeFormatter('vi')(0)).toBe('0%');
  });
});

describe('buildKpiModel', () => {
  const thresholds = [
    { below: null, color: 'green' },
    { below: 50, color: 'red' },
    { below: 80, color: 'amber' },
  ];

  it.each([
    [10, 'red'],
    [50, 'amber'],
    [79.9, 'amber'],
    [80, 'green'],
    [null, null],
  ])('value %s → threshold %s', (value, color) => {
    expect(thresholdColor(value, thresholds)).toBe(color);
  });

  it('reads the value, the comparison and the progress', () => {
    const model = buildKpiModel(
      {
        rows: [[120]],
        compare: {
          previous: 100,
          change: 0.2,
          current_period: { from: '2026-10-01', to: '2026-11-01' },
          previous_period: { from: '2026-09-01', to: '2026-10-01' },
        },
      },
      { target: 200, thresholds },
    );
    expect(model).toEqual({
      value: 120,
      compare: { previous: 100, change: 0.2, direction: 'up' },
      color: 'green',
      progress: 0.6,
    });
    expect(buildKpiModel({ rows: [] }, { target: 0 })).toEqual({
      value: null,
      compare: null,
      color: null,
      progress: null,
    });
  });
});

function widget(
  id: string,
  layout: WidgetDto['layout'],
  tableId: string | null = 'tbl_A',
): WidgetDto {
  return {
    id,
    dashboard_id: 'dsh_1',
    type: tableId === null ? 'text' : 'kpi',
    title: id,
    config: tableId === null ? { markdown: '' } : { table_id: tableId },
    layout,
    status: 'ok',
    broken_reason: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
  } as unknown as WidgetDto;
}

describe('layout', () => {
  const widgets = [
    widget('c', { x: 0, y: 4, w: 12, h: 3 }),
    widget('b', { x: 6, y: 0, w: 6, h: 4 }),
    widget('a', { x: 0, y: 0, w: 6, h: 4 }),
  ];

  it('reads row by row, then column by column (the one-column order)', () => {
    expect(readingOrder(widgets).map((item) => item.id)).toEqual(['a', 'b', 'c']);
    expect(viewLayout(widgets)).toEqual([
      { i: 'a', x: 0, y: 0, w: 6, h: 4, static: true },
      { i: 'b', x: 6, y: 0, w: 6, h: 4, static: true },
      { i: 'c', x: 0, y: 4, w: 12, h: 3, static: true },
    ]);
  });

  it('keeps the grid rhythm in one column', () => {
    expect(singleColumnHeight(1)).toBe(48);
    expect(singleColumnHeight(4)).toBe(4 * 48 + 3 * 16);
  });
});

describe('widgetsToRefresh', () => {
  const widgets = [
    widget('a', { x: 0, y: 0, w: 6, h: 4 }, 'tbl_A'),
    widget('b', { x: 6, y: 0, w: 6, h: 4 }, 'tbl_B'),
    widget('t', { x: 0, y: 4, w: 6, h: 2 }, null),
  ];

  it('refetches the widgets of the changed tables', () => {
    expect(widgetsToRefresh(widgets, new Set(['tbl_B'])).map((item) => item.id)).toEqual(['b']);
  });

  it('refetches every data widget when none reads the table (links, lookups)', () => {
    expect(widgetsToRefresh(widgets, new Set(['tbl_C'])).map((item) => item.id)).toEqual([
      'a',
      'b',
    ]);
  });
});

describe('Limiter', () => {
  it('runs at most `max` tasks at once, in order', async () => {
    const limiter = new Limiter(2);
    const started: number[] = [];
    const releases: (() => void)[] = [];
    const tasks = [0, 1, 2, 3].map((index) =>
      limiter.run(
        () =>
          new Promise<number>((resolve) => {
            started.push(index);
            releases.push(() => {
              resolve(index);
            });
          }),
      ),
    );
    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    releases[0]?.();
    await tasks[0];
    await vi.waitFor(() => {
      expect(started).toEqual([0, 1, 2]);
    });
    releases[1]?.();
    releases[2]?.();
    await vi.waitFor(() => {
      expect(started).toEqual([0, 1, 2, 3]);
    });
    releases[3]?.();
    await expect(Promise.all(tasks)).resolves.toEqual([0, 1, 2, 3]);
    expect(limiter.active).toBe(0);
  });

  it('drops a waiting task whose signal aborts', async () => {
    const limiter = new Limiter(1);
    let release = () => {};
    const first = limiter.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const controller = new AbortController();
    const task = vi.fn(() => Promise.resolve());
    const second = limiter.run(task, controller.signal);
    controller.abort();
    await expect(second).rejects.toThrow();
    release();
    await first;
    expect(task).not.toHaveBeenCalled();
    expect(limiter.active).toBe(0);
  });
});

describe('RefreshGate', () => {
  function fakeTimers() {
    const pending: { callback: () => void; ms: number }[] = [];
    const timers: Timers = {
      setTimeout: (callback, ms) => {
        const entry = { callback, ms };
        pending.push(entry);
        return entry;
      },
      clearTimeout: (handle) => {
        const index = pending.indexOf(handle as (typeof pending)[number]);
        if (index !== -1) pending.splice(index, 1);
      },
    };
    const fire = () => {
      const next = pending.shift();
      next?.callback();
    };
    return { timers, fire, pending };
  }

  it('flushes the first hint at once, then gathers the window', () => {
    const { timers, fire, pending } = fakeTimers();
    const flushes: string[][] = [];
    const gate = new RefreshGate((tables) => flushes.push([...tables].sort()), 5000, timers);
    gate.push(['tbl_A']);
    expect(flushes).toEqual([['tbl_A']]);
    gate.push(['tbl_B']);
    gate.push(['tbl_A', 'tbl_B']);
    expect(flushes).toHaveLength(1);
    expect(pending[0]?.ms).toBe(5000);
    fire();
    expect(flushes).toEqual([['tbl_A'], ['tbl_A', 'tbl_B']]);
    // A quiet window closes the gate: the next hint is immediate again.
    fire();
    expect(pending).toHaveLength(0);
    gate.push(['tbl_C']);
    expect(flushes).toHaveLength(3);
    gate.dispose();
    expect(pending).toHaveLength(0);
  });
});
