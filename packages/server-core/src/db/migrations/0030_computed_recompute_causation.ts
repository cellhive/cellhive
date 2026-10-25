import { sql, type Kysely } from 'kysely';

/**
 * Migration 0030 (BACKLOG T509, `docs/reviews/S4b-decisions-followup.md`
 * §3.4): recomputed values of stored formula/lookup fields become
 * `record.updated` events for automations, so the work the
 * `computed.recompute` job does later keeps what the loop guard needs.
 *
 * - `meta.computed_recompute_queue.causation` (`jsonb`, `NULL` = unknown):
 *   the causation (SPEC §11.6) of the write that queued the row. Rows merge
 *   on `(field_id, record_id)`, so causations merge conservatively with
 *   `meta.merge_recompute_causation`: `depth` = the greatest,
 *   `automation_chain` = the union (first chain's order, then new ids),
 *   `root_event_id` = the first row's.
 * - `meta.computed_recompute_queue.created`: the row only computes the first
 *   value of a record that was just created or restored — the job writes it
 *   but emits no `record.updated` (it is part of `record.created`). A merge
 *   keeps `true` only while every write that queued the row was such a
 *   creation.
 * - `meta.automation_batch_counters.events`: `record.updated` events a
 *   recompute job wrote for an automation and a batch (`job_…`), so the job
 *   stops writing events past `AUTOMATION_MAX_RUNS_PER_BATCH` + 1 and only
 *   counts `skipped` (ADR-26 §4).
 *
 * Static DDL on `meta.*` only, run in the migrator's single transaction.
 * Self-contained: no function or table of a later migration is used, so its
 * number can change at merge (T505 may take 0030 first).
 *
 * This file is locked by `migrations.lock.json`: never edit it once merged.
 */

const STATEMENTS = [
  `ALTER TABLE meta.computed_recompute_queue
     ADD COLUMN causation jsonb,
     ADD COLUMN created boolean NOT NULL DEFAULT false,
     ADD CONSTRAINT computed_recompute_queue_causation_check
       CHECK (causation IS NULL OR jsonb_typeof(causation) = 'object')`,

  `ALTER TABLE meta.automation_batch_counters
     ADD COLUMN events integer NOT NULL DEFAULT 0,
     ADD CONSTRAINT automation_batch_counters_events_check CHECK (events >= 0)`,

  // NULL is "unknown": merging it with a known causation keeps the known one.
  `CREATE FUNCTION meta.merge_recompute_causation(a jsonb, b jsonb)
     RETURNS jsonb
     LANGUAGE sql IMMUTABLE PARALLEL SAFE
     SET search_path = pg_catalog, pg_temp
   AS $$
     SELECT CASE
       WHEN a IS NULL THEN b
       WHEN b IS NULL THEN a
       ELSE jsonb_build_object(
         'root_event_id', a -> 'root_event_id',
         'depth', GREATEST(COALESCE((a ->> 'depth')::int, 0), COALESCE((b ->> 'depth')::int, 0)),
         'automation_chain', COALESCE((
           SELECT jsonb_agg(u.value ORDER BY u.first)
             FROM (
               SELECT c.value, min(c.ord) AS first
                 FROM (
                   SELECT x.value, x.ord
                     FROM jsonb_array_elements(COALESCE(a -> 'automation_chain', '[]'::jsonb))
                          WITH ORDINALITY AS x(value, ord)
                   UNION ALL
                   SELECT y.value, y.ord + 1000000
                     FROM jsonb_array_elements(COALESCE(b -> 'automation_chain', '[]'::jsonb))
                          WITH ORDINALITY AS y(value, ord)
                 ) AS c
                GROUP BY c.value
             ) AS u
         ), '[]'::jsonb)
       )
     END
   $$`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
