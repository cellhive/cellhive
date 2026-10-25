import { sql, type Kysely } from 'kysely';

/**
 * Migration 0047 (BACKLOG T606; ADR-35 §8, SPEC §5.10, CONTRACTS §24):
 * secrets for outbound HTTP.
 *
 * - `meta.secrets.kind` also takes `http_header` (the value of the auth
 *   header of `http_request`) and `webhook_signing` (a `whsec_…` Standard
 *   Webhooks signing secret). The CHECK of 0036 is replaced by a wider one
 *   that accepts every existing row.
 * - `previous_ciphertext` + `previous_expires_at`: the value a
 *   `webhook_signing` secret had before it was replaced, sealed like
 *   `ciphertext`, kept 24 hours so requests carry both signatures while
 *   receivers switch (ADR-22 §3). Both set or both `NULL`, and only on
 *   `webhook_signing` rows.
 *
 * Self-contained (only `meta.secrets` of 0036), so its number can change at
 * merge. This file is locked by `migrations.lock.json`: never edit it once
 * merged.
 */

const STATEMENTS = [
  `ALTER TABLE meta.secrets DROP CONSTRAINT secrets_kind_check`,
  `ALTER TABLE meta.secrets ADD CONSTRAINT secrets_kind_check
     CHECK (kind IN ('telegram_bot', 'http_header', 'webhook_signing'))`,
  `ALTER TABLE meta.secrets
     ADD COLUMN previous_ciphertext text,
     ADD COLUMN previous_expires_at timestamptz`,
  `ALTER TABLE meta.secrets ADD CONSTRAINT secrets_previous_check CHECK (
     (previous_ciphertext IS NULL) = (previous_expires_at IS NULL)
     AND (previous_ciphertext IS NULL OR
          (kind = 'webhook_signing' AND char_length(previous_ciphertext) > 0)))`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
