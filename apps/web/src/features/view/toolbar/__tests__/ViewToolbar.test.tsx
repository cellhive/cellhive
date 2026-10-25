import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultView, json, ORG, renderApp, stubApi } from '../../../../../test/app-harness';
import { axeViolations } from '../../../../../test/axe';
import { viewSessions } from '../../../../lib/views/session';
import { SEARCH_DEBOUNCE_MS } from '../ViewSearch';

import type { GridViewProps } from '../../../../grid';

// The canvas grid needs a real browser (E2E): a list of the rows, plus Shift+Enter's hook.
vi.mock('../../../../grid/GridView', () => ({
  GridView: ({ rowCount, getRecord, onViewportChange, label, fields, hooks }: GridViewProps) => {
    useEffect(() => {
      onViewportChange({ firstRow: 0, lastRow: Math.min(rowCount, 20) - 1, dragging: false });
    }, [onViewportChange, rowCount]);
    const primary = fields[0]?.field.id ?? '';
    return (
      <ul aria-label={label} data-rows={rowCount}>
        <li>
          <button
            type="button"
            disabled={hooks?.rows === undefined}
            onClick={() => {
              hooks?.rows?.onAddRow(0, 1);
            }}
          >
            shift enter on row 1
          </button>
        </li>
        {Array.from({ length: Math.min(rowCount, 3) }, (_, row) => getRecord(row)).map(
          (record, row) => (
            <li key={record?.id ?? `loading-${String(row)}`}>
              {record === undefined ? 'loading' : String(record.fields[primary])}
            </li>
          ),
        )}
      </ul>
    );
  },
}));

const BASE = 'bse_Sales00000000001';
const TABLE = 'tbl_Orders0000000001';
const NOW = '2026-09-24T00:00:00.000Z';
const VIEW = defaultView(TABLE).id;
const F = {
  title: 'fld_Title00000000001',
  status: 'fld_Status0000000001',
  amount: 'fld_Amount0000000001',
};
const OPT_NEW = 'opt_New0000000000001';
const OPT_DONE = 'opt_Done000000000001';

type Kind = 'admin' | 'reader';

function base(kind: Kind) {
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
      tables: {
        [TABLE]: {
          perm: kind === 'admin' ? 'manage' : 'read_only',
          operations: kind === 'admin' ? ['add', 'delete'] : [],
          view_rule: { allow_edit: kind === 'admin', visible_views: null },
          read_scope: 'all',
          fields: Object.fromEntries(
            Object.values(F).map((id) => [id, kind === 'admin' ? 'edit' : 'read']),
          ),
          option_edit_fields: [],
          file_download_fields: [],
        },
      },
      dashboards: {},
    },
  };
}

function field(id: string, name: string, type: string, options: unknown, position: number) {
  return {
    id,
    table_id: TABLE,
    name,
    type,
    options,
    is_primary: position === 0,
    required: false,
    unique_values: false,
    description: null,
    position,
    created_at: NOW,
    updated_at: NOW,
  };
}

const FIELDS = [
  field(F.title, 'Title', 'text', {}, 0),
  field(
    F.status,
    'Status',
    'select',
    {
      multiple: false,
      options: [
        { id: OPT_NEW, name: 'Mới', color: 1 },
        { id: OPT_DONE, name: 'Xong', color: 2 },
      ],
    },
    1,
  ),
  field(F.amount, 'Amount', 'number', {}, 2),
];

const RECORDS = ['Cửa hàng An Phát', 'Bình Minh', 'Cao Nguyên'].map((title, index) => ({
  id: `rec_${String(index).padStart(16, '0')}`,
  created_at: NOW,
  updated_at: NOW,
  version: 1,
  fields: { [F.title]: title },
}));

type Body = Record<string, unknown>;

