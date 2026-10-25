import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultView, json, ME, ORG, renderApp, stubApi } from '../../../../test/app-harness';
import { axeViolations } from '../../../../test/axe';
import { viewSessions } from '../../../lib/views/session';
import { fallbackViewId, uniqueViewName } from '../names';

import type { GridViewProps } from '../../../grid';

// The canvas grid needs a real browser (E2E): a plain list stands in.
vi.mock('../../../grid/GridView', () => ({
  GridView: ({ label }: GridViewProps) => <ul aria-label={label} />,
}));

const BASE = 'bse_Sales00000000001';
const TABLE = 'tbl_Tickets000000001';
const NOW = '2026-09-24T00:00:00.000Z';
const ME_ID = 'usr_0123456789ABCDEF';

const MAIN = defaultView(TABLE);
const OPEN = defaultView(TABLE, { id: 'viw_Open000000000001', name: 'Open tickets', position: 1 });
const MINE = defaultView(TABLE, {
  id: 'viw_Mine000000000001',
  name: 'My tickets',
  is_personal: true,
  owner_id: ME_ID,
});
const BOARD = defaultView(TABLE, {
  id: 'viw_Board00000000001',
  name: 'Board',
  type: 'kanban',
  position: 2,
});

type Kind = 'admin' | 'viewEditor' | 'reader';

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
                perm: kind === 'reader' ? 'read_only' : 'edit',
                operations: [],
                view_rule: { allow_edit: kind === 'viewEditor', visible_views: null },
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

const table = {
  id: TABLE,
  base_id: BASE,
  name: 'Tickets',
  description: null,
  primary_field_id: 'fld_Title00000000001',
  position: 0,
  schema_state: 'ready',
  created_at: NOW,
  updated_at: NOW,
};

