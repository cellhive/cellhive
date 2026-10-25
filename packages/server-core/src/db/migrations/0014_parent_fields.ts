import { sql, type Kysely } from 'kysely';

/**
 * Migration 0014 (BACKLOG T405): sub-records.
 *
 * A `parent` field keeps its values in the system column `__parent_id` of
 * its table (SPEC §5.7), created by `SchemaService` with the field, so it
 * has no `db_column_name` of its own. A table has at most one `parent`
 * field whose column still exists: an active one, or one in the trash that
 * can still be restored (its column and values are kept until the field is
 * purged).
 *
 * Addition to SPEC §5.10 (reported in T405). Self-contained: no function or
 * table of a later migration is used, so its number can change at merge.
 *
 * This file is locked by `migrations.lock.json`: never edit it once merged.
 */

const STATEMENTS = [
  `ALTER TABLE meta.fields
     ADD CONSTRAINT fields_parent_column_check CHECK (type <> 'parent' OR db_column_name IS NULL)`,
  `CREATE UNIQUE INDEX fields_table_parent_key
     ON meta.fields (table_id) WHERE type = 'parent' AND purged_at IS NULL`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
