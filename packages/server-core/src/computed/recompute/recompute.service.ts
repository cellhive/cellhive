import {
  COMPUTED_RECOMPUTE_BATCH_SIZE,
  COMPUTED_RECOMPUTE_DEBOUNCE_MS,
  COMPUTED_SYNC_ROW_LIMIT,
  type Id,
} from '@cellhive/contracts';
import { isValidTimeZone } from '@cellhive/field-types';
import { sql } from 'kysely';

import { RecomputeEventHooks } from '../../automation/dispatch/recompute-events.js';
import { OrganizationsRepository } from '../../db/repositories/organizations.repository.js';
import { orgScope, type OrgScope } from '../../db/repository.js';
import { enqueue } from '../../jobs/enqueue.js';
import { RealtimeComputedHooks } from '../../realtime/computed-values.js';
import { FieldsRepository } from '../../schema/fields.repository.js';
import { assertDataTableName, assertFieldColumnName, DATA_SCHEMA } from '../../schema/names.js';
import { DDL_LOCK_TIMEOUT_MS, schemaLockKey } from '../../schema/policy.js';
import { TablesRepository } from '../../schema/tables.repository.js';

import {
  composeComputedRecomputeHooks,
  type ComputedBefore,
  type ComputedChange,
  type ComputedChanges,
  type ComputedRecomputeHooks,
  type ComputedRecomputeResult,
  type DeferredField,
  type RecomputedValues,
  type RecomputeSource,
} from './changes.js';
import { RecomputeContext } from './context.js';
import { ComputedRecomputeQueueRepository, type QueuedOrigin } from './queue.repository.js';
import { AffectedResolver, AffectedRows, type ResolvedChange } from './resolver.js';

import type { Db, Tx } from '../../db/create-db.js';

/** Alias of the recomputed row in the `UPDATE` (code constant). */
const ROW_ALIAS = 'cr';
const TARGET_ALIAS = 'u';

export interface ComputedRecomputeServiceOptions {
  /** Zone of organizations without `settings.timezone` (ADR-21); default UTC. */
  readonly defaultTimeZone?: string;
  /** Rows a write recomputes itself (SPEC §5.9); default `COMPUTED_SYNC_ROW_LIMIT` (1 000). */
  readonly syncRowLimit?: number;
  /** Wait for a table's schema lock before `SCHEMA_LOCKED` (`55P03`); default 3 s. */
  readonly lockTimeoutMs?: number;
  /**
   * Default: the realtime of recomputed values (T459,
   * `RealtimeComputedHooks`: inactive without a bus attached to `db`), then
   * the `record.updated` events of automations (T509, `RecomputeEventHooks`).
   */
  readonly hooks?: ComputedRecomputeHooks;
  /** `AUTOMATION_MAX_RUNS_PER_BATCH` for the default event hook (ADR-26 §4); default 1 000. */
  readonly automationMaxRunsPerBatch?: number;
  /** Debounce of `computed.recompute`; default 2 s. */
  readonly debounceMs?: number;
}

/** One batch of `computed.recompute` ({@link ComputedRecomputeService.runQueuedBatch}). */
export type QueuedRecomputeBatch =
  /** Records were recomputed; more may be queued. */
  | {
      readonly status: 'more';
      readonly rows: number;
      /**
       * Rows still queued for the field after this batch (records, or the
       * records left of an every-record request): the progress of the job
       * (`computed.recomputing`, T459).
       */
      readonly remaining: number;
      readonly tableId: Id<'tbl'>;
      readonly result: ComputedRecomputeResult;
    }
  /** Nothing left for the field (`stateChanged`: it went back to `ready`). */
  | {
      readonly status: 'done';
      readonly tableId: Id<'tbl'> | null;
      readonly result: ComputedRecomputeResult;
    }
  /** The field is gone, no longer stored or in error: its queue was dropped. */
  | { readonly status: 'gone'; readonly result: ComputedRecomputeResult };

const EMPTY_RESULT: ComputedRecomputeResult = { recomputed: [], deferred: [], stateChanged: [] };

interface RunOptions {
  /** Rows recomputed at most in this transaction; past it a field goes to the job. */
  readonly budget: number;
  /** Fields recomputed whatever the budget (the job's batch). */
  readonly force?: ReadonlySet<string>;
  /** Causation and created records of the source, for rows left to the job (T509). */
  readonly origin?: QueuedOrigin;
}

