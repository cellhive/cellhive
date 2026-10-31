import {
  AI_CLASSIFY_MAX_OUTPUT_TOKENS,
  type AiFieldOptions,
  type AutomationAction,
  type AutomationTemporaryCause,
  type Id,
} from '@cellhive/contracts';

import { writeAiRequestedAudit } from '../../../ai/audit/ai-requested.js';
import { createDeadline } from '../../../ai/deadline.js';
import { isTemporaryAiError } from '../../../ai/errors.js';
import { aiTargetOf, generateAiValue } from '../../../ai/generation/generator.js';
import { aiSourceFieldIds, isAiField } from '../../../ai/generation/options.js';
import { AiRenderError, renderAiInput, type AiFieldTarget } from '../../../ai/generation/prompt.js';
import { recordAiRequest } from '../../../ai/metrics.js';
import { AiSettingsRepository } from '../../../ai/settings/ai-settings.repository.js';
import { requireAi } from '../../../ai/settings/settings.js';
import { AiUsageLedger } from '../../../ai/usage/quota.js';
import { AppError } from '../../../errors/app-error.js';
import { aiPromptSnapshot, isMultipleSelect } from '../../definition/validate.js';
import { AutomationStepError } from '../../engine/errors.js';
import { requireTable, requireWritableFields } from '../record/record-actions.js';

import type { AiProviderSettings, AiUsage, LlmClient } from '../../../ai/client.js';
import type { Db, Tx } from '../../../db/create-db.js';
import type { JsonObject } from '../../../db/schema.js';
import type { RecordMutationService } from '../../../records/record-mutation.service.js';
import type { RecordQueryService } from '../../../records/record-query.service.js';
import type {
  AutomationActionContext,
  AutomationActionHandler,
  AutomationActionResult,
} from '../../engine/action-registry.js';

/**
 * `ai_generate_text` and `ai_classify` (CONTRACTS §29.6, BACKLOG T911,
 * ADR-39): one step, as `run_as` —
 *
 * 1. AI and `allow_record_data` on, else `ai_unavailable`;
 * 2. the target field (when any) still of its kind and writable by
 *    `run_as` (`permission_denied`, `scope: table`, like `update_record`);
 * 3. the prompt's fields of the trigger record read through
 *    `RecordQueryService` with `run_as`'s access, each value in an untrusted
 *    data block (`renderAiInput`, the AI field's renderer);
 * 4. the daily quota, else `ai_quota_exceeded` — never retried;
 * 5. one provider call (`generateAiValue`: text, or an `enum` of the
 *    option names with ≤ 2 repair rounds), usage under feature `action`;
 *    `429`/`5xx`/timeout/network → `temporary_error` (the engine retries),
 *    no valid answer → `ai_invalid_output` (nothing written), other
 *    refusals → `ai_provider_error`;
 * 6. the value written through `RecordMutationService` with the step
 *    completed in the same transaction; a record outside `run_as`'s edit
 *    rule is left alone (`skipped_not_editable`, the step succeeds).
 *
 * One `ai.requested` audit entry per step that called the provider, never
 * with the prompt or the answer. Nothing is logged of either.
 */

export interface AiActionDeps {
  readonly db: Db;
  readonly llm: LlmClient;
  readonly records: Pick<RecordMutationService, 'update'>;
  readonly query: Pick<RecordQueryService, 'getRecords'>;
}

type Ctx<T extends AutomationAction['type']> = AutomationActionContext & {
  readonly action: Extract<AutomationAction, { type: T }>;
};

/** One AI step: its prompt, guidance, and the field it writes (if any). */
interface AiStep {
  readonly prompt: string;
  /** `prompt` or `input`: `params.field` of an `invalid_value` on it. */
  readonly promptKey: string;
  readonly ai: Pick<AiFieldOptions, 'task' | 'instructions' | 'max_output_tokens'>;
  readonly target: { readonly fieldId: Id<'fld'>; readonly kind: 'text' | 'select' } | null;
}

/** What the call gave, before anything is written. */
interface AiAnswer {
  readonly value: string | null;
  readonly usage: AiUsage;
  readonly tableId: Id<'tbl'>;
  readonly recordId: Id<'rec'>;
  readonly target: AiFieldTarget;
  /** Writes the audit entry of the step on `tx` (status `ok`). */
  readonly audit: (tx: Tx) => Promise<void>;
}

/** Record-level refusals of a write: outside `run_as`'s rules (P29) — the step skips the write. */
const NOT_EDITABLE: ReadonlySet<string> = new Set([
  'NOT_FOUND',
  'PERMISSION_DENIED',
  'RECORD_RULE_VIOLATION',
]);

const NO_USAGE: AiUsage = { promptTokens: 0, completionTokens: 0, estimated: false };

function invalidValue(field: string, error: string): AutomationStepError {
  return new AutomationStepError('invalid_value', 'The AI step cannot use this value', {
    params: { field, error },
  });
}

