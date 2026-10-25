import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { json, ME, ORG, renderApp, stubApi } from '../../../../test/app-harness';

const BASE = 'bse_0123456789ABCDEF';
const ORDERS = 'tbl_Orders0000000001';
const NOTES = 'tbl_Notes00000000001';

function access(perm: 'read_only' | 'edit', operations: string[]) {
  return {
    perm,
    operations,
    view_rule: { allow_edit: false, visible_views: null },
    read_scope: 'all',
    fields: {},
    option_edit_fields: [],
    file_download_fields: [],
  };
}

function table(id: string, name: string, position: number) {
  return {
    id,
    base_id: BASE,
    name,
    description: null,
    primary_field_id: 'fld_Name000000000001',
    position,
    schema_state: 'ready',
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
  };
}

function serve(tables: ReturnType<typeof table>[]) {
  stubApi({
    signedIn: true,
    routes: {
      [`GET /bases/${BASE}`]: () =>
        json({
          id: BASE,
          organization_id: ORG.id,
          workspace_id: 'wsp_0123456789ABCDEF',
          owner_id: ME.user.id,
          name: 'Sales',
          icon: null,
          description: null,
          permission_version: 1,
          created_at: '2026-09-01T00:00:00.000Z',
          updated_at: '2026-09-01T00:00:00.000Z',
          deleted_at: null,
          access: {
            role: null,
            is_admin: false,
            base_rule: { copy: false, download: false, share_link: false },
            // Orders: may delete records (and so open its trash); Notes: read only.
            tables: {
              [ORDERS]: access('edit', ['add', 'delete']),
              [NOTES]: access('read_only', []),
            },
            dashboards: {},
          },
        }),
      [`GET /bases/${BASE}/tables`]: () =>
        json({ items: tables, total: tables.length, offset: 0, limit: 1000 }),
    },
  });
}

describe('BasePage', () => {
  it('opens the first table when the base has tables (the grid links to the trash)', async () => {
    serve([table(ORDERS, 'Orders', 0), table(NOTES, 'Notes', 1)]);
    const { router } = await renderApp(`/b/${BASE}`);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/b/${BASE}/t/${ORDERS}`);
    });
  });

  it('keeps the empty state without tables', async () => {
    serve([]);
    await renderApp(`/b/${BASE}`);
    expect(await screen.findByRole('heading', { name: 'No tables yet' })).toBeVisible();
  });
});
