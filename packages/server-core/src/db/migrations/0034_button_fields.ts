import { sql, type Kysely } from 'kysely';

/**
 * Migration 0034 (BACKLOG T517, ADR-32 §2): button fields and their
 * `button.clicked` automations (SPEC §5.5, §11.2).
 *
 * - `meta.fields.type` also accepts `button`. A button has no column of its
 *   own (`db_column_name` stays `NULL`, no slot of ADR-20 is used): its cell
 *   is computed per reader and a click runs an automation.
 * - `automations_button_field_key`: at most one automation that is not
 *   deleted per button (BACKLOG "Câu hỏi mở S5" #6, `422 BUTTON_IN_USE`) —
 *   the backstop of the check made when an automation is saved — and the
 *   index used to find the automation of a button (cells, clicks). Keyed by
 *   organization and the trigger's `field_id` inside `definition`.
 *
 * Static DDL on `meta.*` only. The check constraint is replaced in place
 * (validated against existing rows, none of which can be a button yet); the
 * unique index is partial and small (button automations only).
 * Self-contained: no object of a later migration is used, so its number may
 * change at merge. This file is locked by `migrations.lock.json`: never edit
 * it once merged.
 */

const FIELD_TYPES = `('text', 'number', 'select', 'datetime', 'checkbox', 'user', 'created_at',
  'updated_at', 'created_by', 'updated_by', 'auto_number', 'link', 'parent', 'lookup', 'formula',
  'attachment', 'button')`;

const STATEMENTS = [
  'ALTER TABLE meta.fields DROP CONSTRAINT fields_type_check',
  `ALTER TABLE meta.fields ADD CONSTRAINT fields_type_check CHECK (type IN ${FIELD_TYPES})`,
  `ALTER TABLE meta.fields ADD CONSTRAINT fields_button_column_check
     CHECK (type <> 'button' OR db_column_name IS NULL)`,
  `CREATE UNIQUE INDEX automations_button_field_key
     ON meta.automations (organization_id, ((definition -> 'trigger' ->> 'field_id')))
     WHERE deleted_at IS NULL AND trigger_type = 'button.clicked'`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
