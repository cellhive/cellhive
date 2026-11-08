import { systemRoleConfig, type SystemRolePresetName } from '@cellhive/permissions';

import { AuditWriter } from '../audit/audit-writer.js';
import { BaseRolesRepository } from '../db/repositories/base-roles.repository.js';
import { BasesRepository } from '../db/repositories/bases.repository.js';
import { GroupMembersRepository } from '../db/repositories/groups.repository.js';
import { OrgMembersRepository } from '../db/repositories/org-members.repository.js';
import { WorkspaceMembersRepository } from '../db/repositories/workspaces.repository.js';
import { withTxScope, type OrgScope } from '../db/repository.js';
import { emit } from '../events/event-writer.js';

import type { AuditContext } from '../audit/audit-entry.js';
import type { Db, Tx } from '../db/create-db.js';
import type { Base, JsonObject, JsonValue } from '../db/schema.js';
import type { EventType, Id } from '@cellhive/contracts';

/**
 * Creating a base (SPEC §13.1, §14.1): the base row and the three system
 * roles, shared by `POST /workspaces/:id/bases` (the API) and the
 * `base.import` job (the worker). Permission checks are the caller's.
 */

/** The system roles every base gets, in display order (SPEC §14.1). */
export const SYSTEM_ROLES: readonly {
  readonly preset: SystemRolePresetName;
  readonly name: string;
}[] = [
  { preset: 'admin', name: 'Admin' },
  { preset: 'editor', name: 'Editor' },
  { preset: 'reader', name: 'Reader' },
];

export interface CreateBaseRecordInput {
  readonly workspaceId: Id<'wsp'>;
  readonly ownerId: Id<'usr'>;
  readonly name: string;
  readonly icon?: string | null;
  readonly description?: string | null;
  readonly settings?: JsonObject;
  /**
   * The `base.import` job building the base: it is created hidden (CONTRACTS
   * §12.2) and nothing about it is emitted or audited until the job
   * finishes it (`finishImportedBase`).
   */
  readonly importJobId?: Id<'job'>;
}

const audit = new AuditWriter();

/** The settings a base admin may change, as the audit entry of `base.created` has them. */
function settingsOf(base: Pick<Base, 'name' | 'icon' | 'description'>): Record<string, JsonValue> {
  return { name: base.name, icon: base.icon, description: base.description };
}

/** Event (and its dispatch job) plus audit entry of one change, in `tx` (CONTRACTS §8). */
async function recordChange(
  tx: Tx,
  input: {
    readonly type: EventType;
    readonly organizationId: Id<'org'>;
    readonly baseId: Id<'bse'>;
    readonly entityType: string;
    readonly entityId: string;
    readonly context: AuditContext;
    readonly after: JsonObject;
    readonly data: JsonObject;
  },
): Promise<void> {
  await emit(tx, {
    type: input.type,
    organizationId: input.organizationId,
    entityType: input.entityType,
    entityId: input.entityId,
    actor: input.context.actor,
    ...(input.context.via === null ? {} : { via: input.context.via }),
    baseId: input.baseId,
    data: input.data,
  });
  await audit.write(tx, {
    action: input.type,
    organizationId: input.organizationId,
    baseId: input.baseId,
    entityType: input.entityType,
    entityId: input.entityId,
    before: null,
    after: input.after,
    context: input.context,
  });
}

/** `base.created` of a new base (its event and audit entry). */
async function recordBaseCreated(tx: Tx, base: Base, context: AuditContext): Promise<void> {
  await recordChange(tx, {
    type: 'base.created',
    organizationId: base.organization_id,
    baseId: base.id,
    entityType: 'base',
    entityId: base.id,
    context,
    after: { ...settingsOf(base), workspace_id: base.workspace_id, owner_id: base.owner_id },
    data: { name: base.name, workspace_id: base.workspace_id },
  });
}

/**
 * Creates a base owned by `input.ownerId` with its system roles, in `tx`.
 * A visible base records `base.created` and one `role.created` per system
 * role (`context`); a base being imported records nothing (see
 * {@link CreateBaseRecordInput.importJobId}).
 */
export async function createBaseRecord(
  db: Db,
  tx: Tx,
  scope: OrgScope,
  input: CreateBaseRecordInput,
  context: AuditContext,
): Promise<Base> {
  const txScope = withTxScope(scope, tx);
  const repositories = repositoriesOf(db);
  const created = await repositories.bases.create(txScope, {
    workspaceId: input.workspaceId,
    ownerId: input.ownerId,
    name: input.name,
    icon: input.icon ?? null,
    description: input.description ?? null,
    ...(input.settings === undefined ? {} : { settings: input.settings }),
    ...(input.importJobId === undefined ? {} : { importJobId: input.importJobId }),
  });
  const hidden = input.importJobId !== undefined;
  if (!hidden) await recordBaseCreated(tx, created, context);
  // A new base has no table nor dashboard yet: the presets cover what comes later.
  const schema = { tables: [], dashboards: [] };
  for (const [position, role] of SYSTEM_ROLES.entries()) {
    const config = systemRoleConfig(role.preset, schema) as unknown as JsonObject;
    const row = await repositories.roles.create(txScope, {
      baseId: created.id,
      name: role.name,
      kind: `system_${role.preset}`,
      config,
      position,
    });
    if (hidden) continue;
    await recordChange(tx, {
      type: 'role.created',
      organizationId: created.organization_id,
      baseId: created.id,
      entityType: 'role',
      entityId: row.id,
      context,
      after: { name: row.name, kind: row.kind, config },
      data: { name: row.name, kind: row.kind },
    });
  }
  return created;
}

/**
 * Finishes an import (CONTRACTS §12.2), in `tx` with the job's last steps:
 * the hidden base of `importJobId` becomes visible, and `base.created` is
 * recorded then, as if the base had just been created (its creator is the
 * importer, `context`). `undefined` when the job has no hidden base here.
 */
export async function finishImportedBase(
  db: Db,
  tx: Tx,
  scope: OrgScope,
  input: { readonly baseId: Id<'bse'>; readonly importJobId: Id<'job'> },
  context: AuditContext,
): Promise<Base | undefined> {
  const { bases } = repositoriesOf(db);
  const base = await bases.finishImport(withTxScope(scope, tx), input.baseId, input.importJobId);
  if (base !== undefined) await recordBaseCreated(tx, base, context);
  return base;
}

/**
 * Whether `userId` may create a base in `workspaceId` (CONTRACTS §12.2,
 * SPEC §14.1): an organization owner/admin, or an admin of the workspace
 * (directly or through a group). A user who is not a member is not.
 */
export async function mayCreateBaseIn(
  db: Db,
  scope: OrgScope,
  userId: Id<'usr'>,
  workspaceId: Id<'wsp'>,
): Promise<boolean> {
  const { orgMembers, workspaceMembers, groups } = repositoriesOf(db);
  const role = await orgMembers.roleOf(scope, userId);
  if (role === undefined) return false;
  if (role === 'owner' || role === 'admin') return true;
  const groupIds = await groups.groupIdsOfUser(scope, userId);
  const roles = await workspaceMembers.rolesOf(scope, { userId, groupIds }, [workspaceId]);
  return roles.get(workspaceId) === 'admin';
}

/** The repositories these functions use (built per call: they hold no state). */
function repositoriesOf(db: Db) {
  return {
    bases: new BasesRepository(db),
    roles: new BaseRolesRepository(db),
    orgMembers: new OrgMembersRepository(db),
    workspaceMembers: new WorkspaceMembersRepository(db),
    groups: new GroupMembersRepository(db),
  };
}
