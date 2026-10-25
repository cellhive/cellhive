import { sql, type Kysely } from 'kysely';

/**
 * Migration 0010 (BACKLOG T308): `meta.imports`, the temporary uploads of
 * the CSV/XLSX import (SPEC §17, CONTRACTS §19).
 *
 * One row per uploaded file: who uploaded it into which base, the file's
 * name/format/size, the parse options of its latest preview (`options`:
 * sheet, delimiter, encoding, header row, column names, row count), and the
 * `table.import` job that used it (`job_id`, set once). The file itself is
 * in object storage under `{organization_id}/{id}` (SPEC §16). The worker's
 * `imports.cleanup` cron deletes rows and files after `expires_at` once no
 * job is still running on them.
 *
 * Addition to SPEC §5.10 (reported in T308). Self-contained: no function or
 * table of a later migration is used, so its number can change at merge.
 *
 * This file is locked by `migrations.lock.json`: never edit it once merged.
 */

const STATEMENTS = [
  `CREATE TABLE meta.imports (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     base_id text NOT NULL,
     created_by text NOT NULL REFERENCES meta.users (id) ON DELETE CASCADE,
     filename text NOT NULL,
     format text NOT NULL,
     size bigint NOT NULL,
     options jsonb NOT NULL DEFAULT '{}'::jsonb,
     job_id text,
     expires_at timestamptz NOT NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT imports_base_fkey FOREIGN KEY (organization_id, base_id)
       REFERENCES meta.bases (organization_id, id) ON DELETE CASCADE,
     CONSTRAINT imports_format_check CHECK (format IN ('csv', 'xlsx')),
     CONSTRAINT imports_size_check CHECK (size >= 0),
     CONSTRAINT imports_filename_check CHECK (char_length(filename) BETWEEN 1 AND 255)
   )`,
  'CREATE UNIQUE INDEX imports_job_id_key ON meta.imports (job_id) WHERE job_id IS NOT NULL',
  'CREATE INDEX imports_org_base_idx ON meta.imports (organization_id, base_id)',
  'CREATE INDEX imports_expires_at_idx ON meta.imports (expires_at)',
  `CREATE TRIGGER imports_set_updated_at BEFORE UPDATE ON meta.imports
     FOR EACH ROW EXECUTE FUNCTION meta.set_updated_at()`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
