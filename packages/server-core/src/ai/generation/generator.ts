import {
  AI_FIELD_BACKOFF_MS,
  AI_FIELD_BATCH_SIZE,
  AI_FIELD_BREAKER_ERRORS,
  AI_FIELD_MAX_BACKOFF_MS,
  AI_FIELD_RETRY_DELAYS_MS,
  type AiFailureReason,
  type AiFieldOptions,
  type AiFieldStateDto,
  type AiPauseReason,
  type AiProviderPauseDetail,
  type Id,
} from '@cellhive/contracts';
import { isValidTimeZone, selectOptionsSchema } from '@cellhive/field-types';
import { resolveBaseAccess } from '@cellhive/permissions';

import { systemAuditContext } from '../../audit/audit-entry.js';
import { loadBaseSchemaRows, snapshotOfBase } from '../../computed/definition/schema-rows.js';
import { OrganizationsRepository } from '../../db/repositories/organizations.repository.js';
import { orgScope, withTxScope, type OrgScope } from '../../db/repository.js';
import { AppError } from '../../errors/app-error.js';
import { parseRetryAfter } from '../../http-out/retry-policy.js';
import { loadMemberAccessBase } from '../../import/member-access.js';
import { JobsRepository } from '../../jobs/jobs.repository.js';
import { FieldsRepository } from '../../schema/fields.repository.js';
import { TablesRepository } from '../../schema/tables.repository.js';
import { writeAiRequestedAudit } from '../audit/ai-requested.js';
import { createDeadline } from '../deadline.js';
import {
  aiInvalidOutput,
  aiProviderPauseDetailOf,
  aiRateLimitOf,
  isTemporaryAiError,
} from '../errors.js';
import { recordAiRequest } from '../metrics.js';
import { AiSettingsRepository } from '../settings/ai-settings.repository.js';
import { requireAi, type AiSettingsState } from '../settings/settings.js';
import { AiUsageLedger, isAiQuotaExceeded, type AiQuotaContext } from '../usage/quota.js';

import { aiConfigFieldIds } from './definition.js';
import { enqueueAiGeneration } from './jobs.js';
import { aiOptionsOf, aiSourcesOf } from './options.js';
import {
  aiFieldMessages,
  aiSelectAnswerSchema,
  aiTextValue,
  AiRenderError,
  renderAiInput,
  type AiFieldTarget,
  type RenderContext,
  type RenderedAiInput,
} from './prompt.js';
import { AiGenerationQueueRepository, type TakenAiRow } from './queue.repository.js';
import { aiCrossRecordSources } from './sources.js';

import type { BaseSchemaRows } from '../../computed/definition/schema-rows.js';
import type { Db, Tx } from '../../db/create-db.js';
import type { JsonValue } from '../../db/schema.js';
import type { Causation } from '../../events/event.js';
import type { RecordMutationService } from '../../records/record-mutation.service.js';
import type { RecordQueryService } from '../../records/record-query.service.js';
import type { RecordAccessContext } from '../../records/types.js';
import type { SchemaChange } from '../../schema/schema-change-publisher.js';
import type { AiCallHooks, AiProviderSettings, AiUsage, LlmClient } from '../client.js';
import type { AiDeadline } from '../deadline.js';
import type { FormulaRecord } from '@cellhive/formula-engine';

/** The target of an AI field from its row: text, or the options of its single select. */
export function aiTargetOf(field: {
  readonly type: string;
  readonly options: unknown;
}): AiFieldTarget {
  if (field.type !== 'select') return { kind: 'text' };
  const parsed = selectOptionsSchema.safeParse(field.options);
  return {
    kind: 'select',
    options: parsed.success ? parsed.data.options.map(({ id, name }) => ({ id, name })) : [],
  };
}

/**
 * What one provider call needs (the API's `AiCall`, or the worker's own),
 * with the hooks of every HTTP call: the usage ledger, the quota check
 * before each call (`beforeCall`), the caller's abort signal.
 */
