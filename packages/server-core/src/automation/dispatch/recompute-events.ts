import { automationDefinitionSchema, newId, type EventBatch, type Id } from '@cellhive/contracts';

import { OrganizationsRepository } from '../../db/repositories/organizations.repository.js';
import { orgScope, type OrgScope } from '../../db/repository.js';
import { EventWriter } from '../../events/event-writer.js';
import { AutomationRunsRepository } from '../repository/automation-runs.repository.js';
import { AutomationsRepository } from '../repository/automations.repository.js';
import { AutomationBatchCountersRepository } from '../repository/batch-counters.repository.js';

import { isBulkEvent } from './event-match.js';
import { automationMaxDepthOf } from './loop-guard.js';
import { conditionFieldIdsOf } from './matches/transition.js';

import type {
  AfterRecomputeInput,
  ComputedRecomputeHooks,
} from '../../computed/recompute/changes.js';
import type { Db, Tx } from '../../db/create-db.js';
import type { JsonValue } from '../../db/schema.js';
import type { EventInput } from '../../events/event.js';

/** Default of `AUTOMATION_MAX_RUNS_PER_BATCH` (ADR-26 §4; same as the dispatcher's). */
const DEFAULT_MAX_RUNS_PER_BATCH = 1_000;

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const JOB_ID_LENGTH = 16;

/**
 * `batch.id` of the events of one `computed.recompute` run (T509,
 * S4b-decisions-followup §3.4): `job_` + the graphile-worker job id in
 * base62, so a retry of the same job (same row) keeps it and every batch,
 * field and table of the run share it.
 */
export function recomputeJobBatchId(jobId: string | number | bigint): Id<'job'> {
  let value = BigInt(jobId);
  if (value < 0n) throw new RangeError('job id must be non-negative');
  let digits = '';
  do {
    digits = (BASE62[Number(value % 62n)] ?? '0') + digits;
    value /= 62n;
  } while (value > 0n);
  if (digits.length > JOB_ID_LENGTH) throw new RangeError('job id too large');
  return `job_${digits.padStart(JOB_ID_LENGTH, '0')}`;
}

export interface RecomputeEventHooksOptions {
  /** `AUTOMATION_MAX_RUNS_PER_BATCH` (ADR-26 §4); default 1 000. */
  readonly maxRunsPerBatch?: number;
}

/** A listening automation, as far as this hook needs it. */
interface Listener {
  readonly id: Id<'aut'>;
  readonly watch: ReadonlySet<string>;
  readonly conditional: boolean;
}

type Changes = Map<string, { from: JsonValue; to: JsonValue }>;

interface TableChanges {
  readonly baseId: Id<'bse'>;
  readonly records: Map<string, Changes>;
}

/** `to_jsonb` of a stored computed cell as its storage-form value (empty list → `null`). */
function jsonOf(raw: unknown): JsonValue {
  if (raw === undefined || raw === null) return null;
  if (Array.isArray(raw) && raw.length === 0) return null;
  return raw as JsonValue;
}

/**
 * The `record.updated` events of recomputed stored formula/lookup values
 * (BACKLOG T509, `docs/reviews/S4b-decisions-followup.md` §3.4, ADR-26),
 * written by `ComputedRecomputeService.afterRecompute` in the transaction
 * of the recompute:
 *
 * - only for records whose value really changed (the recompute writes only
 *   those), never for the first values of records just created or restored
 *   (`created`), nor for records in the trash; `changes` holds only the
 *   recomputed fields (storage form), `actor` is `system`, `record_version`
 *   is left out (`__version` does not change), no audit entry (ADR-23 §2);
 * - only when an enabled `record.updated` automation of the table watches
 *   one of the changed fields (`watch_fields`) — or a `record.matches`
 *   automation names one in its condition (T510) —, is not stopped by the loop
 *   guard (depth, own chain) and does not skip bulk events that are bulk;
 *   only records with a watched change get an event;
 * - in a write's transaction: `batch`, `causation` and `via` of that write,
 *   plus `via.computed_recompute`, `job_id: null`;
 * - in a `computed.recompute` run: `batch.id = job_…` of the run (always a
 *   bulk event, so one trigger unit), the merged causation of the queue
 *   rows (depth unchanged), `via = { computed_recompute: true, job_id }`.
 *   Past the fan-out cap an automation gets no more events, only `skipped`
 *   counts (`meta.automation_batch_counters`): without a condition after
 *   `AUTOMATION_MAX_RUNS_PER_BATCH` + 1 events (the last one makes the
 *   `skipped` run of `events.dispatch`), with a condition once that run
 *   exists (only `events.dispatch` knows which events match).
 */