/** The cause of a temporary provider failure (`params.cause` of `temporary_error`). */
function causeOf(error: AppError): AutomationTemporaryCause {
  if (error.code === 'AI_TIMEOUT') return 'timeout';
  if (error.params?.['reason'] === 'network') return 'network';
  return error.params?.['status'] === 429 ? 'rate_limited' : 'server_error';
}

/** A failed call as the step error the engine knows (or the error itself). */
function stepErrorOf(error: unknown, promptKey: string): unknown {
  if (error instanceof AiRenderError) return invalidValue(promptKey, 'UNKNOWN_FIELD');
  if (!(error instanceof AppError)) return error;
  if (isTemporaryAiError(error)) {
    const cause = causeOf(error);
    return new AutomationStepError('temporary_error', 'The AI provider failed for now', {
      transient: cause,
      params: { cause },
    });
  }
  if (error.code === 'AI_INVALID_OUTPUT') {
    return new AutomationStepError('ai_invalid_output', 'The AI gave no valid answer', {
      params: { attempts: error.params?.['attempts'] ?? 0 },
    });
  }
  if (error.code === 'AI_PROVIDER_ERROR') {
    const status = error.params?.['status'];
    return new AutomationStepError('ai_provider_error', 'The AI provider refused the request', {
      params: {
        reason: error.params?.['reason'] ?? 'http_status',
        ...(typeof status === 'number' ? { status } : {}),
      },
    });
  }
  return error;
}

