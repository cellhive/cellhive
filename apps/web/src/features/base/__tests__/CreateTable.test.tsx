import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { json, problem, renderApp, stubApi } from '../../../../test/app-harness';
import { axeViolations } from '../../../../test/axe';
import { BASE_ID, baseDetail, fieldList, TABLE } from '../../../../test/records';

import type { AccessKind } from '../../../../test/records';

const NEW = 'tbl_Tasks00000000001';

/** A base without tables; `POST /tables` adds one, or answers `conflict`. */
function serve(kind: AccessKind, { conflict = false } = {}) {
  let tables: (typeof TABLE)[] = [];
  const posted: unknown[] = [];
  stubApi({
    signedIn: true,
    routes: {
      [`GET /bases/${BASE_ID}`]: () => json(baseDetail(kind)),
      [`GET /bases/${BASE_ID}/tables`]: () =>
        json({ items: tables, total: tables.length, offset: 0, limit: 1000 }),
      [`GET /bases/${BASE_ID}/tables/trash`]: () => json({ items: [] }),
      [`GET /bases/${BASE_ID}/dashboards`]: () => json({ items: [] }),
      [`POST /bases/${BASE_ID}/tables`]: (init) => {
        const body = JSON.parse(init?.body as string) as { name: string };
        posted.push(body);
        if (conflict) return problem('NAME_CONFLICT', 409);
        const created = { ...TABLE, id: NEW, name: body.name };
        tables = [created];
        return json(created, 201);
      },
      [`GET /tables/${NEW}`]: () => json(tables[0]),
      [`GET /tables/${NEW}/fields`]: () => json(fieldList()),
      // No view: the table opens on its "no view" screen, not the canvas grid (jsdom has no ResizeObserver).
      [`GET /tables/${NEW}/views`]: () => json({ items: [], total: 0, offset: 0, limit: 1000 }),
    },
  });
  return { posted };
}

describe('Creating a table', () => {
  it('lets a base admin create a table from an empty base and opens it', async () => {
    const { posted } = serve('admin');
    const { router } = await renderApp(`/b/${BASE_ID}`);
    await userEvent.click(await screen.findByTestId('empty-base-new-table'));
    const dialog = await screen.findByTestId('create-table-dialog');
    const name = within(dialog).getByLabelText('Name');
    expect(name).toHaveValue('Table 1');
    expect(name).toHaveAccessibleDescription(/starts with a Name field/u);
    await userEvent.clear(name);
    await userEvent.type(name, 'Tasks');
    expect(await axeViolations(document.body)).toEqual([]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      expect(router.state.location.pathname).toMatch(new RegExp(`^/b/${BASE_ID}/t/${NEW}`, 'u'));
    });
    expect(posted).toEqual([{ name: 'Tasks' }]);
    // The sidebar lists it: the table list was refreshed.
    const tablesNav = await screen.findByRole('navigation', { name: 'Tables' });
    expect(await within(tablesNav).findByRole('link', { name: /Tasks/u })).toBeVisible();
  });

  it('opens from the sidebar and keeps the dialog open on a name in use', async () => {
    const { posted } = serve('admin', { conflict: true });
    const { router } = await renderApp(`/b/${BASE_ID}`);
    // The sidebar's "+" (the empty base shows a "New table" button of its own).
    const sidebarButton = await screen.findByTestId('new-table');
    expect(sidebarButton).toHaveAccessibleName('New table');
    await userEvent.click(sidebarButton);
    const dialog = await screen.findByTestId('create-table-dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create' }));

    expect(await within(dialog).findByText('This name is already in use.')).toBeVisible();
    expect(posted).toEqual([{ name: 'Table 1' }]);
    expect(router.state.location.pathname).toBe(`/b/${BASE_ID}`);
  });

  it('offers neither entry to members who cannot change the schema', async () => {
    serve('editor');
    await renderApp(`/b/${BASE_ID}`);
    expect(await screen.findByText('No tables yet')).toBeVisible();
    expect(screen.queryByTestId('empty-base-new-table')).toBeNull();
    expect(screen.queryByTestId('new-table')).toBeNull();
  });
});
