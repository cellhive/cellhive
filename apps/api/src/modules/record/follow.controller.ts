import {
  recordFollowParamsSchema,
  type RecordFollowDto,
  type RecordFollowParams,
} from '@cellhive/contracts';
import { Controller, Delete, Get, HttpCode, Inject, Param, Put } from '@nestjs/common';

import { CurrentPrincipal, type Principal } from '../../common/auth/principal.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';

import { FollowService } from './follow.service.js';

const paramsPipe = new ZodValidationPipe(recordFollowParamsSchema);

/**
 * `/tables/:tableId/records/:recordId/follow` (CONTRACTS §22.5, BACKLOG
 * T543): whether the caller follows a record, follow (`PUT`, idempotent),
 * unfollow (`DELETE`, idempotent). Not audited, no event.
 */
@Controller('tables/:tableId/records/:recordId/follow')
export class FollowController {
  constructor(@Inject(FollowService) private readonly follows: FollowService) {}

  @Get()
  status(
    @Param(paramsPipe) params: RecordFollowParams,
    @CurrentPrincipal() principal: Principal,
  ): Promise<RecordFollowDto> {
    return this.follows.status(principal, params);
  }

  @Put()
  @HttpCode(204)
  follow(
    @Param(paramsPipe) params: RecordFollowParams,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    return this.follows.follow(principal, params);
  }

  @Delete()
  @HttpCode(204)
  unfollow(
    @Param(paramsPipe) params: RecordFollowParams,
    @CurrentPrincipal() principal: Principal,
  ): Promise<void> {
    return this.follows.unfollow(principal, params);
  }
}
