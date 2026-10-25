import { sql, type Kysely } from 'kysely';

/**
 * Migration 0038 (BACKLOG T542; ADR-34 §2): the grouping buffer of
 * notifications.
 *
 * `meta.notification_buffer` holds what bulk writes would otherwise turn
 * into one notification job per event: a row per (group, record[, user])
 * appended in the transaction of `events.dispatch`, gathered by
 * `notifications.flush` into one notification per recipient and deleted in
 * the flush transaction.
 *
 * - `kind`: `assigned` (bulk `record.assigned`, `group_key = batch.id`) or
 *   `followed` (`record.followed_changed`, `group_key = record id`).
 * - `user_id`: the recipient when the producer knows it (`assigned`); NULL
 *   when the flush computes the recipients (`followed`: the followers).
 * - `field_ids`: the fields of the change (assigned `user` fields, changed
 *   fields); `actor_*`: who made the change.
 *
 * Every foreign key to a tenant table is composite with `organization_id`
 * (SPEC §5.10, T501 catalog test): leaving the organization or deleting the
 * table deletes the rows. `(organization_id, kind, group_key)` finds a group;
 * `created_at` finds the rows whose flush job was lost (cron
 * `notifications.cleanup`). Self-contained: no function or table of a later
 * migration is used, so its number can change at merge.
 *
 * This file is locked by `migrations.lock.json`: never edit it once merged.
 */

const STATEMENTS = [
  `CREATE TABLE meta.notification_buffer (
     id bigint GENERATED ALWAYS AS IDENTITY,
     organization_id text NOT NULL,
     kind text NOT NULL,
     group_key text NOT NULL,
     user_id text,
     table_id text NOT NULL,
     record_id text NOT NULL,
     field_ids text[] NOT NULL DEFAULT '{}'::text[],
     actor_type text,
     actor_id text,
     created_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT notification_buffer_pkey PRIMARY KEY (organization_id, id),
     CONSTRAINT notification_buffer_member_fkey FOREIGN KEY (organization_id, user_id)
       REFERENCES meta.org_members (organization_id, user_id) ON DELETE CASCADE,
     CONSTRAINT notification_buffer_table_fkey FOREIGN KEY (organization_id, table_id)
       REFERENCES meta.tables (organization_id, id) ON DELETE CASCADE,
     CONSTRAINT notification_buffer_kind_check CHECK (kind IN ('assigned', 'followed')),
     CONSTRAINT notification_buffer_group_key_check
       CHECK (char_length(group_key) BETWEEN 1 AND 200),
     CONSTRAINT notification_buffer_record_check CHECK (record_id LIKE 'rec\\_%'),
     CONSTRAINT notification_buffer_actor_check
       CHECK ((actor_type IS NULL) = (actor_id IS NULL))
   )`,
  `CREATE INDEX notification_buffer_group_idx
     ON meta.notification_buffer (organization_id, kind, group_key)`,
  'CREATE INDEX notification_buffer_created_at_idx ON meta.notification_buffer (created_at)',
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
