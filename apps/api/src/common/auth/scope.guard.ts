import {
  apiTokenRouteIndex,
  apiTokenRouteKey,
  INSUFFICIENT_SCOPE,
  type ApiTokenRouteScope,
  type ApiTokenScope,
} from '@cellhive/contracts';
import { AppError } from '@cellhive/server-core/errors';
import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';

import { RouteScopeService, scopeParamOf } from '../access/route-scope.service.js';
import { routeKeyOf } from '../idempotency/request-policies.js';

import type { ApiTokenPrincipal, Principal } from './principal.js';
import type { FastifyRequest } from 'fastify';

const ROUTES = apiTokenRouteIndex();

/** `403 INSUFFICIENT_SCOPE` with `errors[0].params.required = [required]` (CONTRACTS §26.3). */
function insufficientScope(required: ApiTokenScope | 'session'): AppError {
  return new AppError('INSUFFICIENT_SCOPE', {
    detail:
      required === 'session'
        ? 'This route needs a signed-in session; API tokens cannot use it.'
        : `This API token lacks the ${required} scope.`,
    errors: [
      {
        path: '',
        code: INSUFFICIENT_SCOPE,
        message: 'The API token does not allow this route',
        params: { required: [required] },
      },
    ],
  });
}

/**
 * A scope a route needs only for some requests, on top of its entry in the
 * route table (e.g. an import that creates a table also needs
 * `schema:write`, BACKLOG T705): `403 INSUFFICIENT_SCOPE` when an API token
 * lacks it; sessions pass.
 */
export function requireTokenScope(principal: Principal, scope: ApiTokenScope): void {
  if (principal.kind === 'api_token' && !principal.scopes.includes(scope)) {
    throw insufficientScope(scope);
  }
}

/**
 * What a route asks of an API token (CONTRACTS §26.3): its entry in
 * `API_TOKEN_ROUTE_SCOPES`, or `session` for a route without one (deny by
 * default). `HEAD` is answered by the `GET` route.
 */
export function apiTokenRouteScopeOf(
  method: string,
  routeUrl: string | undefined,
): ApiTokenRouteScope {
  if (routeUrl === undefined) return 'session';
  const verb = method.toUpperCase() === 'HEAD' ? 'GET' : method;
  return ROUTES.get(apiTokenRouteKey(verb, routeUrl))?.scope ?? 'session';
}

/**
 * Global guard right after `AuthGuard` (ADR-36 §1, BACKLOG T704): a request
 * authenticated by an API token needs the scope the route→scope table names
 * (`403 INSUFFICIENT_SCOPE`, `errors[0].params.required = [scope]`); a
 * session-only route (or one missing from the table) answers the same with
 * `required = ["session"]`. Sessions pass untouched.
 *
 * A route naming a resource the token cannot reach (another organization,
 * a base outside `base_ids`, or one its user cannot open) answers `404`
 * instead, like a missing resource, so that the scope error tells nothing
 * about resources outside the token's reach. The token's limits on data are
 * applied by `AccessService`.
 */
@Injectable()
export class ScopeGuard implements CanActivate {
  constructor(@Inject(RouteScopeService) private readonly scopes: RouteScopeService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const principal = request.principal;
    if (principal?.kind !== 'api_token') return true;
    const required = apiTokenRouteScopeOf(request.method, request.routeOptions.url);
    if (required !== 'session' && required !== 'public' && principal.scopes.includes(required)) {
      return true;
    }
    await this.requireReachable(request, principal);
    throw insufficientScope(required === 'public' ? 'session' : required);
  }

  /** `404` when the route names an organization resource the token cannot reach. */
  private async requireReachable(
    request: FastifyRequest,
    principal: ApiTokenPrincipal,
  ): Promise<void> {
    const routeKey = routeKeyOf(request.routeOptions.url);
    if (routeKey === undefined || scopeParamOf(routeKey) === undefined) return;
    const params = (request.params ?? {}) as Readonly<Record<string, unknown>>;
    if ((await this.scopes.resolve(principal, params)) === undefined) {
      throw new AppError('NOT_FOUND');
    }
  }
}