/**
 * The one door of the incremental recompute of stored computed fields
 * (SPEC §5.9, BACKLOG T458 "Tính lại qua một cửa"): every source of a change
 * — record writes (cells, links of both sides, imports, bulk, trash,
 * restore, purge), schema changes that alter values (select option names,
 * zones, finished conversions, purged tables) — calls {@link enqueue} **in
 * the transaction of its write**. No other code updates a computed column
 * outside the backfill (T456).
 *
 * Rows are found per dependency kind (`AffectedResolver`) and recomputed
 * set-based, one `UPDATE data.t_x SET f_y = (<compiled>) … WHERE __id =
 * ANY($ids)` per field, in topological order (ties by `db_table_name`),
 * after locking the rows `ORDER BY __id FOR UPDATE`. Only values that
 * differ are written; readers of a changed value follow in the same order.
 * Up to `COMPUTED_SYNC_ROW_LIMIT` rows (all fields together) are done in
 * the transaction — the response of the write has the new values; a field
 * past it, or needing every row, is queued (`meta.computed_recompute_queue`)
 * for the debounced job `computed.recompute` and reads `compute_state =
 * recomputing` meanwhile (BACKLOG S4b #2). Recomputed values write no event,
 * audit entry, `__version` or `__updated_*` (ADR-23 §2); the hook
 * `afterRecompute` is where S5 and T459 plug in.
 */
export class ComputedRecomputeService {
  private readonly queue: ComputedRecomputeQueueRepository;
  private readonly fields: FieldsRepository;
  private readonly tables: TablesRepository;
  private readonly organizations: OrganizationsRepository;
  private readonly defaultTimeZone: string;
  private readonly syncRowLimit: number;
  private readonly lockTimeoutMs: number;
  private readonly debounceMs: number;
  private readonly hooks: ComputedRecomputeHooks;
  private readonly contexts = new WeakMap<Tx, Map<string, Promise<RecomputeContext | null>>>();
  private readonly lockedTables = new WeakMap<Tx, Set<string>>();

  constructor(
    private readonly db: Db,
    options: ComputedRecomputeServiceOptions = {},
  ) {
    this.queue = new ComputedRecomputeQueueRepository(db);
    this.fields = new FieldsRepository(db);
    this.tables = new TablesRepository(db);
    this.organizations = new OrganizationsRepository(db);
    this.defaultTimeZone = options.defaultTimeZone ?? 'UTC';
    this.syncRowLimit = options.syncRowLimit ?? COMPUTED_SYNC_ROW_LIMIT;
    this.lockTimeoutMs = options.lockTimeoutMs ?? DDL_LOCK_TIMEOUT_MS;
    this.debounceMs = options.debounceMs ?? COMPUTED_RECOMPUTE_DEBOUNCE_MS;
    this.hooks =
      options.hooks ??
      composeComputedRecomputeHooks(
        new RealtimeComputedHooks(db),
        new RecomputeEventHooks(db, {
          ...(options.automationMaxRunsPerBatch === undefined
            ? {}
            : { maxRunsPerBatch: options.automationMaxRunsPerBatch }),
        }),
      );
    if (!isValidTimeZone(this.defaultTimeZone)) {
      throw new RangeError('defaultTimeZone must be an IANA time zone');
    }
    if (!Number.isSafeInteger(this.syncRowLimit) || this.syncRowLimit < 0) {
      throw new RangeError('syncRowLimit must be a non-negative integer');
    }
  }

  /**
   * The rows `changes` touch on the state **before** the write, to hand to
   * {@link enqueue} with them: `cross_table` conditions on the changed
   * records (a lookup or FILTER keyed on a value the write changes selects
   * other rows before and after). Call it just before writing; cheap when
   * no such condition exists.
   */
  async before(
    tx: Tx,
    organizationId: Id<'org'>,
    changes: readonly ComputedChange[],
  ): Promise<ComputedBefore[]> {
    const out: ComputedBefore[] = [];
    for (const [baseId, items] of byBase(changes)) {
      const ctx = await this.context(tx, organizationId, baseId);
      if (ctx === null) continue;
      const rows = new AffectedRows();
      const resolver = new AffectedResolver(ctx, tx, rows, 'pre');
      for (const change of items) {
        const resolved = resolvedOf(ctx, change);
        if (resolved !== null) await resolver.change(resolved);
      }
      if (rows.size > 0) out.push({ baseId, rows: rows.snapshot() });
    }
    return out;
  }

