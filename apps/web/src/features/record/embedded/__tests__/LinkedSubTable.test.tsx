import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  json,
  problem,
  renderApp,
  stubApi,
  type ServerState,
} from '../../../../../test/app-harness';
import { axeViolations } from '../../../../../test/axe';
import {
  BASE_ID,
  baseDetail,
  fieldList,
  NOW,
  record,
  recordId,
  TABLE,
  TABLE_ID,
  type AccessKind,
} from '../../../../../test/records';
import { clearToasts } from '../../../../lib/toast/toast';

import type { GridViewProps } from '../../../../grid';

// The canvas grid needs a real browser (E2E); here it only reports its viewport.
vi.mock('../../../../grid/GridView', () => ({
  GridView: ({ rowCount, onViewportChange, label }: GridViewProps) => {
    useEffect(() => {
      onViewportChange({ firstRow: 0, lastRow: Math.min(rowCount, 20) - 1, dragging: false });
    }, [onViewportChange, rowCount]);
    return <section aria-label={label} data-testid="grid" />;
  },
}));

/** Orders.items → Order details (two-way, `Order` is the reverse field). */
const DETAILS_ID = 'tbl_Details000000001';
const ITEMS = 'fld_Items00000000001';
const D = {
  product: 'fld_Product000000001',
  qty: 'fld_Qty0000000000001',
  price: 'fld_Price00000000001',
  total: 'fld_Total00000000001',
  note: 'fld_Note000000000001',
  order: 'fld_Order00000000001',
  shipped: 'fld_Shipped000000001',
} as const;
const MONEY = { style: { type: 'currency', currency_code: 'VND' } };

function detailField(
  id: string,
  name: string,
  type: string,
  position: number,
  options: Record<string, unknown> = {},
) {
  return {
    id,
    table_id: DETAILS_ID,
    name,
    type,
    options,
    is_primary: id === D.product,
    required: false,
    unique_values: false,
    description: null,
    position,
    created_at: NOW,
    updated_at: NOW,
  };
}

const DETAIL_FIELDS = [
  detailField(D.product, 'Product', 'text', 0),
  detailField(D.qty, 'Qty', 'number', 1),
  detailField(D.price, 'Unit price', 'number', 2, MONEY),
  detailField(D.total, 'Line total', 'number', 3, MONEY),
  detailField(D.note, 'Note', 'text', 4),
  detailField(D.order, 'Order', 'link', 5, {
    link_table: TABLE_ID,
    bidirectional: true,
    allow_multiple: false,
    symmetric_field_id: ITEMS,
  }),
  detailField(D.shipped, 'Shipped', 'checkbox', 6),
];

const ITEMS_FIELD = {
  id: ITEMS,
  table_id: TABLE_ID,
  name: 'Order details',
  type: 'link',
  options: {
    link_table: DETAILS_ID,
    bidirectional: true,
    allow_multiple: true,
    symmetric_field_id: D.order,
  },
  is_primary: false,
  required: false,
  unique_values: false,
  description: null,
  position: 9,
  created_at: NOW,
  updated_at: NOW,
};

function detailId(index: number): string {
  return `rec_D${String(index).padStart(15, '0')}`;
}

function detail(index: number, product: string, qty: number, price: number, version = 1) {
  return {
    id: detailId(index),
    version,
    created_at: NOW,
    updated_at: NOW,
    fields: {
      [D.product]: product,
      [D.qty]: qty,
      [D.price]: price,
      [D.total]: qty * price,
      [D.note]: null,
      [D.order]: [{ id: recordId(1), title: 'Order 1' }],
      [D.shipped]: false,
    },
  };
}

const DETAILS = [
  detail(1, 'POS terminal', 1, 9_800_000),
  detail(2, 'Barcode scanner', 2, 1_650_000),
  detail(3, 'Cash drawer', 1, 1_150_000),
];
const LOCKED = 'rec_Locked0000000001';

