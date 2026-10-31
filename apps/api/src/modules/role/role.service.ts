import {
  isId,
  ROLE_IN_USE,
  SYSTEM_ROLE,
  UNKNOWN_DASHBOARD,
  UNKNOWN_PRINCIPAL,
  UNKNOWN_ROLE,
  type AssignRoleRequest,
  type CreateRoleRequest,
  type Id,
  type OffsetQuery,
  type RemoveRoleAssignmentRequest,
  type RoleAssignmentDto,
  type RoleDto,
  type RoleList,
  type RoleWithAdjustments,
  type UpdateRoleRequest,
} from '@cellhive/contracts';
import {
  prepareRoleConfig,
  type RoleAdjustment,
  type RoleConfig,
  type RoleFieldMeta,
  type RoleKind,
  type RoleSchemaMeta,
} from '@cellhive/permissions';
import {
  BaseRoleMembersRepository,
  BaseRolesRepository,
  BasesRepository,
  DashboardsRepository,
  FieldsRepository,
  GroupsRepository,
  isAiField,
  OrgMembersRepository,
  TablesRepository,
  ViewsRepository,
  withTxScope,
  type AuditContext,
  type BaseRole,
  type BaseRoleMember,
  type Db,
  type JsonObject,
  type JsonValue,
  type OrgScope,
  type Tx,
} from '@cellhive/server-core';
import { AppError, zodIssuesToProblemErrors } from '@cellhive/server-core/errors';
import { Inject, Injectable } from '@nestjs/common';

import { AccessService, notFound, type BaseAccess } from '../../common/access/access.service.js';
import { diffOf, mutationContextOf, recordChange } from '../../common/access/change-log.js';
import { iso, validationFailed } from '../../common/dto.js';
import { DB } from '../../common/tokens.js';

import type { Principal } from '../../common/auth/principal.js';
import type { RequestMeta } from '../../common/auth/request-meta.js';

type Assignee = RoleDto['assignments'][number];

/** Display name (and email for users) of each assigned principal, by principal ID. */
type AssigneeNames = ReadonlyMap<string, { readonly name: string; readonly email: string | null }>;

function roleDtoOf(
  role: BaseRole,
  assignments: readonly BaseRoleMember[],
  names: AssigneeNames,
): RoleDto {
  return {
    id: role.id,
    base_id: role.base_id,
    name: role.name,
    kind: role.kind,
    config: role.config as Record<string, unknown>,
    position: role.position,
    assignments: assignments
      .filter((member) => member.role_id === role.id)
      .map((member): Assignee => {
        const named = names.get(member.principal_id);
        return {
          principal_type: member.principal_type,
          principal_id: member.principal_id,
          // Removing a member or deleting a group removes its assignments.
          name: named?.name ?? member.principal_id,
          email: named?.email ?? null,
        };
      }),
    created_at: iso(role.created_at),
    updated_at: iso(role.updated_at),
  };
}

function nameConflict(): AppError {
  return new AppError('NAME_CONFLICT', {
    detail: 'A role with this name already exists in the base.',
    errors: [{ path: 'name', code: 'NAME_CONFLICT', message: 'Name already used' }],
  });
}

/** `value` with object keys sorted recursively, for order-insensitive comparison. */
function canonical(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key] ?? null)]),
  );
}

/** Well-formed view ids of every `tables.*.view_rule.visible_views` of a raw role config. */
function visibleViewIdsOf(config: unknown): Id<'viw'>[] {
  const ids = new Set<Id<'viw'>>();
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  const tables = isRecord(config) ? config['tables'] : undefined;
  if (!isRecord(tables)) return [];
  for (const rule of Object.values(tables)) {
    const viewRule = isRecord(rule) ? rule['view_rule'] : undefined;
    const visible = isRecord(viewRule) ? viewRule['visible_views'] : undefined;
    if (!Array.isArray(visible)) continue;
    for (const id of visible) if (typeof id === 'string' && isId('viw', id)) ids.add(id);
  }
  return [...ids];
}

