import { sql, type Kysely } from 'kysely';

/**
 * Migration 0041 (BACKLOG T547; ADR-29 §1, ADR-34 §1): the cursors of the
 * date reminder consumer of the shared time scan core.
 *
 * `meta.date_reminder_cursors` holds one row per `datetime` field whose
 * `options.reminder` is on — the row exists exactly while the reminder is
 * on (`SchemaService` writes it in the transaction of the field change):
 *
 * - `armed_at`: when the reminder was turned on or last changed (offset,
 *   time of day, recipients, format, zone) or the field came back from the
 *   trash: only moments passing **after** it remind (no catch-up);
 * - `scanned_until`: end of the window the per-minute scan already handled,
 *   moved forward in the scan transaction that queued the reminders;
 * - `boundary_due_at` / `boundary_record_ids`: when a scan stopped at the
 *   per-scan cap (1 000 reminders), the due moment it stopped at and the
 *   records due at that very moment it already reminded of. The next scan
 *   reads that moment again (`scanned_until` = due − 1 ms, ADR-34 §1) and
 *   skips them, so many records due at one moment (a date-only field) still
 *   make progress. Cleared once a scan reads its whole window.
 *
 * The foreign key to `meta.fields` is composite with `organization_id`
 * (SPEC §5.10, T501 catalog test) and cascades. Leaving a field in the
 * trash deletes the row in the same transaction; restoring re-arms it. The
 * primary key `(organization_id, field_id)` serves the scan's keyset over
 * every organization (`listDateReminderFields`).
 *
 * Self-contained: only `meta.set_updated_at()` (migration 0001) is used, so
 * its number can change at merge. This file is locked by
 * `migrations.lock.json`: never edit it once merged.
 */

const STATEMENTS = [
  `CREATE TABLE meta.date_reminder_cursors (
     organization_id text NOT NULL,
     field_id text NOT NULL,
     armed_at timestamptz NOT NULL,
     scanned_until timestamptz NOT NULL,
     boundary_due_at timestamptz,
     boundary_record_ids text[] NOT NULL DEFAULT '{}',
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT date_reminder_cursors_pkey PRIMARY KEY (organization_id, field_id),
     CONSTRAINT date_reminder_cursors_field_fkey FOREIGN KEY (organization_id, field_id)
       REFERENCES meta.fields (organization_id, id) ON DELETE CASCADE,
     CONSTRAINT date_reminder_cursors_boundary_check
       CHECK (boundary_due_at IS NOT NULL OR cardinality(boundary_record_ids) = 0)
   )`,
  `CREATE TRIGGER date_reminder_cursors_set_updated_at
     BEFORE UPDATE ON meta.date_reminder_cursors
     FOR EACH ROW EXECUTE FUNCTION meta.set_updated_at()`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
