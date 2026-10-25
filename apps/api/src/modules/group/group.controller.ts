import {
  addGroupMemberRequestSchema,
  createGroupRequestSchema,
  idOf,
  offsetQuerySchema,
  updateGroupRequestSchema,
  type AddGroupMemberRequest,
  type CreateGroupRequest,
  type GroupDto,
  type GroupList,
  type GroupMemberDto,
  type GroupMemberList,
  type Id,
  type OffsetQuery,
  type UpdateGroupRequest,
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

import { GroupService } from './group.service.js';

import type { FastifyRequest } from 'fastify';

const orgIdPipe = new ZodValidationPipe(idOf('org'));
const groupIdPipe = new ZodValidationPipe(idOf('grp'));
const pagePipe = new ZodValidationPipe(offsetQuerySchema);

/** `/orgs/:orgId/groups` and `/groups/:groupId/members` (SPEC §13.1). */
@Controller()
export class GroupController {
  constructor(@Inject(GroupService) private readonly groups: GroupService) {}

  @Get('orgs/:orgId/groups')
  list(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @Query(pagePipe) query: OffsetQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<GroupList> {
    return this.groups.list(principal, orgId, query);
  }

  @Post('orgs/:orgId/groups')
  @HttpCode(201)
  create(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @Body(new ZodValidationPipe(createGroupRequestSchema)) body: CreateGroupRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<GroupDto> {
    return this.groups.create(principal, orgId, body, requestMetaOf(request));
  }

  @Get('orgs/:orgId/groups/:groupId')
  get(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @Param('groupId', groupIdPipe) groupId: Id<'grp'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<GroupDto> {
    return this.groups.get(principal, orgId, groupId);
  }

  @Patch('orgs/:orgId/groups/:groupId')
  update(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @Param('groupId', groupIdPipe) groupId: Id<'grp'>,
    @Body(new ZodValidationPipe(updateGroupRequestSchema)) body: UpdateGroupRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<GroupDto> {
    return this.groups.update(principal, orgId, groupId, body, requestMetaOf(request));
  }

  @Delete('orgs/:orgId/groups/:groupId')
  @HttpCode(204)
  async delete(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @Param('groupId', groupIdPipe) groupId: Id<'grp'>,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.groups.delete(principal, orgId, groupId, requestMetaOf(request));
  }

  @Get('groups/:groupId/members')
  listMembers(
    @Param('groupId', groupIdPipe) groupId: Id<'grp'>,
    @Query(pagePipe) query: OffsetQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<GroupMemberList> {
    return this.groups.listMembers(principal, groupId, query);
  }

  @Post('groups/:groupId/members')
  @HttpCode(201)
  addMember(
    @Param('groupId', groupIdPipe) groupId: Id<'grp'>,
    @Body(new ZodValidationPipe(addGroupMemberRequestSchema)) body: AddGroupMemberRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<GroupMemberDto> {
    return this.groups.addMember(principal, groupId, body, requestMetaOf(request));
  }

  @Delete('groups/:groupId/members/:userId')
  @HttpCode(204)
  async removeMember(
    @Param('groupId', groupIdPipe) groupId: Id<'grp'>,
    @Param('userId', new ZodValidationPipe(idOf('usr'))) userId: Id<'usr'>,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.groups.removeMember(principal, groupId, userId, requestMetaOf(request));
  }
}
