import { sql, type Kysely } from 'kysely';

/**
 * Migration 0009 (BACKLOG T306): `meta.form_submissions`, one row per record
 * a signed-in person created through a form (member route, or a link while
 * signed in). It backs the per-person submission limit of a form (`once`,
 * `daily`, `weekly`, `monthly` in the base time zone; BACKLOG S3 decision
 * 9). Anonymous submissions are not tracked: there is nobody to limit.
 *
 * Rows go with their base, form view and user (`ON DELETE CASCADE`); a
 * record deleted later still counts for the limit. No cell value is stored.
 *
 * This file is locked by `migrations.lock.json`: never edit it once merged.
 */

const STATEMENTS = [
  `CREATE TABLE meta.form_submissions (
     organization_id text NOT NULL,
     base_id text NOT NULL,
     view_id text NOT NULL,
     user_id text NOT NULL,
     share_link_id text,
     record_id text NOT NULL,
     submitted_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (organization_id, record_id),
     CONSTRAINT form_submissions_base_fkey FOREIGN KEY (organization_id, base_id)
       REFERENCES meta.bases (organization_id, id) ON DELETE CASCADE,
     CONSTRAINT form_submissions_view_fkey FOREIGN KEY (view_id)
       REFERENCES meta.views (id) ON DELETE CASCADE,
     CONSTRAINT form_submissions_user_fkey FOREIGN KEY (user_id)
       REFERENCES meta.users (id) ON DELETE CASCADE
   )`,
  `CREATE INDEX form_submissions_person_idx
     ON meta.form_submissions (organization_id, view_id, user_id, submitted_at)`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
