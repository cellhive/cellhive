import { sql, type Kysely } from 'kysely';

/**
 * Migration 0036 (BACKLOG T516, SPEC §5.10): secrets of an organization.
 * Self-contained: no object of another migration than 0001–0033 is used.
 *
 * - `meta.secrets`: a credential automations use (`kind = telegram_bot`:
 *   the bot token of `send_telegram`), managed by organization
 *   owners/admins. `ciphertext` = the value sealed with AES-256-GCM under a
 *   key derived from `APP_MASTER_KEY` (HKDF, `info = org-secret:v1`),
 *   never returned, logged or audited. `name` is unique in the
 *   organization (case-insensitive). `base_scope` like sender identities
 *   (ADR-33): `all` bases or the `selected` ones.
 * - `meta.secret_bases`: the bases of a `selected` scope.
 *
 * Every foreign key between tenant tables is composite with
 * `organization_id` (SPEC §5.10, T501). Static DDL on `meta.*` only.
 *
 * This file is locked by `migrations.lock.json`: never edit it once merged.
 */

const STATEMENTS = [
  `CREATE TABLE meta.secrets (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     kind text NOT NULL,
     name text NOT NULL,
     ciphertext text NOT NULL,
     base_scope text NOT NULL DEFAULT 'all',
     created_by text REFERENCES meta.users (id) ON DELETE SET NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT secrets_org_fkey FOREIGN KEY (organization_id)
       REFERENCES meta.organizations (id) ON DELETE CASCADE,
     CONSTRAINT secrets_organization_id_id_key UNIQUE (organization_id, id),
     CONSTRAINT secrets_kind_check CHECK (kind IN ('telegram_bot')),
     CONSTRAINT secrets_name_check CHECK (char_length(name) BETWEEN 1 AND 100),
     CONSTRAINT secrets_ciphertext_check CHECK (char_length(ciphertext) > 0),
     CONSTRAINT secrets_base_scope_check CHECK (base_scope IN ('all', 'selected'))
   )`,
  `CREATE UNIQUE INDEX secrets_organization_id_name_key
     ON meta.secrets (organization_id, lower(name))`,
  `CREATE TRIGGER secrets_set_updated_at BEFORE UPDATE ON meta.secrets
     FOR EACH ROW EXECUTE FUNCTION meta.set_updated_at()`,

  `CREATE TABLE meta.secret_bases (
     organization_id text NOT NULL,
     secret_id text NOT NULL,
     base_id text NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (secret_id, base_id),
     CONSTRAINT secret_bases_secret_fkey FOREIGN KEY (organization_id, secret_id)
       REFERENCES meta.secrets (organization_id, id) ON DELETE CASCADE,
     CONSTRAINT secret_bases_base_fkey FOREIGN KEY (organization_id, base_id)
       REFERENCES meta.bases (organization_id, id) ON DELETE CASCADE
   )`,
  // The base cascade and "secrets usable in this base".
  `CREATE INDEX secret_bases_base_idx ON meta.secret_bases (organization_id, base_id)`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
