import {
  addWorkspaceMemberRequestSchema,
  createWorkspaceRequestSchema,
  idOf,
  offsetQuerySchema,
  principalIdSchema,
  updateWorkspaceMemberRequestSchema,
  updateWorkspaceRequestSchema,
  type AddWorkspaceMemberRequest,
  type CreateWorkspaceRequest,
  type Id,
  type OffsetQuery,
  type PrincipalId,
  type UpdateWorkspaceMemberRequest,
  type UpdateWorkspaceRequest,
  type WorkspaceDto,
  type WorkspaceList,
  type WorkspaceMemberDto,
  type WorkspaceMemberList,
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

import { WorkspaceService } from './workspace.service.js';

import type { FastifyRequest } from 'fastify';

const orgIdPipe = new ZodValidationPipe(idOf('org'));
const workspaceIdPipe = new ZodValidationPipe(idOf('wsp'));
const principalIdPipe = new ZodValidationPipe(principalIdSchema);
const pagePipe = new ZodValidationPipe(offsetQuerySchema);

/** `/orgs/:orgId/workspaces` and `/workspaces/:workspaceId/members` (SPEC §13.1). */
@Controller()
export class WorkspaceController {
  constructor(@Inject(WorkspaceService) private readonly workspaces: WorkspaceService) {}

  @Get('orgs/:orgId/workspaces')
  list(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @Query(pagePipe) query: OffsetQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<WorkspaceList> {
    return this.workspaces.list(principal, orgId, query);
  }

  @Post('orgs/:orgId/workspaces')
  @HttpCode(201)
  create(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @Body(new ZodValidationPipe(createWorkspaceRequestSchema)) body: CreateWorkspaceRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<WorkspaceDto> {
    return this.workspaces.create(principal, orgId, body, requestMetaOf(request));
  }

  @Get('orgs/:orgId/workspaces/:workspaceId')
  get(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @Param('workspaceId', workspaceIdPipe) workspaceId: Id<'wsp'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<WorkspaceDto> {
    return this.workspaces.get(principal, orgId, workspaceId);
  }

  @Patch('orgs/:orgId/workspaces/:workspaceId')
  update(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @Param('workspaceId', workspaceIdPipe) workspaceId: Id<'wsp'>,
    @Body(new ZodValidationPipe(updateWorkspaceRequestSchema)) body: UpdateWorkspaceRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<WorkspaceDto> {
    return this.workspaces.update(principal, orgId, workspaceId, body, requestMetaOf(request));
  }

  @Delete('orgs/:orgId/workspaces/:workspaceId')
  @HttpCode(204)
  async delete(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @Param('workspaceId', workspaceIdPipe) workspaceId: Id<'wsp'>,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.workspaces.delete(principal, orgId, workspaceId, requestMetaOf(request));
  }

  @Get('workspaces/:workspaceId/members')
  listMembers(
    @Param('workspaceId', workspaceIdPipe) workspaceId: Id<'wsp'>,
    @Query(pagePipe) query: OffsetQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<WorkspaceMemberList> {
    return this.workspaces.listMembers(principal, workspaceId, query);
  }

  @Post('workspaces/:workspaceId/members')
  @HttpCode(201)
  addMember(
    @Param('workspaceId', workspaceIdPipe) workspaceId: Id<'wsp'>,
    @Body(new ZodValidationPipe(addWorkspaceMemberRequestSchema)) body: AddWorkspaceMemberRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<WorkspaceMemberDto> {
    return this.workspaces.addMember(principal, workspaceId, body, requestMetaOf(request));
  }

  @Patch('workspaces/:workspaceId/members/:principalId')
  updateMember(
    @Param('workspaceId', workspaceIdPipe) workspaceId: Id<'wsp'>,
    @Param('principalId', principalIdPipe) principalId: PrincipalId,
    @Body(new ZodValidationPipe(updateWorkspaceMemberRequestSchema))
    body: UpdateWorkspaceMemberRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<WorkspaceMemberDto> {
    return this.workspaces.updateMember(
      principal,
      workspaceId,
      principalId,
      body,
      requestMetaOf(request),
    );
  }

  @Delete('workspaces/:workspaceId/members/:principalId')
  @HttpCode(204)
  async removeMember(
    @Param('workspaceId', workspaceIdPipe) workspaceId: Id<'wsp'>,
    @Param('principalId', principalIdPipe) principalId: PrincipalId,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.workspaces.removeMember(principal, workspaceId, principalId, requestMetaOf(request));
  }
}
