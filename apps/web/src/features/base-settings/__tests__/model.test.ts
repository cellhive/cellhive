import { describe, expect, it } from 'vitest';

import {
  assignmentCounts,
  fullAccessOf,
  NO_ROLE,
  roleChangeOf,
  sortRoles,
  type FullAccessReason,
  type RoleChange,
} from '../model';

import type { BasePrincipalDto, OrgMemberDto } from '@cellhive/contracts';

const USER = 'usr_0000000000000001';
const OWNER = 'usr_0000000000000002';
const GROUP = 'grp_0000000000000001';

function member(id: string, role: OrgMemberDto['role']) {
  return {
    user: { id, email: `${id}@example.test`, display_name: id, avatar_url: null },
    role,
  } as Pick<OrgMemberDto, 'user' | 'role'>;
}

describe('sortRoles (T712)', () => {
  it('orders by position, then name, then ID', () => {
    const roles = [
      { id: 'rol_c', name: 'Kho', position: 3 },
      { id: 'rol_a', name: 'Admin', position: 0 },
      { id: 'rol_e', name: 'B', position: 3 },
      { id: 'rol_d', name: 'B', position: 3 },
      { id: 'rol_b', name: 'Editor', position: 1 },
    ];
    expect(sortRoles(roles).map((role) => role.id)).toEqual([
      'rol_a',
      'rol_b',
      'rol_d',
      'rol_e',
      'rol_c',
    ]);
  });
});

describe('assignmentCounts', () => {
  it.each([
    [[], { users: 0, groups: 0 }],
    [['user', 'user', 'group'], { users: 2, groups: 1 }],
    [['group'], { users: 0, groups: 1 }],
  ] as const)('%j → %j', (types, expected) => {
    const assignments = types.map((type, index) => ({
      principal_type: type,
      principal_id: (type === 'user'
        ? `usr_${String(index).padStart(16, '0')}`
        : `grp_${String(index).padStart(16, '0')}`) as `usr_${string}`,
      name: 'x',
      email: null,
    }));
    expect(assignmentCounts(assignments)).toEqual(expected);
  });
});

describe('fullAccessOf (T713: from the server)', () => {
  const orgMembers = [member(USER, 'owner'), member(OWNER, 'admin')];
  it.each<[string, string, BasePrincipalDto['full_access'], FullAccessReason | null]>([
    ['org owner', USER, 'org_admin', 'org_owner'],
    ['org admin', OWNER, 'org_admin', 'org_admin'],
    ['base owner', USER, 'base_owner', 'base_owner'],
    ['workspace admin', USER, 'workspace_admin', 'workspace_admin'],
    ['group that is workspace admin', GROUP, 'workspace_admin', 'workspace_admin'],
    ['by role', USER, null, null],
    ['group by role', GROUP, null, null],
  ])('%s', (_, id, fullAccess, expected) => {
    expect(
      fullAccessOf(
        {
          principal_type: id.startsWith('grp_') ? 'group' : 'user',
          principal_id: id as `usr_${string}`,
          full_access: fullAccess,
        },
        { orgMembers },
      ),
    ).toBe(expected);
  });

  it('says organization admin before the member list loads', () => {
    expect(
      fullAccessOf(
        { principal_type: 'user', principal_id: USER, full_access: 'org_admin' },
        { orgMembers: undefined },
      ),
    ).toBe('org_admin');
  });
});

describe('roleChangeOf', () => {
  it.each<[string | null, string, RoleChange]>([
    [null, NO_ROLE, { kind: 'none' }],
    ['rol_a', 'rol_a', { kind: 'none' }],
    [null, 'rol_a', { kind: 'assign', roleId: 'rol_a' }],
    ['rol_a', 'rol_b', { kind: 'assign', roleId: 'rol_b' }],
    ['rol_a', NO_ROLE, { kind: 'remove' }],
  ])('%s → %j', (current, value, expected) => {
    expect(roleChangeOf(current, value)).toEqual(expected);
  });
});