interface Setup {
  readonly kind?: AccessKind;
  /** Links of Order 1 (default: the three details and one record the user cannot read). */
  readonly links?: { id: string; title: string | null }[];
  readonly details?: typeof DETAILS;
  /** Details table readable (else Sales-like: the linked table is hidden). */
  readonly readable?: boolean;
  readonly linkPatch?: (init: RequestInit | undefined) => Response;
  /** The linked table is in the trash (T421a): the field carries `link_target_deleted`. */
  readonly targetDeleted?: boolean;
}

function serve(setup: Setup = {}) {
  const kind = setup.kind ?? 'admin';
  const details = setup.details ?? DETAILS;
  const links = setup.links ?? [
    ...details.map((item) => ({ id: item.id, title: item.fields[D.product] })),
    { id: LOCKED, title: null },
  ];
  let order: Omit<ReturnType<typeof record>, 'fields'> & { fields: Record<string, unknown> } =
    record(1, { [ITEMS]: links });
  const calls: { method: string; path: string; body: unknown }[] = [];
  const base = baseDetail(kind);
  if (setup.readable !== false) {
    (base.access.tables as Record<string, unknown>)[DETAILS_ID] = {
      ...base.access.tables[TABLE_ID],
      fields: Object.fromEntries(DETAIL_FIELDS.map((item) => [item.id, 'edit'])),
    };
  }
  const tables = [
    TABLE,
    ...(setup.readable === false || setup.targetDeleted === true
      ? []
      : [{ ...TABLE, id: DETAILS_ID, name: 'Order details' }]),
  ];
  const log = (method: string, path: string) => (init: RequestInit | undefined) => {
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
    calls.push({ method, path, body });
    return body;
  };
  const state: ServerState = {
    signedIn: true,
    routes: {
      [`GET /bases/${BASE_ID}`]: () => json(base),
      [`GET /bases/${BASE_ID}/tables`]: () =>
        json({ items: tables, total: tables.length, offset: 0, limit: 1000 }),
      [`GET /tables/${TABLE_ID}`]: () => json(TABLE),
      [`GET /tables/${TABLE_ID}/fields`]: () =>
        json(
          fieldList([
            setup.targetDeleted === true
              ? ({ ...ITEMS_FIELD, link_target_deleted: true } as typeof ITEMS_FIELD)
              : ITEMS_FIELD,
          ]),
        ),
      [`POST /tables/${TABLE_ID}/records/query`]: () =>
        json({ records: [order], total: 1, offset: 0, limit: 200 }),
      [`GET /tables/${TABLE_ID}/records/${recordId(1)}`]: () => json(order),
      [`GET /tables/${TABLE_ID}/records/${recordId(1)}/history`]: () =>
        json({ items: [], next_cursor: null }),
      [`PATCH /tables/${TABLE_ID}/records`]: (init) => {
        const body = log('PATCH', `/tables/${TABLE_ID}/records`)(init) as {
          records: { fields: Record<string, unknown>; version: number }[];
        };
        const change = body.records[0];
        // Ids, or `{ id }` (an undo writes the refs back).
        const ids = ((change?.fields[ITEMS] ?? []) as (string | { id: string })[]).map((item) =>
          typeof item === 'string' ? item : item.id,
        );
        const byId = new Map(links.map((item) => [item.id, item]));
        order = {
          ...order,
          version: order.version + 1,
          fields: {
            ...order.fields,
            [ITEMS]: ids.map((id) => byId.get(id) ?? { id, title: '' }),
          },
        };
        return json({ records: [order] });
      },
      [`PATCH /tables/${TABLE_ID}/records/${recordId(1)}`]: (init) => {
        const body = log('PATCH', `/tables/${TABLE_ID}/records/${recordId(1)}`)(init) as {
          fields: Record<string, string[]>;
        };
        const answer = setup.linkPatch?.(init);
        if (answer !== undefined) return answer;
        order = {
          ...order,
          version: order.version + 1,
          fields: {
            ...order.fields,
            [ITEMS]: (body.fields[ITEMS] ?? []).map((id) => ({ id, title: '' })),
          },
        };
        return json(order);
      },
      [`GET /tables/${DETAILS_ID}/fields`]: () =>
        json({ items: DETAIL_FIELDS, total: DETAIL_FIELDS.length, offset: 0, limit: 1000 }),
      [`POST /tables/${DETAILS_ID}/records/query`]: (init) => {
        const body = log('POST', `/tables/${DETAILS_ID}/records/query`)(init) as {
          ids?: string[];
        };
        // Without ids: the sidebar's record count.
        if (body.ids === undefined) {
          return json({ records: [], total: details.length, offset: 0, limit: 1 });
        }
        const found = body.ids.flatMap((id) => details.filter((item) => item.id === id));
        return json({ records: found, offset: 0, limit: body.ids.length });
      },
      [`PATCH /tables/${DETAILS_ID}/records`]: (init) => {
        const body = log('PATCH', `/tables/${DETAILS_ID}/records`)(init) as {
          records: { id: string; version: number; fields: Record<string, unknown> }[];
        };
        const change = body.records[0];
        const current = details.find((item) => item.id === change?.id) ?? details[0];
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
      [`POST /tables/${DETAILS_ID}/records`]: (init) => {
        log('POST', `/tables/${DETAILS_ID}/records`)(init);
        return json({ records: [{ ...detail(9, '', 0, 0), fields: {} }] }, 201);
      },
      [`DELETE /tables/${DETAILS_ID}/records`]: (init) => {
        log('DELETE', `/tables/${DETAILS_ID}/records`)(init);
        return json({ ids: [detailId(9)] });
      },
    },
  };
  const fetchMock = stubApi(state);
  return { calls, state, fetchMock };
}

const PATH = `/b/${BASE_ID}/t/${TABLE_ID}?record=${recordId(1)}`;

async function subTable() {
  const dialog = await screen.findByRole('dialog', { name: /Order/u });
  const section = await within(dialog).findByTestId('subtable');
  await within(section).findByTestId('subtable-table');
  return section;
}

beforeEach(() => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })),
  );
  window.localStorage.clear();
});

