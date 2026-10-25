import { sql, type Kysely } from 'kysely';

/**
 * Migration 0039 (BACKLOG T543; ADR-29 §1, ADR-34 §2): following records.
 *
 * `meta.record_follows` holds one row per (record, member) who follows it —
 * or unfollowed it by hand:
 *
 * - `source`: what started the follow — `manual` (the follow button),
 *   `created` (the member created the record by hand), `assigned` (added to
 *   a `user` field with `notify_on_assign`, T544). Comments (S11) will add
 *   `commented` with a new migration.
 * - `muted`: the member unfollowed by hand. The row stays so that no
 *   automatic source (creating, being assigned) follows the record again
 *   for them; only following by hand clears it (BACKLOG "Câu hỏi mở S5b" #2).
 *   Muted rows do not count towards the per-member cap.
 *
 * The record itself lives in `data.*` (no foreign key): purging a record
 * deletes its rows in the purge transaction, and so does purging its table
 * (the `meta.tables` row stays with `purged_at`). Every foreign key to a
 * tenant table is composite with `organization_id` (SPEC §5.10, T501 catalog
 * test) and cascades: leaving the organization or deleting the table row
 * deletes the rows. The primary key serves `followersOf(table, records)`;
 * `(organization_id, user_id)` counts a member's follows and serves the
 * membership cascade.
 *
 * `meta.notification_settings` gets the two personal switches of automatic
 * following (`auto_follow_created`, `auto_follow_assigned`), on by default.
 *
 * Self-contained: only `meta.set_updated_at()` (migration 0001) is used, so
 * its number can change at merge. This file is locked by
 * `migrations.lock.json`: never edit it once merged.
 */

const STATEMENTS = [
  `CREATE TABLE meta.record_follows (
     organization_id text NOT NULL,
     table_id text NOT NULL,
     record_id text NOT NULL,
     user_id text NOT NULL,
     source text NOT NULL,
     muted boolean NOT NULL DEFAULT false,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT record_follows_pkey PRIMARY KEY (organization_id, table_id, record_id, user_id),
     CONSTRAINT record_follows_member_fkey FOREIGN KEY (organization_id, user_id)
       REFERENCES meta.org_members (organization_id, user_id) ON DELETE CASCADE,
     CONSTRAINT record_follows_table_fkey FOREIGN KEY (organization_id, table_id)
       REFERENCES meta.tables (organization_id, id) ON DELETE CASCADE,
     CONSTRAINT record_follows_source_check CHECK (source IN ('manual', 'created', 'assigned')),
     CONSTRAINT record_follows_record_check CHECK (record_id LIKE 'rec\\_%')
   )`,
  `CREATE INDEX record_follows_user_idx ON meta.record_follows (organization_id, user_id)`,
  `CREATE TRIGGER record_follows_set_updated_at
     BEFORE UPDATE ON meta.record_follows
     FOR EACH ROW EXECUTE FUNCTION meta.set_updated_at()`,
  `ALTER TABLE meta.notification_settings
     ADD COLUMN auto_follow_created boolean NOT NULL DEFAULT true,
     ADD COLUMN auto_follow_assigned boolean NOT NULL DEFAULT true`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
