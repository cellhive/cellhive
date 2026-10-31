import {
  createOrganizationRequestSchema,
  idOf,
  offsetQuerySchema,
  removeOrgMemberRequestSchema,
  updateOrganizationRequestSchema,
  updateOrgMemberRequestSchema,
  type CreateOrganizationRequest,
  type Id,
  type OffsetQuery,
  type OrganizationDetailDto,
  type OrganizationDto,
  type OrganizationList,
  type OrgMemberDto,
  type OrgMemberList,
  type RemoveOrgMemberRequest,
  type UpdateOrganizationRequest,
  type UpdateOrgMemberRequest,
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

import { OrgMemberService } from './org-member.service.js';
import { OrgService } from './org.service.js';

import type { FastifyRequest } from 'fastify';

const orgIdPipe = new ZodValidationPipe(idOf('org'));
const userIdPipe = new ZodValidationPipe(idOf('usr'));

/** `/orgs`, `/orgs/:orgId` and `/orgs/:orgId/members` (SPEC §13.1). */
@Controller('orgs')
export class OrgController {
  constructor(
    @Inject(OrgService) private readonly orgs: OrgService,
    @Inject(OrgMemberService) private readonly members: OrgMemberService,
  ) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(offsetQuerySchema)) query: OffsetQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<OrganizationList> {
    return this.orgs.list(principal, query);
  }

  @Post()
  @HttpCode(201)
  create(
    @Body(new ZodValidationPipe(createOrganizationRequestSchema)) body: CreateOrganizationRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<OrganizationDto> {
    return this.orgs.create(principal, body, requestMetaOf(request));
  }

  @Get(':orgId')
  get(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<OrganizationDetailDto> {
    return this.orgs.get(principal, orgId);
  }

  @Patch(':orgId')
  update(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @Body(new ZodValidationPipe(updateOrganizationRequestSchema)) body: UpdateOrganizationRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<OrganizationDto> {
    return this.orgs.update(principal, orgId, body, requestMetaOf(request));
  }

  @Get(':orgId/members')
  listMembers(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @Query(new ZodValidationPipe(offsetQuerySchema)) query: OffsetQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<OrgMemberList> {
    return this.members.list(principal, orgId, query);
  }

  @Get(':orgId/members/:userId')
  getMember(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @Param('userId', userIdPipe) userId: Id<'usr'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<OrgMemberDto> {
    return this.members.get(principal, orgId, userId);
  }

  @Patch(':orgId/members/:userId')
  updateMember(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @Param('userId', userIdPipe) userId: Id<'usr'>,
    @Body(new ZodValidationPipe(updateOrgMemberRequestSchema)) body: UpdateOrgMemberRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<OrgMemberDto> {
    return this.members.update(principal, orgId, userId, body, requestMetaOf(request));
  }

  @Delete(':orgId/members/:userId')
  @HttpCode(204)
  async removeMember(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @Param('userId', userIdPipe) userId: Id<'usr'>,
    @Body(new ZodValidationPipe(removeOrgMemberRequestSchema.optional()))
    body: RemoveOrgMemberRequest | undefined,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.members.remove(principal, orgId, userId, body ?? {}, requestMetaOf(request));
  }
}
