import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultView, json, ME, ORG, renderApp, stubApi } from '../../../../test/app-harness';
import { axeViolations } from '../../../../test/axe';
import { AUTOSAVE_DELAY_MS, viewSessions } from '../../../lib/views/session';

import type { GridViewProps } from '../../../grid';

// The canvas grid needs a real browser (E2E); here each column is a list item
// with buttons standing in for the header menu, a drag and a resize.
vi.mock('../../../grid/GridView', () => ({
  GridView: ({
    fields,
    rowCount,
    onViewportChange,
    hooks,
    widths,
    freezeColumns,
    label,
  }: GridViewProps) => {
    useEffect(() => {
      onViewportChange({ firstRow: 0, lastRow: Math.min(rowCount, 20) - 1, dragging: false });
    }, [onViewportChange, rowCount]);
    return (
      <ul aria-label={label} data-frozen={freezeColumns}>
        {fields.map(({ field }, index) => (
          <li key={field.id} data-width={widths?.[field.id] ?? ''}>
            <button
              type="button"
              onClick={() => {
                hooks?.headerMenu?.onHeaderMenu(field.id, { x: 10, y: 10, width: 100, height: 36 });
              }}
            >
              {`Header ${field.name}`}
            </button>
            {hooks?.columns?.onColumnMove !== undefined && index > 0 ? (
              <button
                type="button"
                onClick={() => {
                  const target = fields[fields.length - 1];
                  if (target !== undefined)
                    hooks.columns?.onColumnMove?.(field.id, target.field.id);
                }}
              >
                {`Drag ${field.name} to the end`}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => {
                hooks?.columns?.onColumnResize?.(field.id, 321, true);
              }}
            >
              {`Resize ${field.name}`}
            </button>
          </li>
        ))}
      </ul>
    );
  },
}));

const BASE = 'bse_Sales00000000001';
const TABLE = 'tbl_Tickets000000001';
const NOW = '2026-09-24T00:00:00.000Z';

const field = (id: string, name: string, position: number, primary = false) => ({
  id,
  table_id: TABLE,
  name,
  type: 'text',
  options: {},
  is_primary: primary,
  required: false,
  unique_values: false,
  description: null,
  position,
  created_at: NOW,
  updated_at: NOW,
});

const TITLE = field('fld_Title00000000001', 'Title', 0, true);
const NOTES = field('fld_Notes00000000001', 'Notes', 1);
const CODE = field('fld_Code000000000001', 'Code', 2);
const VIEW = defaultView(TABLE).id;

function base(kind: 'admin' | 'manager' | 'editor') {
  return {
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
      is_admin: kind === 'admin',
      base_rule: { copy: true, download: true, share_link: true },
      tables:
        kind === 'admin'
          ? {}
          : {
              [TABLE]: {
                perm: kind === 'manager' ? 'manage' : 'edit',
                operations: ['add'],
                view_rule: { allow_edit: false, visible_views: null },
                read_scope: 'all',
                fields: {},
                option_edit_fields: [],
                file_download_fields: [],
              },
            },
      dashboards: {},
    },
  };
}

function serve(
  kind: 'admin' | 'manager' | 'editor',
  extra: Record<string, () => Response> = {},
  view: Record<string, unknown> = {},
) {
  const table = {
    id: TABLE,
    base_id: BASE,
    name: 'Tickets',
    description: null,
    primary_field_id: TITLE.id,
    position: 0,
    schema_state: 'ready',
    created_at: NOW,
    updated_at: NOW,
  };
  return stubApi({
    signedIn: true,
    routes: {
      [`GET /bases/${BASE}`]: () => json(base(kind)),
      [`GET /bases/${BASE}/tables`]: () =>
        json({ items: [table], total: 1, offset: 0, limit: 1000 }),
      [`GET /tables/${TABLE}`]: () => json(table),
      [`GET /tables/${TABLE}/fields`]: () =>
        json({ items: [TITLE, NOTES, CODE], total: 3, offset: 0, limit: 1000 }),
      [`POST /tables/${TABLE}/records/query`]: () =>
        json({ records: [], total: 0, offset: 0, limit: 200 }),
      ...extra,
    },
    views: { [TABLE]: [defaultView(TABLE, view)] },
  });
}

async function openMenu(name: string) {
  await userEvent.click(await screen.findByRole('button', { name: `Header ${name}` }));
  return screen.findByRole('menu');
}

