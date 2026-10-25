import {
  createRecordsRequestSchema,
  deleteRecordQuerySchema,
  deleteRecordsRequestSchema,
  idOf,
  purgeRecordsRequestSchema,
  recordChildrenQuerySchema,
  recordTreeRequestSchema,
  restoreRecordsRequestSchema,
  recordGetQuerySchema,
  recordGroupCountsRequestSchema,
  recordHistoryQuerySchema,
  recordKeyParamsSchema,
  recordListQuerySchema,
  recordQueryRequestSchema,
  recordReadParamsSchema,
  recordSummariesRequestSchema,
  recordTrashQuerySchema,
  recordWriteParamsSchema,
  revertRecordRequestSchema,
  updateRecordRequestSchema,
  updateRecordsRequestSchema,
  type CreateRecordsRequest,
  type DeleteRecordQuery,
  type DeleteRecordsRequest,
  type DeletedRecordsResponse,
  type PurgedRecordsResponse,
  type PurgeRecordsRequest,
  type RecordAncestorsResponse,
  type RecordChildrenQuery,
  type RecordTreeRequest,
  type RecordTreeResponse,
  type RestoreRecordsRequest,
  type Id,
  type RecordDto,
  type RecordGetQuery,
  type RecordGroupCountsRequest,
  type RecordGroupCountsResponse,
  type RecordHistoryQuery,
  type RecordHistoryResponse,
  type RecordKeyParams,
  type RecordListQuery,
  type RecordListResponse,
  type RecordQueryRequest,
  type RecordReadParams,
  type RecordsResponse,
  type RecordSummariesRequest,
  type RecordSummariesResponse,
  type RecordTrashQuery,
  type RecordTrashResponse,
  type RecordWriteParams,
  type RevertedRecordDto,
  type RevertRecordRequest,
  type UpdateRecordRequest,
  type UpdateRecordsRequest,
  type UpsertRecordsResponse,
} from '@cellhive/contracts';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';

import { CurrentPrincipal, type Principal } from '../../common/auth/principal.js';
import { requestMetaOf } from '../../common/auth/request-meta.js';
import { BatchBodyPipe } from '../../common/validation/batch-body.pipe.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';

import { RecordService } from './record.service.js';

import type { FastifyReply, FastifyRequest } from 'fastify';

const tableIdPipe = new ZodValidationPipe(idOf('tbl'));
const recordIdPipe = new ZodValidationPipe(idOf('rec'));
const readParamsPipe = new ZodValidationPipe(recordReadParamsSchema);
const writeParamsPipe = new ZodValidationPipe(recordWriteParamsSchema);

/**
 * `/tables/:tableId/records…` (SPEC §13.1, CONTRACTS §1.3–1.4).
 * `Idempotency-Key` on the write `POST`s is handled by the global
 * `RequestPoliciesInterceptor`.
 */
@Controller('tables/:tableId/records')
export class RecordController {
  constructor(@Inject(RecordService) private readonly records: RecordService) {}

