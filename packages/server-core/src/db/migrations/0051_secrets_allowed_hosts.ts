import { sql, type Kysely } from 'kysely';

/**
 * Migration 0051 (BACKLOG T701; ADR-36 §4, SPEC §5.10, CONTRACTS §24): HTTP
 * secrets bound to the hosts they may be sent to (QA S5c M4).
 *
 * - `meta.secrets.allowed_hosts text[]`: canonical host patterns (like
 *   `meta.http_allowlist.pattern`) an `http_header` / `webhook_signing`
 *   secret may be sent to; always `{}` for other kinds.
 * - `legacy_hosts_until`: HTTP secrets that exist now have no list; they
 *   keep being sent to any host for 30 days, then fail with
 *   `secret_host_not_allowed` (`legacy_expired`) until a list is set (which
 *   clears this column).
 * - CHECK: an HTTP secret has either a list (1–20 entries, no NULL) or a
 *   transition deadline, never both nor neither; other kinds have neither.
 *
 * Self-contained (only `meta.secrets` of 0036/0047), so its number can
 * change at merge. This file is locked by `migrations.lock.json`: never edit
 * it once merged.
 */

const STATEMENTS = [
  `ALTER TABLE meta.secrets
     ADD COLUMN allowed_hosts text[] NOT NULL DEFAULT '{}',
     ADD COLUMN legacy_hosts_until timestamptz`,
  `UPDATE meta.secrets
      SET legacy_hosts_until = now() + interval '30 days'
    WHERE kind IN ('http_header', 'webhook_signing')`,
  `ALTER TABLE meta.secrets ADD CONSTRAINT secrets_allowed_hosts_check CHECK (
     array_position(allowed_hosts, NULL) IS NULL
     AND CASE WHEN kind IN ('http_header', 'webhook_signing')
       THEN cardinality(allowed_hosts) <= 20
            AND (cardinality(allowed_hosts) > 0) <> (legacy_hosts_until IS NOT NULL)
       ELSE cardinality(allowed_hosts) = 0 AND legacy_hosts_until IS NULL
     END)`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
