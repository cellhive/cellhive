import {
  createdShareLinkSchema,
  organizationSchema,
  revokeShareLinksResponseSchema,
  shareLinkListSchema,
  shareLinkPreviewSchema,
  shareLinkSchema,
  type CreateShareLinkRequest,
  type OrganizationDetailDto,
  type OrgShareLinkListQuery,
  type PublicSharingPolicy,
  type ShareLinkListQuery,
  type UpdateShareLinkRequest,
} from '@cellhive/contracts';
import { keepPreviousData, queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';

import { apiRequest, apiRequestVoid } from '../../../lib/api/client';
import { keys } from '../../../lib/query/keys';

const id = encodeURIComponent;

/** Filters of the admin lists, as sent (`offset`/`limit` included). */
export type BaseLinkFilters = Partial<ShareLinkListQuery>;
export type OrgLinkFilters = Partial<OrgShareLinkListQuery>;

/**
 * Share link management (CONTRACTS §16). Tokens only ever come back from
 * create and regenerate (`CreatedShareLink`); lists and `GET` never carry one.
 */
export const shareLinksApi = {
  listForView: (viewId: string, signal?: AbortSignal) =>
    apiRequest(`/views/${id(viewId)}/share-links`, shareLinkListSchema, { signal }),
  /** (T814) `GET /dashboards/:id/share-links` (T809). */
  listForDashboard: (dashboardId: string, signal?: AbortSignal) =>
    apiRequest(`/dashboards/${id(dashboardId)}/share-links`, shareLinkListSchema, { signal }),
  preview: (viewId: string, signal?: AbortSignal) =>
    apiRequest(`/views/${id(viewId)}/share-links/preview`, shareLinkPreviewSchema, { signal }),
  create: (viewId: string, body: Partial<CreateShareLinkRequest>) =>
    apiRequest(`/views/${id(viewId)}/share-links`, createdShareLinkSchema, {
      method: 'POST',
      body,
    }),
  /** (T814) `POST /dashboards/:id/share-links` (T809). */
  createForDashboard: (dashboardId: string, body: Partial<CreateShareLinkRequest>) =>
    apiRequest(`/dashboards/${id(dashboardId)}/share-links`, createdShareLinkSchema, {
      method: 'POST',
      body,
    }),
  update: (linkId: string, body: UpdateShareLinkRequest) =>
    apiRequest(`/share-links/${id(linkId)}`, shareLinkSchema, { method: 'PATCH', body }),
  revoke: (linkId: string) => apiRequestVoid(`/share-links/${id(linkId)}`, { method: 'DELETE' }),
  regenerate: (linkId: string) =>
    apiRequest(`/share-links/${id(linkId)}/regenerate`, createdShareLinkSchema, {
      method: 'POST',
    }),
  listForBase: (baseId: string, filters: BaseLinkFilters, signal?: AbortSignal) =>
    apiRequest(`/bases/${id(baseId)}/share-links`, shareLinkListSchema, {
      query: filters,
      signal,
    }),
  revokeForBase: (baseId: string, ids: readonly string[]) =>
    apiRequest(`/bases/${id(baseId)}/share-links/revoke`, revokeShareLinksResponseSchema, {
      method: 'POST',
      body: { ids },
    }),
  listForOrg: (orgId: string, filters: OrgLinkFilters, signal?: AbortSignal) =>
    apiRequest(`/orgs/${id(orgId)}/share-links`, shareLinkListSchema, { query: filters, signal }),
  revokeForOrg: (orgId: string, ids: readonly string[]) =>
    apiRequest(`/orgs/${id(orgId)}/share-links/revoke`, revokeShareLinksResponseSchema, {
      method: 'POST',
      body: { ids },
    }),
  setPublicSharing: (orgId: string, policy: PublicSharingPolicy) =>
    apiRequest(`/orgs/${id(orgId)}`, organizationSchema, {
      method: 'PATCH',
      body: { settings: { public_sharing: policy } },
    }),
};

/** What a share dialog shares: a view (or form) or (T814) a dashboard. */
export interface ShareTargetRef {
  readonly kind: 'view' | 'dashboard';
  readonly id: string;
}

/** Cache entry of the links of a target. */
function targetLinksKey(target: ShareTargetRef) {
  return target.kind === 'view'
    ? keys.viewShareLinks(target.id)
    : keys.dashboardShareLinks(target.id);
}

/**
 * The link of a view or dashboard, fetched again whenever the dialog opens:
 * its open count moves while the link is used (the settings lists read the
 * same fields, always fresh too — T320 QA).
 */
export const targetShareLinksQuery = (target: ShareTargetRef) =>
  queryOptions({
    queryKey: targetLinksKey(target),
    queryFn: ({ signal }) =>
      target.kind === 'view'
        ? shareLinksApi.listForView(target.id, signal)
        : shareLinksApi.listForDashboard(target.id, signal),
    staleTime: 0,
  });

/** What outsiders would see: always fresh when the dialog opens (the warning must be current). */
export const shareLinkPreviewQuery = (viewId: string) =>
  queryOptions({
    queryKey: keys.shareLinkPreview(viewId),
    queryFn: ({ signal }) => shareLinksApi.preview(viewId, signal),
    staleTime: 0,
  });

/** Where an admin list lives: a base (base admins) or an organization (owners/admins). */
export type LinkScope =
  | { readonly kind: 'base'; readonly baseId: string }
  | { readonly kind: 'org'; readonly orgId: string };

/** One page of the admin list of a scope; the previous page stays shown while the next loads. */
export const shareLinkListQuery = (scope: LinkScope, filters: OrgLinkFilters) =>
  queryOptions({
    queryKey:
      scope.kind === 'base'
        ? keys.baseShareLinks(scope.baseId, filters)
        : keys.orgShareLinks(scope.orgId, filters),
    queryFn: ({ signal }) =>
      scope.kind === 'base'
        ? shareLinksApi.listForBase(scope.baseId, filters, signal)
        : shareLinksApi.listForOrg(scope.orgId, filters, signal),
    placeholderData: keepPreviousData,
    staleTime: 0,
  });

/** Names of the bases of an organization (shared with other settings pages: `lib/query`). */
export { orgBasesQuery } from '../../../lib/query/queries';

/**
 * Invalidates every list a change of a link shows up in: the view's own list
 * and preview, the admin lists of its base and organization. Not awaited on
 * purpose: the dialog swaps its content when the refetched list arrives,
 * and the callbacks of `mutate` (showing the new token once) must run first
 * (TanStack Query skips them for an unmounted component).
 */
function useInvalidateLinks() {
  const queryClient = useQueryClient();
  return ({ target, baseId, orgId }: ShareContext) => {
    void queryClient.invalidateQueries({ queryKey: targetLinksKey(target) });
    void queryClient.invalidateQueries({ queryKey: keys.baseShareLinks(baseId) });
    void queryClient.invalidateQueries({ queryKey: keys.orgShareLinks(orgId) });
  };
}

/** Context of the share dialog: what is shared and where its links are listed. */
export interface ShareContext {
  readonly target: ShareTargetRef;
  readonly baseId: string;
  readonly orgId: string;
}

export function useCreateShareLink(context: ShareContext) {
  const invalidate = useInvalidateLinks();
  return useMutation({
    mutationFn: (body: Partial<CreateShareLinkRequest>) =>
      context.target.kind === 'view'
        ? shareLinksApi.create(context.target.id, body)
        : shareLinksApi.createForDashboard(context.target.id, body),
    onSettled: () => {
      invalidate(context);
    },
  });
}

export function useUpdateShareLink(context: ShareContext) {
  const invalidate = useInvalidateLinks();
  return useMutation({
    mutationFn: ({ linkId, body }: { linkId: string; body: UpdateShareLinkRequest }) =>
      shareLinksApi.update(linkId, body),
    onSettled: () => {
      invalidate(context);
    },
  });
}

export function useRegenerateShareLink(context: ShareContext) {
  const invalidate = useInvalidateLinks();
  return useMutation({
    mutationFn: (linkId: string) => shareLinksApi.regenerate(linkId),
    onSettled: () => {
      invalidate(context);
    },
  });
}

export function useRevokeShareLink(context: ShareContext) {
  const invalidate = useInvalidateLinks();
  return useMutation({
    mutationFn: (linkId: string) => shareLinksApi.revoke(linkId),
    onSettled: () => {
      invalidate(context);
    },
  });
}

/** Bulk revoke from a settings page (CONTRACTS §16: unknown or revoked ids are skipped). */
export function useRevokeLinks(scope: LinkScope) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids: readonly string[]) =>
      scope.kind === 'base'
        ? shareLinksApi.revokeForBase(scope.baseId, ids)
        : shareLinksApi.revokeForOrg(scope.orgId, ids),
    // Links of any view may be gone: view lists refetch when a dialog opens.
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey:
            scope.kind === 'base'
              ? keys.baseShareLinks(scope.baseId)
              : keys.orgShareLinks(scope.orgId),
        }),
        queryClient.invalidateQueries({ queryKey: keys.allViewShareLinks() }),
      ]),
  });
}

/** Changes `settings.public_sharing`; the statuses of public links change with it. */
export function useSetPublicSharing(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (policy: PublicSharingPolicy) => shareLinksApi.setPublicSharing(orgId, policy),
    onSuccess: (org) => {
      // `PATCH` answers without `ai` (T912): keep the one of `GET /orgs/:id`.
      queryClient.setQueryData<OrganizationDetailDto>(keys.org(orgId), (old) =>
        old === undefined ? undefined : { ...old, ...org },
      );
    },
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.orgShareLinks(orgId) }),
        queryClient.invalidateQueries({ queryKey: keys.allViewShareLinks() }),
      ]),
  });
}
