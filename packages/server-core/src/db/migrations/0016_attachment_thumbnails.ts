import { sql, type Kysely } from 'kysely';

/**
 * Migration 0016 (BACKLOG T407): thumbnails of image attachments.
 *
 * - `thumbnail_status`: `NULL` for files that get no thumbnail (not a raster
 *   image, too large) and uploads not completed; `pending` once `complete`
 *   enqueued the `file.thumbnail` job; `running` while the worker renders
 *   it; `ready` when the WebP files `{object_key}_t<size>` are stored;
 *   `skipped` (too many pixels — decompression bombs — or unreadable) and
 *   `failed` (storage error after the retries) leave the attachment usable
 *   without a thumbnail. Copies of a cell (BACKLOG S4 #12) share the object,
 *   hence its thumbnails: the job updates every row of the object key.
 * - `thumbnail_started_at`: when the running render started; the
 *   per-organization cap of the job (`acquireOrgSlot`, ADR-18) only counts
 *   recent ones, so a render interrupted by a worker crash does not hold a
 *   slot forever.
 *
 * Addition to SPEC §5.10 (reported in T407). Self-contained: no function or
 * table of a later migration is used, so its number can change at merge.
 *
 * This file is locked by `migrations.lock.json`: never edit it once merged.
 */

const STATEMENTS = [
  `ALTER TABLE meta.attachments
     ADD COLUMN thumbnail_status text,
     ADD COLUMN thumbnail_started_at timestamptz,
     ADD CONSTRAINT attachments_thumbnail_status_check
       CHECK (thumbnail_status IN ('pending', 'running', 'ready', 'skipped', 'failed'))`,
  `CREATE INDEX attachments_thumbnail_running_idx
     ON meta.attachments (organization_id, thumbnail_started_at)
     WHERE thumbnail_status = 'running'`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
