import {
  idOf,
  memberPasswordResetRequestSchema,
  type Id,
  type MemberPasswordResetRequest,
  type PasswordResetLink,
} from '@cellhive/contracts';
import { Body, Controller, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';

import { CurrentPrincipal, type Principal } from '../../common/auth/principal.js';
import { requestMetaOf } from '../../common/auth/request-meta.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';

import { PasswordResetService } from './password-reset.service.js';

import type { FastifyRequest } from 'fastify';

/** `POST /api/v1/orgs/:orgId/members/:userId/password-reset` (SPEC §14.2, CONTRACTS §12.1). */
@Controller('orgs/:orgId/members/:userId/password-reset')
export class MemberPasswordResetController {
  constructor(@Inject(PasswordResetService) private readonly passwordReset: PasswordResetService) {}

  @Post()
  @HttpCode(201)
  create(
    @Param('orgId', new ZodValidationPipe(idOf('org'))) orgId: Id<'org'>,
    @Param('userId', new ZodValidationPipe(idOf('usr'))) userId: Id<'usr'>,
    // The body is optional: no body = `{ revoke_tokens: true }` (T802).
    @Body(new ZodValidationPipe(memberPasswordResetRequestSchema.optional()))
    body: MemberPasswordResetRequest | undefined,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<PasswordResetLink> {
    return this.passwordReset.createForMember(
      principal,
      orgId,
      userId,
      { revokeTokens: body?.revoke_tokens ?? true },
      requestMetaOf(request),
    );
  }
}
