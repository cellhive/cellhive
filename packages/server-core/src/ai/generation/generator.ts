import {
  AI_FIELD_BATCH_SIZE,
  AI_FIELD_RETRY_DELAYS_MS,
  type AiFieldOptions,
  type AiFieldStateDto,
  type AiPauseReason,
  type Id,
} from '@cellhive/contracts';
import { isValidTimeZone, selectOptionsSchema } from '@cellhive/field-types';
import { resolveBaseAccess } from '@cellhive/permissions';

import { systemAuditContext } from '../../audit/audit-entry.js';
import { loadBaseSchemaRows, snapshotOfBase } from '../../computed/definition/schema-rows.js';
import { OrganizationsRepository } from '../../db/repositories/organizations.repository.js';
import { withTxScope, type OrgScope } from '../../db/repository.js';
import { AppError } from '../../errors/app-error.js';
import { loadMemberAccessBase } from '../../import/member-access.js';
import { JobsRepository } from '../../jobs/jobs.repository.js';
import { FieldsRepository } from '../../schema/fields.repository.js';
import { TablesRepository } from '../../schema/tables.repository.js';
import { writeAiRequestedAudit } from '../audit/ai-requested.js';
import { createDeadline } from '../deadline.js';
import { isTemporaryAiError, aiInvalidOutput } from '../errors.js';
import { recordAiRequest } from '../metrics.js';
import { AiSettingsRepository } from '../settings/ai-settings.repository.js';
import { requireAi, type AiSettingsState } from '../settings/settings.js';
import { AiUsageLedger, type AiQuotaContext } from '../usage/quota.js';

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

import type { Db } from '../../db/create-db.js';
import type { JsonValue } from '../../db/schema.js';
import type { Causation } from '../../events/event.js';
import type { RecordMutationService } from '../../records/record-mutation.service.js';
import type { RecordQueryService } from '../../records/record-query.service.js';
import type { RecordAccessContext } from '../../records/types.js';
import type { AiProviderSettings, AiUsage, LlmClient } from '../client.js';
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

/** What one provider call needs (the API's `AiCall`, or the worker's own). */
export interface AiValueCall {
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
export function aiFailureReason(error: unknown): string {
  if (error instanceof AiRenderError) return 'render_error';
  if (error instanceof AppError) {
    if (error.code === 'AI_INVALID_OUTPUT') return 'invalid_output';
    if (error.code === 'AI_TIMEOUT') return 'timeout';
  }
  return 'provider_error';
}

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
 * before every call) → `paused quota`; temporary errors retried after 30 s,
 * 2 and 10 minutes, then `failed`. One `ai.requested` audit entry per batch.
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
      if (error instanceof AppError && error.code === 'AI_QUOTA_EXCEEDED') return true;
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

  /** Pauses every queued row of the organization and tells the fields' readers. */
  private async pause(scope: OrgScope, reason: AiPauseReason): Promise<void> {
    const fields = await this.queue.pause(scope, reason);
    await this.announce(scope, fields);
  }

  /** `schema.changed` with `ai_state` for `fieldIds` (paused or resumed together). */
  private async announce(scope: OrgScope, fieldIds: readonly Id<'fld'>[]): Promise<void> {
    if (fieldIds.length === 0 || this.options.onStateChange === undefined) return;
    const states = await this.queue.statesOf(scope, fieldIds);
    const changes: AiFieldStateChange[] = [];
    for (const fieldId of fieldIds) {
      const field = await this.fields.getById(scope, fieldId);
      const table =
        field === undefined ? undefined : await this.tables.getById(scope, field.table_id);
      const state = states.get(fieldId);
      if (field === undefined || table === undefined || state === undefined) continue;
      changes.push({
        organizationId: scope.organizationId,
        baseId: table.base_id,
        tableId: table.id,
        fieldId,
        state,
      });
    }
    await this.options.onStateChange(changes);
  }

  /** When the next queued row of the field is due (`null`: none queued). */
  private async nextDue(scope: OrgScope, fieldId: Id<'fld'>): Promise<Date | null> {
    const due = await this.queue.dueFields(scope);
    return due.find((item) => item.fieldId === fieldId)?.dueAt ?? null;
  }

  /**
   * One batch of `fieldId` (the `ai.generate` job runs batches while
   * `status` is `more`, then schedules itself at `nextRunAt`). `batchId` is
   * the `job_…` of the run: the `batch_id` of the audit entries it writes.
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
    const taken = await this.queue.take(scope, fieldId, AI_FIELD_BATCH_SIZE);
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
    let pausedReason: AiPauseReason | undefined;
    for (const [index, row] of taken.entries()) {
      const record = records.get(row.recordId);
      if (record === undefined) {
        // Gone, or in the trash: nothing to generate.
        done.push(row);
        continue;
      }
      // Before every call after the first: AI or record data turned off meanwhile, or the quota.
      if (calls > 0) {
        const stopped =
          (await this.stopReason(scope)) ??
          ((await this.quotaUsedUp(scope, context.timeZone, settings)) ? 'quota' : null);
        if (stopped !== null) {
          left = taken.slice(index);
          pausedReason = stopped;
          break;
        }
      }
      const formulaRow: FormulaRecord = { id: record.id, fields: record.fields };
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
            onUsage: async (call) => {
              usage = {
                promptTokens: usage.promptTokens + call.promptTokens,
                completionTokens: usage.completionTokens + call.completionTokens,
                estimated: usage.estimated || call.estimated,
              };
              await this.ledger.record(this.quota(scope, context.timeZone), 'field', call);
            },
          },
          ai,
          input,
          target,
        );
        calls += result.attempts - 1;
        values.push({ recordId: row.recordId, version: record.version, value: result.value });
      } catch (error) {
        // `AI_INVALID_OUTPUT` after repair rounds: every call counts.
        const attempts = error instanceof AppError ? error.params?.['attempts'] : undefined;
        if (typeof attempts === 'number' && attempts > 1) calls += attempts - 1;
        const temporary = isTemporaryAiError(error);
        const delay = AI_FIELD_RETRY_DELAYS_MS[row.attempts - 1];
        if (temporary && delay !== undefined) push(retry, delay, row);
        else if (error instanceof AppError || error instanceof AiRenderError) {
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
      causation === undefined ? {} : { causation },
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
    if (left.length > 0 && pausedReason !== undefined) {
      await this.queue.requeue(scope, fieldId, left, { refund: true });
      await this.pause(scope, pausedReason);
    }
    const failedCount = [...failed.values()].reduce((sum, list) => sum + list.length, 0);
    const durationMs = performance.now() - started;
    if (calls > 0) {
      recordAiRequest({
        feature: 'field',
        status: failedCount === 0 ? 'ok' : 'partial',
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
          status: failedCount === 0 ? 'ok' : 'partial',
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
   * their reason is gone (AI and record data on again, quota reset); every
   * field with queued rows gets its `ai.generate` job (a lost one too).
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