export interface AiValueCall extends AiCallHooks {
  readonly llm: LlmClient;
  readonly organizationId: Id<'org'>;
  readonly settings: AiProviderSettings;
  readonly deadline: AiDeadline;
  readonly onUsage: (usage: AiUsage) => void | Promise<void>;
}

/**
 * The value of one record (text, or the option name of a select): one call
 * — text, or JSON with the option names as an `enum` (≤ 2 repair rounds).
 * `AI_INVALID_OUTPUT` when the text is too long or no option fits.
 */
export async function generateAiValue(
  call: AiValueCall,
  ai: Pick<AiFieldOptions, 'task' | 'instructions' | 'max_output_tokens'>,
  input: RenderedAiInput,
  target: AiFieldTarget,
): Promise<{ value: string | null; attempts: number }> {
  const request = {
    organizationId: call.organizationId,
    settings: call.settings,
    messages: aiFieldMessages(ai, input, target),
    maxOutputTokens: ai.max_output_tokens,
    deadline: call.deadline,
    onUsage: call.onUsage,
    ...(call.beforeCall === undefined ? {} : { beforeCall: call.beforeCall }),
    ...(call.signal === undefined ? {} : { signal: call.signal }),
  };
  if (target.kind === 'select') {
    if (target.options.length === 0) throw aiInvalidOutput(0);
    const result = await call.llm.completeStructured({
      ...request,
      output: { kind: 'json', schema: aiSelectAnswerSchema(target.options), name: 'cell' },
    });
    return { value: result.value.option, attempts: result.attempts };
  }
  const completion = await call.llm.complete({ ...request, output: { kind: 'text' } });
  const text = aiTextValue(completion.content);
  if (text.invalid) throw aiInvalidOutput(1);
  return { value: text.value, attempts: 1 };
}

/** A failed call as the code a `failed` row keeps. */
export function aiFailureReason(error: unknown): AiFailureReason {
  if (error instanceof AiRenderError) return 'render_error';
  if (error instanceof AppError) {
    if (error.code === 'AI_INVALID_OUTPUT') return 'invalid_output';
    if (error.code === 'AI_TIMEOUT') return 'timeout';
    const reason = error.params?.['reason'];
    if (error.code === 'AI_PROVIDER_ERROR' && (reason === 'refused' || reason === 'truncated')) {
      return reason;
    }
  }
  return 'provider_error';
}

/**
 * How long the organization waits after a `429`: its `Retry-After` (at
 * least a second, at most {@link AI_FIELD_MAX_BACKOFF_MS}), else
 * {@link AI_FIELD_BACKOFF_MS}.
 */
export function aiBackOffMs(retryAfter: string | null, now: Date): number {
  const at = parseRetryAfter(retryAfter, now);
  if (at === null) return AI_FIELD_BACKOFF_MS;
  return Math.min(AI_FIELD_MAX_BACKOFF_MS, Math.max(1_000, at.getTime() - now.getTime()));
}

/** Why a batch stopped before its last row: the queue paused, or the organization backs off. */
type AiBatchStop =
  | {
      readonly kind: 'pause';
      readonly reason: AiPauseReason;
      readonly detail?: AiProviderPauseDetail;
    }
  | { readonly kind: 'back_off'; readonly until: Date };

/** A placeholder user of the system read (never a member: no role is ever matched). */
const SYSTEM_READER: Id<'usr'> = 'usr_SystemAiReader00';

/**
 * Read access of the AI worker (BACKLOG T910 "ngữ cảnh hệ thống như
 * computed"): every table and field of the base, no record rule — the
 * values an AI field is generated from are the record's own, like stored
 * formula values. Only the worker uses it; writes never go through it.
 */
