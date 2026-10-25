import { isId } from '@cellhive/contracts';
import { AppError } from '@cellhive/server-core/errors';
import {
  applyDecorators,
  createParamDecorator,
  Inject,
  Injectable,
  SetMetadata,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { principalOf } from '../auth/principal.js';

import {
  AccessService,
  notFound,
  type BaseAccess,
  type BaseAccessLevel,
} from './access.service.js';

import type { FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `BaseAccessGuard` for routes decorated with `@RequireBase`. */
    baseAccess?: BaseAccess;
  }
}

export interface RequireBaseOptions {
  /** Route parameter holding the base ID. Default `baseId`. */
  readonly param?: string;
}

interface RequireBaseMetadata {
  readonly level: BaseAccessLevel;
  readonly param: string;
}

const REQUIRE_BASE = 'app:requireBase';

/**
 * Resolves the base named by a route parameter with the caller's effective
 * access (SPEC §14.1) before the handler runs. A base the caller cannot read
 * (missing, other organization, no role) is `404 NOT_FOUND`, never `403`; a
 * readable base below `level` is `403 PERMISSION_DENIED`. The handler reads
 * the result with `@CurrentBase()`.
 *
 * Runs after the global `AuthGuard`, so the principal is known.
 */
@Injectable()
export class BaseAccessGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AccessService) private readonly access: AccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const metadata = this.reflector.getAllAndOverride<RequireBaseMetadata | undefined>(
      REQUIRE_BASE,
      [context.getHandler(), context.getClass()],
    );
    if (metadata === undefined) return true;
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const principal = principalOf(request);
    const params = request.params as Record<string, string | undefined>;
    const baseId = params[metadata.param];
    // A malformed ID cannot name an existing base.
    if (!isId('bse', baseId)) throw notFound();
    request.baseAccess = await this.access.requireBase(principal, baseId, metadata.level);
    return true;
  }
}

/** Requires `level` access to the base in `:baseId` (see `BaseAccessGuard`). */
export function RequireBase(
  level: BaseAccessLevel,
  options: RequireBaseOptions = {},
): MethodDecorator & ClassDecorator {
  return applyDecorators(
    SetMetadata<string, RequireBaseMetadata>(REQUIRE_BASE, {
      level,
      param: options.param ?? 'baseId',
    }),
    UseGuards(BaseAccessGuard),
  );
}

/** The base resolved by `@RequireBase` for this request. */
export const CurrentBase = createParamDecorator(
  (_data: unknown, context: ExecutionContext): BaseAccess => {
    const access = context.switchToHttp().getRequest<FastifyRequest>().baseAccess;
    if (access === undefined) {
      // Programming error: the route lacks @RequireBase.
      throw new AppError('INTERNAL', { params: { reason: 'route without @RequireBase' } });
    }
    return access;
  },
);
