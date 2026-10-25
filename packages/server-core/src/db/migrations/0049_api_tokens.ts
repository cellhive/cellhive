import { sql, type Kysely } from 'kysely';

/**
 * Migration 0049 (BACKLOG T703; ADR-36 §1, SPEC §5.10, CONTRACTS §26):
 * personal API tokens.
 *
 * `meta.api_tokens` holds one token of one member of one organization:
 *
 * - `token_hash`: SHA-256 (32 bytes) of the whole `cht_…` token, unique in
 *   the instance — the only form of the token ever stored; `token_prefix`:
 *   the 8 characters after `cht_`, to recognise it;
 * - `scopes`: a non-empty subset of the closed list of CONTRACTS §26.2;
 *   `base_ids`: the bases it is limited to (`NULL` = every base of the
 *   owner);
 * - `expires_at` (`NULL` = never), `last_used_at` (written at most every
 *   5 minutes, T704), `revoked_at` + `revoked_by` (soft revocation; the row
 *   stays 90 days for audit and listings, then `maintenance.cleanup`
 *   deletes it).
 *
 * The owner reference is composite with `organization_id` to
 * `meta.org_members` and cascades (SPEC §5.10, T501 catalog test): leaving
 * the organization deletes the member's tokens. `revoked_by` only clears
 * that column when the revoking member leaves. The partial index serves
 * "tokens not revoked of a member" (the 50-token cap).
 *
 * Self-contained: no object of another migration than 0001 is used, so its
 * number can change at merge. This file is locked by
 * `migrations.lock.json`: never edit it once merged.
 */

const STATEMENTS = [
  `CREATE TABLE meta.api_tokens (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     user_id text NOT NULL,
     name text NOT NULL,
     token_prefix text NOT NULL,
     token_hash bytea NOT NULL,
     scopes text[] NOT NULL,
     base_ids text[],
     expires_at timestamptz,
     last_used_at timestamptz,
     revoked_at timestamptz,
     revoked_by text,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT api_tokens_org_fkey FOREIGN KEY (organization_id)
       REFERENCES meta.organizations (id) ON DELETE CASCADE,
     CONSTRAINT api_tokens_owner_fkey FOREIGN KEY (organization_id, user_id)
       REFERENCES meta.org_members (organization_id, user_id) ON DELETE CASCADE,
     CONSTRAINT api_tokens_revoked_by_fkey FOREIGN KEY (organization_id, revoked_by)
       REFERENCES meta.org_members (organization_id, user_id) ON DELETE SET NULL (revoked_by),
     CONSTRAINT api_tokens_token_hash_key UNIQUE (token_hash),
     CONSTRAINT api_tokens_organization_id_id_key UNIQUE (organization_id, id),
     CONSTRAINT api_tokens_id_check CHECK (id LIKE 'tok\\_%'),
     CONSTRAINT api_tokens_name_check CHECK (char_length(name) BETWEEN 1 AND 100),
     CONSTRAINT api_tokens_token_prefix_check CHECK (token_prefix ~ '^[0-9A-Za-z]{8}$'),
     CONSTRAINT api_tokens_token_hash_check CHECK (octet_length(token_hash) = 32),
     CONSTRAINT api_tokens_scopes_check CHECK (
       cardinality(scopes) >= 1
       AND scopes <@ ARRAY['records:read', 'records:write', 'schema:read', 'schema:write',
                           'automations:read', 'automations:write']::text[]),
     CONSTRAINT api_tokens_base_ids_check CHECK (
       base_ids IS NULL OR cardinality(base_ids) BETWEEN 1 AND 50),
     CONSTRAINT api_tokens_revoked_by_check CHECK (revoked_by IS NULL OR revoked_at IS NOT NULL)
   )`,
  `CREATE INDEX api_tokens_active_idx ON meta.api_tokens (organization_id, user_id)
     WHERE revoked_at IS NULL`,
  // The revoker FK's `ON DELETE SET NULL` when a member leaves.
  `CREATE INDEX api_tokens_revoked_by_idx ON meta.api_tokens (organization_id, revoked_by)
     WHERE revoked_by IS NOT NULL`,
  `CREATE TRIGGER api_tokens_set_updated_at BEFORE UPDATE ON meta.api_tokens
     FOR EACH ROW EXECUTE FUNCTION meta.set_updated_at()`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