export async function aiSystemAccess(
  db: Db,
  scope: OrgScope,
  baseId: Id<'bse'>,
  context: Pick<RenderContext, 'timeZone' | 'locale'>,
): Promise<RecordAccessContext | null> {
  const base = await loadMemberAccessBase(db, scope, baseId);
  if (base === undefined) return null;
  const resolved = resolveBaseAccess({
    principal: {
      userId: SYSTEM_READER,
      groupIds: [],
      orgRole: 'owner',
      workspaceRole: null,
      isBaseOwner: false,
    },
    roles: [],
    assignments: [],
    schema: base.schema,
  });
  if (resolved === null) return null;
  return {
    baseId,
    resolved,
    userId: null,
    groupMemberUserIds: [],
    timeZone: context.timeZone,
    locale: context.locale,
  };
}

/** A field whose queue was paused or resumed as a whole (`schema.changed` with `ai_state`). */
export interface AiFieldStateChange {
  readonly organizationId: Id<'org'>;
  readonly baseId: Id<'bse'>;
  readonly tableId: Id<'tbl'>;
  readonly fieldId: Id<'fld'>;
  readonly state: AiFieldStateDto;
  /**
   * The active fields flowing into its prompt (`aiConfigFieldIds`): only
   * subscribers who manage the table and read each one receive `ai_state`.
   */
  readonly configFieldIds: readonly Id<'fld'>[];
}

/**
 * The `schema.changed` of `change` (CONTRACTS §7): field `updated` with
 * `ai_state` and the fields its receivers must read to get it.
 */
export function aiFieldStateSchemaChange(change: AiFieldStateChange): SchemaChange {
  return {
    organization_id: change.organizationId,
    base_id: change.baseId,
    table_id: change.tableId,
    entity: 'field',
    entity_id: change.fieldId,
    action: 'updated',
    ai_state: change.state,
    ai_config_field_ids: change.configFieldIds,
  };
}

export interface AiFieldGeneratorOptions {
  readonly llm: LlmClient;
  readonly records: Pick<RecordQueryService, 'getRecords'>;
  readonly mutations: Pick<RecordMutationService, 'writeAiValues'>;
  readonly defaultTimeZone: string;
  readonly defaultLocale: string;
  readonly now?: () => Date;
  /** After commit: `schema.changed` of fields whose rows were paused or resumed together. */
  readonly onStateChange?: (changes: readonly AiFieldStateChange[]) => Promise<void>;
}

/** What one batch did (logs, the task's next run). */
export interface AiBatchOutcome {
  /** `more`: rows are due now; `done`: none now (maybe later: `nextRunAt`); `paused`; `gone`. */
  readonly status: 'more' | 'done' | 'paused' | 'gone';
  readonly rows: number;
  readonly written: number;
  readonly failed: number;
  readonly calls: number;
  readonly usage: AiUsage;
  /** When queued rows of the field are next due (retry), `null` when none is queued. */
  readonly nextRunAt: Date | null;
  readonly pausedReason?: AiPauseReason;
  /** What the provider rejected (`pausedReason: provider_error`). */
  readonly pausedDetail?: AiProviderPauseDetail;
  /** The organization backs off until then (a `429`, or temporary errors in a row). */
  readonly backOffUntil?: Date;
}

const NO_USAGE: AiUsage = { promptTokens: 0, completionTokens: 0, estimated: false };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Generation of AI fields in the background (BACKLOG T910, ADR-39 §7,
 * research S8 §4.5): batches of ≤ 20 queued rows of one field, leased,
 * read through `RecordQueryService` with the system access, one isolated
 * provider call per record, values written through `RecordMutationService`
 * only when the record did not change since it was read. AI off or record
 * data off → the organization's queued rows `paused`; quota used up (checked
 * before every provider call, repair rounds and resends included — the
 * refused call is never sent) → `paused quota`; the provider rejecting the
 * configuration → `paused provider_error` (BACKLOG T1002); a `429` or five
 * temporary errors in a row → the organization backs off; other temporary
 * errors retried after 30 s, 2 and 10 minutes, then `failed`. One
 * `ai.requested` audit entry per batch.
 */
