import { newId } from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import {
  effectiveAccessSchema,
  resolveBaseAccess,
  roleConfigSchema,
  systemRoleConfig,
  type BaseRoleDef,
  type Principal,
  type ResolvedBaseAccess,
  type RoleAssignment,
  type SchemaMeta,
} from '../src/index.js';

import { buildFixture, type Fixture } from './fixture.js';

const fx = buildFixture();

function resolve(principal: Principal, extra: Parameters<Fixture['input']>[1] = {}) {
  const result = resolveBaseAccess(fx.input(principal, extra));
  if (result !== null) {
    // Every result must match the CONTRACTS §5A shape and never leak filters.
    expect(() => effectiveAccessSchema.parse(result.access)).not.toThrow();
    const json = JSON.stringify(result.access);
    expect(json).not.toContain('edit_filter');
    expect(json).not.toContain('read_filter');
  }
  return result;
}

function mustResolve(principal: Principal, extra: Parameters<Fixture['input']>[1] = {}) {
  const result = resolve(principal, extra);
  expect(result).not.toBeNull();
  return result as ResolvedBaseAccess;
}

describe('resolveBaseAccess — resolution order (SPEC §14.1)', () => {
  const cases: {
    name: string;
    principal: Principal;
    expected: 'none' | 'full' | 'role';
    roleKind?: string | null;
  }[] = [
    {
      name: 'P01 u_out (org member, no role) → no access',
      principal: fx.principal(fx.usr.u_out),
      expected: 'none',
    },
    {
      name: 'workspace member without base role → no access',
      principal: fx.principal(fx.usr.u_out, { workspaceRole: 'member' }),
      expected: 'none',
    },
    {
      name: 'not an org member, even with a direct role → no access',
      principal: fx.principal(fx.usr.u_editor, { orgRole: null }),
      expected: 'none',
    },
    {
      name: 'org owner → full',
      principal: fx.principal(fx.usr.u_out, { orgRole: 'owner' }),
      expected: 'full',
      roleKind: null,
    },
    {
      name: 'org admin → full',
      principal: fx.principal(fx.usr.u_out, { orgRole: 'admin' }),
      expected: 'full',
      roleKind: null,
    },
    {
      name: 'base owner → full',
      principal: fx.principal(fx.usr.u_out, { isBaseOwner: true }),
      expected: 'full',
      roleKind: null,
    },
    {
      name: 'workspace admin of the base workspace → full',
      principal: fx.principal(fx.usr.u_out, { workspaceRole: 'admin' }),
      expected: 'full',
      roleKind: null,
    },
    {
      name: 'workspace admin elevation beats a lower direct role',
      principal: fx.principal(fx.usr.u_reader, { workspaceRole: 'admin' }),
      expected: 'full',
      roleKind: null,
    },
    {
      name: 'role admin (P06) → full',
      principal: fx.principal(fx.usr.u_admin),
      expected: 'full',
      roleKind: 'system_admin',
    },
    {
      name: 'direct role applies without workspace membership',
      principal: fx.principal(fx.usr.u_editor, { workspaceRole: null }),
      expected: 'role',
      roleKind: 'system_editor',
    },
    {
      name: 'group role applies',
      principal: fx.principal(fx.usr.u_sales2),
      expected: 'role',
      roleKind: 'custom',
    },
  ];

  it.each(cases)('$name', ({ principal, expected, roleKind }) => {
    const result = resolve(principal);
    if (expected === 'none') {
      expect(result).toBeNull();
      return;
    }
    expect(result).not.toBeNull();
    const access = (result as ResolvedBaseAccess).access;
    expect(access.is_admin).toBe(expected === 'full');
    expect(access.role?.kind ?? null).toBe(roleKind);
  });

  it('full access grants manage on every table with computed fields capped at read', () => {
    const { access, internal } = mustResolve(
      fx.principal(fx.usr.u_out, { workspaceRole: 'admin' }),
    );
    expect(access.base_rule).toEqual({ copy: true, download: true, share_link: true });
    const orders = access.tables[fx.tbl.orders];
    expect(orders?.perm).toBe('manage');
    expect(orders?.operations).toEqual(['add', 'delete']);
    expect(orders?.view_rule).toEqual({ allow_edit: true, visible_views: null });
    expect(orders?.fields[fx.fld.amount]).toBe('edit');
    expect(orders?.fields[fx.fld.total_formula]).toBe('read');
    expect(orders?.option_edit_fields).toEqual([fx.fld.status]);
    expect(access.tables[fx.tbl.customers]?.perm).toBe('manage');
    expect(internal.editFilters[fx.tbl.orders]).toBeNull();
    expect(internal.readFilters[fx.tbl.orders]).toBeNull();
  });
});

