import { newId, type Id } from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import {
  explainBaseAccess,
  resolveBaseAccess,
  roleConfigSchema,
  type AccessSource,
  type BaseRoleDef,
  type Principal,
  type ResolveBaseAccessInput,
  type RoleAssignment,
} from '../src/index.js';

import { buildFixture } from './fixture.js';

const fx = buildFixture();

/** A second group with the system `editor` role, and a group without any role in the base. */
const g_editors = newId('grp');
const g_idle = newId('grp');
/** A custom role that is assigned but whose config could not be read (left out of `roles`). */
const brokenRoleId = newId('rol');
const support: BaseRoleDef = {
  id: newId('rol'),
  kind: 'custom',
  name: 'Support',
  config: roleConfigSchema.parse({
    base_rule: { copy: true, download: false, share_link: false },
    tables: {
      [fx.tbl.customers]: {
        perm: 'read_only',
        view_rule: { allow_edit: false, visible_views: null },
        record_rule: { operations: [], edit_filter: null, read_scope: 'all', read_filter: null },
        field_rule: {
          mode: 'all_read',
          fields: {},
          option_edit_fields: [],
          file_download_fields: [],
        },
      },
    },
    dashboards: {},
  }),
};

const roles: BaseRoleDef[] = [...Object.values(fx.roles), support];
const extraAssignments: RoleAssignment[] = [
  { roleId: fx.roles.editor.id, principalType: 'group', principalId: g_editors },
  { roleId: support.id, principalType: 'group', principalId: g_editors },
];

function input(principal: Principal, assignments: RoleAssignment[] = []): ResolveBaseAccessInput {
  return {
    principal,
    roles,
    assignments: [...fx.assignments, ...extraAssignments, ...assignments],
    schema: fx.schema,
  };
}

const p = fx.principal;
const { u_admin, u_editor, u_reader, u_sales1, u_sales2, u_out } = fx.usr;
const { g_sales } = fx.grp;

interface Case {
  name: string;
  input: ResolveBaseAccessInput;
  expected: AccessSource;
}

const source = (
  kind: AccessSource['kind'],
  roleIds: Id<'rol'>[] = [],
  groupIds: Id<'grp'>[] = [],
): AccessSource => ({ kind, roleIds, groupIds });

const cases: Case[] = [
  {
    name: 'P01 u_out: org member without a role → none',
    input: input(p(u_out)),
    expected: source('none'),
  },
  {
    name: 'workspace member without a base role → none',
    input: input(p(u_out, { workspaceRole: 'member' })),
    expected: source('none'),
  },
  {
    name: 'not an org member, even with a direct role → none',
    input: input(p(u_editor, { orgRole: null })),
    expected: source('none'),
  },
  {
    name: 'not an org member, even as base owner → none',
    input: input(p(u_out, { orgRole: null, isBaseOwner: true })),
    expected: source('none'),
  },
  {
    name: 'org owner → org_admin',
    input: input(p(u_out, { orgRole: 'owner' })),
    expected: source('org_admin'),
  },
  {
    name: 'org admin with a direct reader role → org_admin (step 1 first)',
    input: input(p(u_reader, { orgRole: 'admin' })),
    expected: source('org_admin'),
  },
  {
    name: 'org admin who also owns the base → org_admin (org before base owner)',
    input: input(p(u_out, { orgRole: 'admin', isBaseOwner: true })),
    expected: source('org_admin'),
  },
  {
    name: 'base owner → base_owner',
    input: input(p(u_out, { isBaseOwner: true })),
    expected: source('base_owner'),
  },
  {
    name: 'base owner and workspace admin → base_owner (owner before workspace admin)',
    input: input(p(u_sales1, { isBaseOwner: true, workspaceRole: 'admin' })),
    expected: source('base_owner'),
  },
  {
    name: 'workspace admin → workspace_admin',
    input: input(p(u_out, { workspaceRole: 'admin' })),
    expected: source('workspace_admin'),
  },
  {
    name: 'workspace admin with a lower direct role → workspace_admin',
    input: input(p(u_reader, { workspaceRole: 'admin' })),
    expected: source('workspace_admin'),
  },
  {
    name: 'P06 u_admin: direct role admin → direct_role',
    input: input(p(u_admin)),
    expected: source('direct_role', [fx.roles.admin.id]),
  },
  {
    name: 'u_editor: direct role, no workspace membership → direct_role',
    input: input(p(u_editor, { workspaceRole: null })),
    expected: source('direct_role', [fx.roles.editor.id]),
  },
  {
    name: 'u_sales1: group g_sales → group_roles Sales',
    input: input(p(u_sales1)),
    expected: source('group_roles', [fx.roles.sales.id], [g_sales]),
  },
  {
    name: 'u_sales2: group g_sales → group_roles Sales',
    input: input(p(u_sales2)),
    expected: source('group_roles', [fx.roles.sales.id], [g_sales]),
  },
  {
    name: 'P25 u_sales1 with a direct reader role → direct_role (wins over the group)',
    input: input(p(u_sales1), [
      { roleId: fx.roles.reader.id, principalType: 'user', principalId: u_sales1 },
    ]),
    expected: source('direct_role', [fx.roles.reader.id]),
  },
  {
    name: 'direct reader wins over a group admin role',
    input: input(p(u_sales1), [
      { roleId: fx.roles.reader.id, principalType: 'user', principalId: u_sales1 },
      { roleId: fx.roles.admin.id, principalType: 'group', principalId: g_sales },
    ]),
    expected: source('direct_role', [fx.roles.reader.id]),
  },
  {
    name: 'group admin role → group_roles (full access through the group)',
    input: input(p(u_out, { groupIds: [g_sales] }), [
      { roleId: fx.roles.admin.id, principalType: 'group', principalId: g_sales },
    ]),
    expected: source('group_roles', [fx.roles.admin.id, fx.roles.sales.id], [g_sales]),
  },
  {
    name: 'two groups → union of their roles, in role order, with both groups',
    input: input(p(u_sales1, { groupIds: [g_sales, g_editors] })),
    expected: source(
      'group_roles',
      [fx.roles.editor.id, fx.roles.sales.id, support.id],
      [g_sales, g_editors],
    ),
  },
  {
    name: 'a group without a role in the base is not a source',
    input: input(p(u_sales1, { groupIds: [g_idle, g_sales] })),
    expected: source('group_roles', [fx.roles.sales.id], [g_sales]),
  },
  {
    name: 'only groups without a role → none',
    input: input(p(u_out, { groupIds: [g_idle] })),
    expected: source('none'),
  },
  {
    name: 'a direct role whose config cannot be read → none (no fallback to groups)',
    input: input(p(u_sales1), [
      { roleId: brokenRoleId, principalType: 'user', principalId: u_sales1 },
    ]),
    expected: source('none'),
  },
  {
    name: 'a group role whose config cannot be read is not a source',
    input: input(p(u_sales1), [
      { roleId: brokenRoleId, principalType: 'group', principalId: g_sales },
    ]),
    expected: source('group_roles', [fx.roles.sales.id], [g_sales]),
  },
  {
    name: 'an assignment of another user does not count',
    input: input(p(u_out), [
      { roleId: fx.roles.editor.id, principalType: 'user', principalId: u_sales2 },
    ]),
    expected: source('none'),
  },
];