export class AiFieldGenerator {
  private readonly queue: AiGenerationQueueRepository;
  private readonly fields: FieldsRepository;
  private readonly tables: TablesRepository;
  private readonly settings: AiSettingsRepository;
  private readonly organizations: OrganizationsRepository;
  private readonly jobs: JobsRepository;
  private readonly ledger: AiUsageLedger;
  private readonly now: () => Date;

  constructor(
    private readonly db: Db,
    private readonly options: AiFieldGeneratorOptions,
  ) {
    this.queue = new AiGenerationQueueRepository(db);
    this.fields = new FieldsRepository(db);
    this.tables = new TablesRepository(db);
    this.settings = new AiSettingsRepository(db);
    this.organizations = new OrganizationsRepository(db);
    this.jobs = new JobsRepository(db);
    this.ledger = new AiUsageLedger(db);
    this.now = options.now ?? (() => new Date());
  }

  /** Zone (quota day, dates in prompts) and locale of the organization. */
  async contextOf(scope: OrgScope): Promise<Pick<RenderContext, 'timeZone' | 'locale'>> {
    const organization = await this.organizations.findById(scope.organizationId, scope.tx);
    const settings = isRecord(organization?.settings) ? organization.settings : {};
    const zone = settings['timezone'];
    const locale = settings['locale'];
    return {
      timeZone:
        typeof zone === 'string' && isValidTimeZone(zone) ? zone : this.options.defaultTimeZone,
      locale: typeof locale === 'string' && locale !== '' ? locale : this.options.defaultLocale,
    };
  }

  private quota(scope: OrgScope, timeZone: string): AiQuotaContext {
    return { organizationId: scope.organizationId, timeZone, now: this.now() };
  }

  /** `429 AI_QUOTA_EXCEEDED` → `true` (anything else is thrown). */
  private async quotaUsedUp(
    scope: OrgScope,
    timeZone: string,
    state: AiSettingsState,
  ): Promise<boolean> {
    const limit = state.daily_token_limit === null ? null : Number(state.daily_token_limit);
    try {
      await this.ledger.check(this.quota(scope, timeZone), limit);
      return false;
    } catch (error) {
      if (isAiQuotaExceeded(error)) return true;
      throw error;
    }
  }

  /** Why AI may not run for the organization now (`null`: it may). */
  private async stopReason(scope: OrgScope): Promise<AiPauseReason | null> {
    try {
      requireAi(await this.settings.find(scope), { recordData: true });
      return null;
    } catch (error) {
      return error instanceof AppError && error.code === 'AI_RECORD_DATA_DISABLED'
        ? 'record_data_disabled'
        : 'ai_disabled';
    }
  }

  /**
   * Pauses every queued row of the organization (`detail`: what the
   * provider rejected) and tells the fields' readers.
   */
  private async pause(
    scope: OrgScope,
    reason: AiPauseReason,
    detail?: AiProviderPauseDetail,
  ): Promise<void> {
    const fields = await this.queue.pause(scope, reason, { detail: detail ?? null });
    await this.announce(scope, fields);
  }

  /** `schema.changed` with `ai_state` for `fieldIds` (paused, backed off or resumed together). */
  private async announce(scope: OrgScope, fieldIds: readonly Id<'fld'>[]): Promise<void> {
    if (fieldIds.length === 0 || this.options.onStateChange === undefined) return;
    await this.options.onStateChange(await aiFieldStateChanges(this.db, scope, fieldIds));
  }

  /** When the next queued row of the field is due (`null`: none queued); reads that field's rows only. */
  private nextDue(scope: OrgScope, fieldId: Id<'fld'>): Promise<Date | null> {
    return this.queue.dueAt(scope, fieldId, this.now());
  }

