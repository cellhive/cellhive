import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultView, json, ME, renderApp, stubApi } from '../../../../test/app-harness';
import { axeViolations } from '../../../../test/axe';
import { resetUndoHistories } from '../../../grid/undo/table-undo';
import { viewSessions } from '../../../lib/views/session';
import { collapseStore } from '../groups/collapse';

import type { GridViewProps } from '../../../grid';

// The canvas grid needs a real browser (E2E); here it lists the display rows it would draw.
vi.mock('../../../grid/GridView', () => ({
  GridView: ({
    rowCount,
    rowModel,
    getRecord,
    onViewportChange,
    label,
    fields,
    hooks,
  }: GridViewProps) => {
    useEffect(() => {
      onViewportChange({ firstRow: 0, lastRow: Math.max(0, rowCount - 1), dragging: false });
    }, [onViewportChange, rowCount, rowModel]);
    const primary = fields[0]?.field.id ?? '';
    const count = Math.min(rowModel?.displayCount ?? rowCount, 40);
    return (
      <ul aria-label={label} data-rows={rowCount}>
        <li>
          <button
            type="button"
            onClick={() => {
              // A paste of two lines on the last row of the first group (data row 1).
              hooks?.selection?.onPaste?.(
                { firstRow: 1, lastRow: 1, fieldIds: [primary] },
                'Pasted A\r\nPasted B\r\n',
              );
            }}
          >
            paste 2 rows
          </button>
        </li>
        {Array.from({ length: count }, (_, display) => {
          const kind = rowModel?.rowAt(display) ?? {
            kind: 'data' as const,
            row: display,
            number: display + 1,
            frame: { depth: 0, top: false, bottom: false },
          };
          if (kind.kind === 'gap') return null;
          if (kind.kind === 'add') {
            const { group } = kind;
            return (
              <li key={`a${String(display)}`} data-testid="add-row">
                <button
                  type="button"
                  onClick={() => {
                    hooks?.groups?.onAdd?.(group.key);
                  }}
                >
                  {`add in ${typeof group.value === 'string' ? group.value : ''}`}
                </button>
              </li>
            );
          }
          if (kind.kind === 'group') {
            const { group } = kind;
            const name = `${typeof group.value === 'string' ? group.value : 'Empty'} (${String(group.count)})${group.collapsed ? ' collapsed' : ''}`;
            return (
              <li key={`h${String(display)}`} data-testid="group-header">
                <button
                  type="button"
                  onClick={() => {
                    hooks?.groups?.onToggle(group.key);
                  }}
                >
                  {name}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    hooks?.groups?.onMenu?.(group.key, { x: 0, y: 0, width: 10, height: 10 });
                  }}
                >
                  {`menu of ${typeof group.value === 'string' ? group.value : 'Empty'}`}
                </button>
              </li>
            );
          }
          const record = getRecord(kind.row);
          return (
            <li key={`r${String(display)}`} data-testid="data-row">
              {record === undefined ? 'loading' : String(record.fields[primary])}
            </li>
          );
        })}
      </ul>
    );
  },
}));

const BASE = 'bse_Sales00000000001';
const TABLE = 'tbl_Tickets000000001';
const PRIMARY = 'fld_Title00000000001';
const STATUS = 'fld_Status0000000001';
const NOW = '2026-09-24T00:00:00.000Z';
const VIEW = defaultView(TABLE).id;

const base = {
  id: BASE,
  organization_id: 'org_0123456789ABCDEF',
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
    is_admin: false,
    base_rule: { copy: true, download: true, share_link: true },
    tables: {
      [TABLE]: {
        perm: 'edit',
        operations: ['add'],
        view_rule: { allow_edit: false, visible_views: null },
        read_scope: 'all',
        fields: { [PRIMARY]: 'edit', [STATUS]: 'edit' },
        option_edit_fields: [],
        file_download_fields: [],
      },
    },
    dashboards: {},
  },
};

const tableDto = {
  id: TABLE,
  base_id: BASE,
  name: 'Tickets',
  description: null,
  primary_field_id: PRIMARY,
  position: 0,
  schema_state: 'ready',
  created_at: NOW,
  updated_at: NOW,
};

const field = (id: string, name: string, type: string, options: object, position: number) => ({
  id,
  table_id: TABLE,
  name,
  type,
  options,
  is_primary: id === PRIMARY,
  required: false,
  unique_values: false,
  description: null,
  position,
  created_at: NOW,
  updated_at: NOW,
});

