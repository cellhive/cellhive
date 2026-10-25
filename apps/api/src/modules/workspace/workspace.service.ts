import { randomBytes } from 'node:crypto';

import { ALREADY_MEMBER, isId, UNKNOWN_PRINCIPAL, WORKSPACE_NOT_EMPTY } from '@cellhive/contracts';
import {
  GroupsRepository,
  OrgMembersRepository,
  withTxScope,
  WorkspaceMembersRepository,
  WorkspacesRepository,
  type Db,
  type OrgScope,
  type PrincipalType,
  type Workspace,
  type WorkspaceMemberWithName,
  type WorkspaceRole,
} from '@cellhive/server-core';
import { AppError } from '@cellhive/server-core/errors';
import { Inject, Injectable } from '@nestjs/common';

import { AccessService, notFound } from '../../common/access/access.service.js';
import {
  mutationContextOf,
  PermissionVersions,
  recordChange,
} from '../../common/access/change-log.js';
import { iso, offsetList, validationFailed } from '../../common/dto.js';
import { DB } from '../../common/tokens.js';
import { slugify } from '../setup/org-provisioning.js';

import type { Principal } from '../../common/auth/principal.js';
import type { RequestMeta } from '../../common/auth/request-meta.js';
import type {
  AddWorkspaceMemberRequest,
  CreateWorkspaceRequest,
  Id,
  OffsetQuery,
  PrincipalId,
  UpdateWorkspaceMemberRequest,
  UpdateWorkspaceRequest,
  WorkspaceDto,
  WorkspaceList,
  WorkspaceMemberDto,
  WorkspaceMemberList,
} from '@cellhive/contracts';

const SLUG_ATTEMPTS = 5;

export function workspaceDtoOf(workspace: Workspace, role: WorkspaceRole | null): WorkspaceDto {
  return {
    id: workspace.id,
    organization_id: workspace.organization_id,
    name: workspace.name,
    slug: workspace.slug,
    role,
    created_at: iso(workspace.created_at),
    updated_at: iso(workspace.updated_at),
  };
}

function memberDtoOf(member: WorkspaceMemberWithName): WorkspaceMemberDto {
  return {
    principal_type: member.principal_type,
    principal_id: member.principal_id,
    name: member.name,
    email: member.email,
    role: member.role,
    added_at: iso(member.created_at),
  };
}

function principalTypeOf(principalId: PrincipalId): PrincipalType {
  return isId('grp', principalId) ? 'group' : 'user';
}

/**
 * Workspaces and their members (SPEC §13.1, §14.1). Organization
 * owners/admins create and delete workspaces; workspace admins rename them
 * and manage their members. Changing a workspace admin bumps the permission
 * version of every base in the workspace.
 */
