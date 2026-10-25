import { z } from 'zod';

import {
  CSRF_COOKIE,
  CSRF_HEADER,
  forgotPasswordRequestSchema,
  loginRequestSchema,
  memberPasswordResetRequestSchema,
  meResponseSchema,
  passwordResetLinkSchema,
  passwordResetRequestSchema,
  SESSION_COOKIE,
  setupRequestSchema,
  setupResponseSchema,
  setupStatusSchema,
} from '../../auth.js';
import { idOf } from '../../ids.js';
import { problemResponse, type RouteRegistrar } from '../types.js';

import { IDEMPOTENCY_NOTE, idempotencyHeaders, withIdempotencyConflict } from './idempotency.js';

/** Security scheme name of the session cookie. */
export const SESSION_SECURITY_SCHEME = 'sessionCookie';
/** Personal API tokens (CONTRACTS §26, T704); operations list the scope they need. */
export const API_TOKEN_SECURITY_SCHEME = 'apiToken';

const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });

const CSRF_NOTE =
  `Requests other than GET/HEAD/OPTIONS that carry the session cookie must send the ` +
  `value of the \`${CSRF_COOKIE}\` cookie in the \`${CSRF_HEADER}\` header, otherwise ` +
  '`403 CSRF_INVALID`.';

/**
 * First-time setup, sign-in/out, `GET /me` and password reset
 * (SPEC §13.1, §14.1A, §14.2; CONTRACTS §5A, §12.1).
 */
