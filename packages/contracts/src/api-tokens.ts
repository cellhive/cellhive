import { z } from 'zod';

import { isoDateTimeSchema } from './common.js';
import { idOf } from './ids.js';
import { cursorListSchema, cursorQuerySchema } from './pagination.js';

/**
 * Personal API tokens (SPEC §5.10 `meta.api_tokens`, §13.1; CONTRACTS §26;
 * ADR-36 §1; BACKLOG T703). A token belongs to one member of one
 * organization, is shown once when created and is stored as a SHA-256 hash
 * only. Its effective rights are the owner's current rights ∩ its scopes ∩
 * its bases ∩ its organization (T704).
 */

/** Tokens start with this (CONTRACTS §26.1); `cht_` + 30 base62 + 6 base62 of a CRC32. */
export const API_TOKEN_PREFIX = 'cht_';
/** Characters after `cht_` kept in clear to recognise a token (`cht_AbCdEfGh…`). */
export const API_TOKEN_PREFIX_LENGTH = 8;

/** The closed list of scopes (CONTRACTS §26.2). `*:write` never implies `*:read`. */
export const API_TOKEN_SCOPES = [
  'records:read',
  'records:write',
  'schema:read',
  'schema:write',
  'automations:read',
  'automations:write',
] as const;
export const apiTokenScopeSchema = z
  .enum(API_TOKEN_SCOPES)
  .meta({ id: 'ApiTokenScope', description: 'What a token may do (CONTRACTS §26.2)' });
export type ApiTokenScope = z.infer<typeof apiTokenScopeSchema>;

/** Limits of CONTRACTS §26.6. */
export const API_TOKEN_NAME_MAX_LENGTH = 100;
/** Tokens not revoked per (member, organization). */
export const API_TOKENS_MAX_PER_USER = 50;
export const API_TOKEN_MAX_BASE_IDS = 50;
/** Longest lifetime of a token, and highest `max_lifetime_days` of the policy. */
export const API_TOKEN_MAX_LIFETIME_DAYS = 3650;
/** Revoked or expired tokens are deleted this long after they stopped working. */
export const API_TOKEN_RETENTION_DAYS = 90;
/**
 * Failed Bearer authentications per client IP and window (CONTRACTS §26.1,
 * T704): past it, Bearer requests from that IP get `429` before any lookup
 * until the window ends. High, because integrations often share an egress
 * IP (CI runners, NAT, cloud functions).
 */
export const API_TOKEN_BEARER_FAILURES_PER_IP = { limit: 300, windowSeconds: 60 } as const;

export const apiTokenIdSchema = idOf('tok');

/**
 * `organizations.settings.api_tokens` (CONTRACTS §26.4): whether members may
 * create and use tokens, and the longest lifetime of a new token (`null` =
 * no limit, "never expires" allowed).
 */
export const apiTokenPolicySchema = z
  .object({
    enabled: z.boolean().meta({
      description:
        'Off: no token can be created (`403 API_TOKENS_DISABLED`) and every token of the ' +
        'organization stops authenticating until it is turned on again',
    }),
    max_lifetime_days: z
      .int()
      .min(1)
      .max(API_TOKEN_MAX_LIFETIME_DAYS)
      .nullable()
      .meta({
        description:
          'New tokens must expire within this many days (`TOKEN_LIFETIME_EXCEEDED`); existing ' +
          'tokens keep their expiry. `null`: no limit',
      }),
  })
  .meta({ id: 'ApiTokenPolicy' });
export type ApiTokenPolicy = z.infer<typeof apiTokenPolicySchema>;
export const DEFAULT_API_TOKEN_POLICY: ApiTokenPolicy = { enabled: true, max_lifetime_days: null };

/** `PATCH /orgs/:id { settings: { api_tokens } }`: keys left out keep their value. */
export const updateApiTokenPolicySchema = z
  .strictObject({
    enabled: apiTokenPolicySchema.shape.enabled.optional(),
    max_lifetime_days: apiTokenPolicySchema.shape.max_lifetime_days.optional(),
  })
  .refine((value) => Object.values(value).some((item) => item !== undefined), {
    message: 'At least one property is required',
  });

const nameSchema = z.string().trim().min(1).max(API_TOKEN_NAME_MAX_LENGTH);

