import {
  aiUsageQuerySchema,
  idOf,
  testAiSettingsRequestSchema,
  updateAiSettingsRequestSchema,
  type AiSettingsDto,
  type AiSettingsTestResult,
  type AiUsageDto,
  type AiUsageQuery,
  type Id,
  type TestAiSettingsRequest,
  type UpdateAiSettingsRequest,
} from '@cellhive/contracts';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';

import { CurrentPrincipal, type Principal } from '../../common/auth/principal.js';
import { requestMetaOf } from '../../common/auth/request-meta.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';

import { AiSettingsService } from './ai-settings.service.js';

import type { FastifyRequest } from 'fastify';

const orgIdPipe = new ZodValidationPipe(idOf('org'));

/** AI settings, "Test connection" and usage of an organization (CONTRACTS §29.1, BACKLOG T906). */
@Controller('orgs/:orgId')
export class AiSettingsController {
  constructor(@Inject(AiSettingsService) private readonly settings: AiSettingsService) {}

  @Get('ai-settings')
  get(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AiSettingsDto> {
    return this.settings.get(principal, orgId);
  }

  @Put('ai-settings')
  update(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @Body(new ZodValidationPipe(updateAiSettingsRequestSchema)) body: UpdateAiSettingsRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<AiSettingsDto> {
    return this.settings.update(principal, orgId, body, requestMetaOf(request));
  }

  @Post('ai-settings/test')
  @HttpCode(200)
  test(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @Body(new ZodValidationPipe(testAiSettingsRequestSchema.default({})))
    body: TestAiSettingsRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<AiSettingsTestResult> {
    return this.settings.test(principal, orgId, body, requestMetaOf(request));
  }

  @Get('ai-usage')
  usage(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @Query(new ZodValidationPipe(aiUsageQuerySchema)) query: AiUsageQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AiUsageDto> {
    return this.settings.usage(principal, orgId, query);
  }
}
