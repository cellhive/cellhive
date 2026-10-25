import { z } from 'zod';

import { idOf } from '../../ids.js';
import {
  acceptInvitationRequestSchema,
  acceptInvitationResponseSchema,
  addGroupMemberRequestSchema,
  addWorkspaceMemberRequestSchema,
  baseDetailSchema,
  baseListQuerySchema,
  baseListSchema,
  createBaseRequestSchema,
  createdInvitationSchema,
  createGroupRequestSchema,
  createInvitationRequestSchema,
  createOrganizationRequestSchema,
  createWorkspaceRequestSchema,
  groupListSchema,
  groupMemberListSchema,
  baseMemberListSchema,
  groupMemberSchema,
  groupSchema,
  invitationListQuerySchema,
  invitationListSchema,
  invitationPreviewSchema,
  invitationSchema,
  organizationListSchema,
  organizationSchema,
  orgMemberListSchema,
  orgMemberSchema,
  principalIdSchema,
  removeOrgMemberRequestSchema,
  updateBaseRequestSchema,
  updateGroupRequestSchema,
  updateOrganizationRequestSchema,
  updateOrgMemberRequestSchema,
  updateWorkspaceMemberRequestSchema,
  updateWorkspaceRequestSchema,
  workspaceListSchema,
  workspaceMemberListSchema,
  workspaceMemberSchema,
  workspaceSchema,
} from '../../orgs.js';
import { offsetQuerySchema } from '../../pagination.js';
import { problemResponse, type RouteRegistrar } from '../types.js';

import { register, type RouteSpec } from './route-spec.js';

const orgParams = z.object({ orgId: idOf('org') });
const orgUserParams = z.object({ orgId: idOf('org'), userId: idOf('usr') });
const orgGroupParams = z.object({ orgId: idOf('org'), groupId: idOf('grp') });
const groupParams = z.object({ groupId: idOf('grp') });
const groupUserParams = z.object({ groupId: idOf('grp'), userId: idOf('usr') });
const orgWorkspaceParams = z.object({ orgId: idOf('org'), workspaceId: idOf('wsp') });
const workspaceParams = z.object({ workspaceId: idOf('wsp') });
const workspacePrincipalParams = z.object({
  workspaceId: idOf('wsp'),
  principalId: principalIdSchema,
});
const baseParams = z.object({ baseId: idOf('bse') });
const orgInvitationParams = z.object({ orgId: idOf('org'), invitationId: idOf('inv') });
const tokenParams = z.object({
  token: z.string().meta({ description: 'Token from the invitation link' }),
});

/**
 * Organizations, members, groups, workspaces, bases and invitations
 * (SPEC §13.1, §14.1; CONTRACTS §5A).
 */