const fields = {
  items: [
    {
      id: 'fld_Title00000000001',
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

function serve(
  kind: Kind,
  views: ReturnType<typeof defaultView>[],
  extra: Record<string, (init: RequestInit | undefined) => Response> = {},
) {
  const state = { views: { [TABLE]: views } };
  const fetchMock = stubApi({
    signedIn: true,
    routes: {
      [`GET /bases/${BASE}`]: () => json(base(kind)),
      [`GET /bases/${BASE}/tables`]: () =>
        json({ items: [table], total: 1, offset: 0, limit: 1000 }),
      [`GET /tables/${TABLE}`]: () => json(table),
      [`GET /tables/${TABLE}/fields`]: () => json(fields),
      [`POST /tables/${TABLE}/records/query`]: () =>
        json({ records: [], total: 0, offset: 0, limit: 200 }),
      ...extra,
    },
    ...state,
  });
  return { fetchMock, state };
}

function bodyOf(fetchMock: ReturnType<typeof stubApi>, method: string, path: string): unknown {
  const call = fetchMock.mock.calls.find(
    ([url, init]) => init?.method === method && url.includes(path),
  );
  return call === undefined ? undefined : JSON.parse(call[1]?.body as string);
}

const viewPath = (viewId: string) => `/b/${BASE}/t/${TABLE}/v/${viewId}`;

async function openOptions(name: string) {
  await userEvent.click(await screen.findByRole('button', { name: `Options of view ${name}` }));
  return screen.findByRole('menu');
}

beforeEach(() => {
  viewSessions.reset();
});

afterEach(() => {
  window.localStorage.clear();
});

// axe runs over the whole page: slow on a loaded machine.
const AXE_TIMEOUT = 30_000;

describe('view bar (T310)', () => {
  it(
    'lists shared then personal views, marks the open and personal ones; no axe violations',
    async () => {
      serve('admin', [MAIN, OPEN, MINE]);
      await renderApp(viewPath(OPEN.id));
      const nav = await screen.findByRole('navigation', { name: 'Views of Tickets' });
      const shared = within(nav).getByRole('list', { name: 'Shared views' });
      expect(
        within(shared)
          .getAllByRole('link')
          .map((link) => link.textContent),
      ).toEqual(['Grid view', 'Open tickets']);
      expect(within(shared).getByRole('link', { name: 'Open tickets' })).toHaveAttribute(
        'aria-current',
        'page',
      );
      const personal = within(nav).getByRole('list', { name: 'Personal views' });
      expect(within(personal).getByRole('link', { name: /My tickets/u })).toContainElement(
        within(personal).getByRole('img', { name: 'Personal view' }),
      );
      expect(document.title).toBe('Open tickets · Tickets · Cellhive');
      expect(window.localStorage.getItem(`cellhive.lastView.${ME.user.id}.${TABLE}`)).toBe(OPEN.id);
      expect(await axeViolations(document.body)).toEqual([]);
    },
    AXE_TIMEOUT,
  );

  it(
    'creates a shared grid view with a free default name and opens it',
    async () => {
      const created = defaultView(TABLE, { id: 'viw_New0000000000001', name: 'Grid view 2' });
      const { fetchMock, state } = serve('admin', [MAIN], {
        [`POST /tables/${TABLE}/views`]: () => {
          state.views[TABLE] = [MAIN, created];
          return json(created, 201);
        },
      });
      const { router } = await renderApp(viewPath(MAIN.id));
      await userEvent.click(await screen.findByRole('button', { name: 'New view' }));
      const menu = await screen.findByRole('menu');
      expect(await axeViolations(document.body)).toEqual([]);
      await userEvent.click(within(menu).getByTestId('create-view-shared-grid'));
      await waitFor(() => {
        expect(router.state.location.pathname).toBe(viewPath(created.id));
      });
      expect(bodyOf(fetchMock, 'POST', `/tables/${TABLE}/views`)).toEqual({
        name: 'Grid view 2',
        type: 'grid',
        is_personal: false,
      });
      await waitFor(() => {
        expect(screen.getByRole('link', { name: 'Grid view 2' })).toHaveAttribute(
          'aria-current',
          'page',
        );
      });
    },
    AXE_TIMEOUT,
  );

  it('a reader only creates personal views and duplicates shared ones as personal', async () => {
    const copy = defaultView(TABLE, {
      id: 'viw_Copy000000000001',
      name: 'Grid view copy',
      is_personal: true,
      owner_id: ME_ID,
    });
    const { fetchMock } = serve('reader', [MAIN], {
      [`POST /views/${MAIN.id}/duplicate`]: () => json(copy, 201),
    });
    const { router } = await renderApp(viewPath(MAIN.id));
    await userEvent.click(await screen.findByRole('button', { name: 'New view' }));
    const createMenu = await screen.findByRole('menu');
    expect(within(createMenu).queryByTestId('create-view-shared-grid')).not.toBeInTheDocument();
    expect(within(createMenu).getByTestId('create-view-personal-grid')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    const menu = await openOptions('Grid view');
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Duplicate as personal view']);
    await userEvent.click(
      within(menu).getByRole('menuitem', { name: 'Duplicate as personal view' }),
    );
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(viewPath(copy.id));
    });
    expect(bodyOf(fetchMock, 'POST', '/duplicate')).toEqual({ is_personal: true });
  });

  it('renames with a taken name shown inline, then saves the new name', async () => {
    let taken = true;
    serve('viewEditor', [MAIN, OPEN], {
      [`PATCH /views/${OPEN.id}`]: (init) => {
        if (taken) {
          taken = false;
          return new Response(JSON.stringify({ code: 'NAME_CONFLICT', title: 'x', status: 409 }), {
            status: 409,
            headers: { 'Content-Type': 'application/problem+json' },
          });
        }
        const body = JSON.parse(init?.body as string) as { name: string };
        return json({ ...OPEN, name: body.name });
      },
    });
    await renderApp(viewPath(OPEN.id));
    const menu = await openOptions('Open tickets');
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Rename' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename view' });
    const input = within(dialog).getByLabelText('Name');
    await userEvent.clear(input);
    await userEvent.type(input, 'grid view');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
    expect(await within(dialog).findByText('This name is already in use.')).toBeInTheDocument();
    await userEvent.clear(input);
    await userEvent.type(input, 'Mới');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Rename' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(await screen.findByRole('link', { name: 'Mới' })).toBeInTheDocument();
  });

  it('reorders with "Move right" (PATCH position) and locks for schema managers', async () => {
    const { fetchMock, state } = serve('admin', [MAIN, OPEN], {
      [`PATCH /views/${MAIN.id}`]: (init) => {
        const body = JSON.parse(init?.body as string) as { position?: number; locked?: boolean };
        const moved = { ...MAIN, position: body.position ?? 1, locked: body.locked ?? false };
        state.views[TABLE] = [{ ...OPEN, position: 0 }, moved];
        return json(moved);
      },
    });
    await renderApp(viewPath(MAIN.id));
    let menu = await openOptions('Grid view');
    expect(within(menu).getByRole('menuitem', { name: 'Move left' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Move right' }));
    const shared = screen.getByRole('list', { name: 'Shared views' });
    await waitFor(() => {
      expect(
        within(shared)
          .getAllByRole('link')
          .map((link) => link.textContent),
      ).toEqual(['Open tickets', 'Grid view']);
    });
    expect(bodyOf(fetchMock, 'PATCH', `/views/${MAIN.id}`)).toEqual({ position: 1 });
    menu = await openOptions('Grid view');
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Lock view' }));
    expect(await screen.findByRole('img', { name: 'Locked view' })).toBeInTheDocument();
  });

  it('a locked view cannot be deleted; the last shared view neither', async () => {
    serve('admin', [{ ...MAIN, locked: true }, OPEN]);
    await renderApp(viewPath(MAIN.id));
    let menu = await openOptions('Grid view');
    expect(
      within(menu).getByRole('menuitem', { name: 'Delete view (unlock it first)' }),
    ).toHaveAttribute('aria-disabled', 'true');
    expect(within(menu).getByRole('menuitem', { name: 'Unlock view' })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    menu = await openOptions('Open tickets');
    expect(within(menu).getByRole('menuitem', { name: 'Delete view' })).not.toHaveAttribute(
      'aria-disabled',
    );
  });

  it(
    'deletes the open view after confirming and opens another one',
    async () => {
      const { fetchMock, state } = serve('viewEditor', [MAIN, OPEN], {
        [`DELETE /views/${OPEN.id}`]: () => {
          state.views[TABLE] = [MAIN];
          return new Response(null, { status: 204 });
        },
      });
      const { router } = await renderApp(viewPath(OPEN.id));
      const menu = await openOptions('Open tickets');
      await userEvent.click(within(menu).getByRole('menuitem', { name: 'Delete view' }));
      const dialog = await screen.findByRole('dialog', { name: 'Delete view Open tickets?' });
      expect(await axeViolations(document.body)).toEqual([]);
      await userEvent.click(within(dialog).getByRole('button', { name: 'Delete view' }));
      await waitFor(() => {
        expect(router.state.location.pathname).toBe(viewPath(MAIN.id));
      });
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(true);
      expect(await screen.findByText('View Open tickets deleted.')).toBeInTheDocument();
      expect(
        screen.queryByText(
          'The view you were looking at was deleted or is no longer available to you.',
        ),
      ).not.toBeInTheDocument();
    },
    AXE_TIMEOUT,
  );

  it(
    'form views open the form builder (T315); kanban views open the board',
    async () => {
      const form = defaultView(TABLE, {
        id: 'viw_Form000000000001',
        name: 'Form',
        type: 'form',
        position: 3,
      });
      serve('admin', [MAIN, BOARD, form]);
      const { router } = await renderApp(viewPath(form.id));
      expect(
        await screen.findByRole('heading', { name: 'Title and description' }, { timeout: 10_000 }),
      ).toBeInTheDocument();
      expect(screen.queryByRole('list', { name: 'Records of Tickets' })).not.toBeInTheDocument();
      // T314: a kanban view without a group field asks for one.
      await router.navigate(viewPath(BOARD.id));
      expect(
        await screen.findByRole(
          'heading',
          { name: 'Choose how to group the cards' },
          { timeout: 10_000 },
        ),
      ).toBeInTheDocument();
    },
    AXE_TIMEOUT,
  );

  it('a reader saves temporary changes as a personal view', async () => {
    const copy = defaultView(TABLE, {
      id: 'viw_Copy000000000001',
      name: 'Grid view copy',
      is_personal: true,
      owner_id: ME_ID,
    });
    window.localStorage.setItem(
      `cellhive.viewDraft.${ME.user.id}.${MAIN.id}`,
      JSON.stringify({ frozen_count: 3 }),
    );
    const { fetchMock } = serve('reader', [MAIN], {
      [`POST /views/${MAIN.id}/duplicate`]: () => json(copy, 201),
      [`PATCH /views/${copy.id}`]: () =>
        json({ ...copy, config: { ...copy.config, frozen_count: 3 } }),
    });
    const { router } = await renderApp(viewPath(MAIN.id));
    const unsaved = await screen.findByRole('group', { name: 'Unsaved changes' });
    expect(unsaved).toHaveTextContent('You cannot change this view');
    await userEvent.click(within(unsaved).getByRole('button', { name: 'Save as personal view' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(viewPath(copy.id));
    });
    // T320b: "<view> (personal)", not "<view> copy".
    expect(bodyOf(fetchMock, 'POST', '/duplicate')).toEqual({
      is_personal: true,
      name: 'Grid view (personal)',
    });
    expect(bodyOf(fetchMock, 'PATCH', `/views/${copy.id}`)).toEqual({
      config: { frozen_count: 3 },
    });
    expect(window.localStorage.getItem(`cellhive.viewDraft.${ME.user.id}.${MAIN.id}`)).toBeNull();
    expect(screen.queryByRole('group', { name: 'Unsaved changes' })).not.toBeInTheDocument();
  });
});

describe('view bar layout and focus (T320b, QA S3)', () => {
  const many = Array.from({ length: 7 }, (_, index) =>
    defaultView(TABLE, {
      id: `viw_Many00000000000${String(index)}`,
      name: `View number ${String(index)}`,
      position: index,
    }),
  );

  it('keeps the open tab and "New view" visible; the rest go to "⋯ N more"', async () => {
    // A 520 px tab strip with a 100 px "New view": two tabs and the overflow button fit.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private readonly callback: ResizeObserverCallback) {}
        observe(target: Element) {
          const width = target.querySelector('a') === null ? 100 : 520;
          this.callback(
            [{ contentRect: { width } } as ResizeObserverEntry],
            this as unknown as ResizeObserver,
          );
        }
        disconnect() {
          // nothing to release
        }
      },
    );
    try {
      serve('admin', many);
      const { router } = await renderApp(viewPath(many[5]?.id ?? ''));
      const nav = await screen.findByRole('navigation', { name: 'Views of Tickets' });
      await waitFor(() => {
        expect(
          within(nav)
            .getAllByRole('link')
            .map((link) => link.textContent),
        ).toEqual(['View number 0', 'View number 5']);
      });
      expect(within(nav).getByRole('link', { name: 'View number 5' })).toHaveAttribute(
        'title',
        'View number 5',
      );
      expect(within(nav).getByRole('button', { name: 'New view' })).toBeInTheDocument();
      await userEvent.click(within(nav).getByRole('button', { name: '5 more views' }));
      const menu = await screen.findByRole('menu');
      expect(
        within(menu)
          .getAllByRole('menuitem')
          .map((item) => item.textContent),
      ).toEqual([
        'View number 1',
        'View number 2',
        'View number 3',
        'View number 4',
        'View number 6',
      ]);
      await userEvent.click(within(menu).getByRole('menuitem', { name: 'View number 3' }));
      await waitFor(() => {
        expect(router.state.location.pathname).toBe(viewPath(many[3]?.id ?? ''));
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('opens rename with the old name selected', async () => {
    serve('admin', [MAIN, OPEN]);
    await renderApp(viewPath(OPEN.id));
    const menu = await openOptions('Open tickets');
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Rename' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename view' });
    const input = within(dialog).getByLabelText<HTMLInputElement>('Name');
    expect(input).toHaveFocus();
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 'Open tickets'.length]);
  });

  it('gives the focus to the tab of the view opened after a delete', async () => {
    const { state } = serve('viewEditor', [MAIN, OPEN], {
      [`DELETE /views/${OPEN.id}`]: () => {
        state.views[TABLE] = [MAIN];
        return new Response(null, { status: 204 });
      },
    });
    await renderApp(viewPath(OPEN.id));
    const menu = await openOptions('Open tickets');
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Delete view' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete view Open tickets?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Delete view' }));
    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'Grid view' })).toHaveFocus();
    });
  });
});

