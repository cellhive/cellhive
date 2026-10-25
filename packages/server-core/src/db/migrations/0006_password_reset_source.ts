import { sql, type Kysely } from 'kysely';

/**
 * Migration 0006: `meta.password_resets.source` (SPEC §14.2, CONTRACTS §12.1).
 *
 * Who created a reset link: `self_service` (forgot password), `admin` (an
 * organization owner/admin) or `cli` (the server CLI). `created_by` alone
 * cannot tell: CLI links have none, and it becomes `NULL` when the issuing
 * admin is deleted. Existing rows are backfilled from `created_by` (set →
 * `admin`, else `self_service`); a pending CLI link from before this
 * migration counts as self-service until it expires (24 hours).
 *
 * This file is locked by `migrations.lock.json`: never edit it once merged.
 */

const STATEMENTS = [
  'ALTER TABLE meta.password_resets ADD COLUMN source text',
  `UPDATE meta.password_resets
      SET source = CASE WHEN created_by IS NOT NULL THEN 'admin' ELSE 'self_service' END`,
  'ALTER TABLE meta.password_resets ALTER COLUMN source SET NOT NULL',
  `ALTER TABLE meta.password_resets
     ADD CONSTRAINT password_resets_source_check
     CHECK (source IN ('self_service', 'admin', 'cli'))`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