export const registerOrgRoutes: RouteRegistrar = (registry, components) => {
  const problem = (description: string) => problemResponse(components, description);
  const add = (spec: RouteSpec) => {
    register(registry, problem, spec);
  };

  // --- Organizations ---
  add({
    method: 'get',
    path: '/api/v1/orgs',
    operationId: 'listOrganizations',
    tag: 'orgs',
    summary: 'Organizations of the signed-in user',
    query: offsetQuerySchema,
    status: 200,
    response: organizationListSchema,
  });
  add({
    method: 'post',
    path: '/api/v1/orgs',
    operationId: 'createOrganization',
    tag: 'orgs',
    summary: 'Create an organization',
    description:
      'Only when the server runs with `ALLOW_ORG_CREATION=true` (otherwise ' +
      '`403 PERMISSION_DENIED`; use the CLI). The caller becomes its owner.',
    body: createOrganizationRequestSchema,
    status: 201,
    response: organizationSchema,
  });
  add({
    method: 'get',
    path: '/api/v1/orgs/{orgId}',
    operationId: 'getOrganization',
    tag: 'orgs',
    summary: 'An organization the caller belongs to',
    params: orgParams,
    status: 200,
    response: organizationSchema,
  });
  add({
    method: 'patch',
    path: '/api/v1/orgs/{orgId}',
    operationId: 'updateOrganization',
    tag: 'orgs',
    summary: 'Rename an organization or change its defaults',
    description:
      'Organization owner/admin only. `settings.api_tokens` (CONTRACTS §26.4): `enabled: false` ' +
      'stops token creation and makes every token of the organization stop authenticating; ' +
      '`max_lifetime_days` applies to new tokens only.',
    params: orgParams,
    body: updateOrganizationRequestSchema,
    status: 200,
    response: organizationSchema,
  });

  // --- Organization members ---
  add({
    method: 'get',
    path: '/api/v1/orgs/{orgId}/members',
    operationId: 'listOrgMembers',
    tag: 'org-members',
    summary: 'Members of an organization',
    params: orgParams,
    query: offsetQuerySchema,
    status: 200,
    response: orgMemberListSchema,
  });
  add({
    method: 'get',
    path: '/api/v1/orgs/{orgId}/members/{userId}',
    operationId: 'getOrgMember',
    tag: 'org-members',
    summary: 'A member of an organization',
    params: orgUserParams,
    status: 200,
    response: orgMemberSchema,
  });
  add({
    method: 'patch',
    path: '/api/v1/orgs/{orgId}/members/{userId}',
    operationId: 'updateOrgMember',
    tag: 'org-members',
    summary: "Change a member's organization role",
    description:
      'Owner/admin only. Only owners can change an owner or make someone an owner. The last ' +
      'owner cannot be demoted (`422 VALIDATION_FAILED`, `errors[].code = LAST_OWNER`). ' +
      'Demoting an owner/admin to member revokes the pending invitations they created.',
    params: orgUserParams,
    body: updateOrgMemberRequestSchema,
    status: 200,
    response: orgMemberSchema,
  });
  add({
    method: 'delete',
    path: '/api/v1/orgs/{orgId}/members/{userId}',
    operationId: 'removeOrgMember',
    tag: 'org-members',
    summary: 'Remove a member (or leave the organization)',
    description:
      'Owner/admin, or the member themselves. Only owners can remove an owner; the last owner ' +
      'cannot be removed (`422`, `LAST_OWNER`). Also removes the group, workspace and base ' +
      'role memberships of the user in this organization, and revokes the pending invitations ' +
      'they created. A member who owns bases (also in the trash) is removed only with ' +
      '`transfer_bases_to`, an owner/admin of the organization who becomes their owner in the ' +
      'same transaction; otherwise `422 VALIDATION_FAILED` with `errors[].code = OWNS_BASES` ' +
      'and `errors[].params = { base_ids (at most 50), total }`. An invalid ' +
      '`transfer_bases_to` is `422` with `UNKNOWN_PRINCIPAL`.',
    params: orgUserParams,
    body: removeOrgMemberRequestSchema,
    bodyOptional: true,
    status: 204,
  });

  // --- Groups ---
  add({
    method: 'get',
    path: '/api/v1/orgs/{orgId}/groups',
    operationId: 'listGroups',
    tag: 'groups',
    summary: 'Groups of an organization',
    params: orgParams,
    query: offsetQuerySchema,
    status: 200,
    response: groupListSchema,
  });
  add({
    method: 'post',
    path: '/api/v1/orgs/{orgId}/groups',
    operationId: 'createGroup',
    tag: 'groups',
    summary: 'Create a group',
    description: 'Organization owner/admin only. Names are unique in the organization.',
    params: orgParams,
    body: createGroupRequestSchema,
    status: 201,
    response: groupSchema,
    errors: { 409: '`NAME_CONFLICT`' },
  });
  add({
    method: 'get',
    path: '/api/v1/orgs/{orgId}/groups/{groupId}',
    operationId: 'getGroup',
    tag: 'groups',
    summary: 'A group',
    params: orgGroupParams,
    status: 200,
    response: groupSchema,
  });
  add({
    method: 'patch',
    path: '/api/v1/orgs/{orgId}/groups/{groupId}',
    operationId: 'updateGroup',
    tag: 'groups',
    summary: 'Rename a group',
    description: 'Organization owner/admin only.',
    params: orgGroupParams,
    body: updateGroupRequestSchema,
    status: 200,
    response: groupSchema,
    errors: { 409: '`NAME_CONFLICT`' },
  });
  add({
    method: 'delete',
    path: '/api/v1/orgs/{orgId}/groups/{groupId}',
    operationId: 'deleteGroup',
    tag: 'groups',
    summary: 'Delete a group',
    description:
      'Organization owner/admin only. Also removes its workspace memberships and base role ' +
      'assignments.',
    params: orgGroupParams,
    status: 204,
  });
  add({
    method: 'get',
    path: '/api/v1/groups/{groupId}/members',
    operationId: 'listGroupMembers',
    tag: 'groups',
    summary: 'Members of a group',
    params: groupParams,
    query: offsetQuerySchema,
    status: 200,
    response: groupMemberListSchema,
  });
  add({
    method: 'post',
    path: '/api/v1/groups/{groupId}/members',
    operationId: 'addGroupMember',
    tag: 'groups',
    summary: 'Add a member of the organization to a group',
    description: 'Organization owner/admin only.',
    params: groupParams,
    body: addGroupMemberRequestSchema,
    status: 201,
    response: groupMemberSchema,
  });
  add({
    method: 'delete',
    path: '/api/v1/groups/{groupId}/members/{userId}',
    operationId: 'removeGroupMember',
    tag: 'groups',
    summary: 'Remove a user from a group',
    description: 'Organization owner/admin only.',
    params: groupUserParams,
    status: 204,
  });

  // --- Workspaces ---
  add({
    method: 'get',
    path: '/api/v1/orgs/{orgId}/workspaces',
    operationId: 'listWorkspaces',
    tag: 'workspaces',
    summary: 'Workspaces visible to the caller',
    description:
      'Organization owners/admins see every workspace; others see workspaces they are a ' +
      'member of (directly or through a group) or that contain a base they can open.',
    params: orgParams,
    query: offsetQuerySchema,
    status: 200,
    response: workspaceListSchema,
  });
  add({
    method: 'post',
    path: '/api/v1/orgs/{orgId}/workspaces',
    operationId: 'createWorkspace',
    tag: 'workspaces',
    summary: 'Create a workspace',
    description: 'Organization owner/admin only.',
    params: orgParams,
    body: createWorkspaceRequestSchema,
    status: 201,
    response: workspaceSchema,
  });
  add({
    method: 'get',
    path: '/api/v1/orgs/{orgId}/workspaces/{workspaceId}',
    operationId: 'getWorkspace',
    tag: 'workspaces',
    summary: 'A workspace',
    params: orgWorkspaceParams,
    status: 200,
    response: workspaceSchema,
  });
  add({
    method: 'patch',
    path: '/api/v1/orgs/{orgId}/workspaces/{workspaceId}',
    operationId: 'updateWorkspace',
    tag: 'workspaces',
    summary: 'Rename a workspace',
    description: 'Workspace admin or organization owner/admin.',
    params: orgWorkspaceParams,
    body: updateWorkspaceRequestSchema,
    status: 200,
    response: workspaceSchema,
  });
  add({
    method: 'delete',
    path: '/api/v1/orgs/{orgId}/workspaces/{workspaceId}',
    operationId: 'deleteWorkspace',
    tag: 'workspaces',
    summary: 'Delete an empty workspace',
    description:
      'Organization owner/admin only. A workspace that still contains bases (also in the ' +
      'trash) is refused with `422 VALIDATION_FAILED`, `errors[].code = WORKSPACE_NOT_EMPTY`.',
    params: orgWorkspaceParams,
    status: 204,
  });
  add({
    method: 'get',
    path: '/api/v1/workspaces/{workspaceId}/members',
    operationId: 'listWorkspaceMembers',
    tag: 'workspaces',
    summary: 'Members of a workspace',
    params: workspaceParams,
    query: offsetQuerySchema,
    status: 200,
    response: workspaceMemberListSchema,
  });
  add({
    method: 'post',
    path: '/api/v1/workspaces/{workspaceId}/members',
    operationId: 'addWorkspaceMember',
    tag: 'workspaces',
    summary: 'Add a user or group of the organization to a workspace',
    description: 'Workspace admin or organization owner/admin.',
    params: workspaceParams,
    body: addWorkspaceMemberRequestSchema,
    status: 201,
    response: workspaceMemberSchema,
  });
  add({
    method: 'patch',
    path: '/api/v1/workspaces/{workspaceId}/members/{principalId}',
    operationId: 'updateWorkspaceMember',
    tag: 'workspaces',
    summary: "Change a workspace member's role",
    description: 'Workspace admin or organization owner/admin.',
    params: workspacePrincipalParams,
    body: updateWorkspaceMemberRequestSchema,
    status: 200,
    response: workspaceMemberSchema,
  });
  add({
    method: 'delete',
    path: '/api/v1/workspaces/{workspaceId}/members/{principalId}',
    operationId: 'removeWorkspaceMember',
    tag: 'workspaces',
    summary: 'Remove a user or group from a workspace',
    description: 'Workspace admin or organization owner/admin.',
    params: workspacePrincipalParams,
    status: 204,
  });

  // --- Bases ---
  add({
    method: 'get',
    path: '/api/v1/workspaces/{workspaceId}/bases',
    operationId: 'listBases',
    tag: 'bases',
    summary: 'Bases of a workspace the caller can open',
    description:
      'Workspace admins and organization owners/admins see every base. With ' +
      '`include_deleted=true`, bases in the trash that the caller may restore are listed too ' +
      '(`deleted_at` set).',
    params: workspaceParams,
    query: baseListQuerySchema,
    status: 200,
    response: baseListSchema,
  });
  add({
    method: 'post',
    path: '/api/v1/workspaces/{workspaceId}/bases',
    operationId: 'createBase',
    tag: 'bases',
    summary: 'Create a base',
    description:
      'Workspace admin or organization owner/admin. The caller becomes the base owner; the ' +
      'system roles `admin`, `editor` and `reader` are created.',
    params: workspaceParams,
    body: createBaseRequestSchema,
    status: 201,
    response: baseDetailSchema,
  });
  add({
    method: 'get',
    path: '/api/v1/bases/{baseId}',
    operationId: 'getBase',
    tag: 'bases',
    summary: 'A base with the caller’s effective access',
    params: baseParams,
    status: 200,
    response: baseDetailSchema,
  });
  add({
    method: 'get',
    path: '/api/v1/bases/{baseId}/members',
    operationId: 'listBaseMembers',
    tag: 'bases',
    summary: 'People who can open a base',
    description:
      'Active members of the organization whose effective access (SPEC §14.1: organization ' +
      'role, workspace role, ownership, base roles through users and groups) lets them open ' +
      'the base, oldest member first. Any member who can read the base may list them (user ' +
      'pickers of the base); others get `404`. Not paged.',
    params: baseParams,
    status: 200,
    response: baseMemberListSchema,
  });
  add({
    method: 'patch',
    path: '/api/v1/bases/{baseId}',
    operationId: 'updateBase',
    tag: 'bases',
    summary: 'Change base settings or transfer ownership',
    description:
      'Base admins change name, icon and description. `owner_id` (ownership transfer) is ' +
      'allowed to the current owner and organization owners/admins only; the new owner must ' +
      'be a member of the organization.',
    params: baseParams,
    body: updateBaseRequestSchema,
    status: 200,
    response: baseDetailSchema,
  });
  add({
    method: 'delete',
    path: '/api/v1/bases/{baseId}',
    operationId: 'deleteBase',
    tag: 'bases',
    summary: 'Move a base to the trash',
    description: 'Base owner, workspace admin or organization owner/admin.',
    params: baseParams,
    status: 204,
  });
  add({
    method: 'post',
    path: '/api/v1/bases/{baseId}/restore',
    operationId: 'restoreBase',
    tag: 'bases',
    summary: 'Restore a base from the trash',
    description:
      'Base owner, workspace admin or organization owner/admin (the people who may delete it); ' +
      'a base in the trash is `404` for everyone else. Emits `base.restored` and increases ' +
      '`permission_version`. A base outside the trash is returned unchanged. No time limit ' +
      'until bases are purged from the trash.',
    params: baseParams,
    status: 200,
    response: baseDetailSchema,
  });

  // --- Invitations ---
  add({
    method: 'get',
    path: '/api/v1/orgs/{orgId}/invitations',
    operationId: 'listInvitations',
    tag: 'invitations',
    summary: 'Invitations of an organization',
    description: 'Organization owner/admin only.',
    params: orgParams,
    query: invitationListQuerySchema,
    status: 200,
    response: invitationListSchema,
  });
  add({
    method: 'post',
    path: '/api/v1/orgs/{orgId}/invitations',
    operationId: 'createInvitation',
    tag: 'invitations',
    summary: 'Invite someone by email',
    description:
      'Organization owner/admin only. The one-time link is valid for 7 days and returned only ' +
      'in this response; it is also emailed when SMTP is configured. Inviting a current ' +
      'member is refused (`422`, `ALREADY_MEMBER`).',
    params: orgParams,
    body: createInvitationRequestSchema,
    status: 201,
    response: createdInvitationSchema,
  });
  add({
    method: 'get',
    path: '/api/v1/orgs/{orgId}/invitations/{invitationId}',
    operationId: 'getInvitation',
    tag: 'invitations',
    summary: 'An invitation',
    description: 'Organization owner/admin only.',
    params: orgInvitationParams,
    status: 200,
    response: invitationSchema,
  });
  add({
    method: 'delete',
    path: '/api/v1/orgs/{orgId}/invitations/{invitationId}',
    operationId: 'revokeInvitation',
    tag: 'invitations',
    summary: 'Revoke a pending invitation',
    description: 'Organization owner/admin only. Revoking a non-pending invitation does nothing.',
    params: orgInvitationParams,
    status: 204,
  });
  add({
    method: 'get',
    path: '/api/v1/invitations/{token}',
    operationId: 'previewInvitation',
    tag: 'invitations',
    summary: 'What an invitation link is for',
    public: true,
    params: tokenParams,
    status: 200,
    response: invitationPreviewSchema,
    errors: {
      410: '`INVITATION_INVALID`: wrong, used, revoked or expired link',
      429: '`RATE_LIMITED`, with `Retry-After`',
    },
  });
  add({
    method: 'post',
    path: '/api/v1/invitations/{token}/accept',
    operationId: 'acceptInvitation',
    tag: 'invitations',
    summary: 'Accept an invitation',
    description:
      'Signed in: the session user must have the invited email. Not signed in: ' +
      '`display_name` and `password` create the account (an existing account must sign in ' +
      'first: `401 UNAUTHENTICATED`). Joins the organization with the invited role, and the ' +
      'workspace when the invitation names one. Does not sign in.',
    public: true,
    forbidden: '`CSRF_INVALID`',
    params: tokenParams,
    body: acceptInvitationRequestSchema,
    status: 200,
    response: acceptInvitationResponseSchema,
    errors: {
      401: '`UNAUTHENTICATED`: an account with this email exists; sign in first',
      410: '`INVITATION_INVALID`: wrong, used, revoked or expired link, or another user',
      429: '`RATE_LIMITED`, with `Retry-After`',
    },
  });
};