beforeEach(() => {
  viewSessions.reset();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('column header menu (T207)', () => {
  it('offers field configuration to schema managers', async () => {
    serve('manager');
    await renderApp(`/b/${BASE}/t/${TABLE}`);
    const menu = await openMenu('Notes');
    const items = within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.textContent);
    expect(items).toEqual([
      'Edit field',
      'Rename',
      'Insert field left',
      'Insert field right',
      'Sort ascending',
      'Sort descending',
      'Freeze up to this field',
      'Hide field',
      'Delete field',
    ]);
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('keeps the primary field: no hide, no insert left, delete disabled', async () => {
    serve('admin');
    await renderApp(`/b/${BASE}/t/${TABLE}`);
    const menu = await openMenu('Title');
    expect(within(menu).queryByRole('menuitem', { name: 'Hide field' })).not.toBeInTheDocument();
    expect(
      within(menu).queryByRole('menuitem', { name: 'Insert field left' }),
    ).not.toBeInTheDocument();
    expect(
      within(menu).getByRole('menuitem', { name: 'The primary field cannot be deleted' }),
    ).toHaveAttribute('aria-disabled', 'true');
  });

  it('shows no schema action to an editor (P05) — only view actions', async () => {
    serve('editor');
    await renderApp(`/b/${BASE}/t/${TABLE}`);
    const menu = await openMenu('Notes');
    const items = within(menu)
      .getAllByRole('menuitem')
      .map((item) => item.textContent);
    expect(items).toEqual([
      'Sort ascending',
      'Sort descending',
      'Freeze up to this field',
      'Hide field',
    ]);
    expect(screen.queryByRole('button', { name: 'Add field' })).not.toBeInTheDocument();
    // Column order is a view setting (T310), not a schema change: everyone may drag.
    expect(screen.getAllByRole('button', { name: /^Drag / })).toHaveLength(2);
  });

  it('opens the field dialog from the menu and the toolbar', async () => {
    serve('admin');
    await renderApp(`/b/${BASE}/t/${TABLE}`);
    const menu = await openMenu('Notes');
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Edit field' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit field' });
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Notes');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    // T320b: "Add field" is in the toolbar's "≡" menu.
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Add field' }));
    expect(await screen.findByRole('dialog', { name: 'New field' })).toBeInTheDocument();
  });

  it('inserts a field right of a column at its place in the order', async () => {
    const fetchMock = serve('admin', {
      [`POST /tables/${TABLE}/fields`]: () => json(field('fld_New0000000000001', 'New', 3), 201),
      'PATCH /fields/fld_New0000000000001': () => json(field('fld_New0000000000001', 'New', 2)),
    });
    await renderApp(`/b/${BASE}/t/${TABLE}`);
    const menu = await openMenu('Notes');
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Insert field right' }));
    const dialog = await screen.findByRole('dialog', { name: 'New field' });
    await userEvent.type(within(dialog).getByLabelText('Name'), 'New');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create field' }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) => init?.method === 'PATCH' && url.endsWith('/fields/fld_New0000000000001'),
        ),
      ).toBe(true);
    });
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(patch?.[1]?.body as string)).toEqual({ position: 2 });
  });

  it('hides a field and lists hidden fields in the toolbar', async () => {
    serve('editor');
    await renderApp(`/b/${BASE}/t/${TABLE}`);
    const menu = await openMenu('Notes');
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Hide field' }));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Header Notes' })).not.toBeInTheDocument();
    });
    const toggle = screen.getByRole('button', { name: '1 hidden field' });
    await userEvent.click(toggle);
    const panel = await screen.findByRole('dialog', { name: 'Shown fields' });
    // The primary field cannot be hidden; the others are switches (they apply at once).
    expect(await within(panel).findByRole('switch', { name: 'Show Title' })).toBeDisabled();
    await userEvent.click(within(panel).getByRole('switch', { name: 'Show Notes' }));
    expect(await screen.findByRole('button', { name: 'Header Notes' })).toBeInTheDocument();
    expect(window.localStorage.getItem(`cellhive.gridLayout.${TABLE}`)).toBeNull();
  });

  it('sorts from the menu (a temporary sort replacing the view sort) and discards it', async () => {
    const fetchMock = serve('editor');
    await renderApp(`/b/${BASE}/t/${TABLE}`);
    const menu = await openMenu('Code');
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Sort descending' }));
    expect(await screen.findByRole('button', { name: 'Sort: Code' })).toBeInTheDocument();
    const bodies = () =>
      fetchMock.mock.calls
        .filter(([url]) => url.includes('/records/query'))
        .map(([, init]) => JSON.parse(init?.body as string) as Record<string, unknown>);
    await waitFor(() => {
      expect(bodies().at(-1)).toMatchObject({
        sort: [{ field: CODE.id, direction: 'desc' }],
        sort_mode: 'replace',
      });
    });
    // Temporary (T311): nothing saved, "Unsaved changes" offers to discard it.
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
    const unsaved = screen.getByRole('group', { name: 'Unsaved changes' });
    await userEvent.click(within(unsaved).getByRole('button', { name: 'Discard' }));
    // Back to the saved (unsorted) rows, already cached: no new request needed.
    expect(await screen.findByRole('button', { name: 'Sort' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Unsaved changes' })).not.toBeInTheDocument();
  });

  it('without view rights: freeze and widths stay on this device as unsaved changes', async () => {
    const fetchMock = serve('editor');
    await renderApp(`/b/${BASE}/t/${TABLE}`);
    const grid = await screen.findByRole('list', { name: 'Records of Tickets' });
    expect(grid).toHaveAttribute('data-frozen', '1');
    const menu = await openMenu('Notes');
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Freeze up to this field' }));
    await waitFor(() => {
      expect(grid).toHaveAttribute('data-frozen', '2');
    });
    await userEvent.click(screen.getByRole('button', { name: 'Resize Code' }));
    expect(screen.getByRole('button', { name: 'Resize Code' }).closest('li')).toHaveAttribute(
      'data-width',
      '321',
    );
    expect(
      JSON.parse(window.localStorage.getItem(`cellhive.viewDraft.${ME.user.id}.${VIEW}`) ?? '{}'),
    ).toEqual({
      frozen_count: 2,
      column_widths: { [CODE.id]: 321 },
    });
    const unsaved = screen.getByRole('group', { name: 'Unsaved changes' });
    expect(within(unsaved).queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(
      within(unsaved).getByRole('button', { name: 'Save as personal view' }),
    ).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, AUTOSAVE_DELAY_MS + 100));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
    // Discard: back to the saved layout.
    await userEvent.click(within(unsaved).getByRole('button', { name: 'Discard' }));
    await waitFor(() => {
      expect(grid).toHaveAttribute('data-frozen', '1');
    });
    expect(window.localStorage.getItem(`cellhive.viewDraft.${ME.user.id}.${VIEW}`)).toBeNull();
  });

  it('with schema rights: dragging a header saves the view field_order (not position)', async () => {
    const fetchMock = serve('manager');
    await renderApp(`/b/${BASE}/t/${TABLE}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Drag Notes to the end' }));
    await waitFor(
      () => {
        const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
        expect(patch?.[0]).toContain(`/views/${VIEW}`);
        expect(JSON.parse(patch?.[1]?.body as string)).toEqual({
          config: { field_order: [CODE.id, NOTES.id] },
        });
      },
      { timeout: 3000 },
    );
    expect(fetchMock.mock.calls.some(([url]) => url.includes('/fields/'))).toBe(false);
    expect(screen.queryByRole('group', { name: 'Unsaved changes' })).not.toBeInTheDocument();
  });

  it('a locked view keeps changes on this device even for schema managers', async () => {
    const fetchMock = serve('admin', {}, { locked: true });
    await renderApp(`/b/${BASE}/t/${TABLE}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Resize Code' }));
    const unsaved = await screen.findByRole('group', { name: 'Unsaved changes' });
    expect(unsaved).toHaveTextContent('This view is locked');
    await new Promise((resolve) => setTimeout(resolve, AUTOSAVE_DELAY_MS + 100));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  });

  it('moves the T207 device layout into unsaved changes once, then deletes the old key', async () => {
    window.localStorage.setItem(
      `cellhive.gridLayout.${TABLE}`,
      JSON.stringify({ hidden: [NOTES.id], frozen: 1, widths: { [CODE.id]: 250 }, sort: null }),
    );
    const fetchMock = serve('admin');
    await renderApp(`/b/${BASE}/t/${TABLE}`);
    await screen.findByRole('button', { name: 'Header Code' });
    expect(screen.queryByRole('button', { name: 'Header Notes' })).not.toBeInTheDocument();
    expect(window.localStorage.getItem(`cellhive.gridLayout.${TABLE}`)).toBeNull();
    const unsaved = screen.getByRole('group', { name: 'Unsaved changes' });
    // Never saved silently into the shared view.
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
    await userEvent.click(within(unsaved).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
      expect(JSON.parse(patch?.[1]?.body as string)).toEqual({
        config: { hidden_fields: [NOTES.id], column_widths: { [CODE.id]: 250 } },
      });
    });
    await waitFor(() => {
      expect(screen.queryByRole('group', { name: 'Unsaved changes' })).not.toBeInTheDocument();
    });
  });
});
