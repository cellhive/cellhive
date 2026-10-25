import type {
  BasePrincipalDto,
  OrgMemberDto,
  RoleAssigneeDto,
  RoleDto,
  RoleKind,
} from '@cellhive/contracts';

/**
 * Pure helpers of the base settings pages (T712, FRONTEND §17): role order,
 * labels and assignment counts, and who has full access whatever their role.
 */

/** System roles have a translated label and description; custom roles their own name. */
export type SystemRoleKind = Exclude<RoleKind, 'custom'>;

export function isSystemRole(role: Pick<RoleDto, 'kind'>): role is { kind: SystemRoleKind } {
  return role.kind !== 'custom';
}

/** Roles in `position` order (CONTRACTS §14), ties by name then ID so the order is stable. */
export function sortRoles<T extends { id: string; name: string; position: number }>(
  roles: readonly T[],
): T[] {
  return [...roles].sort(
    (a, b) =>
      a.position - b.position ||
      a.name.localeCompare(b.name) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

export interface AssignmentCounts {
  readonly users: number;
  readonly groups: number;
}

export function assignmentCounts(assignments: readonly RoleAssigneeDto[]): AssignmentCounts {
  let users = 0;
  let groups = 0;
  for (const item of assignments) {
    if (item.principal_type === 'user') users += 1;
    else groups += 1;
  }
  return { users, groups };
}

/**
 * Why a principal has full access to the base whatever role it holds here
 * (SPEC §14.1 resolution order): the server says it (`full_access` of
 * `GET /bases/:id/principals`, T713) — organization owner/admin, base owner,
 * workspace admin (a group: when the group itself is one). The organization
 * member list tells an owner from an admin.
 */
export type FullAccessReason = 'org_owner' | 'org_admin' | 'base_owner' | 'workspace_admin';

export function fullAccessOf(
  principal: Pick<BasePrincipalDto, 'principal_type' | 'principal_id' | 'full_access'>,
  context: { readonly orgMembers: readonly Pick<OrgMemberDto, 'user' | 'role'>[] | undefined },
): FullAccessReason | null {
  switch (principal.full_access) {
    case null:
      return null;
    case 'org_admin': {
      const member = context.orgMembers?.find((item) => item.user.id === principal.principal_id);
      return member?.role === 'owner' ? 'org_owner' : 'org_admin';
    }
    default:
      return principal.full_access;
  }
}

/** The value of the "no access" option of the role select (= remove the assignment). */
export const NO_ROLE = '';

export type RoleChange =
  | { readonly kind: 'none' }
  | { readonly kind: 'assign'; readonly roleId: string }
  | { readonly kind: 'remove' };

/** What picking `value` in the role select of a principal holding `current` means. */
export function roleChangeOf(current: string | null, value: string): RoleChange {
  if (value === (current ?? NO_ROLE)) return { kind: 'none' };
  if (value === NO_ROLE) return { kind: 'remove' };
  return { kind: 'assign', roleId: value };
}
