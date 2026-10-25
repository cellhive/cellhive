import { IDEMPOTENT_REPLAYED_HEADER } from '@cellhive/contracts';
import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { from, lastValueFrom, type Observable } from 'rxjs';

import {
  BASE_SCOPE_PARAMS,
  RouteScopeService,
  scopeParamOf,
  type RouteScope,
} from '../access/route-scope.service.js';
import { principalKeyOf, type Principal } from '../auth/principal.js';
import { ApiRateLimits } from '../rate-limit/api-rate-limits.js';

import { IdempotencyService, idempotentRequestOf } from './idempotency.service.js';
import {
  BASE_RATE_LIMIT_EXEMPT_ROUTES,
  idempotencyModeOf,
  routeKeyOf,
} from './request-policies.js';

import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Global interceptor (`APP_INTERCEPTOR`) applying the cross-cutting request
 * policies to authenticated routes, after `AuthGuard` and before
 * validation and the handler:
 *
 * - rate limits (SPEC §13.1): every request with a principal counts
 *   against the per-principal limit (60/s) — keyed by the API token
 *   (`tok_…`) for token requests, by the user (`usr_…`) for sessions; a
 *   request on a base, a table or a field also counts against the
 *   per-principal-and-base limit (20/s),
 *   except `BASE_RATE_LIMIT_EXEMPT_ROUTES`. `429 RATE_LIMITED` with
 *   `Retry-After`. Routes without a principal (probes, metrics, signed
 *   storage URLs, sign-in) are not counted here; the public endpoints have
 *   their own per-IP/per-email limits;
 * - `Idempotency-Key` on every write `POST` (CONTRACTS §1.1) except
 *   `IDEMPOTENCY_EXCLUDED_ROUTES`. The key is stored in the organization the
 *   route names (`RouteScopeService`), per principal key (the token or the
 *   user, like the rate limits); a route whose resource the caller
 *   cannot reach runs without it and answers `404` from the handler. The
 *   stored response is the handler's status and body; a replay sets
 *   `Idempotent-Replayed: true`.
 */
@Injectable()
export class RequestPoliciesInterceptor implements NestInterceptor {
  constructor(
    @Inject(RouteScopeService) private readonly scopes: RouteScopeService,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(ApiRateLimits) private readonly limits: ApiRateLimits,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const principal = request.principal;
    if (principal === undefined) return next.handle();
    return from(this.apply(request, http.getResponse<FastifyReply>(), principal, next));
  }

  private async apply(
    request: FastifyRequest,
    reply: FastifyReply,
    principal: Principal,
    next: CallHandler,
  ): Promise<unknown> {
    const routeKey = routeKeyOf(request.routeOptions.url);
    const params = (request.params ?? {}) as Readonly<Record<string, unknown>>;

    let resolved: Promise<RouteScope | undefined> | undefined;
    const scopeOf = () => (resolved ??= this.scopes.resolve(principal, params));

    // Per token for API tokens (60/s each), per user for sessions (SPEC §13.1).
    const principalKey = principalKeyOf(principal);
    await this.limits.hitPrincipal(principalKey);
    const scopeParam = routeKey === undefined ? undefined : scopeParamOf(routeKey);
    if (
      routeKey !== undefined &&
      scopeParam !== undefined &&
      BASE_SCOPE_PARAMS.has(scopeParam) &&
      !BASE_RATE_LIMIT_EXEMPT_ROUTES.has(routeKey)
    ) {
      const baseId = (await scopeOf())?.baseId;
      if (baseId !== undefined) await this.limits.hitBase(principalKey, baseId);
    }

    const handle = (): Promise<unknown> =>
      lastValueFrom(next.handle() as Observable<unknown>, { defaultValue: undefined });
    if (request.method !== 'POST' || routeKey === undefined) return handle();
    const mode = idempotencyModeOf(routeKey);
    if (mode === 'excluded' || mode === 'unscoped') return handle();
    const idempotent = idempotentRequestOf(request);
    if (idempotent.key === undefined) return handle();

    const scope = mode === 'home' ? await this.scopes.home(principal) : await scopeOf();
    if (scope === undefined) return handle();

    const outcome = await this.idempotency.run(
      scope.org.scope,
      principalKey,
      idempotent,
      async () => {
        const body = await handle();
        return { status: reply.statusCode, body };
      },
    );
    if (outcome.replayed) {
      void reply.status(outcome.status);
      void reply.header(IDEMPOTENT_REPLAYED_HEADER, 'true');
    }
    return outcome.body;
  }
}
