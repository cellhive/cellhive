import {
  idOf,
  updateEmailSettingsRequestSchema,
  type EmailSettingsDto,
  type EmailTestResult,
  type Id,
  type UpdateEmailSettingsRequest,
} from '@cellhive/contracts';
import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Req } from '@nestjs/common';

import { CurrentPrincipal, type Principal } from '../../common/auth/principal.js';
import { requestMetaOf } from '../../common/auth/request-meta.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';

import { EmailSettingsService } from './email-settings.service.js';

import type { FastifyRequest } from 'fastify';

const orgIdPipe = new ZodValidationPipe(idOf('org'));

/** `/orgs/:orgId/email-settings` (CONTRACTS §23). */
@Controller('orgs/:orgId/email-settings')
export class EmailSettingsController {
  constructor(@Inject(EmailSettingsService) private readonly settings: EmailSettingsService) {}

  @Get()
  get(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<EmailSettingsDto> {
    return this.settings.get(principal, orgId);
  }

  @Patch()
  update(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @Body(new ZodValidationPipe(updateEmailSettingsRequestSchema)) body: UpdateEmailSettingsRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<EmailSettingsDto> {
    return this.settings.update(principal, orgId, body, requestMetaOf(request));
  }

  @Post('test')
  @HttpCode(200)
  test(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<EmailTestResult> {
    return this.settings.test(principal, orgId, requestMetaOf(request));
  }
}
