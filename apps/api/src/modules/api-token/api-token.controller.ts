import {
  apiTokenIdSchema,
  apiTokenListQuerySchema,
  createApiTokenRequestSchema,
  idOf,
  orgApiTokenListQuerySchema,
  updateApiTokenRequestSchema,
  type ApiTokenDto,
  type ApiTokenList,
  type ApiTokenListQuery,
  type CreateApiTokenRequest,
  type CreatedApiToken,
  type Id,
  type OrgApiTokenList,
  type OrgApiTokenListQuery,
  type UpdateApiTokenRequest,
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

import { ApiTokenService } from './api-token.service.js';

import type { FastifyRequest } from 'fastify';

const orgIdPipe = new ZodValidationPipe(idOf('org'));
const tokenIdPipe = new ZodValidationPipe(apiTokenIdSchema);

/** Personal API tokens: management by session (CONTRACTS §26.4, BACKLOG T703). */
@Controller()
export class ApiTokenController {
  constructor(@Inject(ApiTokenService) private readonly tokens: ApiTokenService) {}

  @Get('orgs/:orgId/me/api-tokens')
  listMine(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @Query(new ZodValidationPipe(apiTokenListQuerySchema)) query: ApiTokenListQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<ApiTokenList> {
    return this.tokens.listMine(principal, orgId, query);
  }

  @Post('orgs/:orgId/me/api-tokens')
  @HttpCode(201)
  create(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @Body(new ZodValidationPipe(createApiTokenRequestSchema)) body: CreateApiTokenRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<CreatedApiToken> {
    return this.tokens.create(principal, orgId, body, requestMetaOf(request));
  }

  @Get('orgs/:orgId/api-tokens')
  listOrg(
    @Param('orgId', orgIdPipe) orgId: Id<'org'>,
    @Query(new ZodValidationPipe(orgApiTokenListQuerySchema)) query: OrgApiTokenListQuery,
    @CurrentPrincipal() principal: Principal,
  ): Promise<OrgApiTokenList> {
    return this.tokens.listOrg(principal, orgId, query);
  }

  @Patch('api-tokens/:apiTokenId')
  rename(
    @Param('apiTokenId', tokenIdPipe) tokenId: Id<'tok'>,
    @Body(new ZodValidationPipe(updateApiTokenRequestSchema)) body: UpdateApiTokenRequest,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<ApiTokenDto> {
    return this.tokens.rename(principal, tokenId, body, requestMetaOf(request));
  }

  @Delete('api-tokens/:apiTokenId')
  @HttpCode(204)
  async revoke(
    @Param('apiTokenId', tokenIdPipe) tokenId: Id<'tok'>,
    @CurrentPrincipal() principal: Principal,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.tokens.revoke(principal, tokenId, requestMetaOf(request));
  }
}
