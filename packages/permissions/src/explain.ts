import type { ResolveBaseAccessInput } from './resolve.js';
import type { AccessSourceKind, Id } from '@cellhive/contracts';

/** Where a principal's access to a base comes from (BACKLOG T711, CONTRACTS §5A). */
export interface AccessSource {
  kind: AccessSourceKind;
  /**
   * Roles the access is resolved from, in the order of `input.roles`:
   * `direct_role` — the user's direct roles; `group_roles` — every role of
   * the user's groups. Empty for the other kinds.
   */
  roleIds: Id<'rol'>[];
  /** `group_roles`: the user's groups (in `principal.groupIds` order) that give one of `roleIds`. */
  groupIds: Id<'grp'>[];
}

const implied = (kind: AccessSourceKind): AccessSource => ({ kind, roleIds: [], groupIds: [] });

/**
 * Explains `resolveBaseAccess(input)`: which step of the SPEC §14.1
 * resolution order grants the access, and from which roles and groups.
 * Follows `resolveBaseAccess` step by step, so that `kind = none` exactly
 * when it returns `null` and resolving from the returned roles alone gives
 * the same result (test `explain.test.ts`):
 *
 * 1. Not a member of the organization → `none`.
 * 2. Organization owner/admin → `org_admin`; base owner → `base_owner`;
 *    admin of the base's workspace → `workspace_admin` (in this order).
 * 3. A role assigned directly to the user → `direct_role` (group roles are
 *    ignored; a direct role that is not among `input.roles` — its config
 *    could not be read — grants nothing, so `none`).
 * 4. Otherwise the roles of the user's groups → `group_roles`.
 * 5. No role → `none`.
 *
 * The `admin` system role is reported as the role it is (`direct_role` or
 * `group_roles`), not as an implied kind.
 */
export function explainBaseAccess(input: ResolveBaseAccessInput): AccessSource {
  const { principal, roles, assignments } = input;
  if (principal.orgRole === null) return implied('none');
  if (principal.orgRole === 'owner' || principal.orgRole === 'admin') return implied('org_admin');
  if (principal.isBaseOwner) return implied('base_owner');
  if (principal.workspaceRole === 'admin') return implied('workspace_admin');

  const directRoleIds = new Set<string>();
  for (const assignment of assignments) {
    if (assignment.principalType === 'user' && assignment.principalId === principal.userId) {
      directRoleIds.add(assignment.roleId);
    }
  }
  if (directRoleIds.size > 0) {
    const roleIds = roles.filter((role) => directRoleIds.has(role.id)).map((role) => role.id);
    return roleIds.length === 0 ? implied('none') : { kind: 'direct_role', roleIds, groupIds: [] };
  }

  const memberOf = new Set<string>(principal.groupIds);
  const rolesOfGroup = new Map<string, Set<string>>();
  for (const assignment of assignments) {
    if (assignment.principalType !== 'group' || !memberOf.has(assignment.principalId)) continue;
    let groupRoles = rolesOfGroup.get(assignment.principalId);
    if (groupRoles === undefined) {
      groupRoles = new Set();
      rolesOfGroup.set(assignment.principalId, groupRoles);
    }
    groupRoles.add(assignment.roleId);
  }
  const groupRoleIds = new Set([...rolesOfGroup.values()].flatMap((ids) => [...ids]));
  const roleIds = roles.filter((role) => groupRoleIds.has(role.id)).map((role) => role.id);
  if (roleIds.length === 0) return implied('none');
  const known = new Set<string>(roleIds);
  const groupIds = [...new Set(principal.groupIds)].filter((groupId) =>
    [...(rolesOfGroup.get(groupId) ?? [])].some((roleId) => known.has(roleId)),
  );
  return { kind: 'group_roles', roleIds, groupIds };
}
