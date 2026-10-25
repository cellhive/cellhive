import { render, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { expect, vi } from 'vitest';

import { Providers } from '../src/app/providers';
import { createRoutes } from '../src/app/router';
import { createQueryClient } from '../src/lib/query/client';

import { createTestI18n } from './i18n';

export const ORG = {
  id: 'org_0123456789ABCDEF',
  name: 'Acme',
  slug: 'acme',
  settings: { locale: 'en', timezone: 'UTC', currency: 'USD', public_sharing: 'allowed' },
  role: 'owner',
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
} as const;

export const ME = {
  user: {
    id: 'usr_0123456789ABCDEF',
    email: 'an@example.test',
    display_name: 'An Nguyen',
    avatar_url: null,
  },
  orgs: [{ id: ORG.id, name: ORG.name, slug: ORG.slug, role: 'owner' }],
  locale: 'en',
  timezone: 'UTC',
} as const;

/** The default grid view every table has (CONTRACTS §15), as the fake API lists it. */
export function defaultView(tableId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `viw_${tableId.slice(4)}`,
    table_id: tableId,
    type: 'grid',
    name: 'Grid view',
    is_personal: false,
    owner_id: null,
    position: 0,
    locked: false,
    config: {
      filter: null,
      sort: [],
      group: [],
      hidden_fields: [],
      field_order: [],
      column_widths: {},
      frozen_count: 1,
      row_height: 'short',
      tree: { enabled: false, show_ancestors: true },
    },
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

type FakeView = ReturnType<typeof defaultView>;

export interface ServerState {
  setupRequired?: boolean;
  smtpEnabled?: boolean;
  signedIn?: boolean;
  /** Extra routes answered before the defaults (public or not). */
  routes?: Record<string, (init: RequestInit | undefined) => Response>;
  /**
   * Views by table for the default view routes (`GET /tables/:id/views`,
   * `PATCH /views/:id` merging `config`); a table not listed has one default
   * grid view. Mutated in place by `PATCH`.
   */
  views?: Record<string, FakeView[]>;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function problem(code: string, status: number): Response {
  return new Response(
    JSON.stringify({
      type: `https://cellhive.io/errors/${code}`,
      title: code,
      status,
      code,
      request_id: 'req_0123456789ABCDEF',
    }),
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

/** A tiny fake of the API routes the shell and auth screens call. */
export function stubApi(state: ServerState) {
  const fetchMock = vi.fn((input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost');
    const path = url.pathname.replace('/api/v1', '');
    const route = state.routes?.[`${init?.method ?? 'GET'} ${path}`];
    if (route !== undefined) return Promise.resolve(route(init));
    if (path === '/setup') {
      return Promise.resolve(
        json({
          setup_required: state.setupRequired ?? false,
          auth_config: { smtp_enabled: state.smtpEnabled ?? false },
        }),
      );
    }
    if (state.signedIn !== true) return Promise.resolve(problem('UNAUTHENTICATED', 401));
    if (path === '/me') return Promise.resolve(json(ME));
    const viewList = /^\/tables\/(tbl_[^/]+)\/views$/u.exec(path);
    if (viewList !== null && (init?.method ?? 'GET') === 'GET') {
      const tableId = viewList[1] ?? '';
      const views = (state.views ??= {});
      const items = (views[tableId] ??= [defaultView(tableId)]);
      return Promise.resolve(json({ items, total: items.length, offset: 0, limit: 1000 }));
    }
    const viewPatch = /^\/views\/(viw_[^/]+)$/u.exec(path);
    if (viewPatch !== null && init?.method === 'PATCH') {
      const view = Object.values(state.views ?? {})
        .flat()
        .find((item) => item.id === viewPatch[1]);
      if (view === undefined) return Promise.resolve(problem('NOT_FOUND', 404));
      const body = JSON.parse(init.body as string) as { config?: object; name?: string };
      view.config = { ...view.config, ...body.config };
      if (body.name !== undefined) view.name = body.name;
      return Promise.resolve(json(view));
    }
    if (path === `/orgs/${ORG.id}/workspaces`) {
      return Promise.resolve(json({ items: [], total: 0, offset: 0, limit: 1000 }));
    }
    return Promise.resolve(problem('NOT_FOUND', 404));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The full-page loader of a lazy route and the app shell skeleton of the first load. */
const FIRST_LOAD_PLACEHOLDERS = 'div[role="status"].min-h-dvh, [data-testid="app-shell-skeleton"]';
const FIRST_LOAD_TIMEOUT_MS = 45_000;
// Room for that first load in every test file that renders the app (the default is 15 s).
vi.setConfig({ testTimeout: 60_000 });

/** Renders the real route tree at `path` and returns the router. */
export async function renderApp(
  path: string,
): Promise<{ router: ReturnType<typeof createMemoryRouter> }> {
  const i18n = await createTestI18n('en');
  const queryClient = createQueryClient();
  const router = createMemoryRouter(createRoutes(queryClient), { initialEntries: [path] });
  render(
    <Providers queryClient={queryClient} i18n={i18n}>
      <RouterProvider router={router} />
    </Providers>,
  );
  await waitFor(() => {
    expect(router.state.navigation.state).toBe('idle');
  });
  // The first render of a test file loads the route's lazy chunks through
  // Vite's transform: in a full parallel `pnpm test` that alone took more
  // than the 5 s of `findBy*` (T527: LinkedSubTable, ViewToolbar, ViewBar,
  // ShareManage, ColumnTools timed out on the full-page loader). Wait for it
  // here, with room, so that the test's own waits only cover its behaviour.
  await waitFor(
    () => {
      expect(document.querySelector(FIRST_LOAD_PLACEHOLDERS)).toBeNull();
    },
    { timeout: FIRST_LOAD_TIMEOUT_MS },
  );
  return { router };
}
