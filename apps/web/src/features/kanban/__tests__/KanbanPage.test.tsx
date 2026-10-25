import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultView, json, ORG, problem, renderApp, stubApi } from '../../../../test/app-harness';
import { axeViolations } from '../../../../test/axe';
import { resetUndoHistories } from '../../../grid/undo/table-undo';
import { viewSessions } from '../../../lib/views/session';

const BASE = 'bse_Sales00000000001';
const TABLE = 'tbl_Tickets000000001';
const NOW = '2026-09-24T00:00:00.000Z';
const ME_ID = 'usr_0123456789ABCDEF';
const TITLE = 'fld_Title00000000001';
const STATUS = 'fld_Status0000000001';
const NOTES = 'fld_Notes00000000001';
const NEW = 'opt_New0000000000001';
const DOING = 'opt_Doing00000000001';
const DONE = 'opt_Done000000000001';

const BOARD = defaultView(TABLE, {
  id: 'viw_Board00000000001',
  name: 'Board',
  type: 'kanban',
  config: {
    ...defaultView(TABLE).config,
    kanban: {
      group_field: STATUS,
      card_fields: [NOTES],
      cover_field: null,
      hide_empty_columns: false,
    },
  },
});

/** A kanban view just created: no group field, no card fields yet. */
const NEW_BOARD = defaultView(TABLE, {
  id: 'viw_NewBoard00000001',
  name: 'New board',
  type: 'kanban',
  config: {
    ...defaultView(TABLE).config,
    kanban: { group_field: null, card_fields: [], cover_field: null, hide_empty_columns: false },
  },
});

type Kind = 'admin' | 'reader';

function base(kind: Kind) {
  return {
    id: BASE,
    organization_id: ORG.id,
    workspace_id: 'wsp_Sales00000000001',
    owner_id: ME_ID,
    name: 'Sales',
    icon: null,
    description: null,
    permission_version: 3,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    access: {
      role: null,
      is_admin: kind === 'admin',
      base_rule: { copy: true, download: true, share_link: true },
      tables:
        kind === 'admin'
          ? {}
          : {
              [TABLE]: {
                perm: 'read_only',
                operations: [],
                view_rule: { allow_edit: false, visible_views: null },
                read_scope: 'all',
                fields: { [TITLE]: 'read', [STATUS]: 'read', [NOTES]: 'read' },
                option_edit_fields: [],
                file_download_fields: [],
              },
            },
      dashboards: {},
    },
  };
}

const table = {
  id: TABLE,
  base_id: BASE,
  name: 'Tickets',
  description: null,
  primary_field_id: TITLE,
  position: 0,
  schema_state: 'ready',
  created_at: NOW,
  updated_at: NOW,
};

function fieldDto(id: string, name: string, type: string, position: number, options = {}) {
  return {
    id,
    table_id: TABLE,
    name,
    type,
    options,
    is_primary: id === TITLE,
    required: false,
    unique_values: false,
    description: null,
    position,
    created_at: NOW,
    updated_at: NOW,
  };
}

const fields = {
  items: [
    fieldDto(TITLE, 'Title', 'text', 0),
    fieldDto(STATUS, 'Status', 'select', 1, {
      multiple: false,
      options: [
        { id: NEW, name: 'New', color: 1 },
        { id: DOING, name: 'Doing', color: 2 },
        { id: DONE, name: 'Done', color: 3 },
      ],
    }),
    fieldDto(NOTES, 'Notes', 'text', 2),
  ],
  total: 3,
  offset: 0,
  limit: 1000,
};

interface Row {
  id: string;
  version: number;
  fields: Record<string, unknown>;
}

function recordOf(row: Row) {
  return { id: row.id, created_at: NOW, updated_at: NOW, version: row.version, fields: row.fields };
}

interface Filter {
  items: { field: string; operator: string; value?: unknown }[];
}

