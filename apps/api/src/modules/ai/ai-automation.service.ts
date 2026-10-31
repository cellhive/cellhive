import {
  AI_AUTOMATION_MAX_OUTPUT_TOKENS,
  type AiAutomationDraft,
  type AiAutomationDraftRequest,
  type AutomationDefinition,
  type Id,
} from '@cellhive/contracts';
import {
  AppError,
  automationDigestTableIds,
  automationDraftDigest,
  automationDraftMessages,
  automationDraftSchema,
  automationValidationProblems,
  canManageAutomation,
  compileAutomationDraft,
  managesAnyAutomation,
  OrganizationsRepository,
  orgEmailSettingsOf,
  SecretsRepository,
  ViewsRepository,
  type AiValidation,
  type AppConfig,
  type AutomationDraft,
} from '@cellhive/server-core';
import { Inject, Injectable } from '@nestjs/common';

import { AccessService, notFound, permissionDenied } from '../../common/access/access.service.js';
import { APP_CONFIG } from '../../common/tokens.js';
import { AutomationService } from '../automation/automation.service.js';

import { AiAccess } from './ai-access.js';

import type { Principal } from '../../common/auth/principal.js';
import type { RequestMeta } from '../../common/auth/request-meta.js';

function cannotManage(): AppError {
  return permissionDenied(
    'Automations are managed by base admins and by people with manage rights on the trigger table.',
  );
}

/**
 * `POST /bases/:baseId/ai/automation-draft` (CONTRACTS §29.3, BACKLOG T908):
 * a sentence becomes a draft automation — the model answers a flat draft by
 * name over what the caller manages and reads, the server compiles it to a
 * definition with ids and checks it exactly like `POST /automations` would
 * for the caller (`AutomationService.validate` + the trigger-table right);
 * errors go back for at most 2 repair rounds. The right to create
 * automations in the base (ADR-25) like the automation routes: `404` /
 * `403` before anything about AI. Nothing is stored or turned on.
 */
@Injectable()
export class AiAutomationService {
  constructor(
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AutomationService) private readonly automations: AutomationService,
    @Inject(AiAccess) private readonly ai: AiAccess,
    @Inject(ViewsRepository) private readonly views: ViewsRepository,
    @Inject(SecretsRepository) private readonly secrets: SecretsRepository,
    @Inject(OrganizationsRepository) private readonly organizations: OrganizationsRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async draft(
    principal: Principal,
    baseId: Id<'bse'>,
    body: AiAutomationDraftRequest,
    meta: RequestMeta,
  ): Promise<AiAutomationDraft> {
    const base = await this.access.requireBase(principal, baseId, 'read');
    if (!managesAnyAutomation(base.access)) throw cannotManage();
    const context = await this.automations.schemaContext(base);
    if (body.table_id !== null) {
      const readable =
        base.access.tables[body.table_id] !== undefined &&
        context.tables.some((table) => table.id === body.table_id);
      if (!readable) throw notFound();
      if (!canManageAutomation(base.access, body.table_id)) throw cannotManage();
    }

    const scope = base.org.scope;
    const tableIds = automationDigestTableIds(context, body.table_id);
    const views = await Promise.all(
      tableIds.map((tableId) => this.views.listByTable(scope, tableId, null)),
    );
    const bots = await this.secrets.listUsableInBase(scope, base.base.id, 'telegram_bot');
    const organization = await this.organizations.findById(base.org.organizationId);
    const digestOf = (recordData: boolean) =>
      automationDraftDigest({
        context,
        views: views.flat(),
        bots,
        // The system sender: a draft never picks a sender identity (the builder can).
        email:
          this.config.mail !== null &&
          orgEmailSettingsOf(organization?.settings).systemSenderEnabled,
        currentTableId: body.table_id,
        recordData,
      });
    let digest = digestOf(false);

    const check = async (
      draft: AutomationDraft,
    ): Promise<AiValidation<{ draft: AutomationDraft; definition: AutomationDefinition }>> => {
      const compiled = compileAutomationDraft(draft, digest);
      if (!compiled.ok) return compiled;
      try {
        // What `create` checks (a draft is never enabled: no `NO_ACTIONS`, no button trigger).
        const saved = await this.automations.validate(base, compiled.definition, null);
        if (!canManageAutomation(base.access, saved.triggerTableId)) {
          return {
            ok: false,
            problems: [
              {
                path: 'trigger',
                code: 'PERMISSION_DENIED',
                message: 'You cannot manage automations of this trigger',
              },
            ],
          };
        }
        return { ok: true, value: { draft, definition: saved.definition } };
      } catch (error) {
        if (error instanceof AppError && error.code === 'AUTOMATION_INVALID') {
          return { ok: false, problems: automationValidationProblems(error.errors ?? [], digest) };
        }
        throw error;
      }
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
        digest = digestOf(call.allowRecordData);
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
            onUsage: call.onUsage,
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
          warnings: [...draft.warnings],
        };
      },
    );
  }
}
