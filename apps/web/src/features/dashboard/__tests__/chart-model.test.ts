import { describe, expect, it } from 'vitest';

import {
  buildChartModel,
  chartSlotOfOptionColor,
  toPercentStack,
  type BuildChartInput,
  type ChartSeries,
  type MetricConfig,
} from '../model/chart-model';
import { buildChartOption, type ChartOptionInput } from '../model/chart-option';
import { chartSummary, modelTable } from '../model/table';

import {
  cell,
  COLORS,
  dimensionColumn,
  metricColumn,
  seriesColumn,
  THEME,
  widgetData,
} from './fixtures';

const metric = (id: string, overrides: Partial<MetricConfig> = {}): MetricConfig => ({
  id,
  aggregation: 'count',
  field: null,
  label: null,
  color: null,
  ...overrides,
});

function input(overrides: Partial<BuildChartInput>): BuildChartInput {
  return {
    type: 'bar',
    metrics: [metric('m1')],
    data: widgetData(),
    colors: COLORS,
    label: (value) => (value.value === null ? '(Empty)' : (value.label ?? String(value.value))),
    otherLabel: 'Other',
    metricName: (item) => item.label ?? `Count ${item.id}`,
    ...overrides,
  };
}

const twoMetrics = widgetData({
  columns: [dimensionColumn(), metricColumn('m1'), metricColumn('m2', { aggregation: 'sum' })],
  rows: [
    [cell('a', 'Alpha'), 10, 100],
    [cell('b'), 5, null],
    [cell(null), 1, 7],
  ],
});

describe('buildChartModel (T811)', () => {
  it('builds categories in row order and a series per metric', () => {
    const model = buildChartModel(
      input({ data: twoMetrics, metrics: [metric('m1'), metric('m2', { label: 'Revenue' })] }),
    );
    expect(model.categories.map((item) => item.label)).toEqual(['Alpha', 'b', '(Empty)']);
    expect(model.series.map((item) => [item.name, item.values, item.color])).toEqual([
      ['Count m1', [10, 5, 1], '#c0'],
      ['Revenue', [100, null, 7], '#c1'],
    ]);
    expect(model.sliceColors).toEqual(['#c0', '#c1', '#c2']);
  });

  it('puts "Other" last with its own gray, for chart and pie', () => {
    const model = buildChartModel(
      input({
        type: 'pie',
        data: widgetData({
          columns: [dimensionColumn(), metricColumn('m1')],
          rows: [
            [cell('a'), 9],
            [cell('b'), 4],
          ],
          other: { groups: 3, rows: [[null, 6]] },
        }),
      }),
    );
    expect(model.categories.map((item) => [item.label, item.other])).toEqual([
      ['a', false],
      ['b', false],
      ['Other', true],
    ]);
    expect(model.series[0]?.values).toEqual([9, 4, 6]);
    expect(model.sliceColors).toEqual(['#c0', '#c1', '#other']);
  });

  it('splits one metric by the series dimension, "Other" rows included', () => {
    const model = buildChartModel(
      input({
        data: widgetData({
          columns: [dimensionColumn(), seriesColumn(), metricColumn('m1')],
          rows: [
            [cell('jan'), cell('north'), 3],
            [cell('jan'), cell('south'), 4],
            [cell('feb'), cell('north'), 5],
          ],
          other: { groups: 2, rows: [[null, cell('south'), 8]] },
        }),
      }),
    );
    expect(model.categories.map((item) => item.label)).toEqual(['jan', 'feb', 'Other']);
    expect(model.series.map((item) => [item.name, item.values])).toEqual([
      ['north', [3, 5, null]],
      ['south', [4, null, 8]],
    ]);
  });

  it('keeps colors on the entity: saved colors, metric colors, option hues', () => {
    const model = buildChartModel(
      input({
        data: widgetData({
          columns: [
            dimensionColumn({ field_type: 'select' }),
            seriesColumn({ field_type: 'select' }),
            metricColumn('m1'),
          ],
          rows: [
            [cell('opt_a', 'A'), cell('opt_x', 'X'), 1],
            [cell('opt_a', 'A'), cell('opt_y', 'Y'), 2],
          ],
        }),
        displayColors: { opt_y: '#saved' },
        optionSlot: (value) => (value === 'opt_x' ? 5 : value === 'opt_a' ? 3 : undefined),
      }),
    );
    expect(model.series.map((item) => item.color)).toEqual(['#c5', '#saved']);
    expect(model.sliceColors).toEqual(['#c3']);
    const own = buildChartModel(
      input({ data: twoMetrics, metrics: [metric('m1', { color: '#mine' }), metric('m2')] }),
    );
    expect(own.series.map((item) => item.color)).toEqual(['#mine', '#c1']);
  });

  it('puts combo metrics on their chart kind and axis', () => {
    const model = buildChartModel(
      input({
        type: 'combo',
        data: twoMetrics,
        metrics: [metric('m1'), metric('m2', { chart: 'line', axis: 'right' })],
      }),
    );
    expect(model.series.map((item) => [item.kind, item.axis])).toEqual([
      ['bar', 0],
      ['line', 1],
    ]);
  });
});

describe('toPercentStack', () => {
  const series = (key: string, values: (number | null)[]): ChartSeries => ({
    key,
    name: key,
    color: '#000',
    values,
    kind: 'bar',
    axis: 0,
    metricId: key,
  });

  it.each([
    [
      [
        [1, 0],
        [3, 0],
      ],
      [
        [25, 0],
        [75, 0],
      ],
    ],
    [
      [
        [2, null],
        [2, 5],
      ],
      [
        [50, null],
        [50, 100],
      ],
    ],
    [
      [
        [-1, 4],
        [3, 4],
      ],
      [
        [25, 50],
        [75, 50],
      ],
    ],
  ])('%j → %j', (values, expected) => {
    const result = toPercentStack(values.map((item, index) => series(`s${String(index)}`, item)));
    expect(result.map((item) => item.values)).toEqual(expected);
  });
});

