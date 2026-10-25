import {
  duplicateAutomationRequestSchema,
  idOf,
  type AutomationDto,
  type DuplicateAutomationRequest,
  type Id,
} from '@cellhive/contracts';
import { Body, Controller, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';

import { CurrentPrincipal, type Principal } from '../../common/auth/principal.js';
import { requestMetaOf } from '../../common/auth/request-meta.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';

import { AutomationService } from './automation.service.js';

import type { FastifyRequest } from 'fastify';

/** Duplicating an automation, with its body images (CONTRACTS §21; BACKLOG T551). */
@Controller()
export class AutomationDuplicateController {
  constructor(@Inject(AutomationService) private readonly automations: AutomationService) {}

  @Post('automations/:automationId/duplicate')
  @HttpCode(201)
  duplicate(
    @Param('automationId', new ZodValidationPipe(idOf('aut'))) automationId: Id<'aut'>,
    @Body(new ZodValidationPipe(duplicateAutomationRequestSchema.default({})))
    body: DuplicateAutomationRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<AutomationDto> {
    return this.automations.duplicate(principal, automationId, body, requestMetaOf(request));
  }
}
