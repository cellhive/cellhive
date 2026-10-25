import { sql, type Kysely } from 'kysely';

/**
 * Migration 0024 (BACKLOG T458): the queue of incremental recomputes of
 * computed fields that a write could not do in its own transaction (more
 * than `COMPUTED_SYNC_ROW_LIMIT` rows, or every row — SPEC §5.9).
 *
 * `meta.computed_recompute_queue`: one row per stored formula/lookup field
 * and record to recompute (`record_id`), or `'*'` for every record of the
 * field's table with `after_auto` = the `__auto` the job has reached. Rows
 * are merged (primary key `(field_id, record_id)`), so a burst of writes
 * leaves one row per record however often it changed; the job
 * `computed.recompute` (debounced per field, ADR-18 §5) takes them in
 * batches and deletes them. Rows follow their field (`ON DELETE CASCADE`).
 *
 * Addition to SPEC §5.10 (reported in T458). Self-contained: no function or
 * table of a later migration is used, so its number can change at merge
 * (0023 is `fx_text_contain` of T473).
 *
 * This file is locked by `migrations.lock.json`: never edit it once merged.
 */

const STATEMENTS = [
  `CREATE TABLE meta.computed_recompute_queue (
     organization_id text NOT NULL,
     field_id text NOT NULL,
     record_id text NOT NULL,
     after_auto bigint NOT NULL DEFAULT 0,
     enqueued_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT computed_recompute_queue_pkey PRIMARY KEY (field_id, record_id),
     CONSTRAINT computed_recompute_queue_field_fkey FOREIGN KEY (field_id)
       REFERENCES meta.fields (id) ON DELETE CASCADE,
     CONSTRAINT computed_recompute_queue_record_check
       CHECK (record_id = '*' OR record_id LIKE 'rec\\_%')
   )`,
  `CREATE INDEX computed_recompute_queue_org_idx
     ON meta.computed_recompute_queue (organization_id, field_id)`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
