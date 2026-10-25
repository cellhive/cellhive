import { sql, type Kysely } from 'kysely';

/**
 * Migration 0043 (BACKLOG T602; ADR-35 §1, SPEC §5.10, §13.2, CONTRACTS
 * §25.1): incoming webhooks and their raw requests.
 *
 * `meta.incoming_webhooks` — a hook of a base, managed by base admins:
 *
 * - `token_hash`: hex SHA-256 of the 32-byte URL token, unique across the
 *   instance (the public route finds the hook by it, a cross-tenant lookup);
 *   `token_enc`: the token sealed with AES-256-GCM (HKDF `info =
 *   incoming-webhook:v1`) so base admins can read the URL again;
 * - `signing_secret_enc` (+ `signing_secret_prev_enc` and its expiry during
 *   the 24 h of a rotation): the Standard Webhooks secret, sealed under
 *   `incoming-webhook-signing:v1`; `bearer_hash`: hex SHA-256 of the
 *   Bearer token. `auth` says which checks apply and always agrees with the
 *   credentials present (CHECK);
 * - `rate_limit_per_sec` (burst 4×; the instance caps it with
 *   `WEBHOOK_MAX_RATE_PER_SEC`), `listen_until`/`listened_by`/`sample`/
 *   `sample_captured_at` (listen for a sample request — T603), `enabled`,
 *   `deleted_at` (soft delete; the token stays reserved).
 *
 * `meta.incoming_webhook_requests` — one row per accepted request, kept
 * 7 days (`purgeExpiredOperationalRows`): body, filtered headers, query,
 * size, the `webhook-id` (`message_id`, deduplicated per hook by the
 * `UNIQUE`; `NULL` without a signing secret — no dedupe), whether a
 * causation token was accepted and the `webhook.received` event. A replay
 * may be logged as `duplicate` with no `message_id`, body or event.
 *
 * Tenant keys are composite (SPEC §5.10, T501 catalog test): the base and
 * the hook cascade, member references only clear their column
 * (`ON DELETE SET NULL (col)`).
 *
 * Self-contained: no object of another migration than 0001/0003 is used, so
 * its number can change at merge. This file is locked by
 * `migrations.lock.json`: never edit it once merged.
 */

