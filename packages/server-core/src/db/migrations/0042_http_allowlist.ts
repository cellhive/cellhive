import { sql, type Kysely } from 'kysely';

/**
 * Migration 0042 (BACKLOG T600; ADR-35 §3, SPEC §5.10, §14.3, CONTRACTS
 * §25.4): the outbound HTTP allowlist of an organization.
 *
 * `meta.http_allowlist` lists host names automations may call on a private
 * network (an internal n8n), managed by organization owners/admins:
 *
 * - `pattern`: canonical form (`n8n.internal`, `*.corp.example:8443`,
 *   lower case, punycode), unique in the organization;
 * - `host`, `wildcard`, `port`: its parts, what the SSRF guard matches —
 *   `host` is the exact host or the suffix of `*.`; `port` `NULL` means the
 *   entry applies to ports 80/443;
 * - `note`: why it is allowed; `created_by`: the member who added it.
 *
 * IP addresses and CIDR are not stored (the API refuses them). The creator
 * reference is composite with `organization_id` to `meta.org_members`
 * (SPEC §5.10, T501 catalog test) and only clears that column when the
 * member leaves (`ON DELETE SET NULL (created_by)`); the organization
 * cascades.
 *
 * Self-contained: no object of another migration than 0001 is used, so its
 * number can change at merge. This file is locked by
 * `migrations.lock.json`: never edit it once merged.
 */

const STATEMENTS = [
  `CREATE TABLE meta.http_allowlist (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     pattern text NOT NULL,
     host text NOT NULL,
     wildcard boolean NOT NULL,
     port integer,
     note text NOT NULL DEFAULT '',
     created_by text,
     created_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT http_allowlist_org_fkey FOREIGN KEY (organization_id)
       REFERENCES meta.organizations (id) ON DELETE CASCADE,
     CONSTRAINT http_allowlist_creator_fkey FOREIGN KEY (organization_id, created_by)
       REFERENCES meta.org_members (organization_id, user_id) ON DELETE SET NULL (created_by),
     CONSTRAINT http_allowlist_organization_id_id_key UNIQUE (organization_id, id),
     CONSTRAINT http_allowlist_organization_id_pattern_key UNIQUE (organization_id, pattern),
     CONSTRAINT http_allowlist_id_check CHECK (id LIKE 'hal\\_%'),
     CONSTRAINT http_allowlist_pattern_check CHECK (char_length(pattern) BETWEEN 1 AND 300),
     CONSTRAINT http_allowlist_host_check CHECK (char_length(host) BETWEEN 1 AND 253),
     CONSTRAINT http_allowlist_port_check CHECK (port IS NULL OR port BETWEEN 1 AND 65535),
     CONSTRAINT http_allowlist_note_check CHECK (char_length(note) <= 200)
   )`,
  // The creator FK's `ON DELETE SET NULL` when a member leaves.
  `CREATE INDEX http_allowlist_created_by_idx ON meta.http_allowlist (organization_id, created_by)
     WHERE created_by IS NOT NULL`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
