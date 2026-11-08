import {
  AI_FIELD_GENERATE_MAX_ROWS,
  AI_FIELD_PREVIEW_INPUT_LENGTH,
  AI_FIELD_PREVIEW_ROWS,
  newId,
  type AiFieldGenerate,
  type AiFieldGenerateRequest,
  type AiFieldPreview,
  type AiFieldPreviewRequest,
  type Id,
} from '@cellhive/contracts';
import {
  AiGenerationQueueRepository,
  AiSettingsRepository,
  AppError,
  aiFieldLockedFor,
  aiOptionsOf,
  aiSourceFieldIds,
  aiTargetOf,
  enqueueAiGeneration,
  estimateTokens,
  generateAiValue,
  GroupMembersRepository,
  isAiQuotaExceeded,
  JobsRepository,
  loadBaseSchemaRows,
  prepareAiOptions,
  RecordQueryService,
  renderAiInput,
  requireAi,
  snapshotOfBase,
  withTxScope,
  type AiFieldTarget,
  type AiSettingsState,
  type AppConfig,
  type Db,
  type OrgScope,
  type RecordAccessContext,
} from '@cellhive/server-core';
import { Inject, Injectable } from '@nestjs/common';

import { notFound, permissionDenied } from '../../common/access/access.service.js';
import { recordAccessContextOf } from '../../common/access/record-access-context.js';
import { SchemaAccess } from '../../common/schema/schema-access.js';
import { APP_CONFIG, DB } from '../../common/tokens.js';
import { readabilityOf } from '../field/computed-fields.js';

import { AiAccess, type AiRequestMeta } from './ai-access.js';

import type { Principal } from '../../common/auth/principal.js';

/** Ids read per query while a generate request collects its rows (never every id at once). */
const AI_GENERATE_ID_BATCH = 5_000;

/** `409 AI_GENERATION_RUNNING`: a generate request of the field still runs (`params.job_id`). */
function generationRunning(jobId: Id<'job'>): AppError {
  const message = 'This AI field is already being generated.';
  return new AppError('AI_GENERATION_RUNNING', {
    detail: `${message} Follow job ${jobId} until it ends, then generate again.`,
    errors: [{ path: '', code: 'AI_GENERATION_RUNNING', message, params: { job_id: jobId } }],
    params: { job_id: jobId },
  });
}

/** `422 TOO_MANY_ROWS`: the request names more rows than one may queue (never cut short). */
function tooManyRows(rows: number, limit: number): AppError {
  return new AppError('VALIDATION_FAILED', {
    detail:
      `This request names ${String(rows)} rows; one generate request queues at most ` +
      `${String(limit)}.`,
    errors: [
      {
        path: 'scope',
        code: 'TOO_MANY_ROWS',
        message: `More than ${String(limit)} rows`,
        params: { rows, limit },
      },
    ],
  });
}

/**
 * AI fields (CONTRACTS §29.5, BACKLOG T910): the 5-record preview of a
 * prompt (provider calls through `AiAccess`, nothing written) and the
 * generate request (rows queued for the AI worker, a `meta.jobs` row to
 * follow). Both need schema rights on the table — `404`/`403` before
 * anything about AI — and record data allowed (`AI_RECORD_DATA_DISABLED`).
 *
 * `maxRows` and `idBatch` are plain fields so tests can lower them.
 */
@Injectable()
export class AiFieldService {
  /** Most rows one generate request queues (`AI_FIELD_GENERATE_MAX_ROWS`). */
  maxRows: number = AI_FIELD_GENERATE_MAX_ROWS;
  /** Ids read per query while a generate request collects its rows. */
  idBatch: number = AI_GENERATE_ID_BATCH;