describe('no visible view (T310)', () => {
  it('a table without any visible view offers a personal view instead of a 404', async () => {
    const mine = defaultView(TABLE, {
      id: 'viw_Mine000000000001',
      is_personal: true,
      owner_id: ME_ID,
    });
    const { fetchMock, state } = serve('reader', [], {
      [`POST /tables/${TABLE}/views`]: () => {
        state.views[TABLE] = [mine];
        return json(mine, 201);
      },
    });
    const { router } = await renderApp(`/b/${BASE}/t/${TABLE}`);
    expect(
      await screen.findByRole('heading', { name: 'No view of this table is available to you' }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Create a personal grid view' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(viewPath(mine.id));
    });
    expect(bodyOf(fetchMock, 'POST', `/tables/${TABLE}/views`)).toEqual({
      name: 'Grid view',
      type: 'grid',
      is_personal: true,
    });
  });
});

describe('view names', () => {
  it.each<[string, string[], string]>([
    ['Grid view', [], 'Grid view'],
    ['Grid view', ['grid VIEW'], 'Grid view 2'],
    ['Grid view', ['Grid view', 'Grid view 2'], 'Grid view 3'],
  ])('%s among %j → %s', (name, taken, expected) => {
    expect(uniqueViewName(name, taken)).toBe(expected);
  });

  it('falls back to the first remaining shared view', () => {
    const views = [
      { id: 'a', is_personal: false },
      { id: 'p', is_personal: true },
      { id: 'b', is_personal: false },
    ];
    expect(fallbackViewId(views, 'a')).toBe('b');
    expect(fallbackViewId([{ id: 'p', is_personal: true }], 'x')).toBe('p');
    expect(fallbackViewId([{ id: 'a', is_personal: false }], 'a')).toBeUndefined();
  });
});