const fields = {
  items: [
    field(PRIMARY, 'Title', 'text', {}, 0),
    field(
      STATUS,
      'Status',
      'select',
      {
        multiple: false,
        options: [
          { id: 'opt_New0000000000001', name: 'New', color: 0 },
          { id: 'opt_Done000000000001', name: 'Done', color: 1 },
        ],
      },
      1,
    ),
  ],
  total: 2,
  offset: 0,
  limit: 1000,
};

/** Rows of the server in group order: `groups` gives each status and how many. */
function server(groups: [string, number][]) {
  const rows = groups.flatMap(([status, count]) => Array.from({ length: count }, () => status));
  const offsets: number[] = [];
  const posted: unknown[] = [];
  const patched: unknown[] = [];
  const record = (index: number) => ({
    id: `rec_${String(index).padStart(16, '0')}`,
    created_at: NOW,
    updated_at: NOW,
    version: 1,
    fields: { [PRIMARY]: `${rows[index] ?? ''} ${String(index + 1)}`, [STATUS]: rows[index] },
  });
  const fetchMock = stubApi({
    signedIn: true,
    views: {
      [TABLE]: [
        defaultView(TABLE, {
          config: {
            ...defaultView(TABLE).config,
            group: [{ field: STATUS, direction: 'asc' }],
          },
        }),
      ],
    },
    routes: {
      [`GET /bases/${BASE}`]: () => json(base),
      [`GET /bases/${BASE}/tables`]: () =>
        json({ items: [tableDto], total: 1, offset: 0, limit: 1000 }),
      [`GET /tables/${TABLE}`]: () => json(tableDto),
      [`GET /tables/${TABLE}/fields`]: () => json(fields),
      [`POST /tables/${TABLE}/records/group-counts`]: () =>
        json({
          group: [{ field: STATUS, direction: 'asc' }],
          groups: groups.map(([status, count]) => ({ values: [status], count })),
          truncated: false,
        }),
      [`POST /tables/${TABLE}/records/query`]: (init) => {
        const body = JSON.parse(init?.body as string) as { offset?: number; limit: number };
        // Rows only: the sidebar's table count (T320b) asks for one row without an offset.
        if (body.offset === undefined)
          return json({ records: [], offset: 0, limit: 1, total: rows.length });
        const offset = body.offset;
        offsets.push(offset);
        const end = Math.min(rows.length, offset + body.limit);
        const records = Array.from({ length: Math.max(0, end - offset) }, (_, at) =>
          record(offset + at),
        );
        return json({
          records,
          offset: body.offset,
          limit: body.limit,
          ...(body.offset === 0 ? { total: rows.length } : {}),
        });
      },
      [`POST /tables/${TABLE}/records`]: (init) => {
        posted.push(JSON.parse(init?.body as string));
        return json({ records: [record(rows.length)] });
      },
      [`PATCH /tables/${TABLE}/records`]: (init) => {
        const body = JSON.parse(init?.body as string) as {
          records: { id: string; fields: object }[];
        };
        patched.push(body);
        return json({
          records: body.records.map((item) => ({
            ...record(Number(item.id.slice(4))),
            version: 2,
            fields: { ...record(Number(item.id.slice(4))).fields, ...item.fields },
          })),
        });
      },
    },
  });
  return { fetchMock, offsets, posted, patched };
}

const collapseKey = `cellhive.groupCollapse.${ME.user.id}.${VIEW}`;

