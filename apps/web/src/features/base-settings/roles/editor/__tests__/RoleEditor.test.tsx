import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { json, ME, ORG, renderApp, stubApi } from '../../../../../../test/app-harness';
import { axeViolations } from '../../../../../../test/axe';
import { clearToasts } from '../../../../../lib/toast/toast';

import type { BasePrincipalDto, RoleAdjustmentDto, RoleDto } from '@cellhive/contracts';

/** T713: the role editor and the member access panel (FRONTEND §17.4, §17.3). */

const BASE = 'bse_0123456789ABCDEF';
const NOW = '2026-10-24T03:00:00.000Z';
const ORDERS = 'tbl_Orders0000000001';
const CUSTOMERS = 'tbl_Customers0000001';
const READER = 'usr_Reader0000000001';
const D_SALES = 'dsh_Sales00000000001';
const D_OPS = 'dsh_Ops0000000000001';

function dashboard(id: string, name: string, position: number) {
  return {
    id,
    base_id: BASE,
    name,
    icon: null,
    description: null,
    position,
    version: 1,
    widget_count: 2,
    created_at: NOW,
    updated_at: NOW,
  };
}
const F = {
  title: 'fld_Title00000000001',
  amount: 'fld_Amount0000000001',
  cost: 'fld_Cost000000000001',
  status: 'fld_Status0000000001',
  owner: 'fld_Owner00000000001',
  total: 'fld_Total00000000001',
  name: 'fld_Name000000000001',
} as const;

function role(
  id: string,
  kind: RoleDto['kind'],
  name: string,
  position: number,
  config: Record<string, unknown> = {},
): RoleDto {
  return {
    id: id as RoleDto['id'],
    base_id: BASE,
    name,
    kind,
    config,
    position,
    assignments: [],
    created_at: NOW,
    updated_at: NOW,
  };
}

const ADMIN_ROLE = role('rol_Admin00000000001', 'system_admin', 'Admin', 0);
const EDITOR_ROLE = role('rol_Editor0000000001', 'system_editor', 'Editor', 1);
const READER_ROLE = role('rol_Reader0000000001', 'system_reader', 'Reader', 2);
const EMPTY_ROLE = role('rol_Empty00000000001', 'custom', 'Kế toán', 3);

