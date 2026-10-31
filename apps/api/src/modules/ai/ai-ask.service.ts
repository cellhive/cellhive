import {
  AI_ASK_NARRATIVE_MAX_OUTPUT_TOKENS,
  AI_ASK_PLAN_MAX_OUTPUT_TOKENS,
  WIDGET_RETRY_AFTER_SECONDS,
  type AiAsk,
  type AiAskRequest,
  type Id,
  type WidgetDataDto,
} from '@cellhive/contracts';
import {
  aggregatePlanOfAsk,
  AppError,
  askDigest,
  askInterpretation,
  askMessages,
  askPlanSchema,
  askProblems,
  askResultJson,
  GroupMembersRepository,
  loadBaseSchemaRows,
  narrativeMessages,
  quotaDayOf,
  readabilityOfAccess,
  RecordQueryService,
  strictComputedPermissionsOf,
  widgetConfigOfPlan,
  widgetQueryOf,
  type AiValidation,
  type AppConfig,
  type AskPlan,
  type Db,
  type PlanByNameResult,
} from '@cellhive/server-core';
import { Inject, Injectable } from '@nestjs/common';

import { recordAccessContextOf } from '../../common/access/record-access-context.js';
import { firstTimeZone, settingOf } from '../../common/access/time-zone.js';
import { SchemaAccess } from '../../common/schema/schema-access.js';
import { APP_CONFIG, DB } from '../../common/tokens.js';
import { WidgetQueryLimiter } from '../dashboard/widget-query-limiter.js';

import { AiAccess, type AiCall } from './ai-access.js';

import type { Principal } from '../../common/auth/principal.js';
import type { RequestMeta } from '../../common/auth/request-meta.js';

const UNANSWERABLE: AiAsk = { status: 'unanswerable' };

/**
 * `POST /tables/:tableId/ai/ask` (CONTRACTS §29.4, BACKLOG T909): a
 * question becomes a plan by name over the fields the asker reads, the plan
 * the config of a temporary widget (`widgetConfigOfPlan`, the save check of
 * a dashboard widget; errors go back for at most 2 repair rounds), the
 * widget runs like a dashboard one — `widgetQueryOf` → the shared
 * `WidgetQueryLimiter` → `RecordQueryService.widgetData` with the asker's
 * access (P21, statement timeout). A narrative only when the organization
 * lets AI see record data ("Quyết định S8" #8); the interpretation is built
 * from the plan. Reading the table comes first (`404`); nothing is stored
 * or cached.
 */
@Injectable()
export class AiAskService {
  constructor(
    @Inject(SchemaAccess) private readonly schemaAccess: SchemaAccess,
    @Inject(AiAccess) private readonly ai: AiAccess,
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(RecordQueryService) private readonly records: RecordQueryService,
    @Inject(GroupMembersRepository) private readonly groupMembers: GroupMembersRepository,
    @Inject(WidgetQueryLimiter) private readonly limiter: WidgetQueryLimiter,
  ) {}

