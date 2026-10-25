import {
  baseAuditLogQuerySchema,
  exportAuditLogsRequestSchema,
  exportBaseAuditLogsRequestSchema,
  idOf,
  orgAuditLogQuerySchema,
  redactAuditLogsRequestSchema,
  type AuditLogList,
  type BaseAuditLogQuery,
  type ExportAuditLogsRequest,
  type ExportBaseAuditLogsRequest,
  type Id,
  type JobAccepted,
  type OrgAuditLogQuery,
  type RedactAuditLogsRequest,
  type RedactAuditLogsResponse,
} from '@cellhive/contracts';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';

import { CurrentPrincipal, type Principal } from '../../common/auth/principal.js';
import { requestMetaOf } from '../../common/auth/request-meta.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';

import { AuditService } from './audit.service.js';

import type { FastifyRequest } from 'fastify';

const orgIdPipe = new ZodValidationPipe(idOf('org'));
const baseIdPipe = new ZodValidationPipe(idOf('bse'));

/** Audit log admin API (ADR-23, CONTRACTS §11.4). */
@Controller()
export class AuditController {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  @Get('orgs/:orgId/audit-logs')
  listOrg(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @Query(new ZodValidationPipe(orgAuditLogQuerySchema)) query: OrgAuditLogQuery,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<AuditLogList> {
    return this.audit.listOrg(principal, orgId, query, requestMetaOf(request));
  }

  @Get('bases/:baseId/audit-logs')
  listBase(
    @Param('baseId', baseIdPipe) baseId: Id<'bse'>,
    @Query(new ZodValidationPipe(baseAuditLogQuerySchema)) query: BaseAuditLogQuery,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<AuditLogList> {
    return this.audit.listBase(principal, baseId, query, requestMetaOf(request));
  }

  @Post('orgs/:orgId/audit-logs/export')
  @HttpCode(202)
  export(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @Body(new ZodValidationPipe(exportAuditLogsRequestSchema)) body: ExportAuditLogsRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<JobAccepted> {
    return this.audit.export(principal, orgId, body, requestMetaOf(request));
  }

  @Post('bases/:baseId/audit-logs/export')
  @HttpCode(202)
  exportBase(
    @Param('baseId', baseIdPipe) baseId: Id<'bse'>,
    @Body(new ZodValidationPipe(exportBaseAuditLogsRequestSchema))
    body: ExportBaseAuditLogsRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<JobAccepted> {
    return this.audit.exportBase(principal, baseId, body, requestMetaOf(request));
  }

  @Post('orgs/:orgId/audit-logs/redact')
  @HttpCode(200)
  redact(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @Body(new ZodValidationPipe(redactAuditLogsRequestSchema)) body: RedactAuditLogsRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<RedactAuditLogsResponse> {
    return this.audit.redact(principal, orgId, body, requestMetaOf(request));
  }
}
