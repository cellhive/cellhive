import { redirect, type LoaderFunctionArgs } from 'react-router';

import { workspaceQuery } from '../features/org/api';
import { isApiError } from '../lib/api/client';
import { notFound } from '../lib/navigation/not-found';
import { loginPathFor, safeNextPath } from '../lib/navigation/safe-next';
import { isBaseAdmin } from '../lib/permissions/access';
import { isOrgAdmin } from '../lib/permissions/org';
import {
  lastViewPreferenceKey,
  PREFERENCE_KEYS,
  readPreference,
  writePreference,
} from '../lib/preferences';
import { dashboardQuery } from '../lib/query/dashboards';
import { baseQuery, fieldsQuery, tableQuery, tablesQuery, viewsQuery } from '../lib/query/queries';
import { meQuery, setupStatusQuery } from '../lib/session/session';

import type { QueryClient } from '@tanstack/react-query';

function isMissing(error: unknown): boolean {
  // Malformed IDs in the path answer 422 (CONTRACTS §6); same screen as 404.
  return isApiError(error) && (error.status === 404 || error.code === 'VALIDATION_FAILED');
}

/**
 * Route guards as React Router loaders (FRONTEND §2). They fill the query
 * cache the screens read, redirect by session state, and turn missing or
 * forbidden resources into the 404 screen.
 */
