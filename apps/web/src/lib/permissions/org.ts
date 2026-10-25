import type { OrgRoleName, WorkspaceRoleName } from '@cellhive/contracts';

/**
 * UX-only permission hints (FRONTEND §7) mirroring SPEC §14.1. They hide
 * buttons; the server still decides and the UI handles its 403/404.
 */
export function isOrgAdmin(role: OrgRoleName | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

/** Workspaces are created by organization owners/admins. */
export function canCreateWorkspace(orgRole: OrgRoleName | undefined): boolean {
  return isOrgAdmin(orgRole);
}

/** Bases are created by workspace admins and organization owners/admins. */
export function canCreateBase(
  orgRole: OrgRoleName | undefined,
  workspaceRole: WorkspaceRoleName | null | undefined,
): boolean {
  return isOrgAdmin(orgRole) || workspaceRole === 'admin';
}
