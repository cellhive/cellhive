import {
  aiAskRequestSchema,
  idOf,
  type AiAsk,
  type AiAskRequest,
  type Id,
} from '@cellhive/contracts';
import { Body, Controller, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';

import { CurrentPrincipal, type Principal } from '../../common/auth/principal.js';
import { requestMetaOf } from '../../common/auth/request-meta.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';

import { AiAskService } from './ai-ask.service.js';

import type { FastifyRequest } from 'fastify';

/** "Ask AI" about a table (CONTRACTS §29.4, BACKLOG T909). */
@Controller('tables/:tableId/ai')
export class AiAskController {
  constructor(@Inject(AiAskService) private readonly asks: AiAskService) {}

  @Post('ask')
  @HttpCode(200)
  ask(
    @Param('tableId', new ZodValidationPipe(idOf('tbl'))) tableId: Id<'tbl'>,
    @Body(new ZodValidationPipe(aiAskRequestSchema)) body: AiAskRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<AiAsk> {
    return this.asks.ask(principal, tableId, body, requestMetaOf(request));
  }
}
