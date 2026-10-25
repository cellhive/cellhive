import {
  automationIfMatchHeaderSchema,
  automationListQuerySchema,
  createAutomationRequestSchema,
  idOf,
  takeOverAutomationRequestSchema,
  updateAutomationRequestSchema,
  type AutomationDto,
  type AutomationList,
  type AutomationListQuery,
  type CreateAutomationRequest,
  type Id,
  type TakeOverAutomationRequest,
  type UpdateAutomationRequest,
  type ValidateAutomationTemplateRequest,
  type ValidateAutomationTemplateResponse,
  validateAutomationTemplateRequestSchema,
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
} from '@nestjs/common';

import { CurrentPrincipal, type Principal } from '../../common/auth/principal.js';
import { requestMetaOf } from '../../common/auth/request-meta.js';
import { validationFailed } from '../../common/dto.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';

import { AutomationService } from './automation.service.js';

import type { FastifyRequest } from 'fastify';

const baseIdPipe = new ZodValidationPipe(idOf('bse'));
const automationIdPipe = new ZodValidationPipe(idOf('aut'));

/** The optional `If-Match` header (expected `version`), else `422 VALIDATION_FAILED`. */
function ifMatchOf(value: string | undefined): string | undefined {
  if (automationIfMatchHeaderSchema.safeParse({ 'if-match': value }).success) return value;
  throw validationFailed('If-Match must be the automation version.', {
    path: 'if-match',
    code: 'INVALID_FORMAT',
  });
}

/** Automations (SPEC §11, CONTRACTS §21; BACKLOG T502). */
@Controller()
export class AutomationController {
  constructor(@Inject(AutomationService) private readonly automations: AutomationService) {}

  @Get('bases/:baseId/automations')
  list(
    @Param('baseId', baseIdPipe) baseId: Id<'bse'>,
    @Query(new ZodValidationPipe(automationListQuerySchema)) query: AutomationListQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AutomationList> {
    return this.automations.list(principal, baseId, query);
  }

  @Post('bases/:baseId/automations')
  @HttpCode(201)
  create(
    @Param('baseId', baseIdPipe) baseId: Id<'bse'>,
    @Body(new ZodValidationPipe(createAutomationRequestSchema)) body: CreateAutomationRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<AutomationDto> {
    return this.automations.create(principal, baseId, body, requestMetaOf(request));
  }

  @Get('automations/:automationId')
  get(
    @Param('automationId', automationIdPipe) automationId: Id<'aut'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AutomationDto> {
    return this.automations.get(principal, automationId);
  }

  @Patch('automations/:automationId')
  update(
    @Param('automationId', automationIdPipe) automationId: Id<'aut'>,
    @Body(new ZodValidationPipe(updateAutomationRequestSchema)) body: UpdateAutomationRequest,
    @Headers('if-match') ifMatchHeader: string | undefined,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<AutomationDto> {
    return this.automations.update(
      principal,
      automationId,
      body,
      ifMatchOf(ifMatchHeader),
      requestMetaOf(request),
    );
  }

  @Delete('automations/:automationId')
  @HttpCode(204)
  async remove(
    @Param('automationId', automationIdPipe) automationId: Id<'aut'>,
    @Headers('if-match') ifMatchHeader: string | undefined,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.automations.remove(
      principal,
      automationId,
      ifMatchOf(ifMatchHeader),
      requestMetaOf(request),
    );
  }

  @Post('automations/:automationId/enable')
  @HttpCode(200)
  enable(
    @Param('automationId', automationIdPipe) automationId: Id<'aut'>,
    @Headers('if-match') ifMatchHeader: string | undefined,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<AutomationDto> {
    return this.automations.enable(
      principal,
      automationId,
      ifMatchOf(ifMatchHeader),
      requestMetaOf(request),
    );
  }

  @Post('automations/:automationId/disable')
  @HttpCode(200)
  disable(
    @Param('automationId', automationIdPipe) automationId: Id<'aut'>,
    @Headers('if-match') ifMatchHeader: string | undefined,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<AutomationDto> {
    return this.automations.disable(
      principal,
      automationId,
      ifMatchOf(ifMatchHeader),
      requestMetaOf(request),
    );
  }

  @Post('automations/:automationId/take-over')
  @HttpCode(200)
  takeOver(
    @Param('automationId', automationIdPipe) automationId: Id<'aut'>,
    @Body(new ZodValidationPipe(takeOverAutomationRequestSchema)) body: TakeOverAutomationRequest,
    @Headers('if-match') ifMatchHeader: string | undefined,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<AutomationDto> {
    return this.automations.takeOver(
      principal,
      automationId,
      body,
      ifMatchOf(ifMatchHeader),
      requestMetaOf(request),
    );
  }

  @Post('bases/:baseId/automations/validate-template')
  @HttpCode(200)
  validateTemplate(
    @Param('baseId', baseIdPipe) baseId: Id<'bse'>,
    @Body(new ZodValidationPipe(validateAutomationTemplateRequestSchema))
    body: ValidateAutomationTemplateRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ValidateAutomationTemplateResponse> {
    return this.automations.validateTemplate(principal, baseId, body);
  }
}
