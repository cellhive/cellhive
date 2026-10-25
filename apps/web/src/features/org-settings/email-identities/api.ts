import {
  emailIdentityListSchema,
  emailIdentityMutationSchema,
  emailIdentitySchema,
  emailIdentityUsagesSchema,
  emailSettingsSchema,
  emailVerificationOutcomeSchema,
  type CreateEmailIdentityRequest,
  type EmailIdentityDto,
  type UpdateEmailIdentityRequest,
} from '@cellhive/contracts';
import { queryOptions } from '@tanstack/react-query';

import { apiRequest, apiRequestVoid } from '../../../lib/api/client';
import { keys } from '../../../lib/query/keys';

const id = encodeURIComponent;

/**
 * Sender identities of an organization (CONTRACTS §23.3, ADR-33): owner/admin
 * only. The SMTP password is write-only: it is sent on create/change and
 * never comes back (`smtp.password_set`).
 */
export const emailIdentitiesApi = {
  list: (orgId: string, signal?: AbortSignal) =>
    apiRequest(`/orgs/${id(orgId)}/email-identities`, emailIdentityListSchema, { signal }),
  create: (orgId: string, body: CreateEmailIdentityRequest) =>
    apiRequest(`/orgs/${id(orgId)}/email-identities`, emailIdentityMutationSchema, {
      method: 'POST',
      body,
    }),
  update: (identityId: string, body: UpdateEmailIdentityRequest) =>
    apiRequest(`/email-identities/${id(identityId)}`, emailIdentityMutationSchema, {
      method: 'PATCH',
      body,
    }),
  remove: (identityId: string) =>
    apiRequestVoid(`/email-identities/${id(identityId)}`, { method: 'DELETE' }),
  sendVerification: (identityId: string) =>
    apiRequest(
      `/email-identities/${id(identityId)}/send-verification`,
      emailVerificationOutcomeSchema,
      { method: 'POST' },
    ),
  testAndVerify: (identityId: string) =>
    apiRequest(
      `/email-identities/${id(identityId)}/test-and-verify`,
      emailVerificationOutcomeSchema,
      { method: 'POST' },
    ),
  verifyCode: (identityId: string, code: string) =>
    apiRequest(`/email-identities/${id(identityId)}/verify-code`, emailIdentitySchema, {
      method: 'POST',
      body: { code },
    }),
  setEnabled: (identityId: string, enabled: boolean) =>
    apiRequest(
      `/email-identities/${id(identityId)}/${enabled ? 'enable' : 'disable'}`,
      emailIdentitySchema,
      { method: 'POST' },
    ),
  usages: (identityId: string, signal?: AbortSignal) =>
    apiRequest(`/email-identities/${id(identityId)}/usages`, emailIdentityUsagesSchema, {
      signal,
    }),
  /** Instance SMTP (`from`, domains sent directly) for the live "recipients will see" line. */
  emailSettings: (orgId: string, signal?: AbortSignal) =>
    apiRequest(`/orgs/${id(orgId)}/email-settings`, emailSettingsSchema, { signal }),
};

export const emailIdentitiesQuery = (orgId: string) =>
  queryOptions({
    queryKey: keys.orgEmailIdentities(orgId),
    queryFn: ({ signal }) => emailIdentitiesApi.list(orgId, signal),
    // A link may be confirmed from the mailbox meanwhile: coming back to the tab shows it.
    refetchOnWindowFocus: 'always',
  });

export const emailIdentityUsagesQuery = (orgId: string, identityId: string) =>
  queryOptions({
    queryKey: keys.emailIdentityUsages(orgId, identityId),
    queryFn: ({ signal }) => emailIdentitiesApi.usages(identityId, signal),
    staleTime: 30_000,
  });

export const emailSettingsQuery = (orgId: string) =>
  queryOptions({
    queryKey: keys.orgEmailSettings(orgId),
    queryFn: ({ signal }) => emailIdentitiesApi.emailSettings(orgId, signal),
    staleTime: 60_000,
  });

/** The list with one identity replaced (or appended), as the cache holds it. */
export function withIdentity(
  items: readonly EmailIdentityDto[],
  identity: EmailIdentityDto,
): EmailIdentityDto[] {
  const index = items.findIndex((item) => item.id === identity.id);
  if (index === -1) return [...items, identity];
  return items.map((item) => (item.id === identity.id ? identity : item));
}