  /**
   * One batch of `fieldId` (the `ai.generate` job runs batches while
   * `status` is `more`, then schedules itself at `nextRunAt`). `batchId` is
   * the `job_…` of the run: the `batch_id` of the audit entries it writes.
   *
   * Provider errors: the configuration rejected (`401`, `403`, `404`, an
   * address or key host refused, the key unreadable) pauses every queued
   * row of the organization (`provider_error`) with no further call; a
   * `429`, or {@link AI_FIELD_BREAKER_ERRORS} temporary errors in a row,
   * backs the organization off (tries unchanged for the `429`); other
   * temporary errors retry the row; `refused` and `truncated` fail it.
   */
  async runBatch(scope: OrgScope, fieldId: Id<'fld'>, batchId: Id<'job'>): Promise<AiBatchOutcome> {
    const empty = { rows: 0, written: 0, failed: 0, calls: 0, usage: NO_USAGE };
    const field = await this.fields.getById(scope, fieldId);
    const ai = field === undefined ? null : aiOptionsOf(field);
    const table =
      field === undefined ? undefined : await this.tables.getById(scope, field.table_id);
    if (field === undefined || field.deleted_at !== null || ai === null || table === undefined) {
      await this.queue.clear(scope, fieldId);
      return { status: 'gone', ...empty, nextRunAt: null };
    }
    const reason = await this.stopReason(scope);
    if (reason !== null) {
      await this.pause(scope, reason);
      return { status: 'paused', ...empty, nextRunAt: null, pausedReason: reason };
    }
    const settings = (await this.settings.find(scope)) as AiSettingsState;
    const provider = requireAi(settings, { recordData: true });
    const context = await this.contextOf(scope);
    if (await this.quotaUsedUp(scope, context.timeZone, settings)) {
      await this.pause(scope, 'quota');
      return { status: 'paused', ...empty, nextRunAt: null, pausedReason: 'quota' };
    }
    const taken = await this.queue.take(scope, fieldId, AI_FIELD_BATCH_SIZE, undefined, this.now());
    if (taken.length === 0) {
      return { status: 'done', ...empty, nextRunAt: await this.nextDue(scope, fieldId) };
    }

    const started = performance.now();
    const rows = await loadBaseSchemaRows(this.db, scope, table.base_id);
    const access = await aiSystemAccess(this.db, scope, table.base_id, context);
    const active = new Set<string>(
      rows.fields.filter((row) => row.deleted_at === null).map((row) => row.id),
    );
    const sources = aiSourcesOf(field).filter((id) => active.has(id));
    // A source formula edited since to read another record or table: no call, no value.
    const crossRecord = aiCrossRecordSources(sources, rows).length > 0;
    const found =
      access === null
        ? []
        : await this.options.records.getRecords(
            scope,
            table.id,
            taken.map((row) => row.recordId),
            access,
            { field_key_type: 'id', cell_format: 'json', fields: sources },
          );
    const records = new Map(found.map((record) => [record.id as string, record]));
    const snapshot = snapshotOfBase(rows, table.id);
    const target = aiTargetOf(field);
    // The day of each call (a batch may run past midnight in the organization's zone).
    const quota = () => this.quota(scope, context.timeZone);
    const limit = settings.daily_token_limit === null ? null : Number(settings.daily_token_limit);
    let usage: AiUsage = NO_USAGE;
    let calls = 0;
    const done: TakenAiRow[] = [];
    const failed = new Map<string, TakenAiRow[]>();
    const retry = new Map<number, TakenAiRow[]>();
    const values: { recordId: Id<'rec'>; version: number; value: string | null }[] = [];
    const push = <K>(map: Map<K, TakenAiRow[]>, key: K, row: TakenAiRow) => {
      map.set(key, [...(map.get(key) ?? []), row]);
    };
    let left: TakenAiRow[] = [];
    let stop: AiBatchStop | undefined;
    // Temporary errors in a row (a call that answered resets it): the circuit breaker.
    let temporaryInRow = 0;
    for (const [index, row] of taken.entries()) {
      const record = records.get(row.recordId);
      if (record === undefined) {
        // Gone, or in the trash: nothing to generate.
        done.push(row);
        continue;
      }
      // Before the record of every call after the first: AI or record data turned off meanwhile.
      if (calls > 0) {
        const stopped = await this.stopReason(scope);
        if (stopped !== null) {
          left = taken.slice(index);
          stop = { kind: 'pause', reason: stopped };
          break;
        }
      }
      const formulaRow: FormulaRecord = { id: record.id, fields: record.fields };
      // Provider calls of this record (repair rounds, resends): each one passed the quota first.
      let sent = 0;
      try {
        if (crossRecord) throw new AiRenderError('A source reads another record or table');
        const input = renderAiInput(ai.prompt, snapshot, formulaRow, {
          ...context,
          now: this.now(),
        });
        calls += 1;
        const result = await generateAiValue(
          {
            llm: this.options.llm,
            organizationId: scope.organizationId,
            settings: provider,
            deadline: createDeadline(provider.requestTimeoutSeconds * 1000),
            // The quota before every call: used up → the batch stops before it is sent.
            beforeCall: async () => {
              await this.ledger.check(quota(), limit);
              sent += 1;
            },
            onUsage: async (call) => {
              usage = {
                promptTokens: usage.promptTokens + call.promptTokens,
                completionTokens: usage.completionTokens + call.completionTokens,
                estimated: usage.estimated || call.estimated,
              };
              await this.ledger.record(quota(), 'field', call);
            },
          },
          ai,
          input,
          target,
        );
        calls += result.attempts - 1;
        temporaryInRow = 0;
        values.push({ recordId: row.recordId, version: record.version, value: result.value });
      } catch (error) {
        if (isAiQuotaExceeded(error)) {
          // The refused call was never sent; this row and the rest wait for the quota.
          calls += sent - 1;
          left = taken.slice(index);
          stop = { kind: 'pause', reason: 'quota' };
          break;
        }
        // `AI_INVALID_OUTPUT` after repair rounds: every call counts.
        const attempts = error instanceof AppError ? error.params?.['attempts'] : undefined;
        if (typeof attempts === 'number' && attempts > 1) calls += attempts - 1;
        // The same answer for every record until the settings change: no further call.
        const detail = aiProviderPauseDetailOf(error);
        if (detail !== null) {
          left = taken.slice(index);
          stop = { kind: 'pause', reason: 'provider_error', detail };
          break;
        }
        const limited = aiRateLimitOf(error);
        if (limited !== null) {
          const now = this.now();
          left = taken.slice(index);
          stop = {
            kind: 'back_off',
            until: new Date(now.getTime() + aiBackOffMs(limited.retryAfter, now)),
          };
          break;
        }
        if (isTemporaryAiError(error)) {
          temporaryInRow += 1;
          const delay = AI_FIELD_RETRY_DELAYS_MS[row.attempts - 1];
          if (delay !== undefined) push(retry, delay, row);
          else push(failed, aiFailureReason(error), row);
          if (temporaryInRow >= AI_FIELD_BREAKER_ERRORS) {
            left = taken.slice(index + 1);
            stop = {
              kind: 'back_off',
              until: new Date(this.now().getTime() + AI_FIELD_BACKOFF_MS),
            };
            break;
          }
          continue;
        }
        if (error instanceof AppError || error instanceof AiRenderError) {
          if (error instanceof AppError) temporaryInRow = 0;
          push(failed, aiFailureReason(error), row);
        } else {
          await this.queue.requeue(scope, fieldId, taken.slice(index), { refund: true });
          throw error;
        }
      }
    }

    const causation = mergedCausation(taken);
    const write = await this.options.mutations.writeAiValues(
      scope,
      table.id,
      fieldId,
      values,
      { ...systemAuditContext(batchId), via: { ai_field_id: fieldId } },
      // Values of the prompt read at the start of the batch only (QA S8).
      { prompt: ai.prompt, ...(causation === undefined ? {} : { causation }) },
    );
    const byRecord = new Map(taken.map((row) => [row.recordId as string, row]));
    const rowsOf = (ids: readonly string[]) =>
      ids.flatMap((id) => {
        const row = byRecord.get(id);
        return row === undefined ? [] : [row];
      });
    await this.queue.finish(scope, fieldId, [
      ...done,
      ...rowsOf(write.written),
      ...rowsOf(write.missing),
    ]);
    await this.queue.requeue(scope, fieldId, rowsOf(write.stale), { refund: true });
    if (!write.fieldFound) await this.queue.clear(scope, fieldId);
    for (const [reason, list] of failed) await this.queue.fail(scope, fieldId, list, reason);
    for (const [delay, list] of retry)
      await this.queue.requeue(scope, fieldId, list, { delayMs: delay });
    if (stop !== undefined) {
      // The rows not tried (and the one that stopped the batch) get their try back.
      await this.queue.requeue(scope, fieldId, left, { refund: true });
      if (stop.kind === 'pause') await this.pause(scope, stop.reason, stop.detail);
      else await this.announce(scope, await this.queue.backOff(scope, stop.until));
    }
    const failedCount = [...failed.values()].reduce((sum, list) => sum + list.length, 0);
    const durationMs = performance.now() - started;
    // A batch the provider stopped (paused or backing off) did not do all its rows.
    const providerStop =
      stop?.kind === 'back_off' || (stop?.kind === 'pause' && stop.reason === 'provider_error');
    const status = failedCount === 0 && !providerStop ? 'ok' : 'partial';
    if (calls > 0) {
      recordAiRequest({
        feature: 'field',
        status,
        durationMs,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        attempts: calls,
      });
      await this.db.withTx((tx) =>
        writeAiRequestedAudit(tx, {
          organizationId: scope.organizationId,
          baseId: table.base_id,
          tableId: table.id,
          entityType: 'field',
          entityId: fieldId,
          feature: 'field',
          model: provider.model,
          status,
          attempts: calls,
          usage,
          durationMs,
          outputMode: null,
          logPrompts: false,
          records: taken.length,
          context: { ...systemAuditContext(batchId), via: { ai_field_id: fieldId } },
        }),
      );
    }
    await this.progress(scope, taken);
    const pausedReason = stop?.kind === 'pause' ? stop.reason : undefined;
    const nextRunAt = await this.nextDue(scope, fieldId);
    return {
      status:
        pausedReason !== undefined
          ? 'paused'
          : nextRunAt !== null && nextRunAt.getTime() <= this.now().getTime()
            ? 'more'
            : 'done',
      rows: taken.length,
      written: write.written.length,
      failed: failedCount,
      calls,
      usage,
      nextRunAt: pausedReason === undefined ? nextRunAt : null,
      ...(pausedReason === undefined ? {} : { pausedReason }),
      ...(stop?.kind === 'pause' && stop.detail !== undefined ? { pausedDetail: stop.detail } : {}),
      ...(stop?.kind === 'back_off' ? { backOffUntil: stop.until } : {}),
    };
  }

