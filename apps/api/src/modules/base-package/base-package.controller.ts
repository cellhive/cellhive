import { Readable } from 'node:stream';

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
import { RawUpload, uploadContentType } from '../../common/http/raw-upload.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';

import { BaseExportService } from './base-export.service.js';
import { BaseImportService } from './base-import.service.js';

import type { FastifyRequest } from 'fastify';

/** Whole-base packages (CONTRACTS §12.2). */
@Controller()
export class BasePackageController {
  constructor(
    @Inject(BaseExportService) private readonly baseExports: BaseExportService,
    @Inject(BaseImportService) private readonly baseImports: BaseImportService,
  ) {}

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

  /** `multipart/form-data` with a `file` part (`.chbase`): the body is read as a stream. */
  @Post('workspaces/:workspaceId/bases/import')
  @HttpCode(202)
  @RawUpload()
  importBase(
    @Param('workspaceId', new ZodValidationPipe(idOf('wsp'))) workspaceId: Id<'wsp'>,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<JobAccepted> {
    return this.baseImports.start(principal, workspaceId, {
      contentType: uploadContentType(request),
      body: request.body instanceof Readable ? request.body : Readable.from([]),
    });
  }
}
