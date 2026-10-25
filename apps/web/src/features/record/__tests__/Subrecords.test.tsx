import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { json, renderApp, stubApi } from '../../../../test/app-harness';
import {
  BASE_ID,
  baseDetail,
  fieldList,
  record,
  recordId,
  TABLE,
  TABLE_ID,
} from '../../../../test/records';
import { clearToasts } from '../../../lib/toast/toast';

import type { GridViewProps } from '../../../grid';

vi.mock('../../../grid/GridView', () => ({
  GridView: ({ rowCount, onViewportChange, label }: GridViewProps) => {
    useEffect(() => {
      onViewportChange({ firstRow: 0, lastRow: Math.min(rowCount, 20) - 1, dragging: false });
    }, [onViewportChange, rowCount]);
    return <section aria-label={label} data-testid="grid" />;
  },
}));

const NOW = '2026-09-26T00:00:00.000Z';
const PARENT = 'fld_Parent0000000001';
const PARENT_FIELD = {
  id: PARENT,
  table_id: TABLE_ID,
  name: 'Parent',
  type: 'parent',
  options: {},
  is_primary: false,
  required: false,
  unique_values: false,
  description: null,
  position: 9,
  created_at: NOW,
  updated_at: NOW,
};
const GRID_PATH = `/b/${BASE_ID}/t/${TABLE_ID}`;
const CHILD = record(3);
const OPEN = record(2, { [PARENT]: { id: recordId(1), title: 'Order 1' } });
const RECORDS = [record(1), OPEN, CHILD];

function serve() {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const log = (method: string, path: string) => (init?: RequestInit) => {
    calls.push({
      method,
      path,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null,
    });
  };
  const fields = fieldList();
  stubApi({
    signedIn: true,
    routes: {
      [`GET /bases/${BASE_ID}`]: () => json(baseDetail('admin')),
      [`GET /bases/${BASE_ID}/tables`]: () =>
        json({ items: [TABLE], total: 1, offset: 0, limit: 1000 }),
      [`GET /tables/${TABLE_ID}`]: () => json(TABLE),
      [`GET /tables/${TABLE_ID}/fields`]: () =>
        json({ ...fields, items: [...fields.items, PARENT_FIELD] }),
      [`POST /tables/${TABLE_ID}/records/query`]: () =>
        json({ records: RECORDS, total: RECORDS.length, offset: 0, limit: 200 }),
      [`GET /tables/${TABLE_ID}/records/${OPEN.id}`]: () => json(OPEN),
      [`GET /tables/${TABLE_ID}/records/${OPEN.id}/history`]: () =>
        json({ items: [], next_cursor: null }),
      [`GET /tables/${TABLE_ID}/records/${OPEN.id}/ancestors`]: () =>
        json({
          items: [
            { id: null, title: null, locked: true },
            { id: recordId(1), title: 'Order 1', locked: false },
          ],
        }),
      [`GET /tables/${TABLE_ID}/records/${OPEN.id}/children`]: () =>
        json({ records: [CHILD], total: 1, offset: 0, limit: 50 }),
      [`GET /tables/${TABLE_ID}/records/${CHILD.id}`]: () => json(CHILD),
      [`GET /tables/${TABLE_ID}/records/${CHILD.id}/history`]: () =>
        json({ items: [], next_cursor: null }),
      [`GET /tables/${TABLE_ID}/records/${CHILD.id}/children`]: () =>
        json({ records: [], total: 0, offset: 0, limit: 50 }),
      [`POST /tables/${TABLE_ID}/records`]: (init) => {
        log('POST', 'records')(init);
        return json({ records: [record(9)] });
      },
      [`DELETE /tables/${TABLE_ID}/records`]: (init) => {
        log('DELETE', 'records')(init);
        return json({ ids: [OPEN.id, CHILD.id] });
      },
    },
  });
  return calls;
}

beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('min-width: 1920px'),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })),
  );
  window.localStorage.clear();
});

afterEach(() => {
  clearToasts();
});

function panel() {
  // The first test loads every lazy route chunk (see `testTimeout`).
  return screen.findByRole('dialog', { name: /Order 2/u }, { timeout: 12_000 });
}

describe('Record panel sub-records (T417)', () => {
  it('shows the parent path (a locked ancestor as a placeholder) and the sub-records', async () => {
    serve();
    await renderApp(`${GRID_PATH}?record=${OPEN.id}`);
    const dialog = await panel();
    const path = await within(dialog).findByRole('navigation', { name: 'Parent records' });
    expect(within(path).getByText('A record you cannot see')).toBeInTheDocument();
    expect(within(path).getByRole('button', { name: 'Order 1' })).toBeVisible();
    const list = await within(dialog).findByRole('list', { name: /^Sub-records/u });
    expect(within(list).getByText('Order 3')).toBeVisible();
    expect(within(dialog).getByTestId('subrecords-count')).toHaveTextContent('1');
  });

  it('adds a sub-record under the record and opens it', async () => {
    const calls = serve();
    const { router } = await renderApp(`${GRID_PATH}?record=${OPEN.id}`);
    const dialog = await panel();
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Add sub-record' }));
    await waitFor(() => {
      expect(calls.find((call) => call.method === 'POST')?.body).toEqual({
        records: [{ fields: {}, parent_id: OPEN.id }],
      });
    });
    await waitFor(() => {
      expect(router.state.location.search).toContain(recordId(9));
    });
  });

  it('asks what happens to the sub-records when deleting a parent', async () => {
    const calls = serve();
    await renderApp(`${GRID_PATH}?record=${OPEN.id}`);
    const dialog = await panel();
    await within(dialog).findByRole('list', { name: /^Sub-records/u });
    await userEvent.click(within(dialog).getByTestId('record-panel-more'));
    await userEvent.click(await screen.findByRole('menuitem', { name: /Delete/u }));
    const choice = await screen.findByTestId('panel-delete-choice');
    await userEvent.click(within(choice).getByRole('radio', { name: /whole branch/u }));
    await userEvent.click(screen.getByRole('button', { name: 'Delete record' }));
    await waitFor(() => {
      expect(calls.find((call) => call.method === 'DELETE')?.body).toEqual({
        ids: [OPEN.id],
        children: 'delete',
      });
    });
  });
});
