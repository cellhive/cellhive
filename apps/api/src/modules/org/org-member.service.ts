import {
  LAST_OWNER,
  OWNED_BASE_IDS_LIMIT,
  OWNS_BASES,
  UNKNOWN_PRINCIPAL,
} from '@cellhive/contracts';
import {
  ApiTokensRepository,
  BaseRoleMembersRepository,
  BasesRepository,
  InvitationsRepository,
  OrgMembersRepository,
  publishApiTokensRevoked,
  withTxScope,
  WorkspaceMembersRepository,
  type AuditContext,
  type Db,
  type OrgMemberWithUser,
  type OrgScope,
  type Tx,
} from '@cellhive/server-core';
import { Inject, Injectable } from '@nestjs/common';

import { AccessService, notFound, permissionDenied } from '../../common/access/access.service.js';
import {
  mutationContextOf,
  PermissionVersions,
  recordChange,
} from '../../common/access/change-log.js';
import { iso, offsetList, userSummaryOf, validationFailed } from '../../common/dto.js';
import { DB } from '../../common/tokens.js';
import { mayInvite } from '../invitation/invitation.service.js';

import type { Principal } from '../../common/auth/principal.js';
import type { RequestMeta } from '../../common/auth/request-meta.js';
import type {
  Id,
  OffsetQuery,
  OrgMemberDto,
  OrgMemberList,
  RemoveOrgMemberRequest,
  UpdateOrgMemberRequest,
} from '@cellhive/contracts';

export function orgMemberDtoOf(member: OrgMemberWithUser): OrgMemberDto {
  return { user: userSummaryOf(member.user), role: member.role, joined_at: iso(member.created_at) };
}

function lastOwner(path: string): Error {
  return validationFailed('An organization must keep at least one owner.', {
    path,
    code: LAST_OWNER,
  });
}

/**
 * `/orgs/:orgId/members[/:userId]` (SPEC §13.1). Owners and admins manage
 * members; only owners change or remove owners or make someone an owner;
 * the last owner can neither be demoted nor removed.
 */
