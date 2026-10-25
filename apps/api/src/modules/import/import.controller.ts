import { Readable } from 'node:stream';

import {
  idOf,
  importPreviewQuerySchema,
  startImportRequestSchema,
  type Id,
  type ImportPreview,
  type ImportPreviewQuery,
  type ImportUploadDto,
  type JobAccepted,
  type JobDto,
  type StartImportRequest,
} from '@cellhive/contracts';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';

import { CurrentPrincipal, type Principal } from '../../common/auth/principal.js';
import { RawUpload, uploadContentType } from '../../common/http/raw-upload.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';

import { ImportService } from './import.service.js';

import type { FastifyRequest } from 'fastify';

const baseIdPipe = new ZodValidationPipe(idOf('bse'));
const uploadIdPipe = new ZodValidationPipe(idOf('imp'));

/** CSV/XLSX import (SPEC §17, CONTRACTS §19; BACKLOG T308). */
@Controller('bases/:baseId/imports')
export class ImportController {
  constructor(@Inject(ImportService) private readonly imports: ImportService) {}

  /** `multipart/form-data` with a `file` part: the body is read as a stream. */
  @Post('uploads')
  @HttpCode(201)
  @RawUpload()
  upload(
    @Param('baseId', baseIdPipe) baseId: Id<'bse'>,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<ImportUploadDto> {
    return this.imports.upload(principal, baseId, {
      contentType: uploadContentType(request),
      body: request.body instanceof Readable ? request.body : Readable.from([]),
    });
  }

  @Get('uploads/:uploadId/preview')
  preview(
    @Param('baseId', baseIdPipe) baseId: Id<'bse'>,
    @Param('uploadId', uploadIdPipe) uploadId: Id<'imp'>,
    @Query(new ZodValidationPipe(importPreviewQuerySchema)) query: ImportPreviewQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ImportPreview> {
    return this.imports.preview(principal, baseId, uploadId, query);
  }

  @Post()
  @HttpCode(202)
  start(
    @Param('baseId', baseIdPipe) baseId: Id<'bse'>,
    @Body(new ZodValidationPipe(startImportRequestSchema)) body: StartImportRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<JobAccepted> {
    return this.imports.start(principal, baseId, body);
  }

  @Post(':jobId/cancel')
  @HttpCode(200)
  cancel(
    @Param('baseId', baseIdPipe) baseId: Id<'bse'>,
    @Param('jobId', new ZodValidationPipe(idOf('job'))) jobId: Id<'job'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<JobDto> {
    return this.imports.cancel(principal, baseId, jobId);
  }
}
