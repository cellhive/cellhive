import {
  createDashboardRequestSchema,
  dashboardIfMatchHeaderSchema,
  duplicateDashboardRequestSchema,
  idOf,
  updateDashboardLayoutRequestSchema,
  updateDashboardRequestSchema,
  type CreateDashboardRequest,
  type DashboardDto,
  type DashboardList,
  type DashboardTrash,
  type DuplicateDashboardRequest,
  type Id,
  type UpdateDashboardLayoutRequest,
  type UpdateDashboardRequest,
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
  Put,
  Req,
} from '@nestjs/common';

import { CurrentPrincipal, type Principal } from '../../common/auth/principal.js';
import { requestMetaOf } from '../../common/auth/request-meta.js';
import { validationFailed } from '../../common/dto.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';

import { DashboardService } from './dashboard.service.js';

import type { FastifyRequest } from 'fastify';

const baseIdPipe = new ZodValidationPipe(idOf('bse'));
const dashboardIdPipe = new ZodValidationPipe(idOf('dsh'));
const duplicateBodyPipe = new ZodValidationPipe(duplicateDashboardRequestSchema.default({}));

/** The optional `If-Match` header (expected dashboard `version`), else `422 VALIDATION_FAILED`. */
export function dashboardIfMatchOf(value: string | undefined): string | undefined {
  if (dashboardIfMatchHeaderSchema.safeParse({ 'if-match': value }).success) return value;
  throw validationFailed('If-Match must be the dashboard version.', {
    path: 'if-match',
    code: 'INVALID_FORMAT',
  });
}

/** Dashboards of a base (SPEC §10, CONTRACTS §28; BACKLOG T805). */
@Controller()
export class DashboardController {
  constructor(@Inject(DashboardService) private readonly dashboards: DashboardService) {}

  @Get('bases/:baseId/dashboards')
  list(
    @Param('baseId', baseIdPipe) baseId: Id<'bse'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<DashboardList> {
    return this.dashboards.list(principal, baseId);
  }

  @Post('bases/:baseId/dashboards')
  @HttpCode(201)
  create(
    @Param('baseId', baseIdPipe) baseId: Id<'bse'>,
    @Body(new ZodValidationPipe(createDashboardRequestSchema)) body: CreateDashboardRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<DashboardDto> {
    return this.dashboards.create(principal, baseId, body, requestMetaOf(request));
  }

  @Get('bases/:baseId/dashboards/trash')
  trash(
    @Param('baseId', baseIdPipe) baseId: Id<'bse'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<DashboardTrash> {
    return this.dashboards.trash(principal, baseId);
  }

  @Get('dashboards/:dashboardId')
  get(
    @Param('dashboardId', dashboardIdPipe) dashboardId: Id<'dsh'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<DashboardDto> {
    return this.dashboards.get(principal, dashboardId);
  }

  @Patch('dashboards/:dashboardId')
  update(
    @Param('dashboardId', dashboardIdPipe) dashboardId: Id<'dsh'>,
    @Body(new ZodValidationPipe(updateDashboardRequestSchema)) body: UpdateDashboardRequest,
    @Headers('if-match') ifMatch: string | undefined,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<DashboardDto> {
    return this.dashboards.update(
      principal,
      dashboardId,
      body,
      dashboardIfMatchOf(ifMatch),
      requestMetaOf(request),
    );
  }

  @Delete('dashboards/:dashboardId')
  @HttpCode(204)
  async remove(
    @Param('dashboardId', dashboardIdPipe) dashboardId: Id<'dsh'>,
    @Headers('if-match') ifMatch: string | undefined,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.dashboards.remove(
      principal,
      dashboardId,
      dashboardIfMatchOf(ifMatch),
      requestMetaOf(request),
    );
  }

  @Post('dashboards/:dashboardId/restore')
  @HttpCode(200)
  restore(
    @Param('dashboardId', dashboardIdPipe) dashboardId: Id<'dsh'>,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<DashboardDto> {
    return this.dashboards.restore(principal, dashboardId, requestMetaOf(request));
  }

  @Post('dashboards/:dashboardId/duplicate')
  @HttpCode(201)
  duplicate(
    @Param('dashboardId', dashboardIdPipe) dashboardId: Id<'dsh'>,
    @Body(duplicateBodyPipe) body: DuplicateDashboardRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<DashboardDto> {
    return this.dashboards.duplicate(principal, dashboardId, body, requestMetaOf(request));
  }

  @Put('dashboards/:dashboardId/layout')
  updateLayout(
    @Param('dashboardId', dashboardIdPipe) dashboardId: Id<'dsh'>,
    @Body(new ZodValidationPipe(updateDashboardLayoutRequestSchema))
    body: UpdateDashboardLayoutRequest,
    @Headers('if-match') ifMatch: string | undefined,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<DashboardDto> {
    return this.dashboards.updateLayout(
      principal,
      dashboardId,
      body,
      dashboardIfMatchOf(ifMatch),
      requestMetaOf(request),
    );
  }
}
