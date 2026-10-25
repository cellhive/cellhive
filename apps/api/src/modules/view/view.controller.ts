import {
  createViewRequestSchema,
  duplicateViewRequestSchema,
  idOf,
  offsetQuerySchema,
  updateViewRequestSchema,
  type CreateViewRequest,
  type DuplicateViewRequest,
  type Id,
  type OffsetQuery,
  type UpdateViewRequest,
  type ViewDto,
  type ViewList,
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

import { ViewService } from './view.service.js';

import type { FastifyRequest } from 'fastify';

const tableIdPipe = new ZodValidationPipe(idOf('tbl'));
const viewIdPipe = new ZodValidationPipe(idOf('viw'));

/** `/tables/:tableId/views` and `/views/:viewId` (SPEC §8, CONTRACTS §15). */
@Controller()
export class ViewController {
  constructor(@Inject(ViewService) private readonly views: ViewService) {}

  @Get('tables/:tableId/views')
  list(
    @Param('tableId', tableIdPipe) tableId: Id<'tbl'>,
    @Query(new ZodValidationPipe(offsetQuerySchema)) query: OffsetQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ViewList> {
    return this.views.list(principal, tableId, query);
  }

  @Post('tables/:tableId/views')
  @HttpCode(201)
  create(
    @Param('tableId', tableIdPipe) tableId: Id<'tbl'>,
    @Body(new ZodValidationPipe(createViewRequestSchema)) body: CreateViewRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<ViewDto> {
    return this.views.create(principal, tableId, body, requestMetaOf(request));
  }

  @Get('views/:viewId')
  get(
    @Param('viewId', viewIdPipe) viewId: Id<'viw'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ViewDto> {
    return this.views.get(principal, viewId);
  }

  @Patch('views/:viewId')
  update(
    @Param('viewId', viewIdPipe) viewId: Id<'viw'>,
    @Body(new ZodValidationPipe(updateViewRequestSchema)) body: UpdateViewRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<ViewDto> {
    return this.views.update(principal, viewId, body, requestMetaOf(request));
  }

  @Delete('views/:viewId')
  @HttpCode(204)
  async delete(
    @Param('viewId', viewIdPipe) viewId: Id<'viw'>,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.views.delete(principal, viewId, requestMetaOf(request));
  }

  @Post('views/:viewId/duplicate')
  @HttpCode(201)
  duplicate(
    @Param('viewId', viewIdPipe) viewId: Id<'viw'>,
    @Body(new ZodValidationPipe(duplicateViewRequestSchema.default({}))) body: DuplicateViewRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<ViewDto> {
    return this.views.duplicate(principal, viewId, body, requestMetaOf(request));
  }
}
