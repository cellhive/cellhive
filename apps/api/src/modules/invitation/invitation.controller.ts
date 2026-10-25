import {
  acceptInvitationRequestSchema,
  createInvitationRequestSchema,
  idOf,
  invitationListQuerySchema,
  type AcceptInvitationRequest,
  type AcceptInvitationResponse,
  type CreatedInvitation,
  type CreateInvitationRequest,
  type Id,
  type InvitationDto,
  type InvitationList,
  type InvitationListQuery,
  type InvitationPreview,
} from '@cellhive/contracts';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';

import {
  CurrentPrincipal,
  OptionalPrincipal,
  Public,
  type Principal,
} from '../../common/auth/principal.js';
import { requestMetaOf } from '../../common/auth/request-meta.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';

import { InvitationService } from './invitation.service.js';

import type { FastifyRequest } from 'fastify';

const orgIdPipe = new ZodValidationPipe(idOf('org'));
const invitationIdPipe = new ZodValidationPipe(idOf('inv'));

/** `/orgs/:orgId/invitations` and `/invitations/:token` (SPEC §13.1, §14.1A). */
@Controller()
export class InvitationController {
  constructor(@Inject(InvitationService) private readonly invitations: InvitationService) {}

  @Get('orgs/:orgId/invitations')
  list(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @Query(new ZodValidationPipe(invitationListQuerySchema)) query: InvitationListQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<InvitationList> {
    return this.invitations.list(principal, orgId, query);
  }

  @Post('orgs/:orgId/invitations')
  @HttpCode(201)
  create(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @Body(new ZodValidationPipe(createInvitationRequestSchema)) body: CreateInvitationRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<CreatedInvitation> {
    return this.invitations.create(principal, orgId, body, requestMetaOf(request));
  }

  @Get('orgs/:orgId/invitations/:invitationId')
  get(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @Param('invitationId', invitationIdPipe) invitationId: Id<'inv'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<InvitationDto> {
    return this.invitations.get(principal, orgId, invitationId);
  }

  @Delete('orgs/:orgId/invitations/:invitationId')
  @HttpCode(204)
  async revoke(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @Param('invitationId', invitationIdPipe) invitationId: Id<'inv'>,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.invitations.revoke(principal, orgId, invitationId, requestMetaOf(request));
  }

  @Get('invitations/:token')
  @Public()
  preview(
    @Param('token') token: string,
    @Req() request: FastifyRequest,
  ): Promise<InvitationPreview> {
    return this.invitations.preview(token, requestMetaOf(request));
  }

  @Post('invitations/:token/accept')
  @Public()
  @HttpCode(200)
  accept(
    @Param('token') token: string,
    @Body(new ZodValidationPipe(acceptInvitationRequestSchema.optional()))
    body: AcceptInvitationRequest | undefined,
    @OptionalPrincipal() principal: Principal | undefined,
    @Req() request: FastifyRequest,
  ): Promise<AcceptInvitationResponse> {
    return this.invitations.accept(token, body, principal, requestMetaOf(request));
  }
}
