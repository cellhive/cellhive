import type { EffectiveAccess, Id, TableAccess } from '@cellhive/contracts';

/**
 * Who manages an automation (ADR-25 §3, SPEC §14.1 item 5): a base admin,
 * or whoever has `manage` on the trigger's table. A trigger without a table
 * (`schedule`) — or whose table the person cannot see any more — is for
 * base admins only.
 */
export function canManageAutomation(
  access: EffectiveAccess,
  triggerTableId: Id<'tbl'> | null,
): boolean {
  if (access.is_admin) return true;
  return triggerTableId !== null && access.tables[triggerTableId]?.perm === 'manage';
}

/**
 * Whether the person may see that an automation exists (`403` rather than
 * `404` when they may not manage it, BACKLOG "Quy ước S5"): it lives in a
 * base they open and, when it has a trigger table, they read that table
 * (base admins see every automation, even one whose table is in the trash).
 */
export function canSeeAutomation(
  access: EffectiveAccess,
  triggerTableId: Id<'tbl'> | null,
): boolean {
  return access.is_admin || triggerTableId === null || access.tables[triggerTableId] !== undefined;
}

/** Whether the person manages at least one automation trigger of the base (base admin or a `manage` table). */
export function managesAnyAutomation(access: EffectiveAccess): boolean {
  return access.is_admin || managedTableIds(access).length > 0;
}

/** Tables the person has `manage` on: the automations they manage without being base admin. */
export function managedTableIds(access: EffectiveAccess): Id<'tbl'>[] {
  return (Object.entries(access.tables) as [Id<'tbl'>, TableAccess][])
    .filter(([, table]) => table.perm === 'manage')
    .map(([id]) => id);
}
