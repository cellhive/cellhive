import { sql, type Kysely } from 'kysely';

/**
 * Migration 0008 (BACKLOG T304): `meta.share_links` (SPEC §5.10, §15A) and
 * daily access counts.
 *
 * Additions to SPEC §5.10 (reported in T304):
 * - `table_id`: table of the target view/form (dashboards, S7, leave it
 *   null), so lists and history resolve a link without reading the target;
 * - `revoked_at`, `revoked_by`: a revoked link is kept (its token answers
 *   `410`, never a different link) but can never be turned on again; at most
 *   one link per target is not revoked;
 * - `meta.share_link_daily_stats`: accesses per link and UTC day (SPEC
 *   §15A.4). No IP address is stored.
 *
 * The token is never stored: only its SHA-256 (`token_hash`) and its first
 * six characters (`token_prefix`). This file is locked by
 * `migrations.lock.json`: never edit it once merged.
 */

const STATEMENTS = [
  `CREATE TABLE meta.share_links (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     base_id text NOT NULL,
     table_id text,
     target_type text NOT NULL,
     target_id text NOT NULL,
     audience text NOT NULL,
     token_prefix text NOT NULL,
     token_hash text NOT NULL,
     password_hash text,
     expires_at timestamptz,
     settings jsonb NOT NULL DEFAULT '{}'::jsonb,
     enabled boolean NOT NULL DEFAULT true,
     created_by text NOT NULL,
     revoked_at timestamptz,
     revoked_by text,
     last_accessed_at timestamptz,
     access_count bigint NOT NULL DEFAULT 0,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT share_links_organization_id_id_key UNIQUE (organization_id, id),
     CONSTRAINT share_links_token_hash_key UNIQUE (token_hash),
     CONSTRAINT share_links_base_fkey FOREIGN KEY (organization_id, base_id)
       REFERENCES meta.bases (organization_id, id) ON DELETE CASCADE,
     CONSTRAINT share_links_created_by_fkey FOREIGN KEY (created_by)
       REFERENCES meta.users (id) ON DELETE CASCADE,
     CONSTRAINT share_links_target_type_check CHECK (target_type IN ('view', 'form', 'dashboard')),
     CONSTRAINT share_links_audience_check CHECK (audience IN ('org', 'public')),
     CONSTRAINT share_links_table_check CHECK ((target_type = 'dashboard') = (table_id IS NULL)),
     CONSTRAINT share_links_revoked_check CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
     CONSTRAINT share_links_access_count_check CHECK (access_count >= 0)
   )`,
  `CREATE UNIQUE INDEX share_links_live_target_key
     ON meta.share_links (organization_id, target_type, target_id) WHERE revoked_at IS NULL`,
  'CREATE INDEX share_links_base_idx ON meta.share_links (organization_id, base_id, created_at)',
  `CREATE TRIGGER share_links_set_updated_at BEFORE UPDATE ON meta.share_links
     FOR EACH ROW EXECUTE FUNCTION meta.set_updated_at()`,
  `CREATE TABLE meta.share_link_daily_stats (
     organization_id text NOT NULL,
     share_link_id text NOT NULL,
     day date NOT NULL,
     access_count bigint NOT NULL DEFAULT 0,
     PRIMARY KEY (share_link_id, day),
     CONSTRAINT share_link_daily_stats_link_fkey FOREIGN KEY (organization_id, share_link_id)
       REFERENCES meta.share_links (organization_id, id) ON DELETE CASCADE,
     CONSTRAINT share_link_daily_stats_count_check CHECK (access_count >= 0)
   )`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