describe('resolveBaseAccess — CONTRACTS §5 matrix (pure level)', () => {
  it('P02 u_reader sees every Orders record and every field', () => {
    const { access, internal } = mustResolve(fx.principal(fx.usr.u_reader));
    const orders = access.tables[fx.tbl.orders];
    expect(orders?.perm).toBe('read_only');
    expect(orders?.read_scope).toBe('all');
    expect(internal.readFilters[fx.tbl.orders]).toBeNull();
    expect(Object.keys(orders?.fields ?? {}).sort()).toEqual(
      [
        fx.fld.title,
        fx.fld.amount,
        fx.fld.cost,
        fx.fld.status,
        fx.fld.owner,
        fx.fld.total_formula,
        fx.fld.customer,
      ].sort(),
    );
  });

  it('P03 u_reader cannot edit, add or delete', () => {
    const { access, internal } = mustResolve(fx.principal(fx.usr.u_reader));
    const orders = access.tables[fx.tbl.orders];
    expect(orders?.operations).toEqual([]);
    expect(Object.values(orders?.fields ?? {}).every((perm) => perm === 'read')).toBe(true);
    expect(fx.tbl.orders in internal.editFilters).toBe(false);
    expect(access.role).toEqual({ id: fx.roles.reader.id, kind: 'system_reader', name: 'Reader' });
  });

  it('P04 u_editor can edit r1.amount', () => {
    const { access, internal } = mustResolve(fx.principal(fx.usr.u_editor));
    const orders = access.tables[fx.tbl.orders];
    expect(orders?.perm).toBe('edit');
    expect(orders?.fields[fx.fld.amount]).toBe('edit');
    expect(internal.editFilters[fx.tbl.orders]).toBeNull();
  });

  it('P05 u_editor cannot change schema (perm is edit, not manage)', () => {
    const { access } = mustResolve(fx.principal(fx.usr.u_editor));
    expect(access.is_admin).toBe(false);
    for (const table of Object.values(access.tables)) expect(table.perm).not.toBe('manage');
  });

  it('P06 u_admin can create fields and edit roles', () => {
    const { access } = mustResolve(fx.principal(fx.usr.u_admin));
    expect(access.is_admin).toBe(true);
    expect(access.tables[fx.tbl.orders]?.perm).toBe('manage');
  });

  it('P07/P10/P19 u_sales1: owner-scoped Orders, no cost, status read, no Customers', () => {
    const { access, internal } = mustResolve(fx.principal(fx.usr.u_sales1));
    const orders = access.tables[fx.tbl.orders];
    expect(orders).toEqual({
      perm: 'edit',
      operations: ['add'],
      view_rule: { allow_edit: false, visible_views: [fx.viw.sales] },
      read_scope: 'editable',
      fields: {
        [fx.fld.title]: 'edit',
        [fx.fld.amount]: 'edit',
        [fx.fld.status]: 'read',
        [fx.fld.owner]: 'edit',
        [fx.fld.total_formula]: 'read',
        [fx.fld.customer]: 'edit',
      },
      option_edit_fields: [],
      file_download_fields: [],
    });
    expect(internal.editFilters[fx.tbl.orders]).toEqual(fx.ownerIsCurrentUser);
    expect(internal.readFilters[fx.tbl.orders]).toEqual(fx.ownerIsCurrentUser);
    expect(access.tables[fx.tbl.customers]).toBeUndefined();
    expect(fx.tbl.customers in internal.readFilters).toBe(false);
    expect(access.base_rule).toEqual({ copy: false, download: false, share_link: false });
  });

  it('P25 a direct reader role wins over the Sales group role', () => {
    const assignments: RoleAssignment[] = [
      ...fx.assignments,
      { roleId: fx.roles.reader.id, principalType: 'user', principalId: fx.usr.u_sales1 },
    ];
    const { access, internal } = mustResolve(fx.principal(fx.usr.u_sales1), { assignments });
    expect(access.role?.kind).toBe('system_reader');
    const orders = access.tables[fx.tbl.orders];
    expect(orders?.perm).toBe('read_only');
    expect(orders?.operations).toEqual([]);
    expect(orders?.fields[fx.fld.cost]).toBe('read');
    expect(internal.readFilters[fx.tbl.orders]).toBeNull();
    expect(fx.tbl.orders in internal.editFilters).toBe(false);
  });

  it('P27 a stored formula override of edit is capped at read', () => {
    const config = roleConfigSchema.parse({
      tables: {
        [fx.tbl.orders]: {
          perm: 'edit',
          field_rule: { mode: 'specify', fields: { [fx.fld.total_formula]: 'edit' } },
        },
      },
    });
    const role: BaseRoleDef = { id: newId('rol'), kind: 'custom', name: 'Formula', config };
    const { access } = mustResolve(fx.principal(fx.usr.u_out), {
      roles: [role],
      assignments: [{ roleId: role.id, principalType: 'user', principalId: fx.usr.u_out }],
    });
    expect(access.tables[fx.tbl.orders]?.fields[fx.fld.total_formula]).toBe('read');
  });
});