const STATEMENTS = [
  `CREATE TABLE meta.incoming_webhooks (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     base_id text NOT NULL,
     name text NOT NULL,
     token_hash text NOT NULL,
     token_enc text NOT NULL,
     auth text NOT NULL,
     signing_secret_enc text,
     signing_secret_prev_enc text,
     signing_secret_prev_expires_at timestamptz,
     bearer_hash text,
     rate_limit_per_sec integer NOT NULL DEFAULT 5,
     listen_until timestamptz,
     listened_by text,
     sample jsonb,
     sample_captured_at timestamptz,
     enabled boolean NOT NULL DEFAULT true,
     created_by text,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     deleted_at timestamptz,
     CONSTRAINT incoming_webhooks_org_fkey FOREIGN KEY (organization_id)
       REFERENCES meta.organizations (id) ON DELETE CASCADE,
     CONSTRAINT incoming_webhooks_base_fkey FOREIGN KEY (organization_id, base_id)
       REFERENCES meta.bases (organization_id, id) ON DELETE CASCADE,
     CONSTRAINT incoming_webhooks_creator_fkey FOREIGN KEY (organization_id, created_by)
       REFERENCES meta.org_members (organization_id, user_id) ON DELETE SET NULL (created_by),
     CONSTRAINT incoming_webhooks_listener_fkey FOREIGN KEY (organization_id, listened_by)
       REFERENCES meta.org_members (organization_id, user_id) ON DELETE SET NULL (listened_by),
     CONSTRAINT incoming_webhooks_organization_id_id_key UNIQUE (organization_id, id),
     CONSTRAINT incoming_webhooks_token_hash_key UNIQUE (token_hash),
     CONSTRAINT incoming_webhooks_id_check CHECK (id LIKE 'hok\\_%'),
     CONSTRAINT incoming_webhooks_name_check CHECK (char_length(name) BETWEEN 1 AND 100),
     CONSTRAINT incoming_webhooks_token_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
     CONSTRAINT incoming_webhooks_bearer_hash_check
       CHECK (bearer_hash IS NULL OR bearer_hash ~ '^[0-9a-f]{64}$'),
     CONSTRAINT incoming_webhooks_auth_check
       CHECK (auth IN ('signature', 'bearer', 'both', 'none')),
     CONSTRAINT incoming_webhooks_auth_signature_check
       CHECK ((auth IN ('signature', 'both')) = (signing_secret_enc IS NOT NULL)),
     CONSTRAINT incoming_webhooks_auth_bearer_check
       CHECK ((auth IN ('bearer', 'both')) = (bearer_hash IS NOT NULL)),
     CONSTRAINT incoming_webhooks_prev_secret_check
       CHECK ((signing_secret_prev_enc IS NULL) = (signing_secret_prev_expires_at IS NULL)
              AND (signing_secret_prev_enc IS NULL OR signing_secret_enc IS NOT NULL)),
     CONSTRAINT incoming_webhooks_rate_check CHECK (rate_limit_per_sec BETWEEN 1 AND 1000),
     CONSTRAINT incoming_webhooks_sample_check
       CHECK ((sample IS NULL) = (sample_captured_at IS NULL))
   )`,
  `CREATE TRIGGER incoming_webhooks_set_updated_at BEFORE UPDATE ON meta.incoming_webhooks
     FOR EACH ROW EXECUTE FUNCTION meta.set_updated_at()`,
  // Names are unique in a base among live hooks, case-insensitive.
  `CREATE UNIQUE INDEX incoming_webhooks_base_name_key
     ON meta.incoming_webhooks (organization_id, base_id, lower(name))
     WHERE deleted_at IS NULL`,
  `CREATE INDEX incoming_webhooks_base_idx
     ON meta.incoming_webhooks (organization_id, base_id, created_at)
     WHERE deleted_at IS NULL`,
  // The member FKs' `ON DELETE SET NULL` when a member leaves.
  `CREATE INDEX incoming_webhooks_created_by_idx ON meta.incoming_webhooks (organization_id, created_by)
     WHERE created_by IS NOT NULL`,
  `CREATE INDEX incoming_webhooks_listened_by_idx ON meta.incoming_webhooks (organization_id, listened_by)
     WHERE listened_by IS NOT NULL`,

  `CREATE TABLE meta.incoming_webhook_requests (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     incoming_webhook_id text NOT NULL,
     message_id text,
     received_at timestamptz NOT NULL DEFAULT now(),
     body jsonb,
     headers jsonb NOT NULL DEFAULT '{}'::jsonb,
     query jsonb NOT NULL DEFAULT '{}'::jsonb,
     size_bytes integer NOT NULL,
     duplicate boolean NOT NULL DEFAULT false,
     causation_accepted boolean NOT NULL DEFAULT false,
     event_id text,
     CONSTRAINT incoming_webhook_requests_org_fkey FOREIGN KEY (organization_id)
       REFERENCES meta.organizations (id) ON DELETE CASCADE,
     CONSTRAINT incoming_webhook_requests_hook_fkey FOREIGN KEY (organization_id, incoming_webhook_id)
       REFERENCES meta.incoming_webhooks (organization_id, id) ON DELETE CASCADE,
     CONSTRAINT incoming_webhook_requests_organization_id_id_key UNIQUE (organization_id, id),
     CONSTRAINT incoming_webhook_requests_message_key
       UNIQUE (organization_id, incoming_webhook_id, message_id),
     CONSTRAINT incoming_webhook_requests_id_check CHECK (id LIKE 'whr\\_%'),
     CONSTRAINT incoming_webhook_requests_message_id_check
       CHECK (message_id IS NULL OR char_length(message_id) BETWEEN 1 AND 256),
     CONSTRAINT incoming_webhook_requests_size_check CHECK (size_bytes BETWEEN 0 AND 1048576),
     CONSTRAINT incoming_webhook_requests_duplicate_check
       CHECK (NOT duplicate OR (message_id IS NULL AND event_id IS NULL AND body IS NULL))
   )`,
  // The request log of a hook, newest first (keyset on received_at, id).
  `CREATE INDEX incoming_webhook_requests_hook_idx
     ON meta.incoming_webhook_requests (organization_id, incoming_webhook_id, received_at DESC, id DESC)`,
  // Retention: rows older than 7 days, every organization.
  `CREATE INDEX incoming_webhook_requests_received_idx
     ON meta.incoming_webhook_requests (received_at)`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
