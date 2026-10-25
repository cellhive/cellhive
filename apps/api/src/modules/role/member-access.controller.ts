import {
  isId,
  memberAccessQuerySchema,
  principalListQuerySchema,
  type BasePrincipalList,
  type MemberAccessDto,
  type MemberAccessQuery,
  type PrincipalListQuery,
} from '@cellhive/contracts';
import { Controller, Get, Inject, Param, Query } from '@nestjs/common';

import { notFound, type BaseAccess } from '../../common/access/access.service.js';
import { CurrentBase, RequireBase } from '../../common/access/require-base.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';

import { MemberAccessService } from './member-access.service.js';

/**
 * `/bases/:baseId/members/:userId/access` and `/bases/:baseId/principals`
 * (BACKLOG T711, CONTRACTS §5A, §14). Base admins only: others who can open
 * the base get `403`, everyone else `404`. Session only (API tokens get
 * `403 INSUFFICIENT_SCOPE`, CONTRACTS §26.3).
 */
@Controller('bases/:baseId')
@RequireBase('admin')
export class MemberAccessController {
  constructor(@Inject(MemberAccessService) private readonly memberAccess: MemberAccessService) {}

  @Get('members/:userId/access')
  get(
    @CurrentBase() base: BaseAccess,
    @Param('userId') userId: string,
    @Query(new ZodValidationPipe(memberAccessQuerySchema)) query: MemberAccessQuery,
  ): Promise<MemberAccessDto> {
    // A malformed ID cannot name a member.
    if (!isId('usr', userId)) throw notFound();
    return this.memberAccess.memberAccess(base, userId, query);
  }

  @Get('principals')
  principals(
    @CurrentBase() base: BaseAccess,
    @Query(new ZodValidationPipe(principalListQuerySchema)) query: PrincipalListQuery,
  ): Promise<BasePrincipalList> {
    return this.memberAccess.listPrincipals(base, query);
  }
}
