import {
  basePrincipalListSchema,
  MAX_LIST_LIMIT,
  memberAccessSchema,
  roleAssignmentSchema,
  roleListSchema,
  roleSchema,
  roleWithAdjustmentsSchema,
  type AssignRoleRequest,
  type CreateRoleRequest,
  type RemoveRoleAssignmentRequest,
  type UpdateRoleRequest,
} from '@cellhive/contracts';

import { apiRequest, apiRequestVoid } from './client';

const id = encodeURIComponent;

/** Base roles and their assignments (CONTRACTS §14); base admins only (other members `403`, others `404`). */
export const rolesApi = {
  list: (baseId: string, signal?: AbortSignal) =>
    apiRequest(`/bases/${id(baseId)}/roles`, roleListSchema, {
      query: { offset: 0, limit: MAX_LIST_LIMIT },
      signal,
    }),
  get: (baseId: string, roleId: string, signal?: AbortSignal) =>
    apiRequest(`/bases/${id(baseId)}/roles/${id(roleId)}`, roleSchema, { signal }),
  /** Answers the role with the `adjustments` the normalizer made. */
  create: (baseId: string, body: CreateRoleRequest) =>
    apiRequest(`/bases/${id(baseId)}/roles`, roleWithAdjustmentsSchema, { method: 'POST', body }),
  update: (baseId: string, roleId: string, body: UpdateRoleRequest) =>
    apiRequest(`/bases/${id(baseId)}/roles/${id(roleId)}`, roleWithAdjustmentsSchema, {
      method: 'PATCH',
      body,
    }),
  remove: (baseId: string, roleId: string) =>
    apiRequestVoid(`/bases/${id(baseId)}/roles/${id(roleId)}`, { method: 'DELETE' }),
  assign: (baseId: string, body: AssignRoleRequest) =>
    apiRequest(`/bases/${id(baseId)}/role-assignments`, roleAssignmentSchema, {
      method: 'PUT',
      body,
    }),
  unassign: (baseId: string, body: RemoveRoleAssignmentRequest) =>
    apiRequestVoid(`/bases/${id(baseId)}/role-assignments`, { method: 'DELETE', body }),
  /**
   * (T711, T712) Active organization members and groups with their current
   * role in the base (CONTRACTS §14): the rows of the members settings page.
   */
  principals: (
    baseId: string,
    params: { readonly q?: string; readonly cursor?: string },
    signal?: AbortSignal,
  ) =>
    apiRequest(`/bases/${id(baseId)}/principals`, basePrincipalListSchema, {
      query: { q: params.q, cursor: params.cursor, limit: PRINCIPAL_PAGE_SIZE },
      signal,
    }),
  /**
   * (T711, T713) A member's effective access to the base, where it comes
   * from and, with `counts`, the records they read and edit per table
   * (CONTRACTS §5A): the read-only "View access" panel.
   */
  memberAccess: (baseId: string, userId: string, signal?: AbortSignal) =>
    apiRequest(`/bases/${id(baseId)}/members/${id(userId)}/access`, memberAccessSchema, {
      query: { counts: true },
      signal,
    }),
};

/** Principals per page of the members settings page (the API allows up to 200). */
export const PRINCIPAL_PAGE_SIZE = 100;
