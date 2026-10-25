import { sql, type Kysely } from 'kysely';

/**
 * Migration 0033 (BACKLOG T508): what the time triggers `schedule` and
 * `record.date_reached` need (SPEC §11.2). Numbered 0033 because T518 takes
 * 0032; self-contained (no object of 0032 is used), so the number may change
 * at merge.
 *
 * - `meta.automations.trigger_armed_at`: when the automation was last turned
 *   on (`INSERT` enabled, or `enabled` false → true), set by a `BEFORE`
 *   trigger with the transaction time. A time trigger only fires for moments
 *   that pass **after** it (no catch-up for values already past when it was
 *   turned on). `NULL` for rows enabled before this migration: the scanners
 *   start from their first scan.
 * - `meta.automation_time_cursors`: per automation, the end of the window the
 *   scanner already handled (`scanned_until`). Each tick handles
 *   `(max(scanned_until, trigger_armed_at), now]` and moves it forward in the
 *   same transaction as the runs it creates, so a stopped worker resumes
 *   where it stopped. Composite tenant foreign key, cascade with the
 *   automation.
 * - `meta.automation_runs.trigger_key` + `UNIQUE (automation_id,
 *   trigger_key)`: the dedupe key of a run without an event —
 *   `automation_id:fired_at` (`schedule`) or
 *   `automation_id:record_id:<value>` (`record.date_reached`). `NULL` for
 *   event runs (unique by `trigger_event_id`); `NULL`s never conflict.
 * - `automations_time_trigger_idx`: the cross-tenant lookup of the enabled
 *   time-trigger automations (`listTimeTriggerAutomations`).
 *
 * Static DDL on `meta.*` only. Adding nullable columns rewrites no table;
 * the unique constraint builds one index over `automation_runs`.
 * This file is locked by `migrations.lock.json`: never edit it once merged.
 */

const STATEMENTS = [
  'ALTER TABLE meta.automations ADD COLUMN trigger_armed_at timestamptz',
  `CREATE FUNCTION meta.automations_arm_trigger() RETURNS trigger
     LANGUAGE plpgsql AS $$
   BEGIN
     IF NEW.enabled AND (TG_OP = 'INSERT' OR NOT OLD.enabled) THEN
       NEW.trigger_armed_at := now();
     END IF;
     RETURN NEW;
   END
   $$`,
  `CREATE TRIGGER automations_arm_trigger BEFORE INSERT OR UPDATE ON meta.automations
     FOR EACH ROW EXECUTE FUNCTION meta.automations_arm_trigger()`,
  `CREATE INDEX automations_time_trigger_idx
     ON meta.automations (organization_id, id)
     WHERE enabled AND deleted_at IS NULL
       AND trigger_type IN ('schedule', 'record.date_reached')`,

  `CREATE TABLE meta.automation_time_cursors (
     organization_id text NOT NULL,
     automation_id text NOT NULL,
     scanned_until timestamptz NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (automation_id),
     CONSTRAINT automation_time_cursors_automation_fkey
       FOREIGN KEY (organization_id, automation_id)
       REFERENCES meta.automations (organization_id, id) ON DELETE CASCADE
   )`,
  `CREATE INDEX automation_time_cursors_org_idx
     ON meta.automation_time_cursors (organization_id, automation_id)`,
  `CREATE TRIGGER automation_time_cursors_set_updated_at BEFORE UPDATE ON meta.automation_time_cursors
     FOR EACH ROW EXECUTE FUNCTION meta.set_updated_at()`,

  `ALTER TABLE meta.automation_runs
     ADD COLUMN trigger_key text,
     ADD CONSTRAINT automation_runs_trigger_key_key UNIQUE (automation_id, trigger_key),
     ADD CONSTRAINT automation_runs_trigger_key_check
       CHECK (trigger_key IS NULL OR length(trigger_key) BETWEEN 1 AND 300)`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
