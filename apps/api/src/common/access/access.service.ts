import {
  resolveBaseAccess,
  roleConfigSchema,
  type BaseRoleDef,
  type EffectiveAccess,
  type ResolveBaseAccessInput,
  type ResolvedBaseAccess,
  type RoleAssignment,
  type SchemaMeta,
} from '@cellhive/permissions';
import {
  BaseRoleMembersRepository,
  BaseRolesRepository,
  BasesRepository,
  GroupMembersRepository,
  GroupsRepository,
  OrganizationsRepository,
  OrgMembersRepository,
  orgScope,
  UsersRepository,
  WorkspaceMembersRepository,
  WorkspacesRepository,
  type Base,
  type GroupWithCount,
  type OrgMemberWithUser,
  type OrgRole,
  type OrgScope,
  type UserMembership,
  type Workspace,
  type WorkspaceRole,
} from '@cellhive/server-core';
import { AppError } from '@cellhive/server-core/errors';
import { Inject, Injectable } from '@nestjs/common';

import { AppLogger } from '../logging/app-logger.js';

import { BASE_SCHEMA_META, type BaseSchemaMetaLoader } from './base-schema-meta.js';

import type { Principal } from '../auth/principal.js';
import type { Id } from '@cellhive/contracts';

/** Levels of `@RequireBase` (SPEC §14.1). */
export type BaseAccessLevel = 'read' | 'edit' | 'admin';

/** An organization the caller belongs to. */
export interface OrgAccess {
  readonly scope: OrgScope;
  readonly organizationId: Id<'org'>;
  readonly role: OrgRole;
  readonly membership: UserMembership;
  /** Owner or admin: full access to the organization (SPEC §14.1). */
  readonly isAdmin: boolean;
}

/** A workspace and the caller's standing in it. */
export interface WorkspaceAccess {
  readonly org: OrgAccess;
  readonly workspace: Workspace;
  /** Role in the workspace, directly or through a group. */
  readonly role: WorkspaceRole | null;
  /** Organization owner/admin or workspace admin. */
  readonly isAdmin: boolean;
}

/** A base and the caller's effective access to it. */
export interface BaseAccess {
  readonly org: OrgAccess;
  readonly base: Base;
  readonly workspaceRole: WorkspaceRole | null;
  readonly groupIds: readonly Id<'grp'>[];
  readonly resolved: ResolvedBaseAccess;
  readonly access: EffectiveAccess;
}

/** A member's access to a base, with what it was resolved from. */
export interface MemberBaseAccess {
  /** What `resolveBaseAccess` was given. */
  readonly input: ResolveBaseAccessInput;
  /** `undefined` when the member cannot open the base. */
  readonly access: BaseAccess | undefined;
}

export function notFound(): AppError {
  return new AppError('NOT_FOUND');
}

export function permissionDenied(detail: string): AppError {
  return new AppError('PERMISSION_DENIED', { detail });
}

/** Whether an effective access reaches `level`. */
export function accessAllows(access: EffectiveAccess, level: BaseAccessLevel): boolean {
  switch (level) {
    case 'read':
      return true;
    case 'admin':
      return access.is_admin;
    case 'edit':
      return (
        access.is_admin ||
        Object.values(access.tables).some(
          (table) => table.perm === 'edit' || table.perm === 'manage',
        )
      );
  }
}

type Cache = Map<string, Promise<unknown>>;

/**
 * Loads memberships and resolves what the caller may do (SPEC §14.1). Every
 * lookup starts from the caller's own organizations, so a resource of an
 * organization the caller does not belong to is simply not found (`404`,
 * never `403`).
 *
 * Results are cached per request: the cache hangs off the `Principal`,
 * which `AuthGuard` creates for each request. Pass `fresh` after changing
 * memberships in the same request.
 */
@Injectable()
export class AccessService {
  private readonly caches = new WeakMap<Principal, Cache>();

