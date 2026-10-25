import {
  createIncomingWebhookRequestSchema,
  idOf,
  incomingWebhookIdSchema,
  incomingWebhookRequestListQuerySchema,
  updateIncomingWebhookRequestSchema,
  type CreateIncomingWebhookRequest,
  type Id,
  type IncomingWebhookDto,
  type IncomingWebhookList,
  type IncomingWebhookListenResponse,
  type IncomingWebhookRequestList,
  type IncomingWebhookRequestListQuery,
  type IncomingWebhookSampleResponse,
  type IncomingWebhookWithSecretsDto,
  type UpdateIncomingWebhookRequest,
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
  Put,
  Query,
  Req,
} from '@nestjs/common';

import { CurrentPrincipal, type Principal } from '../../common/auth/principal.js';
import { requestMetaOf } from '../../common/auth/request-meta.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';

import { IncomingWebhookService } from './incoming-webhook.service.js';

import type { FastifyRequest } from 'fastify';

const baseIdPipe = new ZodValidationPipe(idOf('bse'));
const hookIdPipe = new ZodValidationPipe(incomingWebhookIdSchema);

/** Incoming webhooks — management (CONTRACTS §25.1, BACKLOG T602). */
@Controller()
export class IncomingWebhookController {
  constructor(@Inject(IncomingWebhookService) private readonly hooks: IncomingWebhookService) {}

  @Get('bases/:baseId/incoming-webhooks')
  list(
    @Param('baseId', baseIdPipe) baseId: Id<'bse'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<IncomingWebhookList> {
    return this.hooks.list(principal, baseId);
  }

  @Post('bases/:baseId/incoming-webhooks')
  @HttpCode(201)
  create(
    @Param('baseId', baseIdPipe) baseId: Id<'bse'>,
    @Body(new ZodValidationPipe(createIncomingWebhookRequestSchema))
    body: CreateIncomingWebhookRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<IncomingWebhookWithSecretsDto> {
    return this.hooks.create(principal, baseId, body, requestMetaOf(request));
  }

  @Get('incoming-webhooks/:incomingWebhookId')
  get(
    @Param('incomingWebhookId', hookIdPipe) hookId: Id<'hok'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<IncomingWebhookDto> {
    return this.hooks.get(principal, hookId);
  }

  @Patch('incoming-webhooks/:incomingWebhookId')
  update(
    @Param('incomingWebhookId', hookIdPipe) hookId: Id<'hok'>,
    @Body(new ZodValidationPipe(updateIncomingWebhookRequestSchema))
    body: UpdateIncomingWebhookRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<IncomingWebhookDto> {
    return this.hooks.update(principal, hookId, body, requestMetaOf(request));
  }

  @Delete('incoming-webhooks/:incomingWebhookId')
  @HttpCode(204)
  async remove(
    @Param('incomingWebhookId', hookIdPipe) hookId: Id<'hok'>,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.hooks.remove(principal, hookId, requestMetaOf(request));
  }

  @Post('incoming-webhooks/:incomingWebhookId/rotate-secret')
  @HttpCode(200)
  rotateSecret(
    @Param('incomingWebhookId', hookIdPipe) hookId: Id<'hok'>,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<IncomingWebhookWithSecretsDto> {
    return this.hooks.rotateSecret(principal, hookId, requestMetaOf(request));
  }

  @Post('incoming-webhooks/:incomingWebhookId/regenerate-token')
  @HttpCode(200)
  regenerateToken(
    @Param('incomingWebhookId', hookIdPipe) hookId: Id<'hok'>,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<IncomingWebhookDto> {
    return this.hooks.regenerateToken(principal, hookId, requestMetaOf(request));
  }

  @Put('incoming-webhooks/:incomingWebhookId/bearer')
  setBearer(
    @Param('incomingWebhookId', hookIdPipe) hookId: Id<'hok'>,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<IncomingWebhookWithSecretsDto> {
    return this.hooks.setBearer(principal, hookId, requestMetaOf(request));
  }

  @Delete('incoming-webhooks/:incomingWebhookId/bearer')
  deleteBearer(
    @Param('incomingWebhookId', hookIdPipe) hookId: Id<'hok'>,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<IncomingWebhookDto> {
    return this.hooks.deleteBearer(principal, hookId, requestMetaOf(request));
  }

  @Get('incoming-webhooks/:incomingWebhookId/requests')
  listRequests(
    @Param('incomingWebhookId', hookIdPipe) hookId: Id<'hok'>,
    @Query(new ZodValidationPipe(incomingWebhookRequestListQuerySchema))
    query: IncomingWebhookRequestListQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<IncomingWebhookRequestList> {
    return this.hooks.listRequests(principal, hookId, query);
  }

  @Post('incoming-webhooks/:incomingWebhookId/listen')
  @HttpCode(200)
  listen(
    @Param('incomingWebhookId', hookIdPipe) hookId: Id<'hok'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<IncomingWebhookListenResponse> {
    return this.hooks.listen(principal, hookId);
  }

  @Delete('incoming-webhooks/:incomingWebhookId/listen')
  @HttpCode(204)
  async stopListening(
    @Param('incomingWebhookId', hookIdPipe) hookId: Id<'hok'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    await this.hooks.stopListening(principal, hookId);
  }

  @Get('incoming-webhooks/:incomingWebhookId/sample')
  sample(
    @Param('incomingWebhookId', hookIdPipe) hookId: Id<'hok'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<IncomingWebhookSampleResponse> {
    return this.hooks.sample(principal, hookId);
  }
}
