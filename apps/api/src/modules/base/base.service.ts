import { UNKNOWN_PRINCIPAL } from '@cellhive/contracts';
import { systemRoleConfig, type SystemRolePresetName } from '@cellhive/permissions';
import {
  BaseRolesRepository,
  BasesRepository,
  OrgMembersRepository,
  publishComputedLocksChanged,
  strictComputedPermissionsOf,
  withTxScope,
  type Base,
  type Db,
  type JsonObject,
  type JsonValue,
} from '@cellhive/server-core';
import { Inject, Injectable } from '@nestjs/common';

import {
  AccessService,
  notFound,
  permissionDenied,
  type BaseAccess,
  type OrgAccess,
} from '../../common/access/access.service.js';
import {
  BASE_SCHEMA_META,
  type BaseSchemaMetaLoader,
} from '../../common/access/base-schema-meta.js';
import { diffOf, mutationContextOf, recordChange } from '../../common/access/change-log.js';
import { iso, offsetList, validationFailed } from '../../common/dto.js';
import { DB } from '../../common/tokens.js';

import type { Principal } from '../../common/auth/principal.js';
import type { RequestMeta } from '../../common/auth/request-meta.js';
import type {
  BaseDetail,
  BaseDto,
  BaseList,
  BaseListQuery,
  BaseMemberList,
  CreateBaseRequest,
  EffectiveAccess,
  Id,
  UpdateBaseRequest,
} from '@cellhive/contracts';

/** The system roles every base gets, in display order (SPEC §14.1). */
const SYSTEM_ROLES: readonly { preset: SystemRolePresetName; name: string }[] = [
  { preset: 'admin', name: 'Admin' },
  { preset: 'editor', name: 'Editor' },
  { preset: 'reader', name: 'Reader' },
];

export function baseDtoOf(base: Base): BaseDto {
  return {
    id: base.id,
    organization_id: base.organization_id,
    workspace_id: base.workspace_id,
    owner_id: base.owner_id,
    name: base.name,
    icon: base.icon,
    description: base.description,
    settings: {
      strict_computed_permissions: strictComputedPermissionsOf(base.settings),
    },
    permission_version: Number(base.permission_version),
    created_at: iso(base.created_at),
    updated_at: iso(base.updated_at),
    deleted_at: base.deleted_at === null ? null : iso(base.deleted_at),
  };
}

function baseDetailOf(base: Base, access: EffectiveAccess): BaseDetail {
  return { ...baseDtoOf(base), access };
}

