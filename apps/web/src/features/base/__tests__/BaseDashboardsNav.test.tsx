import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { json, ME, problem, renderApp, stubApi } from '../../../../test/app-harness';
import { axeViolations } from '../../../../test/axe';
import { BASE_ID, baseDetail, NOW, TABLE } from '../../../../test/records';
import { clearToasts } from '../../../lib/toast/toast';

import type { AccessKind } from '../../../../test/records';

const SALES = 'dsh_Sales00000000001';
const OPS = 'dsh_Ops0000000000001';
const NEW = 'dsh_New0000000000001';
const DAY = 24 * 60 * 60 * 1000;

interface Item {
  id: string;
  name: string;
  version: number;
}

const summary = (item: Item, position: number) => ({
  id: item.id,
  base_id: BASE_ID,
  name: item.name,
  icon: null,
  description: null,
  position,
  version: item.version,
  widget_count: 0,
  created_at: NOW,
  updated_at: NOW,
});

function dashboardDto(item: Item) {
  return {
    id: item.id,
    base_id: BASE_ID,
    name: item.name,
    icon: null,
    description: null,
    theme: {},
    global_filters: [],
    position: 0,
    version: item.version,
    created_by: null,
    widgets: [],
    created_at: NOW,
    updated_at: NOW,
  };
}

function serve(kind: AccessKind, initial: Item[], trashed: Item[] = []) {
  let items = [...initial];
  let trash = trashed.map((item) => ({
    ...item,
    deleted_at: new Date(Date.now() - DAY).toISOString(),
  }));
  const requests: { method: string; path: string; body: unknown; ifMatch: string | null }[] = [];
  const record = (method: string, path: string, init: RequestInit | undefined) => {
    requests.push({
      method,
      path,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      ifMatch: new Headers(init?.headers).get('If-Match'),
    });
  };
  const one = (dashboardId: string) => () => {
    const item = items.find((entry) => entry.id === dashboardId);
    return item === undefined ? problem('NOT_FOUND', 404) : json(dashboardDto(item));
  };
  const routes: Record<string, (init: RequestInit | undefined) => Response> = {
    [`GET /bases/${BASE_ID}`]: () => json(baseDetail(kind)),
    [`GET /bases/${BASE_ID}/tables`]: () =>
      json({ items: [TABLE], total: 1, offset: 0, limit: 1000 }),
    [`GET /bases/${BASE_ID}/tables/trash`]: () => json({ items: [] }),
    [`GET /bases/${BASE_ID}/dashboards`]: () => json({ items: items.map(summary) }),
    [`GET /bases/${BASE_ID}/dashboards/trash`]: () =>
      json({
        items: trash.map((item) => ({
          id: item.id,
          base_id: BASE_ID,
          name: item.name,
          icon: null,
          widget_count: 2,
          deleted_at: item.deleted_at,
          deleted_by: { id: ME.user.id, name: 'An Nguyen' },
          purge_at: new Date(Date.parse(item.deleted_at) + 30 * DAY).toISOString(),
        })),
      }),
    [`POST /bases/${BASE_ID}/dashboards`]: (init) => {
      record('POST', 'create', init);
      const body = JSON.parse(init?.body as string) as { name: string };
      const created = { id: NEW, name: body.name, version: 1 };
      items = [...items, created];
      return json(dashboardDto(created), 201);
    },
  };
  for (const item of [...initial, ...trashed, { id: NEW, name: '', version: 1 }]) {
    routes[`GET /dashboards/${item.id}`] = one(item.id);
    routes[`PATCH /dashboards/${item.id}`] = (init) => {
      record('PATCH', item.id, init);
      const body = JSON.parse(init?.body as string) as { name: string };
      items = items.map((entry) =>
        entry.id === item.id ? { ...entry, name: body.name, version: entry.version + 1 } : entry,
      );
      return one(item.id)();
    };
    routes[`DELETE /dashboards/${item.id}`] = (init) => {
      record('DELETE', item.id, init);
      const gone = items.find((entry) => entry.id === item.id);
      items = items.filter((entry) => entry.id !== item.id);
      if (gone !== undefined) trash = [{ ...gone, deleted_at: new Date().toISOString() }, ...trash];
      return new Response(null, { status: 204 });
    };
    routes[`POST /dashboards/${item.id}/restore`] = (init) => {
      record('POST', `restore ${item.id}`, init);
      const back = trash.find((entry) => entry.id === item.id);
      if (back === undefined) return problem('NOT_FOUND', 404);
      trash = trash.filter((entry) => entry.id !== item.id);
      items = [...items, { id: back.id, name: back.name, version: back.version }];
      return json(dashboardDto(back));
    };
  }
  stubApi({ signedIn: true, routes });
  return { requests };
}

