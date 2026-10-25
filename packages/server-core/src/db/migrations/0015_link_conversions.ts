import { sql, type Kysely } from 'kysely';

/**
 * Migration 0015 (BACKLOG T404): link conversions in
 * `meta.field_conversions` (ADR-28, CONTRACTS §4).
 *
 * A `link` field has no column: its conversions (`to_two_way`,
 * `to_one_way`, `to_single`) have no shadow, old or new column.
 *
 * - `kind`: `column` for the type conversions of T403 (their three column
 *   names stay required), or the link change;
 * - `partner_table_id` / `partner_field_id`: the other side of the link
 *   (the reverse field created by `to_two_way` — its id is chosen when the
 *   conversion starts —, the side deleted by `to_one_way`, the reverse
 *   field of a two-way link cut by `to_single`). While the conversion runs,
 *   schema changes of that field answer `409 SCHEMA_LOCKED` too;
 * - `backup_table_name`: `to_single` moves the links it removes (and the
 *   link each cut cell keeps) to `data.l_<id>__old_<epoch ms>` for the
 *   7-day revert; dropped by the cleanup like an old column.
 *
 * Addition to SPEC §5.10 (reported in T404). Self-contained: no function or
 * table of a later migration is used, so its number can change at merge.
 *
 * This file is locked by `migrations.lock.json`: never edit it once merged.
 */

const STATEMENTS = [
  `ALTER TABLE meta.field_conversions
     ALTER COLUMN new_column_name DROP NOT NULL,
     ALTER COLUMN shadow_column_name DROP NOT NULL,
     ADD COLUMN kind text NOT NULL DEFAULT 'column',
     ADD COLUMN partner_table_id text,
     ADD COLUMN partner_field_id text,
     ADD COLUMN backup_table_name text`,
  `ALTER TABLE meta.field_conversions
     ADD CONSTRAINT field_conversions_kind_check
       CHECK (kind IN ('column', 'to_two_way', 'to_one_way', 'to_single')),
     ADD CONSTRAINT field_conversions_columns_check CHECK (
       CASE WHEN kind = 'column'
         THEN new_column_name IS NOT NULL AND shadow_column_name IS NOT NULL
              AND backup_table_name IS NULL AND partner_field_id IS NULL
         ELSE new_column_name IS NULL AND shadow_column_name IS NULL AND old_column_name IS NULL
       END
     ),
     ADD CONSTRAINT field_conversions_partner_check
       CHECK ((partner_table_id IS NULL) = (partner_field_id IS NULL)),
     ADD CONSTRAINT field_conversions_backup_check
       CHECK (backup_table_name ~ '^l_[0-9a-z]{12}__old_[0-9]{1,15}$')`,
  `CREATE INDEX field_conversions_partner_idx
     ON meta.field_conversions (organization_id, partner_table_id)
     WHERE status = 'running' AND partner_table_id IS NOT NULL`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
