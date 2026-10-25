import {
  oidcCallbackQuerySchema,
  oidcProviderParamsSchema,
  oidcStartQuerySchema,
  type AuthProvidersResponse,
  type OidcCallbackQuery,
  type OidcStartQuery,
} from '@cellhive/contracts';
import { Controller, Get, Inject, Param, Query, Req, Res } from '@nestjs/common';

import { OidcStateCookie } from '../../common/auth/oidc/state-cookie.js';
import {
  OptionalSessionPrincipal,
  Public,
  type SessionPrincipal,
} from '../../common/auth/principal.js';
import { requestMetaOf } from '../../common/auth/request-meta.js';
import { SessionService } from '../../common/auth/session.service.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';

import { OidcLoginService } from './oidc.service.js';

import type { FastifyReply, FastifyRequest } from 'fastify';

const providerPipe = new ZodValidationPipe(oidcProviderParamsSchema);

/** `302` that is never cached nor sent with a `Referer` (the URL may carry `state`). */
async function redirect(reply: FastifyReply, location: string): Promise<void> {
  await reply
    .status(302)
    .header('location', location)
    .header('cache-control', 'no-store')
    .header('referrer-policy', 'no-referrer')
    .send();
}

/** Sign-in with OIDC (CONTRACTS §27.1–27.2; BACKLOG T707, ADR-36 §3). */
@Controller('auth')
@Public()
export class OidcController {
  constructor(
    @Inject(OidcLoginService) private readonly oidc: OidcLoginService,
    @Inject(OidcStateCookie) private readonly stateCookie: OidcStateCookie,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  @Get('providers')
  providers(): AuthProvidersResponse {
    return this.oidc.providers();
  }

  @Get('oidc/:provider/start')
  async start(
    @Param(providerPipe) params: { provider: string },
    @Query(new ZodValidationPipe(oidcStartQuerySchema)) query: OidcStartQuery,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const result = await this.oidc.start(params.provider, query.next, requestMetaOf(request));
    if (result.cookie !== null) this.stateCookie.set(reply, request, result.cookie);
    await redirect(reply, result.location);
  }

  @Get('oidc/:provider/callback')
  async callback(
    @Param(providerPipe) params: { provider: string },
    @Query(new ZodValidationPipe(oidcCallbackQuerySchema)) query: OidcCallbackQuery,
    @OptionalSessionPrincipal() previous: SessionPrincipal | undefined,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    // One use: the state cookie is cleared before anything else.
    const cookie = this.stateCookie.read(request);
    this.stateCookie.clear(reply, request);
    const result = await this.oidc.callback(
      params.provider,
      query,
      cookie,
      previous,
      requestMetaOf(request),
    );
    if (result.kind !== 'signed_in') {
      await redirect(reply, result.location);
      return;
    }
    this.sessions.setCookies(reply, request, result.token, result.session.id);
    await redirect(reply, result.next);
  }
}
