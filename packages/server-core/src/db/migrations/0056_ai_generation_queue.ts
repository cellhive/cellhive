import { sql, type Kysely } from 'kysely';

/**
 * Migration 0056 (BACKLOG T910; ADR-39 §7, SPEC §5.10, CONTRACTS §29.5):
 * the generation queue of AI fields (`options.ai` on a `text` or single
 * `select` field).
 *
 * `meta.ai_generation_queue`: one row per (field, record) whose value must be
 * generated (merged: queueing again only resets the row). Written in the
 * transaction of the record write through the "one door" of computed
 * changes, by `POST /fields/:id/ai/generate`, and by the `ai.generate` /
 * `ai.generation_rescue` jobs.
 *
 * - `status`: `queued` → `running` (taken by a batch, `lease_until` = end of
 *   its lease) → row deleted once the value is written; `failed` (`reason`
 *   = an error code, never a value) after the last try; `paused` (`reason`
 *   = `quota` | `ai_disabled` | `record_data_disabled`) until the rescue
 *   cron or a new generate request queues it again. A `queued` row with a
 *   `lease_until` in the future waits for its next try (temporary error).
 * - `job_id`: the `meta.jobs` row of the generate request that queued it
 *   (its progress), `NULL` otherwise; no FK (jobs are cleaned up first).
 * - `causation`: of the write that queued the row (SPEC §11.6, like
 *   `computed_recompute_queue`).
 *
 * Self-contained (only `meta.fields` of 0001/0026), so its number can change
 * at merge. This file is locked by `migrations.lock.json`: never edit it once
 * merged.
 */

const STATEMENTS = [
  `CREATE TABLE meta.ai_generation_queue (
     organization_id text NOT NULL,
     field_id text NOT NULL,
     record_id text NOT NULL,
     status text NOT NULL DEFAULT 'queued',
     reason text,
     attempts integer NOT NULL DEFAULT 0,
     enqueued_at timestamptz NOT NULL DEFAULT now(),
     lease_until timestamptz,
     job_id text,
     causation jsonb,
     PRIMARY KEY (field_id, record_id),
     CONSTRAINT ai_generation_queue_field_fkey FOREIGN KEY (organization_id, field_id)
       REFERENCES meta.fields (organization_id, id) ON DELETE CASCADE,
     CONSTRAINT ai_generation_queue_status_check
       CHECK (status IN ('queued', 'running', 'failed', 'paused')),
     CONSTRAINT ai_generation_queue_reason_check CHECK (char_length(reason) BETWEEN 1 AND 64),
     CONSTRAINT ai_generation_queue_attempts_check CHECK (attempts BETWEEN 0 AND 100)
   )`,
  // Batches take the oldest queued rows of a field; counts per field and status.
  `CREATE INDEX ai_generation_queue_field_idx
     ON meta.ai_generation_queue (organization_id, field_id, status, enqueued_at)`,
  // The rescue cron (every organization): expired leases and paused rows.
  `CREATE INDEX ai_generation_queue_rescue_idx
     ON meta.ai_generation_queue (status, lease_until) WHERE status IN ('running', 'paused')`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
