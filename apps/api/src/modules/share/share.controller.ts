import {
  recordReadParamsSchema,
  shareExportQuerySchema,
  shareRecordGetQuerySchema,
  shareRecordGroupCountsRequestSchema,
  shareRecordQueryRequestSchema,
  shareRecordSummariesRequestSchema,
  shareUnlockRequestSchema,
  type RecordDto,
  type RecordGroupCountsResponse,
  type RecordListResponse,
  type RecordReadParams,
  type RecordSummariesResponse,
  type ShareExportQuery,
  type ShareMeta,
  type ShareRecordGetQuery,
  type ShareRecordGroupCountsRequest,
  type ShareRecordQueryRequest,
  type ShareRecordSummariesRequest,
  type ShareUnlockRequest,
  type ShareUnlockResponse,
} from '@cellhive/contracts';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';

import { Public } from '../../common/auth/principal.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { sendExport } from '../export/send-export.js';

import { ShareExportService } from './share-export.service.js';
import { ShareService } from './share.service.js';

import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Public, read-only access through a share link (SPEC §15A.3, CONTRACTS
 * §16A): `/shares/:token/meta|records/query|records/group-counts|records/summaries|
 * records/:recordId|export|unlock`. No
 * session needed for `audience = public`; a session cookie, when present,
 * still requires `X-CSRF-Token` on `POST` (AuthGuard). Form submission
 * (`/shares/:token/submit`) lives in the form module (T306).
 */
@Controller('shares/:token')
@Public()
export class ShareController {
  constructor(
    @Inject(ShareService) private readonly shares: ShareService,
    @Inject(ShareExportService) private readonly exports: ShareExportService,
  ) {}

  @Get('meta')
  meta(@Param('token') token: string, @Req() request: FastifyRequest): Promise<ShareMeta> {
    return this.shares.meta(token, request);
  }

  @Post('records/query')
  @HttpCode(200)
  query(
    @Param('token') token: string,
    @Query(new ZodValidationPipe(recordReadParamsSchema)) params: RecordReadParams,
    @Body(new ZodValidationPipe(shareRecordQueryRequestSchema)) body: ShareRecordQueryRequest,
    @Req() request: FastifyRequest,
  ): Promise<RecordListResponse> {
    return this.shares.queryRecords(token, params, body, request);
  }

  @Post('records/group-counts')
  @HttpCode(200)
  groupCounts(
    @Param('token') token: string,
    @Query(new ZodValidationPipe(recordReadParamsSchema)) params: RecordReadParams,
    @Body(new ZodValidationPipe(shareRecordGroupCountsRequestSchema))
    body: ShareRecordGroupCountsRequest,
    @Req() request: FastifyRequest,
  ): Promise<RecordGroupCountsResponse> {
    return this.shares.groupCounts(token, params, body, request);
  }

  @Post('records/summaries')
  @HttpCode(200)
  summaries(
    @Param('token') token: string,
    @Query(new ZodValidationPipe(recordReadParamsSchema)) params: RecordReadParams,
    @Body(new ZodValidationPipe(shareRecordSummariesRequestSchema))
    body: ShareRecordSummariesRequest,
    @Req() request: FastifyRequest,
  ): Promise<RecordSummariesResponse> {
    return this.shares.summaries(token, params, body, request);
  }

  @Get('records/:recordId')
  record(
    @Param('token') token: string,
    @Param('recordId') recordId: string,
    @Query(new ZodValidationPipe(shareRecordGetQuerySchema)) query: ShareRecordGetQuery,
    @Req() request: FastifyRequest,
  ): Promise<RecordDto> {
    return this.shares.getRecord(token, recordId, query, request);
  }

  /** `GET /shares/:token/export?format=csv|xlsx&tz=` (T810): the shared view as a file. */
  @Get('export')
  async export(
    @Param('token') token: string,
    @Query(new ZodValidationPipe(shareExportQuerySchema)) query: ShareExportQuery,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await sendExport(reply, (signal) => this.exports.open(token, query, request, signal));
  }

  @Post('unlock')
  @HttpCode(200)
  unlock(
    @Param('token') token: string,
    @Body(new ZodValidationPipe(shareUnlockRequestSchema)) body: ShareUnlockRequest,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<ShareUnlockResponse> {
    return this.shares.unlock(token, body, request, reply);
  }
}
