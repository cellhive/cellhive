import { sql, type Kysely } from 'kysely';

/**
 * Migration 0012 (BACKLOG T406): `meta.attachments`, the files of
 * `attachment` cells (SPEC §5.10, §16; CONTRACTS §20).
 *
 * One row per file **per record** (BACKLOG S4 open question #12): copying a
 * cell to another record creates a new row (new `att_…` id) that shares the
 * `object_key` of the original; an object is deleted only once no row
 * references it. Columns beyond SPEC §5.10 (reported in T406):
 *
 * - `record_id` is `NULL` while the upload is not written to any cell;
 * - `status`: `pending_upload` (presigned PUT issued) → `ready` (`complete`
 *   checked size and content, `sha256` set); `pending_scan` is reserved for
 *   virus scanning (Phase 2, SPEC §14.2);
 * - `detached_at`: the file was removed from its cell (kept for undo and
 *   history revert, CONTRACTS §20); `NULL` while it is in the cell;
 * - `created_by` is the uploader (`SET NULL` when the user is deleted).
 *
 * The worker's `attachments.cleanup` cron deletes uploads never attached
 * after 24 hours and detached files after 30 days (rows, then objects no
 * longer referenced). The table FK is `RESTRICT`: a table can only be hard
 * deleted once its files are gone.
 *
 * Self-contained: no function or table of a later migration is used, so its
 * number can change at merge. Locked by `migrations.lock.json` once merged.
 */

const STATEMENTS = [
  `CREATE TABLE meta.attachments (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     base_id text NOT NULL,
     table_id text NOT NULL,
     field_id text NOT NULL,
     record_id text,
     object_key text NOT NULL,
     filename text NOT NULL,
     mime text NOT NULL,
     size bigint NOT NULL,
     sha256 text,
     status text NOT NULL DEFAULT 'pending_upload',
     created_by text REFERENCES meta.users (id) ON DELETE SET NULL,
     detached_at timestamptz,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT attachments_table_fkey FOREIGN KEY (organization_id, table_id)
       REFERENCES meta.tables (organization_id, id) ON DELETE RESTRICT,
     CONSTRAINT attachments_status_check
       CHECK (status IN ('pending_upload', 'ready', 'pending_scan')),
     CONSTRAINT attachments_size_check CHECK (size >= 0),
     CONSTRAINT attachments_filename_check CHECK (char_length(filename) BETWEEN 1 AND 255),
     CONSTRAINT attachments_mime_check CHECK (char_length(mime) BETWEEN 3 AND 255),
     CONSTRAINT attachments_sha256_check CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
     CONSTRAINT attachments_ready_check CHECK (status = 'pending_upload' OR sha256 IS NOT NULL),
     CONSTRAINT attachments_attached_check CHECK (record_id IS NOT NULL OR detached_at IS NULL)
   )`,
  `CREATE INDEX attachments_record_idx
     ON meta.attachments (organization_id, table_id, record_id, field_id)
     WHERE record_id IS NOT NULL`,
  'CREATE INDEX attachments_object_key_idx ON meta.attachments (object_key)',
  `CREATE INDEX attachments_unattached_idx ON meta.attachments (created_at)
     WHERE record_id IS NULL`,
  `CREATE INDEX attachments_detached_idx ON meta.attachments (detached_at)
     WHERE detached_at IS NOT NULL`,
  `CREATE TRIGGER attachments_set_updated_at BEFORE UPDATE ON meta.attachments
     FOR EACH ROW EXECUTE FUNCTION meta.set_updated_at()`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
