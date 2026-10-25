import {
  idOf,
  shareWidgetDataRequestSchema,
  shareWidgetExportQuerySchema,
  shareWidgetOptionsRequestSchema,
  type Id,
  type SharedDashboardDto,
  type WidgetDataDto,
  type WidgetDataRequest,
  type WidgetExportQuery,
  type WidgetOptionsDto,
  type WidgetOptionsRequest,
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

import { ShareDashboardService } from './share-dashboard.service.js';

import type { FastifyReply, FastifyRequest } from 'fastify';

const widgetIdPipe = new ZodValidationPipe(idOf('wgt'));

/**
 * A dashboard through its share link (SPEC §15A.3, CONTRACTS §16A; BACKLOG
 * T809): `/shares/:token/dashboard` and `/shares/:token/widgets/:widgetId/
 * data|options|export`. No realtime: the page polls at `refresh_seconds`.
 */
@Controller('shares/:token')
@Public()
export class ShareDashboardController {
  constructor(@Inject(ShareDashboardService) private readonly shares: ShareDashboardService) {}

  @Get('dashboard')
  dashboard(
    @Param('token') token: string,
    @Req() request: FastifyRequest,
  ): Promise<SharedDashboardDto> {
    return this.shares.dashboard(token, request);
  }

  @Post('widgets/:widgetId/data')
  @HttpCode(200)
  widgetData(
    @Param('token') token: string,
    @Param('widgetId', widgetIdPipe) widgetId: Id<'wgt'>,
    // The body may be omitted.
    @Body(new ZodValidationPipe(shareWidgetDataRequestSchema.default({ filters: [] })))
    body: WidgetDataRequest,
    @Req() request: FastifyRequest,
  ): Promise<WidgetDataDto> {
    return this.shares.widgetData(token, widgetId, body, request);
  }

  @Post('widgets/:widgetId/options')
  @HttpCode(200)
  widgetOptions(
    @Param('token') token: string,
    @Param('widgetId', widgetIdPipe) widgetId: Id<'wgt'>,
    @Body(new ZodValidationPipe(shareWidgetOptionsRequestSchema.default({ filters: [] })))
    body: WidgetOptionsRequest,
    @Req() request: FastifyRequest,
  ): Promise<WidgetOptionsDto> {
    return this.shares.widgetOptions(token, widgetId, body, request);
  }

  @Get('widgets/:widgetId/export')
  async widgetExport(
    @Param('token') token: string,
    @Param('widgetId', widgetIdPipe) widgetId: Id<'wgt'>,
    @Query(new ZodValidationPipe(shareWidgetExportQuerySchema)) query: WidgetExportQuery,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const file = await this.shares.widgetCsv(token, widgetId, query, request);
    await reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', file.disposition)
      .send(file.body);
  }
}
