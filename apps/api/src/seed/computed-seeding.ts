import { COMPUTED_BACKFILL_BATCH_SIZE, COMPUTED_BACKFILL_JOB_TYPE } from '@cellhive/contracts';
import {
  FieldsRepository,
  isComputedRow,
  JobsRepository,
  RecordMutationService,
  SchemaService,
  type AuditContext,
  type Db,
  type FieldRow,
  type OrgScope,
} from '@cellhive/server-core';

import { DB } from '../common/tokens.js';

import type { Id } from '@cellhive/contracts';
import type { INestApplicationContext } from '@nestjs/common';

/** Rows rewritten from which the seed analyzes the table, as the worker's job (10 000). */
const SEED_ANALYZE_THRESHOLD = 10_000;

/** `statement_timeout` of one backfill batch, as the worker's (SPEC §9.5). */
const BACKFILL_STATEMENT_TIMEOUT_MS = 30_000;

/** A formula or lookup field the seed adds (options as `POST /tables/:id/fields` takes them). */
export interface SeedComputedField {
  readonly name: string;
  readonly type: 'formula' | 'lookup';
  readonly options: Record<string, unknown>;
  readonly description?: string;
}

export interface SeedComputedInput {
  readonly scope: OrgScope;
  readonly context: AuditContext;
  /** Organization zone (ADR-21): what `TODAY()` and dates compile against. */
  readonly timeZone: string;
}

/**
 * Adds `formula`/`lookup` fields through `SchemaService` (AGENTS.md rule 1)
 * after the records exist, and computes each stored one right away, as the
 * `computed.backfill` job would (`RecordMutationService.backfillComputedBatch`
 * in batches of 5 000, then `SchemaService.finishComputedBackfill`), so the
 * seeded data is complete without a running worker. The job's `meta.jobs`
 * row is closed as succeeded: when a worker starts later, the queued
 * graphile job finds it final and skips (see `computed-backfill.ts`).
 *
 * Fields are added in order: a field reading another one comes after it.
 */
export class SeedComputedFields {
  private readonly db: Db;
  private readonly schema: SchemaService;
  private readonly records: RecordMutationService;
  private readonly jobs: JobsRepository;
  private readonly fields: FieldsRepository;

  constructor(
    app: INestApplicationContext,
    private readonly input: SeedComputedInput,
  ) {
    this.db = app.get<Db>(DB);
    this.schema = app.get(SchemaService);
    this.records = app.get(RecordMutationService);
    this.jobs = new JobsRepository(this.db);
    this.fields = new FieldsRepository(this.db);
  }

  /** Adds one field and, when stored, fills its column; returns the field as it ends. */
  async add(tableId: Id<'tbl'>, field: SeedComputedField): Promise<FieldRow> {
    const { scope, context, timeZone } = this.input;
    const before = await this.jobs.findActive(scope, COMPUTED_BACKFILL_JOB_TYPE);
    const added = await this.schema.addField(
      scope,
      tableId,
      {
        name: field.name,
        type: field.type,
        options: field.options,
        ...(field.description === undefined ? {} : { description: field.description }),
        computed: { timeZone },
      },
      context,
    );
    if (!isComputedRow(added) || added.compute_state !== 'backfilling') return added;

    let cursor = 0n;
    let written = 0;
    for (;;) {
      const result = await this.records.backfillComputedBatch(scope, {
        fieldId: added.id,
        afterAuto: cursor,
        limit: COMPUTED_BACKFILL_BATCH_SIZE,
        statementTimeoutMs: BACKFILL_STATEMENT_TIMEOUT_MS,
      });
      if (result.status === 'skipped' || result.status === 'superseded') {
        throw new Error(`computed field ${field.name} could not be backfilled (${result.status})`);
      }
      written += result.rows;
      if (result.status === 'done') break;
      cursor = result.cursor;
    }
    await this.schema.finishComputedBackfill(scope, added.id, { status: 'ready' });
    // Like the job (S4b conventions): many rows rewritten → ANALYZE, else the
    // planner's row estimate of the table doubles with the dead tuples and the
    // grid's "About N records" of a 200k bench table reads ~400k (T470).
    if (written >= SEED_ANALYZE_THRESHOLD) await this.schema.analyzeComputedTable(scope, tableId);

    // Close the job of this field: the only active backfill job, since the
    // seed adds fields one at a time (with another job active before, the
    // worker runs it: its second pass writes nothing new).
    const job =
      before === undefined
        ? await this.jobs.findActive(scope, COMPUTED_BACKFILL_JOB_TYPE)
        : undefined;
    if (job !== undefined) {
      await this.jobs.markRunning(scope, job.id);
      await this.jobs.markSucceeded(scope, job.id, { fields: 1, via: 'seed' });
    }
    return (await this.fields.getById(scope, added.id)) ?? added;
  }
}