  /** Progress of the generate requests (`meta.jobs`) whose rows this batch took. */
  private async progress(scope: OrgScope, taken: readonly TakenAiRow[]): Promise<void> {
    const jobIds = [...new Set(taken.flatMap((row) => (row.jobId === null ? [] : [row.jobId])))];
    for (const jobId of jobIds) {
      const job = await this.jobs.getById(scope, jobId);
      if (job === undefined || job.status !== 'running') continue;
      const total =
        isRecord(job.result) && typeof job.result['rows'] === 'number' ? job.result['rows'] : 0;
      const pending = await this.queue.pendingOfJob(scope, jobId);
      if (pending === 0) {
        const failed = await this.queue.failedOfJob(scope, jobId);
        await this.db.withTx((tx) =>
          this.jobs.markSucceeded(withTxScope(scope, tx), jobId, { rows: total, failed }),
        );
      } else if (total > 0) {
        await this.db.withTx((tx) =>
          this.jobs.setProgress(
            withTxScope(scope, tx),
            jobId,
            Math.max(0, Math.min(1, 1 - pending / total)),
          ),
        );
      }
    }
  }

  /**
   * The rescue of one organization (cron `ai.generation_rescue`, every
   * minute): leases that ended go back to `queued`; paused rows resume once
   * their reason is gone (AI and record data on again, quota reset) — never
   * `provider_error` ones, which resume when the AI settings or the key
   * change; every field with queued rows gets its `ai.generate` job (a lost
   * one too).
   */
  async rescue(scope: OrgScope): Promise<Id<'fld'>[]> {
    await this.queue.releaseExpired(scope);
    const state = await this.settings.find(scope);
    let available = true;
    try {
      requireAi(state, { recordData: true });
    } catch {
      available = false;
    }
    if (available && state !== undefined) {
      const context = await this.contextOf(scope);
      const reasons: AiPauseReason[] = ['ai_disabled', 'record_data_disabled'];
      if (!(await this.quotaUsedUp(scope, context.timeZone, state))) reasons.push('quota');
      await this.announce(scope, await this.queue.resume(scope, reasons));
    }
    const due = available ? await this.queue.dueFields(scope) : [];
    if (due.length > 0) {
      await this.db.withTx(async (tx) => {
        for (const item of due) {
          await enqueueAiGeneration(tx, scope.organizationId, item.fieldId, item.dueAt);
        }
      });
    }
    return due.map((item) => item.fieldId);
  }
}

