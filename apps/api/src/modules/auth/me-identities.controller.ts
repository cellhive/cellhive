import {
  meIdentityParamsSchema,
  oidcProviderParamsSchema,
  type Id,
  type MeIdentityList,
  type OidcLinkStartResponse,
} from '@cellhive/contracts';
import { AppError } from '@cellhive/server-core/errors';
import { Controller, Delete, Get, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';

import { OidcStateCookie } from '../../common/auth/oidc/state-cookie.js';
import {
  CurrentPrincipal,
  type Principal,
  type SessionPrincipal,
} from '../../common/auth/principal.js';
import { requestMetaOf } from '../../common/auth/request-meta.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';

import { MeIdentitiesService } from './me-identities.service.js';
import { OidcLoginService } from './oidc.service.js';

import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Session only (`api-token-scopes.ts`): `ScopeGuard` already refuses API
 * tokens with `403 INSUFFICIENT_SCOPE`; this keeps the type narrow.
 */
function sessionOf(principal: Principal): SessionPrincipal {
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

/** Connected accounts of the caller (CONTRACTS §27.3; BACKLOG T708, ADR-36 §3). */
@Controller('me/identities')
export class MeIdentitiesController {
  constructor(
    @Inject(MeIdentitiesService) private readonly identities: MeIdentitiesService,
    @Inject(OidcLoginService) private readonly oidc: OidcLoginService,
    @Inject(OidcStateCookie) private readonly stateCookie: OidcStateCookie,
  ) {}

  @Get()
  list(@CurrentPrincipal() principal: Principal): Promise<MeIdentityList> {
    return this.identities.list(sessionOf(principal));
  }

  /**
   * Sets the `link` mode state cookie and returns the authorization URL; the
   * web client then navigates to it. A `POST` (CSRF-checked by `AuthGuard`),
   * so another site cannot start a link with the caller's session.
   */
  @Post(':provider/start')
  @HttpCode(200)
  async start(
    @Param(new ZodValidationPipe(oidcProviderParamsSchema)) params: { provider: string },
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<OidcLinkStartResponse> {
    const session = sessionOf(principal);
    const result = await this.oidc.start(params.provider, undefined, requestMetaOf(request), {
      userId: session.userId,
      sessionId: session.session.id,
    });
    if (result.cookie !== null) this.stateCookie.set(reply, request, result.cookie);
    void reply.header('cache-control', 'no-store');
    return { authorization_url: result.location };
  }

  @Delete(':userIdentityId')
  @HttpCode(204)
  async unlink(
    @Param(new ZodValidationPipe(meIdentityParamsSchema)) params: { userIdentityId: Id<'idn'> },
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.identities.unlink(
      sessionOf(principal),
      params.userIdentityId,
      requestMetaOf(request),
    );
  }
}
