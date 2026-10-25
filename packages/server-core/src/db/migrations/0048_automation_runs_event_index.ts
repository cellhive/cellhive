import { sql, type Kysely } from 'kysely';

/**
 * Migration 0048 (BACKLOG T616 — QA S5c; CONTRACTS §21 "Lịch sử chạy"): the
 * run history filters by trigger event (`GET /bases/:id/automation-runs
 * ?event_id=`, the "Run history" link of a webhook request row). The
 * unique key `(automation_id, trigger_event_id)` of 0027 starts with the
 * automation, so it cannot serve a lookup by event alone; this partial
 * index does, inside the organization. Runs without an event (`schedule`,
 * re-runs) are not indexed.
 *
 * This file is locked by `migrations.lock.json`: never edit it once merged.
 */

const STATEMENTS = [
  `CREATE INDEX automation_runs_trigger_event_idx
     ON meta.automation_runs (organization_id, trigger_event_id)
     WHERE trigger_event_id IS NOT NULL`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
