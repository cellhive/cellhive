import { sql, type Kysely } from 'kysely';

/**
 * Migration 0054 (BACKLOG T906; ADR-39 §1, §6, SPEC §5.10, CONTRACTS §24,
 * §29.1): AI settings of an organization, its daily usage ledger and the
 * `ai_api_key` secret kind.
 *
 * - `meta.secrets.kind` also takes `ai_api_key` (the key of the AI
 *   provider): bound to 1–20 hosts like the HTTP kinds but never in a
 *   transition period, and always for every base (`base_scope = 'all'`).
 * - `meta.ai_settings`: one row per organization (PK `organization_id`);
 *   the key is a secret (`api_key_secret_id`, composite FK, `SET NULL`),
 *   never a column. `token_param` `NULL` = the default for the host;
 *   `detected_output` = the rung "Test connection" found.
 * - `meta.ai_usage_daily`: tokens per organization, day (in the
 *   organization time zone) and feature, added up after every call; the
 *   quota reads today's sum. Kept 400 days (`maintenance.cleanup`, by
 *   `day`).
 *
 * Self-contained (only `meta.secrets` of 0036/0047/0051 and
 * `meta.organizations`), so its number can change at merge. This file is
 * locked by `migrations.lock.json`: never edit it once merged.
 */

const STATEMENTS = [
  `ALTER TABLE meta.secrets DROP CONSTRAINT secrets_kind_check`,
  `ALTER TABLE meta.secrets ADD CONSTRAINT secrets_kind_check
     CHECK (kind IN ('telegram_bot', 'http_header', 'webhook_signing', 'ai_api_key'))`,
  `ALTER TABLE meta.secrets DROP CONSTRAINT secrets_allowed_hosts_check`,
  `ALTER TABLE meta.secrets ADD CONSTRAINT secrets_allowed_hosts_check CHECK (
     array_position(allowed_hosts, NULL) IS NULL
     AND CASE
       WHEN kind IN ('http_header', 'webhook_signing')
         THEN cardinality(allowed_hosts) <= 20
              AND (cardinality(allowed_hosts) > 0) <> (legacy_hosts_until IS NOT NULL)
       WHEN kind = 'ai_api_key'
         THEN cardinality(allowed_hosts) BETWEEN 1 AND 20
              AND legacy_hosts_until IS NULL AND base_scope = 'all'
       ELSE cardinality(allowed_hosts) = 0 AND legacy_hosts_until IS NULL
     END)`,
  `CREATE TABLE meta.ai_settings (
     organization_id text PRIMARY KEY,
     enabled boolean NOT NULL DEFAULT false,
     provider_base_url text,
     model text,
     api_key_secret_id text,
     allow_record_data boolean NOT NULL DEFAULT false,
     log_prompts boolean NOT NULL DEFAULT false,
     daily_token_limit bigint DEFAULT 1000000,
     structured_output text NOT NULL DEFAULT 'auto',
     detected_output text,
     token_param text,
     request_timeout_seconds integer NOT NULL DEFAULT 60,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT ai_settings_org_fkey FOREIGN KEY (organization_id)
       REFERENCES meta.organizations (id) ON DELETE CASCADE,
     CONSTRAINT ai_settings_key_fkey FOREIGN KEY (organization_id, api_key_secret_id)
       REFERENCES meta.secrets (organization_id, id) ON DELETE SET NULL (api_key_secret_id),
     CONSTRAINT ai_settings_base_url_check
       CHECK (char_length(provider_base_url) BETWEEN 1 AND 2048),
     CONSTRAINT ai_settings_model_check CHECK (char_length(model) BETWEEN 1 AND 200),
     CONSTRAINT ai_settings_limit_check
       CHECK (daily_token_limit BETWEEN 10000 AND 1000000000),
     CONSTRAINT ai_settings_structured_output_check
       CHECK (structured_output IN ('auto', 'json_schema', 'json_object', 'prompt')),
     CONSTRAINT ai_settings_detected_output_check
       CHECK (detected_output IN ('json_schema', 'json_object', 'prompt')),
     CONSTRAINT ai_settings_token_param_check
       CHECK (token_param IN ('max_tokens', 'max_completion_tokens')),
     CONSTRAINT ai_settings_timeout_check CHECK (request_timeout_seconds BETWEEN 10 AND 120)
   )`,
  // The key FK's `ON DELETE SET NULL` when a secret is deleted.
  `CREATE INDEX ai_settings_key_idx ON meta.ai_settings (organization_id, api_key_secret_id)
     WHERE api_key_secret_id IS NOT NULL`,
  `CREATE TRIGGER ai_settings_set_updated_at BEFORE UPDATE ON meta.ai_settings
     FOR EACH ROW EXECUTE FUNCTION meta.set_updated_at()`,
  `CREATE TABLE meta.ai_usage_daily (
     organization_id text NOT NULL,
     day date NOT NULL,
     feature text NOT NULL,
     requests integer NOT NULL DEFAULT 0,
     prompt_tokens bigint NOT NULL DEFAULT 0,
     completion_tokens bigint NOT NULL DEFAULT 0,
     estimated_requests integer NOT NULL DEFAULT 0,
     PRIMARY KEY (organization_id, day, feature),
     CONSTRAINT ai_usage_daily_org_fkey FOREIGN KEY (organization_id)
       REFERENCES meta.organizations (id) ON DELETE CASCADE,
     CONSTRAINT ai_usage_daily_feature_check
       CHECK (feature IN ('formula', 'automation_draft', 'ask', 'field', 'action', 'test')),
     CONSTRAINT ai_usage_daily_counts_check CHECK (
       requests >= 0 AND prompt_tokens >= 0 AND completion_tokens >= 0
       AND estimated_requests BETWEEN 0 AND requests)
   )`,
  // Retention deletes by age across organizations (cron `maintenance.cleanup`).
  `CREATE INDEX ai_usage_daily_day_idx ON meta.ai_usage_daily (day)`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