/** A tiny server holding the rows: group counts and per-column queries follow the writes. */
function serve(kind: Kind, patch?: () => Response | null) {
  const rows: Row[] = [
    {
      id: 'rec_A000000000000001',
      version: 1,
      fields: { [TITLE]: 'Printer', [STATUS]: 'New', [NOTES]: 'Tầng 2' },
    },
    {
      id: 'rec_B000000000000001',
      version: 1,
      fields: { [TITLE]: 'Scanner', [STATUS]: 'New', [NOTES]: null },
    },
    {
      id: 'rec_C000000000000001',
      version: 1,
      fields: { [TITLE]: 'Router', [STATUS]: 'Doing', [NOTES]: null },
    },
  ];
  const optionName = (id: unknown) =>
    fields.items[1]?.options &&
    (fields.items[1].options as { options: { id: string; name: string }[] }).options.find(
      (option) => option.id === id,
    )?.name;
  const views = { [TABLE]: [defaultView(TABLE), BOARD, NEW_BOARD] };
  // Following (T553): one state for every card, `PUT`/`DELETE` answered `204`.
  const follows = { following: false };
  const followRoutes = Object.fromEntries(
    rows.flatMap((row) => {
      const path = `/tables/${TABLE}/records/${row.id}/follow`;
      return [
        [`GET ${path}`, () => json({ ...follows, source: follows.following ? 'manual' : null })],
        [
          `PUT ${path}`,
          () => {
            follows.following = true;
            return new Response(null, { status: 204 });
          },
        ],
        [
          `DELETE ${path}`,
          () => {
            follows.following = false;
            return new Response(null, { status: 204 });
          },
        ],
      ];
    }),
  );
  const fetchMock = stubApi({
    signedIn: true,
    views,
    routes: {
      ...followRoutes,
      [`GET /bases/${BASE}`]: () => json(base(kind)),
      [`GET /bases/${BASE}/tables`]: () =>
        json({ items: [table], total: 1, offset: 0, limit: 1000 }),
      [`GET /tables/${TABLE}`]: () => json(table),
      [`GET /tables/${TABLE}/fields`]: () => json(fields),
      [`POST /tables/${TABLE}/records/group-counts`]: () => {
        const counts = new Map<string | null, number>();
        for (const row of rows) {
          const value = (row.fields[STATUS] as string | null) ?? null;
          counts.set(value, (counts.get(value) ?? 0) + 1);
        }
        return json({
          group: [{ field: STATUS, direction: 'asc' }],
          groups: [...counts].map(([value, count]) => ({ values: [value], count })),
          truncated: false,
        });
      },
      [`POST /tables/${TABLE}/records/query`]: (init) => {
        const body = JSON.parse(init?.body as string) as { filter?: Filter; ids?: string[] };
        const condition = body.filter?.items[0];
        const matching = rows.filter((row) => {
          if (body.ids !== undefined) return body.ids.includes(row.id);
          if (condition === undefined) return true;
          const value = row.fields[STATUS] ?? null;
          return condition.operator === 'is_empty'
            ? value === null
            : value === optionName(condition.value);
        });
        return json({ records: matching.map(recordOf), offset: 0, limit: 50 });
      },
      [`PATCH /tables/${TABLE}/records`]: (init) => {
        const refused = patch?.();
        if (refused !== null && refused !== undefined) return refused;
        const body = JSON.parse(init?.body as string) as {
          records: { id: string; fields: Record<string, unknown> }[];
        };
        const updated = body.records.map((change) => {
          const row = rows.find((item) => item.id === change.id);
          if (row === undefined) throw new Error('unknown record');
          for (const [fieldId, value] of Object.entries(change.fields)) {
            row.fields[fieldId] = fieldId === STATUS ? (optionName(value) ?? value) : value;
          }
          row.version += 1;
          return recordOf(row);
        });
        return json({ records: updated });
      },
    },
  });
  return { fetchMock, rows, views };
}

const viewPath = `/b/${BASE}/t/${TABLE}/v/${BOARD.id}`;

function column(name: string): HTMLElement {
  const found = screen
    .getAllByTestId('kanban-column')
    .find((element) =>
      within(element).queryByRole('heading', { name: new RegExp(`^${name}`, 'u') }),
    );
  if (found === undefined) throw new Error(`no column ${name}`);
  return found;
}

