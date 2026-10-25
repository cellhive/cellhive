import {
  automationActionIdSchema,
  automationEmailPreviewRequestSchema,
  automationEmailTestRequestSchema,
  idOf,
  type AutomationEmailPreview,
  type AutomationEmailPreviewRequest,
  type AutomationEmailTestRequest,
  type AutomationEmailTestResult,
  type Id,
} from '@cellhive/contracts';
import { Body, Controller, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';

import { CurrentPrincipal, type Principal } from '../../common/auth/principal.js';
import { requestMetaOf } from '../../common/auth/request-meta.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';

import { AutomationEmailService } from './automation-email.service.js';

import type { FastifyRequest } from 'fastify';

const automationIdPipe = new ZodValidationPipe(idOf('aut'));
const actionIdPipe = new ZodValidationPipe(automationActionIdSchema);

/** Preview and test email of a `send_email` step (CONTRACTS §21; BACKLOG T514). */
@Controller()
export class AutomationEmailController {
  constructor(@Inject(AutomationEmailService) private readonly email: AutomationEmailService) {}

  @Post('automations/:automationId/actions/:actionId/email-preview')
  @HttpCode(200)
  preview(
    @Param('automationId', automationIdPipe) automationId: Id<'aut'>,
    @Param('actionId', actionIdPipe) actionId: string,
    @Body(new ZodValidationPipe(automationEmailPreviewRequestSchema))
    body: AutomationEmailPreviewRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AutomationEmailPreview> {
    return this.email.preview(principal, automationId, actionId, body);
  }

  @Post('automations/:automationId/actions/:actionId/email-test')
  @HttpCode(200)
  test(
    @Param('automationId', automationIdPipe) automationId: Id<'aut'>,
    @Param('actionId', actionIdPipe) actionId: string,
    @Body(new ZodValidationPipe(automationEmailTestRequestSchema)) body: AutomationEmailTestRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<AutomationEmailTestResult> {
    return this.email.test(principal, automationId, actionId, body, requestMetaOf(request));
  }
}
