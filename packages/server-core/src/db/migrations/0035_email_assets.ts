import { sql, type Kysely } from 'kysely';

/**
 * Migration 0035 (BACKLOG T534, ADR-32 §3, ADR-33 §3): `meta.email_assets`,
 * images uploaded for automation emails — embedded in the message as inline
 * `cid:` parts, never linked.
 *
 * An email image is not the value of a cell, so it does not live in
 * `meta.attachments` (whose rows always belong to a field and a record),
 * like the form covers of 0019. One row per uploaded image:
 *
 * - `kind`: `signature` (organization default or sender identity
 *   signatures, uploaded by organization owners/admins) or `automation`
 *   (the body of one automation, uploaded by its managers; `automation_id`).
 *   A deleted automation sets `automation_id` to `NULL` instead of
 *   cascading, so the cleanup still deletes the storage object;
 * - `status`: `pending_upload` (presigned `PUT` issued) → `ready`
 *   (`complete` checked the content, re-encoded it without metadata within
 *   1280 × 1280 px; `size`, `mime`, `sha256`, `width`, `height` are the
 *   processed image's);
 * - what an email shows is the Markdown alone (`![alt](asset:att_…)` in a
 *   signature or an automation body): the `attachments.cleanup` cron deletes
 *   an asset nothing references, 24 hours after its upload.
 *
 * Every foreign key between tenant tables is composite with
 * `organization_id` (SPEC §5.10, T501). Static DDL on `meta.*` only.
 * Self-contained: its number can change at merge.
 *
 * This file is locked by `migrations.lock.json`: never edit it once merged.
 */

const STATEMENTS = [
  `CREATE TABLE meta.email_assets (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     kind text NOT NULL,
     automation_id text,
     object_key text NOT NULL,
     filename text NOT NULL,
     mime text NOT NULL,
     size bigint NOT NULL,
     width integer,
     height integer,
     sha256 text,
     status text NOT NULL DEFAULT 'pending_upload',
     created_by text REFERENCES meta.users (id) ON DELETE SET NULL,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT email_assets_org_fkey FOREIGN KEY (organization_id)
       REFERENCES meta.organizations (id) ON DELETE CASCADE,
     CONSTRAINT email_assets_automation_fkey FOREIGN KEY (organization_id, automation_id)
       REFERENCES meta.automations (organization_id, id) ON DELETE SET NULL (automation_id),
     CONSTRAINT email_assets_kind_check CHECK (kind IN ('signature', 'automation')),
     CONSTRAINT email_assets_signature_check CHECK (kind = 'automation' OR automation_id IS NULL),
     CONSTRAINT email_assets_status_check CHECK (status IN ('pending_upload', 'ready')),
     CONSTRAINT email_assets_size_check CHECK (size > 0),
     CONSTRAINT email_assets_filename_check CHECK (char_length(filename) BETWEEN 1 AND 255),
     CONSTRAINT email_assets_mime_check
       CHECK (mime IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
     CONSTRAINT email_assets_sha256_check CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
     CONSTRAINT email_assets_dimensions_check
       CHECK ((width IS NULL OR width BETWEEN 1 AND 1280)
              AND (height IS NULL OR height BETWEEN 1 AND 1280)),
     CONSTRAINT email_assets_ready_check
       CHECK (status = 'pending_upload'
              OR (sha256 IS NOT NULL AND width IS NOT NULL AND height IS NOT NULL))
   )`,
  // Assets of an automation (the automation cascade, the reference check).
  `CREATE INDEX email_assets_automation_idx
     ON meta.email_assets (organization_id, automation_id)`,
  // The cleanup scans old assets of every organization.
  'CREATE INDEX email_assets_created_idx ON meta.email_assets (created_at)',
  `CREATE TRIGGER email_assets_set_updated_at BEFORE UPDATE ON meta.email_assets
     FOR EACH ROW EXECUTE FUNCTION meta.set_updated_at()`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