describe('resolveBaseAccess — union of group roles', () => {
  const g_support = newId('grp');
  const dashboard = newId('dsh');
  const statusDone = {
    op: 'and' as const,
    items: [{ field: fx.fld.status, operator: 'is', value: 'opt_done' }],
  };
  const support: BaseRoleDef = {
    id: newId('rol'),
    kind: 'custom',
    name: 'Support',
    config: roleConfigSchema.parse({
      base_rule: { download: true },
      tables: {
        [fx.tbl.orders]: {
          perm: 'read_only',
          view_rule: { allow_edit: true, visible_views: [fx.viw.all] },
          record_rule: { read_scope: 'filter', read_filter: statusDone },
          field_rule: {
            mode: 'specify',
            fields: { [fx.fld.cost]: 'read', [fx.fld.owner]: 'no_perm' },
          },
        },
        [fx.tbl.customers]: { perm: 'edit', record_rule: { operations: ['delete'] } },
      },
      dashboards: { [dashboard]: 'read_only' },
    }),
  };
  const roles = [...Object.values(fx.roles), support];
  const assignments: RoleAssignment[] = [
    ...fx.assignments,
    { roleId: support.id, principalType: 'group', principalId: g_support },
  ];
  const schema = { ...fx.schema, dashboards: [dashboard] };
  const member = fx.principal(fx.usr.u_sales1, { groupIds: [fx.grp.g_sales, g_support] });

  it('takes the highest perms and OR-combines record filters', () => {
    const { access, internal } = mustResolve(member, { roles, assignments, schema });
    expect(access.role).toBeNull();
    expect(access.is_admin).toBe(false);
    expect(access.base_rule).toEqual({ copy: false, download: true, share_link: false });
    expect(access.dashboards).toEqual({ [dashboard]: 'read_only' });

    const orders = access.tables[fx.tbl.orders];
    expect(orders?.perm).toBe('edit');
    expect(orders?.operations).toEqual(['add']);
    expect(orders?.view_rule).toEqual({
      allow_edit: true,
      visible_views: [fx.viw.sales, fx.viw.all],
    });
    expect(orders?.read_scope).toBe('filter');
    expect(orders?.fields[fx.fld.cost]).toBe('read');
    expect(orders?.fields[fx.fld.owner]).toBe('edit');
    expect(orders?.fields[fx.fld.status]).toBe('read');
    // Only Sales can edit, so the edit scope is Sales' filter alone.
    expect(internal.editFilters[fx.tbl.orders]).toEqual(fx.ownerIsCurrentUser);
    expect(internal.readFilters[fx.tbl.orders]).toEqual({
      op: 'or',
      items: [fx.ownerIsCurrentUser, statusDone],
    });

    const customers = access.tables[fx.tbl.customers];
    expect(customers?.perm).toBe('edit');
    expect(customers?.operations).toEqual(['delete']);
    expect(internal.editFilters[fx.tbl.customers]).toBeNull();
  });

  it('an unrestricted role makes the union unrestricted', () => {
    const openSupport: BaseRoleDef = {
      ...support,
      config: roleConfigSchema.parse({
        tables: { [fx.tbl.orders]: { perm: 'edit', view_rule: { visible_views: null } } },
      }),
    };
    const { access, internal } = mustResolve(member, {
      roles: [...Object.values(fx.roles), openSupport],
      assignments,
    });
    const orders = access.tables[fx.tbl.orders];
    expect(orders?.read_scope).toBe('all');
    expect(orders?.view_rule.visible_views).toBeNull();
    expect(internal.readFilters[fx.tbl.orders]).toBeNull();
    expect(internal.editFilters[fx.tbl.orders]).toBeNull();
  });

  it('keeps a shared read scope when every role uses it', () => {
    const twin: BaseRoleDef = { ...fx.roles.sales, id: newId('rol'), name: 'Sales 2' };
    const { access, internal } = mustResolve(member, {
      roles: [...Object.values(fx.roles), twin],
      assignments: [
        ...fx.assignments,
        { roleId: twin.id, principalType: 'group', principalId: g_support },
      ],
    });
    expect(access.tables[fx.tbl.orders]?.read_scope).toBe('editable');
    // Identical filters are deduplicated rather than OR-ed with themselves.
    expect(internal.readFilters[fx.tbl.orders]).toEqual(fx.ownerIsCurrentUser);
  });

  it('a group admin role gives full access', () => {
    const { access } = mustResolve(member, {
      assignments: [
        ...fx.assignments,
        { roleId: fx.roles.admin.id, principalType: 'group', principalId: g_support },
      ],
    });
    expect(access.is_admin).toBe(true);
    expect(access.role?.id).toBe(fx.roles.admin.id);
  });

  it('ignores assignments to unknown roles', () => {
    const result = resolve(fx.principal(fx.usr.u_out), {
      assignments: [{ roleId: newId('rol'), principalType: 'user', principalId: fx.usr.u_out }],
    });
    expect(result).toBeNull();
  });
});