  /**
   * Recomputes what `changes` touch, in `tx` (see the class comment).
   * Returns what was written and what went to the job.
   */
  async enqueue(tx: Tx, changes: ComputedChanges): Promise<ComputedRecomputeResult> {
    const scope = orgScope(changes.organizationId, tx);
    const bases = byBase(changes.changes);
    for (const before of changes.before ?? []) {
      if (!bases.has(before.baseId)) bases.set(before.baseId, []);
    }
    let budget = this.syncRowLimit;
    const results: ComputedRecomputeResult[] = [];
    const created = createdRecordsOf(changes.changes);
    const origin: QueuedOrigin = {
      ...(changes.source?.causation === undefined ? {} : { causation: changes.source.causation }),
      created,
    };
    for (const [baseId, items] of bases) {
      const ctx = await this.context(tx, changes.organizationId, baseId);
      if (ctx === null) continue;
      const pending = new AffectedRows();
      for (const before of changes.before ?? []) {
        if (before.baseId === baseId) pending.merge(before.rows);
      }
      const resolver = new AffectedResolver(ctx, tx, pending, 'post');
      for (const change of items) {
        const resolved = resolvedOf(ctx, change);
        if (resolved !== null) await resolver.change(resolved);
      }
      if (pending.size === 0) continue;
      const result = await this.run(tx, scope, ctx, pending, { budget, origin });
      budget = Math.max(
        0,
        budget - result.recomputed.reduce((sum, item) => sum + item.recordIds.length, 0),
      );
      results.push(result);
    }
    const result = mergeResults(results);
    if (result.recomputed.length > 0) {
      await this.hooks.afterRecompute(tx, {
        organizationId: changes.organizationId,
        recomputed: result.recomputed,
        ...(changes.source === undefined ? {} : { source: changes.source }),
        created,
      });
    }
    return result;
  }

  /**
   * The organization's zone changed (ADR-21): every stored computed field of
   * its bases that computes with dates is recomputed for every record, by
   * the job.
   */
  async enqueueTimeZoneChange(tx: Tx, organizationId: Id<'org'>): Promise<ComputedRecomputeResult> {
    const scope = orgScope(organizationId, tx);
    const { rows } = await sql<{ base_id: Id<'bse'> }>`
      SELECT DISTINCT t.base_id
        FROM meta.fields AS f
        JOIN meta.tables AS t ON t.id = f.table_id AND t.organization_id = f.organization_id
       WHERE f.organization_id = ${organizationId}
         AND f.type IN ('formula', 'lookup')
         AND f.compute_mode = 'stored'
         AND f.deleted_at IS NULL
         AND t.deleted_at IS NULL
       ORDER BY t.base_id
    `.execute(tx);
    this.contexts.delete(tx);
    const results: ComputedRecomputeResult[] = [];
    for (const { base_id: baseId } of rows) {
      const ctx = await this.context(tx, organizationId, baseId);
      if (ctx === null) continue;
      const pending = new AffectedRows();
      for (const fieldId of ctx.order) if (ctx.usesCalendar(fieldId)) pending.add(fieldId, 'all');
      if (pending.size > 0) results.push(await this.run(tx, scope, ctx, pending, { budget: 0 }));
    }
    return mergeResults(results);
  }

  /**
   * `fieldIds` (stored computed fields of `baseId`) are recomputed for every
   * record by the job (`compute_state = recomputing`, cells keep their
   * values meanwhile): a field that just became a formula/lookup through a
   * type conversion, whose values were computed while its sources could
   * still change (BACKLOG T463). Only rows whose value differs are written.
   */
  async enqueueFieldRecompute(
    tx: Tx,
    organizationId: Id<'org'>,
    baseId: Id<'bse'>,
    fieldIds: readonly Id<'fld'>[],
  ): Promise<ComputedRecomputeResult> {
    if (fieldIds.length === 0) return EMPTY_RESULT;
    this.contexts.delete(tx);
    const ctx = await this.context(tx, organizationId, baseId);
    if (ctx === null) return EMPTY_RESULT;
    const pending = new AffectedRows();
    for (const fieldId of fieldIds) if (ctx.order.includes(fieldId)) pending.add(fieldId, 'all');
    if (pending.size === 0) return EMPTY_RESULT;
    return this.run(tx, orgScope(organizationId, tx), ctx, pending, { budget: 0 });
  }

