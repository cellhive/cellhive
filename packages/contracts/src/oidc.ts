import { z } from 'zod';

import { isoDateTimeSchema } from './common.js';
import { OIDC_LOGIN_DETAIL_CODES } from './error-details.js';
import { idOf } from './ids.js';

/**
 * Sign-in with OIDC (CONTRACTS §27, ADR-36 §3; BACKLOG T707): providers are
 * configured per instance through `OIDC_*` (SPEC §20); the browser is sent
 * to `GET /api/v1/auth/oidc/:provider/start` and comes back to `…/callback`.
 */

/** Slug of a provider (`OIDC_PROVIDERS`). */
export const OIDC_PROVIDER_SLUG_PATTERN = /^[a-z0-9-]{1,32}$/;
/** Providers per instance (§27.4). */
export const OIDC_MAX_PROVIDERS = 10;
/** Encrypted one-time cookie holding `state`, `nonce`, `code_verifier` and `next`. */
export const OIDC_STATE_COOKIE = 'ob_oidc';
/** Path of the state cookie: only the OIDC routes receive it. */
export const OIDC_STATE_COOKIE_PATH = '/api/v1/auth/oidc/';
/** Lifetime of the state cookie (§27.4). */
export const OIDC_STATE_TTL_SECONDS = 600;
/** Timeout of every call to a provider (discovery, JWKS, token) (§27.4). */
export const OIDC_PROVIDER_TIMEOUT_SECONDS = 10;
/** Provider metadata and JWKS are cached this long; an unknown `kid` reloads the JWKS (§27.4). */
export const OIDC_METADATA_CACHE_SECONDS = 3600;
/** Largest difference between the ID token `iat` and the server clock (§27.4). */
export const OIDC_MAX_IAT_SKEW_SECONDS = 300;
/** `GET …/start` per client IP (§27.4). */
export const OIDC_START_RATE_LIMIT = { limit: 20, windowSeconds: 60 } as const;
/** Longest `next` accepted by `GET …/start`. */
export const OIDC_NEXT_MAX_LENGTH = 2048;

export const oidcProviderSlugSchema = z
  .string()
  .regex(OIDC_PROVIDER_SLUG_PATTERN)
  .meta({ description: 'Provider slug of `OIDC_PROVIDERS`', example: 'keycloak' });

/** A sign-in button. */
export const authProviderSchema = z
  .object({
    slug: oidcProviderSlugSchema,
    name: z.string().meta({ description: 'Button label (`OIDC_<SLUG>_NAME`, else the slug)' }),
  })
  .meta({ id: 'AuthProvider' });
export type AuthProvider = z.infer<typeof authProviderSchema>;

/** `GET /api/v1/auth/providers` (public). */
export const authProvidersResponseSchema = z
  .object({
    providers: z.array(authProviderSchema).meta({
      description: 'Configured OIDC providers, in `OIDC_PROVIDERS` order; empty when none',
    }),
    password_login: z.literal(true).meta({
      description: 'Password sign-in is always available (enforcing SSO is out of S6)',
    }),
  })
  .meta({ id: 'AuthProviders' });
export type AuthProvidersResponse = z.infer<typeof authProvidersResponseSchema>;

export const oidcProviderParamsSchema = z.object({ provider: oidcProviderSlugSchema });

/** `GET /api/v1/auth/oidc/:provider/start?next=` */
export const oidcStartQuerySchema = z.object({
  next: z
    .string()
    .max(OIDC_NEXT_MAX_LENGTH)
    .optional()
    .meta({
      description:
        'Path of the app to open after signing in (as `/login?next=`, FRONTEND §2). Anything ' +
        'else than an internal path — an absolute or protocol-relative URL, `/login` — is ' +
        'replaced by `/`.',
      example: '/o/acme',
    }),
});
export type OidcStartQuery = z.infer<typeof oidcStartQuerySchema>;

/**
 * Authorization response of the provider (OIDC Core §3.1.2.5–6). Every
 * parameter is optional: a missing or wrong one is a sign-in error, never a
 * `422`.
 */
export const oidcCallbackQuerySchema = z.object({
  code: z.string().max(4096).optional(),
  state: z.string().max(512).optional(),
  error: z.string().max(256).optional(),
  error_description: z.string().max(4096).optional().meta({
    description: 'Ignored: never shown to the user nor logged',
  }),
  iss: z.string().max(2048).optional(),
});
export type OidcCallbackQuery = z.infer<typeof oidcCallbackQuerySchema>;

