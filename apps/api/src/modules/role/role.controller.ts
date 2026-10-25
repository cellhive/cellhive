import {
  assignRoleRequestSchema,
  createRoleRequestSchema,
  idOf,
  offsetQuerySchema,
  removeRoleAssignmentRequestSchema,
  updateRoleRequestSchema,
  type AssignRoleRequest,
  type CreateRoleRequest,
  type Id,
  type OffsetQuery,
  type RemoveRoleAssignmentRequest,
  type RoleAssignmentDto,
  type RoleDto,
  type RoleList,
  type RoleWithAdjustments,
  type UpdateRoleRequest,
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

import { CurrentBase, RequireBase } from '../../common/access/require-base.js';
import { CurrentPrincipal, type Principal } from '../../common/auth/principal.js';
import { requestMetaOf } from '../../common/auth/request-meta.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';

import { RoleService } from './role.service.js';

import type { BaseAccess } from '../../common/access/access.service.js';
import type { FastifyRequest } from 'fastify';

const roleIdPipe = new ZodValidationPipe(idOf('rol'));

/**
 * `/bases/:baseId/roles` and `/bases/:baseId/role-assignments` (SPEC §13.1,
 * BACKLOG T109). Base admins only: others who can open the base get `403`,
 * everyone else `404`.
 */
@Controller('bases/:baseId')
@RequireBase('admin')
export class RoleController {
  constructor(@Inject(RoleService) private readonly roles: RoleService) {}

  @Get('roles')
  list(
    @CurrentBase() base: BaseAccess,
    @Query(new ZodValidationPipe(offsetQuerySchema)) query: OffsetQuery,
  ): Promise<RoleList> {
    return this.roles.list(base, query);
  }

  @Post('roles')
  @HttpCode(201)
  create(
    @CurrentBase() base: BaseAccess,
    @Body(new ZodValidationPipe(createRoleRequestSchema)) body: CreateRoleRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<RoleWithAdjustments> {
    return this.roles.create(principal, base, body, requestMetaOf(request));
  }

  @Get('roles/:roleId')
  get(
    @CurrentBase() base: BaseAccess,
    @Param('roleId', roleIdPipe) roleId: Id<'rol'>,
  ): Promise<RoleDto> {
    return this.roles.get(base, roleId);
  }

  @Patch('roles/:roleId')
  update(
    @CurrentBase() base: BaseAccess,
    @Param('roleId', roleIdPipe) roleId: Id<'rol'>,
    @Body(new ZodValidationPipe(updateRoleRequestSchema)) body: UpdateRoleRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<RoleWithAdjustments> {
    return this.roles.update(principal, base, roleId, body, requestMetaOf(request));
  }

  @Delete('roles/:roleId')
  @HttpCode(204)
  async delete(
    @CurrentBase() base: BaseAccess,
    @Param('roleId', roleIdPipe) roleId: Id<'rol'>,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.roles.delete(principal, base, roleId, requestMetaOf(request));
  }

  @Put('role-assignments')
  assign(
    @CurrentBase() base: BaseAccess,
    @Body(new ZodValidationPipe(assignRoleRequestSchema)) body: AssignRoleRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<RoleAssignmentDto> {
    return this.roles.assign(principal, base, body, requestMetaOf(request));
  }

  @Delete('role-assignments')
  @HttpCode(204)
  async removeAssignment(
    @CurrentBase() base: BaseAccess,
    @Body(new ZodValidationPipe(removeRoleAssignmentRequestSchema))
    body: RemoveRoleAssignmentRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.roles.removeAssignment(principal, base, body, requestMetaOf(request));
  }
}
