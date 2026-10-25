import { auditLogListSchema, jobAcceptedSchema } from '@cellhive/contracts';
import { infiniteQueryOptions } from '@tanstack/react-query';

import { apiRequest, UNCHECKED_SCHEMA } from '../../lib/api/client';

import type { AuditQuery } from './model';

const id = encodeURIComponent;
const DEV = import.meta.env.DEV;
export const AUDIT_PAGE_SIZE = 50;

/** Whose audit log the page shows: an organization's or one base's (CONTRACTS §11.4). */
export type AuditScope =
  | { readonly kind: 'org'; readonly orgId: string }
  | { readonly kind: 'base'; readonly baseId: string; readonly orgId: string };

function root(scope: AuditScope): string {
  return scope.kind === 'org' ? `/orgs/${id(scope.orgId)}` : `/bases/${id(scope.baseId)}`;
}

/**
 * Query keys of the viewer (kept here, not in `lib/query/keys.ts`, which the
 * app shell bundles). The base list sits under `['base', id]`, so
 * `permission.changed` of the base reloads it (FRONTEND §5).
 */
export const auditKeys = {
  list: (scope: AuditScope, query: AuditQuery) =>
    scope.kind === 'org'
      ? (['org', scope.orgId, 'audit', query] as const)
      : (['base', scope.baseId, 'audit', query] as const),
};

/** The audit log admin API (CONTRACTS §11.4): org owners/admins, base admins; others `404`. */
export const auditApi = {
  list: (scope: AuditScope, query: AuditQuery, cursor: string | undefined, signal?: AbortSignal) =>
    apiRequest(`${root(scope)}/audit-logs`, DEV ? auditLogListSchema : UNCHECKED_SCHEMA, {
      query: { ...query, include: 'refs', limit: AUDIT_PAGE_SIZE, cursor },
      signal,
    }),
  /** `202 { job_id }`: a CSV of every entry the filters match (at most 100,000). */
  export: (scope: AuditScope, filters: AuditQuery, idempotencyKey: string) =>
    apiRequest(`${root(scope)}/audit-logs/export`, DEV ? jobAcceptedSchema : UNCHECKED_SCHEMA, {
      method: 'POST',
      body: { format: 'csv', filters },
      idempotencyKey,
    }),
};

export const auditListQuery = (scope: AuditScope, query: AuditQuery) =>
  infiniteQueryOptions({
    queryKey: auditKeys.list(scope, query),
    queryFn: ({ pageParam, signal }) => auditApi.list(scope, query, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
