import { sql, type Kysely } from 'kysely';

/**
 * Migration 0050 (BACKLOG T707; ADR-36 §3, SPEC §5.10, CONTRACTS §27):
 * details of an external sign-in identity (OIDC).
 *
 * - `email`: the email the identity provider reported at the last sign-in
 *   (display only — the identity is `(provider, subject)`, never the email).
 * - `last_login_at`: last successful sign-in through this identity.
 *
 * Both nullable: rows written before this migration have neither. Self-
 * contained (only `meta.user_identities` of 0001), so its number can change
 * at merge. This file is locked by `migrations.lock.json`: never edit it once
 * merged.
 */

const STATEMENTS = [
  `ALTER TABLE meta.user_identities
     ADD COLUMN email public.citext,
     ADD COLUMN last_login_at timestamptz`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
