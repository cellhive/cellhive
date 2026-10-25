import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { json, problem, renderApp, stubApi } from '../../../../test/app-harness';
import { axeViolations } from '../../../../test/axe';
import { FIELD, OPTION, TABLE_ID } from '../../../../test/records';

import { cell, dimensionColumn, metricColumn, widgetData } from './fixtures';

// ECharts draws on a canvas jsdom does not have: the chart stands in as its text alternative.
vi.mock('../charts/EChart', () => ({
  default: ({ label, testId }: { label: string; testId?: string }) => (
    <div role="img" aria-label={label} data-testid={testId} />
  ),
}));

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-ABCDE';
const PATH = `/s/${TOKEN}`;
const API = `/shares/${TOKEN}`;
const DASHBOARD_ID = 'dsh_Sales00000000001';
const id = (name: string) => `wgt_${name.padEnd(16, '0')}`;
const count = { id: 'm1', aggregation: 'count', field: null, label: null, color: null };
const byStatus = { field: FIELD.status, date_bucket: null, bucket_width: null };

/** `GET /shares/:token/meta` of a dashboard link (CONTRACTS §16A). */
function dashboardLink(): Response {
  return new Response(
    JSON.stringify({
      type: 'https://cellhive.io/errors/NOT_FOUND',
      title: 'NOT_FOUND',
      status: 404,
      code: 'NOT_FOUND',
      request_id: 'req_0123456789ABCDEF',
      errors: [{ path: '', code: 'DASHBOARD_LINK', message: 'A dashboard link' }],
    }),
    { status: 404, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

function shared(settings: Record<string, unknown> = {}) {
  const widget = (
    name: string,
    type: string,
    config: Record<string, unknown> | null,
    status = 'ok',
    x = 0,
  ) => ({
    id: id(name),
    type,
    title: name,
    layout: { x, y: 0, w: 6, h: 4 },
    status,
    config:
      config === null
        ? null
        : { table_id: TABLE_ID, filter: null, description: null, display: {}, ...config },
  });
  return {
    target_type: 'dashboard',
    dashboard: {
      id: DASHBOARD_ID,
      name: 'Sales overview',
      description: 'Orders this quarter',
      icon: null,
      theme: {},
      global_filters: [],
    },
    widgets: [
      widget('Orders', 'kpi', { metrics: [count], compare: null }),
      widget(
        'ByStatus',
        'bar',
        { dimension: byStatus, series_dimension: null, metrics: [count] },
        'ok',
        6,
      ),
      widget('Secret', 'kpi', null, 'no_permission'),
    ],
    fields: [
      {
        id: FIELD.status,
        table_id: TABLE_ID,
        name: 'Status',
        type: 'select',
        options: {
          multiple: false,
          options: [
            { id: OPTION.new, name: 'New', color: 1 },
            { id: OPTION.done, name: 'Done', color: 2 },
          ],
        },
      },
    ],
    settings: {
      allow_filter_controls: true,
      refresh_seconds: 60,
      tv_mode: false,
      allow_export: false,
      ...settings,
    },
    expires_at: null,
    csrf_token: null,
  };
}

const card = (name: string) => screen.findByTestId(`widget-${id(name)}`);

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a dashboard opened through its link (T814)', () => {
  it('draws the widgets read-only from the link, never asking for unreadable ones', async () => {
    const secret = vi.fn(() => json(widgetData()));
    const fetchMock = stubApi({
      routes: {
        [`GET ${API}/meta`]: dashboardLink,
        [`GET ${API}/dashboard`]: () => json(shared()),
        [`POST ${API}/widgets/${id('Orders')}/data`]: () =>
          json(widgetData({ columns: [metricColumn('m1')], rows: [[42]] })),
        [`POST ${API}/widgets/${id('ByStatus')}/data`]: () =>
          json(
            widgetData({
              columns: [
                dimensionColumn({ field_id: FIELD.status, field_type: 'select' }),
                metricColumn('m1'),
              ],
              rows: [
                [cell(OPTION.new, 'New'), 12],
                [cell(OPTION.done, 'Done'), 30],
              ],
            }),
          ),
        [`POST ${API}/widgets/${id('Secret')}/data`]: secret,
      },
    });
    await renderApp(PATH);
    expect(await screen.findByTestId('dashboard-title')).toHaveTextContent('Sales overview');
    expect(await within(await card('Orders')).findByTestId('kpi-value')).toHaveTextContent('42');
    expect(await within(await card('ByStatus')).findByTestId('widget-chart')).toHaveAccessibleName(
      /New: 12; Done: 30/u,
    );
    expect(
      await within(await card('Secret')).findByText(
        "You don't have permission to see this widget's data",
      ),
    ).toBeVisible();
    expect(secret).not.toHaveBeenCalled();
    expect(screen.getByTestId('shared-refresh-every')).toHaveTextContent('Updates every minute');
    // Read-only: no editing, no TV mode without `tv_mode`, no records behind the numbers.
    expect(screen.queryByTestId('dashboard-edit')).toBeNull();
    expect(screen.queryByTestId('dashboard-tv')).toBeNull();
    // Without `allow_export` nothing is left in the widget menu: no menu.
    expect(screen.queryByTestId('widget-menu')).toBeNull();
    expect(await axeViolations(document.body)).toEqual([]);
    // No session asked for, no member API called.
    const paths = fetchMock.mock.calls.map(
      ([input]) => new URL(input, 'http://localhost').pathname,
    );
    expect(paths).not.toContain('/api/v1/me');
    expect(paths.some((path) => path.startsWith('/api/v1/widgets/'))).toBe(false);
  });

  it('offers TV mode with `tv_mode`', async () => {
    stubApi({
      routes: {
        [`GET ${API}/meta`]: dashboardLink,
        [`GET ${API}/dashboard`]: () => json(shared({ tv_mode: true, refresh_seconds: 30 })),
        [`POST ${API}/widgets/${id('Orders')}/data`]: () =>
          json(widgetData({ columns: [metricColumn('m1')], rows: [[1]] })),
        [`POST ${API}/widgets/${id('ByStatus')}/data`]: () => json(widgetData()),
      },
    });
    await renderApp(PATH);
    expect(await screen.findByTestId('shared-refresh-every')).toHaveTextContent(
      'Updates every 30 seconds',
    );
    expect(screen.getByTestId('dashboard-tv')).toBeVisible();
  });

  it('offers widget downloads with `allow_export`, never the records behind them', async () => {
    stubApi({
      routes: {
        [`GET ${API}/meta`]: dashboardLink,
        [`GET ${API}/dashboard`]: () => json(shared({ allow_export: true })),
        [`POST ${API}/widgets/${id('Orders')}/data`]: () =>
          json(widgetData({ columns: [metricColumn('m1')], rows: [[1]] })),
        [`POST ${API}/widgets/${id('ByStatus')}/data`]: () => json(widgetData()),
      },
    });
    await renderApp(PATH);
    await userEvent.click(await within(await card('Orders')).findByTestId('widget-menu'));
    expect(await screen.findByRole('menuitem', { name: /CSV/u })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: /records/u })).toBeNull();
  });

  it('shows the gone screen when the link is revoked while open', async () => {
    stubApi({
      routes: {
        [`GET ${API}/meta`]: dashboardLink,
        [`GET ${API}/dashboard`]: () => problem('SHARE_LINK_GONE', 410),
      },
    });
    await renderApp(PATH);
    await waitFor(async () => {
      expect(
        await screen.findByRole('heading', { name: 'This link is no longer available' }),
      ).toBeVisible();
    });
  });
});
