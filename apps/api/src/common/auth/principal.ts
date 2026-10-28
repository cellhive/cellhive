import { AppError } from '@cellhive/server-core/errors';
import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';

import type { ApiTokenScope, Id } from '@cellhive/contracts';
import type { Session, User } from '@cellhive/server-core';
import type { FastifyRequest } from 'fastify';

/** A user signed in with the session cookie (SPEC §14.2). */
export interface SessionPrincipal {
  readonly kind: 'session';
  readonly userId: Id<'usr'>;
  readonly user: User;
  readonly session: Session;
}

/**
 * A request authenticated with `Authorization: Bearer cht_…` (ADR-36 §1,
 * CONTRACTS §26.1). It acts as its user, limited to the token's
 * organization, scopes and bases (`AccessService`, `ScopeGuard`).
 */
export interface ApiTokenPrincipal {
  readonly kind: 'api_token';
  readonly userId: Id<'usr'>;
  readonly user: User;
  readonly organizationId: Id<'org'>;
  readonly tokenId: Id<'tok'>;
  readonly scopes: readonly ApiTokenScope[];
  /** `null`: every base of the organization the user can open. */
  readonly baseIds: readonly Id<'bse'>[] | null;
}

/** The authenticated caller of a request. */
export type Principal = SessionPrincipal | ApiTokenPrincipal;

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `AuthGuard` when the request carries a valid session or API token. */
    principal?: Principal;
  }
}

/**
 * Who a request counts as for the request policies: the API token
 * (`tok_…`) or the signed-in user (`usr_…`) — the key of the rate limits
 * (SPEC §13.1) and of `Idempotency-Key` (CONTRACTS §1.1).
 */
export function principalKeyOf(principal: Principal): string {
  return principal.kind === 'api_token' ? principal.tokenId : principal.userId;
}

/**
 * Session only (`api-token-scopes.ts`): `ScopeGuard` already refuses API
 * tokens with `403 INSUFFICIENT_SCOPE`; this keeps the type narrow.
 */
export function sessionOf(principal: Principal): SessionPrincipal {
  if (principal.kind !== 'session') {
    throw new AppError('INSUFFICIENT_SCOPE', {
      detail: 'This route needs a signed-in session; API tokens cannot use it.',
      errors: [
        {
          path: '',
          code: 'INSUFFICIENT_SCOPE',
          message: 'The API token does not allow this route',
          params: { required: ['session'] },
        },
      ],
    });
  }
  return principal;
}

/** Metadata key of `@Public()`. */
export const PUBLIC_ACCESS = 'app:publicAccess';

/**
 * - `optional`: no principal required; a session cookie, when valid, still
 *   authenticates the request and then CSRF is enforced.
 * - `ignore`: the route never uses the session (e.g. signed storage URLs,
 *   probes); the cookie is not even looked up.
 */
export type PublicAccess = 'optional' | 'ignore';

export interface PublicOptions {
  /** The route is authorised by other means (signature) and never reads the session. */
  readonly ignoreSession?: boolean;
}

/**
 * Opts a route (or controller) out of the authentication requirement of the
 * global `AuthGuard`. Everything else requires a principal: deny by default
 * (AGENTS.md rule 4).
 */
export const Public = (options: PublicOptions = {}): MethodDecorator & ClassDecorator =>
  SetMetadata<string, PublicAccess>(
    PUBLIC_ACCESS,
    options.ignoreSession === true ? 'ignore' : 'optional',
  );

/** The principal of a request that passed `AuthGuard`; throws 401 if absent. */
export function principalOf(request: FastifyRequest): Principal {
  const principal = request.principal;
  if (principal === undefined) {
    throw new AppError('UNAUTHENTICATED', { detail: 'Sign in to continue.' });
  }
  return principal;
}

/**
 * Injects the authenticated `Principal` (user + session):
 * `me(@CurrentPrincipal() principal: Principal)`. On a `@Public()` route
 * without a session it throws `401 UNAUTHENTICATED`; use
 * `@OptionalPrincipal()` there instead.
 */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Principal =>
    principalOf(context.switchToHttp().getRequest<FastifyRequest>()),
);

/** The principal when the request is authenticated, else `undefined`. */
export const OptionalPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Principal | undefined =>
    context.switchToHttp().getRequest<FastifyRequest>().principal,
);

/**
 * The cookie session of the request, else `undefined`: for the sign-in and
 * sign-out routes, which act on sessions. (`@Public()` routes ignore
 * `Authorization`, so they never see an API token principal anyway.)
 */
export const OptionalSessionPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): SessionPrincipal | undefined => {
    const principal = context.switchToHttp().getRequest<FastifyRequest>().principal;
    return principal?.kind === 'session' ? principal : undefined;
  },
);
