import { sql, type Kysely } from 'kysely';

/**
 * Migration 0046 (BACKLOG T609; ADR-35 §7, SPEC §5.10, CONTRACTS §22.7): the
 * webhook of an organization's notification bot.
 *
 * `meta.telegram_webhooks` holds at most one row per organization — the
 * organization whose notification bot is in `webhook` mode
 * (`organizations.settings.notifications.telegram_delivery_mode`):
 *
 * - `path_token_hash`: hex SHA-256 of the 24-byte path token of the webhook
 *   URL (`PUBLIC_URL/api/v1/telegram/webhook/<path token>`), unique across
 *   the instance (the public route finds the organization by it, a
 *   cross-tenant lookup); the token itself is never stored;
 * - `secret_token_enc`: the `secret_token` Telegram sends back in
 *   `X-Telegram-Bot-Api-Secret-Token`, sealed with AES-256-GCM (HKDF
 *   `info = telegram-webhook:v1`);
 * - `registered_url`: the URL registered **without** the path token (the
 *   `PUBLIC_URL` prefix, to notice a changed `PUBLIC_URL`);
 * - `status`, `last_error_code`, `last_checked_at`: what the hourly
 *   `notifications.telegram_webhook_check` last saw (never the error text).
 *
 * Kept apart from `meta.secrets` (that list is the secrets members manage,
 * Quyết định S5c #14). The secret FK is composite with `organization_id`
 * (SPEC §5.10, T501 catalog test) and cascades: no bot, no webhook.
 *
 * Self-contained: no object of another migration than 0001 and 0036 is
 * used, so its number can change at merge. This file is locked by
 * `migrations.lock.json`: never edit it once merged.
 */

const STATEMENTS = [
  `CREATE TABLE meta.telegram_webhooks (
     organization_id text PRIMARY KEY,
     secret_id text NOT NULL,
     path_token_hash text NOT NULL,
     secret_token_enc text NOT NULL,
     registered_url text NOT NULL,
     status text NOT NULL DEFAULT 'ok',
     last_error_code text,
     last_checked_at timestamptz,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT telegram_webhooks_org_fkey FOREIGN KEY (organization_id)
       REFERENCES meta.organizations (id) ON DELETE CASCADE,
     CONSTRAINT telegram_webhooks_secret_fkey FOREIGN KEY (organization_id, secret_id)
       REFERENCES meta.secrets (organization_id, id) ON DELETE CASCADE,
     CONSTRAINT telegram_webhooks_path_token_hash_key UNIQUE (path_token_hash),
     CONSTRAINT telegram_webhooks_path_token_hash_check CHECK (path_token_hash ~ '^[0-9a-f]{64}$'),
     CONSTRAINT telegram_webhooks_registered_url_check CHECK (
       registered_url LIKE 'https://%' AND char_length(registered_url) <= 2048),
     CONSTRAINT telegram_webhooks_status_check CHECK (status IN ('ok', 'error')),
     CONSTRAINT telegram_webhooks_error_check CHECK (last_error_code IS NULL OR
       last_error_code IN ('delivery_failed', 'webhook_conflict', 'invalid_token'))
   )`,
  // The secret FK's cascade is served by the primary key (one row per organization).
  `CREATE TRIGGER telegram_webhooks_set_updated_at BEFORE UPDATE ON meta.telegram_webhooks
     FOR EACH ROW EXECUTE FUNCTION meta.set_updated_at()`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
