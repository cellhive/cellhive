import { ALREADY_MEMBER, UNKNOWN_PRINCIPAL } from '@cellhive/contracts';
import {
  BaseRoleMembersRepository,
  GroupMembersRepository,
  GroupsRepository,
  OrgMembersRepository,
  withTxScope,
  WorkspaceMembersRepository,
  type Db,
  type Group,
  type GroupMemberWithUser,
  type OrgScope,
} from '@cellhive/server-core';
import { AppError } from '@cellhive/server-core/errors';
import { Inject, Injectable } from '@nestjs/common';

import {
  AccessService,
  notFound,
  permissionDenied,
  type OrgAccess,
} from '../../common/access/access.service.js';
import {
  mutationContextOf,
  PermissionVersions,
  recordChange,
} from '../../common/access/change-log.js';
import { iso, offsetList, userSummaryOf, validationFailed } from '../../common/dto.js';
import { DB } from '../../common/tokens.js';

import type { Principal } from '../../common/auth/principal.js';
import type { RequestMeta } from '../../common/auth/request-meta.js';
import type {
  AddGroupMemberRequest,
  CreateGroupRequest,
  GroupDto,
  GroupList,
  GroupMemberDto,
  GroupMemberList,
  Id,
  OffsetQuery,
  UpdateGroupRequest,
} from '@cellhive/contracts';

function groupDtoOf(group: Group & { member_count: number }): GroupDto {
  return {
    id: group.id,
    organization_id: group.organization_id,
    name: group.name,
    member_count: group.member_count,
    created_at: iso(group.created_at),
    updated_at: iso(group.updated_at),
  };
}

function groupMemberDtoOf(member: GroupMemberWithUser): GroupMemberDto {
  return { user: userSummaryOf(member.user), added_at: iso(member.created_at) };
}

function nameConflict(): AppError {
  return new AppError('NAME_CONFLICT', {
    detail: 'A group with this name already exists in the organization.',
    errors: [{ path: 'name', code: 'NAME_CONFLICT', message: 'Name already used' }],
  });
}

/**
 * Groups and their members (SPEC §13.1). Every member of the organization
 * sees its groups; owners and admins manage them. Group changes bump the
 * permission version of the bases the group matters for.
 */
