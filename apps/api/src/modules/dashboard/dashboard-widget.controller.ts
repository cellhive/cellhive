import {
  createWidgetRequestSchema,
  idOf,
  updateWidgetRequestSchema,
  widgetDataRequestSchema,
  widgetExportQuerySchema,
  widgetOptionsRequestSchema,
  widgetRecordsRequestSchema,
  type CreateWidgetRequest,
  type Id,
  type UpdateWidgetRequest,
  type WidgetDataDto,
  type WidgetDataRequest,
  type WidgetDto,
  type WidgetExportQuery,
  type WidgetOptionsDto,
  type WidgetOptionsRequest,
  type WidgetRecordsDto,
  type WidgetRecordsRequest,
} from '@cellhive/contracts';
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
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
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';

import { DashboardDataService } from './dashboard-data.service.js';
import { DashboardExportService } from './dashboard-export.service.js';
import { dashboardIfMatchOf } from './dashboard.controller.js';
import { DashboardService } from './dashboard.service.js';

import type { FastifyReply, FastifyRequest } from 'fastify';

const dashboardIdPipe = new ZodValidationPipe(idOf('dsh'));
const widgetIdPipe = new ZodValidationPipe(idOf('wgt'));

/** Widgets of a dashboard (SPEC §10.2, CONTRACTS §28.2–§28.6; BACKLOG T805, T806, T808). */
@Controller()
export class DashboardWidgetController {
  constructor(
    @Inject(DashboardService) private readonly dashboards: DashboardService,
    @Inject(DashboardDataService) private readonly data: DashboardDataService,
    @Inject(DashboardExportService) private readonly exports: DashboardExportService,
  ) {}

  @Post('dashboards/:dashboardId/widgets')
  @HttpCode(201)
  create(
    @Param('dashboardId', dashboardIdPipe) dashboardId: Id<'dsh'>,
    @Body(new ZodValidationPipe(createWidgetRequestSchema)) body: CreateWidgetRequest,
    @Headers('if-match') ifMatch: string | undefined,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<WidgetDto> {
    return this.dashboards.createWidget(
      principal,
      dashboardId,
      body,
      dashboardIfMatchOf(ifMatch),
      requestMetaOf(request),
    );
  }

  @Patch('widgets/:widgetId')
  update(
    @Param('widgetId', widgetIdPipe) widgetId: Id<'wgt'>,
    @Body(new ZodValidationPipe(updateWidgetRequestSchema)) body: UpdateWidgetRequest,
    @Headers('if-match') ifMatch: string | undefined,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<WidgetDto> {
    return this.dashboards.updateWidget(
      principal,
      widgetId,
      body,
      dashboardIfMatchOf(ifMatch),
      requestMetaOf(request),
    );
  }

  @Delete('widgets/:widgetId')
  @HttpCode(204)
  async remove(
    @Param('widgetId', widgetIdPipe) widgetId: Id<'wgt'>,
    @Headers('if-match') ifMatch: string | undefined,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.dashboards.removeWidget(
      principal,
      widgetId,
      dashboardIfMatchOf(ifMatch),
      requestMetaOf(request),
    );
  }

  @Post('widgets/:widgetId/duplicate')
  @HttpCode(201)
  duplicate(
    @Param('widgetId', widgetIdPipe) widgetId: Id<'wgt'>,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<WidgetDto> {
    return this.dashboards.duplicateWidget(principal, widgetId, requestMetaOf(request));
  }

  /** `POST /widgets/:widgetId/data` (T806): the widget's numbers for the caller. */
  @Post('widgets/:widgetId/data')
  @HttpCode(200)
  widgetData(
    @Param('widgetId', widgetIdPipe) widgetId: Id<'wgt'>,
    // The body may be omitted.
    @Body(new ZodValidationPipe(widgetDataRequestSchema.default({ filters: [] })))
    body: WidgetDataRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<WidgetDataDto> {
    return this.data.data(principal, widgetId, body);
  }

  /** `POST /widgets/:widgetId/options` (T808): values of a filter control for the caller. */
  @Post('widgets/:widgetId/options')
  @HttpCode(200)
  widgetOptions(
    @Param('widgetId', widgetIdPipe) widgetId: Id<'wgt'>,
    @Body(new ZodValidationPipe(widgetOptionsRequestSchema.default({ filters: [] })))
    body: WidgetOptionsRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<WidgetOptionsDto> {
    return this.data.options(principal, widgetId, body);
  }

  /** `POST /widgets/:widgetId/records` (T808): the records behind a widget (click-through). */
  @Post('widgets/:widgetId/records')
  @HttpCode(200)
  widgetRecords(
    @Param('widgetId', widgetIdPipe) widgetId: Id<'wgt'>,
    @Body(
      new ZodValidationPipe(
        widgetRecordsRequestSchema.default({ segment: null, filters: [], offset: 0, limit: 50 }),
      ),
    )
    body: WidgetRecordsRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<WidgetRecordsDto> {
    return this.data.recordsOf(principal, widgetId, body);
  }

  /** `GET /widgets/:widgetId/export?format=csv` (T808): the widget's aggregate table as CSV. */
  @Get('widgets/:widgetId/export')
  async exportWidget(
    @Param('widgetId', widgetIdPipe) widgetId: Id<'wgt'>,
    @Query(new ZodValidationPipe(widgetExportQuerySchema)) query: WidgetExportQuery,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const file = await this.exports.csv(principal, widgetId, query, requestMetaOf(request));
    await reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', file.disposition)
      .header('cache-control', 'private, no-store')
      .send(file.body);
  }
}