afterEach(() => {
  clearToasts();
});

describe('Dashboards in the base sidebar (T811)', () => {
  it('lets a base admin create, rename and delete dashboards', async () => {
    const { requests } = serve('admin', [
      { id: SALES, name: 'Sales overview', version: 1 },
      { id: OPS, name: 'Operations', version: 4 },
    ]);
    const { router } = await renderApp(`/b/${BASE_ID}/d/${SALES}`);
    const nav = await screen.findByTestId('dashboards-nav');
    expect(await within(nav).findByTestId(`dashboard-link-${SALES}`)).toHaveAttribute(
      'aria-current',
      'page',
    );

    // Create: opens the new dashboard.
    await userEvent.click(within(nav).getByTestId('new-dashboard'));
    const create = await screen.findByTestId('dashboard-name-dialog');
    const name = within(create).getByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Pipeline');
    expect(await axeViolations(document.body)).toEqual([]);
    await userEvent.click(within(create).getByRole('button', { name: 'Create' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/b/${BASE_ID}/d/${NEW}`);
    });
    expect(await within(nav).findByTestId(`dashboard-link-${NEW}`)).toHaveTextContent('Pipeline');
    await waitFor(() => {
      expect(screen.getByTestId('dashboard-title')).toHaveTextContent('Pipeline');
    });

    // Rename another one with its version.
    await userEvent.click(within(nav).getByTestId(`dashboard-menu-${OPS}`));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    const rename = await screen.findByTestId('dashboard-name-dialog');
    await userEvent.clear(within(rename).getByLabelText('Name'));
    await userEvent.type(within(rename).getByLabelText('Name'), 'Ops');
    await userEvent.click(within(rename).getByRole('button', { name: 'Save' }));
    expect(await within(nav).findByText('Ops')).toBeVisible();

    // Delete: to the trash, with "Undo".
    await userEvent.click(within(nav).getByTestId(`dashboard-menu-${OPS}`));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Delete dashboard' }));
    await userEvent.click(await screen.findByTestId('delete-dashboard-confirm'));
    expect(await screen.findByText(/Deleted dashboard Ops/u)).toBeVisible();
    await waitFor(() => {
      expect(within(nav).queryByTestId(`dashboard-link-${OPS}`)).toBeNull();
    });
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await within(nav).findByTestId(`dashboard-link-${OPS}`)).toBeVisible();

    expect(
      requests.map(({ method, path, body, ifMatch }) => [method, path, body, ifMatch]),
    ).toEqual([
      ['POST', 'create', { name: 'Pipeline' }, null],
      ['PATCH', OPS, { name: 'Ops' }, '"4"'],
      ['DELETE', OPS, undefined, null],
      ['POST', `restore ${OPS}`, undefined, null],
    ]);
  });

  it('lists only what members may read, without admin actions', async () => {
    serve('reader', [{ id: SALES, name: 'Sales overview', version: 1 }]);
    await renderApp(`/b/${BASE_ID}/d/${SALES}`);
    const nav = await screen.findByTestId('dashboards-nav');
    expect(await within(nav).findByTestId(`dashboard-link-${SALES}`)).toBeVisible();
    expect(within(nav).queryByTestId('new-dashboard')).toBeNull();
    expect(within(nav).queryByTestId(`dashboard-menu-${SALES}`)).toBeNull();
  });

  it('restores a deleted dashboard from the base trash', async () => {
    const { requests } = serve('admin', [], [{ id: OPS, name: 'Operations', version: 1 }]);
    const { router } = await renderApp(`/b/${BASE_ID}/trash?tab=dashboards`);
    const list = await screen.findByTestId('dashboard-trash');
    const row = within(list).getByTestId(`trashed-dashboard-${OPS}`);
    expect(within(row).getByText('Operations')).toBeVisible();
    expect(within(row).getByText('2 widgets')).toBeVisible();
    expect(screen.getByRole('tab', { name: /Dashboards/u })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(await axeViolations(document.body)).toEqual([]);
    await userEvent.click(within(row).getByTestId(`restore-dashboard-${OPS}`));
    expect(await screen.findByText('Dashboard Operations restored.')).toBeVisible();
    expect(await screen.findByText('No deleted dashboards')).toBeVisible();
    expect(requests.map((item) => item.path)).toEqual([`restore ${OPS}`]);
    expect(router.state.location.search).toBe('?tab=dashboards');
    // The sidebar lists it again.
    expect(
      await within(await screen.findByTestId('dashboards-nav')).findByTestId(
        `dashboard-link-${OPS}`,
      ),
    ).toBeVisible();
  });
});
