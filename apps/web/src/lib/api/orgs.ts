import {
  baseListSchema,
  emailSettingsSchema,
  groupListSchema,
  MAX_LIST_LIMIT,
  orgMemberListSchema,
  organizationSchema,
  workspaceListSchema,
} from '@cellhive/contracts';

import { apiRequest, UNCHECKED_SCHEMA } from './client';

/** Responses are checked in development only (FRONTEND §3.1); production builds drop the schemas (T700). */
const DEV = import.meta.env.DEV;

/**
 * Organization data shared by several features. The member list feeds the
 * user pickers of the grid (FRONTEND §4.1): any member may read it, and one
 * page of the maximum size holds the members of an MVP organization.
 */
export const orgsApi = {
  /** An organization with its defaults (locale, timezone, currency: SPEC §20). */
  get: (orgId: string, signal?: AbortSignal) =>
    apiRequest(`/orgs/${encodeURIComponent(orgId)}`, DEV ? organizationSchema : UNCHECKED_SCHEMA, {
      signal,
    }),
  members: (orgId: string, signal?: AbortSignal) =>
    apiRequest(
      `/orgs/${encodeURIComponent(orgId)}/members`,
      DEV ? orgMemberListSchema : UNCHECKED_SCHEMA,
      {
        query: { offset: 0, limit: MAX_LIST_LIMIT },
        signal,
      },
    ),
  /**
   * (T522) Email settings of the organization (CONTRACTS §23.2): org
   * owners/admins only (`403` for others) — the builder uses them, when
   * readable, to explain senders, the footer policy and the limits.
   */
  emailSettings: (orgId: string, signal?: AbortSignal) =>
    apiRequest(
      `/orgs/${encodeURIComponent(orgId)}/email-settings`,
      DEV ? emailSettingsSchema : UNCHECKED_SCHEMA,
      {
        signal,
      },
    ),
  /** (T522) Groups of the organization (any member reads them): recipients of `send_notification`. */
  groups: (orgId: string, signal?: AbortSignal) =>
    apiRequest(
      `/orgs/${encodeURIComponent(orgId)}/groups`,
      DEV ? groupListSchema : UNCHECKED_SCHEMA,
      {
        query: { offset: 0, limit: MAX_LIST_LIMIT },
        signal,
      },
    ),
  /**
   * Workspaces then bases of an organization, as `{ id, name }`: the base
   * column of the share link list (T316), the base scope of sender identities (T533).
   */
  bases: async (orgId: string, signal?: AbortSignal) => {
    const page = { offset: 0, limit: MAX_LIST_LIMIT };
    const workspaces = await apiRequest(
      `/orgs/${encodeURIComponent(orgId)}/workspaces`,
      DEV ? workspaceListSchema : UNCHECKED_SCHEMA,
      { query: page, signal },
    );
    const lists = await Promise.all(
      workspaces.items.map((workspace) =>
        apiRequest(
          `/workspaces/${encodeURIComponent(workspace.id)}/bases`,
          DEV ? baseListSchema : UNCHECKED_SCHEMA,
          {
            query: page,
            signal,
          },
        ),
      ),
    );
    return lists.flatMap((list) => list.items.map((base) => ({ id: base.id, name: base.name })));
  },
};
