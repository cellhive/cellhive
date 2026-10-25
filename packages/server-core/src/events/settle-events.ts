import { sql } from 'kysely';

import type { Db } from '../db/create-db.js';
import type { OrgScope } from '../db/repository.js';

export interface SettledEvents {
  /** Events marked dispatched. */
  readonly events: number;
  /** Their queued `events.dispatch` jobs removed from the queue. */
  readonly jobs: number;
}

/** The organization already has an automation: its pending events may still start runs. */
export class EventsNotSettleableError extends Error {
  constructor() {
    super('the organization has automations: its pending events must be dispatched');
    this.name = 'EventsNotSettleableError';
  }
}

/**
 * Marks every pending event of an organization **without any automation**
 * as dispatched and removes their queued `events.dispatch` jobs (BACKLOG
 * T519). Dispatching only creates automation runs (SPEC §11.1): with no
 * automation in the organization, each of those jobs would set
 * `dispatched_at` and do nothing else — and, if an automation were created
 * before the worker got to them, it would wrongly fire for changes made
 * before it existed. Bulk loaders (`seed:demo`, `seed:bench`) call this once
 * their records exist, so a fresh database does not start with tens of
 * thousands of queued jobs in front of real work.
 *
 * Without `scope.tx`, each chunk commits in its own transaction, which
 * re-takes the organization lock and re-checks "no automation" (BACKLOG
 * T818): a dispatch job a worker already holds then waits on at most one
 * chunk's row locks, not on all 200 000 events of `seed:bench` until its
 * statement timeout. With `scope.tx`, every chunk runs in that transaction.
 *
 * Refuses (`EventsNotSettleableError`) once the organization has an
 * automation, deleted ones included. A job a worker holds right now is left
 * alone (it finds the event dispatched and completes).
 */
export async function settleEventsWithoutAutomations(
  db: Db,
  scope: OrgScope,
  /** Events per statement (default 2 000; tests use less). */
  options: { readonly chunkSize?: number } = {},
): Promise<SettledEvents> {
  const chunkSize = options.chunkSize ?? SETTLE_CHUNK;
  const chunk = (executor: NonNullable<OrgScope['tx']>): Promise<SettledEvents> =>
    settleChunk(executor, scope.organizationId, chunkSize);
  let events = 0;
  let jobs = 0;
  for (;;) {
    const settled = scope.tx === undefined ? await db.withTx(chunk) : await chunk(scope.tx);
    if (settled.events === 0) break;
    events += settled.events;
    jobs += settled.jobs;
  }
  return { events, jobs };
}

/** One chunk: lock the organization, check it has no automation, settle its oldest events. */
async function settleChunk(
  executor: NonNullable<OrgScope['tx']>,
  organizationId: string,
  chunkSize: number,
): Promise<SettledEvents> {
  // Serializes with a concurrent automation insert of the organization (row lock on it).
  await sql`
    SELECT 1 FROM meta.organizations WHERE id = ${organizationId} FOR UPDATE
  `.execute(executor);
  const { rows: existing } = await sql<{ found: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM meta.automations WHERE organization_id = ${organizationId}
    ) AS found
  `.execute(executor);
  if (existing[0]?.found === true) throw new EventsNotSettleableError();
  // The oldest pending events of the organization by the partial index
  // `events_pending_idx`, each then updated by its primary key (id,
  // created_at — which also picks its partition). In chunks: each statement
  // stays far below the statement timeout, even for `seed:bench`.
  const { rows: settled } = await sql<{ id: string }>`
    WITH batch AS (
      SELECT id, created_at FROM meta.events
       WHERE dispatched_at IS NULL AND organization_id = ${organizationId}
       ORDER BY created_at
       LIMIT ${chunkSize}
    )
    UPDATE meta.events AS events
       SET dispatched_at = now()
      FROM batch
     WHERE events.id = batch.id
       AND events.created_at = batch.created_at
       AND events.dispatched_at IS NULL
    RETURNING events.id
  `.execute(executor);
  if (settled.length === 0) return { events: 0, jobs: 0 };
  // What graphile_worker.complete_jobs does for a job without queue (delete
  // its row), for exactly the events settled above: one array parameter,
  // hashed by PostgreSQL.
  const removed = await sql`
    DELETE FROM graphile_worker._private_jobs AS jobs
     USING graphile_worker._private_tasks AS tasks
     WHERE tasks.id = jobs.task_id
       AND tasks.identifier = 'events.dispatch'
       AND jobs.job_queue_id IS NULL
       AND jobs.locked_at IS NULL
       AND jobs.payload->>'organization_id' = ${organizationId}
       AND jobs.payload->>'event_id' = ANY(${settled.map((row) => row.id)}::text[])
  `.execute(executor);
  return { events: settled.length, jobs: Number(removed.numAffectedRows ?? 0n) };
}

/** Events settled per statement. */
const SETTLE_CHUNK = 2_000;
