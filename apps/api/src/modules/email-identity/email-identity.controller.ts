import {
  createEmailIdentityRequestSchema,
  emailIdentityIdSchema,
  emailVerificationTokenRequestSchema,
  idOf,
  updateEmailIdentityRequestSchema,
  verifyEmailIdentityCodeRequestSchema,
  type BaseEmailIdentityList,
  type CreateEmailIdentityInput,
  type EmailIdentityDto,
  type EmailIdentityList,
  type EmailIdentityMutation,
  type EmailIdentityUsages,
  type EmailVerificationConfirmed,
  type EmailVerificationOutcome,
  type EmailVerificationPreview,
  type EmailVerificationTokenRequest,
  type Id,
  type UpdateEmailIdentityRequest,
  type VerifyEmailIdentityCodeRequest,
} from '@cellhive/contracts';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';

import { CurrentPrincipal, Public, type Principal } from '../../common/auth/principal.js';
import { requestMetaOf } from '../../common/auth/request-meta.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';

import { EmailIdentityService } from './email-identity.service.js';

import type { FastifyRequest } from 'fastify';

const orgIdPipe = new ZodValidationPipe(idOf('org'));
const baseIdPipe = new ZodValidationPipe(idOf('bse'));
const identityIdPipe = new ZodValidationPipe(emailIdentityIdSchema);

/** Sender identities (CONTRACTS §23.3, BACKLOG T530). */
@Controller()
export class EmailIdentityController {
  constructor(@Inject(EmailIdentityService) private readonly identities: EmailIdentityService) {}

  @Get('orgs/:orgId/email-identities')
  list(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<EmailIdentityList> {
    return this.identities.list(principal, orgId);
  }

  @Post('orgs/:orgId/email-identities')
  @HttpCode(201)
  create(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @Body(new ZodValidationPipe(createEmailIdentityRequestSchema)) body: CreateEmailIdentityInput,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<EmailIdentityMutation> {
    return this.identities.create(principal, orgId, body, requestMetaOf(request));
  }

  @Get('bases/:baseId/email-identities')
  listForBase(
    @Param('baseId', baseIdPipe) baseId: Id<'bse'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<BaseEmailIdentityList> {
    return this.identities.listForBase(principal, baseId);
  }

  // Static routes before `:identityId` (public verification page).
  @Post('email-identities/verify/preview')
  @Public()
  @HttpCode(200)
  preview(
    @Body(new ZodValidationPipe(emailVerificationTokenRequestSchema))
    body: EmailVerificationTokenRequest,
    @Req() request: FastifyRequest,
  ): Promise<EmailVerificationPreview> {
    return this.identities.preview(body.token, requestMetaOf(request));
  }

  @Post('email-identities/verify')
  @Public()
  @HttpCode(200)
  confirm(
    @Body(new ZodValidationPipe(emailVerificationTokenRequestSchema))
    body: EmailVerificationTokenRequest,
    @Req() request: FastifyRequest,
  ): Promise<EmailVerificationConfirmed> {
    return this.identities.confirm(body.token, requestMetaOf(request));
  }

  @Get('email-identities/:identityId')
  get(
    @Param('identityId', identityIdPipe) identityId: Id<'eid'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<EmailIdentityDto> {
    return this.identities.get(principal, identityId);
  }

  @Patch('email-identities/:identityId')
  update(
    @Param('identityId', identityIdPipe) identityId: Id<'eid'>,
    @Body(new ZodValidationPipe(updateEmailIdentityRequestSchema)) body: UpdateEmailIdentityRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<EmailIdentityMutation> {
    return this.identities.update(principal, identityId, body, requestMetaOf(request));
  }

  @Delete('email-identities/:identityId')
  @HttpCode(204)
  async remove(
    @Param('identityId', identityIdPipe) identityId: Id<'eid'>,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.identities.remove(principal, identityId, requestMetaOf(request));
  }

  @Post('email-identities/:identityId/send-verification')
  @HttpCode(200)
  sendVerification(
    @Param('identityId', identityIdPipe) identityId: Id<'eid'>,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<EmailVerificationOutcome> {
    return this.identities.resendVerification(principal, identityId, requestMetaOf(request));
  }

  @Post('email-identities/:identityId/test-and-verify')
  @HttpCode(200)
  testAndVerify(
    @Param('identityId', identityIdPipe) identityId: Id<'eid'>,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<EmailVerificationOutcome> {
    return this.identities.testAndVerify(principal, identityId, requestMetaOf(request));
  }

  @Post('email-identities/:identityId/verify-code')
  @HttpCode(200)
  verifyCode(
    @Param('identityId', identityIdPipe) identityId: Id<'eid'>,
    @Body(new ZodValidationPipe(verifyEmailIdentityCodeRequestSchema))
    body: VerifyEmailIdentityCodeRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<EmailIdentityDto> {
    return this.identities.verifyCode(principal, identityId, body.code, requestMetaOf(request));
  }

  @Post('email-identities/:identityId/disable')
  @HttpCode(200)
  disable(
    @Param('identityId', identityIdPipe) identityId: Id<'eid'>,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<EmailIdentityDto> {
    return this.identities.disable(principal, identityId, requestMetaOf(request));
  }

  @Post('email-identities/:identityId/enable')
  @HttpCode(200)
  enable(
    @Param('identityId', identityIdPipe) identityId: Id<'eid'>,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<EmailIdentityDto> {
    return this.identities.enable(principal, identityId, requestMetaOf(request));
  }

  @Get('email-identities/:identityId/usages')
  usages(
    @Param('identityId', identityIdPipe) identityId: Id<'eid'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<EmailIdentityUsages> {
    return this.identities.usages(principal, identityId);
  }
}