function serve(
  kind: Kind,
  options: { fields?: typeof FIELDS; query?: (body: Body) => Response } = {},
) {
  const fields = options.fields ?? FIELDS;
  const views = { [TABLE]: [defaultView(TABLE)] };
  const fetchMock = stubApi({
    signedIn: true,
    views,
    routes: {
      [`GET /bases/${BASE}`]: () => json(base(kind)),
      [`GET /bases/${BASE}/tables`]: () =>
        json({ items: [table()], total: 1, offset: 0, limit: 1000 }),
      [`GET /tables/${TABLE}`]: () => json(table()),
      [`GET /tables/${TABLE}/fields`]: () =>
        json({ items: fields, total: fields.length, offset: 0, limit: 1000 }),
      [`GET /orgs/${ORG.id}/members`]: () => json({ items: [], total: 0, offset: 0, limit: 1000 }),
      [`POST /tables/${TABLE}/records/query`]: (init) => {
        const body = JSON.parse(init?.body as string) as Body;
        return (
          options.query?.(body) ??
          json({ records: RECORDS, total: RECORDS.length, offset: 0, limit: 200 })
        );
      },
      [`POST /tables/${TABLE}/records`]: () =>
        json(
          {
            records: [
              {
                id: 'rec_New0000000000001',
                created_at: NOW,
                updated_at: NOW,
                version: 1,
                fields: {},
              },
            ],
          },
          201,
        ),
      [`POST /views/${VIEW}/duplicate`]: () => {
        const copy = defaultView(TABLE, {
          id: 'viw_Copy000000000001',
          name: 'Grid view copy',
          is_personal: true,
          owner_id: 'usr_0123456789ABCDEF',
        });
        views[TABLE].push(copy);
        return json(copy, 201);
      },
    },
  });
  return fetchMock;
}

function table() {
  return {
    id: TABLE,
    base_id: BASE,
    name: 'Orders',
    description: null,
    primary_field_id: F.title,
    position: 0,
    schema_state: 'ready',
    created_at: NOW,
    updated_at: NOW,
  };
}

function queryBodies(fetchMock: ReturnType<typeof stubApi>): Body[] {
  return fetchMock.mock.calls
    .filter(([url, init]) => url.includes('/records/query') && init?.method === 'POST')
    .map(([, init]) => JSON.parse(init?.body as string) as Body);
}

function patches(fetchMock: ReturnType<typeof stubApi>): Body[] {
  return fetchMock.mock.calls
    .filter(([, init]) => init?.method === 'PATCH')
    .map(([, init]) => JSON.parse(init?.body as string) as Body);
}

async function openFilter() {
  const button = await screen.findByTestId('filter-button');
  button.focus();
  await userEvent.keyboard('{Enter}');
  return screen.getByRole('dialog', { name: 'Filter' });
}