/** The `dashboards` object of a stored (raw) role config, `{}` when absent. */
function storedDashboardsOf(config: unknown): Record<string, unknown> {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return {};
  const dashboards = (config as Record<string, unknown>)['dashboards'];
  return typeof dashboards === 'object' && dashboards !== null && !Array.isArray(dashboards)
    ? (dashboards as Record<string, unknown>)
    : {};
}

function jsonOf(config: RoleConfig): JsonObject {
  return config as unknown as JsonObject;
}

/**
 * Base roles and their assignments (SPEC §13.1, §14.1; BACKLOG T109). Base
 * admins only (the controller requires `@RequireBase('admin')`).
 *
 * Every change runs in one transaction that locks the base row (serialising
 * concurrent role changes, so name checks hold), bumps
 * `bases.permission_version`, and writes the entity event
 * (`role.created|updated|deleted`, `role_assignment.changed`) plus
 * `permission.changed`, each with its audit entry.
 */
@Injectable()
export class RoleService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(BasesRepository) private readonly bases: BasesRepository,
    @Inject(BaseRolesRepository) private readonly roles: BaseRolesRepository,
    @Inject(BaseRoleMembersRepository) private readonly members: BaseRoleMembersRepository,
    @Inject(OrgMembersRepository) private readonly orgMembers: OrgMembersRepository,
    @Inject(GroupsRepository) private readonly groups: GroupsRepository,
    @Inject(TablesRepository) private readonly tables: TablesRepository,
    @Inject(FieldsRepository) private readonly fields: FieldsRepository,
    @Inject(ViewsRepository) private readonly views: ViewsRepository,
    @Inject(DashboardsRepository) private readonly dashboards: DashboardsRepository,
    @Inject(AccessService) private readonly access: AccessService,
  ) {}

  async list(base: BaseAccess, query: OffsetQuery): Promise<RoleList> {
    const scope = base.org.scope;
    const [roles, assignments] = await Promise.all([
      this.roles.listByBase(scope, base.base.id),
      this.members.listByBase(scope, base.base.id),
    ]);
    const page = roles.slice(query.offset, query.offset + query.limit);
    const shown = assignments.filter((member) => page.some((role) => role.id === member.role_id));
    const names = await this.assigneeNames(scope, shown);
    return {
      items: page.map((role) => roleDtoOf(role, shown, names)),
      total: roles.length,
      offset: query.offset,
      limit: query.limit,
    };
  }

  async get(base: BaseAccess, roleId: Id<'rol'>): Promise<RoleDto> {
    const scope = base.org.scope;
    const role = await this.roles.getById(scope, base.base.id, roleId);
    if (role === undefined) throw notFound();
    const assignments = (await this.members.listByBase(scope, base.base.id)).filter(
      (member) => member.role_id === role.id,
    );
    return roleDtoOf(role, assignments, await this.assigneeNames(scope, assignments));
  }

  async create(
    principal: Principal,
    base: BaseAccess,
    input: CreateRoleRequest,
    meta: RequestMeta,
  ): Promise<RoleWithAdjustments> {
    const context = mutationContextOf(meta, principal.userId);
    const result = await this.db.withTx(async (tx) => {
      const scope = withTxScope(base.org.scope, tx);
      const version = await this.lockBase(scope, base);
      if ((await this.roles.findByName(scope, base.base.id, input.name)) !== undefined) {
        throw nameConflict();
      }
      const schema = await this.schemaOf(scope, base, input.config);
      const prepared = this.prepare(input.config ?? {}, schema, 'custom');
      prepared.config.dashboards = await this.checkDashboards(
        scope,
        base,
        schema,
        prepared.config,
        {},
      );
      const role = await this.roles.create(scope, {
        baseId: base.base.id,
        name: input.name,
        kind: 'custom',
        config: jsonOf(prepared.config),
        position: await this.roles.nextPosition(scope, base.base.id),
      });
      await recordChange(tx, {
        type: 'role.created',
        organizationId: base.org.organizationId,
        baseId: base.base.id,
        entityType: 'role',
        entityId: role.id,
        context,
        after: { name: role.name, kind: role.kind, config: jsonOf(prepared.config) },
        data: { name: role.name, kind: role.kind },
      });
      await this.permissionChanged(tx, scope, base, version, context);
      return { role, adjustments: prepared.adjustments };
    });
    this.access.invalidate(principal);
    return { ...roleDtoOf(result.role, [], new Map()), adjustments: result.adjustments };
  }

  async update(
    principal: Principal,
    base: BaseAccess,
    roleId: Id<'rol'>,
    input: UpdateRoleRequest,
    meta: RequestMeta,
  ): Promise<RoleWithAdjustments> {
    const context = mutationContextOf(meta, principal.userId);
    const result = await this.db.withTx(async (tx) => {
      const scope = withTxScope(base.org.scope, tx);
      const version = await this.lockBase(scope, base);
      const current = await this.roles.getById(scope, base.base.id, roleId);
      if (current === undefined) throw notFound();

      let adjustments: RoleAdjustment[] = [];
      let config: JsonObject | undefined;
      if (input.config !== undefined) {
        if (current.kind === 'system_admin') {
          throw validationFailed('The config of the admin role cannot change.', {
            path: 'config',
            code: SYSTEM_ROLE,
          });
        }
        const schema = await this.schemaOf(scope, base, input.config);
        const prepared = this.prepare(input.config, schema, current.kind);
        prepared.config.dashboards = await this.checkDashboards(
          scope,
          base,
          schema,
          prepared.config,
          current.config,
        );
        adjustments = prepared.adjustments;
        config = jsonOf(prepared.config);
      }
      if (
        input.name !== undefined &&
        (await this.roles.findByName(scope, base.base.id, input.name, roleId)) !== undefined
      ) {
        throw nameConflict();
      }

      const before: JsonObject = { name: current.name, config: current.config };
      const after: JsonObject = {
        name: input.name ?? current.name,
        config: config ?? current.config,
      };
      // `jsonb` does not keep key order: compare canonical forms.
      const changes = diffOf(canonical(before) as JsonObject, canonical(after) as JsonObject);
      if (Object.keys(changes).length === 0) return { role: current, adjustments };

      const updated = await this.roles.update(scope, base.base.id, roleId, {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(config === undefined ? {} : { config }),
      });
      if (updated === undefined) throw notFound();
      await recordChange(tx, {
        type: 'role.updated',
        organizationId: base.org.organizationId,
        baseId: base.base.id,
        entityType: 'role',
        entityId: roleId,
        context,
        before: Object.fromEntries(Object.keys(changes).map((key) => [key, before[key] ?? null])),
        after: Object.fromEntries(Object.keys(changes).map((key) => [key, after[key] ?? null])),
        data: { name: updated.name, kind: updated.kind, changed: Object.keys(changes) },
      });
      await this.permissionChanged(tx, scope, base, version, context);
      return { role: updated, adjustments };
    });
    this.access.invalidate(principal);
    const assignments = (await this.members.listByBase(base.org.scope, base.base.id)).filter(
      (member) => member.role_id === roleId,
    );
    const names = await this.assigneeNames(base.org.scope, assignments);
    return { ...roleDtoOf(result.role, assignments, names), adjustments: result.adjustments };
  }

  /**
   * Deletes a custom role. A role still assigned to someone is refused
   * (`ROLE_IN_USE`) rather than silently taking access away from them.
   */
  async delete(
    principal: Principal,
    base: BaseAccess,
    roleId: Id<'rol'>,
    meta: RequestMeta,
  ): Promise<void> {
    const context = mutationContextOf(meta, principal.userId);
    await this.db.withTx(async (tx) => {
      const scope = withTxScope(base.org.scope, tx);
      const version = await this.lockBase(scope, base);
      const current = await this.roles.getById(scope, base.base.id, roleId);
      if (current === undefined) throw notFound();
      if (current.kind !== 'custom') {
        throw validationFailed('System roles cannot be deleted.', {
          path: 'role_id',
          code: SYSTEM_ROLE,
        });
      }
      const assigned = await this.members.countByRole(scope, base.base.id, roleId);
      if (assigned > 0) {
        throw validationFailed('The role is still assigned; remove its assignments first.', {
          path: 'role_id',
          code: ROLE_IN_USE,
          params: { assignments: assigned },
        });
      }
      if ((await this.roles.delete(scope, base.base.id, roleId)) === undefined) throw notFound();
      await recordChange(tx, {
        type: 'role.deleted',
        organizationId: base.org.organizationId,
        baseId: base.base.id,
        entityType: 'role',
        entityId: roleId,
        context,
        before: { name: current.name, kind: current.kind, config: current.config },
        data: { name: current.name, kind: current.kind },
      });
      await this.permissionChanged(tx, scope, base, version, context);
    });
    this.access.invalidate(principal);
  }

  /** Gives a user or group a role in the base, replacing its previous role. */
  async assign(
    principal: Principal,
    base: BaseAccess,
    input: AssignRoleRequest,
    meta: RequestMeta,
  ): Promise<RoleAssignmentDto> {
    const context = mutationContextOf(meta, principal.userId);
    const previous = await this.db.withTx(async (tx) => {
      const scope = withTxScope(base.org.scope, tx);
      const version = await this.lockBase(scope, base);
      if ((await this.roles.getById(scope, base.base.id, input.role_id)) === undefined) {
        throw validationFailed('The role does not exist in this base.', {
          path: 'role_id',
          code: UNKNOWN_ROLE,
        });
      }
      await this.requirePrincipal(scope, input.principal_type, input.principal_id);
      const current = await this.members.getForPrincipal(
        scope,
        base.base.id,
        input.principal_type,
        input.principal_id,
      );
      const previousRoleId = current?.role_id ?? null;
      if (previousRoleId === input.role_id) return previousRoleId;
      await this.members.assign(scope, {
        baseId: base.base.id,
        roleId: input.role_id,
        principalType: input.principal_type,
        principalId: input.principal_id,
      });
      await this.assignmentChanged(tx, base, context, {
        principalType: input.principal_type,
        principalId: input.principal_id,
        from: previousRoleId,
        to: input.role_id,
      });
      await this.permissionChanged(tx, scope, base, version, context);
      return previousRoleId;
    });
    this.access.invalidate(principal);
    return {
      base_id: base.base.id,
      role_id: input.role_id,
      principal_type: input.principal_type,
      principal_id: input.principal_id,
      previous_role_id: previous,
    };
  }

  async removeAssignment(
    principal: Principal,
    base: BaseAccess,
    input: RemoveRoleAssignmentRequest,
    meta: RequestMeta,
  ): Promise<void> {
    const context = mutationContextOf(meta, principal.userId);
    await this.db.withTx(async (tx) => {
      const scope = withTxScope(base.org.scope, tx);
      const version = await this.lockBase(scope, base);
      const removed = await this.members.remove(
        scope,
        base.base.id,
        input.principal_type,
        input.principal_id,
      );
      if (removed === undefined) throw notFound();
      await this.assignmentChanged(tx, base, context, {
        principalType: input.principal_type,
        principalId: input.principal_id,
        from: removed.role_id,
        to: null,
      });
      await this.permissionChanged(tx, scope, base, version, context);
    });
    this.access.invalidate(principal);
  }

  /**
   * Names of the assigned users and groups: one batched lookup per principal
   * type, scoped to the organization (principals of other organizations
   * cannot match).
   */
  private async assigneeNames(
    scope: OrgScope,
    assignments: readonly BaseRoleMember[],
  ): Promise<AssigneeNames> {
    const idsOf = <T extends string>(type: BaseRoleMember['principal_type']) =>
      assignments
        .filter((member) => member.principal_type === type)
        .map((member) => member.principal_id as T);
    const [users, groups] = await Promise.all([
      this.orgMembers.listWithUserByIds(scope, idsOf<Id<'usr'>>('user')),
      this.groups.listByIds(scope, idsOf<Id<'grp'>>('group')),
    ]);
    const names = new Map<string, { name: string; email: string | null }>();
    for (const member of users) {
      names.set(member.user.id, { name: member.user.display_name, email: member.user.email });
    }
    for (const group of groups) names.set(group.id, { name: group.name, email: null });
    return names;
  }

  /** Locks the base row for the transaction; returns its current permission version. */
  private async lockBase(scope: OrgScope, base: BaseAccess): Promise<number> {
    const locked = await this.bases.lockForUpdate(scope, base.base.id);
    // Deleted meanwhile.
    if (locked === undefined) throw notFound();
    return Number(locked.permission_version);
  }

  /**
   * Active tables, fields and shared views of the base, as role validation
   * needs them. Read under the base lock: deleting a shared view takes it
   * too, so `visible_views` never keeps a deleted view.
   */
  private async schemaOf(
    scope: OrgScope,
    base: BaseAccess,
    config: unknown,
  ): Promise<RoleSchemaMeta> {
    const schema = await this.activeSchemaOf(scope, base);
    // Which `visible_views` entries still name a view: ids of deleted views
    // are dropped silently (roles saved before T301), others are checked.
    const referenced = visibleViewIdsOf(config);
    const existingViews =
      referenced.length === 0 ? new Set<string>() : await this.views.existingIds(scope, referenced);
    return { ...schema, existingViews };
  }

  private async activeSchemaOf(scope: OrgScope, base: BaseAccess): Promise<RoleSchemaMeta> {
    // Sequential: `scope` carries the transaction (one connection).
    const tables = await this.tables.listByBase(scope, base.base.id);
    const fields =
      tables.length === 0 ? [] : await this.fields.listActiveByBase(scope, base.base.id);
    const views =
      tables.length === 0
        ? new Map<Id<'tbl'>, Id<'viw'>[]>()
        : await this.views.sharedIdsByBase(scope, base.base.id);
    const dashboards = await this.dashboards.activeIdsByBase(scope, base.base.id);
    const byTable = new Map<Id<'tbl'>, RoleFieldMeta[]>(tables.map((table) => [table.id, []]));
    for (const field of fields) {
      byTable.get(field.table_id)?.push({
        id: field.id,
        name: field.name,
        type: field.type as RoleFieldMeta['type'],
        options: field.options,
        // AI fields (T910) are written by the AI worker only: read at most, like formulas.
        ...(field.compute_mode === null && !isAiField(field) ? {} : { computed: true }),
      });
    }
    return {
      tables: tables.map((table) => ({
        id: table.id,
        fields: byTable.get(table.id) ?? [],
        views: views.get(table.id) ?? [],
      })),
      dashboards,
    };
  }

  /**
   * `dashboards.<id>` of a config, checked against the base (BACKLOG T815,
   * CONTRACTS §14): an active dashboard or one in the base trash (restoring
   * it keeps the grant) is kept; an id the stored config already lists but
   * that no longer exists (purged) is dropped silently; any other id is
   * `UNKNOWN_DASHBOARD` — including dashboards of other bases.
   */
  private async checkDashboards(
    scope: OrgScope,
    base: BaseAccess,
    schema: RoleSchemaMeta,
    config: RoleConfig,
    stored: unknown,
  ): Promise<RoleConfig['dashboards']> {
    const active = new Set<string>(schema.dashboards ?? []);
    const listed = new Set(Object.keys(storedDashboardsOf(stored)));
    const kept: RoleConfig['dashboards'] = {};
    const issues: { path: string; code: string; message: string }[] = [];
    // Sequential: `scope` carries the transaction (one connection).
    for (const [id, perm] of Object.entries(config.dashboards) as [
      Id<'dsh'>,
      RoleConfig['dashboards'][Id<'dsh'>],
    ][]) {
      if (active.has(id)) {
        kept[id] = perm;
        continue;
      }
      const row = await this.dashboards.getById(scope, id, { includeDeleted: true });
      if (row?.base_id === base.base.id) {
        kept[id] = perm;
      } else if (row === undefined && listed.has(id)) {
        continue;
      } else {
        issues.push({
          path: `config.dashboards.${id}`,
          code: UNKNOWN_DASHBOARD,
          message: 'The dashboard does not exist in the base',
        });
      }
    }
    if (issues.length > 0) {
      throw new AppError('VALIDATION_FAILED', {
        detail: 'The role config names dashboards that do not exist in the base.',
        errors: issues,
      });
    }
    return kept;
  }

  private prepare(
    input: unknown,
    schema: RoleSchemaMeta,
    kind: RoleKind,
  ): { config: RoleConfig; adjustments: RoleAdjustment[] } {
    const result = prepareRoleConfig(input, schema, { kind });
    if (result.ok) return result;
    switch (result.error) {
      case 'schema':
        throw new AppError('VALIDATION_FAILED', {
          detail: 'The role config does not match the expected schema.',
          errors: zodIssuesToProblemErrors(result.issues),
        });
      case 'reference':
        throw new AppError('VALIDATION_FAILED', {
          detail: 'The role config names tables or fields that do not exist in the base.',
          errors: result.issues,
        });
      case 'filter':
        throw new AppError('INVALID_FILTER', {
          detail: 'A record filter of the role is invalid.',
          errors: result.issues,
        });
    }
  }

  private async requirePrincipal(
    scope: OrgScope,
    type: AssignRoleRequest['principal_type'],
    id: AssignRoleRequest['principal_id'],
  ): Promise<void> {
    const exists =
      type === 'user'
        ? (await this.orgMembers.get(scope, id as Id<'usr'>)) !== undefined
        : (await this.groups.getById(scope, id as Id<'grp'>)) !== undefined;
    if (!exists) {
      throw validationFailed(
        type === 'user'
          ? 'The user is not a member of the organization.'
          : 'The group does not exist in the organization.',
        { path: 'principal_id', code: UNKNOWN_PRINCIPAL },
      );
    }
  }

  private async assignmentChanged(
    tx: Tx,
    base: BaseAccess,
    context: AuditContext,
    change: {
      principalType: AssignRoleRequest['principal_type'];
      principalId: AssignRoleRequest['principal_id'];
      from: Id<'rol'> | null;
      to: Id<'rol'> | null;
    },
  ): Promise<void> {
    await recordChange(tx, {
      type: 'role_assignment.changed',
      organizationId: base.org.organizationId,
      baseId: base.base.id,
      entityType: 'role_assignment',
      entityId: change.principalId,
      context,
      before: change.from === null ? null : { role_id: change.from },
      after: change.to === null ? null : { role_id: change.to },
      data: { principal_type: change.principalType, principal_id: change.principalId },
      changes: { role_id: { from: change.from, to: change.to } },
    });
  }

  /** Bumps `permission_version` and records `permission.changed` (CONTRACTS §8). */
  private async permissionChanged(
    tx: Tx,
    scope: OrgScope,
    base: BaseAccess,
    lockedVersion: number,
    context: AuditContext,
  ): Promise<void> {
    await this.bases.bumpPermissionVersion(scope, { baseIds: [base.base.id] });
    const version = lockedVersion + 1;
    await recordChange(tx, {
      type: 'permission.changed',
      organizationId: base.org.organizationId,
      baseId: base.base.id,
      entityType: 'base',
      entityId: base.base.id,
      context,
      before: { permission_version: lockedVersion },
      after: { permission_version: version },
      data: { permission_version: version },
    });
  }
}
