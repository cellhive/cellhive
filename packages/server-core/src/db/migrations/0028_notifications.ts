import { sql, type Kysely } from 'kysely';

/**
 * Migration 0028 (BACKLOG T511; ADR-29 §1, ADR-32 §1): in-app notification
 * infrastructure.
 *
 * - `meta.notifications`: one row per recipient. `payload` holds ids and
 *   stored-form parameters only (ADR-29), except the content rendered for
 *   that recipient of `automation.message` (ADR-32 §1). `in_app = false`:
 *   the user turned the in-app channel of the type off, the row only exists
 *   for another channel (email). `group_key`: producers' idempotency key —
 *   at most one row per (user, type, group_key).
 * - `meta.notification_deliveries`: the outbox of non in-app channels
 *   (`email`; Telegram from S5b): a `pending` row is "an email is queued"
 *   (sent, grouped and marked by T512, idempotency `ntf_id:channel`).
 * - `meta.notification_preferences`: per user, type and channel; no row =
 *   the type default (CONTRACTS §22).
 * - `meta.notification_settings`: per user and organization, the email
 *   frequency (`immediate | daily | off`) and the daily digest hour.
 * - `meta.notification_base_mutes`: bases a user muted (no email, in-app
 *   still recorded; mandatory types are never muted).
 *
 * Every foreign key to a tenant table is composite with `organization_id`
 * (SPEC §5.10, T501 catalog test); recipients reference the membership, so
 * leaving the organization deletes them. Self-contained: no function or
 * table of a later migration is used, so its number can change at merge.
 *
 * This file is locked by `migrations.lock.json`: never edit it once merged.
 */

const STATEMENTS = [
  `CREATE TABLE meta.notifications (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     user_id text NOT NULL,
     type text NOT NULL,
     base_id text,
     table_id text,
     entity_type text NOT NULL,
     entity_id text NOT NULL,
     actor_type text,
     actor_id text,
     group_key text,
     payload jsonb NOT NULL DEFAULT '{}'::jsonb,
     in_app boolean NOT NULL DEFAULT true,
     read_at timestamptz,
     created_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT notifications_organization_id_id_key UNIQUE (organization_id, id),
     CONSTRAINT notifications_member_fkey FOREIGN KEY (organization_id, user_id)
       REFERENCES meta.org_members (organization_id, user_id) ON DELETE CASCADE,
     CONSTRAINT notifications_base_fkey FOREIGN KEY (organization_id, base_id)
       REFERENCES meta.bases (organization_id, id) ON DELETE CASCADE,
     CONSTRAINT notifications_table_fkey FOREIGN KEY (organization_id, table_id)
       REFERENCES meta.tables (organization_id, id) ON DELETE CASCADE,
     CONSTRAINT notifications_id_check CHECK (id LIKE 'ntf\\_%'),
     CONSTRAINT notifications_actor_check
       CHECK ((actor_type IS NULL) = (actor_id IS NULL)),
     CONSTRAINT notifications_payload_check CHECK (jsonb_typeof(payload) = 'object')
   )`,
  // The list and the unread count (ADR-29 §1).
  `CREATE INDEX notifications_user_idx
     ON meta.notifications (organization_id, user_id, read_at, created_at DESC, id DESC)
     WHERE in_app`,
  `CREATE INDEX notifications_user_base_idx
     ON meta.notifications (organization_id, user_id, base_id, created_at DESC, id DESC)
     WHERE in_app AND base_id IS NOT NULL`,
  `CREATE UNIQUE INDEX notifications_group_key
     ON meta.notifications (organization_id, user_id, type, group_key)
     WHERE group_key IS NOT NULL`,
  // Retention (NOTIFICATION_RETENTION_DAYS) and purges by entity.
  'CREATE INDEX notifications_created_at_idx ON meta.notifications (created_at)',
  `CREATE INDEX notifications_entity_idx
     ON meta.notifications (organization_id, entity_type, entity_id)`,
  `CREATE TABLE meta.notification_deliveries (
     organization_id text NOT NULL,
     notification_id text NOT NULL,
     channel text NOT NULL,
     status text NOT NULL DEFAULT 'pending',
     attempts integer NOT NULL DEFAULT 0,
     error_code text,
     created_at timestamptz NOT NULL DEFAULT now(),
     sent_at timestamptz,
     CONSTRAINT notification_deliveries_pkey PRIMARY KEY (notification_id, channel),
     CONSTRAINT notification_deliveries_notification_fkey
       FOREIGN KEY (organization_id, notification_id)
       REFERENCES meta.notifications (organization_id, id) ON DELETE CASCADE,
     CONSTRAINT notification_deliveries_channel_check CHECK (channel IN ('email')),
     CONSTRAINT notification_deliveries_status_check
       CHECK (status IN ('pending', 'sent', 'skipped', 'failed')),
     CONSTRAINT notification_deliveries_attempts_check CHECK (attempts >= 0)
   )`,
  `CREATE INDEX notification_deliveries_pending_idx
     ON meta.notification_deliveries (organization_id, channel, created_at)
     WHERE status = 'pending'`,
  `CREATE TABLE meta.notification_preferences (
     organization_id text NOT NULL,
     user_id text NOT NULL,
     type text NOT NULL,
     channel text NOT NULL,
     enabled boolean NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT notification_preferences_pkey PRIMARY KEY (organization_id, user_id, type, channel),
     CONSTRAINT notification_preferences_member_fkey FOREIGN KEY (organization_id, user_id)
       REFERENCES meta.org_members (organization_id, user_id) ON DELETE CASCADE,
     CONSTRAINT notification_preferences_channel_check CHECK (channel IN ('in_app', 'email'))
   )`,
  `CREATE TABLE meta.notification_settings (
     organization_id text NOT NULL,
     user_id text NOT NULL,
     email_frequency text NOT NULL DEFAULT 'immediate',
     daily_hour smallint NOT NULL DEFAULT 8,
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT notification_settings_pkey PRIMARY KEY (organization_id, user_id),
     CONSTRAINT notification_settings_member_fkey FOREIGN KEY (organization_id, user_id)
       REFERENCES meta.org_members (organization_id, user_id) ON DELETE CASCADE,
     CONSTRAINT notification_settings_frequency_check
       CHECK (email_frequency IN ('immediate', 'daily', 'off')),
     CONSTRAINT notification_settings_daily_hour_check CHECK (daily_hour BETWEEN 0 AND 23)
   )`,
  `CREATE TABLE meta.notification_base_mutes (
     organization_id text NOT NULL,
     user_id text NOT NULL,
     base_id text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT notification_base_mutes_pkey PRIMARY KEY (organization_id, user_id, base_id),
     CONSTRAINT notification_base_mutes_member_fkey FOREIGN KEY (organization_id, user_id)
       REFERENCES meta.org_members (organization_id, user_id) ON DELETE CASCADE,
     CONSTRAINT notification_base_mutes_base_fkey FOREIGN KEY (organization_id, base_id)
       REFERENCES meta.bases (organization_id, id) ON DELETE CASCADE
   )`,
  `CREATE INDEX notification_base_mutes_base_idx
     ON meta.notification_base_mutes (organization_id, base_id)`,
  `CREATE TRIGGER notification_preferences_set_updated_at
     BEFORE UPDATE ON meta.notification_preferences
     FOR EACH ROW EXECUTE FUNCTION meta.set_updated_at()`,
  `CREATE TRIGGER notification_settings_set_updated_at
     BEFORE UPDATE ON meta.notification_settings
     FOR EACH ROW EXECUTE FUNCTION meta.set_updated_at()`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