export const registerAuthRoutes: RouteRegistrar = (registry, components) => {
  registry.registerComponent('securitySchemes', SESSION_SECURITY_SCHEME, {
    type: 'apiKey',
    in: 'cookie',
    name: SESSION_COOKIE,
    description: `Session cookie set by \`POST /api/v1/auth/login\`. ${CSRF_NOTE}`,
  });
  registry.registerComponent('securitySchemes', API_TOKEN_SECURITY_SCHEME, {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'cht_…',
    description:
      'Personal API token (`Authorization: Bearer cht_…`, CONTRACTS §26). The header wins over ' +
      'the session cookie (never read then) and needs no CSRF token. An operation accepts a ' +
      'token only when its `security` lists `apiToken` with the scope it needs ' +
      '(`x-api-token-scope`; `*:write` never implies `*:read`); other routes answer ' +
      '`403 INSUFFICIENT_SCOPE` (`errors[0].params.required`: the scope, or `["session"]`). The ' +
      "token acts as its user's current access, limited to its organization and `base_ids` " +
      '(anything outside → `404`). Malformed, unknown, revoked (`TOKEN_REVOKED`), expired ' +
      '(`TOKEN_EXPIRED`) or disabled tokens → `401` with ' +
      '`WWW-Authenticate: Bearer error="invalid_token"`. Rate limits: 60 requests/s per token, ' +
      '20 requests/s per token and base (`429 RATE_LIMITED` + `Retry-After`).',
  });
  const session = [{ [SESSION_SECURITY_SCHEME]: [] }];
  const problem = (description: string) => problemResponse(components, description);

  registry.registerPath({
    method: 'get',
    path: '/api/v1/setup',
    operationId: 'getSetupStatus',
    tags: ['setup'],
    summary: 'Whether first-time setup is still required, and public sign-in settings',
    description:
      'Public. `auth_config` tells the sign-in screen which options exist (e.g. whether ' +
      '"forgot password" can email a link).',
    security: [],
    responses: {
      200: { description: 'Setup status', content: json(setupStatusSchema) },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/setup',
    operationId: 'completeSetup',
    tags: ['setup'],
    summary: 'Create the first user and organization',
    description:
      'Only while the instance has no user: creates the user, the organization and the ' +
      'owner membership in one transaction. Does not sign in. Rate limited per IP.',
    security: [],
    request: { body: { content: json(setupRequestSchema), required: true } },
    responses: {
      201: { description: 'Instance set up', content: json(setupResponseSchema) },
      409: problem('`SETUP_COMPLETED`: a user already exists'),
      422: problem('`VALIDATION_FAILED` (weak password: `PASSWORD_TOO_COMMON`, `TOO_SMALL`)'),
      429: problem('`RATE_LIMITED`, with `Retry-After`'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/auth/login',
    operationId: 'login',
    tags: ['auth'],
    summary: 'Sign in with email and password',
    description:
      `Sets the HttpOnly \`${SESSION_COOKIE}\` cookie (new session; a previous session sent ` +
      `with the request is revoked) and the readable \`${CSRF_COOKIE}\` cookie. Sessions ` +
      'expire after 30 days without activity. 10 consecutive failures for one email within ' +
      '15 minutes lock it for 15 minutes.',
    security: [],
    request: { body: { content: json(loginRequestSchema), required: true } },
    responses: {
      204: { description: 'Signed in; cookies set' },
      401: problem('`UNAUTHENTICATED`: wrong email or password'),
      423: problem('`ACCOUNT_LOCKED`, with `Retry-After`'),
      429: problem('`RATE_LIMITED` (per IP), with `Retry-After`'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/auth/logout',
    operationId: 'logout',
    tags: ['auth'],
    summary: 'Sign out',
    description: `Revokes the current session and clears the cookies. ${CSRF_NOTE}`,
    security: [...session, {}],
    responses: {
      204: { description: 'Signed out' },
      403: problem('`CSRF_INVALID`'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/me',
    operationId: 'getMe',
    tags: ['auth'],
    summary: 'The signed-in user',
    description: `Also re-issues the \`${CSRF_COOKIE}\` cookie when it is missing.`,
    security: session,
    responses: {
      200: { description: 'The signed-in user', content: json(meResponseSchema) },
      401: problem('`UNAUTHENTICATED`'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/auth/forgot-password',
    operationId: 'forgotPassword',
    tags: ['auth'],
    summary: 'Email a password reset link',
    description:
      'Always answers 202, whether or not the email exists. Sends a link only when SMTP is ' +
      'configured and the account has a password. Rate limited to 5 per hour per email and ' +
      '20 per hour per IP.',
    security: [],
    request: { body: { content: json(forgotPasswordRequestSchema), required: true } },
    responses: {
      202: { description: 'Accepted' },
      429: problem('`RATE_LIMITED`, with `Retry-After`'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/auth/password-reset/{token}',
    operationId: 'resetPassword',
    tags: ['auth'],
    summary: 'Set a new password with a reset link',
    description:
      'On success every session of the user is revoked and the account is unlocked. With ' +
      '`revoke_tokens` (default `true`) every API token of the user, in every organization, ' +
      'is revoked in the same transaction (T802).',
    security: [],
    request: {
      params: z.object({ token: z.string().meta({ description: 'Token from the reset link' }) }),
      body: { content: json(passwordResetRequestSchema), required: true },
    },
    responses: {
      204: { description: 'Password changed' },
      410: problem('`RESET_TOKEN_INVALID`: wrong, used or expired link'),
      422: problem('`VALIDATION_FAILED` (weak password)'),
      429: problem('`RATE_LIMITED`, with `Retry-After`'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/orgs/{orgId}/members/{userId}/password-reset',
    operationId: 'createMemberPasswordResetLink',
    tags: ['auth'],
    summary: 'Create a one-time password reset link for a member',
    description:
      'Organization owner/admin only. The member must belong to this organization only and ' +
      'must not own any organization; otherwise `403 PERMISSION_DENIED` (use the CLI ' +
      '`cellhive user reset-password`). The link is valid for 24 hours and returned only ' +
      `once (a replay with the same Idempotency-Key returns it again). The body is ` +
      'optional: with `revoke_tokens` (default `true`) every API token of the member is ' +
      'revoked when the link is created (T802). ' +
      `${IDEMPOTENCY_NOTE} ` +
      CSRF_NOTE,
    security: session,
    request: {
      params: z.object({ orgId: idOf('org'), userId: idOf('usr') }),
      headers: idempotencyHeaders,
      body: { content: json(memberPasswordResetRequestSchema), required: false },
    },
    responses: {
      201: { description: 'Link created', content: json(passwordResetLinkSchema) },
      401: problem('`UNAUTHENTICATED`'),
      403: problem('`PERMISSION_DENIED` or `CSRF_INVALID`'),
      404: problem('`NOT_FOUND`: organization or member not visible'),
      409: problem(withIdempotencyConflict(undefined)),
      422: problem('`VALIDATION_FAILED`: the user has no password (external sign-in)'),
      429: problem('`RATE_LIMITED`, with `Retry-After`'),
    },
  });
};