describe('GridPage grouped (T312)', () => {
  beforeEach(() => {
    viewSessions.reset();
    collapseStore.reset();
    resetUndoHistories();
    window.localStorage.clear();
  });

  it('shows a header per group with its count, in the order of group-counts', async () => {
    const { fetchMock } = server([
      ['New', 2],
      ['Done', 1],
    ]);
    await renderApp(`/b/${BASE}/t/${TABLE}`);
    const headers = await screen.findAllByTestId('group-header');
    expect(headers.map((item) => item.textContent)).toEqual([
      'New (2)menu of New',
      'Done (1)menu of Done',
    ]);
    // Every group ends with a "+" row (T320a).
    expect(screen.getAllByTestId('add-row').map((item) => item.textContent)).toEqual([
      'add in New',
      'add in Done',
    ]);
    await waitFor(() => {
      expect(screen.getAllByTestId('data-row').map((item) => item.textContent)).toEqual([
        'New 1',
        'New 2',
        'Done 3',
      ]);
    });
    expect(screen.getByRole('status')).toHaveTextContent('3 records · 2 groups');
    // Same query as the grid: through the view.
    const call = fetchMock.mock.calls.find(([url]) => url.includes('/group-counts'));
    expect(JSON.parse(call?.[1]?.body as string)).toMatchObject({ view_id: VIEW });
  });

  it('collapse is per user and view on this device, and survives a reload', async () => {
    server([
      ['New', 2],
      ['Done', 1],
    ]);
    const first = await renderApp(`/b/${BASE}/t/${TABLE}`);
    await userEvent.click(await screen.findByRole('button', { name: 'New (2)' }));
    expect(await screen.findByRole('button', { name: 'New (2) collapsed' })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getAllByTestId('data-row').map((item) => item.textContent)).toEqual(['Done 3']);
    });
    expect(window.localStorage.getItem(collapseKey)).toContain('except');
    // Not in the view: no PATCH of its config.
    first.router.dispose();
    collapseStore.reset();
    document.body.innerHTML = '';
    await renderApp(`/b/${BASE}/t/${TABLE}`);
    expect(await screen.findByRole('button', { name: 'New (2) collapsed' })).toBeInTheDocument();
    // Collapse all / expand all from a header's menu (T320a: no toolbar line for them).
    await userEvent.click(screen.getByRole('button', { name: 'menu of New' }));
    const menu = await screen.findByRole('menu', { name: 'Group menu: Status: New' });
    // One level: no subgroup items; a record may be added from the menu (keyboard way to "+").
    expect(within(menu).queryByRole('menuitem', { name: 'Collapse subgroups' })).toBeNull();
    expect(
      within(menu).getByRole('menuitem', { name: 'Add a record to this group' }),
    ).toBeVisible();
    expect(await axeViolations(menu)).toEqual([]);
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Expand all groups' }));
    expect(await screen.findByRole('button', { name: 'New (2)' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Expand all groups' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'menu of Done' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Collapse all groups' }));
    expect(await screen.findByRole('button', { name: 'Done (1) collapsed' })).toBeInTheDocument();
    // And from the group panel of the toolbar.
    await userEvent.click(screen.getByTestId('group-button'));
    const panel = await screen.findByRole('dialog', { name: 'Group' });
    await userEvent.click(within(panel).getByRole('button', { name: 'Expand all' }));
    expect(await screen.findByRole('button', { name: 'Done (1)' })).toBeInTheDocument();
  });

  it('rows of a collapsed group are never fetched', async () => {
    window.localStorage.setItem(collapseKey, JSON.stringify({ mode: 'collapsed', except: [] }));
    const { offsets } = server([
      ['New', 450],
      ['Done', 5],
    ]);
    await renderApp(`/b/${BASE}/t/${TABLE}`);
    expect(await screen.findByRole('button', { name: 'New (450) collapsed' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Done (5) collapsed' }));
    await waitFor(() => {
      expect(screen.getAllByTestId('data-row')[0]).toHaveTextContent('Done 451');
    });
    // Done's rows are offsets 450–454: block 2 only; New's blocks 0–1 are never asked for.
    expect(offsets).toEqual([400]);
  });

  it('the "+" row of a group adds a record with the group value filled in', async () => {
    const { posted } = server([
      ['New', 1],
      ['Done', 1],
    ]);
    await renderApp(`/b/${BASE}/t/${TABLE}`);
    await userEvent.click(await screen.findByRole('button', { name: 'add in Done' }));
    await waitFor(() => {
      expect(posted).toEqual([{ records: [{ fields: { [STATUS]: 'Done' } }] }]);
    });
  });

  it('a paste over two rows across a header writes the data rows on both sides', async () => {
    const { patched } = server([
      ['New', 2],
      ['Done', 2],
    ]);
    await renderApp(`/b/${BASE}/t/${TABLE}`);
    const list = await screen.findByRole('list', { name: 'Records of Tickets' });
    await waitFor(() => {
      expect(within(list).getAllByTestId('data-row')[3]).toHaveTextContent('Done 4');
    });
    await userEvent.click(screen.getByRole('button', { name: 'paste 2 rows' }));
    await waitFor(() => {
      expect(patched).toHaveLength(1);
    });
    const body = patched[0] as { records: { id: string; fields: object }[] };
    // Data row 1 (last of New) and data row 2 (first of Done): the header between is no row.
    expect(body.records.map((item) => [item.id, item.fields])).toEqual([
      ['rec_0000000000000001', { [PRIMARY]: 'Pasted A' }],
      ['rec_0000000000000002', { [PRIMARY]: 'Pasted B' }],
    ]);
  });
});