  /**
   * One batch of `computed.recompute` for `fieldId`, in `tx`: up to
   * `batchSize` queued records (or the next records of an every-record
   * request, by `__auto`, the trash included), recomputed with the fields
   * reading them (up to `batchSize` rows more; the rest is queued for their
   * own jobs). An empty queue puts the field back to `ready`.
   *
   * Every lock of the batch — its queue rows, the field's `compute_state`,
   * the schema lock, the rows it rewrites — waits at most `lockTimeoutMs`
   * (T474): a batch blocked by another transaction (an import writing the
   * same rows) fails with `55P03` and the job retries it, instead of
   * waiting until its `statement_timeout` and marking the field `TIMEOUT`.
   *
   * `jobId` (`job_…` of the run, the same on retries: T509) is the `batch.id`
   * of the `record.updated` events of every batch of the run; their
   * causation is the merged causation of the rows taken (depth unchanged).
   */
  async runQueuedBatch(
    tx: Tx,
    organizationId: Id<'org'>,
    fieldId: Id<'fld'>,
    batchSize: number = COMPUTED_RECOMPUTE_BATCH_SIZE,
    options: { readonly jobId?: Id<'job'> } = {},
  ): Promise<QueuedRecomputeBatch> {
    const scope = orgScope(organizationId, tx);
    await sql`SELECT set_config('lock_timeout', ${`${String(this.lockTimeoutMs)}ms`}, true)`.execute(
      tx,
    );
    const gone = async (): Promise<QueuedRecomputeBatch> => {
      await this.queue.clear(scope, fieldId);
      await this.queue.setComputeState(scope, [fieldId], 'recomputing', 'ready');
      return { status: 'gone', result: EMPTY_RESULT };
    };
    const field = await this.fields.getById(scope, fieldId);
    if (field === undefined) return gone();
    const table = await this.tables.getById(scope, field.table_id);
    if (table === undefined) return gone();
    const ctx = await this.context(tx, organizationId, table.base_id);
    if (ctx === null || ctx.rankOf(fieldId) === undefined) return gone();

    const batch = await this.queue.take(scope, fieldId, batchSize);
    if (batch.kind === 'empty') {
      if ((await this.queue.count(scope, fieldId)) > 0) {
        return { status: 'done', tableId: table.id, result: EMPTY_RESULT };
      }
      const changed = await this.queue.setComputeState(scope, [fieldId], 'recomputing', 'ready');
      return {
        status: 'done',
        tableId: table.id,
        result: {
          ...EMPTY_RESULT,
          stateChanged: changed.map((id) => ({
            baseId: table.base_id,
            tableId: table.id,
            fieldId: id,
          })),
        },
      };
    }
    let ids: string[];
    let remaining: number;
    if (batch.kind === 'every') {
      const data = sql.id(DATA_SCHEMA, assertDataTableName(table.db_table_name));
      const { rows } = await sql<{ id: string; auto: string }>`
        SELECT r.__id AS id, r.__auto::text AS auto FROM ${data} AS r
         WHERE r.__auto > ${batch.afterAuto.toString()}::bigint
         ORDER BY r.__auto
         LIMIT ${batchSize}
      `.execute(tx);
      ids = rows.map((row) => row.id);
      const last = rows.at(-1)?.auto;
      const after = last === undefined ? batch.afterAuto : BigInt(last);
      const done = rows.length < batchSize;
      await this.queue.advance(scope, fieldId, after, done);
      const { rows: left } = await sql<{ count: string }>`
        SELECT count(*)::text AS count FROM ${data} AS r
         WHERE r.__auto > ${after.toString()}::bigint
      `.execute(tx);
      remaining = done ? 0 : Number(left[0]?.count ?? 0);
      // Records queued one by one wait behind the every-record request.
      remaining += Math.max(0, (await this.queue.count(scope, fieldId)) - (done ? 0 : 1));
    } else {
      ids = [...batch.recordIds];
      remaining = await this.queue.count(scope, fieldId);
    }
    await this.queue.setComputeState(scope, [fieldId], 'ready', 'recomputing');
    if (ids.length === 0) {
      return { status: 'more', rows: 0, remaining, tableId: table.id, result: EMPTY_RESULT };
    }
    const pending = new AffectedRows();
    pending.add(fieldId, ids);
    const created: ReadonlySet<string> = batch.kind === 'records' ? batch.created : new Set();
    const source: RecomputeSource = {
      ...(options.jobId === undefined ? {} : { jobId: options.jobId }),
      ...(batch.causation === undefined ? {} : { causation: batch.causation }),
    };
    const result = await this.run(tx, scope, ctx, pending, {
      budget: batchSize,
      force: new Set([fieldId]),
      origin: { ...(batch.causation === undefined ? {} : { causation: batch.causation }), created },
    });
    if (result.recomputed.length > 0) {
      await this.hooks.afterRecompute(tx, {
        organizationId,
        recomputed: result.recomputed,
        source,
        created,
      });
    }
    return { status: 'more', rows: ids.length, remaining, tableId: table.id, result };
  }

