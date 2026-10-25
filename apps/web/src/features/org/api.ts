import {
  baseDetailSchema,
  baseListSchema,
  workspaceListSchema,
  workspaceSchema,
  type CreateBaseRequest,
  type CreateWorkspaceRequest,
} from '@cellhive/contracts';
import { queryOptions } from '@tanstack/react-query';

import { apiRequest, UNCHECKED_SCHEMA } from '../../lib/api/client';
import { keys } from '../../lib/query/keys';

/** Responses are checked in development only (FRONTEND §3.1); production builds drop the schemas (T700). */
const DEV = import.meta.env.DEV;

/**
 * Navigation lists are small (an organization has few workspaces, a
 * workspace few bases); one page of the maximum size is enough for the MVP.
 */
const NAV_PAGE = { offset: 0, limit: 1000 } as const;

const id = encodeURIComponent;

/**
 * Workspaces and bases (SPEC §13.1, §14.1). The caller's organizations come
 * from `GET /me` (CONTRACTS §5A).
 */
export const orgApi = {
  listWorkspaces: (orgId: string, signal?: AbortSignal) =>
    apiRequest(`/orgs/${id(orgId)}/workspaces`, DEV ? workspaceListSchema : UNCHECKED_SCHEMA, {
      query: NAV_PAGE,
      signal,
    }),
  getWorkspace: (orgId: string, workspaceId: string, signal?: AbortSignal) =>
    apiRequest(
      `/orgs/${id(orgId)}/workspaces/${id(workspaceId)}`,
      DEV ? workspaceSchema : UNCHECKED_SCHEMA,
      { signal },
    ),
  createWorkspace: (orgId: string, body: CreateWorkspaceRequest) =>
    apiRequest(`/orgs/${id(orgId)}/workspaces`, DEV ? workspaceSchema : UNCHECKED_SCHEMA, {
      method: 'POST',
      body,
    }),
  listBases: (workspaceId: string, signal?: AbortSignal) =>
    apiRequest(`/workspaces/${id(workspaceId)}/bases`, DEV ? baseListSchema : UNCHECKED_SCHEMA, {
      query: NAV_PAGE,
      signal,
    }),
  createBase: (workspaceId: string, body: CreateBaseRequest) =>
    apiRequest(`/workspaces/${id(workspaceId)}/bases`, DEV ? baseDetailSchema : UNCHECKED_SCHEMA, {
      method: 'POST',
      body,
    }),
};

export const workspacesQuery = (orgId: string) =>
  queryOptions({
    queryKey: keys.workspaces(orgId),
    queryFn: ({ signal }) => orgApi.listWorkspaces(orgId, signal),
  });

export const workspaceQuery = (orgId: string, workspaceId: string) =>
  queryOptions({
    queryKey: keys.workspace(workspaceId),
    queryFn: ({ signal }) => orgApi.getWorkspace(orgId, workspaceId, signal),
  });

export const basesQuery = (workspaceId: string) =>
  queryOptions({
    queryKey: keys.bases(workspaceId),
    queryFn: ({ signal }) => orgApi.listBases(workspaceId, signal),
  });