export function createGuards(queryClient: QueryClient) {
  // Fresh cached data when present, else fetched (invalidated data is refetched).
  const setupStatus = () => queryClient.query(setupStatusQuery());
  const me = () => queryClient.query(meQuery());

  /** A 401 in a nested loader means the session ended while navigating. */
  async function withSession<T>(request: Request, load: () => Promise<T>): Promise<T> {
    try {
      return await load();
    } catch (error) {
      if (isApiError(error) && error.status === 401) {
        throw redirect(loginPathFor(new URL(request.url)));
      }
      if (isMissing(error)) notFound();
      throw error;
    }
  }

  /** The caller's organizations come with the session (CONTRACTS §5A). */
  async function findOrg(slug: string | undefined) {
    const org = (await me())?.orgs.find((item) => item.slug === slug);
    if (org === undefined) notFound();
    return org;
  }

  async function loadTable(request: Request, baseId: string, tableId: string): Promise<void> {
    await withSession(request, async () => {
      const [, table] = await Promise.all([
        queryClient.query(baseQuery(baseId)),
        queryClient.query(tableQuery(tableId)),
        queryClient.query(fieldsQuery(tableId)),
      ]);
      if (table.base_id !== baseId) notFound();
    });
  }

  return {
    /** `/`: the last used (or first) organization, else the "no organization" screen. */
    home: async () => {
      if ((await setupStatus()).setup_required) throw redirect('/setup');
      const session = await me();
      if (session === null) throw redirect('/login');
      const last = readPreference(PREFERENCE_KEYS.lastOrg);
      const org = session.orgs.find((item) => item.slug === last) ?? session.orgs[0];
      if (org !== undefined) throw redirect(`/o/${encodeURIComponent(org.slug)}`);
      return null;
    },

    /** `/setup` exists only until the first user is created. */
    setupOnly: async () => {
      const status = await queryClient.query(setupStatusQuery());
      if (!status.setup_required) throw redirect('/login');
      return null;
    },

    /** `/login`: signed-in users continue to `?next=` (internal paths only). */
    guestOnly: async ({ request }: LoaderFunctionArgs) => {
      if ((await setupStatus()).setup_required) throw redirect('/setup');
      if ((await me()) !== null) {
        const next = safeNextPath(new URL(request.url).searchParams.get('next'));
        throw redirect(next ?? '/');
      }
      return null;
    },

    /** Every page of the app shell needs a session. */
    requireSession: async ({ request }: LoaderFunctionArgs) => {
      if ((await me()) !== null) return null;
      if ((await setupStatus()).setup_required) throw redirect('/setup');
      throw redirect(loginPathFor(new URL(request.url)));
    },

    /**
     * Any other path (`*`): the 404 screen for a signed-in user; without a
     * session, the sign-in page first (then back here), as app pages do.
     */
    unknownPath: async ({ request }: LoaderFunctionArgs) => {
      try {
        if ((await me()) !== null) return null;
        if ((await setupStatus()).setup_required) return redirect('/setup');
      } catch {
        // Server unreachable: the 404 screen still renders.
        return null;
      }
      return redirect(loginPathFor(new URL(request.url)));
    },

    org: async ({ request, params }: LoaderFunctionArgs) => {
      const org = await withSession(request, () => findOrg(params['orgSlug']));
      writePreference(PREFERENCE_KEYS.lastOrg, org.slug);
      return null;
    },

    workspace: async ({ request, params }: LoaderFunctionArgs) => {
      await withSession(request, async () => {
        const org = await findOrg(params['orgSlug']);
        const workspaceId = params['workspaceId'] ?? '';
        const workspace = await queryClient.query(workspaceQuery(org.id, workspaceId));
        if (workspace.organization_id !== org.id) notFound();
      });
      return null;
    },

    /** `/b/:baseId`: the first table of the base (FRONTEND §2), else the base page. */
    base: async ({ request, params }: LoaderFunctionArgs) => {
      const baseId = params['baseId'] ?? '';
      const tables = await withSession(request, async () => {
        await queryClient.query(baseQuery(baseId));
        return queryClient.query(tablesQuery(baseId));
      });
      const first = tables.items[0];
      if (first !== undefined) {
        throw redirect(`/b/${encodeURIComponent(baseId)}/t/${encodeURIComponent(first.id)}`);
      }
      return null;
    },

    /**
     * Table screens (`/b/:baseId/t/:tableId/v/:viewId`, `…/trash`): the
     * base (access, permission version), the table, which must belong to
     * that base, and its fields.
     */
    table: async ({ request, params }: LoaderFunctionArgs) => {
      await loadTable(request, params['baseId'] ?? '', params['tableId'] ?? '');
      return null;
    },

    /**
     * `/b/:baseId/t/:tableId` (FRONTEND §2): the view last opened on this
     * device when the user still sees it, else the first view; without any
     * visible view, the table page offers a personal view.
     */
    tableViews: async ({ request, params }: LoaderFunctionArgs) => {
      const baseId = params['baseId'] ?? '';
      const tableId = params['tableId'] ?? '';
      await loadTable(request, baseId, tableId);
      const views = await withSession(request, () => queryClient.query(viewsQuery(tableId)));
      const userId = (await me())?.user.id;
      const last =
        userId === undefined ? null : readPreference(lastViewPreferenceKey(userId, tableId));
      const view = views.items.find((item) => item.id === last) ?? views.items[0];
      // No view visible at all: the "no view" screen of the table (it can make a personal one).
      if (view === undefined) return null;
      const url = new URL(request.url);
      throw redirect(
        `/b/${encodeURIComponent(baseId)}/t/${encodeURIComponent(tableId)}/v/${encodeURIComponent(view.id)}${url.search}`,
      );
    },

    /**
     * `/b/:baseId/t/:tableId/v/:viewId`: the table as above and its views;
     * a view the user cannot see (hidden by `visible_views`, someone
     * else's personal view, deleted, another table's) is the 404 screen
     * (CONTRACTS §15). A view created meanwhile elsewhere is looked up once more.
     */
    view: async ({ request, params }: LoaderFunctionArgs) => {
      const tableId = params['tableId'] ?? '';
      const viewId = params['viewId'] ?? '';
      await loadTable(request, params['baseId'] ?? '', tableId);
      await withSession(request, async () => {
        let views = await queryClient.query(viewsQuery(tableId));
        if (!views.items.some((item) => item.id === viewId)) {
          views = await queryClient.query({ ...viewsQuery(tableId), staleTime: 0 });
        }
        if (!views.items.some((item) => item.id === viewId)) notFound();
      });
      return null;
    },

    /**
     * `/b/:baseId/settings/*` (FRONTEND §2): base admins and owners only;
     * anyone else gets the 404 screen, like a base they cannot see.
     */
    baseSettings: async ({ request, params }: LoaderFunctionArgs) => {
      const base = await withSession(request, () =>
        queryClient.query(baseQuery(params['baseId'] ?? '')),
      );
      if (!isBaseAdmin(base.access)) notFound();
      return null;
    },

    /**
     * (T520) `/b/:baseId/automations`: anyone who opens the base reaches the
     * page; who manages which automation is the API's answer (the page shows
     * "you manage none" on its `403`). A base they cannot see is the 404 screen.
     */
    baseAutomations: async ({ request, params }: LoaderFunctionArgs) => {
      await withSession(request, () => queryClient.query(baseQuery(params['baseId'] ?? '')));
      return null;
    },

    /**
     * (T811) `/b/:baseId/d/:dashboardId`: the base and the dashboard; one the
     * caller cannot read (role, other base, trash, unknown id) is the 404 screen.
     */
    dashboard: async ({ request, params }: LoaderFunctionArgs) => {
      await withSession(request, async () => {
        const baseId = params['baseId'] ?? '';
        const [, dashboard] = await Promise.all([
          queryClient.query(baseQuery(baseId)),
          queryClient.query(dashboardQuery(params['dashboardId'] ?? '')),
        ]);
        if (dashboard.base_id !== baseId) notFound();
      });
      return null;
    },

    /** `/o/:orgSlug/settings/*`: organization owners and admins only (others: 404). */
    orgSettings: async ({ request, params }: LoaderFunctionArgs) => {
      const org = await withSession(request, () => findOrg(params['orgSlug']));
      if (!isOrgAdmin(org.role)) notFound();
      return null;
    },
  };
}

export type Guards = ReturnType<typeof createGuards>;
