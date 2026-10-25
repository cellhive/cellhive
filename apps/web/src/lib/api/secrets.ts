import {
  baseSecretListSchema,
  secretListSchema,
  secretSchema,
  secretUsagesSchema,
  type CreateSecretInput,
  type SecretKind,
  type UpdateSecretRequest,
} from '@cellhive/contracts';

import { apiRequest, apiRequestVoid } from './client';

const id = encodeURIComponent;

/**
 * Organization secrets (CONTRACTS §24, BACKLOG T516): Telegram bot tokens.
 * Owners/admins manage them (the value is write-only: sent on create or
 * replace, never returned); automation managers of a base only list the
 * ones in scope, by name (`base`).
 */
export const secretsApi = {
  list: (orgId: string, signal?: AbortSignal) =>
    apiRequest(`/orgs/${id(orgId)}/secrets`, secretListSchema, { signal }),
  create: (orgId: string, body: CreateSecretInput) =>
    apiRequest(`/orgs/${id(orgId)}/secrets`, secretSchema, { method: 'POST', body }),
  update: (secretId: string, body: UpdateSecretRequest) =>
    apiRequest(`/secrets/${id(secretId)}`, secretSchema, { method: 'PATCH', body }),
  remove: (secretId: string) => apiRequestVoid(`/secrets/${id(secretId)}`, { method: 'DELETE' }),
  usages: (secretId: string, signal?: AbortSignal) =>
    apiRequest(`/secrets/${id(secretId)}/usages`, secretUsagesSchema, { signal }),
  base: (baseId: string, kind: SecretKind, signal?: AbortSignal) =>
    apiRequest(`/bases/${id(baseId)}/secrets?kind=${id(kind)}`, baseSecretListSchema, { signal }),
};