/** Settings a base admin may change (not ownership). */
function settingsOf(base: Pick<Base, 'name' | 'icon' | 'description'>): Record<string, JsonValue> {
  return { name: base.name, icon: base.icon, description: base.description };
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Bases (SPEC §13.1, §14.1): workspace admins (and organization
 * owners/admins) create them; the creator owns the base and the three
 * system roles are created with it. Base admins change settings; ownership
 * moves only by the current owner or an organization owner/admin.
 */
@Injectable()
export class BaseService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(BasesRepository) private readonly bases: BasesRepository,
    @Inject(BaseRolesRepository) private readonly baseRoles: BaseRolesRepository,
    @Inject(OrgMembersRepository) private readonly orgMembers: OrgMembersRepository,
    @Inject(BASE_SCHEMA_META) private readonly schemaMeta: BaseSchemaMetaLoader,
    @Inject(AccessService) private readonly access: AccessService,
  ) {}

  /**
   * The active members of the organization who can open the base (T320),
   * for the user pickers of the base: never people outside it.
   */
  async members(base: BaseAccess): Promise<BaseMemberList> {
    const members = await this.access.membersWithAccess(base);
    return {
      items: members.map((member) => ({
        id: member.user.id,
        display_name: member.user.display_name,
        email: member.user.email,
      })),
    };
  }

  /**
   * Bases of a workspace the caller can open (all of them for workspace/org
   * admins). With `include_deleted`, also the bases in the trash the caller
   * may restore (all for admins, their own for others; see `restore`).
   */
  async list(
    principal: Principal,
    workspaceId: Id<'wsp'>,
    query: BaseListQuery,
  ): Promise<BaseList> {
    const workspace = await this.access.requireWorkspace(principal, workspaceId, 'read');
    const page = await this.bases.listPage(
      workspace.org.scope,
      workspaceId,
      query,
      workspace.isAdmin
        ? undefined
        : {
            userId: principal.userId,
            groupIds: await this.access.groupIds(principal, workspace.org),
          },
      { includeDeleted: query.include_deleted, ...this.onlyTokenBases(principal) },
    );
    return offsetList(page, query, baseDtoOf);
  }

  /** An API token limited to bases lists only those (ADR-36 §1). */
  private onlyTokenBases(principal: Principal): { onlyIds?: readonly Id<'bse'>[] } {
    const onlyIds = this.access.tokenBaseIds(principal);
    return onlyIds === null ? {} : { onlyIds };
  }

  async create(
    principal: Principal,
    workspaceId: Id<'wsp'>,
    input: CreateBaseRequest,
    meta: RequestMeta,
  ): Promise<BaseDetail> {
    const workspace = await this.access.requireWorkspace(principal, workspaceId, 'admin');
    const organizationId = workspace.org.organizationId;
    const base = await this.db.withTx(async (tx) => {
      const scope = withTxScope(workspace.org.scope, tx);
      const context = mutationContextOf(meta, principal.userId);
      const created = await this.bases.create(scope, {
        workspaceId,
        ownerId: principal.userId,
        name: input.name,
        icon: input.icon ?? null,
        description: input.description ?? null,
      });
      await recordChange(tx, {
        type: 'base.created',
        organizationId,
        baseId: created.id,
        entityType: 'base',
        entityId: created.id,
        context,
        after: { ...settingsOf(created), workspace_id: workspaceId, owner_id: principal.userId },
        data: { name: created.name, workspace_id: workspaceId },
      });
      const schema = await this.schemaMeta.load(scope, created.id);
      for (const [position, role] of SYSTEM_ROLES.entries()) {
        const config = systemRoleConfig(role.preset, schema) as unknown as JsonObject;
        const row = await this.baseRoles.create(scope, {
          baseId: created.id,
          name: role.name,
          kind: `system_${role.preset}`,
          config,
          position,
        });
        await recordChange(tx, {
          type: 'role.created',
          organizationId,
          baseId: created.id,
          entityType: 'role',
          entityId: row.id,
          context,
          after: { name: row.name, kind: row.kind, config },
          data: { name: row.name, kind: row.kind },
        });
      }
      return created;
    });
    const access = await this.access.findBase(principal, base.id, { fresh: true });
    if (access === undefined) throw notFound();
    return baseDetailOf(access.base, access.access);
  }

  get(access: BaseAccess): BaseDetail {
    return baseDetailOf(access.base, access.access);
  }

  async update(
    principal: Principal,
    access: BaseAccess,
    input: UpdateBaseRequest,
    meta: RequestMeta,
  ): Promise<BaseDetail> {
    const base = access.base;
    const changesSettings =
      input.name !== undefined ||
      input.icon !== undefined ||
      input.description !== undefined ||
      input.settings !== undefined;
    if (changesSettings && !access.access.is_admin) {
      throw permissionDenied('Only base admins can change the base settings.');
    }
    const transfersOwnership = input.owner_id !== undefined && input.owner_id !== base.owner_id;
    if (transfersOwnership && base.owner_id !== principal.userId && !access.org.isAdmin) {
      throw permissionDenied(
        'Only the base owner or an organization owner/admin can transfer ownership.',
      );
    }

    await this.db.withTx(async (tx) => {
      const scope = withTxScope(access.org.scope, tx);
      if (transfersOwnership && input.owner_id !== undefined) {
        if ((await this.orgMembers.get(scope, input.owner_id)) === undefined) {
          throw validationFailed('The new owner must be a member of the organization.', {
            path: 'owner_id',
            code: UNKNOWN_PRINCIPAL,
          });
        }
      }
      const before: Record<string, JsonValue> = {
        ...settingsOf(base),
        strict_computed_permissions: strictComputedPermissionsOf(base.settings),
        owner_id: base.owner_id,
      };
      const strict = input.settings?.strict_computed_permissions;
      const after: Record<string, JsonValue> = {
        name: input.name ?? base.name,
        icon: input.icon === undefined ? base.icon : input.icon,
        description: input.description === undefined ? base.description : input.description,
        strict_computed_permissions: strict ?? strictComputedPermissionsOf(base.settings),
        owner_id: input.owner_id ?? base.owner_id,
      };
      const changes = diffOf(before, after);
      if (Object.keys(changes).length === 0) return;
      const updated = await this.bases.update(scope, base.id, {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.icon === undefined ? {} : { icon: input.icon }),
        ...(input.description === undefined ? {} : { description: input.description }),
        // `meta.bases.settings` keeps its other keys (locale, collation…).
        ...(strict === undefined
          ? {}
          : {
              settings: {
                ...(isObject(base.settings) ? base.settings : {}),
                strict_computed_permissions: strict,
              },
            }),
        ...(transfersOwnership && input.owner_id !== undefined ? { ownerId: input.owner_id } : {}),
      });
      if (updated === undefined) throw notFound();
      const changedBefore = Object.fromEntries(
        Object.keys(changes).map((key) => [key, before[key] ?? null]),
      );
      const changedAfter = Object.fromEntries(
        Object.keys(changes).map((key) => [key, after[key] ?? null]),
      );
      await recordChange(tx, {
        type: 'base.updated',
        organizationId: access.org.organizationId,
        baseId: base.id,
        entityType: 'base',
        entityId: base.id,
        context: mutationContextOf(meta, principal.userId),
        before: changedBefore,
        after: changedAfter,
        changes,
      });
      // Who sees formulas as `locked` may change: clients refetch them (T459).
      if (Object.hasOwn(changes, 'strict_computed_permissions')) {
        await publishComputedLocksChanged(this.db, tx, access.org.scope, base.id);
      }
    });
    const fresh = await this.access.findBase(principal, base.id, { fresh: true });
    // The caller may have given the base away and lost access.
    if (fresh === undefined) throw notFound();
    return baseDetailOf(fresh.base, fresh.access);
  }

  /** Moves the base to the trash: owner, workspace admin or organization owner/admin. */
  async delete(principal: Principal, access: BaseAccess, meta: RequestMeta): Promise<void> {
    const base = access.base;
    const allowed =
      access.org.isAdmin || access.workspaceRole === 'admin' || base.owner_id === principal.userId;
    if (!allowed) {
      throw permissionDenied(
        'Only the base owner, a workspace admin or an organization owner/admin can delete it.',
      );
    }
    await this.db.withTx(async (tx) => {
      const deleted = await this.bases.softDelete(withTxScope(access.org.scope, tx), base.id);
      if (deleted === undefined) throw notFound();
      await recordChange(tx, {
        type: 'base.deleted',
        organizationId: access.org.organizationId,
        baseId: base.id,
        entityType: 'base',
        entityId: base.id,
        context: mutationContextOf(meta, principal.userId),
        before: { name: base.name, workspace_id: base.workspace_id },
        data: { name: base.name, workspace_id: base.workspace_id },
      });
    });
    this.access.invalidate(principal);
  }

  /**
   * Takes a base out of the trash: the same people who may delete it (base
   * owner, workspace admin, organization owner/admin). A trashed base is
   * invisible to everyone else (`404`). A base outside the trash is returned
   * as it is (when the caller can open it). No time limit until bases are
   * purged from the trash.
   */
  async restore(principal: Principal, baseId: Id<'bse'>, meta: RequestMeta): Promise<BaseDetail> {
    const trashed = await this.findRestorable(principal, baseId);
    if (trashed !== undefined) {
      const { org, base } = trashed;
      await this.db.withTx(async (tx) => {
        const restored = await this.bases.restore(withTxScope(org.scope, tx), base.id);
        // Restored concurrently: nothing left to do.
        if (restored === undefined) return;
        await recordChange(tx, {
          type: 'base.restored',
          organizationId: org.organizationId,
          baseId: base.id,
          entityType: 'base',
          entityId: base.id,
          context: mutationContextOf(meta, principal.userId),
          after: { name: restored.name, workspace_id: restored.workspace_id },
          data: { name: restored.name, workspace_id: restored.workspace_id },
        });
      });
      this.access.invalidate(principal);
    }
    const access = await this.access.findBase(principal, baseId, { fresh: true });
    if (access === undefined) throw notFound();
    return baseDetailOf(access.base, access.access);
  }

  /** The caller's organization and the base, when it is in the trash and the caller may restore it. */
  private async findRestorable(
    principal: Principal,
    baseId: Id<'bse'>,
  ): Promise<{ org: OrgAccess; base: Base } | undefined> {
    for (const membership of await this.access.memberships(principal)) {
      const org = await this.access.findOrg(principal, membership.organizationId);
      if (org === undefined) continue;
      const base = await this.bases.getById(org.scope, baseId, { includeDeleted: true });
      if (base === undefined) continue;
      if (base.deleted_at === null) return undefined;
      const workspaceRole =
        (await this.access.workspaceRoles(principal, org)).get(base.workspace_id) ?? null;
      const allowed =
        org.isAdmin || workspaceRole === 'admin' || base.owner_id === principal.userId;
      if (!allowed) throw notFound();
      return { org, base };
    }
    return undefined;
  }
}
