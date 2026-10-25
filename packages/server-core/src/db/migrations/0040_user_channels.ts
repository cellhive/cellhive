import { sql, type Kysely } from 'kysely';

/**
 * Migration 0040 (BACKLOG T549; ADR-34 §3, CONTRACTS §22.7): personal
 * Telegram channels of notifications, linked through the organization's
 * notification bot.
 *
 * - `meta.user_channels`: one channel per (organization, member, kind).
 *   `secret_id` = the notification bot (a `telegram_bot` secret) the chat
 *   was linked through. `address_enc` = the chat id sealed with AES-256-GCM
 *   under a key derived from `APP_MASTER_KEY` (HKDF, `info =
 *   user-channel:v1`); `address_hmac` = HMAC-SHA256 of the bot and the
 *   chat under another derived key (`user-channel-lookup:v1`), so a
 *   `/stop` from a chat finds its channels without the chat id ever being
 *   stored in clear. `status` `linked | error` with `error_reason`
 *   (`bot_changed | blocked`). The secret's FK sets `secret_id` to NULL
 *   on delete (a notification bot cannot be deleted, `409`; the column is
 *   only a record of which bot the chat knows).
 * - `meta.user_channel_link_tokens`: one-time link tokens (`/start
 *   <token>`): only the SHA-256 of the token is stored (`token_hash`), with
 *   the bot it was created for, its expiry (10 minutes) and when it was used.
 *   Rows also count the links created in the last hour (5 per user).
 * - The channel CHECKs of `meta.notification_preferences` and
 *   `meta.notification_deliveries` (0028) accept `telegram` (deliveries and
 *   preferences of T550). 0028 is never edited: the constraints are dropped
 *   and added again here, validated against the S5 rows (all `in_app` /
 *   `email`).
 *
 * Every foreign key to a tenant table is composite with `organization_id`
 * (SPEC §5.10, T501 catalog test): leaving the organization (membership
 * deleted) deletes the channel and the tokens. Self-contained: no function
 * or table of a later migration is used, so its number can change at merge.
 *
 * This file is locked by `migrations.lock.json`: never edit it once merged.
 */

const STATEMENTS = [
  `CREATE TABLE meta.user_channels (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     user_id text NOT NULL,
     kind text NOT NULL,
     secret_id text,
     address_enc text NOT NULL,
     address_hmac text NOT NULL,
     status text NOT NULL DEFAULT 'linked',
     error_reason text,
     linked_at timestamptz NOT NULL DEFAULT now(),
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT user_channels_organization_id_id_key UNIQUE (organization_id, id),
     CONSTRAINT user_channels_member_kind_key UNIQUE (organization_id, user_id, kind),
     CONSTRAINT user_channels_member_fkey FOREIGN KEY (organization_id, user_id)
       REFERENCES meta.org_members (organization_id, user_id) ON DELETE CASCADE,
     CONSTRAINT user_channels_secret_fkey FOREIGN KEY (organization_id, secret_id)
       REFERENCES meta.secrets (organization_id, id) ON DELETE SET NULL (secret_id),
     CONSTRAINT user_channels_id_check CHECK (id LIKE 'uch\\_%'),
     CONSTRAINT user_channels_kind_check CHECK (kind IN ('telegram')),
     CONSTRAINT user_channels_status_check CHECK (status IN ('linked', 'error')),
     CONSTRAINT user_channels_error_reason_check
       CHECK ((status = 'error') = (error_reason IS NOT NULL)
              AND (error_reason IS NULL OR error_reason IN ('bot_changed', 'blocked'))),
     CONSTRAINT user_channels_address_check
       CHECK (char_length(address_enc) > 0 AND char_length(address_hmac) = 64)
   )`,
  // `/stop` from a chat: its channels through this bot.
  `CREATE INDEX user_channels_address_idx
     ON meta.user_channels (organization_id, secret_id, address_hmac)`,
  `CREATE TRIGGER user_channels_set_updated_at BEFORE UPDATE ON meta.user_channels
     FOR EACH ROW EXECUTE FUNCTION meta.set_updated_at()`,

  `CREATE TABLE meta.user_channel_link_tokens (
     organization_id text NOT NULL,
     token_hash text NOT NULL,
     user_id text NOT NULL,
     kind text NOT NULL DEFAULT 'telegram',
     secret_id text NOT NULL,
     expires_at timestamptz NOT NULL,
     used_at timestamptz,
     created_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT user_channel_link_tokens_pkey PRIMARY KEY (organization_id, token_hash),
     CONSTRAINT user_channel_link_tokens_member_fkey FOREIGN KEY (organization_id, user_id)
       REFERENCES meta.org_members (organization_id, user_id) ON DELETE CASCADE,
     CONSTRAINT user_channel_link_tokens_secret_fkey FOREIGN KEY (organization_id, secret_id)
       REFERENCES meta.secrets (organization_id, id) ON DELETE CASCADE,
     CONSTRAINT user_channel_link_tokens_kind_check CHECK (kind IN ('telegram')),
     CONSTRAINT user_channel_link_tokens_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
     CONSTRAINT user_channel_link_tokens_expiry_check CHECK (expires_at > created_at)
   )`,
  // Pending links of a user (limits, `pending` status) and of a bot (poller).
  `CREATE INDEX user_channel_link_tokens_user_idx
     ON meta.user_channel_link_tokens (organization_id, user_id, created_at)`,
  `CREATE INDEX user_channel_link_tokens_pending_idx
     ON meta.user_channel_link_tokens (expires_at, organization_id, secret_id)
     WHERE used_at IS NULL`,

  `ALTER TABLE meta.notification_preferences
     DROP CONSTRAINT notification_preferences_channel_check`,
  `ALTER TABLE meta.notification_preferences
     ADD CONSTRAINT notification_preferences_channel_check
     CHECK (channel IN ('in_app', 'email', 'telegram'))`,
  `ALTER TABLE meta.notification_deliveries
     DROP CONSTRAINT notification_deliveries_channel_check`,
  `ALTER TABLE meta.notification_deliveries
     ADD CONSTRAINT notification_deliveries_channel_check
     CHECK (channel IN ('email', 'telegram'))`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
