import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { json, problem, renderApp, stubApi } from '../../../../test/app-harness';
import { axeViolations } from '../../../../test/axe';
import {
  BASE_ID,
  baseDetail,
  FIELD,
  fieldList,
  record,
  recordId,
  TABLE,
  TABLE_ID,
  type AccessKind,
} from '../../../../test/records';
import { clearToasts } from '../../../lib/toast/toast';

import type { GridViewProps } from '../../../grid';

// The canvas grid needs a real browser (E2E); here it is a list with the hooks the panel uses.
vi.mock('../../../grid/GridView', () => ({
  GridView: ({ rowCount, getRecord, onViewportChange, label, fields, hooks }: GridViewProps) => {
    useEffect(() => {
      onViewportChange({ firstRow: 0, lastRow: Math.min(rowCount, 20) - 1, dragging: false });
    }, [onViewportChange, rowCount]);
    const first = getRecord(0);
    return (
      <section aria-label={label} data-testid="grid" data-rows={rowCount}>
        <button
          type="button"
          onClick={() => {
            if (first !== undefined) hooks?.recordDetail?.onOpenRecord(first.id);
          }}
        >
          expand row 1
        </button>
        <button
          type="button"
          onClick={() => {
            const field = fields[1];
            if (first !== undefined && field !== undefined) {
              hooks?.recordDetail?.onCellMenu?.(
                { recordId: first.id, fieldId: field.field.id },
                { x: 10, y: 10, width: 100, height: 30 },
              );
            }
          }}
        >
          cell menu row 1
        </button>
      </section>
    );
  },
}));

const GRID_PATH = `/b/${BASE_ID}/t/${TABLE_ID}`;
const RECORDS = [record(1), record(2, { [FIELD.status]: 'Done' }), record(3)];

interface Server {
  kind: AccessKind;
  records?: typeof RECORDS;
  getRecord?: (id: string) => Response;
  patch?: (body: unknown) => Response;
}

function serve(server: Server) {
  const patches: unknown[] = [];
  const records = server.records ?? RECORDS;
  const fetchMock = stubApi({
    signedIn: true,
    routes: {
      [`GET /bases/${BASE_ID}`]: () => json(baseDetail(server.kind)),
      [`GET /bases/${BASE_ID}/tables`]: () =>
        json({ items: [TABLE], total: 1, offset: 0, limit: 1000 }),
      [`GET /tables/${TABLE_ID}`]: () => json(TABLE),
      [`GET /tables/${TABLE_ID}/fields`]: () => json(fieldList()),
      [`POST /tables/${TABLE_ID}/records/query`]: () =>
        json({ records, total: records.length, offset: 0, limit: 200 }),
      ...Object.fromEntries(
        records.map((item) => [
          `GET /tables/${TABLE_ID}/records/${item.id}`,
          () => server.getRecord?.(item.id) ?? json(item),
        ]),
      ),
      ...Object.fromEntries(
        records.map((item) => [
          `GET /tables/${TABLE_ID}/records/${item.id}/history`,
          () => json({ items: [], next_cursor: null }),
        ]),
      ),
      [`PATCH /tables/${TABLE_ID}/records`]: (init) => {
        const body = JSON.parse(init?.body as string) as {
          records: { id: string; version: number; fields: Record<string, unknown> }[];
        };
        patches.push(body);
        const answer = server.patch?.(body);
        if (answer !== undefined) return answer;
        const [change] = body.records;
        const current = records.find((item) => item.id === change?.id) ?? RECORDS[0];
        return json({
          records: [
            {
              ...current,
              version: (change?.version ?? 1) + 1,
              fields: { ...current?.fields, ...change?.fields },
            },
          ],
        });
      },
    },
  });
  return { fetchMock, patches };
}

function panel() {
  // The first test loads every lazy route chunk (see `testTimeout`): more than the 1 s default.
  return screen.findByRole('dialog', { name: /Order/u }, { timeout: 12_000 });
}

