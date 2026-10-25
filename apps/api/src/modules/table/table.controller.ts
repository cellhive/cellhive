import {
  createTableRequestSchema,
  idOf,
  offsetQuerySchema,
  purgeTableRequestSchema,
  updateTableRequestSchema,
  type CreateTableRequest,
  type DeletePreview,
  type Id,
  type OffsetQuery,
  type PurgedTableResponse,
  type PurgeTableRequest,
  type TableDto,
  type TableList,
  type TrashedTableList,
  type UpdateTableRequest,
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
} from '@nestjs/common';

import { CurrentBase, RequireBase } from '../../common/access/require-base.js';
import { CurrentPrincipal, type Principal } from '../../common/auth/principal.js';
import { requestMetaOf } from '../../common/auth/request-meta.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';

import { TableService } from './table.service.js';

import type { BaseAccess } from '../../common/access/access.service.js';
import type { FastifyRequest } from 'fastify';

const tableIdPipe = new ZodValidationPipe(idOf('tbl'));

/** `/bases/:baseId/tables` and `/tables/:tableId` (SPEC §13.1, BACKLOG T103). */
@Controller()
export class TableController {
  constructor(@Inject(TableService) private readonly tables: TableService) {}

  @Get('bases/:baseId/tables')
  @RequireBase('read')
  list(
    @CurrentBase() base: BaseAccess,
    @Query(new ZodValidationPipe(offsetQuerySchema)) query: OffsetQuery,
  ): Promise<TableList> {
    return this.tables.list(base, query);
  }

  @Get('bases/:baseId/tables/trash')
  @RequireBase('read')
  listTrash(@CurrentBase() base: BaseAccess): Promise<TrashedTableList> {
    return this.tables.listTrash(base);
  }

  @Post('bases/:baseId/tables')
  @HttpCode(201)
  @RequireBase('read')
  create(
    @CurrentBase() base: BaseAccess,
    @Body(new ZodValidationPipe(createTableRequestSchema)) body: CreateTableRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<TableDto> {
    return this.tables.create(principal, base, body, requestMetaOf(request));
  }

  @Get('tables/:tableId')
  get(
    @Param('tableId', tableIdPipe) tableId: Id<'tbl'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<TableDto> {
    return this.tables.get(principal, tableId);
  }

  @Patch('tables/:tableId')
  update(
    @Param('tableId', tableIdPipe) tableId: Id<'tbl'>,
    @Body(new ZodValidationPipe(updateTableRequestSchema)) body: UpdateTableRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<TableDto> {
    return this.tables.update(principal, tableId, body, requestMetaOf(request));
  }

  @Get('tables/:tableId/delete-preview')
  deletePreview(
    @Param('tableId', tableIdPipe) tableId: Id<'tbl'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<DeletePreview> {
    return this.tables.deletePreview(principal, tableId);
  }

  @Delete('tables/:tableId')
  @HttpCode(204)
  async delete(
    @Param('tableId', tableIdPipe) tableId: Id<'tbl'>,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.tables.delete(principal, tableId, requestMetaOf(request));
  }

  @Post('tables/:tableId/restore')
  @HttpCode(200)
  restore(
    @Param('tableId', tableIdPipe) tableId: Id<'tbl'>,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<TableDto> {
    return this.tables.restore(principal, tableId, requestMetaOf(request));
  }

  @Post('tables/:tableId/purge')
  @HttpCode(200)
  purge(
    @Param('tableId', tableIdPipe) tableId: Id<'tbl'>,
    @Body(new ZodValidationPipe(purgeTableRequestSchema)) body: PurgeTableRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<PurgedTableResponse> {
    return this.tables.purge(principal, tableId, body, requestMetaOf(request));
  }
}
