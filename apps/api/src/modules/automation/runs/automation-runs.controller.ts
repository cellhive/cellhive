import {
  automationRunListQuerySchema,
  baseAutomationRunListQuerySchema,
  idOf,
  type AutomationRunDetailDto,
  type AutomationRunDto,
  type AutomationRunList,
  type AutomationRunListQuery,
  type BaseAutomationRunListQuery,
  type Id,
} from '@cellhive/contracts';
import { Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';

import { CurrentPrincipal, type Principal } from '../../../common/auth/principal.js';
import { requestMetaOf } from '../../../common/auth/request-meta.js';
import { ZodValidationPipe } from '../../../common/validation/zod-validation.pipe.js';

import { AutomationRunsService } from './automation-runs.service.js';

import type { FastifyRequest } from 'fastify';

const baseIdPipe = new ZodValidationPipe(idOf('bse'));
const automationIdPipe = new ZodValidationPipe(idOf('aut'));
const runIdPipe = new ZodValidationPipe(idOf('run'));

/** Run history of automations (CONTRACTS §21 "Lịch sử chạy"; BACKLOG T518). */
@Controller()
export class AutomationRunsController {
  constructor(@Inject(AutomationRunsService) private readonly runs: AutomationRunsService) {}

  @Get('automations/:automationId/runs')
  listForAutomation(
    @Param('automationId', automationIdPipe) automationId: Id<'aut'>,
    @Query(new ZodValidationPipe(automationRunListQuerySchema)) query: AutomationRunListQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AutomationRunList> {
    return this.runs.listForAutomation(principal, automationId, query);
  }

  @Get('bases/:baseId/automation-runs')
  listForBase(
    @Param('baseId', baseIdPipe) baseId: Id<'bse'>,
    @Query(new ZodValidationPipe(baseAutomationRunListQuerySchema))
    query: BaseAutomationRunListQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AutomationRunList> {
    return this.runs.listForBase(principal, baseId, query);
  }

  @Get('automation-runs/:runId')
  get(
    @Param('runId', runIdPipe) runId: Id<'run'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AutomationRunDetailDto> {
    return this.runs.get(principal, runId);
  }

  @Post('automation-runs/:runId/rerun')
  @HttpCode(201)
  rerun(
    @Param('runId', runIdPipe) runId: Id<'run'>,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<AutomationRunDto> {
    return this.runs.rerun(principal, runId, requestMetaOf(request));
  }

  @Post('automation-runs/:runId/cancel')
  @HttpCode(200)
  cancel(
    @Param('runId', runIdPipe) runId: Id<'run'>,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<AutomationRunDto> {
    return this.runs.cancel(principal, runId, requestMetaOf(request));
  }
}