/**
 * What `resolveBaseAccess` gives from the source alone: no role for the
 * implied kinds, only the source roles (and the assignments that give them)
 * otherwise. It must equal the full resolution — the source explains it.
 */
function resolveFromSource(base: ResolveBaseAccessInput, explained: AccessSource) {
  if (explained.kind === 'none') return null;
  const roleIds = new Set<string>(explained.roleIds);
  const groupIds = new Set<string>(explained.groupIds);
  return resolveBaseAccess({
    ...base,
    roles: base.roles.filter((role) => roleIds.has(role.id)),
    assignments: base.assignments.filter(
      (assignment) =>
        roleIds.has(assignment.roleId) &&
        (explained.kind === 'direct_role'
          ? assignment.principalType === 'user'
          : assignment.principalType === 'group' && groupIds.has(assignment.principalId)),
    ),
  });
}

describe('explainBaseAccess — source of the effective access (SPEC §14.1 order)', () => {
  it('has at least 15 table-driven cases', () => {
    expect(cases.length).toBeGreaterThanOrEqual(15);
  });

  it.each(cases)('$name', ({ input: caseInput, expected }) => {
    const explained = explainBaseAccess(caseInput);
    expect(explained).toEqual(expected);

    const resolved = resolveBaseAccess(caseInput);
    // `none` exactly when `resolve` grants nothing.
    expect(resolved === null).toBe(explained.kind === 'none');
    if (resolved === null) return;
    const implied = ['org_admin', 'base_owner', 'workspace_admin'].includes(explained.kind);
    if (implied) {
      expect(resolved.access.is_admin).toBe(true);
      expect(resolved.access.role).toBeNull();
    }
    if (resolved.access.role !== null) expect(explained.roleIds).toContain(resolved.access.role.id);
    // Resolving from the source alone gives the same result.
    expect(resolveFromSource(caseInput, explained)).toEqual(resolved);
  });

  it('agrees with resolve on every role-assignment combination of the fixture users', () => {
    const users = [u_admin, u_editor, u_reader, u_sales1, u_sales2, u_out];
    const flags: Partial<Principal>[] = [
      {},
      { orgRole: null },
      { orgRole: 'admin' },
      { isBaseOwner: true },
      { workspaceRole: 'admin' },
      { workspaceRole: null },
      { groupIds: [g_editors] },
      { groupIds: [g_sales, g_editors, g_idle] },
    ];
    for (const userId of users) {
      for (const overrides of flags) {
        const caseInput = input(p(userId, overrides));
        const explained = explainBaseAccess(caseInput);
        const resolved = resolveBaseAccess(caseInput);
        expect(resolved === null).toBe(explained.kind === 'none');
        expect(resolveFromSource(caseInput, explained)).toEqual(resolved);
      }
    }
  });
});
