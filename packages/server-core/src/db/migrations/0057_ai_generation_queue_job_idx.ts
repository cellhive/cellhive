import { sql, type Kysely } from 'kysely';

/**
 * Migration 0057 (BACKLOG T1003; CONTRACTS §29.5, SPEC §5.10): indexes of
 * the AI field generation queue (`meta.ai_generation_queue`, 0056) for the
 * queries that run once per batch or once per minute, so that none of them
 * reads every row of an organization:
 *
 * - `ai_generation_queue_job_idx`: the rows of one generate request
 *   (`meta.jobs` id) — its progress after every batch (`pendingOfJob`,
 *   `failedOfJob`) and "is a generate request of this field still running"
 *   (`409 AI_GENERATION_RUNNING`). Rows queued by record writes have no
 *   job: left out.
 * - `ai_generation_queue_backoff_idx`: the `queued` rows that wait while
 *   the organization backs off (`reason = 'backoff'`, T1002) — checked by
 *   every batch before it takes rows and when it computes its next run.
 * - `ai_generation_queue_paused_idx`: `paused` rows by organization and
 *   reason — the per-minute rescue cron looks for organizations whose
 *   paused rows can resume now (AI or record data turned back on, a new
 *   quota day), never `provider_error` ones.
 *
 * The queue holds work in progress, not history, so `CREATE INDEX` (in the
 * migration's transaction, not `CONCURRENTLY`) holds writes to it only
 * briefly. Self-contained (only the table of 0056), so its number can change
 * at merge. This file is locked by `migrations.lock.json`: never edit it once
 * merged.
 */

const STATEMENTS = [
  `CREATE INDEX ai_generation_queue_job_idx
     ON meta.ai_generation_queue (organization_id, job_id) WHERE job_id IS NOT NULL`,
  `CREATE INDEX ai_generation_queue_backoff_idx
     ON meta.ai_generation_queue (organization_id, lease_until)
     WHERE status = 'queued' AND reason = 'backoff'`,
  `CREATE INDEX ai_generation_queue_paused_idx
     ON meta.ai_generation_queue (organization_id, reason) WHERE status = 'paused'`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