  async ask(
    principal: Principal,
    tableId: Id<'tbl'>,
    body: AiAskRequest,
    meta: RequestMeta,
  ): Promise<AiAsk> {
    const { base, table } = await this.schemaAccess.requireTable(principal, tableId, 'read');
    const scope = base.org.scope;
    const access = await recordAccessContextOf(
      { groupMembers: this.groupMembers, config: this.config },
      principal.user,
      base,
    );
    const digest = askDigest(
      await loadBaseSchemaRows(this.db, scope, base.base.id),
      table.id,
      readabilityOfAccess(access),
      strictComputedPermissionsOf(base.base.settings),
    );
    // The request's zone, else the asker's, else the organization's.
    const timeZone = firstTimeZone(
      [body.timezone, principal.user.timezone, settingOf(base.org.membership.settings, 'timezone')],
      this.config.defaults.timezone,
    );
    const fields = { id: table.id, fields: digest.fields.map((field) => field.meta) };
    const check = (
      plan: AskPlan,
    ): AiValidation<{ plan: AskPlan; built: Extract<PlanByNameResult, { ok: true }> | null }> => {
      if (!plan.answerable) return { ok: true, value: { plan, built: null } };
      const built = widgetConfigOfPlan(aggregatePlanOfAsk(plan), fields);
      return built.ok
        ? { ok: true, value: { plan, built } }
        : { ok: false, problems: askProblems(built.problems) };
    };

    return this.ai.run(
      principal,
      base.org,
      {
        feature: 'ask',
        recordData: false,
        entityType: 'table',
        entityId: table.id,
        baseId: base.base.id,
        tableId: table.id,
        meta,
      },
      async (call) => {
        const result = await call.llm.completeStructured(
          {
            organizationId: call.organizationId,
            settings: call.settings,
            messages: askMessages({
              digest,
              question: body.question,
              today: quotaDayOf(this.ai.now(), timeZone).day,
              timeZone,
            }),
            output: { kind: 'json', schema: askPlanSchema(digest), name: 'ask_plan' },
            maxOutputTokens: AI_ASK_PLAN_MAX_OUTPUT_TOKENS,
            deadline: call.deadline,
            onUsage: call.onUsage,
          },
          check,
        );
        const { plan, built } = result.value;
        call.report({
          attempts: result.attempts,
          outputMode: result.outputMode,
          input: body.question,
          output: JSON.stringify(plan),
        });
        const query = built === null ? null : widgetQueryOf(built.type, built.config);
        if (built === null || query === null || query === 'invalid') return UNANSWERABLE;

        const answer = await this.limiter
          .run(principal.userId, () => this.records.widgetData(scope, access, query, { timeZone }))
          .catch((error: unknown) => {
            throw retryable(error);
          });
        // Impossible with a right digest; never tells which field.
        if (answer.status === 'no_permission' || answer.status === 'broken') return UNANSWERABLE;
        const data: WidgetDataDto = {
          ...answer,
          computed_at: new Date().toISOString(),
          cache: 'miss',
          ignored_filters: [],
        };
        const interpretation = askInterpretation(plan, digest);
        return {
          status: 'ok',
          interpretation,
          widget: { type: built.type, title: plan.title, config: built.config },
          data,
          narrative:
            call.allowRecordData && data.status === 'ok'
              ? await narrative(call, body.question, askResultJson(interpretation, data))
              : null,
        };
      },
    );
  }
}

/**
 * The narrative of the numbers (only with `allow_record_data`): `null` when
 * the provider fails or the budget is spent — the numbers stand without it.
 */
async function narrative(call: AiCall, question: string, result: string): Promise<string | null> {
  try {
    const completion = await call.llm.complete({
      organizationId: call.organizationId,
      settings: call.settings,
      messages: narrativeMessages({ question, result }),
      output: { kind: 'text' },
      maxOutputTokens: AI_ASK_NARRATIVE_MAX_OUTPUT_TOKENS,
      deadline: call.deadline,
      onUsage: call.onUsage,
    });
    const text = completion.content.trim();
    return text === '' ? null : text;
  } catch (error) {
    if (error instanceof AppError && ['AI_PROVIDER_ERROR', 'AI_TIMEOUT'].includes(error.code)) {
      return null;
    }
    throw error;
  }
}

/** A widget query timeout with `Retry-After`, as on dashboards (CONTRACTS §28.3). */
function retryable(error: unknown): unknown {
  if (!(error instanceof AppError) || error.code !== 'QUERY_TIMEOUT') return error;
  if (error.retryAfterSeconds !== undefined) return error;
  return new AppError('QUERY_TIMEOUT', {
    detail: error.detail ?? 'The query took too long and was cancelled.',
    retryAfterSeconds: WIDGET_RETRY_AFTER_SECONDS,
    cause: error,
  });
}
