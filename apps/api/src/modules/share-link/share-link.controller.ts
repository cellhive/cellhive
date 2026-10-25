import {
  createShareLinkRequestSchema,
  idOf,
  orgShareLinkListQuerySchema,
  revokeShareLinksRequestSchema,
  shareLinkListQuerySchema,
  updateShareLinkRequestSchema,
  type CreatedShareLinkDto,
  type CreateShareLinkRequest,
  type Id,
  type OrgShareLinkListQuery,
  type RevokeShareLinksRequest,
  type RevokeShareLinksResponse,
  type ShareLinkDto,
  type ShareLinkList,
  type ShareLinkListQuery,
  type ShareLinkPreview,
  type UpdateShareLinkRequest,
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
  Query,
  Req,
} from '@nestjs/common';

import { CurrentPrincipal, type Principal } from '../../common/auth/principal.js';
import { requestMetaOf } from '../../common/auth/request-meta.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';

import { ShareLinkService } from './share-link.service.js';

import type { FastifyRequest } from 'fastify';

const viewIdPipe = new ZodValidationPipe(idOf('viw'));
const dashboardIdPipe = new ZodValidationPipe(idOf('dsh'));
const linkIdPipe = new ZodValidationPipe(idOf('shl'));
const baseIdPipe = new ZodValidationPipe(idOf('bse'));
const orgIdPipe = new ZodValidationPipe(idOf('org'));

/** Share link management (SPEC §15A, CONTRACTS §16; BACKLOG T304, dashboards T809). */
@Controller()
export class ShareLinkController {
  constructor(@Inject(ShareLinkService) private readonly links: ShareLinkService) {}

  @Get('views/:viewId/share-links')
  listForView(
    @Param('viewId', viewIdPipe) viewId: Id<'viw'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ShareLinkList> {
    return this.links.listForView(principal, viewId);
  }

  @Get('views/:viewId/share-links/preview')
  preview(
    @Param('viewId', viewIdPipe) viewId: Id<'viw'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ShareLinkPreview> {
    return this.links.preview(principal, viewId);
  }

  @Post('views/:viewId/share-links')
  @HttpCode(201)
  create(
    @Param('viewId', viewIdPipe) viewId: Id<'viw'>,
    @Body(
      new ZodValidationPipe(
        createShareLinkRequestSchema.default({ audience: 'org', enabled: true }),
      ),
    )
    body: CreateShareLinkRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<CreatedShareLinkDto> {
    return this.links.create(principal, viewId, body, requestMetaOf(request));
  }

  @Get('dashboards/:dashboardId/share-links')
  listForDashboard(
    @Param('dashboardId', dashboardIdPipe) dashboardId: Id<'dsh'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ShareLinkList> {
    return this.links.listForDashboard(principal, dashboardId);
  }

  @Post('dashboards/:dashboardId/share-links')
  @HttpCode(201)
  createForDashboard(
    @Param('dashboardId', dashboardIdPipe) dashboardId: Id<'dsh'>,
    @Body(
      new ZodValidationPipe(
        createShareLinkRequestSchema.default({ audience: 'org', enabled: true }),
      ),
    )
    body: CreateShareLinkRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<CreatedShareLinkDto> {
    return this.links.createForDashboard(principal, dashboardId, body, requestMetaOf(request));
  }

  @Get('share-links/:shareLinkId')
  get(
    @Param('shareLinkId', linkIdPipe) linkId: Id<'shl'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ShareLinkDto> {
    return this.links.get(principal, linkId);
  }

  @Patch('share-links/:shareLinkId')
  update(
    @Param('shareLinkId', linkIdPipe) linkId: Id<'shl'>,
    @Body(new ZodValidationPipe(updateShareLinkRequestSchema)) body: UpdateShareLinkRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<ShareLinkDto> {
    return this.links.update(principal, linkId, body, requestMetaOf(request));
  }

  @Delete('share-links/:shareLinkId')
  @HttpCode(204)
  async revoke(
    @Param('shareLinkId', linkIdPipe) linkId: Id<'shl'>,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.links.revoke(principal, linkId, requestMetaOf(request));
  }

  @Post('share-links/:shareLinkId/regenerate')
  @HttpCode(201)
  regenerate(
    @Param('shareLinkId', linkIdPipe) linkId: Id<'shl'>,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<CreatedShareLinkDto> {
    return this.links.regenerate(principal, linkId, requestMetaOf(request));
  }

  @Get('bases/:baseId/share-links')
  listForBase(
    @Param('baseId', baseIdPipe) baseId: Id<'bse'>,
    @Query(new ZodValidationPipe(shareLinkListQuerySchema)) query: ShareLinkListQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ShareLinkList> {
    return this.links.listForBase(principal, baseId, query);
  }

  @Post('bases/:baseId/share-links/revoke')
  @HttpCode(200)
  revokeForBase(
    @Param('baseId', baseIdPipe) baseId: Id<'bse'>,
    @Body(new ZodValidationPipe(revokeShareLinksRequestSchema)) body: RevokeShareLinksRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<RevokeShareLinksResponse> {
    return this.links.revokeForBase(principal, baseId, body, requestMetaOf(request));
  }

  @Get('orgs/:orgId/share-links')
  listForOrg(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @Query(new ZodValidationPipe(orgShareLinkListQuerySchema)) query: OrgShareLinkListQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ShareLinkList> {
    return this.links.listForOrg(principal, orgId, query);
  }

  @Post('orgs/:orgId/share-links/revoke')
  @HttpCode(200)
  revokeForOrg(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @Body(new ZodValidationPipe(revokeShareLinksRequestSchema)) body: RevokeShareLinksRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<RevokeShareLinksResponse> {
    return this.links.revokeForOrg(principal, orgId, body, requestMetaOf(request));
  }
}
