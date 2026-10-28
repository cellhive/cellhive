import {
  createdInvitationSchema,
  groupMemberListSchema,
  groupMemberSchema,
  groupSchema,
  invitationListSchema,
  MAX_LIST_LIMIT,
  organizationSchema,
  orgMemberSchema,
  passwordResetLinkSchema,
  type CreateInvitationRequest,
  type OrgRoleName,
  type UpdateOrganizationRequest,
} from '@cellhive/contracts';

import { apiRequest, apiRequestVoid, UNCHECKED_SCHEMA } from './client';

const id = encodeURIComponent;
/** Responses are checked in development only (FRONTEND §3.1). */
const DEV = import.meta.env.DEV;
const PAGE = { offset: 0, limit: MAX_LIST_LIMIT };

/**
 * Organization administration (SPEC §13.1, §14.1A; CONTRACTS §5A): the
 * organization itself, its members, invitations and groups. Only the
 * organization settings pages call these, so they stay out of `api` and the
 * app shell (FRONTEND §11.1). Owners/admins only; the reads of members and
 * groups every member may call stay in `lib/api/orgs.ts`.
 */
export const orgAdminApi = {
  update: (orgId: string, body: UpdateOrganizationRequest) =>
    apiRequest(`/orgs/${id(orgId)}`, DEV ? organizationSchema : UNCHECKED_SCHEMA, {
      method: 'PATCH',
      body,
    }),

  setMemberRole: (orgId: string, userId: string, role: OrgRoleName) =>
    apiRequest(
      `/orgs/${id(orgId)}/members/${id(userId)}`,
      DEV ? orgMemberSchema : UNCHECKED_SCHEMA,
      { method: 'PATCH', body: { role } },
    ),
  /** The bases the member owns (also in the trash) go to `transferBasesTo` (an owner/admin). */
  removeMember: (orgId: string, userId: string, transferBasesTo: string) =>
    apiRequestVoid(`/orgs/${id(orgId)}/members/${id(userId)}`, {
      method: 'DELETE',
      body: { transfer_bases_to: transferBasesTo },
    }),
  /** A one-time link, returned once; the member's API tokens are revoked (default, T802). */
  passwordResetLink: (orgId: string, userId: string) =>
    apiRequest(
      `/orgs/${id(orgId)}/members/${id(userId)}/password-reset`,
      DEV ? passwordResetLinkSchema : UNCHECKED_SCHEMA,
      { method: 'POST' },
    ),

  pendingInvitations: (orgId: string, signal?: AbortSignal) =>
    apiRequest(`/orgs/${id(orgId)}/invitations`, DEV ? invitationListSchema : UNCHECKED_SCHEMA, {
      query: { ...PAGE, status: 'pending' },
      signal,
    }),
  /** The response carries the one-time `invite_url` (never stored in the query cache). */
  invite: (orgId: string, body: CreateInvitationRequest) =>
    apiRequest(`/orgs/${id(orgId)}/invitations`, DEV ? createdInvitationSchema : UNCHECKED_SCHEMA, {
      method: 'POST',
      body,
    }),
  revokeInvitation: (orgId: string, invitationId: string) =>
    apiRequestVoid(`/orgs/${id(orgId)}/invitations/${id(invitationId)}`, { method: 'DELETE' }),

  createGroup: (orgId: string, name: string) =>
    apiRequest(`/orgs/${id(orgId)}/groups`, DEV ? groupSchema : UNCHECKED_SCHEMA, {
      method: 'POST',
      body: { name },
    }),
  renameGroup: (orgId: string, groupId: string, name: string) =>
    apiRequest(`/orgs/${id(orgId)}/groups/${id(groupId)}`, DEV ? groupSchema : UNCHECKED_SCHEMA, {
      method: 'PATCH',
      body: { name },
    }),
  deleteGroup: (orgId: string, groupId: string) =>
    apiRequestVoid(`/orgs/${id(orgId)}/groups/${id(groupId)}`, { method: 'DELETE' }),
  groupMembers: (groupId: string, signal?: AbortSignal) =>
    apiRequest(`/groups/${id(groupId)}/members`, DEV ? groupMemberListSchema : UNCHECKED_SCHEMA, {
      query: PAGE,
      signal,
    }),
  addGroupMember: (groupId: string, userId: string) =>
    apiRequest(`/groups/${id(groupId)}/members`, DEV ? groupMemberSchema : UNCHECKED_SCHEMA, {
      method: 'POST',
      body: { user_id: userId },
    }),
  removeGroupMember: (groupId: string, userId: string) =>
    apiRequestVoid(`/groups/${id(groupId)}/members/${id(userId)}`, { method: 'DELETE' }),
};
