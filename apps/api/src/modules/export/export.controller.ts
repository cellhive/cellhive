import { idOf, tableExportQuerySchema, type Id, type TableExportQuery } from '@cellhive/contracts';
import { Controller, Get, Inject, Param, Query, Req, Res } from '@nestjs/common';

import { CurrentPrincipal, type Principal } from '../../common/auth/principal.js';
import { requestMetaOf } from '../../common/auth/request-meta.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';

import { ExportService } from './export.service.js';
import { sendExport } from './send-export.js';

import type { FastifyReply, FastifyRequest } from 'fastify';

/** `GET /tables/:tableId/export?view_id=&format=csv|xlsx` (CONTRACTS §18). */
@Controller()
export class ExportController {
  constructor(@Inject(ExportService) private readonly exports: ExportService) {}

  @Get('tables/:tableId/export')
  async export(
    @Param('tableId', new ZodValidationPipe(idOf('tbl'))) tableId: Id<'tbl'>,
    @Query(new ZodValidationPipe(tableExportQuerySchema)) query: TableExportQuery,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await sendExport(
      reply,
      (signal) => this.exports.open(principal, tableId, query, requestMetaOf(request), signal),
      { 'cache-control': 'private, no-store' },
    );
  }
}
