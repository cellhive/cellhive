import { CSRF_COOKIE, SESSION_COOKIE } from '../../auth.js';
import {
  authProvidersResponseSchema,
  meIdentityListSchema,
  meIdentityParamsSchema,
  OIDC_LINK_MAX_AUTH_AGE_SECONDS,
  OIDC_LINK_RETURN_PATH,
  oidcLinkStartResponseSchema,
  OIDC_STATE_COOKIE,
  OIDC_STATE_COOKIE_PATH,
  OIDC_STATE_TTL_SECONDS,
  oidcCallbackQuerySchema,
  oidcProviderParamsSchema,
  oidcStartQuerySchema,
} from '../../oidc.js';
import { problemResponse, type RouteRegistrar } from '../types.js';

import { SESSION_SECURITY_SCHEME } from './auth.js';
import { register } from './route-spec.js';

import type { z } from 'zod';

const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });

const LOGIN_ERROR =
  'Failures redirect to `/login?error=<CODE>` (CONTRACTS §27.2: `OIDC_STATE_INVALID`, ' +
  '`OIDC_PROVIDER_ERROR`, `OIDC_ACCOUNT_EXISTS`, `OIDC_SIGNUP_DISABLED`, ' +
  '`OIDC_EMAIL_UNVERIFIED`, `OIDC_DOMAIN_NOT_ALLOWED`, `UNAUTHENTICATED` for a disabled ' +
  'account, `RATE_LIMITED`), never a problem document.';

const LINK_ERROR =
  `Failures redirect to \`${OIDC_LINK_RETURN_PATH}?error=<CODE>\` (CONTRACTS §27.3: ` +
  '`OIDC_STATE_INVALID` — also when the session changed since `start` —, ' +
  '`OIDC_PROVIDER_ERROR` — also an ID token without a recent `auth_time` —, `IDENTITY_IN_USE`).';

