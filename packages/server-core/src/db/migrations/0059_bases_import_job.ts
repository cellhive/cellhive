import { sql, type Kysely } from 'kysely';

/**
 * Migration 0059 (BACKLOG T1018; ADR-24 amendment 2026-11 §4, CONTRACTS
 * §12.2, SPEC §5.10): `meta.bases.import_job_id`, the `base.import` job that
 * is building the base.
 *
 * A base being imported is hidden: it is created with `deleted_at` set (a
 * base in the trash is `404` everywhere) and `import_job_id` naming its job,
 * which also keeps it out of the trash list and out of a restore. The job
 * clears both in the transaction that finishes the import; a failed,
 * cancelled or interrupted import purges the base (`SchemaService.purgeBase`
 * only accepts a base whose `import_job_id` is that job).
 *
 * - `bases_import_hidden_check`: a base with an import job is always hidden,
 *   so no write that forgets the column can make a half-built base visible;
 * - `bases_import_job_id_key`: one base per import job, found by
 *   organization and job (the retry of an interrupted job purges it).
 *
 * No foreign key to `meta.jobs` (like `meta.imports.job_id`): finished jobs
 * are deleted after 30 days by `maintenance.cleanup`, and `ON DELETE SET
 * NULL` would turn a base left hidden into a visible base in the trash.
 *
 * Existing rows get `NULL` (no base is being imported before this
 * migration), which satisfies the check. Self-contained (only `meta.bases`
 * of 0001), so its number can change at merge. This file is locked by
 * `migrations.lock.json`: never edit it once merged.
 */

const STATEMENTS = [
  'ALTER TABLE meta.bases ADD COLUMN import_job_id text',
  `ALTER TABLE meta.bases ADD CONSTRAINT bases_import_hidden_check
     CHECK (import_job_id IS NULL OR deleted_at IS NOT NULL)`,
  `CREATE UNIQUE INDEX bases_import_job_id_key
     ON meta.bases (organization_id, import_job_id) WHERE import_job_id IS NOT NULL`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
