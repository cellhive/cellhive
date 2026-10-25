import { sql, type Kysely } from 'kysely';

/**
 * Migration 0018 (BACKLOG T410): uploads of form links (BACKLOG S4 open
 * question #14).
 *
 * - `share_link_id`: the form link the file was uploaded through
 *   (`POST /shares/:token/uploads`); `NULL` for uploads of members.
 * - `upload_session`: SHA-256 (hex) of the link id and the nonce of the
 *   submit token the upload was made with. A submission through the link
 *   only binds files of its own session (the token it claims), so a file
 *   uploaded for one person, link or token never lands in another record.
 *
 * Anonymous uploads have `created_by = NULL`. Files never submitted are
 * deleted by `attachments.cleanup` after 24 hours like every unattached
 * upload. No foreign key to `meta.share_links` (links are never deleted,
 * only revoked). Addition to SPEC §5.10 (reported in T410). Self-contained:
 * no function or table of a later migration is used, so its number can
 * change at merge.
 *
 * This file is locked by `migrations.lock.json`: never edit it once merged.
 */

const STATEMENTS = [
  'ALTER TABLE meta.attachments ADD COLUMN share_link_id text',
  'ALTER TABLE meta.attachments ADD COLUMN upload_session text',
  `ALTER TABLE meta.attachments ADD CONSTRAINT attachments_upload_session_check
     CHECK ((share_link_id IS NULL) = (upload_session IS NULL)
            AND (upload_session IS NULL OR upload_session ~ '^[0-9a-f]{64}$'))`,
  `CREATE INDEX attachments_upload_session_idx
     ON meta.attachments (organization_id, share_link_id, upload_session)
     WHERE upload_session IS NOT NULL`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
