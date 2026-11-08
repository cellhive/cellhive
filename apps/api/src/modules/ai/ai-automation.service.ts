import {
  AI_AUTOMATION_MAX_OUTPUT_TOKENS,
  type AiAutomationDraft,
  type AiAutomationDraftRequest,
  type AutomationDefinition,
  type Id,
} from '@cellhive/contracts';
import {
  automationDraftMessages,
  automationDraftSchema,
  literalChatWarnings,
  type AiValidation,
  type AutomationDraft,
} from '@cellhive/server-core';
import { Inject, Injectable } from '@nestjs/common';

import { AutomationDraftsService } from '../automation/automation-drafts.service.js';

import { AiAccess, type AiRequestMeta } from './ai-access.js';

import type { Principal } from '../../common/auth/principal.js';

/**
 * `POST /bases/:baseId/ai/automation-draft` (CONTRACTS §29.3, BACKLOG T908):
 * a sentence becomes a draft automation — the model answers a flat draft by
 * name over what the caller manages and reads, the server compiles it to a
 * definition with ids and checks it exactly like `POST /automations` would
 * for the caller (`AutomationDraftsService.check`: `AutomationService.validate`
 * + the trigger-table right); errors go back for at most 2 repair rounds.
 * The right to create automations in the base (ADR-25) like the automation
 * routes: `404` / `403` before anything about AI. Nothing is stored or
 * turned on. A chat id the model wrote into a `send_telegram` step comes
 * back as a `literal_chat_id` warning (T1015).
 */
@Injectable()
export class AiAutomationService {
  constructor(
    @Inject(AutomationDraftsService) private readonly drafts: AutomationDraftsService,
    @Inject(AiAccess) private readonly ai: AiAccess,
  ) {}

  async draft(
    principal: Principal,
    baseId: Id<'bse'>,
    body: AiAutomationDraftRequest,
    meta: AiRequestMeta,
  ): Promise<AiAutomationDraft> {
    const scope = await this.drafts.scopeOf(principal, baseId, body.table_id);
    const { base } = scope;
    let digest = scope.digestOf(false);

    const check = async (
      draft: AutomationDraft,
    ): Promise<AiValidation<{ draft: AutomationDraft; definition: AutomationDefinition }>> => {
      const checked = await this.drafts.check(base, digest, draft);
      return checked.ok
        ? { ok: true, value: { draft, definition: checked.value.definition } }
        : checked;
    };

    return this.ai.run(
      principal,
      base.org,
      {
        feature: 'automation_draft',
        recordData: false,
        entityType: 'base',
        entityId: base.base.id,
        baseId: base.base.id,
        tableId: body.table_id,
        meta,
      },
      async (call) => {
        // The AI actions only when the organization lets AI see record values (T911).
        digest = scope.digestOf(call.allowRecordData);
        const result = await call.llm.completeStructured(
          {
            organizationId: call.organizationId,
            settings: call.settings,
            messages: automationDraftMessages({ digest, prompt: body.prompt }),
            output: {
              kind: 'json',
              schema: automationDraftSchema(digest),
              name: 'automation_draft',
            },
            maxOutputTokens: AI_AUTOMATION_MAX_OUTPUT_TOKENS,
            deadline: call.deadline,
            ...call.hooks,
          },
          check,
        );
        const { draft, definition } = result.value;
        call.report({
          attempts: result.attempts,
          outputMode: result.outputMode,
          input: body.prompt,
          output: JSON.stringify(draft),
        });
        return {
          name: draft.name,
          description: body.prompt,
          definition,
          explanation: draft.explanation,
          warnings: [...draft.warnings, ...literalChatWarnings(definition)],
        };
      },
    );
  }
}
