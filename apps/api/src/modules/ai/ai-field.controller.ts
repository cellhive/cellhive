import {
  aiFieldGenerateRequestSchema,
  aiFieldPreviewRequestSchema,
  idOf,
  type AiFieldGenerate,
  type AiFieldGenerateRequest,
  type AiFieldPreview,
  type AiFieldPreviewRequest,
  type Id,
} from '@cellhive/contracts';
import { Body, Controller, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';

import { CurrentPrincipal, type Principal } from '../../common/auth/principal.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';

import { AiFieldService } from './ai-field.service.js';
import { aiRequestMetaOf } from './client-abort.js';

import type { FastifyReply, FastifyRequest } from 'fastify';

/** AI fields: preview on 5 records and generation of the values (CONTRACTS §29.5, BACKLOG T910). */
@Controller()
export class AiFieldController {
  constructor(@Inject(AiFieldService) private readonly fields: AiFieldService) {}

  @Post('tables/:tableId/ai/field-preview')
  @HttpCode(200)
  preview(
    @Param('tableId', new ZodValidationPipe(idOf('tbl'))) tableId: Id<'tbl'>,
    @Body(new ZodValidationPipe(aiFieldPreviewRequestSchema)) body: AiFieldPreviewRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AiFieldPreview> {
    return this.fields.preview(principal, tableId, body, aiRequestMetaOf(request, reply));
  }

  @Post('fields/:fieldId/ai/generate')
  @HttpCode(202)
  generate(
    @Param('fieldId', new ZodValidationPipe(idOf('fld'))) fieldId: Id<'fld'>,
    @Body(new ZodValidationPipe(aiFieldGenerateRequestSchema)) body: AiFieldGenerateRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AiFieldGenerate> {
    return this.fields.generate(principal, fieldId, body);
  }
}
