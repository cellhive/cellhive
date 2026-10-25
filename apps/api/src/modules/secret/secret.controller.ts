import {
  baseSecretListQuerySchema,
  createSecretRequestSchema,
  idOf,
  secretIdSchema,
  updateSecretRequestSchema,
  type BaseSecretList,
  type BaseSecretListQuery,
  type CreateSecretRequest,
  type Id,
  type SecretWithValueDto,
  type SecretList,
  type SecretUsages,
  type UpdateSecretRequest,
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

import { SecretService } from './secret.service.js';

import type { FastifyRequest } from 'fastify';

const orgIdPipe = new ZodValidationPipe(idOf('org'));
const baseIdPipe = new ZodValidationPipe(idOf('bse'));
const secretIdPipe = new ZodValidationPipe(secretIdSchema);

/** Organization secrets (CONTRACTS §24, BACKLOG T516, T606). */
@Controller()
export class SecretController {
  constructor(@Inject(SecretService) private readonly secrets: SecretService) {}

  @Get('orgs/:orgId/secrets')
  list(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<SecretList> {
    return this.secrets.list(principal, orgId);
  }

  @Post('orgs/:orgId/secrets')
  @HttpCode(201)
  create(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @Body(new ZodValidationPipe(createSecretRequestSchema)) body: CreateSecretRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<SecretWithValueDto> {
    return this.secrets.create(principal, orgId, body, requestMetaOf(request));
  }

  @Get('bases/:baseId/secrets')
  listForBase(
    @Param('baseId', baseIdPipe) baseId: Id<'bse'>,
    @Query(new ZodValidationPipe(baseSecretListQuerySchema)) query: BaseSecretListQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<BaseSecretList> {
    return this.secrets.listForBase(principal, baseId, query);
  }

  @Patch('secrets/:secretId')
  update(
    @Param('secretId', secretIdPipe) secretId: Id<'sec'>,
    @Body(new ZodValidationPipe(updateSecretRequestSchema)) body: UpdateSecretRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<SecretWithValueDto> {
    return this.secrets.update(principal, secretId, body, requestMetaOf(request));
  }

  @Delete('secrets/:secretId')
  @HttpCode(204)
  async remove(
    @Param('secretId', secretIdPipe) secretId: Id<'sec'>,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.secrets.remove(principal, secretId, requestMetaOf(request));
  }

  @Get('secrets/:secretId/usages')
  usages(
    @Param('secretId', secretIdPipe) secretId: Id<'sec'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<SecretUsages> {
    return this.secrets.usages(principal, secretId);
  }
}
