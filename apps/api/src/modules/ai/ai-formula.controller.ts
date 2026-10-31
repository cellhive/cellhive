import {
  aiFormulaRequestSchema,
  idOf,
  type AiFormula,
  type AiFormulaRequest,
  type Id,
} from '@cellhive/contracts';
import { Body, Controller, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';

import { CurrentPrincipal, type Principal } from '../../common/auth/principal.js';
import { requestMetaOf } from '../../common/auth/request-meta.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';

import { AiFormulaService } from './ai-formula.service.js';

import type { FastifyRequest } from 'fastify';

/** "Write the formula with AI" of a table (CONTRACTS §29.2, BACKLOG T907). */
@Controller('tables/:tableId/ai')
export class AiFormulaController {
  constructor(@Inject(AiFormulaService) private readonly formulas: AiFormulaService) {}

  @Post('formula')
  @HttpCode(200)
  generate(
    @Param('tableId', new ZodValidationPipe(idOf('tbl'))) tableId: Id<'tbl'>,
    @Body(new ZodValidationPipe(aiFormulaRequestSchema)) body: AiFormulaRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<AiFormula> {
    return this.formulas.generate(principal, tableId, body, requestMetaOf(request));
  }
}