describe('resolveBaseAccess — system roles and ceilings', () => {
  const newTable = { id: newId('tbl'), fields: [{ id: newId('fld'), type: 'text' }] };
  const grown = { ...fx.schema, tables: [...fx.schema.tables, newTable] };

  it.each([
    { user: fx.usr.u_editor, perm: 'edit' },
    { user: fx.usr.u_reader, perm: 'read_only' },
  ])('system role covers a table created after the role was stored ($perm)', ({ user, perm }) => {
    const { access } = mustResolve(fx.principal(user), { schema: grown });
    expect(access.tables[newTable.id]?.perm).toBe(perm);
  });

  it('a custom role denies a table missing from its config', () => {
    const { access } = mustResolve(fx.principal(fx.usr.u_sales1), { schema: grown });
    expect(access.tables[newTable.id]).toBeUndefined();
  });

  it('the reader ceiling applies even to an edited reader config', () => {
    const edited: BaseRoleDef = {
      ...fx.roles.reader,
      config: roleConfigSchema.parse({
        base_rule: { copy: true },
        tables: {
          [fx.tbl.orders]: {
            perm: 'manage',
            record_rule: { operations: ['add', 'delete'] },
            field_rule: { mode: 'all_edit' },
          },
        },
      }),
    };
    const { access, internal } = mustResolve(fx.principal(fx.usr.u_reader), {
      roles: [fx.roles.admin, fx.roles.editor, edited, fx.roles.sales],
    });
    const orders = access.tables[fx.tbl.orders];
    expect(orders?.perm).toBe('read_only');
    expect(orders?.operations).toEqual([]);
    expect(orders?.fields[fx.fld.amount]).toBe('read');
    expect(fx.tbl.orders in internal.editFilters).toBe(false);
  });

  it('the editor ceiling removes manage', () => {
    const edited: BaseRoleDef = {
      ...fx.roles.editor,
      config: roleConfigSchema.parse({ tables: { [fx.tbl.orders]: { perm: 'manage' } } }),
    };
    const { access } = mustResolve(fx.principal(fx.usr.u_editor), {
      roles: [fx.roles.admin, edited, fx.roles.reader, fx.roles.sales],
    });
    expect(access.tables[fx.tbl.orders]?.perm).toBe('edit');
  });
});

