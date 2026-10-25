import {
  emailAssetUploadRequestSchema,
  idOf,
  type CreateUploadResponse,
  type EmailAssetDto,
  type EmailAssetUploadRequest,
  type Id,
} from '@cellhive/contracts';
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Res } from '@nestjs/common';

import { CurrentPrincipal, type Principal } from '../../common/auth/principal.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { EmailAssetService } from '../email-settings/email-asset.service.js';
import { sendFileRedirect } from '../file/file-replies.js';

import { AutomationService } from './automation.service.js';

import type { FastifyReply } from 'fastify';

const automationIdPipe = new ZodValidationPipe(idOf('aut'));
const assetIdPipe = new ZodValidationPipe(idOf('att'));

/**
 * Images of an automation's email body (CONTRACTS §23.5; BACKLOG T534):
 * people who manage the automation (`404` when they cannot see it, `403`
 * when they see but do not manage it, like the other automation routes).
 */
@Controller('automations/:automationId/email-assets')
export class AutomationEmailAssetController {
  constructor(
    @Inject(AutomationService) private readonly automations: AutomationService,
    @Inject(EmailAssetService) private readonly assets: EmailAssetService,
  ) {}

  private async owner(principal: Principal, automationId: Id<'aut'>) {
    const { base, row } = await this.automations.locate(principal, automationId);
    return { scope: base.org.scope, owner: { kind: 'automation', automationId: row.id } as const };
  }

  @Post('uploads')
  @HttpCode(201)
  async createUpload(
    @Param('automationId', automationIdPipe) automationId: Id<'aut'>,
    @Body(new ZodValidationPipe(emailAssetUploadRequestSchema)) body: EmailAssetUploadRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CreateUploadResponse> {
    const { scope, owner } = await this.owner(principal, automationId);
    return this.assets.createUpload(scope, owner, principal.userId, body);
  }

  @Post('uploads/:assetId/complete')
  @HttpCode(200)
  async complete(
    @Param('automationId', automationIdPipe) automationId: Id<'aut'>,
    @Param('assetId', assetIdPipe) assetId: Id<'att'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<EmailAssetDto> {
    const { scope, owner } = await this.owner(principal, automationId);
    return this.assets.complete(scope, owner, principal.userId, assetId);
  }

  @Get(':assetId')
  async read(
    @Param('automationId', automationIdPipe) automationId: Id<'aut'>,
    @Param('assetId', assetIdPipe) assetId: Id<'att'>,
    @CurrentPrincipal() principal: Principal,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const { scope, owner } = await this.owner(principal, automationId);
    await sendFileRedirect(reply, await this.assets.read(scope, owner, assetId));
  }

  @Delete(':assetId')
  @HttpCode(204)
  async delete(
    @Param('automationId', automationIdPipe) automationId: Id<'aut'>,
    @Param('assetId', assetIdPipe) assetId: Id<'att'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    const { scope, owner } = await this.owner(principal, automationId);
    await this.assets.delete(scope, owner, assetId);
  }
}
