import { idOf, type Id, type McpAutomationDraft } from '@cellhive/contracts';
import { Controller, Get, Inject, Param } from '@nestjs/common';

import { CurrentPrincipal, type Principal } from '../../common/auth/principal.js';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe.js';

import { AutomationDraftsService } from './automation-drafts.service.js';

/**
 * A draft of the MCP tool `draft_automation`, for its creator's builder
 * (CONTRACTS §30.8, BACKLOG T1015). Session only: the route table gives
 * API tokens `403 INSUFFICIENT_SCOPE` (`required: ["session"]`).
 */
@Controller('bases/:baseId/automation-drafts')
export class AutomationDraftsController {
  constructor(@Inject(AutomationDraftsService) private readonly drafts: AutomationDraftsService) {}

  @Get(':draftId')
  get(
    @Param('baseId', new ZodValidationPipe(idOf('bse'))) baseId: Id<'bse'>,
    @Param('draftId', new ZodValidationPipe(idOf('mdr'))) draftId: Id<'mdr'>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<McpAutomationDraft> {
    return this.drafts.get(principal, baseId, draftId);
  }
}