  // -------------------------------------------------------------------------

  /** The base's context, loaded once per transaction. */
  private async context(
    tx: Tx,
    organizationId: Id<'org'>,
    baseId: Id<'bse'>,
  ): Promise<RecomputeContext | null> {
    let byBaseId = this.contexts.get(tx);
    if (byBaseId === undefined) {
      byBaseId = new Map();
      this.contexts.set(tx, byBaseId);
    }
    let loading = byBaseId.get(baseId);
    if (loading === undefined) {
      loading = (async () => {
        const scope = orgScope(organizationId);
        return RecomputeContext.load(
          this.db,
          scope,
          tx,
          baseId,
          await this.timeZoneOf(tx, organizationId),
        );
      })();
      byBaseId.set(baseId, loading);
    }
    return loading;
  }

  private async timeZoneOf(tx: Tx, organizationId: Id<'org'>): Promise<string> {
    const organization = await this.organizations.findById(organizationId, tx);
    const settings = organization?.settings;
    const configured =
      typeof settings === 'object' && settings !== null && !Array.isArray(settings)
        ? settings.timezone
        : undefined;
    return typeof configured === 'string' && isValidTimeZone(configured)
      ? configured
      : this.defaultTimeZone;
  }

  /**
   * Recomputes `pending` in order: each field's rows (within the budget)
   * are written, then the rows of its readers are found — on the old values
   * (before its `UPDATE`) and on the new ones. Fields past the budget, or
   * needing every row, go to the job.
   */
  private async run(
    tx: Tx,
    scope: OrgScope,
    ctx: RecomputeContext,
    pending: AffectedRows,
    options: RunOptions,
  ): Promise<ComputedRecomputeResult> {
    const recomputed: RecomputedValues[] = [];
    const deferred = new Map<Id<'fld'>, Set<string> | 'all'>();
    const defer = (fieldId: Id<'fld'>, rows: Set<string> | 'all') => {
      const current = deferred.get(fieldId);
      if (current === 'all' || rows === 'all') {
        deferred.set(fieldId, 'all');
        return;
      }
      const set = current ?? new Set<string>();
      for (const id of rows) set.add(id);
      deferred.set(fieldId, set);
    };
    let spent = 0;
    for (const fieldId of ctx.order) {
      const rows = pending.take(fieldId);
      if (rows === undefined || (rows !== 'all' && rows.size === 0)) continue;
      const forced = options.force?.has(fieldId) === true;
      if (rows === 'all' || (!forced && spent + rows.size > options.budget)) {
        defer(fieldId, rows);
        continue;
      }
      if (!forced) spent += rows.size;
      const field = ctx.field(fieldId);
      if (field === undefined) continue;
      const ids = [...rows].sort();
      const change: ResolvedChange = { tableId: field.table_id, ids, fieldIds: [fieldId] };
      // Readers keyed on this field's values: the rows that selected the old ones.
      await new AffectedResolver(ctx, tx, pending, 'pre').change(change);
      const { changed, before, after, trashed } = await this.write(tx, ctx, fieldId, ids);
      if (changed.length === 0) continue;
      recomputed.push({
        baseId: ctx.baseId,
        tableId: field.table_id,
        fieldId,
        recordIds: changed,
        before,
        after,
        trashed,
      });
      await new AffectedResolver(ctx, tx, pending, 'post').change({ ...change, ids: changed });
    }
    // Rows added to a field already passed (only with a cycle left by a restore).
    for (const [fieldId, rows] of pending.entries()) defer(fieldId, rows);
    const deferredFields = await this.deferToJob(scope, tx, ctx, deferred, options.origin);
    return { recomputed, ...deferredFields };
  }

