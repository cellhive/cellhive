import {
  AuditWriter,
  BaseRoleMembersRepository,
  BaseRolesRepository,
  BasesRepository,
  emit,
  WorkspaceMembersRepository,
  type AuditContext,
  type JsonObject,
  type JsonValue,
  type OrgScope,
  type Tx,
} from '@cellhive/server-core';
import { Inject, Injectable } from '@nestjs/common';

import { auditContextOf, type RequestMeta } from '../auth/request-meta.js';

import type { EventType, Id } from '@cellhive/contracts';

/**
 * Audit context of a mutation made by a signed-in user: the request ID is
 * also the batch ID, so every entry written by one request is grouped
 * (ADR-23).
 */
export function mutationContextOf(meta: RequestMeta, userId: Id<'usr'>): AuditContext {
  const context = auditContextOf(meta, { type: 'user', id: userId });
  return { ...context, batch_id: context.request_id };
}

export interface ChangeInput {
  /** Event type, also the audit action (CONTRACTS §8). */
  readonly type: EventType;
  readonly organizationId: Id<'org'>;
  readonly baseId?: Id<'bse'> | null;
  readonly tableId?: Id<'tbl'> | null;
  readonly entityType: string;
  readonly entityId: string;
  readonly context: AuditContext;
  readonly before?: JsonObject | null;
  readonly after?: JsonObject | null;
  /** Extra event data (never secrets). */
  readonly data?: JsonObject;
  readonly changes?: Readonly<Record<string, { readonly from: JsonValue; readonly to: JsonValue }>>;
}

const audit = new AuditWriter();

/**
 * Writes the event (plus its dispatch job) and the audit entry of one
 * mutation, in the mutation's transaction (CONTRACTS §8: every event is
 * audited).
 */
export async function recordChange(tx: Tx, input: ChangeInput): Promise<void> {
  await emit(tx, {
    type: input.type,
    organizationId: input.organizationId,
    entityType: input.entityType,
    entityId: input.entityId,
    actor: input.context.actor,
    // The event carries the audit `via` (ADR-23): `api_token_id` through a token (T705).
    ...(input.context.via === null ? {} : { via: input.context.via }),
    ...(input.baseId == null ? {} : { baseId: input.baseId }),
    ...(input.tableId == null ? {} : { tableId: input.tableId }),
    ...(input.data === undefined ? {} : { data: input.data }),
    ...(input.changes === undefined ? {} : { changes: input.changes }),
  });
  await audit.write(tx, {
    action: input.type,
    organizationId: input.organizationId,
    baseId: input.baseId ?? null,
    ...(input.tableId == null ? {} : { tableId: input.tableId }),
    entityType: input.entityType,
    entityId: input.entityId,
    before: input.before ?? null,
    after: input.after ?? null,
    context: input.context,
  });
}

/** `{ key: { from, to } }` for the keys whose value differs. */
export function diffOf(
  before: Readonly<Record<string, JsonValue>>,
  after: Readonly<Record<string, JsonValue>>,
): Record<string, { from: JsonValue; to: JsonValue }> {
  const changes: Record<string, { from: JsonValue; to: JsonValue }> = {};
  for (const key of Object.keys(after)) {
    const from = before[key] ?? null;
    const to = after[key] ?? null;
    if (JSON.stringify(from) !== JSON.stringify(to)) changes[key] = { from, to };
  }
  return changes;
}

/**
 * Bumps `bases.permission_version` (SPEC §14.1) when memberships that feed
 * access resolution change. Always called with a scope bound to the
 * mutation's transaction.
 */
@Injectable()
export class PermissionVersions {
  constructor(
    @Inject(BasesRepository) private readonly bases: BasesRepository,
    @Inject(BaseRoleMembersRepository) private readonly roleMembers: BaseRoleMembersRepository,
    @Inject(BaseRolesRepository) private readonly roles: BaseRolesRepository,
    @Inject(WorkspaceMembersRepository)
    private readonly workspaceMembers: WorkspaceMembersRepository,
  ) {}

  /** Every base of the organization (an organization role changed or a member left). */
  bumpOrganization(scope: OrgScope): Promise<number> {
    return this.bases.bumpPermissionVersion(scope, { all: true });
  }

  /** Every base of these workspaces (a workspace admin was added, changed or removed). */
  bumpWorkspaces(scope: OrgScope, workspaceIds: readonly Id<'wsp'>[]): Promise<number> {
    return this.bases.bumpPermissionVersion(scope, { workspaceIds });
  }

  bumpBases(scope: OrgScope, baseIds: readonly Id<'bse'>[]): Promise<number> {
    return this.bases.bumpPermissionVersion(scope, { baseIds });
  }

  /**
   * Bases a group's membership matters for: those where the group has a
   * role, every base with a role whose filters use `current_user_groups`
   * (the variable resolves to the members of all groups of the current user,
   * whatever role the user holds, SPEC §6.1), and every base of workspaces
   * the group administers.
   */
  async bumpForGroup(scope: OrgScope, groupId: Id<'grp'>): Promise<number> {
    const baseIds = [
      ...(await this.roleMembers.baseIdsForGroup(scope, groupId)),
      ...(await this.roles.baseIdsUsingGroupsVariable(scope)),
    ];
    const adminOf = (await this.workspaceMembers.listForPrincipal(scope, 'group', groupId))
      .filter((membership) => membership.role === 'admin')
      .map((membership) => membership.workspace_id);
    return (await this.bumpBases(scope, baseIds)) + (await this.bumpWorkspaces(scope, adminOf));
  }
}