function cardsOf(name: string): string[] {
  return within(column(name))
    .queryAllByTestId('kanban-card')
    .map((card) => card.textContent);
}

async function board() {
  await renderApp(viewPath);
  await screen.findByRole('region', { name: 'Tickets by Status' }, { timeout: 10_000 });
  await waitFor(() => {
    expect(cardsOf('New')).toHaveLength(2);
  });
}

beforeEach(() => {
  viewSessions.reset();
  resetUndoHistories();
});

afterEach(() => {
  window.localStorage.clear();
});

const SLOW = 30_000;

describe('kanban board (T314)', () => {
  it(
    'shows a column per option with its count, cards with their fields; no axe violations',
    async () => {
      serve('admin');
      await board();
      const headings = screen
        .getAllByTestId('kanban-column')
        .map((element) => within(element).getByRole('heading').textContent);
      expect(headings).toEqual([
        'UncategorizedRecords:0',
        'NewRecords:2',
        'DoingRecords:1',
        'DoneRecords:0',
      ]);
      // Values without labels (the name is read out only); empty values take no room.
      expect(cardsOf('New')).toEqual(['PrinterNotes: Tầng 2', 'Scanner']);
      expect(cardsOf('Doing')).toEqual(['Router']);
      const value = within(column('New')).getAllByTestId('kanban-card-value')[0];
      expect(value).toHaveAttribute('title', 'Notes');
      expect(within(column('Done')).getByText('No records')).toBeInTheDocument();
      expect(await axeViolations(document.body)).toEqual([]);
    },
    SLOW,
  );

  it(
    'moves a card with "Move to": PATCH of the group field with the version, counts follow',
    async () => {
      const { fetchMock } = serve('admin');
      await board();
      const card = within(column('New')).getAllByTestId('kanban-card')[0];
      if (card === undefined) throw new Error('no card');
      card.focus();
      fireEvent.keyDown(card, { key: 'F10', shiftKey: true });
      const menu = await screen.findByRole('menu');
      // Every column is listed, "Uncategorized" included; the current one is checked.
      expect(
        within(menu)
          .getAllByRole('menuitemradio')
          .map((item) => item.textContent),
      ).toEqual(['Uncategorized', 'NewCurrent', 'Doing', 'Done']);
      expect(within(menu).getByRole('menuitemradio', { name: /^New/u })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      await userEvent.click(within(menu).getByRole('menuitemradio', { name: 'Doing' }));
      await waitFor(() => {
        expect(cardsOf('Doing')).toEqual(['PrinterNotes: Tầng 2', 'Router']);
      });
      expect(cardsOf('New')).toEqual(['Scanner']);
      // The focus goes to the next card of the column the card left.
      await waitFor(() => {
        expect(document.activeElement?.textContent).toBe('Scanner');
      });
      const call = fetchMock.mock.calls.find(
        ([url, init]) => init?.method === 'PATCH' && url.includes('/records'),
      );
      expect(JSON.parse(call?.[1]?.body as string)).toEqual({
        records: [{ id: 'rec_A000000000000001', version: 1, fields: { [STATUS]: DOING } }],
      });
      await waitFor(() => {
        expect(within(column('Doing')).getByRole('heading').textContent).toBe('DoingRecords:2');
      });
      expect(within(column('New')).getByRole('heading').textContent).toBe('NewRecords:1');
      // One undo step of the table: the card goes back.
      await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
      await waitFor(() => {
        expect(cardsOf('New')).toContain('PrinterNotes: Tầng 2');
      });
    },
    SLOW,
  );

  it(
    'puts the card back and explains a refusal (record rule)',
    async () => {
      serve('admin', () => problem('RECORD_RULE_VIOLATION', 403));
      await board();
      const card = within(column('New')).getAllByTestId('kanban-card')[0];
      if (card === undefined) throw new Error('no card');
      await userEvent.click(
        within(card.parentElement as HTMLElement).getByRole('button', { name: 'Card actions' }),
      );
      await userEvent.click(
        within(await screen.findByRole('menu')).getByRole('menuitemradio', { name: 'Done' }),
      );
      await waitFor(() => {
        expect(cardsOf('New')).toHaveLength(2);
      });
      expect(cardsOf('Done')).toEqual([]);
      expect(await screen.findByRole('alert')).toBeInTheDocument();
    },
    SLOW,
  );

  it(
    'a reader opens cards but cannot move them',
    async () => {
      serve('reader');
      await board();
      const card = within(column('New')).getAllByTestId('kanban-card')[0];
      if (card === undefined) throw new Error('no card');
      expect(card).not.toHaveAttribute('aria-roledescription');
      // Shift+F10 opens the card menu: open, and why cards cannot be moved (no empty menu).
      card.focus();
      fireEvent.keyDown(card, { key: 'F10', shiftKey: true });
      const menu = await screen.findByRole('menu');
      expect(within(menu).queryAllByRole('menuitemradio')).toEqual([]);
      expect(within(menu).getByRole('menuitem', { name: 'Open record' })).toBeInTheDocument();
      expect(within(menu).getByTestId('kanban-move-blocked')).toHaveTextContent(
        'You cannot change this field, so cards cannot be moved.',
      );
      expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Add a record to/u })).not.toBeInTheDocument();
    },
    SLOW,
  );

  it(
    'hides empty columns and keeps the setting in the view',
    async () => {
      const { fetchMock } = serve('admin');
      await board();
      await userEvent.click(screen.getByRole('button', { name: 'Hide empty columns' }));
      await waitFor(() => {
        expect(screen.getAllByTestId('kanban-column')).toHaveLength(2);
      });
      await waitFor(() => {
        const call = fetchMock.mock.calls.find(
          ([url, init]) => init?.method === 'PATCH' && url.includes(`/views/${BOARD.id}`),
        );
        expect(JSON.parse(call?.[1]?.body as string)).toMatchObject({
          config: { kanban: { group_field: STATUS, hide_empty_columns: true } },
        });
      });
    },
    SLOW,
  );

  it(
    'a new board grouped for the first time shows the first readable fields on its cards',
    async () => {
      const { fetchMock } = serve('admin');
      await renderApp(`/b/${BASE}/t/${TABLE}/v/${NEW_BOARD.id}`);
      const select = await screen.findByRole('combobox', { name: 'Group cards by' });
      await userEvent.selectOptions(select, STATUS);
      await waitFor(() => {
        const call = fetchMock.mock.calls.find(
          ([url, init]) => init?.method === 'PATCH' && url.includes(`/views/${NEW_BOARD.id}`),
        );
        expect(JSON.parse(call?.[1]?.body as string)).toMatchObject({
          config: { kanban: { group_field: STATUS, card_fields: [NOTES] } },
        });
      });
    },
    SLOW,
  );

  it(
    'the card menu follows and unfollows the record, by keyboard (T553)',
    async () => {
      const { fetchMock } = serve('reader');
      await board();
      const card = within(column('New')).getAllByTestId('kanban-card')[0];
      if (card === undefined) throw new Error('no card');
      card.focus();
      fireEvent.keyDown(card, { key: 'F10', shiftKey: true });
      const menu = await screen.findByRole('menu');
      const follow = within(menu).getByRole('menuitem', { name: 'Follow record' });
      await waitFor(() => {
        expect(follow).not.toHaveAttribute('data-disabled');
      });
      expect(await axeViolations(menu)).toEqual([]);
      follow.focus();
      await userEvent.keyboard('{Enter}');
      expect(await screen.findByText(/You follow “Printer”\./u)).toBeVisible();
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) => init?.method === 'PUT' && url.endsWith('/rec_A000000000000001/follow'),
        ),
      ).toBe(true);

      card.focus();
      fireEvent.keyDown(card, { key: 'F10', shiftKey: true });
      const again = await screen.findByRole('menu');
      await userEvent.click(within(again).getByRole('menuitem', { name: 'Unfollow record' }));
      expect(await screen.findByText('You no longer follow “Printer”.')).toBeVisible();
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            init?.method === 'DELETE' && url.endsWith('/rec_A000000000000001/follow'),
        ),
      ).toBe(true);
    },
    SLOW,
  );
});
