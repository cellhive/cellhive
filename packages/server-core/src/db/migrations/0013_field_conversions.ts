import { sql, type Kysely } from 'kysely';

/**
 * Migration 0013 (BACKLOG T403): `meta.field_conversions`, one row per
 * field type conversion (SPEC §5.5, CONTRACTS §4, ADR-23 §3).
 *
 * `job_id` is the `field.convert` job that backfills the new column (also
 * the conversion's id: `meta.jobs` rows are purged after a while, this row
 * is not). While it runs, the job fills a shadow column
 * (`shadow_column_name`, `f_x__new_<epoch ms>`) and the field keeps reading
 * its old column with its old definition (BACKLOG S4 design decision #8);
 * the end swaps them: the old column becomes `old_column_name`
 * (`f_x__old_<epoch ms>`, kept 7 days; `NULL` when the source type had no
 * column of its own, e.g. `created_at`) and the shadow takes the canonical
 * name `new_column_name`. The row keeps what a revert needs: the definition
 * before (`from_definition`: type, options, unique_values) and after, the
 * locale/zone/settings the values were converted with (`context`), the
 * backfill position (`cursor_auto`; `max_auto` = last `__auto` at the start)
 * and the counters. `status`: `running` → `succeeded` | `failed` (the shadow
 * column is dropped, the field unchanged), then `reverted` (undone within 7
 * days) or `cleaned` (the old column was dropped after `expires_at`). At
 * most one conversion of a field runs at a time.
 *
 * Addition to SPEC §5.10 (reported in T403). Self-contained: no function or
 * table of a later migration is used, so its number can change at merge.
 *
 * This file is locked by `migrations.lock.json`: never edit it once merged.
 */

const STATEMENTS = [
  `CREATE TABLE meta.field_conversions (
     job_id text PRIMARY KEY,
     organization_id text NOT NULL,
     table_id text NOT NULL,
     field_id text NOT NULL,
     status text NOT NULL DEFAULT 'running',
     from_definition jsonb NOT NULL,
     to_definition jsonb NOT NULL,
     old_column_name text,
     new_column_name text NOT NULL,
     shadow_column_name text NOT NULL,
     context jsonb NOT NULL DEFAULT '{}'::jsonb,
     max_auto bigint NOT NULL DEFAULT 0,
     cursor_auto bigint NOT NULL DEFAULT 0,
     counts jsonb NOT NULL DEFAULT '{}'::jsonb,
     created_by text,
     expires_at timestamptz NOT NULL,
     finished_at timestamptz,
     reverted_at timestamptz,
     cleaned_at timestamptz,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT field_conversions_field_fkey FOREIGN KEY (organization_id, table_id, field_id)
       REFERENCES meta.fields (organization_id, table_id, id) ON DELETE CASCADE,
     CONSTRAINT field_conversions_status_check
       CHECK (status IN ('running', 'succeeded', 'failed', 'reverted', 'cleaned')),
     CONSTRAINT field_conversions_old_column_check
       CHECK (old_column_name ~ '^f_[0-9a-z]{12}__old_[0-9]{1,15}$'),
     CONSTRAINT field_conversions_new_column_check
       CHECK (new_column_name ~ '^f_[0-9a-z]{12}$'),
     CONSTRAINT field_conversions_shadow_column_check
       CHECK (shadow_column_name ~ '^f_[0-9a-z]{12}__new_[0-9]{1,15}$'),
     CONSTRAINT field_conversions_cursor_check CHECK (cursor_auto >= 0 AND max_auto >= 0)
   )`,
  `CREATE UNIQUE INDEX field_conversions_running_key
     ON meta.field_conversions (field_id) WHERE status = 'running'`,
  `CREATE INDEX field_conversions_field_idx
     ON meta.field_conversions (organization_id, field_id, created_at DESC)`,
  `CREATE INDEX field_conversions_table_idx
     ON meta.field_conversions (organization_id, table_id)
     WHERE status IN ('running', 'succeeded')`,
  `CREATE INDEX field_conversions_expires_idx
     ON meta.field_conversions (expires_at)
     WHERE status = 'succeeded'`,
  `CREATE TRIGGER field_conversions_set_updated_at BEFORE UPDATE ON meta.field_conversions
     FOR EACH ROW EXECUTE FUNCTION meta.set_updated_at()`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