/**
 * Values of `error` in `/login?error=<CODE>` after an OIDC sign-in: the
 * OIDC codes of `OIDC_LOGIN_DETAIL_CODES`, `UNAUTHENTICATED` (the account is
 * disabled) and `RATE_LIMITED` (too many `start` from this IP).
 */
export const OIDC_LOGIN_ERRORS = [
  ...OIDC_LOGIN_DETAIL_CODES,
  'UNAUTHENTICATED',
  'RATE_LIMITED',
] as const;
export type OidcLoginError = (typeof OIDC_LOGIN_ERRORS)[number];

export const oidcLoginErrorSchema = z
  .enum(OIDC_LOGIN_ERRORS)
  .meta({ id: 'OidcLoginError', description: '`error` of `/login?error=` after an OIDC sign-in' });

/**
 * Connected accounts (CONTRACTS §27.3; BACKLOG T708): the caller links an
 * identity of a provider while signed in (`POST /me/identities/:provider/start`
 * → provider → the same `…/callback`), lists and removes them.
 */

/**
 * Link mode asks the provider to authenticate again (`max_age=0`); the ID
 * token must carry an `auth_time` at most this old (§27.3).
 */
export const OIDC_LINK_MAX_AUTH_AGE_SECONDS = 600;

/** `POST /api/v1/me/identities/:provider/start` → where the browser goes next. */
export const oidcLinkStartResponseSchema = z
  .object({
    authorization_url: z.url().meta({
      description:
        'Authorization request of the provider (`max_age=0`); open it with a top-level ' +
        'navigation (`window.location.assign`)',
    }),
  })
  .meta({ id: 'OidcLinkStart' });
export type OidcLinkStartResponse = z.infer<typeof oidcLinkStartResponseSchema>;

/** Page the link callback always sends the browser back to. */
export const OIDC_LINK_RETURN_PATH = '/account/connections';

/**
 * Values of `error` in `/account/connections?error=<CODE>` after a link
 * attempt: `OIDC_STATE_INVALID` (state cookie missing, expired, used, or the
 * session changed since `start`), `OIDC_PROVIDER_ERROR`, `IDENTITY_IN_USE`
 * (the provider account belongs to another user, or the caller already has
 * another account of that provider). Errors of `POST …/start` itself are
 * problem documents (`429 RATE_LIMITED`, `503 DEPENDENCY_UNAVAILABLE`).
 */
export const OIDC_LINK_ERRORS = [
  'OIDC_STATE_INVALID',
  'OIDC_PROVIDER_ERROR',
  'IDENTITY_IN_USE',
] as const;
export type OidcLinkError = (typeof OIDC_LINK_ERRORS)[number];

export const oidcLinkErrorSchema = z.enum(OIDC_LINK_ERRORS).meta({
  id: 'OidcLinkError',
  description: '`error` of `/account/connections?error=` after linking an OIDC identity',
});

/** One identity of the caller (`GET /api/v1/me/identities`). */
export const meIdentitySchema = z
  .object({
    id: idOf('idn'),
    provider: z.string().meta({ description: 'Provider slug', example: 'keycloak' }),
    provider_name: z.string().meta({
      description:
        'Button label of the provider (`OIDC_<SLUG>_NAME`); the slug when the provider is no ' +
        'longer configured',
    }),
    email: z.string().nullable().meta({
      description: 'Email the provider reported last (display only; never used to sign in)',
    }),
    created_at: isoDateTimeSchema,
    last_login_at: isoDateTimeSchema.nullable().meta({
      description: 'Last sign-in through this identity; `null` when never used to sign in',
    }),
  })
  .meta({ id: 'MeIdentity' });
export type MeIdentity = z.infer<typeof meIdentitySchema>;

export const meIdentityListSchema = z
  .object({ items: z.array(meIdentitySchema).meta({ description: 'Oldest first' }) })
  .meta({ id: 'MeIdentityList' });
export type MeIdentityList = z.infer<typeof meIdentityListSchema>;

export const meIdentityParamsSchema = z.object({ userIdentityId: idOf('idn') });