  /**
   * Writes the recomputed values of `fieldId` for `ids`: the table's schema
   * lock (shared), the rows locked in `__id` order, then one `UPDATE` of the
   * rows whose value differs. Returns their ids, their values before and
   * after the update (`to_jsonb`: realtime images, T459; event `changes`,
   * T509) and those in the trash.
   */
  private async write(
    tx: Tx,
    ctx: RecomputeContext,
    fieldId: Id<'fld'>,
    ids: readonly string[],
  ): Promise<{
    changed: Id<'rec'>[];
    before: Map<Id<'rec'>, unknown>;
    after: Map<Id<'rec'>, unknown>;
    trashed: Set<Id<'rec'>>;
  }> {
    const before = new Map<Id<'rec'>, unknown>();
    const after = new Map<Id<'rec'>, unknown>();
    const trashed = new Set<Id<'rec'>>();
    const nothing = { changed: [], before, after, trashed };
    const field = ctx.field(fieldId);
    const table = field === undefined ? undefined : ctx.table(field.table_id);
    if (field?.db_column_name == null || table === undefined) return nothing;
    const value = ctx.model.storedValue(field, ROW_ALIAS);
    if (value === null) return nothing;
    await this.lockTable(tx, table.id);
    const data = sql.id(DATA_SCHEMA, assertDataTableName(table.db_table_name));
    const column = assertFieldColumnName(field.db_column_name);
    const changed: Id<'rec'>[] = [];
    for (let index = 0; index < ids.length; index += COMPUTED_RECOMPUTE_BATCH_SIZE) {
      const batch = ids.slice(index, index + COMPUTED_RECOMPUTE_BATCH_SIZE);
      // Deterministic lock order across tables and writers (SPEC §5.9).
      await sql`
        SELECT l.__id FROM ${data} AS l
         WHERE l.__id = ANY(${sql.val(batch)}::text[])
         ORDER BY l.__id
           FOR UPDATE
      `.execute(tx);
      const { rows } = await sql<{ id: Id<'rec'>; old: unknown; new: unknown; trashed: boolean }>`
        WITH v AS (
          SELECT ${sql.id(ROW_ALIAS, '__id')} AS id, ${value} AS val,
                 to_jsonb(${sql.id(ROW_ALIAS, column)}) AS old
            FROM ${data} AS ${sql.id(ROW_ALIAS)}
           WHERE ${sql.id(ROW_ALIAS, '__id')} = ANY(${sql.val(batch)}::text[])
        )
        UPDATE ${data} AS ${sql.id(TARGET_ALIAS)}
           SET ${sql.id(column)} = v.val
          FROM v
         WHERE ${sql.id(TARGET_ALIAS, '__id')} = v.id
           AND ${sql.id(TARGET_ALIAS, column)} IS DISTINCT FROM v.val
        RETURNING ${sql.id(TARGET_ALIAS, '__id')} AS id, v.old AS old,
                  to_jsonb(${sql.id(TARGET_ALIAS, column)}) AS new,
                  ${sql.id(TARGET_ALIAS, '__deleted_at')} IS NOT NULL AS trashed
      `.execute(tx);
      for (const row of rows) {
        changed.push(row.id);
        before.set(row.id, row.old);
        after.set(row.id, row.new);
        if (row.trashed) trashed.add(row.id);
      }
    }
    return { changed: changed.sort(), before, after, trashed };
  }