@Injectable()
export class WorkspaceService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(WorkspacesRepository) private readonly workspaces: WorkspacesRepository,
    @Inject(WorkspaceMembersRepository)
    private readonly workspaceMembers: WorkspaceMembersRepository,
    @Inject(OrgMembersRepository) private readonly orgMembers: OrgMembersRepository,
    @Inject(GroupsRepository) private readonly groups: GroupsRepository,
    @Inject(PermissionVersions) private readonly permissionVersions: PermissionVersions,
    @Inject(AccessService) private readonly access: AccessService,
  ) {}

  async list(
    principal: Principal,
    organizationId: Id<'org'>,
    query: OffsetQuery,
  ): Promise<WorkspaceList> {
    const org = await this.access.requireOrg(principal, organizationId);
    const onlyBaseIds = this.access.tokenBaseIds(principal);
    const page = await this.workspaces.list(
      org.scope,
      query,
      org.isAdmin
        ? undefined
        : { userId: principal.userId, groupIds: await this.access.groupIds(principal, org) },
      onlyBaseIds === null ? {} : { containingBaseIds: onlyBaseIds },
    );
    const roles = await this.access.workspaceRoles(principal, org);
    return offsetList(page, query, (workspace) =>
      workspaceDtoOf(workspace, roles.get(workspace.id) ?? null),
    );
  }

  async get(
    principal: Principal,
    organizationId: Id<'org'>,
    workspaceId: Id<'wsp'>,
  ): Promise<WorkspaceDto> {
    const access = await this.access.requireWorkspace(
      principal,
      workspaceId,
      'read',
      organizationId,
    );
    return workspaceDtoOf(access.workspace, access.role);
  }

  async create(
    principal: Principal,
    organizationId: Id<'org'>,
    input: CreateWorkspaceRequest,
    meta: RequestMeta,
  ): Promise<WorkspaceDto> {
    const org = await this.access.requireOrgAdmin(principal, organizationId);
    const workspace = await this.db.withTx(async (tx) => {
      const scope = withTxScope(org.scope, tx);
      const created = await this.workspaces.create(scope, {
        name: input.name,
        slug: await this.uniqueSlug(scope, input.name),
      });
      await recordChange(tx, {
        type: 'workspace.created',
        organizationId,
        entityType: 'workspace',
        entityId: created.id,
        context: mutationContextOf(meta, principal.userId),
        after: { name: created.name, slug: created.slug },
        data: { name: created.name },
      });
      return created;
    });
    return workspaceDtoOf(workspace, null);
  }

  async update(
    principal: Principal,
    organizationId: Id<'org'>,
    workspaceId: Id<'wsp'>,
    input: UpdateWorkspaceRequest,
    meta: RequestMeta,
  ): Promise<WorkspaceDto> {
    const access = await this.access.requireWorkspace(
      principal,
      workspaceId,
      'admin',
      organizationId,
    );
    const current = access.workspace;
    if (current.name === input.name) return workspaceDtoOf(current, access.role);
    const renamed = await this.db.withTx(async (tx) => {
      const row = await this.workspaces.rename(
        withTxScope(access.org.scope, tx),
        workspaceId,
        input.name,
      );
      if (row === undefined) throw notFound();
      await recordChange(tx, {
        type: 'workspace.updated',
        organizationId,
        entityType: 'workspace',
        entityId: workspaceId,
        context: mutationContextOf(meta, principal.userId),
        before: { name: current.name },
        after: { name: row.name },
        changes: { name: { from: current.name, to: row.name } },
      });
      return row;
    });
    return workspaceDtoOf(renamed, access.role);
  }

  /** Deletes a workspace without bases (also none in the trash). Organization owner/admin only. */
  async delete(
    principal: Principal,
    organizationId: Id<'org'>,
    workspaceId: Id<'wsp'>,
    meta: RequestMeta,
  ): Promise<void> {
    const access = await this.access.requireWorkspace(
      principal,
      workspaceId,
      'read',
      organizationId,
    );
    if (!access.org.isAdmin) {
      throw new AppError('PERMISSION_DENIED', {
        detail: 'Only organization owners and admins can delete workspaces.',
      });
    }
    await this.db.withTx(async (tx) => {
      const scope = withTxScope(access.org.scope, tx);
      if ((await this.workspaces.countBases(scope, workspaceId)) > 0) {
        throw validationFailed('Move or delete the bases of this workspace first.', {
          path: 'workspaceId',
          code: WORKSPACE_NOT_EMPTY,
        });
      }
      const deleted = await this.workspaces.delete(scope, workspaceId);
      if (deleted === undefined) throw notFound();
      await recordChange(tx, {
        type: 'workspace.deleted',
        organizationId,
        entityType: 'workspace',
        entityId: workspaceId,
        context: mutationContextOf(meta, principal.userId),
        before: { name: deleted.name, slug: deleted.slug },
        data: { name: deleted.name },
      });
    });
    this.access.invalidate(principal);
  }

  async listMembers(
    principal: Principal,
    workspaceId: Id<'wsp'>,
    query: OffsetQuery,
  ): Promise<WorkspaceMemberList> {
    const access = await this.access.requireWorkspace(principal, workspaceId, 'read');
    return offsetList(
      await this.workspaceMembers.list(access.org.scope, workspaceId, query),
      query,
      memberDtoOf,
    );
  }

  async addMember(
    principal: Principal,
    workspaceId: Id<'wsp'>,
    input: AddWorkspaceMemberRequest,
    meta: RequestMeta,
  ): Promise<WorkspaceMemberDto> {
    const access = await this.access.requireWorkspace(principal, workspaceId, 'admin');
    const principalType = principalTypeOf(input.principal_id);
    const member = await this.db.withTx(async (tx) => {
      const scope = withTxScope(access.org.scope, tx);
      await this.requirePrincipal(scope, principalType, input.principal_id);
      const added = await this.workspaceMembers.add(scope, {
        workspaceId,
        principalType,
        principalId: input.principal_id,
        role: input.role,
      });
      if (added === undefined) {
        throw validationFailed('Already a member of this workspace.', {
          path: 'principal_id',
          code: ALREADY_MEMBER,
        });
      }
      await recordChange(tx, {
        type: 'workspace_member.added',
        organizationId: access.org.organizationId,
        entityType: 'workspace_member',
        entityId: workspaceId,
        context: mutationContextOf(meta, principal.userId),
        after: {
          principal_type: principalType,
          principal_id: input.principal_id,
          role: input.role,
        },
        data: { principal_type: principalType, principal_id: input.principal_id, role: input.role },
      });
      if (input.role === 'admin') {
        await this.permissionVersions.bumpWorkspaces(scope, [workspaceId]);
      }
      return this.reload(scope, workspaceId, principalType, input.principal_id);
    });
    this.access.invalidate(principal);
    return memberDtoOf(member);
  }

  async updateMember(
    principal: Principal,
    workspaceId: Id<'wsp'>,
    principalId: PrincipalId,
    input: UpdateWorkspaceMemberRequest,
    meta: RequestMeta,
  ): Promise<WorkspaceMemberDto> {
    const access = await this.access.requireWorkspace(principal, workspaceId, 'admin');
    const principalType = principalTypeOf(principalId);
    const member = await this.db.withTx(async (tx) => {
      const scope = withTxScope(access.org.scope, tx);
      const current = await this.workspaceMembers.get(
        scope,
        workspaceId,
        principalType,
        principalId,
      );
      if (current === undefined) throw notFound();
      if (current.role === input.role) return current;
      await this.workspaceMembers.updateRole(
        scope,
        workspaceId,
        principalType,
        principalId,
        input.role,
      );
      await recordChange(tx, {
        type: 'workspace_member.role_changed',
        organizationId: access.org.organizationId,
        entityType: 'workspace_member',
        entityId: workspaceId,
        context: mutationContextOf(meta, principal.userId),
        before: { principal_type: principalType, principal_id: principalId, role: current.role },
        after: { principal_type: principalType, principal_id: principalId, role: input.role },
        data: { principal_type: principalType, principal_id: principalId },
        changes: { role: { from: current.role, to: input.role } },
      });
      // One side of the change is `admin`: access to every base of the workspace changes.
      await this.permissionVersions.bumpWorkspaces(scope, [workspaceId]);
      return this.reload(scope, workspaceId, principalType, principalId);
    });
    this.access.invalidate(principal);
    return memberDtoOf(member);
  }

  async removeMember(
    principal: Principal,
    workspaceId: Id<'wsp'>,
    principalId: PrincipalId,
    meta: RequestMeta,
  ): Promise<void> {
    const access = await this.access.requireWorkspace(principal, workspaceId, 'admin');
    const principalType = principalTypeOf(principalId);
    await this.db.withTx(async (tx) => {
      const scope = withTxScope(access.org.scope, tx);
      const removed = await this.workspaceMembers.remove(
        scope,
        workspaceId,
        principalType,
        principalId,
      );
      if (removed === undefined) throw notFound();
      await recordChange(tx, {
        type: 'workspace_member.removed',
        organizationId: access.org.organizationId,
        entityType: 'workspace_member',
        entityId: workspaceId,
        context: mutationContextOf(meta, principal.userId),
        before: { principal_type: principalType, principal_id: principalId, role: removed.role },
        data: { principal_type: principalType, principal_id: principalId },
      });
      if (removed.role === 'admin') {
        await this.permissionVersions.bumpWorkspaces(scope, [workspaceId]);
      }
    });
    this.access.invalidate(principal);
  }

  private async reload(
    scope: OrgScope,
    workspaceId: Id<'wsp'>,
    principalType: PrincipalType,
    principalId: PrincipalId,
  ): Promise<WorkspaceMemberWithName> {
    const row = await this.workspaceMembers.get(scope, workspaceId, principalType, principalId);
    if (row === undefined) throw notFound();
    return row;
  }

  /** The user must be a member of the organization; the group must belong to it. */
  private async requirePrincipal(
    scope: OrgScope,
    principalType: PrincipalType,
    principalId: PrincipalId,
  ): Promise<void> {
    const exists =
      principalType === 'user'
        ? (await this.orgMembers.get(scope, principalId as Id<'usr'>)) !== undefined
        : (await this.groups.getById(scope, principalId as Id<'grp'>)) !== undefined;
    if (!exists) {
      throw validationFailed('No such member or group in this organization.', {
        path: 'principal_id',
        code: UNKNOWN_PRINCIPAL,
      });
    }
  }

  /** A slug unique in the organization: the name's slug, else with a random suffix. */
  private async uniqueSlug(scope: OrgScope, name: string): Promise<string> {
    const base = slugify(name);
    if (!(await this.workspaces.slugExists(scope, base))) return base;
    for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt += 1) {
      const candidate = `${base}-${randomBytes(3).toString('hex')}`;
      if (!(await this.workspaces.slugExists(scope, candidate))) return candidate;
    }
    throw new AppError('INTERNAL', { params: { reason: 'no free workspace slug' } });
  }
}
