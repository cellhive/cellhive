import {
  computedPreviewRequestSchema,
  convertFieldPreviewRequestSchema,
  convertFieldRequestSchema,
  createFieldRequestSchema,
  fieldListQuerySchema,
  idOf,
  revertConversionRequestSchema,
  updateFieldRequestSchema,
  type ComputedPreview,
  type ComputedPreviewRequest,
  type ConvertFieldPreview,
  type ConvertFieldPreviewRequest,
  type ConvertFieldRequest,
  type ConvertFieldResponse,
  type CreateFieldRequest,
  type DeletePreview,
  type FieldDto,
  type FieldList,
  type FieldListQuery,
  type Id,
  type RevertConversionPreview,
  type RevertConversionRequest,
  type UpdateFieldRequest,
  type UpdateFieldResponse,
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

import { CurrentPrincipal, type Principal } from '../../common/auth/principal.js';
import { requestMetaOf } from '../../common/auth/request-meta.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';

import { ComputedPreviewService } from './computed-preview.service.js';
import { FieldConversionService } from './field-conversion.service.js';
import { FieldService } from './field.service.js';

import type { FastifyRequest } from 'fastify';

const tableIdPipe = new ZodValidationPipe(idOf('tbl'));
const fieldIdPipe = new ZodValidationPipe(idOf('fld'));

/** `/tables/:tableId/fields` and `/fields/:fieldId` (SPEC §13.1, BACKLOG T103). */
@Controller()
export class FieldController {
  constructor(
    @Inject(FieldService) private readonly fields: FieldService,
    @Inject(FieldConversionService) private readonly conversions: FieldConversionService,
    @Inject(ComputedPreviewService) private readonly computedPreview: ComputedPreviewService,
  ) {}

  @Get('tables/:tableId/fields')
  list(
    @Param('tableId', tableIdPipe) tableId: Id<'tbl'>,
    @Query(new ZodValidationPipe(fieldListQuerySchema)) query: FieldListQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<FieldList> {
    return this.fields.list(principal, tableId, query);
  }

  @Post('tables/:tableId/fields')
  @HttpCode(201)
  create(
    @Param('tableId', tableIdPipe) tableId: Id<'tbl'>,
    @Body(new ZodValidationPipe(createFieldRequestSchema)) body: CreateFieldRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<FieldDto> {
    return this.fields.create(principal, tableId, body, requestMetaOf(request));
  }

  /** Formula/lookup preview (T456, CONTRACTS §13): values on the first 5 readable records. */
  @Post('tables/:tableId/computed-preview')
  @HttpCode(200)
  previewComputed(
    @Param('tableId', tableIdPipe) tableId: Id<'tbl'>,
    @Body(new ZodValidationPipe(computedPreviewRequestSchema)) body: ComputedPreviewRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ComputedPreview> {
    return this.computedPreview.preview(principal, tableId, body);
  }

  @Get('fields/:fieldId')
  get(
    @Param('fieldId', fieldIdPipe) fieldId: Id<'fld'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<FieldDto> {
    return this.fields.get(principal, fieldId);
  }

  @Get('fields/:fieldId/delete-preview')
  deletePreview(
    @Param('fieldId', fieldIdPipe) fieldId: Id<'fld'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<DeletePreview> {
    return this.fields.deletePreview(principal, fieldId);
  }

  @Patch('fields/:fieldId')
  update(
    @Param('fieldId', fieldIdPipe) fieldId: Id<'fld'>,
    @Body(new ZodValidationPipe(updateFieldRequestSchema)) body: UpdateFieldRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<UpdateFieldResponse> {
    return this.fields.update(principal, fieldId, body, requestMetaOf(request));
  }

  /** Type conversion (CONTRACTS §4.4, T403): `202 { job_id, field }`. */
  @Put('fields/:fieldId')
  @HttpCode(202)
  convert(
    @Param('fieldId', fieldIdPipe) fieldId: Id<'fld'>,
    @Body(new ZodValidationPipe(convertFieldRequestSchema)) body: ConvertFieldRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<ConvertFieldResponse> {
    return this.conversions.convert(principal, fieldId, body, requestMetaOf(request));
  }

  @Post('fields/:fieldId/convert-preview')
  @HttpCode(200)
  previewConversion(
    @Param('fieldId', fieldIdPipe) fieldId: Id<'fld'>,
    @Body(new ZodValidationPipe(convertFieldPreviewRequestSchema)) body: ConvertFieldPreviewRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ConvertFieldPreview> {
    return this.conversions.preview(principal, fieldId, body);
  }

  @Post('fields/:fieldId/revert-conversion/preview')
  @HttpCode(200)
  previewRevert(
    @Param('fieldId', fieldIdPipe) fieldId: Id<'fld'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<RevertConversionPreview> {
    return this.conversions.revertPreview(principal, fieldId);
  }

  @Post('fields/:fieldId/revert-conversion')
  @HttpCode(200)
  revertConversion(
    @Param('fieldId', fieldIdPipe) fieldId: Id<'fld'>,
    @Body(new ZodValidationPipe(revertConversionRequestSchema.optional()))
    body: RevertConversionRequest | undefined,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<FieldDto> {
    return this.conversions.revert(principal, fieldId, body ?? {}, requestMetaOf(request));
  }

  @Post('fields/:fieldId/restore')
  @HttpCode(200)
  restore(
    @Param('fieldId', fieldIdPipe) fieldId: Id<'fld'>,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<FieldDto> {
    return this.fields.restore(principal, fieldId, requestMetaOf(request));
  }

  @Delete('fields/:fieldId')
  @HttpCode(204)
  async delete(
    @Param('fieldId', fieldIdPipe) fieldId: Id<'fld'>,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.fields.delete(principal, fieldId, requestMetaOf(request));
  }
}
