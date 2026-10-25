import { sql } from 'kysely';

import {
  TenantRepository,
  type OrgScope,
  type TenantRepositoryContract,
} from '../../db/repository.js';

import type { Db } from '../../db/create-db.js';
import type { Id } from '@cellhive/contracts';

/**
 * `meta.automation_batch_counters` (ADR-26 §4, BACKLOG T503): runs and
 * skipped records per (automation, `batch.id`), so one paste or import
 * creates at most `AUTOMATION_MAX_RUNS_PER_BATCH` runs per automation.
 * Rows are written in the transaction of `events.dispatch` and purged
 * after 24 hours by `maintenance.cleanup`. Scoped by `organization_id`.
 */
export class AutomationBatchCountersRepository
  extends TenantRepository<'automation_batch_counters'>
  implements TenantRepositoryContract<AutomationBatchCountersRepository>
{
  constructor(db: Db) {
    super(db, 'automation_batch_counters');
  }

  /**
   * Takes one run slot of the batch: `true` (and `runs + 1`) while the
   * batch has fewer than `limit` runs, `false` once it is full. Concurrent
   * callers wait on the row lock, so the cap is exact.
   */
  async claimRun(
    scope: OrgScope,
    automationId: Id<'aut'>,
    batchId: string,
    limit: number,
  ): Promise<boolean> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('limit must be ≥ 1');
    const { rows } = await sql<{ runs: number }>`
      INSERT INTO meta.automation_batch_counters AS c
             (organization_id, automation_id, batch_id, runs, skipped)
      VALUES (${scope.organizationId}, ${automationId}, ${batchId}, 1, 0)
      ON CONFLICT (automation_id, batch_id) DO UPDATE
         SET runs = c.runs + 1
       WHERE c.organization_id = excluded.organization_id AND c.runs < ${limit}
      RETURNING runs
    `.execute(this.executor(scope));
    return rows.length > 0;
  }

  /** Counts one record of the batch that got no run; returns the new `skipped`. */
  async addSkipped(scope: OrgScope, automationId: Id<'aut'>, batchId: string): Promise<number> {
    const row = await this.executor(scope)
      .updateTable('meta.automation_batch_counters')
      .set((eb) => ({ skipped: eb('skipped', '+', 1) }))
      .where('organization_id', '=', scope.organizationId)
      .where('automation_id', '=', automationId)
      .where('batch_id', '=', batchId)
      .returning('skipped')
      .executeTakeFirst();
    return row?.skipped ?? 0;
  }

  /**
   * Counters of one automation for the batches of a recompute job (T509),
   * read before the job writes events: `undefined` when none exists yet.
   */
  async get(
    scope: OrgScope,
    automationId: Id<'aut'>,
    batchId: string,
  ): Promise<{ runs: number; skipped: number; events: number } | undefined> {
    return this.executor(scope)
      .selectFrom('meta.automation_batch_counters')
      .select(['runs', 'skipped', 'events'])
      .where('organization_id', '=', scope.organizationId)
      .where('automation_id', '=', automationId)
      .where('batch_id', '=', batchId)
      .executeTakeFirst();
  }

  /**
   * A recompute job wrote `events` `record.updated` events the automation
   * listens to, and left `skipped` records without one past the cap (T509,
   * ADR-26 §4). Creates the row when needed (`runs` stays with
   * `events.dispatch`); returns the new counters.
   */
  async addRecomputeEvents(
    scope: OrgScope,
    automationId: Id<'aut'>,
    batchId: string,
    counts: { readonly events: number; readonly skipped: number },
  ): Promise<{ runs: number; skipped: number; events: number } | undefined> {
    const { rows } = await sql<{ runs: number; skipped: number; events: number }>`
      INSERT INTO meta.automation_batch_counters AS c
             (organization_id, automation_id, batch_id, runs, skipped, events)
      SELECT a.organization_id, a.id, ${batchId}, 0, ${counts.skipped}, ${counts.events}
        FROM meta.automations AS a
       WHERE a.organization_id = ${scope.organizationId} AND a.id = ${automationId}
      ON CONFLICT (automation_id, batch_id) DO UPDATE
         SET skipped = c.skipped + excluded.skipped, events = c.events + excluded.events
       WHERE c.organization_id = excluded.organization_id
      RETURNING runs, skipped, events
    `.execute(this.executor(scope));
    return rows[0];
  }
}
