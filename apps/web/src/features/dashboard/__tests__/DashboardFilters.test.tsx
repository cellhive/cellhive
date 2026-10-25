import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { json, renderApp, stubApi } from '../../../../test/app-harness';
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
import { encodeFilterState } from '../filters/filter-state';

import { cell, dimensionColumn, metricColumn, widgetData } from './fixtures';

import type { AccessKind } from '../../../../test/records';

// ECharts draws on a canvas jsdom does not have: the chart stands in as its text alternative.
vi.mock('../charts/EChart', () => ({
  default: ({ label, testId }: { label: string; testId?: string }) => (
    <div role="img" aria-label={label} data-testid={testId} />
  ),
}));

const DASHBOARD_ID = 'dsh_Sales00000000001';
const OTHER_TABLE = 'tbl_Tickets000000001';
const id = (name: string) => `wgt_${name.padEnd(16, '0')}` as const;

let order = 0;
function widget(name: string, type: string, config: Record<string, unknown>) {
  order += 1;
  return {
    id: id(name),
    dashboard_id: DASHBOARD_ID,
    type,
    title: name,
    config,
    layout: { x: (order % 2) * 6, y: Math.floor(order / 2) * 4, w: 6, h: 4 },
    status: 'ok',
    broken_reason: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

const count = { id: 'm1', aggregation: 'count', field: null, label: null, color: null };
const chart = (name: string, tableId = TABLE_ID, bindings: string[] = []) =>
  widget(name, 'bar', {
    table_id: tableId,
    filter: null,
    description: null,
    display: {},
    filter_bindings: bindings,
    dimension: { field: FIELD.status, date_bucket: null, bucket_width: null },
    series_dimension: null,
    metrics: [count],
  });
const control = (name: string, config: Record<string, unknown>) =>
  widget(name, 'filter_control', {
    table_id: TABLE_ID,
    parent_control_id: null,
    default: null,
    ...config,
  });

const statusRows = widgetData({
  columns: [dimensionColumn({ field_id: FIELD.status, field_type: 'select' }), metricColumn('m1')],
  rows: [
    [cell(OPTION.new, 'New'), 12],
    [cell(OPTION.done, 'Done'), 30],
  ],
});

interface Body {
  filters?: unknown[];
  search?: string;
  segment?: unknown;
}

function serve({
  kind = 'reader',
  widgets,
  download = true,
  globalFilters = [],
}: {
  kind?: AccessKind;
  widgets: ReturnType<typeof widget>[];
  download?: boolean;
  globalFilters?: unknown[];
}) {
  const bodies = new Map<string, Body[]>();
  const record = (key: string, init: RequestInit | undefined) => {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Body;
    bodies.set(key, [...(bodies.get(key) ?? []), body]);
    return body;
  };
  const base = baseDetail(kind);
  const routes: Record<string, (init: RequestInit | undefined) => Response> = {
    [`GET /bases/${BASE_ID}`]: () =>
      json({
        ...base,
        access: { ...base.access, base_rule: { ...base.access.base_rule, download } },
      }),
    [`GET /bases/${BASE_ID}/tables`]: () =>
      json({ items: [TABLE], total: 1, offset: 0, limit: 1000 }),
    [`GET /bases/${BASE_ID}/dashboards`]: () => json({ items: [] }),
    [`GET /dashboards/${DASHBOARD_ID}`]: () =>
      json({
        id: DASHBOARD_ID,
        base_id: BASE_ID,
        name: 'Sales overview',
        icon: null,
        description: null,
        theme: {},
        global_filters: globalFilters,
        position: 0,
        version: 1,
        created_by: null,
        widgets,
        created_at: NOW,
        updated_at: NOW,
      }),
    [`GET /tables/${TABLE_ID}`]: () => json(TABLE),
    [`GET /tables/${TABLE_ID}/fields`]: () => json(fieldList()),
  };
  for (const item of widgets) {
    routes[`POST /widgets/${item.id}/data`] = (init) => {
      record(`${item.title}/data`, init);
      return json(statusRows);
    };
    routes[`POST /widgets/${item.id}/options`] = (init) => {
      const body = record(`${item.title}/options`, init);
      const parent = body.filters?.length ?? 0;
      return json({
        status: 'ok',
        items:
          item.title === 'Province'
            ? [cell('HN', 'Hà Nội'), cell('HCM', 'Hồ Chí Minh')]
            : parent > 0
              ? [cell('BD', 'Ba Đình')]
              : [cell('BD', 'Ba Đình'), cell('Q1', 'Quận 1')],
        has_more: false,
        ignored_filters: [],
      });
    };
    routes[`POST /widgets/${item.id}/records`] = (init) => {
      record(`${item.title}/records`, init);
      return json({
        status: 'ok',
        records: [
          {
            id: 'rec_First00000000001',
            fields: { [FIELD.title]: 'First order', [FIELD.status]: OPTION.new },
            version: 1,
            created_at: NOW,
            updated_at: NOW,
          },
        ],
        offset: 0,
        limit: 50,
        total: 1,
        ignored_filters: [],
      });
    };
  }
  stubApi({ signedIn: true, routes });
  return { bodies };
}

const card = (name: string) => screen.findByTestId(`widget-${id(name)}`);
const path = (search = '') => `/b/${BASE_ID}/d/${DASHBOARD_ID}${search}`;

beforeEach(() => {
  order = 0;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

describe('Dashboard filters (T813)', () => {
  it('sends a control default on open and shows it', async () => {
    const { bodies } = serve({
      widgets: [
        control('Period', {
          field: FIELD.title,
          control: 'date_range',
          default: { relative: 'last_30_days' },
        }),
        chart('Orders', TABLE_ID, [id('Period')]),
      ],
    });
    await renderApp(path());
    const period = await screen.findByTestId(`filter-control-${id('Period')}`);
    expect(within(period).getByRole('combobox')).toHaveDisplayValue('Last 30 days');
    await waitFor(() => {
      expect(bodies.get('Orders/data')?.[0]?.filters).toEqual([
        { source: 'control', widget_id: id('Period'), value: { relative: 'last_30_days' } },
      ]);
    });
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('cascades: a district list follows the province, a new province clears it', async () => {
    const { bodies } = serve({
      widgets: [
        control('Province', { field: FIELD.title, control: 'select' }),
        control('District', {
          field: FIELD.notes,
          control: 'select',
          parent_control_id: id('Province'),
        }),
        chart('Orders', TABLE_ID, [id('Province'), id('District')]),
      ],
    });
    await renderApp(path());
    const user = userEvent.setup();
    const prefix = (name: string) => `filter-control-${id(name)}`;

    const pick = async (name: string, option: string) => {
      await user.click(screen.getByTestId(`${prefix(name)}-button`));
      const panel = await screen.findByTestId(`${prefix(name)}-panel`);
      await user.click(await within(panel).findByRole('checkbox', { name: option }));
      await user.keyboard('{Escape}');
      await waitFor(() => {
        expect(screen.queryByTestId(`${prefix(name)}-panel`)).toBeNull();
      });
    };

    await screen.findByTestId(`${prefix('Province')}-button`);
    await pick('Province', 'Hà Nội');
    await pick('District', 'Ba Đình');
    expect(bodies.get('District/options')?.at(-1)?.filters).toEqual([
      { source: 'control', widget_id: id('Province'), value: { values: ['HN'] } },
    ]);
    await waitFor(() => {
      expect(bodies.get('Orders/data')?.at(-1)?.filters).toHaveLength(2);
    });
    expect(screen.getByTestId(`${prefix('District')}-button`)).toHaveTextContent('Ba Đình');

    // Another province: the district picked under the old one goes.
    await pick('Province', 'Hồ Chí Minh');
    await waitFor(() => {
      expect(bodies.get('Orders/data')?.at(-1)?.filters).toEqual([
        { source: 'control', widget_id: id('Province'), value: { values: ['HN', 'HCM'] } },
      ]);
    });
    expect(screen.getByTestId(`${prefix('District')}-button`)).not.toHaveTextContent('Ba Đình');
  });

  it('applies a cross-filter from the link to the same table and says so elsewhere', async () => {
    const f = encodeFilterState({
      global: {},
      controls: {},
      cross: [{ widgetId: id('ByStatus'), value: OPTION.new, label: 'New' }],
    });
    const { bodies } = serve({
      widgets: [chart('ByStatus'), chart('Orders'), chart('Tickets', OTHER_TABLE)],
    });
    await renderApp(path(`?f=${f}`));
    const chip = await screen.findByTestId(`cross-chip-${id('ByStatus')}`);
    expect(chip).toHaveTextContent('Filtered by: New');

    await waitFor(() => {
      expect(bodies.get('Orders/data')?.[0]?.filters).toEqual([
        { source: 'cross', widget_id: id('ByStatus'), value: OPTION.new },
      ]);
    });
    // The source keeps every group; another table is not filtered — said in text.
    expect(bodies.get('ByStatus/data')?.[0]?.filters).toEqual([]);
    const notices = await within(await card('Tickets')).findByTestId('widget-filter-notices');
    expect(notices).toHaveTextContent(/does not apply: it filters another table/u);
    expect(await axeViolations(document.body)).toEqual([]);

    await userEvent.click(within(chip).getByRole('button', { name: /Remove the filter by New/u }));
    await waitFor(() => {
      expect(screen.queryByTestId(`cross-chip-${id('ByStatus')}`)).toBeNull();
    });
    await waitFor(() => {
      expect(bodies.get('Orders/data')?.at(-1)?.filters).toEqual([]);
    });
  });

  it('lists the records behind a widget and downloads its CSV', async () => {
    const { bodies } = serve({ widgets: [chart('Orders')] });
    await renderApp(path());
    const user = userEvent.setup();
    await user.click(
      await within(await card('Orders')).findByRole('button', { name: 'Actions for Orders' }),
    );
    await user.click(await screen.findByRole('menuitem', { name: 'View records' }));
    const drawer = await screen.findByTestId('drill-drawer');
    expect(await within(drawer).findByTestId('drill-records')).toHaveTextContent('First order');
    expect(within(drawer).getByTestId('drill-summary')).toHaveTextContent('1 record');
    expect(bodies.get('Orders/records')?.[0]).toMatchObject({ segment: null, offset: 0 });
    expect(await axeViolations(document.body)).toEqual([]);
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByTestId('drill-drawer')).toBeNull();
    });

    await user.click(
      within(await card('Orders')).getByRole('button', { name: 'Actions for Orders' }),
    );
    expect(await screen.findByRole('menuitem', { name: 'Download as PNG' })).toBeVisible();
    await user.click(screen.getByRole('menuitem', { name: 'Download as CSV' }));
    const frame = document.querySelector<HTMLIFrameElement>('iframe');
    // No live filter on the dashboard: none in the URL.
    expect(frame?.getAttribute('src')).toBe(
      `/api/v1/widgets/${id('Orders')}/export?format=csv&timezone=UTC`,
    );
  });

  it('offers no download without base_rule.download', async () => {
    serve({ widgets: [chart('Orders')], download: false });
    await renderApp(path());
    await userEvent.click(
      await within(await card('Orders')).findByRole('button', { name: 'Actions for Orders' }),
    );
    expect(await screen.findByRole('menuitem', { name: 'View records' })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: /Download/u })).toBeNull();
  });

  it('enters TV mode and leaves it with Escape', async () => {
    serve({ widgets: [chart('Orders')] });
    const { router } = await renderApp(path());
    await userEvent.click(await screen.findByTestId('dashboard-tv'));
    const bar = await screen.findByTestId('dashboard-tv-bar');
    expect(within(bar).getByRole('heading', { level: 1 })).toHaveTextContent('Sales overview');
    expect(router.state.location.search).toContain('tv=1');
    expect(screen.queryByRole('button', { name: 'Actions for Orders' })).toBeNull();
    expect(await axeViolations(document.body)).toEqual([]);
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    await waitFor(() => {
      expect(screen.queryByTestId('dashboard-tv-bar')).toBeNull();
    });
    expect(router.state.location.search).not.toContain('tv=1');
  });
});
