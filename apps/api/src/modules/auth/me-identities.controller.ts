import {
  meIdentityParamsSchema,
  oidcProviderParamsSchema,
  type Id,
  type MeIdentityList,
  type OidcLinkStartResponse,
} from '@cellhive/contracts';
import { Controller, Delete, Get, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';

import { OidcStateCookie } from '../../common/auth/oidc/state-cookie.js';
import { CurrentPrincipal, sessionOf, type Principal } from '../../common/auth/principal.js';
import { requestMetaOf } from '../../common/auth/request-meta.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';

import { MeIdentitiesService } from './me-identities.service.js';
import { OidcLoginService } from './oidc.service.js';

import type { FastifyReply, FastifyRequest } from 'fastify';

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
