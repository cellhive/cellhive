import { QueryClient } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { json, ME, ORG, renderApp, stubApi } from '../../../../test/app-harness';
import { axeViolations } from '../../../../test/axe';
import { keys } from '../../../lib/query/keys';
import { applyBaseMessage } from '../../../lib/realtime/channels';
import { clearToasts } from '../../../lib/toast/toast';
import { principalKeys } from '../hooks';

import type { BasePrincipalDto, RoleDto } from '@cellhive/contracts';

/** T712: base settings layout, roles page and members page (FRONTEND §17). */

const BASE = 'bse_0123456789ABCDEF';
const NOW = '2026-10-24T03:00:00.000Z';
const OWNER = 'usr_Owner00000000001';
const READER = 'usr_Reader0000000001';
const SALES = 'grp_Sales00000000001';

function role(
  id: string,
  kind: RoleDto['kind'],
  name: string,
  position: number,
  assignments: RoleDto['assignments'] = [],
): RoleDto {
  return {
    id: id as RoleDto['id'],
    base_id: BASE,
    name,
    kind,
    config: {},
    position,
    assignments,
    created_at: NOW,
    updated_at: NOW,
  };
}

const READER_ASSIGNEE: RoleDto['assignments'][number] = {
  principal_type: 'user',
  principal_id: READER,
  name: 'Lê Quốc Bảo',
  email: 'reader@example.test',
};
const SALES_ASSIGNEE: RoleDto['assignments'][number] = {
  principal_type: 'group',
  principal_id: SALES,
  name: 'Sales',
  email: null,
};

const ADMIN_ROLE = role('rol_Admin00000000001', 'system_admin', 'Admin', 0);
const EDITOR_ROLE = role('rol_Editor0000000001', 'system_editor', 'Editor', 1);
const READER_ROLE = role('rol_Reader0000000001', 'system_reader', 'Reader', 2, [READER_ASSIGNEE]);
const SALES_ROLE = role('rol_Sales00000000001', 'custom', 'Sales', 3, [SALES_ASSIGNEE]);
const EMPTY_ROLE = role('rol_Empty00000000001', 'custom', 'Kế toán', 4);

function baseDetail(admin: boolean) {
  return {
    id: BASE,
    organization_id: ORG.id,
    workspace_id: 'wsp_0123456789ABCDEF',
    owner_id: OWNER,
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
      is_admin: admin,
      base_rule: { copy: true, download: true, share_link: true },
      tables: {},
      dashboards: {},
    },
  };
}

function principal(
  id: string,
  name: string,
  roleId: string | null,
  email: string | null = null,
  fullAccess: BasePrincipalDto['full_access'] = null,
): BasePrincipalDto {
  return {
    principal_type: id.startsWith('grp_') ? 'group' : 'user',
    principal_id: id as BasePrincipalDto['principal_id'],
    name,
    email: id.startsWith('grp_') ? null : (email ?? `${id}@example.test`),
    role_id: roleId as BasePrincipalDto['role_id'],
    full_access: fullAccess,
  };
}

interface Call {
  readonly route: string;
  readonly body: unknown;
  readonly query: string;
}