  @Post('query')
  @HttpCode(200)
  query(
    @Param('tableId', tableIdPipe) tableId: Id<'tbl'>,
    @Query(readParamsPipe) params: RecordReadParams,
    @Body(new ZodValidationPipe(recordQueryRequestSchema)) body: RecordQueryRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<RecordListResponse> {
    return this.records.queryRecords(principal, tableId, params, body);
  }

  /** One level of the sub-record tree (CONTRACTS §1.4, T405). */
  @Post('tree')
  @HttpCode(200)
  tree(
    @Param('tableId', tableIdPipe) tableId: Id<'tbl'>,
    @Query(readParamsPipe) params: RecordReadParams,
    @Body(new ZodValidationPipe(recordTreeRequestSchema)) body: RecordTreeRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<RecordTreeResponse> {
    return this.records.tree(principal, tableId, params, body);
  }

  @Post('group-counts')
  @HttpCode(200)
  groupCounts(
    @Param('tableId', tableIdPipe) tableId: Id<'tbl'>,
    @Query(readParamsPipe) params: RecordReadParams,
    @Body(new ZodValidationPipe(recordGroupCountsRequestSchema)) body: RecordGroupCountsRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<RecordGroupCountsResponse> {
    return this.records.groupCounts(principal, tableId, params, body);
  }

  @Post('summaries')
  @HttpCode(200)
  summaries(
    @Param('tableId', tableIdPipe) tableId: Id<'tbl'>,
    @Query(readParamsPipe) params: RecordReadParams,
    @Body(new ZodValidationPipe(recordSummariesRequestSchema)) body: RecordSummariesRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<RecordSummariesResponse> {
    return this.records.summaries(principal, tableId, params, body);
  }

  @Get()
  list(
    @Param('tableId', tableIdPipe) tableId: Id<'tbl'>,
    @Query(new ZodValidationPipe(recordListQuerySchema)) query: RecordListQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<RecordListResponse> {
    return this.records.listRecords(principal, tableId, query);
  }

  @Post()
  @HttpCode(201)
  async create(
    @Param('tableId', tableIdPipe) tableId: Id<'tbl'>,
    @Query(writeParamsPipe) params: RecordWriteParams,
    @Body(new BatchBodyPipe(createRecordsRequestSchema, 'records')) body: CreateRecordsRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<RecordsResponse | RecordDto | undefined> {
    const created = await this.records.createRecords(
      principal,
      tableId,
      params,
      body,
      requestMetaOf(request),
    );
    if (created === undefined) void reply.status(204);
    return created;
  }

  @Patch()
  update(
    @Param('tableId', tableIdPipe) tableId: Id<'tbl'>,
    @Query(writeParamsPipe) params: RecordWriteParams,
    @Body(new BatchBodyPipe(updateRecordsRequestSchema, 'records')) body: UpdateRecordsRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<RecordsResponse | UpsertRecordsResponse> {
    return this.records.updateRecords(principal, tableId, params, body, requestMetaOf(request));
  }

  @Delete()
  @HttpCode(200)
  delete(
    @Param('tableId', tableIdPipe) tableId: Id<'tbl'>,
    @Body(new BatchBodyPipe(deleteRecordsRequestSchema, 'ids')) body: DeleteRecordsRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<DeletedRecordsResponse> {
    return this.records.deleteRecords(principal, tableId, body, requestMetaOf(request));
  }

  @Post('restore')
  @HttpCode(200)
  restore(
    @Param('tableId', tableIdPipe) tableId: Id<'tbl'>,
    @Body(new BatchBodyPipe(restoreRecordsRequestSchema, 'ids')) body: RestoreRecordsRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<RecordsResponse> {
    return this.records.restoreRecords(principal, tableId, body, requestMetaOf(request));
  }

  /** Permanent delete from the trash (T408, CONTRACTS §11.3). */
  @Post('trash/purge')
  @HttpCode(200)
  purge(
    @Param('tableId', tableIdPipe) tableId: Id<'tbl'>,
    @Body(new BatchBodyPipe(purgeRecordsRequestSchema, 'ids')) body: PurgeRecordsRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<PurgedRecordsResponse> {
    return this.records.purgeRecords(principal, tableId, body, requestMetaOf(request));
  }

  @Get('trash')
  trash(
    @Param('tableId', tableIdPipe) tableId: Id<'tbl'>,
    @Query(new ZodValidationPipe(recordTrashQuerySchema)) query: RecordTrashQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<RecordTrashResponse> {
    return this.records.listTrash(principal, tableId, query);
  }

  @Get(':recordId/children')
  children(
    @Param('tableId', tableIdPipe) tableId: Id<'tbl'>,
    @Param('recordId', recordIdPipe) recordId: Id<'rec'>,
    @Query(new ZodValidationPipe(recordChildrenQuerySchema)) query: RecordChildrenQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<RecordListResponse> {
    return this.records.children(principal, tableId, recordId, query);
  }

  @Get(':recordId/ancestors')
  ancestors(
    @Param('tableId', tableIdPipe) tableId: Id<'tbl'>,
    @Param('recordId', recordIdPipe) recordId: Id<'rec'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<RecordAncestorsResponse> {
    return this.records.ancestors(principal, tableId, recordId);
  }

  @Get(':recordId/history')
  history(
    @Param('tableId', tableIdPipe) tableId: Id<'tbl'>,
    @Param('recordId', recordIdPipe) recordId: Id<'rec'>,
    @Query(new ZodValidationPipe(recordHistoryQuerySchema)) query: RecordHistoryQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<RecordHistoryResponse> {
    return this.records.history(principal, tableId, recordId, query);
  }

  @Post(':recordId/revert')
  @HttpCode(200)
  async revert(
    @Param('tableId', tableIdPipe) tableId: Id<'tbl'>,
    @Param('recordId', recordIdPipe) recordId: Id<'rec'>,
    @Query(new ZodValidationPipe(recordKeyParamsSchema)) params: RecordKeyParams,
    @Body(new ZodValidationPipe(revertRecordRequestSchema)) body: RevertRecordRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<RevertedRecordDto | undefined> {
    const record = await this.records.revert(
      principal,
      tableId,
      recordId,
      params,
      body,
      requestMetaOf(request),
    );
    if (record === undefined) void reply.status(204);
    return record;
  }

  @Get(':recordId')
  get(
    @Param('tableId', tableIdPipe) tableId: Id<'tbl'>,
    @Param('recordId', recordIdPipe) recordId: Id<'rec'>,
    @Query(new ZodValidationPipe(recordGetQuerySchema)) query: RecordGetQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<RecordDto> {
    return this.records.getRecord(principal, tableId, recordId, query);
  }

  @Patch(':recordId')
  async updateOne(
    @Param('tableId', tableIdPipe) tableId: Id<'tbl'>,
    @Param('recordId', recordIdPipe) recordId: Id<'rec'>,
    @Query(writeParamsPipe) params: RecordWriteParams,
    @Body(new ZodValidationPipe(updateRecordRequestSchema)) body: UpdateRecordRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<RecordDto | undefined> {
    const record = await this.records.updateRecord(
      principal,
      tableId,
      recordId,
      params,
      body,
      requestMetaOf(request),
    );
    if (record === undefined) void reply.status(204);
    return record;
  }

  @Delete(':recordId')
  @HttpCode(204)
  async deleteOne(
    @Param('tableId', tableIdPipe) tableId: Id<'tbl'>,
    @Param('recordId', recordIdPipe) recordId: Id<'rec'>,
    @Query(new ZodValidationPipe(deleteRecordQuerySchema)) query: DeleteRecordQuery,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.records.deleteRecords(
      principal,
      tableId,
      { ids: [recordId], ...(query.children === undefined ? {} : { children: query.children }) },
      requestMetaOf(request),
    );
  }
}
