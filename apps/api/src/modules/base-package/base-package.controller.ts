import {
  baseExportRequestSchema,
  idOf,
  type BaseExportRequest,
  type Id,
  type JobAccepted,
} from '@cellhive/contracts';
import { Body, Controller, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';

import { CurrentPrincipal, type Principal } from '../../common/auth/principal.js';
import { requestMetaOf } from '../../common/auth/request-meta.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';

import { BaseExportService } from './base-export.service.js';

import type { FastifyRequest } from 'fastify';

/** Whole-base packages (CONTRACTS §12.2). */
@Controller()
export class BasePackageController {
  constructor(@Inject(BaseExportService) private readonly baseExports: BaseExportService) {}

  @Post('bases/:baseId/export')
  @HttpCode(202)
  exportBase(
    @Param('baseId', new ZodValidationPipe(idOf('bse'))) baseId: Id<'bse'>,
    // No body or `{}` (format version 1 has no options).
    @Body(new ZodValidationPipe(baseExportRequestSchema.default({}))) body: BaseExportRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<JobAccepted> {
    return this.baseExports.start(principal, baseId, body, requestMetaOf(request));
  }
}
