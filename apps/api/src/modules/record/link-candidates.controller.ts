import {
  idOf,
  linkCandidatesRequestSchema,
  type Id,
  type LinkCandidatesRequest,
  type LinkCandidatesResponse,
} from '@cellhive/contracts';
import { Body, Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';

import { CurrentPrincipal, type Principal } from '../../common/auth/principal.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';

import { RecordService } from './record.service.js';

/** `POST /fields/:fieldId/link-candidates`: records a link picker may offer (T402, CONTRACTS §2). */
@Controller('fields/:fieldId/link-candidates')
export class LinkCandidatesController {
  constructor(@Inject(RecordService) private readonly records: RecordService) {}

  @Post()
  @HttpCode(200)
  candidates(
    @Param('fieldId', new ZodValidationPipe(idOf('fld'))) fieldId: Id<'fld'>,
    @Body(new ZodValidationPipe(linkCandidatesRequestSchema)) body: LinkCandidatesRequest,
    @CurrentPrincipal() principal: Principal,
  ): Promise<LinkCandidatesResponse> {
    return this.records.linkCandidates(principal, fieldId, body);
  }
}