@Injectable()
export class OrgMemberService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(OrgMembersRepository) private readonly orgMembers: OrgMembersRepository,
    @Inject(WorkspaceMembersRepository)
    private readonly workspaceMembers: WorkspaceMembersRepository,
    @Inject(BaseRoleMembersRepository) private readonly roleMembers: BaseRoleMembersRepository,
    @Inject(InvitationsRepository) private readonly invitations: InvitationsRepository,
    @Inject(BasesRepository) private readonly bases: BasesRepository,
    @Inject(PermissionVersions) private readonly permissionVersions: PermissionVersions,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(ApiTokensRepository) private readonly apiTokens: ApiTokensRepository,
  ) {}

  async list(
    principal: Principal,
    organizationId: Id<'org'>,
    query: OffsetQuery,
  ): Promise<OrgMemberList> {
    const org = await this.access.requireOrg(principal, organizationId);
    return offsetList(await this.orgMembers.listPage(org.scope, query), query, orgMemberDtoOf);
  }

  async get(
    principal: Principal,
    organizationId: Id<'org'>,
    userId: Id<'usr'>,
  ): Promise<OrgMemberDto> {
    const org = await this.access.requireOrg(principal, organizationId);
    const member = await this.orgMembers.getWithUser(org.scope, userId);
    if (member === undefined) throw notFound();
    return orgMemberDtoOf(member);
  }

  async update(
    principal: Principal,
    organizationId: Id<'org'>,
    userId: Id<'usr'>,
    input: UpdateOrgMemberRequest,
    meta: RequestMeta,
  ): Promise<OrgMemberDto> {
    const org = await this.access.requireOrgAdmin(principal, organizationId);
    const result = await this.db.withTx(async (tx) => {
      const scope = withTxScope(org.scope, tx);
      const target = await this.orgMembers.getWithUser(scope, userId);
      if (target === undefined) throw notFound();
      if ((target.role === 'owner' || input.role === 'owner') && org.role !== 'owner') {
        throw permissionDenied('Only owners can change an owner or make someone an owner.');
      }
      if (target.role === input.role) return target;
      if (target.role === 'owner') {
        const owners = await this.orgMembers.lockOwners(scope);
        if (owners.length <= 1) throw lastOwner('role');
      }
      const updated = await this.orgMembers.updateRole(scope, userId, input.role);
      if (updated === undefined) throw notFound();
      const context = mutationContextOf(meta, principal.userId);
      if (mayInvite(target.role) && !mayInvite(input.role)) {
        await this.revokeInvitationsOf(tx, scope, userId, 'inviter_demoted', context);
      }
      await recordChange(tx, {
        type: 'org_member.role_changed',
        organizationId,
        entityType: 'org_member',
        entityId: userId,
        context,
        before: { user_id: userId, role: target.role },
        after: { user_id: userId, role: input.role },
        data: { user_id: userId },
        changes: { role: { from: target.role, to: input.role } },
      });
      // Owner/admin means full access to every base (SPEC §14.1).
      await this.permissionVersions.bumpOrganization(scope);
      return { ...target, role: input.role, updated_at: updated.updated_at };
    });
    this.access.invalidate(principal);
    return orgMemberDtoOf(result);
  }

  /**
   * Removes a member, or lets a member leave. Also removes the user's
   * workspace memberships and base role assignments in this organization;
   * group memberships cascade. Bases the user owns (the trash included)
   * need a new owner: `transfer_bases_to`, an owner/admin of the
   * organization, else `422 OWNS_BASES`.
   */
  async remove(
    principal: Principal,
    organizationId: Id<'org'>,
    userId: Id<'usr'>,
    input: RemoveOrgMemberRequest,
    meta: RequestMeta,
  ): Promise<void> {
    const org = await this.access.requireOrg(principal, organizationId);
    const self = userId === principal.userId;
    if (!self && !org.isAdmin) {
      throw permissionDenied('Only organization owners and admins can remove members.');
    }
    await this.db.withTx(async (tx) => {
      const scope = withTxScope(org.scope, tx);
      const target = await this.orgMembers.get(scope, userId);
      if (target === undefined) throw notFound();
      if (target.role === 'owner') {
        if (!self && org.role !== 'owner') {
          throw permissionDenied('Only owners can remove an owner.');
        }
        const owners = await this.orgMembers.lockOwners(scope);
        if (owners.length <= 1) throw lastOwner('userId');
      }
      const context = mutationContextOf(meta, principal.userId);
      await this.transferBasesOf(tx, scope, userId, input.transfer_bases_to, context);
      await this.revokeInvitationsOf(tx, scope, userId, 'inviter_removed', context);
      const workspaces = await this.workspaceMembers.removeAllForPrincipal(scope, 'user', userId);
      const bases = await this.roleMembers.removeAllForPrincipal(scope, 'user', userId);
      // The member's API tokens go with the membership (CASCADE, T703).
      const tokenIds = await this.apiTokens.idsOfUser(scope, userId);
      await this.orgMembers.remove(scope, userId);
      await publishApiTokensRevoked(this.db, tx, organizationId, tokenIds);
      await recordChange(tx, {
        type: 'org_member.removed',
        organizationId,
        entityType: 'org_member',
        entityId: userId,
        context,
        before: {
          user_id: userId,
          role: target.role,
          workspace_ids: workspaces.map((membership) => membership.workspace_id),
          base_ids: bases,
        },
        data: { user_id: userId, role: target.role, left: self },
      });
      await this.permissionVersions.bumpOrganization(scope);
    });
    this.access.invalidate(principal);
  }

  /**
   * Moves the bases `userId` owns to `newOwnerId` (who must be an owner or
   * admin of the organization, locked `FOR SHARE`), with a `base.updated`
   * event and audit entry per base; `422 OWNS_BASES` when the user owns
   * bases and no new owner was given.
   */
  private async transferBasesOf(
    tx: Tx,
    scope: OrgScope,
    userId: Id<'usr'>,
    newOwnerId: Id<'usr'> | undefined,
    context: AuditContext,
  ): Promise<void> {
    if (newOwnerId !== undefined) {
      const role =
        newOwnerId === userId ? undefined : await this.orgMembers.lockRole(scope, newOwnerId);
      if (role !== 'owner' && role !== 'admin') {
        throw validationFailed(
          'The new owner of the bases must be another owner or admin of the organization.',
          { path: 'transfer_bases_to', code: UNKNOWN_PRINCIPAL },
        );
      }
    }
    const owned = await this.bases.lockIdsOwnedBy(scope, userId);
    if (owned.length === 0) return;
    if (newOwnerId === undefined) {
      throw validationFailed(
        'This member owns bases: give them a new owner with transfer_bases_to.',
        {
          path: 'transfer_bases_to',
          code: OWNS_BASES,
          params: { base_ids: owned.slice(0, OWNED_BASE_IDS_LIMIT), total: owned.length },
        },
      );
    }
    for (const base of await this.bases.transferOwnership(scope, userId, newOwnerId)) {
      await recordChange(tx, {
        type: 'base.updated',
        organizationId: scope.organizationId,
        baseId: base.id,
        entityType: 'base',
        entityId: base.id,
        context,
        before: { owner_id: userId },
        after: { owner_id: newOwnerId },
        changes: { owner_id: { from: userId, to: newOwnerId } },
      });
    }
  }

  /**
   * Revokes every pending invitation `userId` created, in the transaction
   * that removes the member or takes away their right to invite: an
   * invitation must not outlive its inviter's authority. All of them, not
   * only `admin` ones: a plain member may not invite anyone.
   */
  private async revokeInvitationsOf(
    tx: Tx,
    scope: OrgScope,
    userId: Id<'usr'>,
    reason: 'inviter_removed' | 'inviter_demoted',
    context: AuditContext,
  ): Promise<void> {
    for (const revoked of await this.invitations.revokePendingByInviter(scope, userId)) {
      await recordChange(tx, {
        type: 'invitation.revoked',
        organizationId: scope.organizationId,
        entityType: 'invitation',
        entityId: revoked.id,
        context,
        before: { email: revoked.email, role: revoked.org_role },
        after: { reason },
        data: { reason },
      });
    }
  }
}