function problemWith(code: string, status: number, errors: unknown[] = []): Response {
  return new Response(
    JSON.stringify({
      type: `https://cellhive.io/errors/${code}`,
      title: code,
      status,
      code,
      errors,
      request_id: 'req_0123456789ABCDEF',
    }),
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

function serve(
  options: {
    admin?: boolean;
    roles?: RoleDto[];
    principals?: BasePrincipalDto[];
    /** Answers of `POST /roles` / `PATCH /roles/:id` / `DELETE /roles/:id` instead of success. */
    createProblem?: () => Response;
    renameProblem?: () => Response;
    deleteProblem?: () => Response;
    /** Held answer of a principal search (`q` set) until this settles. */
    searchGate?: Promise<void>;
  } = {},
) {
  let roles = options.roles ?? [ADMIN_ROLE, EDITOR_ROLE, READER_ROLE, SALES_ROLE, EMPTY_ROLE];
  let principals = options.principals ?? [
    // (T713) The server says who has full access whatever their role.
    principal(ME.user.id, ME.user.display_name, null, ME.user.email, 'org_admin'),
    principal(OWNER, 'Chủ Base', null, null, 'base_owner'),
    principal(READER, 'Lê Quốc Bảo', READER_ROLE.id, 'reader@example.test'),
    principal(SALES, 'Sales', SALES_ROLE.id),
  ];
  const calls: Call[] = [];
  const record = (route: string, init: RequestInit | undefined, query = '') => {
    calls.push({
      route,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      query,
    });
  };
  const fetchMock = stubApi({
    signedIn: true,
    routes: {
      [`GET /bases/${BASE}`]: () => json(baseDetail(options.admin ?? true)),
      [`GET /bases/${BASE}/tables`]: () => json({ items: [], total: 0, offset: 0, limit: 1000 }),
      [`GET /bases/${BASE}/tables/trash`]: () => json({ items: [] }),
      [`GET /bases/${BASE}/automations`]: () =>
        json({ items: [], total: 0, offset: 0, limit: 1000 }),
      [`GET /orgs/${ORG.id}/members`]: () =>
        json({
          items: [
            {
              user: { ...ME.user },
              role: 'owner',
              joined_at: NOW,
            },
          ],
          total: 1,
          offset: 0,
          limit: 1000,
        }),
      [`GET /bases/${BASE}/roles`]: () =>
        json({ items: roles, total: roles.length, offset: 0, limit: 1000 }),
      [`POST /bases/${BASE}/roles`]: (init) => {
        record('role.create', init);
        if (options.createProblem !== undefined) return options.createProblem();
        const sent = JSON.parse(init?.body as string) as { name: string };
        const created = role('rol_Kho0000000000001', 'custom', sent.name, roles.length);
        roles = [...roles, created];
        return json({ ...created, adjustments: [] }, 201);
      },
      [`PATCH /bases/${BASE}/roles/${EMPTY_ROLE.id}`]: (init) => {
        record('role.rename', init);
        if (options.renameProblem !== undefined) return options.renameProblem();
        const sent = JSON.parse(init?.body as string) as { name: string };
        roles = roles.map((item) =>
          item.id === EMPTY_ROLE.id ? { ...item, name: sent.name } : item,
        );
        return json({ ...EMPTY_ROLE, name: sent.name, adjustments: [] });
      },
      [`DELETE /bases/${BASE}/roles/${EMPTY_ROLE.id}`]: (init) => {
        record('role.delete', init);
        if (options.deleteProblem !== undefined) {
          // Assigned meanwhile (another tab): the refetched role holds the assignment.
          roles = roles.map((item) =>
            item.id === EMPTY_ROLE.id ? { ...item, assignments: [READER_ASSIGNEE] } : item,
          );
          return options.deleteProblem();
        }
        roles = roles.filter((item) => item.id !== EMPTY_ROLE.id);
        return new Response(null, { status: 204 });
      },
      [`PUT /bases/${BASE}/role-assignments`]: (init) => {
        record('assign', init);
        const sent = JSON.parse(init?.body as string) as { principal_id: string; role_id: string };
        principals = principals.map((item) =>
          item.principal_id === sent.principal_id
            ? { ...item, role_id: sent.role_id as BasePrincipalDto['role_id'] }
            : item,
        );
        return json({ base_id: BASE, ...sent, previous_role_id: null });
      },
      [`DELETE /bases/${BASE}/role-assignments`]: (init) => {
        record('unassign', init);
        const sent = JSON.parse(init?.body as string) as { principal_id: string };
        principals = principals.map((item) =>
          item.principal_id === sent.principal_id ? { ...item, role_id: null } : item,
        );
        return new Response(null, { status: 204 });
      },
    },
  });
  // The principal list takes a query string: answered here (the harness matches paths only).
  const routed = fetchMock.getMockImplementation();
  fetchMock.mockImplementation((input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost');
    if (url.pathname === `/api/v1/bases/${BASE}/principals`) {
      record('principals', init, url.search);
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const items = principals.filter(
        (item) =>
          q === '' ||
          item.name.toLowerCase().includes(q) ||
          (item.email ?? '').toLowerCase().includes(q),
      );
      const answer = () => json({ items, next_cursor: null });
      if (q !== '' && options.searchGate !== undefined) return options.searchGate.then(answer);
      return Promise.resolve(answer());
    }
    if (routed === undefined) throw new Error('no fetch stub');
    return routed(input, init);
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

describe('base settings layout (T712)', () => {
  it('has the grouped base settings nav with the current page; General holds settings', async () => {
    serve();
    await renderApp(`/b/${BASE}/settings`);
    const nav = await screen.findByRole('navigation', { name: 'Base settings' });
    for (const name of ['General', 'Members', 'Roles', 'Share links', 'Webhooks', 'Audit log']) {
      expect(within(nav).getByRole('link', { name })).toBeVisible();
    }
    for (const group of ['Access', 'Integrations', 'Data']) {
      expect(within(nav).getByRole('heading', { name: group })).toBeInTheDocument();
    }
    expect(within(nav).getByRole('link', { name: 'General' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    // General is the base's own settings, not links repeating the nav.
    const general = await screen.findByTestId('base-settings-general');
    expect(within(general).getByLabelText('Base name')).toHaveValue('Chăm sóc khách hàng');
    expect(within(general).queryByRole('link', { name: /Roles/u })).toBeNull();
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('gives a base member who is not an admin the 404 screen without the nav', async () => {
    serve({ admin: false });
    await renderApp(`/b/${BASE}/settings/roles`);
    expect(await screen.findByText(/not found/iu)).toBeVisible();
    expect(screen.queryByRole('navigation', { name: 'Base settings' })).toBeNull();
    expect(screen.queryByTestId('role-table')).toBeNull();
  });

  it('refetches roles and principals on permission.changed of the base', () => {
    const client = new QueryClient();
    client.setQueryData(keys.roles(BASE), { items: [] });
    client.setQueryData(principalKeys.list(BASE, ''), { pages: [], pageParams: [] });
    applyBaseMessage(client, BASE, {
      type: 'permission.changed',
      channel: `base:${BASE}`,
    });
    expect(client.getQueryState(keys.roles(BASE))?.isInvalidated).toBe(true);
    expect(client.getQueryState(principalKeys.list(BASE, ''))?.isInvalidated).toBe(true);
  });
});

describe('roles page (T712)', () => {
  it('lists the roles in position order with labels, built-in badges and who holds them', async () => {
    serve();
    await renderApp(`/b/${BASE}/settings/roles`);
    const table = await screen.findByTestId('role-table');
    await waitFor(() => {
      expect(within(table).getAllByTestId('role-row')).toHaveLength(5);
    });
    const rows = within(table).getAllByTestId('role-row');
    expect(rows.map((row) => within(row).getByRole('rowheader').textContent)).toEqual([
      expect.stringContaining('Admin'),
      expect.stringContaining('Editor'),
      expect.stringContaining('Reader'),
      'Sales',
      'Kế toán',
    ]);
    expect(within(rows[0] as HTMLElement).getByText('Built-in')).toBeVisible();
    expect(within(rows[2] as HTMLElement).getByText('1 person')).toBeVisible();
    expect(within(rows[3] as HTMLElement).getByText('1 group')).toBeVisible();
    expect(within(rows[4] as HTMLElement).getByText('Not assigned')).toBeVisible();
    // System roles are neither renamed nor deleted here.
    expect(within(rows[0] as HTMLElement).queryByRole('button')).toBeNull();
    expect(
      within(rows[4] as HTMLElement).getByRole('button', { name: 'Rename Kế toán' }),
    ).toBeVisible();
    const nav = screen.getByRole('navigation', { name: 'Base settings' });
    expect(within(nav).getByRole('link', { name: 'Roles' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('creates a role by name; a taken name is shown under the input', async () => {
    const user = userEvent.setup();
    const calls = serve({
      createProblem: () =>
        problemWith('NAME_CONFLICT', 409, [
          { path: 'name', code: 'NAME_CONFLICT', message: 'Name already used' },
        ]),
    });
    await renderApp(`/b/${BASE}/settings/roles`);
    await user.click(await screen.findByRole('button', { name: 'New role' }));
    const dialog = await screen.findByRole('dialog', { name: 'New role' });
    const input = within(dialog).getByLabelText('Name');
    await user.type(input, 'Sales');
    await user.click(within(dialog).getByRole('button', { name: 'Create role' }));
    expect(
      await within(dialog).findByText('A role of this base already has this name.'),
    ).toBeVisible();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(await axeViolations(dialog)).toEqual([]);
    expect(calls.filter((call) => call.route === 'role.create')).toHaveLength(1);
  });

  it('creates a role and focuses its row', async () => {
    const user = userEvent.setup();
    const calls = serve();
    await renderApp(`/b/${BASE}/settings/roles`);
    await user.click(await screen.findByRole('button', { name: 'New role' }));
    const dialog = await screen.findByRole('dialog', { name: 'New role' });
    await user.type(within(dialog).getByLabelText('Name'), '  Kho  {Enter}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'New role' })).toBeNull();
    });
    expect(calls.find((call) => call.route === 'role.create')?.body).toEqual({ name: 'Kho' });
    expect(await screen.findByText('Role “Kho” created.')).toBeVisible();
    await waitFor(() => {
      expect(document.activeElement).toHaveAttribute('data-role-id', 'rol_Kho0000000000001');
    });
  });

  it('renames a custom role; a taken name stays inline', async () => {
    const user = userEvent.setup();
    const calls = serve({
      renameProblem: () =>
        problemWith('NAME_CONFLICT', 409, [
          { path: 'name', code: 'NAME_CONFLICT', message: 'Name already used' },
        ]),
    });
    await renderApp(`/b/${BASE}/settings/roles`);
    await user.click(await screen.findByRole('button', { name: 'Rename Kế toán' }));
    const dialog = await screen.findByRole('dialog', { name: 'Rename role' });
    const input = within(dialog).getByLabelText('Name');
    expect(input).toHaveValue('Kế toán');
    await user.clear(input);
    await user.type(input, 'sales{Enter}');
    expect(
      await within(dialog).findByText('A role of this base already has this name.'),
    ).toBeVisible();
    expect(calls.find((call) => call.route === 'role.rename')?.body).toEqual({ name: 'sales' });
    // Editing clears the conflict.
    await user.type(input, 'x');
    expect(within(dialog).queryByText('A role of this base already has this name.')).toBeNull();
  });

  it('lists who still holds a role instead of deleting it', async () => {
    const user = userEvent.setup();
    const calls = serve();
    await renderApp(`/b/${BASE}/settings/roles`);
    await user.click(await screen.findByRole('button', { name: 'Delete Sales' }));
    const dialog = await screen.findByRole('alertdialog', { name: '“Sales” is still assigned' });
    expect(within(dialog).getByTestId('role-in-use-list')).toHaveTextContent('Sales');
    expect(within(dialog).queryByRole('button', { name: 'Delete role' })).toBeNull();
    expect(
      within(dialog).getByRole('link', { name: 'Give roles on the Members page' }),
    ).toHaveAttribute('href', `/b/${BASE}/settings/members`);
    expect(await axeViolations(dialog)).toEqual([]);
    expect(calls.some((call) => call.route === 'role.delete')).toBe(false);
  });

  it('deletes an unassigned role after the confirmation (keyboard)', async () => {
    const user = userEvent.setup();
    const calls = serve();
    await renderApp(`/b/${BASE}/settings/roles`);
    await user.click(await screen.findByRole('button', { name: 'Delete Kế toán' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete the role “Kế toán”?' });
    within(dialog).getByRole('button', { name: 'Delete role' }).focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByText('Role “Kế toán” deleted.')).toBeVisible();
    expect(calls.filter((call) => call.route === 'role.delete')).toHaveLength(1);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Delete Kế toán' })).toBeNull();
    });
  });

  it('turns ROLE_IN_USE (assigned meanwhile) into the list of holders', async () => {
    const user = userEvent.setup();
    serve({
      deleteProblem: () =>
        problemWith('VALIDATION_FAILED', 422, [
          {
            path: 'role_id',
            code: 'ROLE_IN_USE',
            message: 'in use',
            params: { assignments: 1 },
          },
        ]),
    });
    await renderApp(`/b/${BASE}/settings/roles`);
    await user.click(await screen.findByRole('button', { name: 'Delete Kế toán' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete the role “Kế toán”?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete role' }));
    const inUse = await screen.findByRole('alertdialog', { name: '“Kế toán” is still assigned' });
    expect(within(inUse).getByTestId('role-in-use-list')).toHaveTextContent('Lê Quốc Bảo');
  });
});

describe('members page (T712)', () => {
  it('shows people and groups with their role, the rules note and full access rows', async () => {
    serve();
    await renderApp(`/b/${BASE}/settings/members`);
    const table = await screen.findByTestId('member-table');
    await waitFor(() => {
      expect(within(table).getAllByTestId('member-row')).toHaveLength(4);
    });
    expect(screen.getByTestId('members-rules')).toHaveTextContent(
      'A role given to a person directly wins over the roles of their groups.',
    );
    // The caller is the organization owner (ME), and the base owner: full access, no select.
    expect(await screen.findByTestId(`full-access-${ME.user.id}`)).toHaveTextContent(
      'Full access · organization owner',
    );
    expect(screen.getByTestId(`full-access-${OWNER}`)).toHaveTextContent(
      'Full access · base owner',
    );
    const reader = screen.getByRole('combobox', { name: 'Role of Lê Quốc Bảo' });
    expect(reader).toHaveValue(READER_ROLE.id);
    expect(
      within(reader)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['No role', 'Admin', 'Editor', 'Reader', 'Sales', 'Kế toán']);
    expect(screen.getByRole('combobox', { name: 'Role of Sales' })).toHaveValue(SALES_ROLE.id);
    // (T713) "View access" for people, not for groups.
    expect(screen.getByRole('button', { name: 'View the access of Lê Quốc Bảo' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'View the access of Sales' })).toBeNull();
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('assigns a role with the select', async () => {
    const user = userEvent.setup();
    const calls = serve();
    await renderApp(`/b/${BASE}/settings/members`);
    const select = await screen.findByRole('combobox', { name: 'Role of Sales' });
    await user.selectOptions(select, EMPTY_ROLE.id);
    expect(await screen.findByText('Sales now has the role Kế toán.')).toBeVisible();
    expect(calls.find((call) => call.route === 'assign')?.body).toEqual({
      principal_type: 'group',
      principal_id: SALES,
      role_id: EMPTY_ROLE.id,
    });
    expect(select).toHaveValue(EMPTY_ROLE.id);
  });

  it('"No role" removes the role after an alertdialog; Cancel keeps it', async () => {
    const user = userEvent.setup();
    const calls = serve();
    await renderApp(`/b/${BASE}/settings/members`);
    const select = await screen.findByRole('combobox', { name: 'Role of Lê Quốc Bảo' });
    await user.selectOptions(select, '');
    let dialog = await screen.findByRole('alertdialog', {
      name: 'Remove the access of Lê Quốc Bảo?',
    });
    expect(dialog).toHaveTextContent(
      'Lê Quốc Bảo can no longer open Chăm sóc khách hàng, unless one of their groups has a role here.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(select).toHaveValue(READER_ROLE.id);
    // The focus goes back to the select (WCAG 2.4.3).
    await waitFor(() => {
      expect(select).toHaveFocus();
    });
    expect(calls.some((call) => call.route === 'unassign')).toBe(false);

    await user.selectOptions(select, '');
    dialog = await screen.findByRole('alertdialog', { name: 'Remove the access of Lê Quốc Bảo?' });
    expect(await axeViolations(dialog)).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Remove access' }));
    expect(await screen.findByText('Lê Quốc Bảo no longer has a role in this base.')).toBeVisible();
    expect(calls.find((call) => call.route === 'unassign')?.body).toEqual({
      principal_type: 'user',
      principal_id: READER,
    });
    await waitFor(() => {
      expect(select).toHaveValue('');
    });
    expect(select).toHaveFocus();
  });

  it('explains what removing a group means', async () => {
    const user = userEvent.setup();
    serve();
    await renderApp(`/b/${BASE}/settings/members`);
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Role of Sales' }), '');
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove the access of Sales?' });
    expect(dialog).toHaveTextContent('Members of Sales lose the access this group gives');
  });

  it('keeps the focused role select while a search loads (WCAG 2.4.3)', async () => {
    const user = userEvent.setup();
    let release: () => void = () => undefined;
    const calls = serve({
      searchGate: new Promise<void>((resolve) => {
        release = resolve;
      }),
    });
    await renderApp(`/b/${BASE}/settings/members`);
    const select = await screen.findByRole('combobox', { name: 'Role of Sales' });
    await user.type(screen.getByLabelText('Search people and groups'), 'Sales');
    // The keyboard reaches the select before the search answers (a slow network).
    select.focus();
    await waitFor(() => {
      expect(
        calls.some((call) => call.route === 'principals' && call.query.includes('q=Sales')),
      ).toBe(true);
    });
    // The previous rows stay (marked busy) instead of a skeleton that drops the focus.
    expect(select).toBeInTheDocument();
    expect(select).toHaveFocus();
    expect(screen.getByTestId('member-table')).toHaveAttribute('aria-busy', 'true');
    release();
    await waitFor(() => {
      expect(screen.getAllByTestId('member-row')).toHaveLength(1);
    });
    expect(screen.getByTestId('member-table')).not.toHaveAttribute('aria-busy');
    expect(select).toHaveFocus();
    await user.selectOptions(select, EMPTY_ROLE.id);
    expect(await screen.findByText('Sales now has the role Kế toán.')).toBeVisible();
    expect(select).toHaveFocus();
  });

  it('searches by name or email on the server', async () => {
    const user = userEvent.setup();
    const calls = serve();
    await renderApp(`/b/${BASE}/settings/members`);
    await screen.findByTestId('member-table');
    await user.type(screen.getByLabelText('Search people and groups'), 'reader@');
    await waitFor(() => {
      expect(screen.getAllByTestId('member-row')).toHaveLength(1);
    });
    expect(
      calls.some((call) => call.route === 'principals' && call.query.includes('q=reader%40')),
    ).toBe(true);
    await user.clear(screen.getByLabelText('Search people and groups'));
    await user.type(screen.getByLabelText('Search people and groups'), 'nobody');
    expect(await screen.findByTestId('members-empty')).toHaveTextContent(
      'No person or group matches “nobody”.',
    );
  });
});
