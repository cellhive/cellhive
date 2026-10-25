import {
  createHttpAllowlistEntryRequestSchema,
  httpAllowlistEntryIdSchema,
  idOf,
  type CreateHttpAllowlistEntryRequest,
  type HttpAllowlist,
  type HttpAllowlistEntryDto,
  type Id,
} from '@cellhive/contracts';
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';

import { CurrentPrincipal, type Principal } from '../../common/auth/principal.js';
import { requestMetaOf } from '../../common/auth/request-meta.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';

import { HttpAllowlistService } from './http-allowlist.service.js';

import type { FastifyRequest } from 'fastify';

const orgIdPipe = new ZodValidationPipe(idOf('org'));

/** Outbound HTTP allowlist of an organization (CONTRACTS §25.4, BACKLOG T600). */
@Controller()
export class HttpAllowlistController {
  constructor(@Inject(HttpAllowlistService) private readonly allowlist: HttpAllowlistService) {}

  @Get('orgs/:orgId/http-allowlist')
  list(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<HttpAllowlist> {
    return this.allowlist.list(principal, orgId);
  }

  @Post('orgs/:orgId/http-allowlist')
  @HttpCode(201)
  create(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @Body(new ZodValidationPipe(createHttpAllowlistEntryRequestSchema))
    body: CreateHttpAllowlistEntryRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<HttpAllowlistEntryDto> {
    return this.allowlist.create(principal, orgId, body, requestMetaOf(request));
  }

  @Delete('http-allowlist/:allowlistEntryId')
  @HttpCode(204)
  async remove(
    @Param('allowlistEntryId', new ZodValidationPipe(httpAllowlistEntryIdSchema))
    entryId: Id<'hal'>,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.allowlist.remove(principal, entryId, requestMetaOf(request));
  }
}
