import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  defaultView,
  json,
  ME,
  ORG,
  problem,
  renderApp,
  stubApi,
} from '../../../../test/app-harness';
import { resetUndoHistories } from '../../../grid/undo/table-undo';
import { viewSessions } from '../../../lib/views/session';
import { selectedRecordIds } from '../components/GridPage';

import type { GridViewProps } from '../../../grid';

// The canvas grid needs a real browser (E2E); here it is a list of the rows it would draw.
vi.mock('../../../grid/GridView', () => ({
  GridView: ({ rowCount, getRecord, onViewportChange, label, fields, hooks }: GridViewProps) => {
    useEffect(() => {
      onViewportChange({ firstRow: 0, lastRow: Math.min(rowCount, 20) - 1, dragging: false });
    }, [onViewportChange, rowCount]);
    const primary = fields[0]?.field.id ?? '';
    const rows = Array.from({ length: Math.min(rowCount, 3) }, (_, row) => getRecord(row));
    const edit = hooks?.edit;
    return (
      <ul
        aria-label={label}
        data-rows={rowCount}
        data-editable={fields
          .filter((field) => edit?.canEditField?.(field.field.id) === true)
          .map((field) => field.field.name)
          .join(',')}
      >
        <li>
          <button
            type="button"
            onClick={() => {
              hooks?.selection?.onSelectionChange?.([
                { firstRow: 0, lastRow: 1, fieldIds: [primary], wholeRows: true },
              ]);
            }}
          >
            select rows 1-2
          </button>
          <button
            type="button"
            onClick={() => {
              hooks?.selection?.onSelectionChange?.([
                { firstRow: 0, lastRow: 1, fieldIds: [primary] },
              ]);
            }}
          >
            select cells 1-2
          </button>
          <button
            type="button"
            onClick={() => {
              hooks?.selection?.onPaste?.(
                { firstRow: 0, lastRow: 0, fieldIds: [primary] },
                'Pasted A\r\nPasted B\r\n',
              );
            }}
          >
            paste 2 rows
          </button>
          <button
            type="button"
            onClick={() => {
              const content = hooks?.selection?.onCopy?.(
                { firstRow: 0, lastRow: 1, fieldIds: [primary] },
                false,
              );
              document.body.dataset['copied'] =
                content === undefined || content === null || content instanceof Promise
                  ? 'refused'
                  : content.text;
            }}
          >
            copy rows 1-2
          </button>
          <button
            type="button"
            onClick={() => {
              const record = getRecord(0);
              if (record !== undefined && edit !== undefined) {
                edit.onCommit({ recordId: record.id, fieldId: primary }, 'Renamed', record);
              }
            }}
          >
            rename row 1
          </button>
        </li>
        {rows.map((record, row) => (
          <li key={record?.id ?? `loading-${String(row)}`}>
            {record === undefined ? 'loading' : String(record.fields[primary])}
          </li>
        ))}
      </ul>
    );
  },
}));

const BASE = 'bse_Sales00000000001';
const TABLE = 'tbl_Tickets000000001';
const OTHER_TABLE = 'tbl_Orders0000000001';
const PRIMARY = 'fld_Title00000000001';
const NOW = '2026-09-24T00:00:00.000Z';
const VIEW = defaultView(TABLE).id;

const base = {
  id: BASE,
  organization_id: ORG.id,
  workspace_id: 'wsp_Sales00000000001',
  owner_id: 'usr_0123456789ABCDEF',
  name: 'Sales',
  icon: null,
  description: null,
  permission_version: 3,
  created_at: NOW,
  updated_at: NOW,
  deleted_at: null,
  access: {
    role: null,
    is_admin: true,
    base_rule: { copy: true, download: true, share_link: true },
    tables: {},
    dashboards: {},
  },
};

const table = (id: string, name: string, position: number, baseId = BASE) => ({
  id,
  base_id: baseId,
  name,
  description: null,
  primary_field_id: PRIMARY,
  position,
  schema_state: 'ready',
  created_at: NOW,
  updated_at: NOW,
});

const fields = {
  items: [
    {
      id: PRIMARY,
      table_id: TABLE,
      name: 'Title',
      type: 'text',
      options: {},
      is_primary: true,
      required: false,
      unique_values: false,
      description: null,
      position: 0,
      created_at: NOW,
      updated_at: NOW,
    },
  ],
  total: 1,
  offset: 0,
  limit: 1000,
};

