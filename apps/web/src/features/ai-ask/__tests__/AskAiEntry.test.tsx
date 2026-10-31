import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { json, ORG, renderApp, stubApi } from '../../../../test/app-harness';
import { axeViolations } from '../../../../test/axe';
import {
  BASE_ID,
  baseDetail,
  FIELD,
  fieldList,
  NOW,
  record,
  TABLE,
  TABLE_ID,
} from '../../../../test/records';
import { viewSessions } from '../../../lib/views/session';
import { clearSessions } from '../model/session';

import type { GridViewProps } from '../../../grid';

/**
 * T914: "Ask AI" through the real route (FRONTEND §20): the grid toolbar's
 * button only when AI is available in the organization; the panel and the
 * dashboard's widget renderer are lazy chunks the route composes; an answer
 * is drawn as a dashboard chart (its text alternative here — ECharts needs a
 * canvas) with "View as table"; Escape closes and the focus goes back.
 */

vi.mock('../../../grid/GridView', () => ({
  GridView: ({ rowCount, onViewportChange, label }: GridViewProps) => {
    useEffect(() => {
      onViewportChange({ firstRow: 0, lastRow: Math.min(rowCount, 20) - 1, dragging: false });
    }, [onViewportChange, rowCount]);
    return <ul aria-label={label} data-rows={rowCount} />;
  },
}));
vi.mock('../../dashboard/charts/EChart', () => ({
  default: ({ label, testId }: { label: string; testId?: string }) => (
    <div role="img" aria-label={label} data-testid={testId} />
  ),
}));

const ANSWER = {
  status: 'ok',
  interpretation: {
    metric: 'count',
    field: null,
    dimension: { id: FIELD.status, name: 'Status' },
    bucket: null,
    series: null,
    series_bucket: null,
    filter_logic: 'and',
    filters: [],
    compare: null,
  },
  widget: {
    type: 'bar',
    title: 'Orders per status',
    config: {
      table_id: TABLE_ID,
      filter: null,
      description: null,
      metrics: [{ id: 'm1', aggregation: 'count', field: null, label: null, color: null }],
      dimension: { field: FIELD.status, date_bucket: null, bucket_width: null },
      series_dimension: null,
      sort: 'metric_desc',
      limit: 20,
      group_others: false,
      display: {},
      filter_bindings: [],
    },
  },
  data: {
    status: 'ok',
    columns: [
      {
        key: 'dimension',
        role: 'dimension',
        field_id: FIELD.status,
        field_type: 'select',
        aggregation: null,
        date_bucket: null,
        bucket_width: null,
      },
      {
        key: 'm1',
        role: 'metric',
        field_id: null,
        field_type: null,
        aggregation: 'count',
        date_bucket: null,
        bucket_width: null,
      },
    ],
    rows: [
      [{ value: 'opt_New0000000000001', label: 'New' }, 2],
      [{ value: 'opt_Done000000000001', label: 'Done' }, 1],
    ],
    total: [3],
    computed_at: NOW,
    cache: 'miss',
    ignored_filters: [],
  },
  narrative: null,
};

function serve(ai: boolean) {
  return stubApi({
    signedIn: true,
    routes: {
      [`GET /orgs/${ORG.id}`]: () => json({ ...ORG, ai: { available: ai, record_data: false } }),
      [`GET /bases/${BASE_ID}`]: () => json(baseDetail('reader')),
      [`GET /bases/${BASE_ID}/tables`]: () =>
        json({ items: [TABLE], total: 1, offset: 0, limit: 1000 }),
      [`GET /tables/${TABLE_ID}`]: () => json(TABLE),
      [`GET /tables/${TABLE_ID}/fields`]: () => json(fieldList()),
      [`POST /tables/${TABLE_ID}/records/query`]: () =>
        json({ records: [record(0), record(1)], total: 2, offset: 0, limit: 200 }),
      [`POST /tables/${TABLE_ID}/ai/ask`]: () => json(ANSWER),
    },
  });
}

describe('"Ask AI" in the grid toolbar (T914)', () => {
  beforeEach(() => {
    viewSessions.reset();
    clearSessions();
    window.localStorage.clear();
  });

  it('renders nothing while AI is not available', async () => {
    serve(false);
    await renderApp(`/b/${BASE_ID}/t/${TABLE_ID}`);
    await screen.findByTestId('filter-button');
    expect(screen.queryByTestId('ask-ai-button')).toBeNull();
    expect(document.querySelector('svg.lucide-sparkles')).toBeNull();
  });

  it('opens the panel; an answer is drawn as a chart with "View as table"; Escape gives the focus back', async () => {
    const fetchMock = serve(true);
    await renderApp(`/b/${BASE_ID}/t/${TABLE_ID}`);
    const button = await screen.findByRole('button', { name: 'Ask AI' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    // A reader asks too (CONTRACTS §29.4: reading the table is enough).
    await userEvent.click(button);
    const panel = await screen.findByRole('dialog', { name: 'Ask AI' });
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(within(panel).getAllByTestId('ask-suggestion')).toHaveLength(3);
    const input = within(panel).getByRole('textbox', { name: 'Your question' });
    await waitFor(() => {
      expect(input).toHaveFocus();
    });
    await userEvent.type(input, 'Orders per status{Enter}');
    const card = await within(panel).findByTestId('ask-answer');
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/ai/ask'))).toHaveLength(1);
    const chart = await within(card).findByRole('img');
    expect(chart.getAttribute('aria-label')).toContain('Orders per status');
    expect(chart.getAttribute('aria-label')).toContain('New');
    await userEvent.click(within(card).getByRole('button', { name: 'View as table' }));
    const table = within(card).getByRole('table');
    expect(within(table).getByRole('rowheader', { name: 'New' })).toBeVisible();
    expect(within(table).getByRole('cell', { name: '2' })).toBeVisible();
    expect(await axeViolations(panel)).toEqual([]);

    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Ask AI' })).toBeNull();
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });
});
