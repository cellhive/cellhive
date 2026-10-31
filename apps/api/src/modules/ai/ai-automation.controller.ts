import {
  aiAutomationDraftRequestSchema,
  idOf,
  type AiAutomationDraft,
  type AiAutomationDraftRequest,
  type Id,
} from '@cellhive/contracts';
import { Body, Controller, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';

import { CurrentPrincipal, type Principal } from '../../common/auth/principal.js';
import { requestMetaOf } from '../../common/auth/request-meta.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';

import { AiAutomationService } from './ai-automation.service.js';

import type { FastifyRequest } from 'fastify';

/** "Create an automation with AI" of a base (CONTRACTS §29.3, BACKLOG T908). */
@Controller('bases/:baseId/ai')
export class AiAutomationController {
  constructor(@Inject(AiAutomationService) private readonly drafts: AiAutomationService) {}

  @Post('automation-draft')
  @HttpCode(200)
  draft(
    @Param('baseId', new ZodValidationPipe(idOf('bse'))) baseId: Id<'bse'>,
    @Body(new ZodValidationPipe(aiAutomationDraftRequestSchema)) body: AiAutomationDraftRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<AiAutomationDraft> {
    return this.drafts.draft(principal, baseId, body, requestMetaOf(request));
  }
}