  /** The table's schema advisory lock in shared mode (like a record write), once per transaction. */
  private async lockTable(tx: Tx, tableId: Id<'tbl'>): Promise<void> {
    let locked = this.lockedTables.get(tx);
    if (locked === undefined) {
      locked = new Set();
      this.lockedTables.set(tx, locked);
    }
    if (locked.has(tableId)) return;
    const { rows } = await sql<{ previous: string }>`
      SELECT current_setting('lock_timeout') AS previous,
             set_config('lock_timeout', ${`${String(this.lockTimeoutMs)}ms`}, true)
    `.execute(tx);
    await sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${schemaLockKey(tableId)}, 0))`.execute(
      tx,
    );
    await sql`SELECT set_config('lock_timeout', ${rows[0]?.previous ?? '0'}, true)`.execute(tx);
    locked.add(tableId);
  }

  /** Queues deferred rows, marks the fields `recomputing` and schedules their debounced jobs. */
  private async deferToJob(
    scope: OrgScope,
    tx: Tx,
    ctx: RecomputeContext,
    deferred: ReadonlyMap<Id<'fld'>, Set<string> | 'all'>,
    origin: QueuedOrigin = {},
  ): Promise<Pick<ComputedRecomputeResult, 'deferred' | 'stateChanged'>> {
    if (deferred.size === 0) return { deferred: [], stateChanged: [] };
    const out: DeferredField[] = [];
    for (const [fieldId, rows] of deferred) {
      const field = ctx.field(fieldId);
      if (field === undefined) continue;
      await this.queue.add(scope, fieldId, rows === 'all' ? 'all' : [...rows], origin);
      await enqueue(
        tx,
        'computed.recompute',
        { organization_id: scope.organizationId, field_id: fieldId },
        {
          jobKey: `computed.recompute:${fieldId}`,
          jobKeyMode: 'preserve_run_at',
          runAt: new Date(Date.now() + this.debounceMs),
          maxAttempts: 5,
        },
      );
      out.push({
        baseId: ctx.baseId,
        tableId: field.table_id,
        fieldId,
        rows: rows === 'all' ? 'all' : rows.size,
      });
    }
    const changed = new Set<string>(
      await this.queue.setComputeState(
        scope,
        out.map((item) => item.fieldId),
        'ready',
        'recomputing',
      ),
    );
    return {
      deferred: out,
      stateChanged: out
        .filter((item) => changed.has(item.fieldId))
        .map(({ baseId, tableId, fieldId }) => ({ baseId, tableId, fieldId })),
    };
  }
}

function byBase(changes: readonly ComputedChange[]): Map<Id<'bse'>, ComputedChange[]> {
  const out = new Map<Id<'bse'>, ComputedChange[]>();
  for (const change of changes) {
    const list = out.get(change.baseId) ?? [];
    list.push(change);
    out.set(change.baseId, list);
  }
  return out;
}

/** A source change as the resolver walks it (`null`: nothing to recompute). */
function resolvedOf(ctx: RecomputeContext, change: ComputedChange): ResolvedChange | null {
  // Fields of a table gone (trash, purge) still have readers to recompute.
  if (change.kind === 'fields') {
    return { tableId: change.tableId, ids: 'all', fieldIds: change.fieldIds };
  }
  if (ctx.table(change.tableId) === undefined) return null;
  switch (change.event) {
    case 'purged':
      // Records of the trash: already out of every cell, FILTER and lookup.
      return null;
    case 'updated':
      return {
        tableId: change.tableId,
        ids: change.recordIds,
        fieldIds: [...new Set([...(change.fieldIds ?? []), ...ctx.updateStampsOf(change.tableId)])],
      };
    default:
      return { tableId: change.tableId, ids: change.recordIds, fieldIds: [], event: change.event };
  }
}

/** Records a change creates or restores: their computed values are first values (T509). */
function createdRecordsOf(changes: readonly ComputedChange[]): Set<string> {
  const out = new Set<string>();
  for (const change of changes) {
    if (change.kind !== 'records') continue;
    if (change.event !== 'created' && change.event !== 'restored') continue;
    for (const id of change.recordIds) out.add(id);
  }
  return out;
}

function mergeResults(results: readonly ComputedRecomputeResult[]): ComputedRecomputeResult {
  if (results.length === 1) return results[0] as ComputedRecomputeResult;
  return {
    recomputed: results.flatMap((result) => result.recomputed),
    deferred: results.flatMap((result) => result.deferred),
    stateChanged: results.flatMap((result) => result.stateChanged),
  };
}
