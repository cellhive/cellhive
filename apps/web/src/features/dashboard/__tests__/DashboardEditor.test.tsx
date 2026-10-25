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
  TABLE,
  TABLE_ID,
} from '../../../../test/records';

import { metricColumn, widgetData } from './fixtures';

import type { AccessKind } from '../../../../test/records';

vi.mock('../charts/EChart', () => ({
  default: ({ label, testId }: { label: string; testId?: string }) => (
    <div role="img" aria-label={label} data-testid={testId} />
  ),
}));

const DASHBOARD_ID = 'dsh_Sales00000000001';
const id = (name: string) => `wgt_${name.padEnd(16, '0')}`;
const count = { id: 'm1', aggregation: 'count', field: null, label: null, color: null };
const byStatus = { field: FIELD.status, date_bucket: null, bucket_width: null };

/** A field the widget editor must never offer to group or aggregate by. */
const ATTACHMENT = fieldList()
  .items.filter((item) => item.id === FIELD.notes)
  .map((item) => ({
    ...item,
    id: 'fld_Files00000000001',
    name: 'Files',
    type: 'attachment',
    position: 6,
  }));

function widget(
  name: string,
  type: string,
  config: Record<string, unknown>,
  layout = { x: 0, y: 0, w: 6, h: 4 },
) {
  return {
    id: id(name),
    dashboard_id: DASHBOARD_ID,
    type,
    title: name,
    config:
      type === 'text'
        ? config
        : {
            table_id: TABLE_ID,
            filter: null,
            filter_bindings: [],
            description: null,
            display: {},
            ...config,
          },
    layout,
    status: 'ok',
    broken_reason: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

type Widget = ReturnType<typeof widget>;

function dashboard(widgets: Widget[], version: number) {
  return {
    id: DASHBOARD_ID,
    base_id: BASE_ID,
    name: 'Sales overview',
    icon: null,
    description: null,
    theme: {},
    global_filters: [],
    position: 0,
    version,
    created_by: null,
    widgets,
    created_at: NOW,
    updated_at: NOW,
  };
}

interface Call {
  readonly route: string;
  readonly body: unknown;
  readonly ifMatch: string | null;
}

function serve(widgets: Widget[], kind: AccessKind = 'admin', patchWidget?: () => Response) {
  let version = 4;
  const calls: Call[] = [];
  const record = (route: string, init: RequestInit | undefined) => {
    const headers = new Headers(init?.headers);
    calls.push({
      route,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
      ifMatch: headers.get('If-Match'),
    });
  };
  const routes: Record<string, (init: RequestInit | undefined) => Response> = {
    [`GET /bases/${BASE_ID}`]: () => json(baseDetail(kind)),
    [`GET /bases/${BASE_ID}/tables`]: () =>
      json({ items: [TABLE], total: 1, offset: 0, limit: 1000 }),
    [`GET /bases/${BASE_ID}/dashboards`]: () => json({ items: [] }),
    [`GET /dashboards/${DASHBOARD_ID}`]: () => json(dashboard(widgets, version)),
    [`GET /tables/${TABLE_ID}/fields`]: () => json(fieldList(ATTACHMENT)),
    [`PUT /dashboards/${DASHBOARD_ID}/layout`]: (init) => {
      record('PUT layout', init);
      version += 1;
      const body = JSON.parse(init?.body as string) as {
        layout: Record<string, { x: number; y: number; w: number; h: number }>;
      };
      return json(
        dashboard(
          widgets.map((item) => ({ ...item, layout: body.layout[item.id] ?? item.layout })),
          version,
        ),
      );
    },
  };
  for (const item of widgets) {
    routes[`POST /widgets/${item.id}/data`] = () =>
      json(widgetData({ columns: [metricColumn('m1')], rows: [[3]] }));
    routes[`PATCH /widgets/${item.id}`] = (init) => {
      record(`PATCH ${item.id}`, init);
      if (patchWidget !== undefined) return patchWidget();
      version += 1;
      const body = JSON.parse(init?.body as string) as { title: string; config: object };
      return json({ ...item, ...body, updated_at: new Date().toISOString() });
    };
  }
  stubApi({ signedIn: true, routes });
  return { calls };
}

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

const openSettings = async (name: string) => {
  const card = await screen.findByTestId(`widget-${id(name)}`);
  await userEvent.click(within(card).getByRole('button', { name: `Actions for ${name}` }));
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Settings' }));
  return screen.findByTestId('widget-panel');
};

describe('DashboardEditor (T812)', () => {
  it('is for base admins; others stay in view mode', async () => {
    serve([widget('Orders', 'kpi', { metrics: [count], compare: null })], 'reader');
    const { router } = await renderApp(`/b/${BASE_ID}/d/${DASHBOARD_ID}?edit=1`);
    expect(await screen.findByTestId('dashboard-title')).toHaveTextContent('Sales overview');
    await waitFor(() => {
      expect(router.state.location.search).toBe('');
    });
    expect(screen.queryByTestId('dashboard-edit-bar')).toBeNull();
    expect(screen.queryByTestId('dashboard-edit')).toBeNull();
  });

  it('opens from the Edit button with the edit bar, and is axe clean', async () => {
    serve([
      widget('Orders', 'kpi', { metrics: [count], compare: null }, { x: 0, y: 0, w: 4, h: 4 }),
      widget('Notes', 'text', { markdown: 'Hi' }, { x: 4, y: 0, w: 4, h: 4 }),
    ]);
    await renderApp(`/b/${BASE_ID}/d/${DASHBOARD_ID}`);
    await userEvent.click(await screen.findByTestId('dashboard-edit'));
    const bar = await screen.findByRole('toolbar', { name: 'Dashboard editing' });
    expect(within(bar).getByRole('button', { name: 'Add widget' })).toBeEnabled();
    expect(within(bar).getByRole('button', { name: 'Undo' })).toBeDisabled();
    expect(within(bar).getByRole('button', { name: 'Redo' })).toBeDisabled();
    expect(await screen.findByTestId(`widget-${id('Orders')}`)).toBeVisible();
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it.each([
    {
      type: 'kpi',
      config: { metrics: [count], compare: null },
      sections: ['Metric', 'Comparison and target'],
    },
    {
      type: 'bar',
      config: { dimension: byStatus, series_dimension: null, metrics: [count] },
      sections: ['Group by', 'Metrics', 'Sort and limit', 'Display'],
    },
    {
      type: 'line',
      config: { dimension: byStatus, series_dimension: null, metrics: [count] },
      sections: ['Group by', 'Metrics', 'Display'],
    },
    {
      type: 'pie',
      config: { dimension: byStatus, metrics: [count] },
      sections: ['Group by', 'Metrics'],
    },
    {
      type: 'combo',
      config: {
        dimension: byStatus,
        metrics: [
          { ...count, chart: 'bar', axis: 'left' },
          { ...count, id: 'm2', chart: 'line', axis: 'right' },
        ],
      },
      sections: ['Group by', 'Metrics'],
    },
    {
      type: 'table',
      config: { table: { mode: 'records', fields: [FIELD.title], sort: null, limit: 10 } },
      sections: ['Table'],
    },
    { type: 'text', config: { markdown: '**Hi**' }, sections: [] },
    {
      type: 'filter_control',
      config: {
        table_id: TABLE_ID,
        field: FIELD.status,
        control: 'select',
        parent_control_id: null,
        default: null,
      },
      sections: ['Filter'],
    },
  ])('shows the settings of a $type widget', async ({ type, config, sections }) => {
    serve([widget('W', type, config)]);
    await renderApp(`/b/${BASE_ID}/d/${DASHBOARD_ID}?edit=1`);
    const panel = await openSettings('W');
    expect(within(panel).getByRole('heading', { level: 2, name: 'Settings: W' })).toBeVisible();
    expect(within(panel).getByTestId('widget-title-input')).toHaveValue('W');
    for (const section of sections) {
      expect(await within(panel).findByRole('heading', { level: 3, name: section })).toBeVisible();
    }
    if (type === 'text') {
      expect(within(panel).getByTestId('markdown-input')).toHaveValue('**Hi**');
      await userEvent.click(within(panel).getByRole('button', { name: 'Preview' }));
      expect(within(panel).getByTestId('markdown-preview')).toHaveTextContent('Hi');
    }
    if (type === 'filter_control') {
      // Option fields only (Status), for an "Options" control.
      const field = within(panel).getByLabelText('Field');
      expect(
        within(field)
          .getAllByRole('option')
          .map((option) => option.textContent),
      ).toEqual(['Status']);
    }
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('offers only fields that fit: groupable dimensions, numbers for sums', async () => {
    serve([
      widget('Chart', 'bar', { dimension: byStatus, series_dimension: null, metrics: [count] }),
    ]);
    await renderApp(`/b/${BASE_ID}/d/${DASHBOARD_ID}?edit=1`);
    const panel = await openSettings('Chart');
    const dimension = await within(panel).findByTestId('dimension-field');
    const names = within(dimension)
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(names).toContain('Status');
    expect(names).not.toContain('Files');

    await userEvent.selectOptions(within(panel).getByTestId('metric-0-aggregation'), 'sum');
    const field = await within(panel).findByTestId('metric-0-field');
    expect(
      within(field)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Amount']);
  });

  it('saves settings after a pause and shows a 422 at the setting it names', async () => {
    const { calls } = serve(
      [widget('Chart', 'bar', { dimension: byStatus, series_dimension: null, metrics: [count] })],
      'admin',
      () =>
        new Response(
          JSON.stringify({
            type: 'https://cellhive.io/errors/VALIDATION_FAILED',
            title: 'VALIDATION_FAILED',
            status: 422,
            code: 'VALIDATION_FAILED',
            errors: [{ path: 'config.dimension.field', code: 'INVALID_DIMENSION', message: 'No' }],
          }),
          { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
        ),
    );
    await renderApp(`/b/${BASE_ID}/d/${DASHBOARD_ID}?edit=1`);
    const panel = await openSettings('Chart');
    await userEvent.selectOptions(await within(panel).findByTestId('dimension-field'), FIELD.owner);
    await waitFor(
      () => {
        expect(calls.some((call) => call.route === `PATCH ${id('Chart')}`)).toBe(true);
      },
      { timeout: 3000 },
    );
    const patch = calls.find((call) => call.route === `PATCH ${id('Chart')}`);
    expect(patch?.ifMatch).toBe('"4"');
    expect(
      (patch?.body as { config: { dimension: { field: string } } }).config.dimension.field,
    ).toBe(FIELD.owner);
    const dimension = within(panel).getByTestId('dimension-field');
    await waitFor(() => {
      expect(dimension).toHaveAttribute('aria-invalid', 'true');
    });
    expect(dimension).toHaveAccessibleDescription('This field cannot be used to group the chart.');
    expect(within(panel).getByTestId('widget-panel-state')).toHaveTextContent('Not saved');
  });

  it('moves and resizes a widget with the keyboard, then saves the layout', async () => {
    const { calls } = serve([
      widget('A', 'text', { markdown: 'a' }, { x: 0, y: 0, w: 6, h: 4 }),
      widget('B', 'text', { markdown: 'b' }, { x: 6, y: 0, w: 6, h: 4 }),
    ]);
    await renderApp(`/b/${BASE_ID}/d/${DASHBOARD_ID}?edit=1`);
    const card = await screen.findByTestId(`widget-${id('A')}`);
    await userEvent.click(within(card).getByRole('button', { name: 'Actions for A' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Move with the keyboard' }));
    const announcer = screen.getByTestId('dashboard-announcer');
    await waitFor(() => {
      expect(screen.getByTestId(`widget-${id('A')}`)).toHaveFocus();
    });
    expect(screen.getByTestId(`widget-${id('A')}`)).toHaveAccessibleDescription(
      'Arrow keys move it. Enter: done. Escape: cancel.',
    );
    // A is in the first column already.
    fireEvent.keyDown(screen.getByTestId(`widget-${id('A')}`), { key: 'ArrowLeft' });
    await waitFor(() => {
      expect(announcer).toHaveTextContent('It cannot move further that way.');
    });
    fireEvent.keyDown(screen.getByTestId(`widget-${id('A')}`), { key: 'ArrowRight' });
    await waitFor(() => {
      expect(announcer).toHaveTextContent('A: column 2, row 1');
    });
    // Escape goes back.
    fireEvent.keyDown(screen.getByTestId(`widget-${id('A')}`), { key: 'Escape' });
    await waitFor(() => {
      expect(announcer).toHaveTextContent('Move cancelled');
    });

    await userEvent.click(
      within(screen.getByTestId(`widget-${id('A')}`)).getByRole('button', {
        name: 'Actions for A',
      }),
    );
    await userEvent.click(
      await screen.findByRole('menuitem', { name: 'Resize with the keyboard' }),
    );
    await waitFor(() => {
      expect(screen.getByTestId(`widget-${id('A')}`)).toHaveFocus();
    });
    fireEvent.keyDown(screen.getByTestId(`widget-${id('A')}`), { key: 'ArrowDown' });
    await waitFor(() => {
      expect(announcer).toHaveTextContent('A: 6 columns wide, 5 rows high');
    });
    fireEvent.keyDown(screen.getByTestId(`widget-${id('A')}`), { key: 'Enter' });
    await waitFor(() => {
      expect(announcer).toHaveTextContent('Position kept');
    });
    expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled();

    // Saved once, 1 s after the change, with the version the screen showed.
    await waitFor(
      () => {
        expect(calls.filter((call) => call.route === 'PUT layout')).toHaveLength(1);
      },
      { timeout: 3000 },
    );
    const put = calls.find((call) => call.route === 'PUT layout');
    expect(put?.ifMatch).toBe('"4"');
    expect(put?.body).toEqual({
      layout: {
        [id('A')]: { x: 0, y: 0, w: 6, h: 5 },
        [id('B')]: { x: 6, y: 0, w: 6, h: 4 },
      },
    });

    // Undo puts the old size back (and saves it).
    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    });
    await waitFor(
      () => {
        expect(calls.filter((call) => call.route === 'PUT layout')).toHaveLength(2);
      },
      { timeout: 3000 },
    );
    expect(calls.at(-1)?.body).toMatchObject({ layout: { [id('A')]: { h: 4 } } });
  });
});