function records(count: number, offset = 0) {
  return Array.from({ length: count }, (_, index) => ({
    id: `rec_${String(offset + index).padStart(16, '0')}`,
    created_at: NOW,
    updated_at: NOW,
    version: 1,
    fields: { [PRIMARY]: `Ticket ${String(offset + index + 1)}` },
  }));
}

type Route = (init: RequestInit | undefined) => Response;

function stubGrid(
  query: Route,
  tables = [table(TABLE, 'Tickets', 0), table(OTHER_TABLE, 'Orders', 1)],
) {
  return stubApi({
    signedIn: true,
    routes: {
      [`GET /bases/${BASE}`]: () => json(base),
      [`GET /bases/${BASE}/tables`]: () =>
        json({ items: tables, total: tables.length, offset: 0, limit: 1000 }),
      [`GET /tables/${TABLE}`]: () => json(tables[0]),
      [`GET /tables/${TABLE}/fields`]: () => json(fields),
      [`POST /tables/${TABLE}/records/query`]: query,
    },
  });
}

describe('GridPage (T202)', () => {
  beforeEach(() => {
    viewSessions.reset();
    window.localStorage.clear();
  });

  it('opens the first table of a base and shows its rows and exact count', async () => {
    const fetchMock = stubGrid(() =>
      json({ records: records(3), total: 3, offset: 0, limit: 200 }),
    );
    const { router } = await renderApp(`/b/${BASE}`);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/b/${BASE}/t/${TABLE}/v/${VIEW}`);
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Tickets' })).toBeInTheDocument();
    expect(await screen.findByText('Ticket 1')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('3 records');
    expect(screen.getByRole('list', { name: 'Records of Tickets' })).toHaveAttribute(
      'data-rows',
      '3',
    );
    // T320b: the tables are in the sidebar, with their record counts (one row, no field asked).
    const tablesNav = screen.getByRole('navigation', { name: 'Tables' });
    expect(within(tablesNav).getByRole('link', { name: 'Orders' })).toHaveAttribute(
      'href',
      `/b/${BASE}/t/${OTHER_TABLE}`,
    );
    expect(within(tablesNav).getByRole('link', { name: 'Tickets' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(await within(tablesNav).findByTestId(`table-count-${TABLE}`)).toHaveTextContent('3');
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) =>
          url.includes(`/tables/${TABLE}/records/query`) &&
          init?.body === JSON.stringify({ limit: 1, fields: [] }),
      ),
    ).toBe(true);
    // Block 0 asks for the count, with ids as keys and json cells (FRONTEND §3.1).
    const call = fetchMock.mock.calls.find(
      ([url, init]) => url.includes('/records/query') && (init?.body as string).includes('view_id'),
    );
    expect(call?.[0]).toContain('field_key_type=id');
    expect(JSON.parse(call?.[1]?.body as string)).toMatchObject({
      view_id: VIEW,
      offset: 0,
      limit: 200,
      include_total: true,
    });
  });

  it('opens the view last used on this device when it is still visible, else the first', async () => {
    const second = defaultView(TABLE, { id: 'viw_Second0000000001', name: 'Open', position: 1 });
    const fetchMock = stubApi({
      signedIn: true,
      routes: {
        [`GET /bases/${BASE}`]: () => json(base),
        [`GET /bases/${BASE}/tables`]: () =>
          json({ items: [table(TABLE, 'Tickets', 0)], total: 1, offset: 0, limit: 1000 }),
        [`GET /tables/${TABLE}`]: () => json(table(TABLE, 'Tickets', 0)),
        [`GET /tables/${TABLE}/fields`]: () => json(fields),
        [`POST /tables/${TABLE}/records/query`]: () =>
          json({ records: records(1), total: 1, offset: 0, limit: 200 }),
      },
      views: { [TABLE]: [defaultView(TABLE), second] },
    });
    window.localStorage.setItem(`cellhive.lastView.${ME.user.id}.${TABLE}`, second.id);
    const { router } = await renderApp(`/b/${BASE}/t/${TABLE}?record=rec_0000000000000000`);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/b/${BASE}/t/${TABLE}/v/${second.id}`);
    });
    expect(router.state.location.search).toBe('?record=rec_0000000000000000');
    expect(await screen.findByRole('link', { name: 'Open', current: 'page' })).toBeInTheDocument();
    const call = fetchMock.mock.calls.find(
      ([url, init]) => url.includes('/records/query') && (init?.body as string).includes('view_id'),
    );
    expect(JSON.parse(call?.[1]?.body as string)).toMatchObject({ view_id: second.id });
    window.localStorage.setItem(`cellhive.lastView.${ME.user.id}.${TABLE}`, 'viw_Deleted000000001');
    await router.navigate(`/b/${BASE}/t/${TABLE}`);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/b/${BASE}/t/${TABLE}/v/${VIEW}`);
    });
  });

  it('a view the user cannot see (or that does not exist) is the 404 screen', async () => {
    stubGrid(() => json({ records: records(1), total: 1, offset: 0, limit: 200 }));
    await renderApp(`/b/${BASE}/t/${TABLE}/v/viw_Hidden0000000001`);
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });

  it('shows "About N records" while only total_estimate is known', async () => {
    stubGrid(() => json({ records: records(200), total_estimate: 250_000, offset: 0, limit: 200 }));
    await renderApp(`/b/${BASE}/t/${TABLE}`);
    expect(await screen.findByText('About 250,000 records')).toBeInTheDocument();
  });

  it('shows the empty state for a table without records', async () => {
    stubGrid(() => json({ records: [], total: 0, offset: 0, limit: 200 }));
    await renderApp(`/b/${BASE}/t/${TABLE}`);
    expect(await screen.findByRole('heading', { name: 'No records yet' })).toBeInTheDocument();
    expect(screen.getByText('0 records')).toBeInTheDocument();
  });

  it('shows a translated error with retry when rows cannot be loaded', async () => {
    let fail = true;
    // A 4xx is not retried by the query client (5xx are, with a back-off).
    stubGrid(() =>
      fail
        ? problem('PERMISSION_DENIED', 403)
        : json({ records: records(2), total: 2, offset: 0, limit: 200 }),
    );
    await renderApp(`/b/${BASE}/t/${TABLE}`);
    const retry = await screen.findByRole('button', { name: 'Try again' }, { timeout: 10_000 });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    fail = false;
    await userEvent.click(retry);
    expect(await screen.findByText('Ticket 2')).toBeInTheDocument();
  });

  it('answers 404 for a table of another base', async () => {
    stubApi({
      signedIn: true,
      routes: {
        [`GET /bases/${BASE}`]: () => json(base),
        [`GET /tables/${TABLE}`]: () => json(table(TABLE, 'Tickets', 0, 'bse_Other00000000001')),
        [`GET /tables/${TABLE}/fields`]: () => json(fields),
      },
    });
    await renderApp(`/b/${BASE}/t/${TABLE}`);
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });

  it('links to the trash only where the user may restore', async () => {
    const tableAccess = (perm: 'read_only' | 'edit', operations: string[]) => ({
      perm,
      operations,
      view_rule: { allow_edit: false, visible_views: null },
      read_scope: 'all',
      fields: {},
      option_edit_fields: [],
      file_download_fields: [],
    });
    const serve = (operations: string[], perm: 'read_only' | 'edit') =>
      stubApi({
        signedIn: true,
        routes: {
          [`GET /bases/${BASE}`]: () =>
            json({
              ...base,
              access: {
                ...base.access,
                is_admin: false,
                tables: { [TABLE]: tableAccess(perm, operations) },
              },
            }),
          [`GET /bases/${BASE}/tables`]: () =>
            json({ items: [table(TABLE, 'Tickets', 0)], total: 1, offset: 0, limit: 1000 }),
          [`GET /tables/${TABLE}`]: () => json(table(TABLE, 'Tickets', 0)),
          [`GET /tables/${TABLE}/fields`]: () => json(fields),
          [`POST /tables/${TABLE}/records/query`]: () =>
            json({ records: records(1), total: 1, offset: 0, limit: 200 }),
        },
      });
    serve(['add', 'delete'], 'edit');
    await renderApp(`/b/${BASE}/t/${TABLE}`);
    expect(await screen.findByRole('link', { name: 'Trash of Tickets' })).toHaveAttribute(
      'href',
      `/b/${BASE}/t/${TABLE}/trash`,
    );
  });

  it('hides the trash link from readers', async () => {
    stubApi({
      signedIn: true,
      routes: {
        [`GET /bases/${BASE}`]: () =>
          json({ ...base, access: { ...base.access, is_admin: false, tables: {} } }),
        [`GET /bases/${BASE}/tables`]: () =>
          json({ items: [table(TABLE, 'Tickets', 0)], total: 1, offset: 0, limit: 1000 }),
        [`GET /tables/${TABLE}`]: () => json(table(TABLE, 'Tickets', 0)),
        [`GET /tables/${TABLE}/fields`]: () => json(fields),
        [`POST /tables/${TABLE}/records/query`]: () =>
          json({ records: records(1), total: 1, offset: 0, limit: 200 }),
      },
    });
    await renderApp(`/b/${BASE}/t/${TABLE}`);
    expect(await screen.findByText('Ticket 1')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Trash of Tickets' })).not.toBeInTheDocument();
  });

  it('saves the row height into the view (row_height) once the user saves', async () => {
    const fetchMock = stubGrid(() =>
      json({ records: records(1), total: 1, offset: 0, limit: 200 }),
    );
    await renderApp(`/b/${BASE}/t/${TABLE}`);
    // T320b: the row height is in the toolbar's "≡" menu.
    await userEvent.click(await screen.findByRole('button', { name: 'More actions' }));
    const comfortable = await screen.findByRole('menuitemradio', { name: 'Comfortable' });
    expect(comfortable).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(comfortable);
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(await screen.findByRole('menuitemradio', { name: 'Comfortable' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await userEvent.keyboard('{Escape}');
    // A temporary change (T311, like Lark) until "Save".
    const unsaved = screen.getByRole('group', { name: 'Unsaved changes' });
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
    await userEvent.click(within(unsaved).getByRole('button', { name: 'Save' }));
    await waitFor(
      () => {
        const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
        expect(patch?.[0]).toContain(`/views/${VIEW}`);
        expect(JSON.parse(patch?.[1]?.body as string)).toEqual({
          config: { row_height: 'medium' },
        });
      },
      { timeout: 3000 },
    );
  });

  describe('editing (T203)', () => {
    const STATUS = 'fld_Status0000000001';
    const statusField = {
      ...fields.items[0],
      id: STATUS,
      name: 'Status',
      type: 'select',
      is_primary: false,
      position: 1,
    };
    const editableFields = { ...fields, items: [...fields.items, statusField], total: 2 };

    function tableAccess(fieldPerms: Record<string, string>, operations: string[], perm = 'edit') {
      return {
        perm,
        operations,
        view_rule: { allow_edit: false, visible_views: null },
        read_scope: 'all',
        fields: fieldPerms,
        option_edit_fields: [],
        file_download_fields: [],
      };
    }

    function serve(access: ReturnType<typeof tableAccess>, extra: Record<string, Route> = {}) {
      let rows = records(3);
      return stubApi({
        signedIn: true,
        routes: {
          [`GET /bases/${BASE}`]: () =>
            json({
              ...base,
              access: { ...base.access, is_admin: false, tables: { [TABLE]: access } },
            }),
          [`GET /bases/${BASE}/tables`]: () =>
            json({ items: [table(TABLE, 'Tickets', 0)], total: 1, offset: 0, limit: 1000 }),
          [`GET /tables/${TABLE}`]: () => json(table(TABLE, 'Tickets', 0)),
          [`GET /tables/${TABLE}/fields`]: () => json(editableFields),
          [`POST /tables/${TABLE}/records/query`]: () =>
            json({ records: rows, total: rows.length, offset: 0, limit: 200 }),
          [`POST /tables/${TABLE}/records`]: () => {
            const created = { ...records(1, 3)[0], fields: {} };
            rows = [...rows, created as (typeof rows)[number]];
            return json({ records: [created] }, 201);
          },
          [`DELETE /tables/${TABLE}/records`]: (init) => {
            const ids = (JSON.parse(init?.body as string) as { ids: string[] }).ids;
            rows = rows.filter((row) => !ids.includes(row.id));
            return json({ ids });
          },
          ...extra,
        },
      });
    }

    it('adds a record at the end with the button', async () => {
      const fetchMock = serve(
        tableAccess({ [PRIMARY]: 'edit', [STATUS]: 'edit' }, ['add', 'delete']),
      );
      await renderApp(`/b/${BASE}/t/${TABLE}`);
      expect(await screen.findByText('3 records')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Add record' }));
      expect(await screen.findByText('4 records')).toBeInTheDocument();
      const call = fetchMock.mock.calls.find(
        ([url, init]) => init?.method === 'POST' && /\/records\?/u.test(url),
      );
      expect(JSON.parse(call?.[1]?.body as string)).toEqual({ records: [{ fields: {} }] });
      expect(new Headers(call?.[1]?.headers).get('idempotency-key')).toMatch(/^web-/u);
    });

    it('deletes the selected rows after confirming', async () => {
      const fetchMock = serve(tableAccess({ [PRIMARY]: 'edit' }, ['delete']));
      await renderApp(`/b/${BASE}/t/${TABLE}`);
      expect(await screen.findByText('3 records')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Add record' })).not.toBeInTheDocument();
      // T320b: "Delete N records" shows only while rows are selected — T322a: whole
      // rows (row markers), not a cell range.
      expect(screen.queryByRole('button', { name: /^Delete/u })).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'select cells 1-2' }));
      expect(screen.queryByRole('button', { name: /^Delete/u })).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'select rows 1-2' }));
      await userEvent.click(screen.getByRole('button', { name: 'Delete 2 records' }));
      const dialog = screen.getByRole('dialog', { name: 'Delete 2 records?' });
      expect(dialog).toHaveTextContent('They move to the trash of Tickets');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Delete 2 records' }));
      expect(await screen.findByText('2 records moved to the trash.')).toBeInTheDocument();
      expect(await screen.findByText('1 record')).toBeInTheDocument();
      const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE');
      expect(JSON.parse(call?.[1]?.body as string)).toEqual({
        ids: [records(1)[0]?.id, records(1, 1)[0]?.id],
      });
    });

    it('offers editing only for the fields the role may edit (read → disabled)', async () => {
      serve(tableAccess({ [PRIMARY]: 'edit', [STATUS]: 'read' }, ['add']));
      await renderApp(`/b/${BASE}/t/${TABLE}`);
      expect(await screen.findByText('3 records')).toBeInTheDocument();
      expect(screen.getByRole('list', { name: 'Records of Tickets' })).toHaveAttribute(
        'data-editable',
        'Title',
      );
    });

    it('readers get a read-only grid without record actions', async () => {
      serve(tableAccess({ [PRIMARY]: 'read', [STATUS]: 'read' }, [], 'read_only'));
      await renderApp(`/b/${BASE}/t/${TABLE}`);
      expect(await screen.findByText('3 records')).toBeInTheDocument();
      expect(screen.getByRole('list', { name: 'Records of Tickets' })).toHaveAttribute(
        'data-editable',
        '',
      );
      expect(screen.queryByRole('button', { name: 'Add record' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Delete/u })).not.toBeInTheDocument();
    });

    it('a refused write (403) rolls back and explains', async () => {
      serve(tableAccess({ [PRIMARY]: 'edit' }, []), {
        [`PATCH /tables/${TABLE}/records`]: () => problem('RECORD_RULE_VIOLATION', 403),
      });
      await renderApp(`/b/${BASE}/t/${TABLE}`);
      expect(await screen.findByText('Ticket 1')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'rename row 1' }));
      expect(
        await screen.findByText(
          'This change would move the record outside the records you may edit.',
        ),
      ).toBeInTheDocument();
      expect(screen.getByText('Ticket 1')).toBeInTheDocument();
    });
  });

  describe('clipboard, undo and shortcuts (T205)', () => {
    beforeEach(() => {
      resetUndoHistories();
    });

    function serveBulk(copy: boolean) {
      let rows = records(3);
      return stubApi({
        signedIn: true,
        routes: {
          [`GET /bases/${BASE}`]: () =>
            json({
              ...base,
              access: {
                ...base.access,
                is_admin: false,
                base_rule: { ...base.access.base_rule, copy },
                tables: {
                  [TABLE]: {
                    perm: 'edit',
                    operations: ['add'],
                    view_rule: { allow_edit: false, visible_views: null },
                    read_scope: 'all',
                    fields: { [PRIMARY]: 'edit' },
                    option_edit_fields: [],
                    file_download_fields: [],
                  },
                },
              },
            }),
          [`GET /bases/${BASE}/tables`]: () =>
            json({ items: [table(TABLE, 'Tickets', 0)], total: 1, offset: 0, limit: 1000 }),
          [`GET /tables/${TABLE}`]: () => json(table(TABLE, 'Tickets', 0)),
          [`GET /tables/${TABLE}/fields`]: () => json(fields),
          [`POST /tables/${TABLE}/records/query`]: () =>
            json({ records: rows, total: rows.length, offset: 0, limit: 200 }),
          [`PATCH /tables/${TABLE}/records`]: (init) => {
            const body = JSON.parse(init?.body as string) as {
              records: { id: string; fields: Record<string, unknown> }[];
            };
            rows = rows.map((row) => {
              const item = body.records.find((candidate) => candidate.id === row.id);
              return item === undefined
                ? row
                : { ...row, version: row.version + 1, fields: { ...row.fields, ...item.fields } };
            });
            return json({
              records: rows.filter((row) => body.records.some((item) => item.id === row.id)),
            });
          },
        },
      });
    }

    const patches = (fetchMock: ReturnType<typeof stubApi>) =>
      fetchMock.mock.calls
        .filter(([, init]) => init?.method === 'PATCH')
        .map(([url, init]) => ({ url, body: JSON.parse(init?.body as string) as unknown }));

    it('pastes rows as one bulk PATCH with typecast, then undoes and redoes it', async () => {
      const fetchMock = serveBulk(true);
      await renderApp(`/b/${BASE}/t/${TABLE}`);
      expect(await screen.findByText('Ticket 1')).toBeInTheDocument();
      const undo = screen.getByRole('button', { name: 'Undo' });
      const redo = screen.getByRole('button', { name: 'Redo' });
      expect(undo).toBeDisabled();
      expect(redo).toBeDisabled();

      await userEvent.click(screen.getByRole('button', { name: 'paste 2 rows' }));
      expect(await screen.findByText('Pasted B')).toBeInTheDocument();
      await waitFor(() => {
        expect(undo).toBeEnabled();
      });
      const [paste] = patches(fetchMock);
      expect(paste?.url).toContain('typecast=true');
      expect(paste?.body).toEqual({
        records: [
          { id: records(1)[0]?.id, version: 1, fields: { [PRIMARY]: 'Pasted A' } },
          { id: records(1, 1)[0]?.id, version: 1, fields: { [PRIMARY]: 'Pasted B' } },
        ],
      });

      await userEvent.click(undo);
      expect(await screen.findByText('Ticket 2')).toBeInTheDocument();
      const [, reverted] = patches(fetchMock);
      expect(reverted?.url).not.toContain('typecast');
      expect(reverted?.body).toEqual({
        records: [
          { id: records(1)[0]?.id, version: 2, fields: { [PRIMARY]: 'Ticket 1' } },
          { id: records(1, 1)[0]?.id, version: 2, fields: { [PRIMARY]: 'Ticket 2' } },
        ],
      });
      await waitFor(() => {
        expect(redo).toBeEnabled();
      });
      expect(undo).toBeDisabled();

      // Ctrl+Shift+Z redoes.
      await userEvent.keyboard('{Control>}{Shift>}z{/Shift}{/Control}');
      expect(await screen.findByText('Pasted A')).toBeInTheDocument();
      expect(patches(fetchMock)[2]?.body).toMatchObject({
        records: [{ version: 3, fields: { [PRIMARY]: 'Pasted A' } }, { version: 3 }],
      });
    });

    it('copies the selection as TSV, or refuses when the role may not copy', async () => {
      serveBulk(true);
      await renderApp(`/b/${BASE}/t/${TABLE}`);
      expect(await screen.findByText('Ticket 1')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'copy rows 1-2' }));
      expect(document.body.dataset['copied']).toBe('Ticket 1\nTicket 2');
    });

    it('base_rule.copy = false: nothing is copied and a toast explains', async () => {
      serveBulk(false);
      await renderApp(`/b/${BASE}/t/${TABLE}`);
      expect(await screen.findByText('Ticket 1')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'copy rows 1-2' }));
      expect(document.body.dataset['copied']).toBe('refused');
      expect(
        await screen.findByText('Copying is turned off for your role in this base.'),
      ).toBeInTheDocument();
    });

    it('? opens the keyboard shortcuts', async () => {
      serveBulk(true);
      await renderApp(`/b/${BASE}/t/${TABLE}`);
      expect(await screen.findByText('Ticket 1')).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'copy rows 1-2' }));
      await userEvent.keyboard('?');
      const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
      expect(within(dialog).getByRole('rowheader', { name: 'Undo' })).toBeInTheDocument();
      expect(
        within(dialog).getByText('Fill down from the first cell of the selection'),
      ).toBeInTheDocument();
    });
  });

  it('selectedRecordIds: loaded records of the selected rows, once each', () => {
    const rows = records(5);
    const loader = { getRecord: (row: number) => (row < 3 ? rows[row] : undefined) };
    expect(
      selectedRecordIds(
        [
          { firstRow: 0, lastRow: 1, fieldIds: [] },
          { firstRow: 1, lastRow: 4, fieldIds: [] },
        ],
        loader,
      ),
    ).toEqual([rows[0]?.id, rows[1]?.id, rows[2]?.id]);
  });
});
