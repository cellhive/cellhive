import { sql, type Kysely } from 'kysely';

/**
 * Migration 0017 (BACKLOG T408): files of permanently deleted records.
 *
 * - `record_purged_at`: the record holding the file was permanently deleted
 *   (trash purge, manual or after 30 days). The row stays until the
 *   `attachments.cleanup` cron deletes it — and the object with its
 *   thumbnails once no other row shares the `object_key` (copies, BACKLOG
 *   S4 #12) —, so object deletion never runs inside the purge transaction
 *   and a storage failure is simply retried by the next run.
 *
 * Addition to SPEC §5.10 (reported in T408). Self-contained: no function or
 * table of a later migration is used, so its number can change at merge.
 *
 * This file is locked by `migrations.lock.json`: never edit it once merged.
 */

const STATEMENTS = [
  'ALTER TABLE meta.attachments ADD COLUMN record_purged_at timestamptz',
  `CREATE INDEX attachments_record_purged_idx ON meta.attachments (record_purged_at)
     WHERE record_purged_at IS NOT NULL`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
