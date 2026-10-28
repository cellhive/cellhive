import { baseListSchema, workspaceSchema, type UpdateWorkspaceRequest } from '@cellhive/contracts';

import { apiRequest, apiRequestVoid, UNCHECKED_SCHEMA } from './client';

const id = encodeURIComponent;
const DEV = import.meta.env.DEV;

/**
 * Renaming and deleting a workspace, and its bases in the trash (SPEC §13.1).
 * Only the workspace page calls these, so they stay out of `api` and the app
 * shell (FRONTEND §11.1). Rename: workspace admins and organization
 * owners/admins; delete: organization owners/admins, once no base is left.
 */
export const workspaceAdminApi = {
  rename: (orgId: string, workspaceId: string, body: UpdateWorkspaceRequest) =>
    apiRequest(
      `/orgs/${id(orgId)}/workspaces/${id(workspaceId)}`,
      DEV ? workspaceSchema : UNCHECKED_SCHEMA,
      { method: 'PATCH', body },
    ),
  remove: (orgId: string, workspaceId: string) =>
    apiRequestVoid(`/orgs/${id(orgId)}/workspaces/${id(workspaceId)}`, { method: 'DELETE' }),
  /** Live bases and those in the trash the caller may restore (`include_deleted`). */
  basesWithDeleted: (workspaceId: string, signal?: AbortSignal) =>
    apiRequest(`/workspaces/${id(workspaceId)}/bases`, DEV ? baseListSchema : UNCHECKED_SCHEMA, {
      query: { offset: 0, limit: 1000, include_deleted: true },
      signal,
    }),
};