/** Sign-in with OIDC (CONTRACTS §27.1–27.2; BACKLOG T707, ADR-36 §3). */
export const registerOidcRoutes: RouteRegistrar = (registry, components) => {
  const problem = (description: string) => problemResponse(components, description);

  registry.registerPath({
    method: 'get',
    path: '/api/v1/auth/providers',
    operationId: 'listAuthProviders',
    tags: ['auth'],
    summary: 'Sign-in options: the configured OIDC providers',
    description:
      'Public. Providers are configured by the operator (`OIDC_PROVIDERS`, SPEC §20); the ' +
      'list is also in `auth_config.providers` of `GET /setup`.',
    security: [],
    responses: {
      200: { description: 'Sign-in options', content: json(authProvidersResponseSchema) },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/auth/oidc/{provider}/start',
    operationId: 'startOidcLogin',
    tags: ['auth'],
    summary: 'Start signing in with an OIDC provider (browser navigation)',
    description:
      'Public; opened by the browser, not by `fetch`. Creates `state`, `nonce` and a PKCE ' +
      `\`code_verifier\`, stores them with \`next\` in the encrypted HttpOnly \`${OIDC_STATE_COOKIE}\` ` +
      `cookie (\`Path=${OIDC_STATE_COOKIE_PATH}\`, ${String(OIDC_STATE_TTL_SECONDS / 60)} minutes, ` +
      'one use) and redirects to the authorization endpoint of the provider ' +
      '(`response_type=code`, `code_challenge_method=S256`). 20 per minute per IP, beyond: ' +
      'redirect to `/login?error=RATE_LIMITED`; provider unreachable: ' +
      '`/login?error=OIDC_PROVIDER_ERROR`.',
    security: [],
    request: { params: oidcProviderParamsSchema, query: oidcStartQuerySchema },
    responses: {
      302: {
        description: 'Redirect to the provider (or to `/login?error=…`)',
        headers: {
          Location: { description: 'Authorization URL', schema: { type: 'string' } },
          'Set-Cookie': {
            description: `\`${OIDC_STATE_COOKIE}\` state cookie`,
            schema: { type: 'string' },
          },
        },
      },
      404: problem('`NOT_FOUND`: no such provider'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/auth/oidc/{provider}/callback',
    operationId: 'completeOidcLogin',
    tags: ['auth'],
    summary: 'Redirect URI of an OIDC provider: finish signing in',
    description:
      `Public; reached through the provider's redirect. The \`${OIDC_STATE_COOKIE}\` cookie is ` +
      'cleared first (one use) and `state` compared in constant time; the code is exchanged ' +
      '(PKCE, `client_secret_basic`) and the ID token checked (issuer, audience, `azp`, expiry, ' +
      '`iat`, `nonce`, JWKS signature). The identity is `(provider, sub)`; an unknown one ' +
      'creates an account only when the provider allows sign-up, the email is verified and ' +
      `its domain allowed (§27.2). Success: new session (\`${SESSION_COOKIE}\` + ` +
      `\`${CSRF_COOKIE}\`, a previous session is revoked) and redirect to \`next\`. A user with ` +
      'the same email is linked only when the provider sets `LINK_BY_EMAIL=true` and ' +
      '`email_verified` is the JSON boolean `true`, else `OIDC_ACCOUNT_EXISTS`. ' +
      `${LOGIN_ERROR} An attempt started by \`POST /me/identities/{provider}/start\` links the ` +
      `identity to the signed-in user instead (no new session) and redirects to ` +
      `\`${OIDC_LINK_RETURN_PATH}\`; ${LINK_ERROR}`,
    security: [],
    request: { params: oidcProviderParamsSchema, query: oidcCallbackQuerySchema },
    responses: {
      302: {
        description: 'Redirect to `next` (signed in) or to `/login?error=<CODE>`',
        headers: {
          Location: { description: 'Internal path', schema: { type: 'string' } },
        },
      },
      404: problem('`NOT_FOUND`: no such provider'),
    },
  });
  register(registry, problem, {
    method: 'get',
    path: '/api/v1/me/identities',
    operationId: 'listMyIdentities',
    tag: 'auth',
    summary: 'My connected sign-in providers',
    description:
      'Session only. The OIDC identities of the caller, oldest first (CONTRACTS §27.3); the ' +
      'subject (`sub`) is never returned.',
    status: 200,
    response: meIdentityListSchema,
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/me/identities/{provider}/start',
    operationId: 'startOidcLink',
    tags: ['auth'],
    summary: 'Start connecting an OIDC provider to my account',
    description:
      'Session only, with the CSRF header (`X-CSRF-Token`); a `POST` so that another site ' +
      "cannot start a link with the caller's session. Sets the state cookie in `link` mode " +
      `(\`${OIDC_STATE_COOKIE}\`, \`Path=${OIDC_STATE_COOKIE_PATH}\`, bound to the caller and ` +
      'the current session) and returns the authorization URL, which the web client opens ' +
      'with a top-level navigation. The request carries `max_age=0` (the provider ' +
      'authenticates the person again) and the callback requires an ID token `auth_time` at ' +
      `most ${String(OIDC_LINK_MAX_AUTH_AGE_SECONDS / 60)} minutes old. The provider redirects ` +
      'to the same `…/callback`, which attaches `(provider, sub)` to the caller: the identity ' +
      'of another user, or another account of the same provider already connected → ' +
      '`IDENTITY_IN_USE`; the same account again → its email is refreshed. Audited as ' +
      '`auth.identity_linked` (one entry per organization of the user). Shares the 20 per ' +
      `minute per IP limit of sign-in; ignores \`Idempotency-Key\`. ${LINK_ERROR}`,
    security: [{ [SESSION_SECURITY_SCHEME]: [] }],
    request: { params: oidcProviderParamsSchema },
    responses: {
      200: {
        description: 'Authorization URL to navigate to',
        headers: {
          'Set-Cookie': {
            description: `\`${OIDC_STATE_COOKIE}\` state cookie (link mode)`,
            schema: { type: 'string' },
          },
        },
        content: json(oidcLinkStartResponseSchema),
      },
      401: problem('`UNAUTHENTICATED`'),
      403: problem(
        '`CSRF_INVALID` (missing or wrong `X-CSRF-Token`), or `INSUFFICIENT_SCOPE`: called ' +
          'with an API token (session only)',
      ),
      404: problem('`NOT_FOUND`: no such provider'),
      422: problem('`VALIDATION_FAILED`: malformed provider slug'),
      429: problem(
        '`RATE_LIMITED` with `Retry-After`: more than 20 starts per minute from this IP',
      ),
      503: problem('`DEPENDENCY_UNAVAILABLE`: the provider did not answer discovery'),
    },
  });

  register(registry, problem, {
    method: 'delete',
    path: '/api/v1/me/identities/{userIdentityId}',
    operationId: 'deleteMyIdentity',
    tag: 'auth',
    summary: 'Disconnect a sign-in provider from my account',
    description:
      "Session only. Removes one identity of the caller (another user's or an unknown id → " +
      '`404`). Audited as `auth.identity_unlinked` (one entry per organization of the user).',
    params: meIdentityParamsSchema,
    status: 204,
    errors: {
      422:
        '`VALIDATION_FAILED`: malformed id, or `errors[].code` `LAST_LOGIN_METHOD` (path ' +
        '`userIdentityId`): the caller has no password and this is their only identity',
    },
  });
};