export class RecomputeEventHooks implements ComputedRecomputeHooks {
  private readonly automations: AutomationsRepository;
  private readonly counters: AutomationBatchCountersRepository;
  private readonly runs: AutomationRunsRepository;
  private readonly organizations: OrganizationsRepository;
  private readonly events = new EventWriter();
  private readonly maxRunsPerBatch: number;

  constructor(db: Db, options: RecomputeEventHooksOptions = {}) {
    this.automations = new AutomationsRepository(db);
    this.counters = new AutomationBatchCountersRepository(db);
    this.runs = new AutomationRunsRepository(db);
    this.organizations = new OrganizationsRepository(db);
    this.maxRunsPerBatch = options.maxRunsPerBatch ?? DEFAULT_MAX_RUNS_PER_BATCH;
    if (!Number.isSafeInteger(this.maxRunsPerBatch) || this.maxRunsPerBatch < 1) {
      throw new RangeError('maxRunsPerBatch must be a positive integer');
    }
  }

  async afterRecompute(tx: Tx, input: AfterRecomputeInput): Promise<void> {
    const byTable = changesByTable(input);
    const source = input.source ?? {};
    // Records the write itself changed: their recomputed values join its own event.
    const fold = source.fold;
    if (fold !== undefined && source.jobId === undefined) {
      for (const [tableId, table] of byTable) {
        for (const [recordId, changes] of table.records) {
          if (
            fold({ tableId: tableId as Id<'tbl'>, recordId, changes: Object.fromEntries(changes) })
          ) {
            table.records.delete(recordId);
          }
        }
        if (table.records.size === 0) byTable.delete(tableId);
      }
    }
    if (byTable.size === 0) return;
    const scope = orgScope(input.organizationId, tx);
    const jobId = source.jobId;
    const size = [...byTable.values()].reduce((sum, table) => sum + table.records.size, 0);
    const batch: EventBatch =
      jobId !== undefined ? { id: jobId, size } : (source.batch ?? { id: newId('job'), size });
    const via = { ...source.via, computed_recompute: true as const, job_id: jobId ?? null };
    const bulk = isBulkEvent({ batch, via });
    const causation = source.causation;
    let maxDepth: number | undefined;

    for (const [tableId, table] of byTable) {
      const changedFields = new Set<string>();
      for (const changes of table.records.values())
        for (const id of changes.keys()) changedFields.add(id);
      let listeners = await this.listeners(scope, tableId as Id<'tbl'>, changedFields, bulk);
      if (causation !== undefined) {
        listeners = listeners.filter((item) => !causation.automation_chain.includes(item.id));
      }
      if (listeners.length === 0) continue;
      if (causation !== undefined) {
        if (maxDepth === undefined) {
          const organization = await this.organizations.findById(input.organizationId, tx);
          maxDepth = automationMaxDepthOf(organization?.settings ?? null);
        }
        if (causation.depth >= maxDepth) continue;
      }
      const remaining = new Map<Id<'aut'>, number>();
      if (jobId !== undefined) {
        for (const listener of listeners) {
          remaining.set(listener.id, await this.remaining(scope, listener, jobId));
        }
      }
      const emitted = new Map<Id<'aut'>, number>();
      const skipped = new Map<Id<'aut'>, number>();
      const events: EventInput[] = [];
      for (const recordId of [...table.records.keys()].sort()) {
        const changes = table.records.get(recordId) as Changes;
        const relevant = listeners.filter((listener) =>
          [...changes.keys()].some((fieldId) => listener.watch.has(fieldId)),
        );
        if (relevant.length === 0) continue;
        const wanted =
          jobId === undefined || relevant.some((listener) => (remaining.get(listener.id) ?? 0) > 0);
        for (const listener of relevant) {
          const counts = wanted ? emitted : skipped;
          counts.set(listener.id, (counts.get(listener.id) ?? 0) + 1);
          if (wanted && remaining.has(listener.id)) {
            remaining.set(listener.id, (remaining.get(listener.id) ?? 0) - 1);
          }
        }
        if (!wanted) continue;
        events.push({
          type: 'record.updated',
          organizationId: input.organizationId,
          entityId: recordId,
          actor: { type: 'system', id: null },
          baseId: table.baseId,
          tableId: tableId as Id<'tbl'>,
          changes: Object.fromEntries(changes),
          ...(causation === undefined ? {} : { causation }),
          batch,
          via,
        });
      }
      if (events.length > 0) await this.events.writeMany(tx, events);
      if (jobId !== undefined) {
        for (const listener of listeners) {
          await this.count(
            scope,
            listener.id,
            jobId,
            emitted.get(listener.id) ?? 0,
            skipped.get(listener.id) ?? 0,
          );
        }
      }
    }
  }

