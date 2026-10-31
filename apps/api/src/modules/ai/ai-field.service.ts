import {
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
  aiFieldLocked,
  aiOptionsOf,
  aiSourceFieldIds,
  aiTargetOf,
  enqueueAiGeneration,
  estimateTokens,
  generateAiValue,
  GroupMembersRepository,
  JobsRepository,
  loadBaseSchemaRows,
  prepareAiOptions,
  RecordQueryService,
  renderAiInput,
  requireAi,
  snapshotOfBase,
  withTxScope,
  type AiFieldTarget,
  type AppConfig,
  type Db,
} from '@cellhive/server-core';
import { Inject, Injectable } from '@nestjs/common';

import { notFound, permissionDenied } from '../../common/access/access.service.js';
import { recordAccessContextOf } from '../../common/access/record-access-context.js';
import { SchemaAccess } from '../../common/schema/schema-access.js';
import { APP_CONFIG, DB } from '../../common/tokens.js';
import { readabilityOf } from '../field/computed-fields.js';

import { AiAccess } from './ai-access.js';

import type { Principal } from '../../common/auth/principal.js';
import type { RequestMeta } from '../../common/auth/request-meta.js';

/** Most rows one generate request queues (a table larger than this needs several). */
const AI_GENERATE_MAX_ROWS = 1_000_000;

/**
 * AI fields (CONTRACTS §29.5, BACKLOG T910): the 5-record preview of a
 * prompt (provider calls through `AiAccess`, nothing written) and the
 * generate request (rows queued for the AI worker, a `meta.jobs` row to
 * follow). Both need schema rights on the table — `404`/`403` before
 * anything about AI — and record data allowed (`AI_RECORD_DATA_DISABLED`).
 */
@Injectable()
export class AiFieldService {
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
    meta: RequestMeta,
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
                onUsage: async (usage) => {
                  tokens += usage.promptTokens + usage.completionTokens;
                  await call.onUsage(usage);
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
    // Generating values the caller could not read: refused like a missing right.
    if (aiFieldLocked(field, (id) => readable.field(field.table_id, id))) {
      throw permissionDenied('Generating this field needs every field of its prompt readable.');
    }
    const scope = base.org.scope;
    requireAi(await this.settings.find(scope), { recordData: true });
    const access = await recordAccessContextOf(
      { groupMembers: this.groupMembers, config: this.config },
      principal.user,
      base,
    );
    const queue = new AiGenerationQueueRepository(this.db);
    let ids: Id<'rec'>[];
    switch (body.scope) {
      case 'records':
        ids = [
          ...(await this.records.matchingIds(
            scope,
            field.table_id,
            access,
            body.record_ids ?? [],
            null,
          )),
        ] as Id<'rec'>[];
        break;
      case 'failed': {
        const failed = await queue.recordIdsOf(scope, fieldId, 'failed');
        ids = [
          ...(await this.records.matchingIds(scope, field.table_id, access, failed, null)),
        ] as Id<'rec'>[];
        break;
      }
      case 'empty':
        ids = await this.records.allMatchingIds(
          scope,
          field.table_id,
          access,
          { op: 'and', items: [{ field: fieldId, operator: 'is_empty' }] },
          AI_GENERATE_MAX_ROWS,
        );
        break;
      case 'all':
        ids = await this.records.allMatchingIds(
          scope,
          field.table_id,
          access,
          null,
          AI_GENERATE_MAX_ROWS,
        );
        break;
    }
    const job = await this.db.withTx(async (tx) => {
      const txScope = withTxScope(scope, tx);
      const created = await this.jobs.create(txScope, {
        type: 'ai.generate',
        createdBy: principal.userId,
        result: { field_id: fieldId, rows: ids.length },
      });
      await this.jobs.markRunning(txScope, created.id);
      if (ids.length === 0) {
        await this.jobs.markSucceeded(txScope, created.id, { rows: 0, failed: 0 });
        return created;
      }
      await queue.enqueue(txScope, fieldId, ids, { jobId: created.id });
      await queue.resume(txScope, ['quota', 'ai_disabled', 'record_data_disabled'], fieldId);
      await enqueueAiGeneration(tx, scope.organizationId, fieldId, new Date());
      return created;
    });
    // Rough upper bound: the prompt (values unknown here) and the answer, per row.
    const perRow = estimateTokens(ai.prompt) + ai.max_output_tokens;
    return { job_id: job.id, rows: ids.length, estimated_tokens: ids.length * perRow };
  }
}
