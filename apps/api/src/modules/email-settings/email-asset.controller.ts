import {
  emailAssetUploadRequestSchema,
  idOf,
  type CreateUploadResponse,
  type EmailAssetDto,
  type EmailAssetUploadRequest,
  type Id,
} from '@cellhive/contracts';
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Res } from '@nestjs/common';

import { AccessService } from '../../common/access/access.service.js';
import { CurrentPrincipal, type Principal } from '../../common/auth/principal.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';
import { sendFileRedirect } from '../file/file-replies.js';

import { EmailAssetService, type EmailAssetOwner } from './email-asset.service.js';

import type { FastifyReply } from 'fastify';

const orgIdPipe = new ZodValidationPipe(idOf('org'));
const assetIdPipe = new ZodValidationPipe(idOf('att'));
const SIGNATURE: EmailAssetOwner = { kind: 'signature' };

/**
 * Signature images of an organization (CONTRACTS §23.5; BACKLOG T534):
 * organization owners/admins only (members `403`, others `404`), like the
 * signatures they illustrate.
 */
@Controller('orgs/:orgId/email-assets')
export class OrgEmailAssetController {
  constructor(
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(EmailAssetService) private readonly assets: EmailAssetService,
  ) {}

  @Post('uploads')
  @HttpCode(201)
  async createUpload(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @Body(new ZodValidationPipe(emailAssetUploadRequestSchema)) body: EmailAssetUploadRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CreateUploadResponse> {
    const org = await this.access.requireOrgAdmin(principal, orgId);
    return this.assets.createUpload(org.scope, SIGNATURE, principal.userId, body);
  }

  @Post('uploads/:assetId/complete')
  @HttpCode(200)
  async complete(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @Param('assetId', assetIdPipe) assetId: Id<'att'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<EmailAssetDto> {
    const org = await this.access.requireOrgAdmin(principal, orgId);
    return this.assets.complete(org.scope, SIGNATURE, principal.userId, assetId);
  }

  @Get(':assetId')
  async read(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @Param('assetId', assetIdPipe) assetId: Id<'att'>,
    @CurrentPrincipal() principal: Principal,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const org = await this.access.requireOrgAdmin(principal, orgId);
    await sendFileRedirect(reply, await this.assets.read(org.scope, SIGNATURE, assetId));
  }

  @Delete(':assetId')
  @HttpCode(204)
  async delete(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @Param('assetId', assetIdPipe) assetId: Id<'att'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    const org = await this.access.requireOrgAdmin(principal, orgId);
    await this.assets.delete(org.scope, SIGNATURE, assetId);
  }
}
