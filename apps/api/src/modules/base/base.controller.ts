import {
  baseListQuerySchema,
  createBaseRequestSchema,
  idOf,
  isId,
  updateBaseRequestSchema,
  type BaseDetail,
  type BaseList,
  type BaseListQuery,
  type BaseMemberList,
  type CreateBaseRequest,
  type Id,
  type UpdateBaseRequest,
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

import { notFound } from '../../common/access/access.service.js';
import { CurrentBase, RequireBase } from '../../common/access/require-base.js';
import { CurrentPrincipal, type Principal } from '../../common/auth/principal.js';
import { requestMetaOf } from '../../common/auth/request-meta.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';

import { BaseService } from './base.service.js';

import type { BaseAccess } from '../../common/access/access.service.js';
import type { FastifyRequest } from 'fastify';

const workspaceIdPipe = new ZodValidationPipe(idOf('wsp'));

/** `/workspaces/:workspaceId/bases` and `/bases/:baseId` (SPEC §13.1, CONTRACTS §5A). */
@Controller()
export class BaseController {
  constructor(@Inject(BaseService) private readonly bases: BaseService) {}

  @Get('workspaces/:workspaceId/bases')
  list(
    @Param('workspaceId', workspaceIdPipe) workspaceId: Id<'wsp'>,
    @Query(new ZodValidationPipe(baseListQuerySchema)) query: BaseListQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<BaseList> {
    return this.bases.list(principal, workspaceId, query);
  }

  @Post('workspaces/:workspaceId/bases')
  @HttpCode(201)
  create(
    @Param('workspaceId', workspaceIdPipe) workspaceId: Id<'wsp'>,
    @Body(new ZodValidationPipe(createBaseRequestSchema)) body: CreateBaseRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<BaseDetail> {
    return this.bases.create(principal, workspaceId, body, requestMetaOf(request));
  }

  @Get('bases/:baseId')
  @RequireBase('read')
  get(@CurrentBase() base: BaseAccess): BaseDetail {
    return this.bases.get(base);
  }

  /** People who can open the base (user pickers, T320): any reader of the base. */
  @Get('bases/:baseId/members')
  @RequireBase('read')
  members(@CurrentBase() base: BaseAccess): Promise<BaseMemberList> {
    return this.bases.members(base);
  }

  @Patch('bases/:baseId')
  @RequireBase('read')
  update(
    @CurrentBase() base: BaseAccess,
    @Body(new ZodValidationPipe(updateBaseRequestSchema)) body: UpdateBaseRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<BaseDetail> {
    return this.bases.update(principal, base, body, requestMetaOf(request));
  }

  @Delete('bases/:baseId')
  @HttpCode(204)
  @RequireBase('read')
  async delete(
    @CurrentBase() base: BaseAccess,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.bases.delete(principal, base, requestMetaOf(request));
  }

  /** No `@RequireBase`: a base in the trash is not readable; the service checks access. */
  @Post('bases/:baseId/restore')
  @HttpCode(200)
  restore(
    @Param('baseId') baseId: string,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<BaseDetail> {
    // Like `@RequireBase`: a malformed ID cannot name an existing base.
    if (!isId('bse', baseId)) throw notFound();
    return this.bases.restore(principal, baseId, requestMetaOf(request));
  }
}