export const createApiTokenRequestSchema = z
  .strictObject({
    name: nameSchema,
    scopes: z.array(apiTokenScopeSchema).min(1).max(API_TOKEN_SCOPES.length).meta({
      description: 'At least one scope (CONTRACTS §26.2); duplicates are ignored',
    }),
    base_ids: z
      .array(idOf('bse'))
      .min(1)
      .max(API_TOKEN_MAX_BASE_IDS)
      .nullable()
      .default(null)
      .meta({
        description:
          'Bases the token is limited to, each readable by the caller now (else `404` with ' +
          '`errors[].path` = `base_ids[i]`); `null`: every base of the owner',
      }),
    expires_at: isoDateTimeSchema.nullable().meta({
      description:
        `In the future and at most ${String(API_TOKEN_MAX_LIFETIME_DAYS)} days away ` +
        '(`OUT_OF_RANGE`), and within `max_lifetime_days` of the policy ' +
        '(`TOKEN_LIFETIME_EXCEEDED`); `null`: never expires — only when the policy has no limit',
    }),
  })
  .meta({ id: 'CreateApiTokenRequest' });
export type CreateApiTokenRequest = z.infer<typeof createApiTokenRequestSchema>;

export const updateApiTokenRequestSchema = z
  .strictObject({ name: nameSchema })
  .meta({ id: 'UpdateApiTokenRequest' });
export type UpdateApiTokenRequest = z.infer<typeof updateApiTokenRequestSchema>;

/** A token's metadata: never its value or hash. */
export const apiTokenSchema = z
  .object({
    id: apiTokenIdSchema,
    name: z.string(),
    token_prefix: z
      .string()
      .meta({ description: '8 characters after `cht_`, shown as `cht_AbCdEfGh…`' }),
    scopes: z.array(apiTokenScopeSchema),
    base_ids: z.array(idOf('bse')).nullable(),
    expires_at: isoDateTimeSchema.nullable(),
    last_used_at: isoDateTimeSchema
      .nullable()
      .meta({ description: 'Written at most once per 5 minutes' }),
    revoked_at: isoDateTimeSchema.nullable(),
    created_at: isoDateTimeSchema,
  })
  .meta({ id: 'ApiToken' });
export type ApiTokenDto = z.infer<typeof apiTokenSchema>;

export const createdApiTokenSchema = apiTokenSchema
  .extend({
    token: z.string().meta({
      description:
        'The token (`cht_…`, 40 characters): returned only in this response (and in its replay ' +
        'for the same `Idempotency-Key`, whose stored copy is encrypted) — never logged or ' +
        'stored in clear',
    }),
  })
  .meta({ id: 'CreatedApiToken' });
export type CreatedApiToken = z.infer<typeof createdApiTokenSchema>;

/** A token of the organization as its owners/admins see it. */
export const orgApiTokenSchema = apiTokenSchema
  .extend({
    user: z
      .object({ id: idOf('usr'), display_name: z.string() })
      .meta({ description: 'The member who owns the token' }),
  })
  .meta({ id: 'OrgApiToken' });
export type OrgApiTokenDto = z.infer<typeof orgApiTokenSchema>;

/** `active`: neither revoked nor expired; `expired`: past `expires_at`, not revoked. */
export const API_TOKEN_STATUSES = ['active', 'revoked', 'expired'] as const;
export const apiTokenStatusSchema = z.enum(API_TOKEN_STATUSES).meta({ id: 'ApiTokenStatus' });
export type ApiTokenStatus = z.infer<typeof apiTokenStatusSchema>;

export const apiTokenListQuerySchema = cursorQuerySchema.extend({
  status: apiTokenStatusSchema.optional(),
});
export type ApiTokenListQuery = z.infer<typeof apiTokenListQuerySchema>;

export const orgApiTokenListQuerySchema = apiTokenListQuerySchema.extend({
  user_id: idOf('usr').optional().meta({ description: 'Tokens of this member only' }),
});
export type OrgApiTokenListQuery = z.infer<typeof orgApiTokenListQuerySchema>;

export const apiTokenListSchema = cursorListSchema(apiTokenSchema).meta({ id: 'ApiTokenList' });
export type ApiTokenList = z.infer<typeof apiTokenListSchema>;

export const orgApiTokenListSchema = cursorListSchema(orgApiTokenSchema).meta({
  id: 'OrgApiTokenList',
});
export type OrgApiTokenList = z.infer<typeof orgApiTokenListSchema>;

// --- Errors ------------------------------------------------------------------------------

/** `VALIDATION_FAILED` detail: the member already has 50 tokens not revoked. */
export const TOO_MANY_TOKENS = 'TOO_MANY_TOKENS';
/**
 * `VALIDATION_FAILED` detail (path `expires_at`): `null` or later than
 * `max_lifetime_days` of the policy; `params.max_lifetime_days`.
 */
export const TOKEN_LIFETIME_EXCEEDED = 'TOKEN_LIFETIME_EXCEEDED';
/**
 * `INSUFFICIENT_SCOPE` detail (T704, CONTRACTS §26.3): `params.required` =
 * the scope the route needs, e.g. `["records:write"]`, or `["session"]` for
 * a route API tokens cannot use.
 */
export const INSUFFICIENT_SCOPE = 'INSUFFICIENT_SCOPE';
