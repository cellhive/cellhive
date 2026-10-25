import { AppError, isAppError } from '@cellhive/server-core/errors';
import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { ApiRateLimits } from '../rate-limit/api-rate-limits.js';

import { ApiTokenAuthService, BEARER_CHALLENGE, bearerTokenOf } from './api-token-auth.service.js';
import { PUBLIC_ACCESS, type PublicAccess } from './principal.js';
import { requestMetaOf } from './request-meta.js';
import { CSRF_SAFE_METHODS, SessionService } from './session.service.js';

import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Global guard (registered as `APP_GUARD`), deny by default:
 * 1. a request with an `Authorization` header on a non-public route is
 *    authenticated by that header only (ADR-36 §1): `Bearer cht_…` →
 *    `ApiTokenAuthService`; anything else, or a bad token, is `401` with
 *    `WWW-Authenticate: Bearer error="invalid_token"`, counted against
 *    `ApiRateLimits.bearerFailures` per IP
 *    (300/min, `API_TOKEN_BEARER_FAILURES_PER_IP`). The cookie is never
 *    read then, and there is no CSRF check (browsers do not attach this
 *    header by themselves);
 * 2. otherwise resolves the session cookie into `request.principal`; for a
 *    request authenticated by the cookie whose method is not
 *    GET/HEAD/OPTIONS, requires the signed double-submit CSRF token
 *    (`403 CSRF_INVALID`), on public routes too;
 * 3. requires a principal unless the route is `@Public()`
 *    (`401 UNAUTHENTICATED`).
 * `@Public()` routes ignore `Authorization` altogether. An invalid or
 * expired cookie is cleared and treated as absent. What a token may do on
 * the route is `ScopeGuard`'s check, right after this one.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(ApiTokenAuthService) private readonly apiTokens: ApiTokenAuthService,
    @Inject(ApiRateLimits) private readonly limits: ApiRateLimits,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const access = this.reflector.getAllAndOverride<PublicAccess | undefined>(PUBLIC_ACCESS, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (access === 'ignore') return true;

    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();

    const authorization = request.headers.authorization;
    if (access === undefined && authorization !== undefined) {
      await this.authenticateBearer(request, reply, authorization);
      return true;
    }

    const token = this.sessions.tokenOf(request);
    if (token !== undefined) {
      const resolved = await this.sessions.resolve(token);
      if (resolved === undefined) {
        this.sessions.clearCookies(reply, request);
      } else {
        const sessionId = resolved.principal.session.id;
        if (
          !CSRF_SAFE_METHODS.has(request.method) &&
          !this.sessions.csrfValid(request, sessionId)
        ) {
          throw new AppError('CSRF_INVALID', {
            detail: 'Missing or invalid X-CSRF-Token header.',
          });
        }
        request.principal = resolved.principal;
        if (resolved.refreshed) {
          this.sessions.setSessionCookie(reply, request, token);
          this.sessions.setCsrfCookie(reply, request, sessionId);
        }
      }
    }

    if (access === undefined && request.principal === undefined) {
      throw new AppError('UNAUTHENTICATED', { detail: 'Sign in to continue.' });
    }
    return true;
  }

  private async authenticateBearer(
    request: FastifyRequest,
    reply: FastifyReply,
    authorization: string,
  ): Promise<void> {
    const ip = requestMetaOf(request).ip ?? 'unknown';
    const token = bearerTokenOf(authorization);
    await this.limits.ensureBearerAttemptAllowed(ip, token);
    try {
      if (token === undefined) {
        throw new AppError('UNAUTHENTICATED', {
          detail: 'Use "Authorization: Bearer <API token>".',
        });
      }
      request.principal = await this.apiTokens.authenticate(token);
      await this.limits.rememberValidBearer(token);
    } catch (error) {
      if (isAppError(error) && error.status === 401) {
        void reply.header('www-authenticate', BEARER_CHALLENGE);
        // Counts the failure; the one that crosses the limit is already `429`.
        await this.limits.hitBearerFailure(ip);
      }
      throw error;
    }
  }
}
