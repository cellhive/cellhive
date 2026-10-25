import { sql, type Kysely } from 'kysely';

/**
 * Migration 0052 (BACKLOG T709, S6 decision #15): indexes for the audit
 * log viewer filters "who" and "what" (CONTRACTS §11.4). Both lists page
 * newest first with a keyset cursor on `(created_at, id)`, so each index
 * ends with `created_at DESC, id DESC`:
 *
 * - `audit_logs_actor_idx`: `actor_id` (one or more values);
 * - `audit_logs_action_idx`: `action` (one or more values, and the closed
 *   action groups of `action_prefix`, which expand to exact actions).
 *
 * `meta.audit_logs` is partitioned by month: an index on the partitioned
 * parent is created on every partition (and on future ones), and
 * `CREATE INDEX CONCURRENTLY` is not supported there, so writes to the
 * table wait while the indexes build (see the Upgrade notes of BACKLOG
 * T709 for the measured time per million rows).
 *
 * This file is locked by `migrations.lock.json`: never edit it once merged.
 */

const STATEMENTS = [
  `CREATE INDEX audit_logs_actor_idx
     ON meta.audit_logs (organization_id, actor_id, created_at DESC, id DESC)`,
  `CREATE INDEX audit_logs_action_idx
     ON meta.audit_logs (organization_id, action, created_at DESC, id DESC)`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