  constructor(
    @Inject(OrganizationsRepository) private readonly organizations: OrganizationsRepository,
    @Inject(OrgMembersRepository) private readonly orgMembers: OrgMembersRepository,
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(GroupsRepository) private readonly groups: GroupsRepository,
    @Inject(GroupMembersRepository) private readonly groupMembers: GroupMembersRepository,
    @Inject(WorkspacesRepository) private readonly workspaces: WorkspacesRepository,
    @Inject(WorkspaceMembersRepository)
    private readonly workspaceMembers: WorkspaceMembersRepository,
    @Inject(BasesRepository) private readonly bases: BasesRepository,
    @Inject(BaseRolesRepository) private readonly baseRoles: BaseRolesRepository,
    @Inject(BaseRoleMembersRepository) private readonly baseRoleMembers: BaseRoleMembersRepository,
    @Inject(BASE_SCHEMA_META) private readonly schemaMeta: BaseSchemaMetaLoader,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  private cached<T>(principal: Principal, key: string, load: () => Promise<T>): Promise<T> {
    let cache = this.caches.get(principal);
    if (cache === undefined) {
      cache = new Map();
      this.caches.set(principal, cache);
    }
    const hit = cache.get(key) as Promise<T> | undefined;
    if (hit !== undefined) return hit;
    const promise = load();
    cache.set(key, promise);
    // A failed lookup is not cached.
    promise.catch(() => cache.delete(key));
    return promise;
  }

  /** Forgets everything cached for this request (after a membership change). */
  invalidate(principal: Principal): void {
    this.caches.delete(principal);
  }

  /**
   * The caller's organizations, oldest membership first. An API token only
   * ever reaches its own organization (ADR-36 §1): any other one is simply
   * not found (`404`).
   */
  memberships(principal: Principal): Promise<UserMembership[]> {
    return this.cached(principal, 'memberships', async () => {
      const memberships = await this.organizations.listMembershipsOfUser(principal.userId);
      return principal.kind === 'api_token'
        ? memberships.filter((item) => item.organizationId === principal.organizationId)
        : memberships;
    });
  }

  /**
   * The bases an API token is limited to (`base_ids`), or `null` when the
   * caller may reach every base its user can open (sessions, tokens without
   * a base list). Listings of bases and workspaces apply it; `findBase`
   * already does.
   */
  tokenBaseIds(principal: Principal): readonly Id<'bse'>[] | null {
    return principal.kind === 'api_token' ? principal.baseIds : null;
  }

  /** Whether the API token's base list (if any) lets the caller reach `baseId`. */
  private tokenReachesBase(principal: Principal, baseId: Id<'bse'>): boolean {
    const allowed = this.tokenBaseIds(principal);
    return allowed === null || allowed.includes(baseId);
  }

  /** The caller's membership of `organizationId`, or `undefined`. */
  async findOrg(principal: Principal, organizationId: Id<'org'>): Promise<OrgAccess | undefined> {
    const membership = (await this.memberships(principal)).find(
      (item) => item.organizationId === organizationId,
    );
    if (membership === undefined) return undefined;
    return {
      scope: orgScope(organizationId),
      organizationId,
      role: membership.role,
      membership,
      isAdmin: membership.role === 'owner' || membership.role === 'admin',
    };
  }

  /** Member of the organization, else `404`. */
  async requireOrg(principal: Principal, organizationId: Id<'org'>): Promise<OrgAccess> {
    const org = await this.findOrg(principal, organizationId);
    if (org === undefined) throw notFound();
    return org;
  }

  /** Owner/admin of the organization; non-members get `404`, members `403`. */
  async requireOrgAdmin(principal: Principal, organizationId: Id<'org'>): Promise<OrgAccess> {
    const org = await this.requireOrg(principal, organizationId);
    if (!org.isAdmin) {
      throw permissionDenied('Only organization owners and admins can do this.');
    }
    return org;
  }

  /** Groups of the organization the caller belongs to. */
  groupIds(principal: Principal, org: OrgAccess): Promise<Id<'grp'>[]> {
    return this.cached(principal, `groups:${org.organizationId}`, () =>
      this.groupMembers.groupIdsOfUser(org.scope, principal.userId),
    );
  }

  /** The caller's workspace roles in the organization (directly or through groups). */
  workspaceRoles(principal: Principal, org: OrgAccess): Promise<Map<Id<'wsp'>, WorkspaceRole>> {
    return this.cached(principal, `workspaceRoles:${org.organizationId}`, async () =>
      this.workspaceMembers.rolesOf(org.scope, {
        userId: principal.userId,
        groupIds: await this.groupIds(principal, org),
      }),
    );
  }

  /** A group of one of the caller's organizations (any member sees the groups). */
  async findGroup(
    principal: Principal,
    groupId: Id<'grp'>,
  ): Promise<{ org: OrgAccess; group: GroupWithCount } | undefined> {
    for (const membership of await this.memberships(principal)) {
      const org = await this.findOrg(principal, membership.organizationId);
      if (org === undefined) continue;
      const group = await this.groups.getById(org.scope, groupId);
      if (group !== undefined) return { org, group };
    }
    return undefined;
  }

  /**
   * A workspace of one of the caller's organizations that the caller can
   * see: organization owner/admin, member of the workspace (directly or
   * through a group), or able to open one of its bases. Else `undefined`.
   */
  async findWorkspace(
    principal: Principal,
    workspaceId: Id<'wsp'>,
    organizationId?: Id<'org'>,
  ): Promise<WorkspaceAccess | undefined> {
    const memberships = (await this.memberships(principal)).filter(
      (item) => organizationId === undefined || item.organizationId === organizationId,
    );
    for (const membership of memberships) {
      const org = await this.findOrg(principal, membership.organizationId);
      if (org === undefined) continue;
      const workspace = await this.workspaces.getById(org.scope, workspaceId);
      if (workspace === undefined) continue;
      const role = (await this.workspaceRoles(principal, org)).get(workspaceId) ?? null;
      const access: WorkspaceAccess = {
        org,
        workspace,
        role,
        isAdmin: org.isAdmin || role === 'admin',
      };
      const onlyIds = this.tokenBaseIds(principal);
      if (onlyIds === null && (org.isAdmin || role !== null)) return access;
      // Otherwise the workspace is visible through a base the caller can open
      // (and, for an API token limited to bases, one of those bases).
      const visibleBases = await this.bases.listPage(
        org.scope,
        workspaceId,
        { offset: 0, limit: 1 },
        org.isAdmin || role !== null
          ? undefined
          : { userId: principal.userId, groupIds: await this.groupIds(principal, org) },
        onlyIds === null ? {} : { onlyIds },
      );
      return visibleBases.total > 0 ? access : undefined;
    }
    return undefined;
  }

  /** A visible workspace (else `404`); with `admin`, also workspace/org admin (else `403`). */
  async requireWorkspace(
    principal: Principal,
    workspaceId: Id<'wsp'>,
    level: 'read' | 'admin',
    organizationId?: Id<'org'>,
  ): Promise<WorkspaceAccess> {
    const access = await this.findWorkspace(principal, workspaceId, organizationId);
    if (access === undefined) throw notFound();
    if (level === 'admin' && !access.isAdmin) {
      throw permissionDenied('Only workspace admins and organization owners/admins can do this.');
    }
    return access;
  }

  /**
   * The caller's effective access to a base outside the trash (SPEC §14.1),
   * or `undefined` when the base does not exist in the caller's
   * organizations, the caller has no access to it, or it is outside the API
   * token's `base_ids`. A token's access is its user's current access
   * (resolved like a session); its scopes are `ScopeGuard`'s check.
   */
  findBase(
    principal: Principal,
    baseId: Id<'bse'>,
    options: { fresh?: boolean } = {},
  ): Promise<BaseAccess | undefined> {
    const key = `base:${baseId}`;
    if (options.fresh === true) this.caches.get(principal)?.delete(key);
    return this.cached(principal, key, () => this.loadBase(principal, baseId));
  }

  /** `404` when the base is not readable; `403` when readable but below `level`. */
  async requireBase(
    principal: Principal,
    baseId: Id<'bse'>,
    level: BaseAccessLevel,
  ): Promise<BaseAccess> {
    const access = await this.findBase(principal, baseId);
    if (access === undefined) throw notFound();
    if (!accessAllows(access.access, level)) {
      throw permissionDenied(`This action needs ${level} access to the base.`);
    }
    return access;
  }

  /**
   * The current access of any member of `organizationId` to one of its bases
   * (outside the trash), resolved exactly like a request of that user —
   * without caching, and reading only that organization. `undefined` when
   * the user is not an active member or has no access to the base.
   *
   * For principals acting on behalf of a user who is not the caller: share
   * links (the creator's current access, SPEC §15A.2).
   */
  async findBaseForUser(
    organizationId: Id<'org'>,
    userId: Id<'usr'>,
    baseId: Id<'bse'>,
  ): Promise<BaseAccess | undefined> {
    return (await this.resolveForMember(organizationId, userId, baseId))?.access;
  }

  /**
   * What {@link findBaseForUser} resolves, with the input it gave
   * `resolveBaseAccess` (to explain where the access comes from, BACKLOG
   * T711). `undefined` when the user is not an active member of the
   * organization or the base is not one of its bases outside the trash;
   * `access` is `undefined` when the member has no access to the base.
   */
  async resolveForMember(
    organizationId: Id<'org'>,
    userId: Id<'usr'>,
    baseId: Id<'bse'>,
  ): Promise<MemberBaseAccess | undefined> {
    const scope = orgScope(organizationId);
    const [user, organization, member] = await Promise.all([
      this.users.findById(userId),
      this.organizations.findById(organizationId),
      this.orgMembers.get(scope, userId),
    ]);
    if (user?.status !== 'active' || organization === undefined || member === undefined) {
      return undefined;
    }
    const org: OrgAccess = {
      scope,
      organizationId,
      role: member.role,
      membership: {
        organizationId,
        name: organization.name,
        slug: organization.slug,
        settings: organization.settings,
        role: member.role,
        joinedAt: member.created_at,
        createdAt: organization.created_at,
        updatedAt: organization.updated_at,
      },
      isAdmin: member.role === 'owner' || member.role === 'admin',
    };
    const groupIds = await this.groupMembers.groupIdsOfUser(scope, userId);
    const workspaceRoles = await this.workspaceMembers.rolesOf(scope, { userId, groupIds });
    const base = await this.bases.getById(scope, baseId);
    if (base === undefined) return undefined;
    return this.resolveIn(org, userId, groupIds, workspaceRoles, base);
  }

  private async loadBase(principal: Principal, baseId: Id<'bse'>): Promise<BaseAccess | undefined> {
    // A base outside the API token's `base_ids` does not exist for it (ADR-36 §1).
    if (!this.tokenReachesBase(principal, baseId)) return undefined;
    for (const membership of await this.memberships(principal)) {
      const org = await this.findOrg(principal, membership.organizationId);
      if (org === undefined) continue;
      const base = await this.bases.getById(org.scope, baseId);
      if (base === undefined) continue;
      const resolved = await this.resolveIn(
        org,
        principal.userId,
        await this.groupIds(principal, org),
        await this.workspaceRoles(principal, org),
        base,
      );
      return resolved.access;
    }
    return undefined;
  }

  /** Resolves `userId`'s access to a base of `org` (SPEC §14.1). */
  private async resolveIn(
    org: OrgAccess,
    userId: Id<'usr'>,
    groupIds: readonly Id<'grp'>[],
    workspaceRoles: ReadonlyMap<Id<'wsp'>, WorkspaceRole>,
    base: Base,
  ): Promise<MemberBaseAccess> {
    const workspaceRole = workspaceRoles.get(base.workspace_id) ?? null;
    const { roles, assignments, schema } = await this.baseRules(org.scope, base.id);
    const input: ResolveBaseAccessInput = {
      principal: {
        userId,
        groupIds,
        orgRole: org.role,
        workspaceRole,
        isBaseOwner: base.owner_id === userId,
      },
      roles,
      assignments,
      schema,
    };
    const resolved = resolveBaseAccess(input);
    return {
      input,
      access:
        resolved === null
          ? undefined
          : { org, base, workspaceRole, groupIds, resolved, access: resolved.access },
    };
  }

  /** Roles, role assignments and schema of a base: what resolving anyone's access needs. */
  private async baseRules(
    scope: OrgScope,
    baseId: Id<'bse'>,
  ): Promise<{ roles: BaseRoleDef[]; assignments: RoleAssignment[]; schema: SchemaMeta }> {
    const [roleRows, assignmentRows, schema] = await Promise.all([
      this.baseRoles.listByBase(scope, baseId),
      this.baseRoleMembers.listByBase(scope, baseId),
      this.schemaMeta.load(scope, baseId),
    ]);
    const roles: BaseRoleDef[] = [];
    for (const row of roleRows) {
      const config = roleConfigSchema.safeParse(row.config);
      if (!config.success) {
        // Deny by default: a role whose config cannot be read grants nothing.
        this.logger.error({ role_id: row.id, base_id: baseId }, 'invalid base role config');
        continue;
      }
      roles.push({ id: row.id, kind: row.kind, name: row.name, config: config.data });
    }
    const assignments = assignmentRows.map(
      (row) =>
        ({
          roleId: row.role_id,
          principalType: row.principal_type,
          principalId: row.principal_id,
        }) as RoleAssignment,
    );
    return { roles, assignments, schema };
  }

  /**
   * Active members of the base's organization who can open the base, each
   * resolved exactly like a request of theirs (SPEC §14.1), oldest member
   * first. The base's roles, assignments and schema are read once.
   */
  async membersWithAccess(access: BaseAccess): Promise<OrgMemberWithUser[]> {
    const scope = access.org.scope;
    const base = access.base;
    const [members, rules] = await Promise.all([
      this.orgMembers.list(scope),
      this.baseRules(scope, base.id),
    ]);
    const withUser = new Map(
      (
        await this.orgMembers.listWithUserByIds(
          scope,
          members.map((member) => member.user_id),
        )
      ).map((member) => [member.user_id, member]),
    );
    const allowed = await Promise.all(
      members.map(async (member) => {
        const [user, groupIds] = await Promise.all([
          this.users.findById(member.user_id),
          this.groupMembers.groupIdsOfUser(scope, member.user_id),
        ]);
        if (user?.status !== 'active') return false;
        const workspaceRoles = await this.workspaceMembers.rolesOf(
          scope,
          { userId: member.user_id, groupIds },
          [base.workspace_id],
        );
        const resolved = resolveBaseAccess({
          principal: {
            userId: member.user_id,
            groupIds,
            orgRole: member.role,
            workspaceRole: workspaceRoles.get(base.workspace_id) ?? null,
            isBaseOwner: base.owner_id === member.user_id,
          },
          ...rules,
        });
        return resolved !== null;
      }),
    );
    return members.flatMap((member, index) => {
      const found = withUser.get(member.user_id);
      return allowed[index] === true && found !== undefined ? [found] : [];
    });
  }
}