afterEach(() => {
  clearToasts();
});

describe('embedded sub-table (T416)', () => {
  it('shows the linked records with the default columns, a locked row and totals; no axe violations', async () => {
    const { calls } = serve();
    await renderApp(PATH);
    const section = await subTable();
    expect(within(section).getByRole('heading', { level: 3, name: 'Order details' })).toBeVisible();
    expect(within(section).getByTestId('subtable-count')).toHaveTextContent('4 rows');
    const table = within(section).getByRole('table', { name: 'Order details' });
    // First 5 readable fields, the reverse link (always this order) left out.
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual(['Row', 'Product', 'Qty', 'Unit price', 'Line total', 'Note', 'Actions']);
    const rows = within(section).getAllByTestId('subtable-row');
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent('POS terminal');
    // The row number and the primary column stay put when the table scrolls sideways (T421a).
    const headers = within(table).getAllByRole('columnheader');
    expect(headers[0]).toHaveClass('sticky', 'left-0');
    expect(headers[1]).toHaveClass('sticky', 'left-9');
    expect(headers[2]).not.toHaveClass('sticky');
    const cells = within(rows[0] as HTMLElement).getAllByRole('cell');
    expect(cells[0]).toHaveClass('sticky', 'left-0');
    expect(cells[1]).toHaveClass('sticky', 'left-9');
    expect(cells[2]).not.toHaveClass('sticky');
    expect(within(rows[3] as HTMLElement).getByTestId('subtable-locked-row')).toHaveTextContent(
      'You cannot see this record',
    );
    // Only readable links are asked for.
    await waitFor(() => {
      expect(
        calls.find(
          (call) => typeof call.body === 'object' && call.body !== null && 'ids' in call.body,
        )?.body,
      ).toMatchObject({
        ids: DETAILS.map((item) => item.id),
      });
    });
    const summary = within(section).getByTestId('subtable-summary');
    expect(summary).toHaveTextContent('Total 4 rows');
    // Money columns are added up (9 800 000 + 3 300 000 + 1 150 000).
    expect(summary.textContent.replace(/\s/gu, '')).toContain('14,250,000');
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('edits a linked record in place through the linked table (version sent)', async () => {
    const { calls } = serve();
    await renderApp(PATH);
    const section = await subTable();
    const user = userEvent.setup();
    const row = within(section).getAllByTestId('subtable-row')[1] as HTMLElement;
    await user.click(within(row).getByRole('button', { name: /^Qty/u }));
    const input = await screen.findByRole('textbox', { name: 'Qty' });
    await user.clear(input);
    await user.type(input, '5');
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(
        calls.find((call) => call.method === 'PATCH' && call.path.includes(DETAILS_ID))?.body,
      ).toEqual({ records: [{ id: detailId(2), version: 1, fields: { [D.qty]: 5 } }] });
    });
    expect(await within(row).findByText('5')).toBeVisible();
  });

  it('arrow keys move between cells, not to another record', async () => {
    serve();
    const { router } = await renderApp(PATH);
    const section = await subTable();
    const user = userEvent.setup();
    const first = within(section).getAllByTestId('subtable-row')[0] as HTMLElement;
    within(first).getByRole('button', { name: /^Qty/u }).focus();
    await user.keyboard('{ArrowDown}');
    const second = within(section).getAllByTestId('subtable-row')[1] as HTMLElement;
    expect(within(second).getByRole('button', { name: /^Qty/u })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(within(second).getByRole('button', { name: /^Unit price/u })).toHaveFocus();
    expect(router.state.location.search).toBe(`?record=${recordId(1)}`);
  });

  it('unlinks without deleting, with undo in the toast', async () => {
    const { calls } = serve();
    await renderApp(PATH);
    const section = await subTable();
    const user = userEvent.setup();
    await user.click(within(section).getByRole('button', { name: 'Unlink Barcode scanner' }));
    await waitFor(() => {
      expect(
        calls.filter((call) => call.method === 'PATCH' && call.path.includes(TABLE_ID)),
      ).toHaveLength(1);
    });
    expect(calls.at(-1)?.body).toMatchObject({
      records: [{ fields: { [ITEMS]: [detailId(1), detailId(3), LOCKED] } }],
    });
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
    const toast = (await screen.findByText('Unlinked “Barcode scanner”.')).closest(
      '[role="status"]',
    ) as HTMLElement;
    await user.click(within(toast).getByRole('button', { name: 'Undo' }));
    await waitFor(() => {
      expect(calls.at(-1)?.body).toMatchObject({
        records: [{ fields: { [ITEMS]: [detailId(1), detailId(2), detailId(3), LOCKED] } }],
      });
    });
    // The toast goes once its undo is used (T421a).
    expect(screen.queryByText('Unlinked “Barcode scanner”.')).toBeNull();
  });

  it('the unlink toast goes when the link comes back another way (toolbar undo, T421a)', async () => {
    const { calls } = serve();
    await renderApp(PATH);
    const section = await subTable();
    const user = userEvent.setup();
    await user.click(within(section).getByRole('button', { name: 'Unlink Barcode scanner' }));
    await screen.findByText('Unlinked “Barcode scanner”.');
    const toolbarUndo = screen
      .getAllByRole('button', { name: /^Undo/u })
      .find((button) => button.closest('[role="status"]') === null);
    if (toolbarUndo === undefined) throw new Error('no toolbar undo');
    await waitFor(() => {
      expect(toolbarUndo).toBeEnabled();
    });
    await user.click(toolbarUndo);
    await waitFor(() => {
      expect(calls.at(-1)?.body).toMatchObject({
        records: [
          {
            fields: {
              [ITEMS]: [detailId(1), detailId(2), detailId(3), LOCKED].map((id) => ({ id })),
            },
          },
        ],
      });
    });
    await waitFor(() => {
      expect(screen.queryByText('Unlinked “Barcode scanner”.')).toBeNull();
    });
  });

  it('saves the chosen columns to the view (record_detail.link_columns)', async () => {
    const { state } = serve();
    await renderApp(PATH);
    const section = await subTable();
    const user = userEvent.setup();
    await user.click(within(section).getByRole('button', { name: 'Columns' }));
    const picker = await screen.findByRole('dialog', { name: 'Columns in the sub-table' });
    expect(within(picker).getByText('Saved for the view “Grid view”')).toBeVisible();
    expect(within(picker).getByRole('checkbox', { name: /Product/u })).toBeDisabled();
    await user.click(within(picker).getByRole('checkbox', { name: /Note/u }));
    await user.click(within(picker).getByRole('checkbox', { name: /Shipped/u }));
    await waitFor(
      () => {
        const view = state.views?.[TABLE_ID]?.[0];
        expect((view?.config as Record<string, unknown>)['record_detail']).toEqual({
          link_columns: { [ITEMS]: [D.product, D.qty, D.price, D.total, D.shipped] },
        });
      },
      { timeout: 3000 },
    );
    await waitFor(() => {
      expect(
        within(screen.getByTestId('subtable-table'))
          .getAllByRole('columnheader')
          .map((header) => header.textContent),
      ).toContain('Shipped');
    });
  });

  it('more than 50 links: "50 / N" and "View all" opens the linked table filtered', async () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      detail(index + 1, `Item ${String(index + 1)}`, 1, 1000),
    );
    serve({ details: many });
    const { router } = await renderApp(PATH);
    const section = await subTable();
    // 60 details and the record the user cannot read.
    expect(within(section).getByTestId('subtable-count')).toHaveTextContent('50 / 61');
    expect(within(section).getAllByTestId('subtable-row')).toHaveLength(50);
    await userEvent.setup().click(within(section).getByRole('button', { name: 'View all' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toMatch(
        new RegExp(`^/b/${BASE_ID}/t/${DETAILS_ID}`, 'u'),
      );
    });
  });

  it('adds a record to the linked table and links it; a failed link trashes it', async () => {
    const { calls } = serve({ linkPatch: () => problem('PERMISSION_DENIED', 403) });
    await renderApp(PATH);
    const section = await subTable();
    await userEvent.setup().click(within(section).getByTestId('subtable-add-row'));
    await waitFor(() => {
      expect(calls.some((call) => call.method === 'DELETE')).toBe(true);
    });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(
      expect.arrayContaining([
        `POST /tables/${DETAILS_ID}/records`,
        `PATCH /tables/${TABLE_ID}/records/${recordId(1)}`,
        `DELETE /tables/${DETAILS_ID}/records`,
      ]),
    );
    expect(
      await screen.findByText('The new record could not be linked; it was moved to the trash.'),
    ).toBeVisible();
  });

  it('adds and links a new record', async () => {
    const { calls } = serve();
    await renderApp(PATH);
    const section = await subTable();
    await userEvent.setup().click(within(section).getByTestId('subtable-add-row'));
    await waitFor(() => {
      expect(
        calls.find((call) => call.path === `/tables/${TABLE_ID}/records/${recordId(1)}`)?.body,
      ).toMatchObject({
        version: 1,
        fields: { [ITEMS]: [detailId(1), detailId(2), detailId(3), LOCKED, detailId(9)] },
      });
    });
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
  });

  it('linked table in the trash (T421a): says so, no add or link actions, no calls to it', async () => {
    const { calls } = serve({ targetDeleted: true, links: [] });
    await renderApp(PATH);
    const dialog = await screen.findByRole('dialog', { name: /Order/u });
    const gone = await within(dialog).findByTestId('subtable-target-deleted');
    expect(gone).toHaveTextContent(
      'The linked table is in the trash. These links come back when it is restored.',
    );
    expect(within(dialog).queryByTestId('subtable')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /Link existing/u })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /^Add/u })).toBeNull();
    expect(await axeViolations(gone)).toEqual([]);
    expect(calls.some((call) => call.path.includes(DETAILS_ID))).toBe(false);
  });

  it('linked table not readable: the count and a lock, no rows', async () => {
    const { calls } = serve({ kind: 'editor', readable: false });
    await renderApp(PATH);
    const dialog = await screen.findByRole('dialog', { name: /Order/u });
    const locked = await within(dialog).findByTestId('subtable-locked');
    expect(locked).toHaveTextContent('4 links. You do not have access to the linked table.');
    expect(within(dialog).queryByTestId('subtable')).toBeNull();
    expect(calls.some((call) => call.path.includes(DETAILS_ID))).toBe(false);
  });
});
