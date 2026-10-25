import { sql, type RawBuilder, type SqlBool } from 'kysely';

import {
  afterCursor,
  cursorTimestamp,
  pageWithCursor,
  type KeysetCursor,
} from '../../db/cursor.js';
import { jsonb } from '../../db/json.js';
import {
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../../db/repository.js';

import type { Db } from '../../db/create-db.js';
import type { AutomationRunRow, AutomationRunStatusKind, JsonObject } from '../../db/schema.js';
import type { Id } from '@cellhive/contracts';

/** How a running segment of a run ends (BACKLOG T505). */
export interface EndSegmentInput {
  /**
   * `queued`: a retry is scheduled; `waiting`: inside a `delay` (T506), the
   * resume job is scheduled; else the final status.
   */
  readonly status: Extract<
    AutomationRunStatusKind,
    'queued' | 'waiting' | 'succeeded' | 'failed' | 'skipped' | 'cancelled'
  >;
  /** Engine clock: the running time added to `active_ms` ends here. */
  readonly at: Date;
  readonly error?: JsonObject | null;
}

export interface InsertRunInput {
  readonly id: Id<'run'>;
  readonly automationId: Id<'aut'>;
  readonly automationVersion: number;
  readonly triggerEventId: Id<'evt'> | null;
  readonly triggerUnit: string;
  readonly status: Extract<AutomationRunStatusKind, 'queued' | 'skipped'>;
  readonly depth: number;
  readonly input: JsonObject;
  readonly error?: JsonObject | null;
  /** A re-run (T518): the run it repeats and who asked. */
  readonly rerun?: { readonly of: Id<'run'>; readonly by: Id<'usr'> };
}

/** Filters of the run log (BACKLOG T518), combined with AND. */
export interface RunLogFilter {
  readonly baseId: Id<'bse'>;
  readonly automationId?: Id<'aut'>;
  /**
   * Only automations triggered on these tables (a manager who is not base
   * admin, ADR-25 §3); `undefined` = every automation of the base.
   */
  readonly triggerTableIds?: readonly Id<'tbl'>[];
  readonly statuses?: readonly AutomationRunStatusKind[];
  /** Inclusive lower bound of `created_at`. */
  readonly from?: Date;
  /** Exclusive upper bound of `created_at`. */
  readonly to?: Date;
  /** Only runs started by this event (`trigger_event_id`, T616). */
  readonly eventId?: Id<'evt'>;
}

/** A run of the run log, with the name of who re-ran it. */
export interface RunLogRow extends AutomationRunRow {
  readonly rerun_by_name: string | null;
  /** `created_at` with microseconds, for the keyset cursor. */
  readonly cursor_at: string;
}

/** Latest run and run counts of one automation (the automation list, T518). */
export interface AutomationRunStats {
  readonly lastRun: {
    readonly id: Id<'run'>;
    readonly status: AutomationRunStatusKind;
    readonly errorCode: string | null;
    readonly createdAt: Date;
    readonly finishedAt: Date | null;
  } | null;
  readonly counts24h: Readonly<Record<AutomationRunStatusKind, number>>;
  readonly counts7d: Readonly<Record<AutomationRunStatusKind, number>>;
}

const RUN_STATUSES: readonly AutomationRunStatusKind[] = [
  'queued',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
];

function zeroCounts(): Record<AutomationRunStatusKind, number> {
  return Object.fromEntries(RUN_STATUSES.map((status) => [status, 0])) as Record<
    AutomationRunStatusKind,
    number
  >;
}

/** Trigger units of one automation over a time window (ADR-26 §5). */
export interface RecentUnits {
  /** Distinct `trigger_unit` values of the runs created in the window. */
  readonly distinct: number;
  /** Whether `unit` is one of them. */
  readonly includesUnit: boolean;
}

/** Outcome of one trigger unit, latest unit first (ADR-26 §5). */
export interface UnitOutcome {
  readonly unit: string;
  /** At least one run `failed` and none `succeeded`. */
  readonly failed: boolean;
}

/** Error code of the run that stands for the runs a batch did not get (ADR-26 §4). */
export const BATCH_FANOUT_EXCEEDED = 'batch_fanout_exceeded';

/**
 * `meta.automation_runs` (SPEC §5.10, §11.1): what `events.dispatch`
 * (BACKLOG T503) needs — create runs once per (automation, event), the
 * fan-out stand-in run, and the trigger-unit counts of the circuit breaker.
 * Every query is scoped by `organization_id`. The run engine (T505) locks,
 * starts and ends runs; the run log (T518) adds its own methods.
 */
export class AutomationRunsRepository
  extends TenantRepository<'automation_runs'>
  implements TenantRepositoryContract<AutomationRunsRepository>
{
  constructor(db: Db) {
    super(db, 'automation_runs');
  }

  /**
   * Inserts a run; `undefined` when the automation already has a run for
   * this event (`UNIQUE (automation_id, trigger_event_id)`: a redelivered
   * event creates nothing).
   */
  async insert(scope: OrgScope, input: InsertRunInput): Promise<AutomationRunRow | undefined> {
    return this.executor(scope)
      .insertInto('meta.automation_runs')
      .values({
        id: input.id,
        organization_id: scope.organizationId,
        automation_id: input.automationId,
        automation_version: input.automationVersion,
        trigger_event_id: input.triggerEventId,
        trigger_unit: input.triggerUnit,
        status: input.status,
        depth: input.depth,
        input: jsonb(input.input),
        ...(input.error == null ? {} : { error: jsonb(input.error) }),
        ...(input.status === 'skipped' ? { finished_at: sql<Date>`now()` } : {}),
        ...(input.rerun === undefined
          ? {}
          : { rerun_of_run_id: input.rerun.of, rerun_by_user_id: input.rerun.by }),
      })
      .onConflict((oc) => oc.columns(['automation_id', 'trigger_event_id']).doNothing())
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * Inserts a `queued` run of a time trigger (BACKLOG T508), deduplicated by
   * `trigger_key` (`automation_id:fired_at`,
   * `automation_id:record_id:<value>`); `undefined` when the automation
   * already has a run with that key.
   */
  async insertKeyed(
    scope: OrgScope,
    input: Omit<InsertRunInput, 'triggerEventId' | 'status' | 'error'> & {
      readonly triggerKey: string;
    },
  ): Promise<AutomationRunRow | undefined> {
    return this.executor(scope)
      .insertInto('meta.automation_runs')
      .values({
        id: input.id,
        organization_id: scope.organizationId,
        automation_id: input.automationId,
        automation_version: input.automationVersion,
        trigger_event_id: null,
        trigger_key: input.triggerKey,
        trigger_unit: input.triggerUnit,
        status: 'queued',
        depth: input.depth,
        input: jsonb(input.input),
      })
      .onConflict((oc) => oc.columns(['automation_id', 'trigger_key']).doNothing())
      .returningAll()
      .executeTakeFirst();
  }

  /** The run of an automation for an event, if any. */
  async findByEvent(
    scope: OrgScope,
    automationId: Id<'aut'>,
    eventId: Id<'evt'>,
  ): Promise<AutomationRunRow | undefined> {
    return this.executor(scope)
      .selectFrom('meta.automation_runs')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('automation_id', '=', automationId)
      .where('trigger_event_id', '=', eventId)
      .executeTakeFirst();
  }

  /** The `skipped` stand-in run of a batch that went over the fan-out cap (ADR-26 §4). */
  async findFanoutRun(
    scope: OrgScope,
    automationId: Id<'aut'>,
    batchId: string,
  ): Promise<AutomationRunRow | undefined> {
    return this.executor(scope)
      .selectFrom('meta.automation_runs')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('automation_id', '=', automationId)
      .where('status', '=', 'skipped')
      .where(sql<string>`error->>'code'`, '=', BATCH_FANOUT_EXCEEDED)
      .where(sql<string>`error->>'batch_id'`, '=', batchId)
      .orderBy('created_at')
      .limit(1)
      .executeTakeFirst();
  }

  /** Sets `error.skipped` of a stand-in run (the records of the batch that got no run). */
  async setFanoutSkipped(scope: OrgScope, runId: Id<'run'>, skipped: number): Promise<void> {
    await this.executor(scope)
      .updateTable('meta.automation_runs')
      .set({ error: sql`jsonb_set(error, '{skipped}', to_jsonb(${skipped}::int))` })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', runId)
      .execute();
  }

  /**
   * Distinct trigger units of the runs an automation got in the last
   * `windowSeconds` by the database clock (the circuit breaker's
   * per-minute window, ADR-26 §5), and whether `unit` is one of them.
   */
  async recentUnits(
    scope: OrgScope,
    automationId: Id<'aut'>,
    windowSeconds: number,
    unit: string,
  ): Promise<RecentUnits> {
    const row = await this.executor(scope)
      .selectFrom('meta.automation_runs')
      .select([
        sql<number>`count(DISTINCT trigger_unit)::int`.as('distinct'),
        sql<boolean>`coalesce(bool_or(trigger_unit = ${unit}), false)`.as('includes_unit'),
      ])
      .where('organization_id', '=', scope.organizationId)
      .where('automation_id', '=', automationId)
      .where('created_at', '>=', sql<Date>`now() - make_interval(secs => ${windowSeconds})`)
      .executeTakeFirstOrThrow();
    return { distinct: row.distinct, includesUnit: row.includes_unit };
  }

  /**
   * Outcomes of the latest `limit` trigger units of an automation (by their
   * latest run), looking at its latest `scan` runs. A unit with a run still
   * pending counts as not failed.
   */
  async latestUnitOutcomes(
    scope: OrgScope,
    automationId: Id<'aut'>,
    limit: number,
    scan = limit * 20,
  ): Promise<UnitOutcome[]> {
    const { rows } = await sql<{ unit: string; failed: boolean }>`
      SELECT r.trigger_unit AS unit,
             bool_or(r.status = 'failed') AND NOT bool_or(r.status = 'succeeded') AS failed
        FROM (SELECT trigger_unit, status, created_at
                FROM meta.automation_runs
               WHERE organization_id = ${scope.organizationId}
                 AND automation_id = ${automationId}
               ORDER BY created_at DESC
               LIMIT ${scan}) AS r
       GROUP BY r.trigger_unit
       ORDER BY max(r.created_at) DESC
       LIMIT ${limit}
    `.execute(this.executor(scope));
    return rows;
  }

  // --- Run engine (BACKLOG T505) ---------------------------------------------------

  async get(scope: OrgScope, runId: Id<'run'>): Promise<AutomationRunRow | undefined> {
    return this.executor(scope)
      .selectFrom('meta.automation_runs')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', runId)
      .executeTakeFirst();
  }

  /** The run, locked until the transaction ends (one engine job at a time per run). */
  async lockById(scope: OrgScope, runId: Id<'run'>): Promise<AutomationRunRow | undefined> {
    return this.executor(scope)
      .selectFrom('meta.automation_runs')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', runId)
      .forUpdate()
      .executeTakeFirst();
  }

  /**
   * Runs of the organization holding a slot of `AUTOMATION_MAX_RUNNING_PER_ORG`
   * (ADR-18): `running` for less than `staleAfterMs` in their current
   * segment by the database clock — a run whose worker died stops holding
   * one once it would have timed out anyway.
   */
  async countRunning(scope: OrgScope, staleAfterMs: number): Promise<number> {
    const row = await this.executor(scope)
      .selectFrom('meta.automation_runs')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('organization_id', '=', scope.organizationId)
      .where('status', '=', 'running')
      .where('running_since', '>', sql<Date>`now() - make_interval(secs => ${staleAfterMs / 1000})`)
      .executeTakeFirstOrThrow();
    return row.n;
  }

  /** `running` from `at` (a new segment); `started_at` keeps the first start. */
  async startSegment(scope: OrgScope, runId: Id<'run'>, at: Date): Promise<AutomationRunRow> {
    return this.executor(scope)
      .updateTable('meta.automation_runs')
      .set({
        status: 'running',
        started_at: sql<Date>`coalesce(started_at, ${at})`,
        running_since: at,
        finished_at: null,
      })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', runId)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * Ends the current segment: its running time (from `running_since` to
   * `at`) is added to `active_ms`; a final status sets `finished_at`
   * (`queued` and `waiting` are not final).
   */
  async endSegment(scope: OrgScope, runId: Id<'run'>, input: EndSegmentInput): Promise<void> {
    const elapsed = sql<number>`coalesce(greatest(0, floor(extract(epoch FROM (${input.at}::timestamptz - running_since)) * 1000)), 0)::bigint`;
    await this.executor(scope)
      .updateTable('meta.automation_runs')
      .set({
        status: input.status,
        active_ms: sql<number>`active_ms + ${elapsed}`,
        running_since: null,
        ...(input.status === 'queued' || input.status === 'waiting'
          ? {}
          : { finished_at: input.at }),
        ...(input.error === undefined
          ? {}
          : { error: input.error === null ? null : jsonb(input.error) }),
      })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', runId)
      .execute();
  }

  // --- Run log (BACKLOG T518) ----------------------------------------------------------

  /**
   * Runs of live automations of a base, newest first (`created_at DESC,
   * id DESC`), cursor-paginated. Runs of deleted automations are left out
   * (their routes are `404`).
   */
  async listPage(
    scope: OrgScope,
    filter: RunLogFilter,
    page: { readonly cursor: KeysetCursor | null; readonly limit: number },
  ): Promise<{ items: RunLogRow[]; nextCursor: string | null }> {
    const conditions: RawBuilder<SqlBool>[] = [
      sql<SqlBool>`r.organization_id = ${scope.organizationId}`,
      sql<SqlBool>`a.base_id = ${filter.baseId}`,
      sql<SqlBool>`a.deleted_at IS NULL`,
    ];
    if (filter.automationId !== undefined) {
      conditions.push(sql<SqlBool>`r.automation_id = ${filter.automationId}`);
    }
    if (filter.triggerTableIds !== undefined) {
      conditions.push(
        sql<SqlBool>`a.trigger_table_id = ANY(${sql.val([...filter.triggerTableIds])}::text[])`,
      );
    }
    if (filter.statuses !== undefined && filter.statuses.length > 0) {
      conditions.push(sql<SqlBool>`r.status = ANY(${sql.val([...filter.statuses])}::text[])`);
    }
    if (filter.from !== undefined) conditions.push(sql<SqlBool>`r.created_at >= ${filter.from}`);
    if (filter.to !== undefined) conditions.push(sql<SqlBool>`r.created_at < ${filter.to}`);
    if (filter.eventId !== undefined) {
      conditions.push(sql<SqlBool>`r.trigger_event_id = ${filter.eventId}`);
    }
    if (page.cursor !== null) {
      conditions.push(afterCursor(sql`r.created_at`, sql`r.id`, page.cursor));
    }
    const { rows } = await sql<RunLogRow>`
      SELECT r.*, u.display_name AS rerun_by_name,
             ${cursorTimestamp(sql`r.created_at`)} AS cursor_at
        FROM meta.automation_runs AS r
        JOIN meta.automations AS a
          ON a.organization_id = r.organization_id AND a.id = r.automation_id
        LEFT JOIN meta.users AS u ON u.id = r.rerun_by_user_id
       WHERE ${sql.join(conditions, sql` AND `)}
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT ${page.limit + 1}
    `.execute(this.executor(scope));
    return pageWithCursor(rows, page.limit, (row) => ({ at: row.cursor_at, id: row.id }));
  }

  /** One run with the name of who re-ran it. */
  async getForLog(scope: OrgScope, runId: Id<'run'>): Promise<RunLogRow | undefined> {
    const { rows } = await sql<RunLogRow>`
      SELECT r.*, u.display_name AS rerun_by_name,
             ${cursorTimestamp(sql`r.created_at`)} AS cursor_at
        FROM meta.automation_runs AS r
        LEFT JOIN meta.users AS u ON u.id = r.rerun_by_user_id
       WHERE r.organization_id = ${scope.organizationId}
         AND r.id = ${runId}
    `.execute(this.executor(scope));
    return rows[0];
  }

  /** The automation of a run (route scope of `/automation-runs/:runId/*`). */
  async automationIdOf(scope: OrgScope, runId: Id<'run'>): Promise<Id<'aut'> | undefined> {
    const row = await this.executor(scope)
      .selectFrom('meta.automation_runs')
      .select('automation_id')
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', runId)
      .executeTakeFirst();
    return row?.automation_id;
  }

  /** Re-runs of a run, newest first. */
  async listReruns(
    scope: OrgScope,
    runId: Id<'run'>,
  ): Promise<Pick<AutomationRunRow, 'id' | 'status' | 'created_at'>[]> {
    return this.executor(scope)
      .selectFrom('meta.automation_runs')
      .select(['id', 'status', 'created_at'])
      .where('organization_id', '=', scope.organizationId)
      .where('rerun_of_run_id', '=', runId)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
  }

  /** Whether a re-run of `runId` has not finished yet (`queued`, `running`, `waiting`). */
  async hasActiveRerun(scope: OrgScope, runId: Id<'run'>): Promise<boolean> {
    const row = await this.executor(scope)
      .selectFrom('meta.automation_runs')
      .select('id')
      .where('organization_id', '=', scope.organizationId)
      .where('rerun_of_run_id', '=', runId)
      .where('status', 'in', ['queued', 'running', 'waiting'])
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * Stops a run that has not started (`queued`): `cancelled` with `error`
   * and `finished_at`. `undefined` when it is in another state (a race lost
   * to the engine). Runs inside a `delay` go through `cancelWaiting` (T506).
   */
  async cancelQueued(
    scope: OrgScope,
    runId: Id<'run'>,
    input: { readonly at: Date; readonly error: JsonObject },
  ): Promise<AutomationRunRow | undefined> {
    return this.executor(scope)
      .updateTable('meta.automation_runs')
      .set({
        status: 'cancelled',
        finished_at: input.at,
        running_since: null,
        error: jsonb(input.error),
      })
      .where('organization_id', '=', scope.organizationId)
      .where('id', '=', runId)
      .where('status', '=', 'queued')
      .returningAll()
      .executeTakeFirst();
  }

  /**
   * Stops every `queued` run of an automation (BACKLOG T507: `run_as` lost
   * access): `cancelled` with `error` and `finished_at`. A run whose job
   * arrives later finds it `cancelled` and does nothing. Returns the ids.
   */
  async cancelQueuedOf(
    scope: OrgScope,
    automationId: Id<'aut'>,
    input: { readonly at: Date; readonly error: JsonObject },
  ): Promise<Id<'run'>[]> {
    const rows = await this.executor(scope)
      .updateTable('meta.automation_runs')
      .set({
        status: 'cancelled',
        finished_at: input.at,
        running_since: null,
        error: jsonb(input.error),
      })
      .where('organization_id', '=', scope.organizationId)
      .where('automation_id', '=', automationId)
      .where('status', '=', 'queued')
      .returning('id')
      .execute();
    return rows.map((row) => row.id);
  }

  /**
   * Latest run and the run counts by status over the last 24 hours and 7
   * days (database clock) of each automation in `automationIds`.
   */
  async statsOf(
    scope: OrgScope,
    automationIds: readonly Id<'aut'>[],
  ): Promise<Map<Id<'aut'>, AutomationRunStats>> {
    const stats = new Map<Id<'aut'>, AutomationRunStats>();
    if (automationIds.length === 0) return stats;
    const ids = sql.val([...automationIds]);
    const counts = await sql<{
      automation_id: Id<'aut'>;
      status: AutomationRunStatusKind;
      day: number;
      week: number;
    }>`
      SELECT automation_id, status,
             count(*) FILTER (WHERE created_at >= now() - interval '24 hours')::int AS day,
             count(*)::int AS week
        FROM meta.automation_runs
       WHERE organization_id = ${scope.organizationId}
         AND automation_id = ANY(${ids}::text[])
         AND created_at >= now() - interval '7 days'
       GROUP BY automation_id, status
    `.execute(this.executor(scope));
    const latest = await sql<{
      automation_id: Id<'aut'>;
      id: Id<'run'>;
      status: AutomationRunStatusKind;
      error_code: string | null;
      created_at: Date;
      finished_at: Date | null;
    }>`
      SELECT a.id AS automation_id, l.id, l.status, l.error->>'code' AS error_code,
             l.created_at, l.finished_at
        FROM unnest(${ids}::text[]) AS a(id)
        CROSS JOIN LATERAL (
          SELECT r.id, r.status, r.error, r.created_at, r.finished_at
            FROM meta.automation_runs AS r
           WHERE r.organization_id = ${scope.organizationId}
             AND r.automation_id = a.id
           ORDER BY r.created_at DESC, r.id DESC
           LIMIT 1
        ) AS l
    `.execute(this.executor(scope));
    for (const id of automationIds) {
      stats.set(id, { lastRun: null, counts24h: zeroCounts(), counts7d: zeroCounts() });
    }
    for (const row of counts.rows) {
      const entry = stats.get(row.automation_id);
      if (entry === undefined) continue;
      (entry.counts24h as Record<AutomationRunStatusKind, number>)[row.status] = row.day;
      (entry.counts7d as Record<AutomationRunStatusKind, number>)[row.status] = row.week;
    }
    for (const row of latest.rows) {
      const entry = stats.get(row.automation_id);
      if (entry === undefined) continue;
      stats.set(row.automation_id, {
        ...entry,
        lastRun: {
          id: row.id,
          status: row.status,
          errorCode: row.error_code,
          createdAt: row.created_at,
          finishedAt: row.finished_at,
        },
      });
    }
    return stats;
  }

  /**
   * Deletes up to `limit` finished runs (`succeeded`, `failed`, `skipped`,
   * `cancelled`) created before `cutoff`, with their steps (cascade);
   * returns how many (`AUTOMATION_RUN_RETENTION_DAYS`, T518).
   */
  async deleteFinishedBefore(scope: OrgScope, cutoff: Date, limit: number): Promise<number> {
    const result = await sql`
      DELETE FROM meta.automation_runs
       WHERE organization_id = ${scope.organizationId}
         AND id IN (
           SELECT id FROM meta.automation_runs
            WHERE organization_id = ${scope.organizationId}
              AND created_at < ${cutoff}
              AND status IN ('succeeded', 'failed', 'skipped', 'cancelled')
            ORDER BY created_at
            LIMIT ${limit})
    `.execute(this.executor(scope));
    return Number(result.numAffectedRows ?? 0n);
  }

  /**
   * Cancels the `waiting` runs (inside a `delay`, BACKLOG T506) of an
   * automation — or the one run `runId` when given — with `error`; their
   * waiting step is cancelled too. The resume job finds them `cancelled`
   * and does nothing. Returns the ids of the runs cancelled.
   */
  async cancelWaiting(
    scope: OrgScope,
    target: { readonly automationId: Id<'aut'> } | { readonly runId: Id<'run'> },
    error: JsonObject,
  ): Promise<Id<'run'>[]> {
    const update = this.executor(scope)
      .updateTable('meta.automation_runs')
      .set({ status: 'cancelled', finished_at: sql<Date>`now()`, error: jsonb(error) })
      .where('organization_id', '=', scope.organizationId)
      .where('status', '=', 'waiting');
    const rows = await (
      'automationId' in target
        ? update.where('automation_id', '=', target.automationId)
        : update.where('id', '=', target.runId)
    )
      .returning('id')
      .execute();
    const ids = rows.map((row) => row.id);
    if (ids.length === 0) return ids;
    await this.executor(scope)
      .updateTable('meta.automation_run_steps')
      .set({ status: 'cancelled', finished_at: sql<Date>`now()` })
      .where('organization_id', '=', scope.organizationId)
      .where('run_id', 'in', ids)
      .where('status', '=', 'waiting')
      .execute();
    return ids;
  }
}
