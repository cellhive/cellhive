import { sql, type Kysely } from 'kysely';

/**
 * Migration 0020 (BACKLOG T461): permanently deleted tables.
 *
 * - `meta.tables.purged_at`: the table was purged from the trash (30 days
 *   after its deletion, or by hand): `data.t_x`, its junctions and link
 *   backups are dropped. The row stays (attachments and share links keep
 *   pointing at it until their cleanup; the audit log keeps naming it), but
 *   every lookup treats the table as missing. Only a table in the trash can
 *   be purged.
 * - `meta.fields.link_table_purged_at`: a `link` field of another table
 *   pointing at a purged table (one-way, or the reverse field of a two-way
 *   link) is put in the trash with this mark: its junction is gone, so a
 *   restore answers `422 LINK_TABLE_PURGED` (CONTRACTS §13).
 * - a partial index on the trash for the daily `tables.purge` cron.
 *
 * Addition to SPEC §5.10 (reported in T461). Self-contained: no function or
 * table of a later migration is used, so its number can change at merge.
 *
 * This file is locked by `migrations.lock.json`: never edit it once merged.
 */

const STATEMENTS = [
  'ALTER TABLE meta.tables ADD COLUMN purged_at timestamptz',
  `ALTER TABLE meta.tables ADD CONSTRAINT tables_purged_state_check
     CHECK (purged_at IS NULL OR deleted_at IS NOT NULL)`,
  `CREATE INDEX tables_trash_idx ON meta.tables (deleted_at)
     WHERE deleted_at IS NOT NULL AND purged_at IS NULL`,
  'ALTER TABLE meta.fields ADD COLUMN link_table_purged_at timestamptz',
  `ALTER TABLE meta.fields ADD CONSTRAINT fields_link_table_purged_check
     CHECK (link_table_purged_at IS NULL OR (deleted_at IS NOT NULL AND type = 'link'))`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
