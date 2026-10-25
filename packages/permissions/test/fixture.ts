import { newId, type Id } from '@cellhive/contracts';

import {
  roleConfigSchema,
  systemRoleConfig,
  type BaseRoleDef,
  type FilterNode,
  type Principal,
  type ResolveBaseAccessInput,
  type RoleAssignment,
  type RoleConfigInput,
  type SchemaMeta,
} from '../src/index.js';

/**
 * CONTRACTS §5 fixture with generated IDs: base B with Orders/Customers,
 * users u_admin, u_editor, u_reader, u_sales1, u_sales2, u_out, group
 * g_sales = {u_sales1, u_sales2} and the custom role `Sales`.
 */
export function buildFixture() {
  const tbl = { orders: newId('tbl'), customers: newId('tbl') };
  const fld = {
    title: newId('fld'),
    amount: newId('fld'),
    cost: newId('fld'),
    status: newId('fld'),
    owner: newId('fld'),
    total_formula: newId('fld'),
    customer: newId('fld'),
    name: newId('fld'),
    phone: newId('fld'),
  };
  const viw = { sales: newId('viw'), all: newId('viw') };
  const usr = {
    u_admin: newId('usr'),
    u_editor: newId('usr'),
    u_reader: newId('usr'),
    u_sales1: newId('usr'),
    u_sales2: newId('usr'),
    u_out: newId('usr'),
  };
  const grp = { g_sales: newId('grp') };

  const schema: SchemaMeta = {
    tables: [
      {
        id: tbl.orders,
        fields: [
          { id: fld.title, type: 'text' },
          { id: fld.amount, type: 'number' },
          { id: fld.cost, type: 'number' },
          { id: fld.status, type: 'select' },
          { id: fld.owner, type: 'user' },
          { id: fld.total_formula, type: 'formula' },
          { id: fld.customer, type: 'link' },
        ],
      },
      {
        id: tbl.customers,
        fields: [
          { id: fld.name, type: 'text' },
          { id: fld.phone, type: 'text' },
        ],
      },
    ],
    dashboards: [],
  };

  const ownerIsCurrentUser: FilterNode = {
    op: 'and',
    items: [{ field: fld.owner, operator: 'has_any_of', value: [{ $var: 'current_user' }] }],
  };

  const salesConfigInput: RoleConfigInput = {
    base_rule: { copy: false, download: false, share_link: false },
    tables: {
      [tbl.orders]: {
        perm: 'edit',
        view_rule: { allow_edit: false, visible_views: [viw.sales] },
        record_rule: {
          operations: ['add'],
          edit_filter: ownerIsCurrentUser,
          read_scope: 'editable',
          read_filter: null,
        },
        field_rule: {
          mode: 'specify',
          fields: { [fld.cost]: 'no_perm', [fld.status]: 'read' },
          option_edit_fields: [],
          file_download_fields: [],
        },
      },
    },
    dashboards: {},
  };

  const roles = {
    admin: {
      id: newId('rol'),
      kind: 'system_admin',
      name: 'Admin',
      config: systemRoleConfig('admin', schema),
    },
    editor: {
      id: newId('rol'),
      kind: 'system_editor',
      name: 'Editor',
      config: systemRoleConfig('editor', schema),
    },
    reader: {
      id: newId('rol'),
      kind: 'system_reader',
      name: 'Reader',
      config: systemRoleConfig('reader', schema),
    },
    sales: {
      id: newId('rol'),
      kind: 'custom',
      name: 'Sales',
      config: roleConfigSchema.parse(salesConfigInput),
    },
  } satisfies Record<string, BaseRoleDef>;

  const assignments: RoleAssignment[] = [
    { roleId: roles.admin.id, principalType: 'user', principalId: usr.u_admin },
    { roleId: roles.editor.id, principalType: 'user', principalId: usr.u_editor },
    { roleId: roles.reader.id, principalType: 'user', principalId: usr.u_reader },
    { roleId: roles.sales.id, principalType: 'group', principalId: grp.g_sales },
  ];

  const groupsOf = (userId: Id<'usr'>): Id<'grp'>[] =>
    userId === usr.u_sales1 || userId === usr.u_sales2 ? [grp.g_sales] : [];

  /** A plain org + workspace member; override membership facts per test. */
  const principal = (userId: Id<'usr'>, overrides: Partial<Principal> = {}): Principal => ({
    userId,
    groupIds: groupsOf(userId),
    orgRole: 'member',
    workspaceRole: 'member',
    isBaseOwner: false,
    ...overrides,
  });

  const input = (
    who: Principal,
    extra: Partial<Omit<ResolveBaseAccessInput, 'principal'>> = {},
  ): ResolveBaseAccessInput => ({
    principal: who,
    roles: Object.values(roles),
    assignments,
    schema,
    ...extra,
  });

  return {
    tbl,
    fld,
    viw,
    usr,
    grp,
    schema,
    roles,
    assignments,
    salesConfigInput,
    ownerIsCurrentUser,
    principal,
    input,
  };
}

export type Fixture = ReturnType<typeof buildFixture>;