  /**
   * Enabled `record.updated` automations of the table watching one of
   * `changedFields`, and `record.matches` ones whose condition names one
   * (a bulk event drops those with `skip_bulk`).
   */
  private async listeners(
    scope: OrgScope,
    tableId: Id<'tbl'>,
    changedFields: ReadonlySet<string>,
    bulk: boolean,
  ): Promise<Listener[]> {
    const rows = [
      ...(await this.automations.listEnabledForTrigger(scope, 'record.updated', tableId)),
      ...(await this.automations.listEnabledForTrigger(scope, 'record.matches', tableId)),
    ];
    const out: Listener[] = [];
    for (const row of rows) {
      const parsed = automationDefinitionSchema.safeParse(row.definition);
      if (!parsed.success) continue;
      const { trigger, condition } = parsed.data;
      if (trigger.type !== 'record.updated' && trigger.type !== 'record.matches') continue;
      if (trigger.table_id !== tableId) continue;
      if (bulk && trigger.skip_bulk) continue;
      // `record.matches` (T510) watches the fields of its condition; whether the
      // record enters it is only known to `events.dispatch`.
      const watch =
        trigger.type === 'record.updated'
          ? new Set<string>(trigger.watch_fields)
          : conditionFieldIdsOf(trigger.condition);
      if (![...changedFields].some((fieldId) => watch.has(fieldId))) continue;
      out.push({
        id: row.id,
        watch,
        conditional: condition !== null || trigger.type === 'record.matches',
      });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Events the automation may still get from the job run (`Infinity`: no cap known yet). */
  private async remaining(scope: OrgScope, listener: Listener, jobId: Id<'job'>): Promise<number> {
    const counter = await this.counters.get(scope, listener.id, jobId);
    if (!listener.conditional) return this.maxRunsPerBatch + 1 - (counter?.events ?? 0);
    if (counter === undefined || counter.runs < this.maxRunsPerBatch) return Infinity;
    const standIn = await this.runs.findFanoutRun(scope, listener.id, jobId);
    return standIn === undefined ? Infinity : 0;
  }

  /** Counts the job run's events and skipped records; keeps the `skipped` run's count current. */
  private async count(
    scope: OrgScope,
    automationId: Id<'aut'>,
    jobId: Id<'job'>,
    events: number,
    skipped: number,
  ): Promise<void> {
    if (events === 0 && skipped === 0) return;
    const counter = await this.counters.addRecomputeEvents(scope, automationId, jobId, {
      events,
      skipped,
    });
    if (skipped === 0 || counter === undefined) return;
    const standIn = await this.runs.findFanoutRun(scope, automationId, jobId);
    if (standIn !== undefined) await this.runs.setFanoutSkipped(scope, standIn.id, counter.skipped);
  }
}

/**
 * Changed values by table and record, without first values (`created`),
 * records in the trash and values equal once in storage form; a field
 * recomputed twice keeps its first `from` and last `to`.
 */
function changesByTable(input: AfterRecomputeInput): Map<string, TableChanges> {
  const created = input.created ?? new Set<string>();
  const out = new Map<string, TableChanges>();
  for (const item of input.recomputed) {
    if (item.after === undefined) continue;
    for (const recordId of item.recordIds) {
      if (created.has(recordId) || item.trashed?.has(recordId) === true) continue;
      const from = jsonOf(item.before?.get(recordId));
      const to = jsonOf(item.after.get(recordId));
      let table = out.get(item.tableId);
      if (table === undefined) {
        table = { baseId: item.baseId, records: new Map() };
        out.set(item.tableId, table);
      }
      let changes = table.records.get(recordId);
      if (changes === undefined) {
        changes = new Map();
        table.records.set(recordId, changes);
      }
      const previous = changes.get(item.fieldId);
      changes.set(item.fieldId, { from: previous === undefined ? from : previous.from, to });
    }
  }
  // Drop fields back to their old value and records left without changes.
  for (const table of out.values()) {
    for (const [recordId, changes] of table.records) {
      for (const [fieldId, change] of changes) {
        if (JSON.stringify(change.from) === JSON.stringify(change.to)) changes.delete(fieldId);
      }
      if (changes.size === 0) table.records.delete(recordId);
    }
  }
  for (const [tableId, table] of out) if (table.records.size === 0) out.delete(tableId);
  return out;
}
