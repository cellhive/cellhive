import { sql, type Kysely } from 'kysely';

/**
 * Migration 0019 (BACKLOG T419): `meta.form_covers`, the cover images of
 * form views (`config.form.cover_attachment_id`, CONTRACTS §15, §17).
 *
 * A cover is not the value of a cell, so it does not live in
 * `meta.attachments` (whose rows always belong to a field and, once
 * written, to a record — every cell rule and file route relies on that).
 * One row per uploaded image:
 *
 * - `view_id`: the form view it was uploaded for (who may finish the
 *   upload); no foreign key — a deleted view (or table) leaves its cover
 *   to the cleanup, so storage objects are never orphaned by a cascade;
 * - `status`: `pending_upload` (presigned `PUT` issued) → `ready`
 *   (`complete` checked size and content, `sha256` set);
 * - which cover a form shows is the view config alone: the
 *   `attachments.cleanup` cron deletes a cover (row, then object) that no
 *   form view of its organization names, 24 hours after its upload.
 *
 * Addition to SPEC §5.10 (reported in T419). Self-contained: no function or
 * table of a later migration is used, so its number can change at merge.
 *
 * This file is locked by `migrations.lock.json`: never edit it once merged.
 */

const STATEMENTS = [
  `CREATE TABLE meta.form_covers (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     base_id text NOT NULL,
     table_id text NOT NULL,
     view_id text NOT NULL,
     object_key text NOT NULL,
     filename text NOT NULL,
     mime text NOT NULL,
     size bigint NOT NULL,
     sha256 text,
     status text NOT NULL DEFAULT 'pending_upload',
     created_by text REFERENCES meta.users (id) ON DELETE SET NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT form_covers_org_fkey FOREIGN KEY (organization_id)
       REFERENCES meta.organizations (id) ON DELETE CASCADE,
     CONSTRAINT form_covers_status_check CHECK (status IN ('pending_upload', 'ready')),
     CONSTRAINT form_covers_size_check CHECK (size > 0),
     CONSTRAINT form_covers_filename_check CHECK (char_length(filename) BETWEEN 1 AND 255),
     CONSTRAINT form_covers_mime_check
       CHECK (mime IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
     CONSTRAINT form_covers_sha256_check CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
     CONSTRAINT form_covers_ready_check CHECK (status = 'pending_upload' OR sha256 IS NOT NULL)
   )`,
  'CREATE INDEX form_covers_view_idx ON meta.form_covers (organization_id, view_id)',
  'CREATE INDEX form_covers_created_idx ON meta.form_covers (created_at)',
  `CREATE TRIGGER form_covers_set_updated_at BEFORE UPDATE ON meta.form_covers
     FOR EACH ROW EXECUTE FUNCTION meta.set_updated_at()`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
