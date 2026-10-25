import { sql, type Kysely } from 'kysely';

/**
 * Migration 0031 (BACKLOG T505): what the run engine needs to time a run.
 *
 * SPEC §11.7: a run times out after 15 minutes **of running** — the waits
 * between retries (10 s … 30 min, the run is `queued` again) and `delay`
 * steps (`waiting`, T506) do not count. A run is resumed by several jobs, so
 * the running time is accumulated:
 * - `active_ms`: running time of the segments already ended;
 * - `running_since`: when the current segment started (`NULL` unless
 *   `running`). A run `running` for longer than the timeout without its job
 *   (a crashed worker) no longer holds a slot of
 *   `AUTOMATION_MAX_RUNNING_PER_ORG` (ADR-18).
 *
 * Columns with constant defaults only: no table rewrite, no backfill (runs
 * created by T503 are `queued`).
 *
 * Static DDL on `meta.*` only.
 * This file is locked by `migrations.lock.json`: never edit it once merged.
 */

const STATEMENTS = [
  `ALTER TABLE meta.automation_runs
     ADD COLUMN active_ms bigint NOT NULL DEFAULT 0,
     ADD COLUMN running_since timestamptz,
     ADD CONSTRAINT automation_runs_active_ms_check CHECK (active_ms >= 0)`,
  `CREATE INDEX automation_runs_running_idx
     ON meta.automation_runs (organization_id, running_since) WHERE status = 'running'`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