@Injectable()
export class GroupService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(GroupsRepository) private readonly groups: GroupsRepository,
    @Inject(GroupMembersRepository) private readonly groupMembers: GroupMembersRepository,
    @Inject(OrgMembersRepository) private readonly orgMembers: OrgMembersRepository,
    @Inject(WorkspaceMembersRepository)
    private readonly workspaceMembers: WorkspaceMembersRepository,
    @Inject(BaseRoleMembersRepository) private readonly roleMembers: BaseRoleMembersRepository,
    @Inject(PermissionVersions) private readonly permissionVersions: PermissionVersions,
    @Inject(AccessService) private readonly access: AccessService,
  ) {}

  async list(
    principal: Principal,
    organizationId: Id<'org'>,
    query: OffsetQuery,
  ): Promise<GroupList> {
    const org = await this.access.requireOrg(principal, organizationId);
    return offsetList(await this.groups.list(org.scope, query), query, groupDtoOf);
  }

  async get(
    principal: Principal,
    organizationId: Id<'org'>,
    groupId: Id<'grp'>,
  ): Promise<GroupDto> {
    const org = await this.access.requireOrg(principal, organizationId);
    const group = await this.groups.getById(org.scope, groupId);
    if (group === undefined) throw notFound();
    return groupDtoOf(group);
  }

  async create(
    principal: Principal,
    organizationId: Id<'org'>,
    input: CreateGroupRequest,
    meta: RequestMeta,
  ): Promise<GroupDto> {
    const org = await this.access.requireOrgAdmin(principal, organizationId);
    const group = await this.db.withTx(async (tx) => {
      const scope = withTxScope(org.scope, tx);
      if ((await this.groups.findByName(scope, input.name)) !== undefined) throw nameConflict();
      const created = await this.groups.create(scope, { name: input.name });
      await recordChange(tx, {
        type: 'group.created',
        organizationId,
        entityType: 'group',
        entityId: created.id,
        context: mutationContextOf(meta, principal.userId),
        after: { name: created.name },
        data: { name: created.name },
      });
      return created;
    });
    return groupDtoOf({ ...group, member_count: 0 });
  }

  async update(
    principal: Principal,
    organizationId: Id<'org'>,
    groupId: Id<'grp'>,
    input: UpdateGroupRequest,
    meta: RequestMeta,
  ): Promise<GroupDto> {
    const org = await this.access.requireOrg(principal, organizationId);
    const current = await this.groups.getById(org.scope, groupId);
    if (current === undefined) throw notFound();
    this.requireAdmin(org);
    if (current.name === input.name) return groupDtoOf(current);
    const renamed = await this.db.withTx(async (tx) => {
      const scope = withTxScope(org.scope, tx);
      if ((await this.groups.findByName(scope, input.name, groupId)) !== undefined) {
        throw nameConflict();
      }
      const row = await this.groups.rename(scope, groupId, input.name);
      if (row === undefined) throw notFound();
      await recordChange(tx, {
        type: 'group.updated',
        organizationId,
        entityType: 'group',
        entityId: groupId,
        context: mutationContextOf(meta, principal.userId),
        before: { name: current.name },
        after: { name: row.name },
        changes: { name: { from: current.name, to: row.name } },
      });
      return row;
    });
    return groupDtoOf({ ...renamed, member_count: current.member_count });
  }

  /** Deletes a group with its members, workspace memberships and base role assignments. */
  async delete(
    principal: Principal,
    organizationId: Id<'org'>,
    groupId: Id<'grp'>,
    meta: RequestMeta,
  ): Promise<void> {
    const org = await this.access.requireOrg(principal, organizationId);
    const current = await this.groups.getById(org.scope, groupId);
    if (current === undefined) throw notFound();
    this.requireAdmin(org);
    await this.db.withTx(async (tx) => {
      const scope = withTxScope(org.scope, tx);
      // Before the rows that tell which bases are affected disappear.
      await this.permissionVersions.bumpForGroup(scope, groupId);
      const workspaces = await this.workspaceMembers.removeAllForPrincipal(scope, 'group', groupId);
      const bases = await this.roleMembers.removeAllForPrincipal(scope, 'group', groupId);
      const deleted = await this.groups.delete(scope, groupId);
      if (deleted === undefined) throw notFound();
      await recordChange(tx, {
        type: 'group.deleted',
        organizationId,
        entityType: 'group',
        entityId: groupId,
        context: mutationContextOf(meta, principal.userId),
        before: {
          name: deleted.name,
          member_count: current.member_count,
          workspace_ids: workspaces.map((membership) => membership.workspace_id),
          base_ids: bases,
        },
        data: { name: deleted.name },
      });
    });
    this.access.invalidate(principal);
  }

  async listMembers(
    principal: Principal,
    groupId: Id<'grp'>,
    query: OffsetQuery,
  ): Promise<GroupMemberList> {
    const { org } = await this.requireGroup(principal, groupId);
    return offsetList(
      await this.groupMembers.list(org.scope, groupId, query),
      query,
      groupMemberDtoOf,
    );
  }

  async addMember(
    principal: Principal,
    groupId: Id<'grp'>,
    input: AddGroupMemberRequest,
    meta: RequestMeta,
  ): Promise<GroupMemberDto> {
    const { org } = await this.requireGroup(principal, groupId);
    this.requireAdmin(org);
    const member = await this.db.withTx(async (tx) => {
      const scope = withTxScope(org.scope, tx);
      await this.requireOrgMember(scope, input.user_id);
      const added = await this.groupMembers.add(scope, groupId, input.user_id);
      if (added === undefined) {
        throw validationFailed('The user already is a member of this group.', {
          path: 'user_id',
          code: ALREADY_MEMBER,
        });
      }
      await recordChange(tx, {
        type: 'group_member.added',
        organizationId: org.organizationId,
        entityType: 'group_member',
        entityId: groupId,
        context: mutationContextOf(meta, principal.userId),
        after: { group_id: groupId, user_id: input.user_id },
        data: { group_id: groupId, user_id: input.user_id },
      });
      await this.permissionVersions.bumpForGroup(scope, groupId);
      const row = await this.groupMembers.get(scope, groupId, input.user_id);
      if (row === undefined) throw notFound();
      return row;
    });
    this.access.invalidate(principal);
    return groupMemberDtoOf(member);
  }

  async removeMember(
    principal: Principal,
    groupId: Id<'grp'>,
    userId: Id<'usr'>,
    meta: RequestMeta,
  ): Promise<void> {
    const { org } = await this.requireGroup(principal, groupId);
    this.requireAdmin(org);
    await this.db.withTx(async (tx) => {
      const scope = withTxScope(org.scope, tx);
      if (!(await this.groupMembers.remove(scope, groupId, userId))) throw notFound();
      await recordChange(tx, {
        type: 'group_member.removed',
        organizationId: org.organizationId,
        entityType: 'group_member',
        entityId: groupId,
        context: mutationContextOf(meta, principal.userId),
        before: { group_id: groupId, user_id: userId },
        data: { group_id: groupId, user_id: userId },
      });
      await this.permissionVersions.bumpForGroup(scope, groupId);
    });
    this.access.invalidate(principal);
  }

  private async requireGroup(principal: Principal, groupId: Id<'grp'>) {
    const found = await this.access.findGroup(principal, groupId);
    if (found === undefined) throw notFound();
    return found;
  }

  private requireAdmin(org: OrgAccess): void {
    if (!org.isAdmin) {
      throw permissionDenied('Only organization owners and admins can manage groups.');
    }
  }

  private async requireOrgMember(scope: OrgScope, userId: Id<'usr'>): Promise<void> {
    if ((await this.orgMembers.get(scope, userId)) === undefined) {
      throw validationFailed('The user is not a member of this organization.', {
        path: 'user_id',
        code: UNKNOWN_PRINCIPAL,
      });
    }
  }
}