  constructor(
    @Inject(SchemaAccess) private readonly schemaAccess: SchemaAccess,
    @Inject(AiAccess) private readonly ai: AiAccess,
    @Inject(AiSettingsRepository) private readonly settings: AiSettingsRepository,
    @Inject(RecordQueryService) private readonly records: RecordQueryService,
    @Inject(GroupMembersRepository) private readonly groupMembers: GroupMembersRepository,
    @Inject(JobsRepository) private readonly jobs: JobsRepository,
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async preview(
    principal: Principal,
    tableId: Id<'tbl'>,
    body: AiFieldPreviewRequest,
    meta: AiRequestMeta,
  ): Promise<AiFieldPreview> {
    const { base, table } = await this.schemaAccess.requireTable(principal, tableId, 'manage');
    const scope = base.org.scope;
    const rows = await loadBaseSchemaRows(this.db, scope, base.base.id);
    const readable = readabilityOf(base.access);
    let target: AiFieldTarget;
    let field: { id: Id<'fld'>; isPrimary: boolean } = { id: newId('fld'), isPrimary: false };
    if (body.field_id === null) {
      target =
        body.type === 'select'
          ? {
              kind: 'select',
              options: [...new Set(body.choices)].map((name) => ({ id: name, name })),
            }
          : { kind: 'text' };
    } else {
      const row = rows.fields.find((item) => item.id === body.field_id);
      if (
        row === undefined ||
        row.table_id !== table.id ||
        (row.type !== 'text' && row.type !== 'select') ||
        !readable.field(table.id, row.id)
      ) {
        throw notFound();
      }
      target = aiTargetOf(row);
      field = { id: row.id, isPrimary: row.is_primary };
    }
    const prepared = prepareAiOptions(body.ai, rows, { ...field, tableId: table.id }, { readable });
    // A formula of the prompt reading a field the caller cannot: its values would reach them.
    const asField = { type: 'text', options: { ai: prepared.ai } };
    if (aiFieldLockedFor(asField, rows, (id) => readable.field(table.id, id))) {
      throw permissionDenied('The prompt reads values you cannot read.');
    }
    const access = await recordAccessContextOf(
      { groupMembers: this.groupMembers, config: this.config },
      principal.user,
      base,
    );
    const page = await this.records.query(scope, table.id, access, {
      field_key_type: 'id',
      cell_format: 'json',
      fields: aiSourceFieldIds(prepared.ai.prompt),
      limit: AI_FIELD_PREVIEW_ROWS,
      ...(body.record_ids === undefined ? {} : { ids: body.record_ids }),
    });
    const total = 'total_estimate' in page ? page.total_estimate : 'total' in page ? page.total : 0;
    const snapshot = snapshotOfBase(rows, table.id, readable);
    return this.ai.run(
      principal,
      base.org,
      {
        feature: 'field',
        recordData: true,
        entityType: 'table',
        entityId: table.id,
        baseId: base.base.id,
        tableId: table.id,
        meta,
      },
      async (call) => {
        let tokens = 0;
        let calls = 0;
        const items: AiFieldPreview['items'] = [];
        for (const record of page.records) {
          const input = renderAiInput(
            prepared.ai.prompt,
            snapshot,
            { id: record.id, fields: record.fields },
            { timeZone: access.timeZone, locale: access.locale, now: this.ai.now() },
          );
          const inputPreview = Array.from(input.plain)
            .slice(0, AI_FIELD_PREVIEW_INPUT_LENGTH)
            .join('');
          try {
            const result = await generateAiValue(
              {
                llm: call.llm,
                organizationId: call.organizationId,
                settings: call.settings,
                deadline: call.deadline,
                ...call.hooks,
                onUsage: async (usage) => {
                  tokens += usage.promptTokens + usage.completionTokens;
                  await call.hooks.onUsage(usage);
                },
              },
              prepared.ai,
              input,
              target,
            );
            calls += result.attempts;
            items.push({
              record_id: record.id,
              input_preview: inputPreview,
              output: result.value,
              error: null,
            });
          } catch (error) {
            // The quota used up meanwhile ends the request (`429`): no call for the other records.
            if (isAiQuotaExceeded(error)) throw error;
            if (!(error instanceof AppError) || !error.code.startsWith('AI_')) throw error;
            calls += 1;
            const reason = error.params?.['reason'];
            items.push({
              record_id: record.id,
              input_preview: inputPreview,
              output: null,
              error: { code: error.code, ...(typeof reason === 'string' ? { reason } : {}) },
            });
            // The time budget of the request is spent: the other records would fail alike.
            if (error.code === 'AI_TIMEOUT') break;
          }
        }
        call.report({ attempts: Math.max(1, calls) });
        const perRow = items.length === 0 ? 0 : tokens / items.length;
        return { items, estimate: { rows: total, tokens: Math.ceil(perRow * total) } };
      },
    );
  }

  /**
   * Queues the rows `body` names for the AI worker (BACKLOG T910, T1003):
   * after the field's `404`/`403`/`422` checks, the AI rate limit and
   * today's quota (`429`, nothing queued); one generate request of a field
   * at a time (`409 AI_GENERATION_RUNNING` while one has rows queued or
   * being generated); at most {@link maxRows} rows (`422 TOO_MANY_ROWS`,
   * never cut short), read {@link idBatch} ids at a time. Rows queue, the
   * job is created and `ai.generate` is scheduled in one transaction.
   */
  async generate(
    principal: Principal,
    fieldId: Id<'fld'>,
    body: AiFieldGenerateRequest,
  ): Promise<AiFieldGenerate> {
    const { base, field } = await this.schemaAccess.requireField(principal, fieldId, 'manage');
    const ai = aiOptionsOf(field);
    if (ai === null) {
      throw new AppError('VALIDATION_FAILED', {
        detail: 'This field is not an AI field.',
        errors: [{ path: 'field_id', code: 'INVALID_FIELD_TYPE', message: 'Not an AI field' }],
      });
    }
    const readable = readabilityOf(base.access);
    const scope = base.org.scope;
    const rows = await loadBaseSchemaRows(this.db, scope, base.base.id);
    // Generating values the caller could not read: refused like a missing right.
    if (aiFieldLockedFor(field, rows, (id) => readable.field(field.table_id, id))) {
      throw permissionDenied('Generating this field needs every field of its prompt readable.');
    }
    const saved = await this.settings.find(scope);
    requireAi(saved, { recordData: true });
    await this.ai.admit(principal, base.org, saved as AiSettingsState);
    const queue = new AiGenerationQueueRepository(this.db);
    const running = await queue.runningJobOf(scope, fieldId);
    if (running !== null) throw generationRunning(running);
    const access = await recordAccessContextOf(
      { groupMembers: this.groupMembers, config: this.config },
      principal.user,
      base,
    );
    const ids = await this.rowsOf(scope, field.table_id, fieldId, access, body, queue);
    const jobId = newId('job');
    const queued = await this.db.withTx(async (tx) => {
      const txScope = withTxScope(scope, tx);
      // A request that waited here for another one sees that one's job now.
      await queue.lockGenerate(txScope, fieldId);
      const other = await queue.runningJobOf(txScope, fieldId);
      if (other !== null) throw generationRunning(other);
      // Rows that failed with `invalid_output` go again only when asked for (`failed`, `all`).
      const count =
        ids.length === 0
          ? 0
          : await queue.enqueue(txScope, fieldId, ids, {
              jobId,
              retryInvalidOutput: body.scope === 'failed' || body.scope === 'all',
            });
      await this.jobs.create(txScope, {
        id: jobId,
        type: 'ai.generate',
        createdBy: principal.userId,
        result: { field_id: fieldId, rows: count },
      });
      await this.jobs.markRunning(txScope, jobId);
      if (count === 0) {
        await this.jobs.markSucceeded(txScope, jobId, { rows: 0, failed: 0 });
        return 0;
      }
      await queue.resume(txScope, ['quota', 'ai_disabled', 'record_data_disabled'], fieldId);
      await enqueueAiGeneration(tx, scope.organizationId, fieldId, new Date());
      return count;
    });
    // A rough figure, not an upper bound: the stored prompt and the longest answer per row —
    // the values, the instructions and repair calls are not counted (CONTRACTS §29.5).
    const perRow = estimateTokens(ai.prompt) + ai.max_output_tokens;
    return { job_id: jobId, rows: queued, estimated_tokens: queued * perRow };
  }

  /**
   * The records `body` names among those the caller reads, {@link idBatch}
   * ids per query; more than {@link maxRows} is `422 TOO_MANY_ROWS` — from
   * the count, before any id is read, for every scope but `records`.
   */
  private async rowsOf(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    fieldId: Id<'fld'>,
    access: RecordAccessContext,
    body: AiFieldGenerateRequest,
    queue: AiGenerationQueueRepository,
  ): Promise<Id<'rec'>[]> {
    const ids: Id<'rec'>[] = [];
    const add = (batch: Iterable<string>) => {
      for (const id of batch) ids.push(id as Id<'rec'>);
      if (ids.length > this.maxRows) throw tooManyRows(ids.length, this.maxRows);
    };
    switch (body.scope) {
      case 'records':
        add(await this.records.matchingIds(scope, tableId, access, body.record_ids ?? [], null));
        return ids;
      case 'failed':
      case 'paused': {
        // (T1002) `paused`: "Resume" — only the cells that were queued and paused.
        const total = await queue.countOf(scope, fieldId, body.scope);
        if (total > this.maxRows) throw tooManyRows(total, this.maxRows);
        let after: Id<'rec'> | null = null;
        for (;;) {
          const page = await queue.recordIdPage(scope, fieldId, body.scope, after, this.idBatch);
          if (page.length > 0) {
            add(await this.records.matchingIds(scope, tableId, access, page, null));
          }
          if (page.length < this.idBatch) return ids;
          after = page.at(-1) ?? null;
        }
      }
      case 'empty':
      case 'all': {
        const filter =
          body.scope === 'empty'
            ? { op: 'and', items: [{ field: fieldId, operator: 'is_empty' }] }
            : null;
        const total = await this.records.countMatching(scope, tableId, access, filter);
        if (total > this.maxRows) throw tooManyRows(total, this.maxRows);
        let after: Id<'rec'> | null = null;
        do {
          const batch = await this.records.matchingIdBatch(scope, tableId, access, filter, {
            after,
            limit: this.idBatch,
          });
          add(batch.ids);
          after = batch.next;
        } while (after !== null);
        return ids;
      }
    }
  }
}