/**
 * `ai_state` of `fieldIds` with the table and base each belongs to, for
 * `schema.changed` (fields gone or without their table are left out).
 */
export async function aiFieldStateChanges(
  db: Db,
  scope: OrgScope,
  fieldIds: readonly Id<'fld'>[],
): Promise<AiFieldStateChange[]> {
  if (fieldIds.length === 0) return [];
  const fields = new FieldsRepository(db);
  const tables = new TablesRepository(db);
  const states = await new AiGenerationQueueRepository(db).statesOf(scope, fieldIds);
  const bases = new Map<Id<'bse'>, BaseSchemaRows>();
  const changes: AiFieldStateChange[] = [];
  for (const fieldId of fieldIds) {
    const field = await fields.getById(scope, fieldId);
    const table = field === undefined ? undefined : await tables.getById(scope, field.table_id);
    const state = states.get(fieldId);
    if (field === undefined || table === undefined || state === undefined) continue;
    let rows = bases.get(table.base_id);
    if (rows === undefined) {
      rows = await loadBaseSchemaRows(db, scope, table.base_id);
      bases.set(table.base_id, rows);
    }
    changes.push({
      organizationId: scope.organizationId,
      baseId: table.base_id,
      tableId: table.id,
      fieldId,
      state,
      configFieldIds: aiConfigFieldIds(field, rows),
    });
  }
  return changes;
}

/**
 * In `tx` (the save of the AI settings, or the new value of the key they
 * use): rows paused because the provider rejected the configuration go back
 * to `queued` and each of their fields gets its `ai.generate` job. Returns
 * those fields (their `schema.changed` goes out after commit).
 */
export async function resumeAiProviderPause(
  db: Db,
  tx: Tx,
  organizationId: Id<'org'>,
): Promise<Id<'fld'>[]> {
  const fieldIds = await new AiGenerationQueueRepository(db).resume(orgScope(organizationId, tx), [
    'provider_error',
  ]);
  for (const fieldId of fieldIds) {
    await enqueueAiGeneration(tx, organizationId, fieldId, new Date());
  }
  return fieldIds;
}

/** The causation of the writes that queued `rows` (the deepest one: the loop guard keeps counting). */
function mergedCausation(rows: readonly TakenAiRow[]): Causation | undefined {
  let found: Causation | undefined;
  for (const row of rows) {
    const value: JsonValue | null = row.causation;
    if (!isRecord(value) || typeof value['depth'] !== 'number') continue;
    if (found === undefined || value['depth'] > found.depth) found = value as unknown as Causation;
  }
  return found;
}
