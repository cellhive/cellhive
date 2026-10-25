import { sql, type Kysely } from 'kysely';

/**
 * Migration 0032 (BACKLOG T518): re-runs in the run log.
 *
 * `POST /automation-runs/:id/rerun` creates a **new** run with the current
 * definition ("Quyết định S5 thiết kế" #4) that keeps a link to the run it
 * repeats:
 * - `rerun_of_run_id`: the original run (same organization — composite
 *   foreign key, SPEC §5.10). When retention deletes the original first,
 *   only this column becomes `NULL` (`ON DELETE SET NULL (rerun_of_run_id)`,
 *   PostgreSQL 15+), the re-run stays;
 * - `rerun_by_user_id`: who asked for it (a user is disabled, never deleted).
 *
 * The partial index serves the foreign key when old runs are deleted and the
 * "re-runs of this run" lookup of the run detail.
 *
 * Static DDL on `meta.*` only. Nullable columns without default: no table
 * rewrite, no backfill.
 * This file is locked by `migrations.lock.json`: never edit it once merged.
 */

const STATEMENTS = [
  `ALTER TABLE meta.automation_runs
     ADD COLUMN rerun_of_run_id text,
     ADD COLUMN rerun_by_user_id text,
     ADD CONSTRAINT automation_runs_rerun_of_fkey FOREIGN KEY (organization_id, rerun_of_run_id)
       REFERENCES meta.automation_runs (organization_id, id) ON DELETE SET NULL (rerun_of_run_id),
     ADD CONSTRAINT automation_runs_rerun_by_fkey FOREIGN KEY (rerun_by_user_id)
       REFERENCES meta.users (id),
     ADD CONSTRAINT automation_runs_rerun_check
       CHECK (rerun_of_run_id IS NULL OR rerun_by_user_id IS NOT NULL)`,
  `CREATE INDEX automation_runs_rerun_of_idx
     ON meta.automation_runs (organization_id, rerun_of_run_id)
     WHERE rerun_of_run_id IS NOT NULL`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