describe('view toolbar (T311)', () => {
  beforeEach(() => {
    viewSessions.reset();
    window.localStorage.clear();
  });

  it('builds a filter with the keyboard; it applies at once, temporarily, and saves with Ctrl+S', async () => {
    const fetchMock = serve('admin');
    await renderApp(`/b/${BASE}/t/${TABLE}`);
    const panel = await openFilter();
    expect(
      within(panel).getByText('No condition yet: every record of the view shows.'),
    ).toBeVisible();
    // Only readable fields are listed; focus starts inside the panel.
    expect(panel.contains(document.activeElement)).toBe(true);
    const add = within(panel).getByRole('button', { name: 'Add condition' });
    add.focus();
    await userEvent.keyboard('{Enter}');
    const row = within(panel).getByTestId('filter-condition');
    const fieldSelect = within(row).getByRole('combobox', { name: 'Field' });
    expect(
      within(fieldSelect)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Title', 'Status', 'Amount']);
    await userEvent.selectOptions(fieldSelect, 'Status');
    const operator = within(row).getByRole('combobox', { name: 'Operator for Status' });
    expect(operator).toHaveValue('is');
    // Not applied until a value is chosen.
    expect(within(row).getByText('Not applied until a value is chosen.')).toBeVisible();
    await userEvent.selectOptions(
      within(row).getByRole('combobox', { name: 'Value for Status' }),
      'Mới',
    );
    await waitFor(() => {
      expect(queryBodies(fetchMock).at(-1)).toMatchObject({
        view_id: VIEW,
        filter: { op: 'and', items: [{ field: F.status, operator: 'is', value: OPT_NEW }] },
        filter_mode: 'replace',
      });
    });
    expect(await screen.findByRole('button', { name: 'Filter: 1 condition' })).toBeVisible();
    expect(await axeViolations(panel)).toEqual([]);
    // Escape closes the panel and gives the focus back to the button.
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Filter' })).not.toBeInTheDocument();
    expect(screen.getByTestId('filter-button')).toHaveFocus();

    // Temporary (Lark-style): nothing saved until Save / Ctrl+S.
    expect(patches(fetchMock)).toEqual([]);
    const unsaved = screen.getByRole('group', { name: 'Unsaved changes' });
    expect(within(unsaved).getByRole('button', { name: 'Save' })).toBeVisible();
    await userEvent.keyboard('{Control>}s{/Control}');
    await waitFor(() => {
      expect(patches(fetchMock)).toEqual([
        {
          config: {
            filter: { op: 'and', items: [{ field: F.status, operator: 'is', value: OPT_NEW }] },
          },
        },
      ]);
    });
    await waitFor(() => {
      expect(screen.queryByRole('group', { name: 'Unsaved changes' })).not.toBeInTheDocument();
    });
  });

  it('marks the condition a 422 INVALID_FILTER names', async () => {
    serve('admin', {
      query: (body) =>
        body['filter_mode'] === 'replace'
          ? new Response(
              JSON.stringify({
                type: 'https://cellhive.io/errors/INVALID_FILTER',
                title: 'INVALID_FILTER',
                status: 422,
                code: 'INVALID_FILTER',
                request_id: 'req_0123456789ABCDEF',
                errors: [
                  {
                    path: 'filter.items[0].value',
                    code: 'INVALID_SELECT_OPTION',
                    message: 'x',
                  },
                ],
              }),
              { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
            )
          : json({ records: RECORDS, total: 3, offset: 0, limit: 200 }),
    });
    await renderApp(`/b/${BASE}/t/${TABLE}`);
    const panel = await openFilter();
    await userEvent.click(within(panel).getByRole('button', { name: 'Add condition' }));
    const row = within(panel).getByTestId('filter-condition');
    await userEvent.selectOptions(within(row).getByRole('combobox', { name: 'Field' }), 'Status');
    await userEvent.selectOptions(
      within(row).getByRole('combobox', { name: 'Value for Status' }),
      'Xong',
    );
    expect(
      await screen.findByRole('button', { name: 'Filter: 1 condition, not valid' }),
    ).toBeVisible();
    await waitFor(() => {
      expect(within(panel).getByTestId('filter-condition')).toHaveAttribute('aria-invalid', 'true');
    });
    expect(within(panel).getByText('This option does not exist.')).toBeVisible();
  });

  it('flags an inverted "is between" instead of sending it (T320 QA)', async () => {
    const fetchMock = serve('admin');
    await renderApp(`/b/${BASE}/t/${TABLE}`);
    const panel = await openFilter();
    await userEvent.click(within(panel).getByRole('button', { name: 'Add condition' }));
    const row = within(panel).getByTestId('filter-condition');
    await userEvent.selectOptions(within(row).getByRole('combobox', { name: 'Field' }), 'Amount');
    await userEvent.selectOptions(
      within(row).getByRole('combobox', { name: 'Operator for Amount' }),
      'between',
    );
    const sent = queryBodies(fetchMock).length;
    await userEvent.type(
      within(row).getByRole('spinbutton', { name: 'Value for Amount, from' }),
      '500',
    );
    await userEvent.type(
      within(row).getByRole('spinbutton', { name: 'Value for Amount, to' }),
      '10',
    );
    expect(
      await within(panel).findByText(
        'The first value is greater than the second, so no record can match. Swap them.',
      ),
    ).toBeVisible();
    expect(row).toHaveAttribute('aria-invalid', 'true');
    // Never applied: no silent empty result.
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(
      queryBodies(fetchMock)
        .slice(sent)
        .some((body) => body['filter'] !== undefined),
    ).toBe(false);
  });

  it('moves the focus to a neighbour when a condition is removed; Escape still closes', async () => {
    serve('admin');
    await renderApp(`/b/${BASE}/t/${TABLE}`);
    const panel = await openFilter();
    const add = within(panel).getByRole('button', { name: 'Add condition' });
    await userEvent.click(add);
    await userEvent.click(add);
    const [first, second] = within(panel).getAllByTestId('filter-condition');
    if (first === undefined || second === undefined) throw new Error('two conditions');
    await userEvent.click(within(first).getByRole('button', { name: /^Remove condition/u }));
    await waitFor(() => {
      expect(within(panel).getAllByTestId('filter-condition')).toHaveLength(1);
    });
    // The next condition's first control.
    expect(document.activeElement).toBe(
      within(within(panel).getByTestId('filter-condition')).getByRole('combobox', {
        name: 'Field',
      }),
    );
    await userEvent.click(
      within(within(panel).getByTestId('filter-condition')).getByRole('button', {
        name: /^Remove condition/u,
      }),
    );
    // No condition left: "Add condition" of the group.
    await waitFor(() => {
      expect(within(panel).getByRole('button', { name: 'Add condition' })).toHaveFocus();
    });
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Filter' })).not.toBeInTheDocument();
  });

  it('sorts by several fields: add, reorder with the keyboard, replace the view sort', async () => {
    const fetchMock = serve('admin');
    await renderApp(`/b/${BASE}/t/${TABLE}`);
    const button = await screen.findByTestId('sort-button');
    await userEvent.click(button);
    const panel = screen.getByRole('dialog', { name: 'Sort' });
    const add = within(panel).getByRole('combobox', { name: 'Add a sort field' });
    await userEvent.selectOptions(add, 'Amount');
    await userEvent.selectOptions(
      within(panel).getByRole('combobox', { name: 'Add a sort field' }),
      'Status',
    );
    await userEvent.selectOptions(
      within(panel).getByRole('combobox', { name: 'Direction for Status' }),
      'desc',
    );
    await userEvent.click(within(panel).getByRole('button', { name: 'Move Status up' }));
    await waitFor(() => {
      expect(queryBodies(fetchMock).at(-1)).toMatchObject({
        sort: [
          { field: F.status, direction: 'desc' },
          { field: F.amount, direction: 'asc' },
        ],
        sort_mode: 'replace',
      });
    });
    // T320b: the button says what applies (design "Sắp xếp: Hạn").
    expect(screen.getByRole('button', { name: 'Sort: Status +1' })).toBeVisible();
    expect(await axeViolations(panel)).toEqual([]);
    await userEvent.click(within(panel).getByRole('button', { name: 'Remove sort by Amount' }));
    expect(within(panel).getAllByTestId('sort-key')).toHaveLength(1);
  });

  it('groups by up to 3 fields (T312): temporary, sent as the query group and counted', async () => {
    const fetchMock = serve('admin');
    await renderApp(`/b/${BASE}/t/${TABLE}`);
    await userEvent.click(await screen.findByTestId('group-button'));
    const panel = screen.getByRole('dialog', { name: 'Group' });
    expect(within(panel).getByText('Not grouped.')).toBeInTheDocument();
    for (const name of ['Status', 'Title', 'Amount']) {
      await userEvent.selectOptions(
        within(panel).getByRole('combobox', { name: 'Add a group field' }),
        name,
      );
    }
    expect(within(panel).getByRole('combobox', { name: 'Add a group field' })).toBeDisabled();
    expect(within(panel).getByText('At most 3 group levels')).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: 'Remove grouping by Title' }));
    // Direction as a segmented toggle labelled by type (T320a): options, numbers.
    const statusDirection = within(panel).getByRole('radiogroup', {
      name: 'Direction for Status',
    });
    expect(within(statusDirection).getByRole('radio', { name: 'First → Last' })).toBeChecked();
    const amountDirection = within(panel).getByRole('radiogroup', {
      name: 'Direction for Amount',
    });
    await userEvent.click(within(amountDirection).getByRole('radio', { name: '9 → 1' }));
    expect(within(amountDirection).getByRole('radio', { name: '9 → 1' })).toBeChecked();
    // The grid counts its groups with the temporary group (rows load once counted).
    await waitFor(() => {
      const counts = fetchMock.mock.calls
        .filter(([url]) => url.includes('/records/group-counts'))
        .map(([, init]) => JSON.parse(init?.body as string) as Body);
      expect(counts.at(-1)).toMatchObject({
        view_id: VIEW,
        group: [
          { field: F.status, direction: 'asc' },
          { field: F.amount, direction: 'desc' },
        ],
      });
    });
    expect(screen.getByRole('button', { name: 'Group: Status +1' })).toBeVisible();
    // Temporary until saved, like filter and sort.
    expect(screen.getByRole('group', { name: 'Unsaved changes' })).toBeInTheDocument();
    expect(patches(fetchMock)).toEqual([]);
    expect(await axeViolations(panel)).toEqual([]);
  });

  it('sizes the popovers to their content and lines the order rows up (T322b)', async () => {
    serve('admin');
    await renderApp(`/b/${BASE}/t/${TABLE}`);
    for (const kind of ['sort', 'group'] as const) {
      await userEvent.click(await screen.findByTestId(`${kind}-button`));
      const panel = screen.getByRole('dialog', { name: kind === 'sort' ? 'Sort' : 'Group' });
      // Content width between a minimum and the screen, not a fixed width.
      expect(panel).toHaveClass('w-max', 'min-w-72', 'max-w-[min(42rem,calc(100vw-2rem))]');
      expect(panel.className).not.toMatch(/(?:^|\s)w-\[/u);
      await userEvent.selectOptions(
        within(panel).getByRole('combobox', {
          name: kind === 'sort' ? 'Add a sort field' : 'Add a group field',
        }),
        'Status',
      );
      // One column set for every row (subgrid); the "Sort by / then by" labels never wrap.
      const list = within(panel).getByRole('list');
      expect(list).toHaveClass('md:grid');
      const row = within(panel).getAllByTestId('sort-key')[0];
      expect(row).toHaveClass('md:grid-cols-subgrid');
      expect(row?.querySelector('.whitespace-nowrap')).not.toBeNull();
      await userEvent.keyboard('{Escape}');
    }
  });

  it('searches after a pause; Ctrl+F focuses the box, Escape clears then leaves', async () => {
    const fetchMock = serve('admin');
    await renderApp(`/b/${BASE}/t/${TABLE}`);
    const search = await screen.findByRole('searchbox', { name: 'Search records' });
    // Says what is searched: the primary field.
    expect(search).toHaveAttribute('placeholder', 'Search by Title');
    // Ctrl/⌘+F from anywhere on the page.
    document.body.focus();
    const event = new KeyboardEvent('keydown', {
      key: 'f',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      document.body.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(search).toHaveFocus();
    await userEvent.type(search, 'an phat');
    await waitFor(
      () => {
        expect(queryBodies(fetchMock).at(-1)).toMatchObject({ search: 'an phat' });
      },
      { timeout: SEARCH_DEBOUNCE_MS + 1000 },
    );
    // Sent once typing paused: never a partial word.
    expect(
      queryBodies(fetchMock)
        .map((body) => body['search'])
        .filter((value) => value !== undefined && value !== null),
    ).toSatisfy((values: unknown[]) => values.every((value) => value === 'an phat'));
    await userEvent.keyboard('{Escape}');
    expect(search).toHaveValue('');
    expect(search).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(search).not.toHaveFocus();
  });

  it('disables search when the primary field is not readable', async () => {
    serve('reader', { fields: FIELDS.slice(1) });
    await renderApp(`/b/${BASE}/t/${TABLE}`);
    const search = await screen.findByRole('searchbox', { name: 'Search records' });
    expect(search).toBeDisabled();
    expect(search).toHaveAccessibleDescription(
      'Search looks in the primary field, which your role does not show.',
    );
  });

  it('a reader keeps changes temporary; Ctrl+S saves them as a personal view', async () => {
    const fetchMock = serve('reader');
    const { router } = await renderApp(`/b/${BASE}/t/${TABLE}`);
    await userEvent.click(await screen.findByTestId('sort-button'));
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Add a sort field' }),
      'Amount',
    );
    const unsaved = await screen.findByRole('group', { name: 'Unsaved changes' });
    expect(within(unsaved).queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: 's', metaKey: true });
    // T320b: first says why the view itself cannot be saved.
    const explain = await screen.findByRole('dialog', {
      name: 'Your changes cannot be saved to this view',
    });
    expect(explain).toHaveTextContent('You cannot change this shared view.');
    await userEvent.click(within(explain).getByRole('button', { name: 'Save as personal view' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/b/${BASE}/t/${TABLE}/v/viw_Copy000000000001`);
    });
    expect(patches(fetchMock)).toEqual([
      { config: { sort: [{ field: F.amount, direction: 'asc' }] } },
    ]);
  });

  it('Shift+Enter adds a record and selects it', { timeout: 20_000 }, async () => {
    const fetchMock = serve('admin');
    await renderApp(`/b/${BASE}/t/${TABLE}`);
    const shiftEnter = await screen.findByRole('button', { name: 'shift enter on row 1' });
    await waitFor(() => {
      expect(shiftEnter).toBeEnabled();
    });
    await userEvent.click(shiftEnter);
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            new URL(url, 'http://localhost').pathname === `/api/v1/tables/${TABLE}/records` &&
            init?.method === 'POST',
        ),
      ).toBe(true);
    });
  });

  it('lists Ctrl/⌘+F, Ctrl/⌘+S and Shift+Enter in the shortcuts', async () => {
    serve('admin');
    await renderApp(`/b/${BASE}/t/${TABLE}`);
    await screen.findByTestId('filter-button');
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Keyboard shortcuts' }));
    const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    for (const action of [
      'Search the view',
      'Save the changes of the view',
      'Add a record below the selected row',
    ]) {
      expect(within(dialog).getByRole('rowheader', { name: action })).toBeVisible();
    }
  });
});