function field(
  id: string,
  tableId: string,
  name: string,
  type: string,
  position: number,
  options = {},
) {
  return {
    id,
    table_id: tableId,
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

const ORDER_FIELDS = [
  field(F.title, ORDERS, 'Title', 'text', 0),
  field(F.amount, ORDERS, 'Amount', 'number', 1),
  field(F.cost, ORDERS, 'Cost', 'number', 2),
  field(F.status, ORDERS, 'Status', 'select', 3, {
    multiple: false,
    options: [{ id: 'opt_New0000000000001', name: 'New', color: 1 }],
  }),
  field(F.owner, ORDERS, 'Owner', 'user', 4, { multiple: false }),
  field(F.total, ORDERS, 'Total', 'formula', 5),
];

function table(id: string, name: string, primary: string, position: number) {
  return {
    id,
    base_id: BASE,
    name,
    description: null,
    primary_field_id: primary,
    position,
    schema_state: 'ready',
    created_at: NOW,
    updated_at: NOW,
  };
}

function list(items: unknown[]) {
  return json({ items, total: items.length, offset: 0, limit: 1000 });
}

function baseDetail() {
  return {
    id: BASE,
    organization_id: ORG.id,
    workspace_id: 'wsp_0123456789ABCDEF',
    owner_id: ME.user.id,
    name: 'Chăm sóc khách hàng',
    icon: null,
    description: null,
    permission_version: 3,
    settings: { strict_computed_permissions: false },
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    access: {
      role: null,
      is_admin: true,
      base_rule: { copy: true, download: true, share_link: true },
      tables: {},
      dashboards: {},
    },
  };
}

function serve(options: { adjustments?: RoleAdjustmentDto[] } = {}) {
  let roles = [ADMIN_ROLE, EDITOR_ROLE, READER_ROLE, EMPTY_ROLE];
  const patches: unknown[] = [];
  const fetchMock = stubApi({
    signedIn: true,
    routes: {
      [`GET /bases/${BASE}`]: () => json(baseDetail()),
      [`GET /bases/${BASE}/tables`]: () =>
        list([table(ORDERS, 'Orders', F.title, 0), table(CUSTOMERS, 'Customers', F.name, 1)]),
      [`GET /bases/${BASE}/tables/trash`]: () => json({ items: [] }),
      [`GET /bases/${BASE}/automations`]: () => list([]),
      [`GET /bases/${BASE}/dashboards`]: () =>
        json({
          items: [dashboard(D_SALES, 'Sales overview', 0), dashboard(D_OPS, 'Operations', 1)],
        }),
      [`GET /tables/${ORDERS}/fields`]: () => list(ORDER_FIELDS),
      [`GET /tables/${CUSTOMERS}/fields`]: () =>
        list([field(F.name, CUSTOMERS, 'Name', 'text', 0)]),
      [`GET /orgs/${ORG.id}/members`]: () =>
        list([{ user: { ...ME.user }, role: 'owner', joined_at: NOW }]),
      [`GET /orgs/${ORG.id}/groups`]: () =>
        list([
          {
            id: 'grp_Sales00000000001',
            organization_id: ORG.id,
            name: 'Sales',
            member_count: 2,
            created_at: NOW,
            updated_at: NOW,
          },
        ]),
      [`GET /bases/${BASE}/roles`]: () => list(roles),
      [`PATCH /bases/${BASE}/roles/${EMPTY_ROLE.id}`]: (init) => {
        const sent = JSON.parse(init?.body as string) as { config: Record<string, unknown> };
        patches.push(sent);
        const saved = {
          ...EMPTY_ROLE,
          config: sent.config,
          updated_at: '2026-10-24T04:00:00.000Z',
        };
        roles = roles.map((item) => (item.id === saved.id ? saved : item));
        return json({ ...saved, adjustments: options.adjustments ?? [] });
      },
      [`GET /bases/${BASE}/members/${READER}/access`]: () =>
        json({
          user: { id: READER, display_name: 'Lê Quốc Bảo' },
          access: {
            role: null,
            is_admin: false,
            base_rule: { copy: false, download: false, share_link: false },
            tables: {
              [ORDERS]: {
                perm: 'edit',
                operations: ['add'],
                view_rule: { allow_edit: false, visible_views: null },
                read_scope: 'editable',
                fields: {
                  [F.title]: 'edit',
                  [F.amount]: 'edit',
                  [F.status]: 'read',
                  [F.owner]: 'create',
                  [F.total]: 'read',
                },
                option_edit_fields: [],
                file_download_fields: [],
              },
            },
            dashboards: { [D_SALES]: 'read_only' },
          },
          source: {
            kind: 'group_roles',
            role_ids: [EMPTY_ROLE.id],
            group_ids: ['grp_Sales00000000001'],
          },
          counts: { [ORDERS]: { readable: 1, editable: 1 } },
        }),
    },
  });
  const routed = fetchMock.getMockImplementation();
  fetchMock.mockImplementation((input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname === `/api/v1/bases/${BASE}/principals`) {
      const items: BasePrincipalDto[] = [
        {
          principal_type: 'user',
          principal_id: READER,
          name: 'Lê Quốc Bảo',
          email: 'reader@example.test',
          role_id: null,
          full_access: null,
        },
        {
          principal_type: 'group',
          principal_id: 'grp_Sales00000000001',
          name: 'Sales',
          email: null,
          role_id: EMPTY_ROLE.id,
          full_access: 'workspace_admin',
        },
      ];
      return Promise.resolve(json({ items, next_cursor: null }));
    }
    if (routed === undefined) throw new Error('no fetch stub');
    return routed(input, init);
  });
  return { patches };
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

const editorPath = (roleId: string, query = '') => `/b/${BASE}/settings/roles/${roleId}${query}`;

async function matrix() {
  return screen.findByTestId('table-matrix', undefined, { timeout: 10_000 });
}

describe('role editor (T713)', () => {
  it('a custom role: the matrix, arrow keys on a level, the unsaved bar and Cancel', async () => {
    const user = userEvent.setup();
    serve();
    await renderApp(editorPath(EMPTY_ROLE.id));
    const grid = await matrix();
    const orders = within(grid).getByRole('radiogroup', { name: 'Access to Orders' });
    const none = within(orders).getByRole('radio', { name: 'No access' });
    expect(none).toHaveAttribute('aria-checked', 'true');
    // One tab stop: the chosen level; arrows move and choose (wrapping).
    expect(none).toHaveAttribute('tabindex', '0');
    expect(within(orders).getByRole('radio', { name: 'Edit' })).toHaveAttribute('tabindex', '-1');
    none.focus();
    await user.keyboard('{ArrowLeft}');
    const readOnly = within(orders).getByRole('radio', { name: 'Read only' });
    expect(readOnly).toHaveAttribute('aria-checked', 'true');
    expect(readOnly).toHaveFocus();
    await user.keyboard('{Home}');
    expect(within(orders).getByRole('radio', { name: 'Manage' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByTestId('unsaved-bar')).toHaveTextContent('Unsaved changes');
    expect(await axeViolations(document.body)).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('unsaved-bar')).toBeNull();
    expect(none).toHaveAttribute('aria-checked', 'true');
  });

  it('saves the whole config and shows the adjustments beside the field', async () => {
    const user = userEvent.setup();
    const { patches } = serve({
      adjustments: [
        {
          table_id: ORDERS,
          field_id: F.total,
          from: 'edit',
          to: 'read',
          reason: 'computed_field_max_read',
        },
      ] as RoleAdjustmentDto[],
    });
    const { router } = await renderApp(editorPath(EMPTY_ROLE.id));
    const grid = await matrix();
    await user.click(
      within(within(grid).getByRole('radiogroup', { name: 'Access to Orders' })).getByRole(
        'radio',
        {
          name: 'Edit',
        },
      ),
    );
    await user.click(screen.getByRole('link', { name: /^Details of Orders/u }));
    await waitFor(() => {
      expect(router.state.location.search).toBe(`?table=${ORDERS}`);
    });
    const detail = await screen.findByTestId('table-detail');
    await user.click(within(detail).getByRole('checkbox', { name: 'Add records' }));
    await user.click(within(detail).getByRole('radio', { name: 'Only the records it can edit' }));
    await user.click(within(detail).getByRole('radio', { name: 'Choose per field' }));
    await user.click(
      within(within(detail).getByRole('radiogroup', { name: 'Permission on Cost' })).getByRole(
        'radio',
        {
          name: 'None',
        },
      ),
    );
    await user.click(
      within(within(detail).getByRole('radiogroup', { name: 'Permission on Status' })).getByRole(
        'radio',
        {
          name: 'Read',
        },
      ),
    );
    // A computed field can be set to Edit: the row says it is saved as Read.
    const total = within(detail).getByRole('radiogroup', { name: 'Permission on Total' });
    expect(total).toHaveAccessibleDescription(/Computed: at most Read/u);
    await user.click(within(total).getByRole('radio', { name: 'Edit' }));
    expect(screen.getByTestId('records-summary')).toHaveTextContent(
      'Edits every record. Reads the records it can edit (every record, without a condition). Can add records, not delete them.',
    );
    expect(await axeViolations(document.body)).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(patches).toHaveLength(1);
    });
    expect(patches[0]).toEqual({
      config: {
        base_rule: { copy: false, download: false, share_link: false },
        dashboards: {},
        tables: {
          [ORDERS]: {
            perm: 'edit',
            view_rule: { allow_edit: false, visible_views: null },
            record_rule: {
              operations: ['add'],
              edit_filter: null,
              read_scope: 'editable',
              read_filter: null,
            },
            field_rule: {
              mode: 'specify',
              fields: {
                [F.title]: 'edit',
                [F.amount]: 'edit',
                [F.cost]: 'no_perm',
                [F.status]: 'read',
                [F.owner]: 'edit',
                [F.total]: 'edit',
              },
              option_edit_fields: [],
              file_download_fields: [],
            },
          },
        },
      },
    });
    // The reason sits beside the field it changed, and in the summary note.
    const row = within(detail)
      .getAllByTestId('field-row')
      .find((item) => item.dataset['fieldId'] === F.total);
    expect(row).toBeDefined();
    expect(within(row as HTMLElement).getByTestId('adjustment')).toHaveTextContent(
      'Total was lowered to Read: computed fields are at most Read.',
    );
    expect(screen.getByTestId('adjustments')).toHaveTextContent(
      'The server adjusted 1 permission when saving',
    );
    expect(screen.queryByTestId('unsaved-bar')).toBeNull();
  });

  it('asks before leaving with unsaved changes', async () => {
    const user = userEvent.setup();
    serve();
    const { router } = await renderApp(editorPath(EMPTY_ROLE.id));
    await matrix();
    await user.click(screen.getByRole('checkbox', { name: 'Copy' }));
    const nav = screen.getByRole('navigation', { name: 'Base settings' });
    expect(within(nav).getByRole('link', { name: 'Roles' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await user.click(within(nav).getByRole('link', { name: 'Members' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Leave without saving?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(router.state.location.pathname).toBe(`/b/${BASE}/settings/roles/${EMPTY_ROLE.id}`);
    await user.click(within(nav).getByRole('link', { name: 'Members' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Leave without saving',
      }),
    );
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/b/${BASE}/settings/members`);
    });
  });

  it.each([
    [EDITOR_ROLE, 'Manage', 'Not for the Editor role: it never goes above Edit.'],
    [READER_ROLE, 'Edit', 'Not for the Reader role: it only reads.'],
  ])('%s: levels above the ceiling are off with the reason', async (systemRole, level, reason) => {
    serve();
    await renderApp(editorPath(systemRole.id));
    const grid = await matrix();
    expect(screen.getByTestId('role-ceiling')).toBeVisible();
    const orders = within(grid).getByRole('radiogroup', { name: 'Access to Orders' });
    const blocked = within(orders).getByRole('radio', { name: level });
    expect(blocked).toHaveAttribute('aria-disabled', 'true');
    expect(blocked).toHaveAccessibleDescription(reason);
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('the admin role is read-only', async () => {
    const user = userEvent.setup();
    serve();
    await renderApp(editorPath(ADMIN_ROLE.id));
    const grid = await matrix();
    expect(screen.getByTestId('role-read-only')).toHaveTextContent('cannot be changed');
    const orders = within(grid).getByRole('radiogroup', { name: 'Access to Orders' });
    expect(orders).toHaveAttribute('aria-disabled', 'true');
    await user.click(within(orders).getByRole('radio', { name: 'Edit' }));
    expect(within(orders).getByRole('radio', { name: 'Manage' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('checkbox', { name: 'Copy' })).toBeDisabled();
    expect(screen.queryByTestId('unsaved-bar')).toBeNull();
  });
});

describe('dashboards in the role editor (T815)', () => {
  it('a custom role: new dashboards start at No access; one by keyboard, View all, saved by id', async () => {
    const user = userEvent.setup();
    const { patches } = serve();
    await renderApp(editorPath(EMPTY_ROLE.id));
    await matrix();
    const section = await screen.findByTestId('dashboard-section');
    expect(within(section).getByRole('heading', { name: 'Dashboards' })).toBeVisible();
    expect(section).toHaveTextContent('New dashboards start at “No access” for this role');
    expect(within(section).getByTestId('dashboard-widgets-note')).toHaveTextContent(
      "Widgets still apply this role's table, field and record permissions",
    );
    const sales = await within(section).findByRole('radiogroup', {
      name: 'Access to the dashboard Sales overview',
    });
    const none = within(sales).getByRole('radio', { name: 'No access' });
    expect(none).toHaveAttribute('aria-checked', 'true');
    expect(none).toHaveAttribute('tabindex', '0');
    // Keyboard: arrows move and choose (the radiogroup of the table levels).
    none.focus();
    await user.keyboard('{ArrowLeft}');
    expect(within(sales).getByRole('radio', { name: 'View' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByTestId('unsaved-bar')).toBeVisible();
    expect(await axeViolations(document.body)).toEqual([]);

    await user.click(within(section).getByRole('button', { name: 'View all' }));
    const ops = within(section).getByRole('radiogroup', {
      name: 'Access to the dashboard Operations',
    });
    expect(within(ops).getByRole('radio', { name: 'View' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(within(section).getByRole('button', { name: 'View all' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(patches).toHaveLength(1);
    });
    expect(patches[0]).toMatchObject({
      config: { dashboards: { [D_SALES]: 'read_only', [D_OPS]: 'read_only' }, tables: {} },
    });
    expect(screen.queryByTestId('unsaved-bar')).toBeNull();

    // "No access to any": a custom role does not list what it cannot read.
    await user.click(within(section).getByRole('button', { name: 'No access to any' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(patches).toHaveLength(2);
    });
    expect(patches[1]).toMatchObject({ config: { dashboards: {} } });
  });

  it.each([EDITOR_ROLE, READER_ROLE, ADMIN_ROLE])(
    '%s: every dashboard viewed, read-only',
    async (systemRole) => {
      serve();
      await renderApp(editorPath(systemRole.id));
      await matrix();
      const section = await screen.findByTestId('dashboard-section');
      const sales = await within(section).findByRole('radiogroup', {
        name: 'Access to the dashboard Sales overview',
      });
      expect(sales).toHaveAttribute('aria-disabled', 'true');
      expect(within(sales).getByRole('radio', { name: 'View' })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      expect(sales).toHaveAccessibleDescription(
        systemRole === ADMIN_ROLE
          ? 'The Admin role views and edits every dashboard of the base.'
          : /views every dashboard of the base, including new ones/u,
      );
      expect(within(section).queryByRole('button', { name: 'View all' })).toBeNull();
      expect(await axeViolations(document.body)).toEqual([]);
    },
  );
});

describe('member access panel (T713)', () => {
  it('shows where the access comes from and the records per table, read-only', async () => {
    const user = userEvent.setup();
    serve();
    await renderApp(`/b/${BASE}/settings/members`);
    // A group that is workspace admin: full access instead of a select.
    expect(await screen.findByTestId('full-access-grp_Sales00000000001')).toHaveTextContent(
      'Full access · workspace admin',
    );
    expect(screen.queryByRole('button', { name: 'View the access of Sales' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'View the access of Lê Quốc Bảo' }));
    const panel = await screen.findByRole('dialog', { name: 'Access of Lê Quốc Bảo' });
    expect(within(panel).getByText(/not a preview of the whole app/u)).toBeVisible();
    expect(await within(panel).findByTestId('access-source')).toHaveTextContent(
      'Through their groups Sales: Kế toán.',
    );
    const orders = within(panel).getByTestId('access-table');
    expect(orders).toHaveTextContent('Orders');
    expect(within(orders).getByTestId('access-counts')).toHaveTextContent('Reads 1 · edits 1');
    await waitFor(() => {
      expect(orders).toHaveTextContent('Hidden fieldsCost');
    });
    expect(orders).toHaveTextContent('Read-only fieldsStatus, Total');
    expect(within(panel).getByTestId('access-denied-tables')).toHaveTextContent(
      'No access: Customers',
    );
    // T815: the dashboards they read, then the others.
    const dashboards = await within(panel).findByTestId('access-dashboards-list');
    expect(dashboards).toHaveTextContent('Sales overview');
    expect(within(panel).getByTestId('access-denied-dashboards')).toHaveTextContent(
      'No access: Operations',
    );
    expect(await axeViolations(document.body)).toEqual([]);
  });
});
