import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { json, problem, renderApp, stubApi } from '../../../../test/app-harness';
import { axeViolations } from '../../../../test/axe';
import {
  BASE_ID,
  baseDetail,
  fieldList,
  FIELD,
  NOW,
  OPTION,
  TABLE,
  TABLE_ID,
} from '../../../../test/records';

import { cell, dimensionColumn, metricColumn, widgetData } from './fixtures';

import type { AccessKind } from '../../../../test/records';

// ECharts draws on a canvas jsdom does not have: the chart stands in as its text alternative.
vi.mock('../charts/EChart', () => ({
  default: ({ label, testId }: { label: string; testId?: string }) => (
    <div role="img" aria-label={label} data-testid={testId} />
  ),
}));

const DASHBOARD_ID = 'dsh_Sales00000000001';
const id = (name: string) => `wgt_${name.padEnd(16, '0')}`;

let order = 0;
function widget(
  name: string,
  type: string,
  config: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  order += 1;
  return {
    id: id(name),
    dashboard_id: DASHBOARD_ID,
    type,
    title: name,
    config: { table_id: TABLE_ID, filter: null, description: null, display: {}, ...config },
    layout: { x: (order % 2) * 6, y: Math.floor(order / 2) * 4, w: 6, h: 4 },
    status: 'ok',
    broken_reason: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

const count = { id: 'm1', aggregation: 'count', field: null, label: null, color: null };
const byStatus = { field: FIELD.status, date_bucket: null, bucket_width: null };

function dashboard(widgets: ReturnType<typeof widget>[]) {
  return {
    id: DASHBOARD_ID,
    base_id: BASE_ID,
    name: 'Sales overview',
    icon: null,
    description: 'Orders this quarter',
    theme: {},
    global_filters: [],
    position: 0,
    version: 1,
    created_by: null,
    widgets,
    created_at: NOW,
    updated_at: NOW,
  };
}

const statusRows = widgetData({
  columns: [dimensionColumn({ field_id: FIELD.status, field_type: 'select' }), metricColumn('m1')],
  rows: [
    [cell(OPTION.new, 'New'), 12],
    [cell(OPTION.done, 'Done'), 30],
  ],
});

function serve({
  kind = 'admin',
  widgets,
  data,
}: {
  kind?: AccessKind;
  widgets: ReturnType<typeof widget>[];
  data: Record<string, () => Response>;
}) {
  const calls = new Map<string, number>();
  const routes: Record<string, (init: RequestInit | undefined) => Response> = {
    [`GET /bases/${BASE_ID}`]: () => json(baseDetail(kind)),
    [`GET /bases/${BASE_ID}/tables`]: () =>
      json({ items: [TABLE], total: 1, offset: 0, limit: 1000 }),
    [`GET /bases/${BASE_ID}/dashboards`]: () =>
      json({
        items: [
          {
            id: DASHBOARD_ID,
            base_id: BASE_ID,
            name: 'Sales overview',
            icon: null,
            description: null,
            position: 0,
            version: 1,
            widget_count: widgets.length,
            created_at: NOW,
            updated_at: NOW,
          },
        ],
      }),
    [`GET /dashboards/${DASHBOARD_ID}`]: () => json(dashboard(widgets)),
    [`GET /tables/${TABLE_ID}/fields`]: () => json(fieldList()),
  };
  for (const [name, answer] of Object.entries(data)) {
    routes[`POST /widgets/${id(name)}/data`] = () => {
      calls.set(name, (calls.get(name) ?? 0) + 1);
      return answer();
    };
  }
  stubApi({ signedIn: true, routes });
  return { calls };
}

const card = (name: string) => screen.findByTestId(`widget-${id(name)}`);
const stateOf = async (name: string) => within(await card(name)).findByTestId('widget-state');

beforeEach(() => {
  order = 0;
  // jsdom has no ResizeObserver (the grid measures its width with it).
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

describe('DashboardPage (T811)', () => {
  it('draws each widget from its data, with a table view for charts', async () => {
    serve({
      widgets: [
        widget('Orders', 'kpi', { metrics: [count], compare: null }),
        widget('ByStatus', 'bar', {
          dimension: byStatus,
          series_dimension: null,
          metrics: [count],
        }),
        widget('Share', 'pie', { dimension: byStatus, metrics: [count] }),
        widget('Pivot', 'table', {
          table: { mode: 'pivot', dimension: byStatus, metrics: [count] },
        }),
        widget(
          'Notes',
          'text',
          { markdown: '**Read me**' },
          { config: { markdown: '**Read me**' } },
        ),
      ],
      data: {
        Orders: () => json(widgetData({ columns: [metricColumn('m1')], rows: [[42]] })),
        ByStatus: () => json(statusRows),
        Share: () => json(statusRows),
        Pivot: () => json(statusRows),
      },
    });
    await renderApp(`/b/${BASE_ID}/d/${DASHBOARD_ID}`);
    expect(await screen.findByTestId('dashboard-title')).toHaveTextContent('Sales overview');
    expect(screen.getByText('Orders this quarter')).toBeVisible();

    expect(await within(await card('Orders')).findByTestId('kpi-value')).toHaveTextContent('42');

    const chart = await within(await card('ByStatus')).findByTestId('widget-chart');
    expect(chart).toHaveAccessibleName(/Bar chart: ByStatus, 2 groups\. New: 12; Done: 30/u);
    await userEvent.click(
      within(await card('ByStatus')).getByRole('button', { name: 'View as table' }),
    );
    const table = await within(await card('ByStatus')).findByTestId('widget-data-table');
    expect(within(table).getByRole('columnheader', { name: 'Status' })).toBeVisible();
    expect(within(table).getByRole('rowheader', { name: 'Done' })).toBeVisible();
    expect(
      within(await card('ByStatus')).getByRole('button', { name: 'View as table' }),
    ).toHaveAttribute('aria-pressed', 'true');

    expect(await within(await card('Share')).findByTestId('widget-chart')).toHaveAccessibleName(
      /Pie chart/u,
    );
    const pivot = await within(await card('Pivot')).findByTestId('widget-pivot');
    expect(within(pivot).getByRole('cell', { name: '30' })).toBeVisible();
    expect(within(await card('Notes')).getByText('Read me')).toBeVisible();

    // The DOM order is the reading order (row, then column).
    const titles = within(screen.getByTestId('dashboard-grid'))
      .getAllByRole('heading', { level: 2 })
      .map((item) => item.textContent);
    expect(titles).toEqual(['Orders', 'ByStatus', 'Share', 'Pivot', 'Notes']);
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('shows empty, no permission, broken, failed and timed out widgets', async () => {
    let failures = 1;
    const { calls } = serve({
      kind: 'reader',
      widgets: [
        widget('Empty', 'pie', {
          dimension: byStatus,
          metrics: [count],
          display: { empty_text: 'Nothing sold yet' },
        }),
        widget('Hidden', 'line', { dimension: byStatus, metrics: [count] }),
        widget(
          'Broken',
          'bar',
          { dimension: byStatus, metrics: [count] },
          { status: 'broken', broken_reason: 'field_deleted' },
        ),
        widget('Flaky', 'kpi', { metrics: [count] }),
        widget('Slow', 'combo', { dimension: byStatus, metrics: [count] }),
      ],
      data: {
        Empty: () => json(widgetData({ status: 'empty' })),
        Hidden: () => json(widgetData({ status: 'no_permission' })),
        Flaky: () => {
          if (failures > 0) {
            failures -= 1;
            return problem('VALIDATION_FAILED', 422);
          }
          return json(widgetData({ columns: [metricColumn('m1')], rows: [[7]] }));
        },
        Slow: () => problem('QUERY_TIMEOUT', 504),
      },
    });
    await renderApp(`/b/${BASE_ID}/d/${DASHBOARD_ID}`);

    const empty = await stateOf('Empty');
    expect(empty).toHaveAttribute('data-state', 'empty');
    expect(empty).toHaveTextContent('Nothing sold yet');

    expect(await stateOf('Hidden')).toHaveTextContent(
      "You don't have permission to see this widget's data",
    );

    const broken = await stateOf('Broken');
    expect(broken).toHaveTextContent('This widget needs to be fixed');
    expect(broken).toHaveTextContent('Ask a base admin to fix it.');
    expect(calls.has('Broken')).toBe(false);

    const slow = await stateOf('Slow');
    expect(slow).toHaveTextContent('This widget took too long to load');
    // A timeout is not retried by itself: one request until "Try again".
    expect(calls.get('Slow')).toBe(1);
    await userEvent.click(within(slow).getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(calls.get('Slow')).toBe(2);
    });

    const flaky = await stateOf('Flaky');
    expect(flaky).toHaveTextContent('This widget could not load');
    await userEvent.click(within(flaky).getByRole('button', { name: 'Try again' }));
    expect(await within(await card('Flaky')).findByTestId('kpi-value')).toHaveTextContent('7');
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('is one column in reading order below 1024 px', async () => {
    vi.stubGlobal(
      'matchMedia',
      (query: string) =>
        ({
          matches: false,
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList,
    );
    serve({
      widgets: [
        widget(
          'First',
          'text',
          {},
          { config: { markdown: 'one' }, layout: { x: 6, y: 0, w: 6, h: 3 } },
        ),
        widget(
          'Second',
          'text',
          {},
          { config: { markdown: 'two' }, layout: { x: 0, y: 2, w: 6, h: 2 } },
        ),
      ],
      data: {},
    });
    await renderApp(`/b/${BASE_ID}/d/${DASHBOARD_ID}`);
    const grid = await screen.findByTestId('dashboard-grid');
    expect(grid).toHaveAttribute('data-layout', 'column');
    const items = within(grid).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual(['Firstone', 'Secondtwo']);
    expect(items[0]?.style.height).toBe(`${String(3 * 48 + 2 * 16)}px`);
  });

  it('says so when the dashboard has no widgets', async () => {
    serve({ widgets: [], data: {} });
    await renderApp(`/b/${BASE_ID}/d/${DASHBOARD_ID}`);
    expect(await screen.findByTestId('dashboard-empty')).toHaveTextContent('No widgets yet');
  });

  it('is the 404 screen for a dashboard the caller cannot read', async () => {
    stubApi({
      signedIn: true,
      routes: {
        [`GET /bases/${BASE_ID}`]: () => json(baseDetail('reader')),
        [`GET /bases/${BASE_ID}/tables`]: () =>
          json({ items: [TABLE], total: 1, offset: 0, limit: 1000 }),
        [`GET /bases/${BASE_ID}/dashboards`]: () => json({ items: [] }),
      },
    });
    await renderApp(`/b/${BASE_ID}/d/${DASHBOARD_ID}`);
    expect(await screen.findByText('Page not found')).toBeVisible();
  });
});