export function createAiActions(deps: AiActionDeps): ReadonlyMap<string, AutomationActionHandler> {
  const settings = new AiSettingsRepository(deps.db);
  const ledger = new AiUsageLedger(deps.db);

  /** AI and record data on, else `ai_unavailable` (`params.reason`). */
  async function providerOf(
    context: AutomationActionContext,
  ): Promise<{ provider: AiProviderSettings; limit: number | null }> {
    const state = await settings.find(context.scope);
    try {
      const provider = requireAi(state, { recordData: true });
      const limit = state?.daily_token_limit ?? null;
      return { provider, limit: limit === null ? null : Number(limit) };
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      throw new AutomationStepError('ai_unavailable', 'AI is not available for this step', {
        params: {
          reason: error.code === 'AI_RECORD_DATA_DISABLED' ? 'record_data_disabled' : 'ai_disabled',
        },
      });
    }
  }

  /** The target field, still of its kind and writable by `run_as` now. */
  function targetOf(
    context: AutomationActionContext,
    tableId: Id<'tbl'>,
    target: NonNullable<AiStep['target']>,
  ): AiFieldTarget {
    const field = context.schema.fields.find(
      (item) => item.id === target.fieldId && item.table_id === tableId,
    );
    if (field === undefined) throw invalidValue('target_field_id', 'UNKNOWN_FIELD');
    if (isAiField(field)) throw invalidValue('target_field_id', 'FIELD_READ_ONLY');
    const kind = aiTargetOf(field);
    if (field.type !== target.kind || (kind.kind === 'select' && isMultipleSelect(field))) {
      throw invalidValue('target_field_id', 'INVALID_FIELD_TYPE');
    }
    requireTable(context, tableId, { write: true });
    requireWritableFields(context, tableId, [target.fieldId], 'edit');
    return kind;
  }

  /** Steps 1–5: the answer of the model, nothing written yet. */
  async function answer(context: AutomationActionContext, step: AiStep): Promise<AiAnswer> {
    const { scope, run } = context;
    const { provider, limit } = await providerOf(context);
    const tableId = run.triggerTableId;
    const recordId = run.triggerRecordId;
    if (tableId === null || recordId === null) throw invalidValue('record_id', 'NO_TRIGGER_RECORD');
    const target: AiFieldTarget =
      step.target === null ? { kind: 'text' } : targetOf(context, tableId, step.target);

    // The prompt's fields of the trigger record, as `run_as` reads them now.
    const snapshot = aiPromptSnapshot(context.schema, tableId);
    const readable = new Set(
      snapshot.tables.find((table) => table.id === tableId)?.fields.map((field) => field.id),
    );
    const [record] = await deps.query.getRecords(
      scope,
      tableId,
      [recordId],
      context.access.record,
      {
        field_key_type: 'id',
        cell_format: 'json',
        fields: aiSourceFieldIds(step.prompt).filter((id) => readable.has(id)),
      },
    );
    if (record === undefined) {
      throw new AutomationStepError('permission_denied', 'run_as cannot read the trigger record', {
        params: { scope: 'record', error: 'NOT_FOUND' },
      });
    }
    let input;
    try {
      input = renderAiInput(
        step.prompt,
        snapshot,
        { id: record.id, fields: record.fields },
        { timeZone: run.timeZone, locale: run.locale, now: context.now() },
      );
    } catch (error) {
      throw stepErrorOf(error, step.promptKey);
    }

    const quota = {
      organizationId: scope.organizationId,
      timeZone: run.timeZone,
      now: context.now(),
    };
    try {
      await ledger.check(quota, limit);
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'AI_QUOTA_EXCEEDED') throw error;
      throw new AutomationStepError('ai_quota_exceeded', 'The AI quota of today is used up', {
        params: { reset_at: error.errors?.[0]?.params?.['reset_at'] ?? null },
      });
    }

    const started = performance.now();
    let usage = NO_USAGE;
    let attempts = 1;
    let durationMs = 0;
    /** Metrics once the call is over; the audit entry is written by whoever ends the step. */
    const measure = (status: string) => {
      durationMs = performance.now() - started;
      recordAiRequest({
        feature: 'action',
        status,
        durationMs,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        attempts,
      });
    };
    const audit = (tx: Tx, status: string) =>
      writeAiRequestedAudit(tx, {
        organizationId: scope.organizationId,
        baseId: run.baseId,
        tableId,
        entityType: 'automation',
        entityId: run.automationId,
        feature: 'action',
        model: provider.model,
        status,
        attempts,
        usage,
        durationMs,
        outputMode: null,
        logPrompts: false,
        context: context.audit,
      });
    try {
      const result = await generateAiValue(
        {
          llm: deps.llm,
          organizationId: scope.organizationId,
          settings: provider,
          deadline: createDeadline(provider.requestTimeoutSeconds * 1000),
          onUsage: async (call) => {
            usage = {
              promptTokens: usage.promptTokens + call.promptTokens,
              completionTokens: usage.completionTokens + call.completionTokens,
              estimated: usage.estimated || call.estimated,
            };
            await ledger.record(quota, 'action', call);
          },
        },
        step.ai,
        input,
        target,
      );
      attempts = result.attempts;
      measure('ok');
      return {
        value: result.value,
        usage,
        tableId,
        recordId,
        target,
        audit: (tx) => audit(tx, 'ok'),
      };
    } catch (error) {
      const failure = stepErrorOf(error, step.promptKey);
      const counted = error instanceof AppError ? error.params?.['attempts'] : undefined;
      if (typeof counted === 'number') attempts = counted;
      const status = failure instanceof AutomationStepError ? failure.code : 'internal_error';
      measure(status);
      await deps.db.withTx((tx) => audit(tx, status));
      throw failure;
    }
  }

  /**
   * Step 6: `cell` written to the target (none: `output` only), the step
   * completed with its audit entry in the same transaction.
   */
  async function finish(
    context: AutomationActionContext,
    result: AiAnswer,
    target: Id<'fld'> | null,
    cell: string | null,
    output: JsonObject,
  ): Promise<AutomationActionResult> {
    const complete = async (tx: Tx, done: JsonObject) => {
      await result.audit(tx);
      await context.complete(tx, done);
    };
    if (target === null) {
      await deps.db.withTx((tx) => complete(tx, output));
      return { output };
    }
    try {
      await deps.records.update(
        context.scope,
        result.tableId,
        context.access.record,
        {
          field_key_type: 'id',
          typecast: true,
          records: [{ id: result.recordId, fields: { [target]: cell } }],
        },
        context.audit,
        { causation: context.causation, beforeCommit: (tx) => complete(tx, output) },
      );
      return { output };
    } catch (error) {
      if (!(error instanceof AppError) || !NOT_EDITABLE.has(error.code)) throw error;
      const skipped: JsonObject = { ...output, skipped_not_editable: true };
      await deps.db.withTx((tx) => complete(tx, skipped));
      return { output: skipped };
    }
  }

  const generateText: AutomationActionHandler = {
    async execute(raw): Promise<AutomationActionResult> {
      const context = raw as Ctx<'ai_generate_text'>;
      const { config } = context.action;
      const target = config.target_field_id;
      const result = await answer(context, {
        prompt: config.prompt,
        promptKey: 'prompt',
        ai: {
          task: 'custom',
          instructions: config.instructions,
          max_output_tokens: config.max_output_tokens,
        },
        target: target === null ? null : { fieldId: target, kind: 'text' },
      });
      return finish(context, result, target, result.value, {
        text: result.value ?? '',
        prompt_tokens: result.usage.promptTokens,
        completion_tokens: result.usage.completionTokens,
      });
    },
  };

  const classify: AutomationActionHandler = {
    async execute(raw): Promise<AutomationActionResult> {
      const context = raw as Ctx<'ai_classify'>;
      const { config } = context.action;
      const result = await answer(context, {
        prompt: config.input,
        promptKey: 'input',
        ai: {
          task: 'classify',
          instructions: config.instructions,
          max_output_tokens: AI_CLASSIFY_MAX_OUTPUT_TOKENS,
        },
        target: { fieldId: config.target_field_id, kind: 'select' },
      });
      const options = result.target.kind === 'select' ? result.target.options : [];
      const option = options.find((item) => item.name === result.value);
      // The schema's `enum` only lets option names through; anything else is a bug.
      if (option === undefined) throw new TypeError('ai_classify: answer outside the options');
      return finish(context, result, config.target_field_id, option.id, {
        option_id: option.id,
        option_name: option.name,
      });
    },
  };

  return new Map([
    ['ai_generate_text', generateText],
    ['ai_classify', classify],
  ]);
}