describe('resolveBaseAccess — field, file and dashboard details', () => {
  const tableId = newId('tbl');
  const f = {
    text: newId('fld'),
    select: newId('fld'),
    select2: newId('fld'),
    file: newId('fld'),
    file2: newId('fld'),
    auto: newId('fld'),
    hidden: newId('fld'),
  };
  const dashA = newId('dsh');
  const dashB = newId('dsh');
  const schema = {
    tables: [
      {
        id: tableId,
        fields: [
          { id: f.text, type: 'text' },
          { id: f.select, type: 'select' },
          { id: f.select2, type: 'select' },
          { id: f.file, type: 'attachment' },
          { id: f.file2, type: 'attachment' },
          { id: f.auto, type: 'text', computed: true },
          { id: f.hidden, type: 'text' },
        ],
      },
    ],
    dashboards: [dashA, dashB],
  };
  const user = newId('usr');
  const run = (
    config: unknown,
    kind: BaseRoleDef['kind'] = 'custom',
    withSchema: SchemaMeta = schema,
  ) => {
    const role: BaseRoleDef = {
      id: newId('rol'),
      kind,
      name: 'R',
      config: roleConfigSchema.parse(config),
    };
    return mustResolve(fx.principal(user), {
      roles: [role],
      assignments: [{ roleId: role.id, principalType: 'user', principalId: user }],
      schema: withSchema,
    }).access;
  };

  it('specify mode: listed download/option fields only, create without add becomes read', () => {
    const access = run({
      tables: {
        [tableId]: {
          perm: 'edit',
          field_rule: {
            mode: 'specify',
            fields: { [f.select2]: 'create', [f.hidden]: 'no_perm', [f.auto]: 'edit' },
            option_edit_fields: [f.select, f.select2, f.text],
            file_download_fields: [f.file],
          },
        },
      },
      dashboards: { [dashA]: 'read_only', [dashB]: 'no_perm' },
    });
    const table = access.tables[tableId];
    expect(table?.fields).toEqual({
      [f.text]: 'edit',
      [f.select]: 'edit',
      [f.select2]: 'read',
      [f.file]: 'edit',
      [f.file2]: 'edit',
      [f.auto]: 'read',
    });
    expect(table?.option_edit_fields).toEqual([f.select]);
    expect(table?.file_download_fields).toEqual([f.file]);
    expect(access.dashboards).toEqual({ [dashA]: 'read_only' });
  });

  it('create is kept when the role can add records', () => {
    const access = run({
      tables: {
        [tableId]: {
          perm: 'edit',
          record_rule: { operations: ['add'] },
          field_rule: { mode: 'no_perm', fields: { [f.text]: 'create' } },
        },
      },
    });
    expect(access.tables[tableId]?.fields).toEqual({ [f.text]: 'create' });
  });

  it('non-specify mode downloads every visible attachment field', () => {
    const access = run({
      tables: { [tableId]: { perm: 'read_only', field_rule: { mode: 'all_read' } } },
    });
    expect(access.tables[tableId]?.file_download_fields).toEqual([f.file, f.file2]);
  });

  it('a no_perm table in the config stays hidden', () => {
    const access = run({ tables: { [tableId]: { perm: 'no_perm' } } });
    expect(access.tables).toEqual({});
  });

  it('system reader sees every dashboard of the schema by default', () => {
    const access = run(systemRoleConfig('reader', { tables: [], dashboards: [] }), 'system_reader');
    expect(access.dashboards).toEqual({ [dashA]: 'read_only', [dashB]: 'read_only' });
  });

  it('without a dashboard list, the config dashboards are used as they are', () => {
    const access = run({ dashboards: { [dashA]: 'read_only', [dashB]: 'no_perm' } }, 'custom', {
      tables: schema.tables,
    });
    expect(access.dashboards).toEqual({ [dashA]: 'read_only' });
  });

  it('full access without a dashboard list has no dashboards', () => {
    const { access } = mustResolve(fx.principal(user, { orgRole: 'owner' }), {
      schema: { tables: schema.tables },
    });
    expect(access.dashboards).toEqual({});
    expect(access.tables[tableId]?.file_download_fields).toEqual([f.file, f.file2]);
    expect(access.tables[tableId]?.option_edit_fields).toEqual([f.select, f.select2]);
  });
});