beforeEach(() => {
  // History column next to the fields (wide screen) is the default of these tests.
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

describe('RecordPanel (T206)', () => {
  it('opens from ?record= (deep link) with the fields in order; no axe violations', async () => {
    serve({ kind: 'admin' });
    const { router } = await renderApp(`${GRID_PATH}?record=${recordId(2)}`);
    const dialog = await panel();
    expect(within(dialog).getByRole('heading', { level: 2, name: 'Order 2' })).toBeVisible();
    // The auto number is the record code above the title.
    expect(within(dialog).getAllByText('OR-0002')).toHaveLength(2);
    const groups = within(dialog).getAllByRole('group');
    const names = groups.map(
      (group) => document.getElementById(group.getAttribute('aria-labelledby') ?? '')?.textContent,
    );
    expect(names).toEqual(['Title', 'Status', 'Amount', 'Owner', 'Code', 'Notes']);
    expect(
      within(within(dialog).getByRole('group', { name: 'Status' })).getByText('Done'),
    ).toBeVisible();
    // History next to the fields on a wide screen.
    expect(within(dialog).getByRole('heading', { level: 3, name: 'History' })).toBeVisible();
    expect(await within(dialog).findByText('No changes yet.')).toBeVisible();
    expect(router.state.location.search).toBe(`?record=${recordId(2)}`);
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('follows the design board: meta line, copy link, plain labels, backdrop (T320b)', async () => {
    serve({ kind: 'admin' });
    const { router } = await renderApp(`${GRID_PATH}?record=${recordId(2)}`);
    const dialog = await panel();
    // "<table> · <code> · Created <date>" above the title.
    const meta = within(dialog).getByTestId('record-panel-meta');
    expect(meta).toHaveTextContent(new RegExp(`^${TABLE.name}·OR-0002·Created .+$`, 'u'));
    // A text button, still named for what it copies.
    const copy = within(dialog).getByRole('button', { name: 'Copy link to record' });
    expect(copy).toHaveTextContent('Copy link');
    // Field names without type icons, one history button a field (shown on hover/focus).
    const status = within(dialog).getByRole('group', { name: 'Status' });
    const label = document.getElementById(status.getAttribute('aria-labelledby') ?? '');
    expect(label?.parentElement?.querySelector('svg')).toBeNull();
    const history = within(status).getByRole('button', { name: 'History of Status' });
    expect(history).toHaveClass('sm:opacity-0', 'sm:group-hover:opacity-100');
    // Full height above the sidebar, with a dim backdrop that closes the panel.
    expect(dialog).toHaveClass('top-0', 'z-50');
    await userEvent.setup().click(screen.getByTestId('record-panel-backdrop'));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(router.state.location.search).toBe('');
  });

  it('opens from the grid, moves with ↑/↓ and closes with Escape', async () => {
    serve({ kind: 'admin' });
    const { router } = await renderApp(GRID_PATH);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'expand row 1' }));
    const dialog = await panel();
    expect(within(dialog).getByRole('heading', { level: 2, name: 'Order 1' })).toBeVisible();
    expect(router.state.location.search).toBe(`?record=${recordId(1)}`);
    expect(dialog).toHaveFocus();
    expect(within(dialog).getByRole('button', { name: 'Previous record' })).toBeDisabled();

    await user.keyboard('{ArrowDown}');
    await waitFor(() => {
      expect(router.state.location.search).toBe(`?record=${recordId(2)}`);
    });
    expect(await screen.findByRole('heading', { level: 2, name: 'Order 2' })).toBeVisible();
    await user.keyboard('{ArrowUp}');
    await waitFor(() => {
      expect(router.state.location.search).toBe(`?record=${recordId(1)}`);
    });

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(router.state.location.search).toBe('');
  });

  it('edits a field through the edit flow: version sent, value shown', async () => {
    const { patches } = serve({ kind: 'admin' });
    await renderApp(`${GRID_PATH}?record=${recordId(1)}`);
    const dialog = await panel();
    const user = userEvent.setup();
    const notes = within(dialog).getByRole('group', { name: 'Notes' });
    await user.click(within(notes).getByRole('button', { name: /^Notes/u }));
    const input = within(notes).getByRole('textbox', { name: 'Notes' });
    expect(input).toHaveFocus();
    await user.type(input, 'Call back on Monday');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(patches).toEqual([
        {
          records: [
            { id: recordId(1), version: 1, fields: { [FIELD.notes]: 'Call back on Monday' } },
          ],
        },
      ]);
    });
    expect(await within(notes).findByText('Call back on Monday')).toBeVisible();
    expect(within(notes).getByRole('button', { name: /^Notes/u })).toHaveFocus();
  });

  it('an invalid value stays in the editor and sends nothing', async () => {
    const { patches } = serve({ kind: 'admin' });
    await renderApp(`${GRID_PATH}?record=${recordId(1)}`);
    const dialog = await panel();
    const user = userEvent.setup();
    const amount = within(dialog).getByRole('group', { name: 'Amount' });
    await user.click(within(amount).getByRole('button', { name: /^Amount/u }));
    const input = within(amount).getByRole('textbox', { name: 'Amount' });
    await user.clear(input);
    await user.type(input, 'abc');
    await user.keyboard('{Enter}');
    expect(within(amount).getByRole('alert')).toHaveTextContent('Expected a number.');
    expect(patches).toEqual([]);
  });

  it('a refused write (403) rolls back and explains', async () => {
    serve({ kind: 'admin', patch: () => problem('RECORD_RULE_VIOLATION', 403) });
    await renderApp(`${GRID_PATH}?record=${recordId(1)}`);
    const dialog = await panel();
    const user = userEvent.setup();
    const title = within(dialog).getByRole('group', { name: 'Title' });
    await user.click(within(title).getByRole('button', { name: /^Title/u }));
    const input = within(title).getByRole('textbox', { name: 'Title' });
    await user.clear(input);
    await user.type(input, 'Renamed');
    await user.keyboard('{Enter}');
    const toasts = screen.getByRole('region', { name: 'Notifications' });
    await waitFor(() => {
      expect(within(toasts).getAllByRole('listitem')).toHaveLength(1);
    });
    await waitFor(() => {
      expect(within(title).getByText('Order 1')).toBeVisible();
    });
  });

  it('readers see read-only fields, and the editor a read-only Status', async () => {
    serve({ kind: 'reader' });
    await renderApp(`${GRID_PATH}?record=${recordId(1)}`);
    const dialog = await panel();
    expect(
      within(dialog)
        .queryAllByRole('button', { name: /^(Title|Status|Amount|Notes)/u })
        .map((button) => button.textContent),
    ).toEqual([]);
    expect(
      within(within(dialog).getByRole('group', { name: 'Title' })).getByText('Read-only'),
    ).toBeInTheDocument();
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('the editor may not edit Status (field read) but edits Amount', async () => {
    serve({ kind: 'editor' });
    await renderApp(`${GRID_PATH}?record=${recordId(1)}`);
    const dialog = await panel();
    const status = within(dialog).getByRole('group', { name: 'Status' });
    expect(within(status).queryByRole('button', { name: /^Status/u })).toBeNull();
    expect(within(status).getByText('Read-only')).toBeInTheDocument();
    const amount = within(dialog).getByRole('group', { name: 'Amount' });
    expect(within(amount).getByRole('button', { name: /^Amount/u })).toBeEnabled();
  });

  it('hidden fields of the view are grouped and collapsed', async () => {
    window.localStorage.setItem(
      `cellhive.gridLayout.${TABLE_ID}`,
      JSON.stringify({ hidden: [FIELD.notes, FIELD.owner], frozen: 1, widths: {}, sort: null }),
    );
    serve({ kind: 'admin' });
    await renderApp(`${GRID_PATH}?record=${recordId(1)}`);
    const dialog = await panel();
    expect(within(dialog).queryByRole('group', { name: 'Notes' })).toBeNull();
    const toggle = within(dialog).getByRole('button', { name: '2 hidden fields' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.setup().click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(within(dialog).getByRole('group', { name: 'Owner' })).toBeVisible();
    expect(within(dialog).getByRole('group', { name: 'Notes' })).toBeVisible();
  });

  it('404: the record is gone — the panel closes with a toast', async () => {
    serve({ kind: 'admin', getRecord: () => problem('NOT_FOUND', 404) });
    const { router } = await renderApp(`${GRID_PATH}?record=rec_Missing000000001`);
    expect(
      await screen.findByText('This record was deleted or is no longer available to you.'),
    ).toBeVisible();
    await waitFor(() => {
      expect(router.state.location.search).toBe('');
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('opens the cell history from the cell menu and from a field of the panel', async () => {
    const { fetchMock } = serve({ kind: 'admin' });
    await renderApp(GRID_PATH);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'cell menu row 1' }));
    await user.click(await screen.findByRole('menuitem', { name: 'View cell history' }));
    const popover = await screen.findByRole('dialog', { name: 'History of Status' });
    expect(await within(popover).findByText('This field has not changed yet.')).toBeVisible();
    expect(fetchMock.mock.calls.some(([input]) => input.includes(`field=${FIELD.status}`))).toBe(
      true,
    );
    expect(await axeViolations(popover)).toEqual([]);
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'History of Status' })).toBeNull();
    });

    await user.click(screen.getByRole('button', { name: 'expand row 1' }));
    const dialog = await panel();
    await user.click(within(dialog).getByRole('button', { name: 'History of Amount' }));
    expect(await screen.findByRole('dialog', { name: 'History of Amount' })).toBeVisible();
  });

  it('below 768 px: a card list instead of the grid and a full-screen panel', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({
        matches: query.includes('max-width: 767.98px'),
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      })),
    );
    serve({ kind: 'admin' });
    await renderApp(GRID_PATH);
    const list = await screen.findByRole('list', { name: 'Records of Orders' });
    expect(screen.queryByTestId('grid')).toBeNull();
    const card = await within(list).findByRole('button', { name: /Order 2/u });
    expect(await axeViolations(document.body)).toEqual([]);
    await userEvent.setup().click(card);
    const dialog = await panel();
    expect(dialog).toHaveClass('inset-0');
    // No room for a history column: tabs.
    expect(within(dialog).getByRole('tab', { name: 'Details' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await userEvent.setup().click(within(dialog).getByRole('tab', { name: 'History' }));
    expect(await within(dialog).findByText('No changes yet.')).toBeVisible();
  });
});