describe('chartSlotOfOptionColor', () => {
  it.each([
    [1, 0, 0],
    [2, 0, 5],
    [6, 0, 1],
    [0, 0, 7],
    [9, 0, 0],
    [undefined, 3, 3],
  ])('option color %s (position %s) → slot %s', (color, position, slot) => {
    expect(chartSlotOfOptionColor(color, position)).toBe(slot);
  });
});

describe('modelTable / chartSummary', () => {
  it('lists every category with formatted values, "Other" marked', () => {
    const model = buildChartModel(
      input({
        data: widgetData({
          columns: [dimensionColumn(), metricColumn('m1')],
          rows: [[cell('a'), 1200]],
          other: { groups: 1, rows: [[null, 3]] },
        }),
      }),
    );
    const table = modelTable(model, 'Status', () => (value) => value.toLocaleString('en'));
    expect(table.columns.map((item) => item.label)).toEqual(['Status', 'Count m1']);
    expect(table.rows).toEqual([
      ['a', '1,200'],
      ['Other', '3'],
    ]);
    expect(table.otherRow).toBe(1);
    expect(chartSummary(table, 'Orders')).toEqual({
      heading: 'Orders',
      items: 'a: 1,200; Other: 3',
    });
  });
});

function option(overrides: Partial<ChartOptionInput>) {
  const model = buildChartModel(
    input({
      data: twoMetrics,
      metrics: [metric('m1'), metric('m2', { chart: 'line', axis: 'right' })],
      type: overrides.type ?? 'bar',
    }),
  );
  return buildChartOption({
    type: 'bar',
    model,
    display: {},
    theme: THEME,
    format: () => (value) => String(value),
    percent: (value) => `${String(value)}%`,
    reducedMotion: false,
    description: 'Bar chart: Orders',
    ...overrides,
  }) as Record<string, unknown> & {
    series: Record<string, unknown>[];
    yAxis: unknown;
    xAxis: unknown;
    aria: { label: { description: string }; decal: { show: boolean } };
    legend: { show: boolean };
  };
}

describe('buildChartOption', () => {
  it('describes the chart and turns animation off for reduced motion', () => {
    const result = option({ reducedMotion: true });
    expect(result.animation).toBe(false);
    expect(result.aria.label.description).toBe('Bar chart: Orders');
    // Two series: a legend and patterns, so color is never the only cue.
    expect(result.legend.show).toBe(true);
    expect(result.aria.decal.show).toBe(true);
  });

  it('rounds only the data end of grouped bars and stacks 100 % bars', () => {
    const grouped = option({});
    const style = grouped.series[0]?.['itemStyle'] as { borderRadius: unknown };
    expect(style.borderRadius).toEqual([4, 4, 0, 0]);
    const percent = option({ display: { stack: 'percent' } });
    expect(percent.series.map((item) => item['stack'])).toEqual(['total', 'total']);
    expect(percent.series[0]?.['data']).toEqual([(10 / 110) * 100, 100, (1 / 8) * 100]);
    const horizontal = option({ display: { orientation: 'horizontal' } });
    expect(Array.isArray(horizontal.xAxis)).toBe(true);
    expect((horizontal.yAxis as { type: string }).type).toBe('category');
  });

  it('keeps whole-number axes on whole ticks', () => {
    const counts = option({});
    expect((counts.yAxis as { minInterval?: number }[])[0]?.minInterval).toBe(1);
    const percent = option({ display: { stack: 'percent' } });
    expect((percent.yAxis as { minInterval?: number }[])[0]?.minInterval).toBeUndefined();
  });

  it('gives combo charts two value axes, the line on the right one', () => {
    const combo = option({ type: 'combo' });
    expect(combo.yAxis).toHaveLength(2);
    expect(combo.series.map((item) => [item['type'], item['yAxisIndex']])).toEqual([
      ['bar', 0],
      ['line', 1],
    ]);
  });

  it('draws pies with the slice colors and their shares', () => {
    const model = buildChartModel(
      input({
        type: 'pie',
        data: widgetData({
          columns: [dimensionColumn(), metricColumn('m1')],
          rows: [
            [cell('a'), 3],
            [cell('b'), 1],
          ],
        }),
      }),
    );
    const pie = buildChartOption({
      type: 'pie',
      model,
      display: { donut: true },
      theme: THEME,
      format: () => (value) => String(value),
      percent: (value) => `${String(value)}%`,
      reducedMotion: false,
      description: 'Pie',
    }) as {
      series: { radius: unknown; data: unknown; label: { formatter: (p: unknown) => string } }[];
    };
    const series = pie.series[0];
    expect(series?.radius).toEqual(['45%', '72%']);
    expect(series?.data).toEqual([
      { name: 'a', value: 3, itemStyle: { color: '#c0' } },
      { name: 'b', value: 1, itemStyle: { color: '#c1' } },
    ]);
    expect(series?.label.formatter({ dataIndex: 0 })).toBe('a: 75%');
  });

  it('builds tooltips as DOM text, never HTML', () => {
    const result = option({});
    const tooltip = result['tooltip'] as { formatter: (params: unknown) => HTMLElement };
    const node = tooltip.formatter([{ dataIndex: 0 }]);
    expect(node).toBeInstanceOf(HTMLElement);
    expect(node.textContent).toContain('Alpha');
    expect(node.querySelector('script')).toBeNull();
  });
});
