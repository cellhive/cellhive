import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { json, ME, ORG, renderApp, stubApi } from '../../../../test/app-harness';
import { axeViolations } from '../../../../test/axe';
import { clearToasts } from '../../../lib/toast/toast';
import { confirmsName } from '../components/PurgeTableDialog';

const BASE = 'bse_0123456789ABCDEF';
const ORDERS = 'tbl_Orders0000000001';
const CUSTOMERS = 'tbl_Customers0000001';
const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function baseDetail(admin: boolean) {
  return {
    id: BASE,
    organization_id: ORG.id,
    workspace_id: 'wsp_0123456789ABCDEF',
    owner_id: ME.user.id,
    name: 'Sales',
    icon: null,
    description: null,
    permission_version: 3,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    deleted_at: null,
    access: {
      role: null,
      is_admin: admin,
      base_rule: { copy: true, download: true, share_link: true },
      tables: {},
      dashboards: {},
    },
  };
}

const table = (id: string, name: string) => ({
  id,
  base_id: BASE,
  name,
  description: null,
  primary_field_id: 'fld_Name000000000001',
  position: 0,
  schema_state: 'ready',
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
});

function trashedCustomers() {
  const deletedAt = ago(3 * DAY);
  return {
    ...table(CUSTOMERS, 'Khách hàng'),
    deleted_at: deletedAt,
    purge_after: new Date(Date.parse(deletedAt) + 30 * DAY).toISOString(),
    deleted_by: { id: 'usr_Deleter000000001', name: 'Trần Thu Hà' },
    field_count: 14,
    partner_fields: [
      {
        id: 'fld_Customer00000001',
        table_id: ORDERS,
        name: 'Khách hàng',
        kind: 'one_way',
        in_trash: false,
      },
    ],
    computed_fields: [
      { id: 'fld_Rank000000000001', table_id: ORDERS, name: 'Hạng khách', type: 'lookup' },
    ],
  };
}

function serve(admin: boolean) {
  let trash = [trashedCustomers()];
  const purges: unknown[] = [];
  const fetchMock = stubApi({
    signedIn: true,
    routes: {
      [`GET /bases/${BASE}`]: () => json(baseDetail(admin)),
      [`GET /bases/${BASE}/tables`]: () =>
        json({ items: [table(ORDERS, 'Đơn hàng')], total: 1, offset: 0, limit: 1000 }),
      [`GET /bases/${BASE}/tables/trash`]: () => json({ items: trash }),
      [`POST /tables/${ORDERS}/records/query`]: () =>
        json({ records: [], total: 0, offset: 0, limit: 1 }),
      [`POST /tables/${CUSTOMERS}/purge`]: (init) => {
        purges.push(JSON.parse(init?.body as string));
        trash = [];
        return json({
          id: CUSTOMERS,
          name: 'Khách hàng',
          record_count: 200,
          partner_field_ids: ['fld_Customer00000001'],
        });
      },
    },
  });
  return { fetchMock, purges };
}

afterEach(() => {
  clearToasts();
});

describe('confirmsName', () => {
  it.each([
    ['Khách hàng', 'Khách hàng', true],
    ['  Khách hàng ', 'Khách hàng', true],
    // NFD input (macOS keyboards) matches the NFC name.
    ['Khách hàng'.normalize('NFD'), 'Khách hàng', true],
    ['khách hàng', 'Khách hàng', false],
    ['', 'Khách hàng', false],
  ])('%j confirms %j: %s', (typed, name, expected) => {
    expect(confirmsName(typed, name)).toBe(expected);
  });
});

describe('BaseTrashPage (T469)', () => {
  it('lists deleted tables and purges one after the name is typed', async () => {
    const { purges } = serve(true);
    await renderApp(`/b/${BASE}/trash`);
    const list = await screen.findByTestId('table-trash');
    const row = within(list).getByTestId(`trashed-table-${CUSTOMERS}`);
    expect(within(row).getByText('Khách hàng')).toBeVisible();
    expect(within(row).getByText('14 fields')).toBeVisible();
    expect(within(row).getByText('1 link from another table')).toBeVisible();
    expect(within(row).getByText('Trần Thu Hà')).toBeVisible();
    expect(within(row).getByText(/27 days left|28 days left/u)).toBeVisible();
    // The sidebar entry, admins only, with the number of deleted tables.
    expect(await screen.findByTestId('base-trash-count')).toHaveTextContent('1');
    expect(await axeViolations(document.body)).toEqual([]);

    await userEvent.click(
      within(row).getByRole('button', { name: 'Delete table Khách hàng permanently' }),
    );
    const dialog = await screen.findByTestId('purge-table-dialog');
    expect(within(dialog).getByTestId('purge-table-partners')).toHaveTextContent(
      'Khách hàng in Đơn hàngOne-way link',
    );
    expect(within(dialog).getByTestId('purge-table-computed')).toHaveTextContent('Hạng khách');
    expect(within(dialog).getByTestId('purge-table-computed')).toHaveTextContent('#REF!');
    const confirm = within(dialog).getByTestId('purge-table-confirm');
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByTestId('purge-table-name'), 'khách');
    expect(confirm).toBeDisabled();
    await userEvent.clear(within(dialog).getByTestId('purge-table-name'));
    await userEvent.type(within(dialog).getByTestId('purge-table-name'), 'Khách hàng');
    expect(confirm).toBeEnabled();
    expect(await axeViolations(document.body)).toEqual([]);
    await userEvent.click(confirm);
    await waitFor(() => {
      expect(purges).toEqual([{ confirm_name: 'Khách hàng' }]);
    });
    expect(
      await screen.findByText('Table Khách hàng and its 200 records deleted permanently.'),
    ).toBeVisible();
    expect(await screen.findByText('No deleted tables')).toBeVisible();
  });

  it('is the 404 screen for people who are not base admins', async () => {
    const { fetchMock } = serve(false);
    await renderApp(`/b/${BASE}/trash`);
    expect(await screen.findByText('Page not found')).toBeVisible();
    expect(screen.queryByTestId('base-trash-link')).toBeNull();
    const asked = fetchMock.mock.calls.map(([url]) => url);
    expect(asked.some((url) => url.includes('/tables/trash'))).toBe(false);
  });
});
