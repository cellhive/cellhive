import { sql, type Kysely } from 'kysely';

/**
 * Migration 0027 (BACKLOG T502): the automation tables of SPEC §5.10 —
 * `meta.automations`, `meta.automation_runs`, `meta.automation_run_steps`,
 * `meta.automation_batch_counters` — each with `organization_id` and
 * composite tenant foreign keys from the start (SPEC §5.10, the T501
 * catalog test).
 *
 * Additions to SPEC §5.10 (reported in T502):
 * - `automations.description`, `deleted_at` (soft delete), `updated_by`
 *   (who changed it last, for `409 VERSION_CONFLICT`);
 * - `automations.trigger_type` / `trigger_table_id`: copied from the
 *   definition on every save, so lists filter by the tables a manager may
 *   manage and `events.dispatch` (T503) finds candidates by index without
 *   reading the JSON;
 * - `automation_runs.created_at`/`updated_at`, and
 *   `UNIQUE (automation_id, trigger_event_id)` (T503: dispatching an event
 *   twice creates no second run; `NULL` for runs without an event).
 *
 * `trigger_event_id` has no foreign key: `meta.events` is partitioned (its
 * key includes `created_at`) and old partitions are dropped. Users are
 * referenced without cascade: a person is disabled, never deleted, and an
 * automation keeps its history.
 *
 * Static DDL on `meta.*` only.
 * This file is locked by `migrations.lock.json`: never edit it once merged.
 */

const STATEMENTS = [
  `CREATE TABLE meta.automations (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     base_id text NOT NULL,
     name text NOT NULL,
     description text NOT NULL DEFAULT '',
     enabled boolean NOT NULL DEFAULT false,
     disabled_reason text,
     definition jsonb NOT NULL,
     trigger_type text NOT NULL,
     trigger_table_id text,
     version integer NOT NULL DEFAULT 1,
     created_by text NOT NULL,
     updated_by text NOT NULL,
     run_as_user_id text NOT NULL,
     run_as_since timestamptz NOT NULL DEFAULT now(),
     deleted_at timestamptz,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT automations_organization_id_id_key UNIQUE (organization_id, id),
     CONSTRAINT automations_base_fkey FOREIGN KEY (organization_id, base_id)
       REFERENCES meta.bases (organization_id, id) ON DELETE CASCADE,
     CONSTRAINT automations_trigger_table_fkey FOREIGN KEY (organization_id, trigger_table_id)
       REFERENCES meta.tables (organization_id, id) ON DELETE CASCADE,
     CONSTRAINT automations_created_by_fkey FOREIGN KEY (created_by) REFERENCES meta.users (id),
     CONSTRAINT automations_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES meta.users (id),
     CONSTRAINT automations_run_as_fkey FOREIGN KEY (run_as_user_id) REFERENCES meta.users (id),
     CONSTRAINT automations_name_check CHECK (length(name) BETWEEN 1 AND 255),
     CONSTRAINT automations_description_check CHECK (length(description) <= 2000),
     CONSTRAINT automations_definition_check CHECK (jsonb_typeof(definition) = 'object'),
     CONSTRAINT automations_version_check CHECK (version >= 1),
     CONSTRAINT automations_disabled_reason_check
       CHECK (disabled_reason IN ('run_as_lost_access', 'circuit_breaker')),
     CONSTRAINT automations_disabled_check CHECK (NOT (enabled AND disabled_reason IS NOT NULL)),
     CONSTRAINT automations_deleted_check CHECK (deleted_at IS NULL OR NOT enabled)
   )`,
  `CREATE INDEX automations_base_idx
     ON meta.automations (organization_id, base_id, created_at) WHERE deleted_at IS NULL`,
  `CREATE INDEX automations_trigger_idx
     ON meta.automations (organization_id, trigger_table_id, trigger_type)
     WHERE enabled AND deleted_at IS NULL`,
  `CREATE INDEX automations_run_as_idx
     ON meta.automations (organization_id, run_as_user_id) WHERE enabled AND deleted_at IS NULL`,
  `CREATE TRIGGER automations_set_updated_at BEFORE UPDATE ON meta.automations
     FOR EACH ROW EXECUTE FUNCTION meta.set_updated_at()`,

  `CREATE TABLE meta.automation_runs (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     automation_id text NOT NULL,
     automation_version integer NOT NULL,
     trigger_event_id text,
     trigger_unit text NOT NULL,
     status text NOT NULL DEFAULT 'queued',
     depth integer NOT NULL DEFAULT 0,
     started_at timestamptz,
     finished_at timestamptz,
     error jsonb,
     input jsonb NOT NULL DEFAULT '{}'::jsonb,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT automation_runs_organization_id_id_key UNIQUE (organization_id, id),
     CONSTRAINT automation_runs_event_key UNIQUE (automation_id, trigger_event_id),
     CONSTRAINT automation_runs_automation_fkey FOREIGN KEY (organization_id, automation_id)
       REFERENCES meta.automations (organization_id, id) ON DELETE CASCADE,
     CONSTRAINT automation_runs_status_check CHECK (status IN
       ('queued', 'running', 'waiting', 'succeeded', 'failed', 'skipped', 'cancelled')),
     CONSTRAINT automation_runs_depth_check CHECK (depth >= 0),
     CONSTRAINT automation_runs_version_check CHECK (automation_version >= 1)
   )`,
  `CREATE INDEX automation_runs_automation_idx
     ON meta.automation_runs (organization_id, automation_id, created_at DESC)`,
  `CREATE INDEX automation_runs_active_idx
     ON meta.automation_runs (organization_id, status)
     WHERE status IN ('queued', 'running', 'waiting')`,
  'CREATE INDEX automation_runs_created_idx ON meta.automation_runs (organization_id, created_at)',
  `CREATE TRIGGER automation_runs_set_updated_at BEFORE UPDATE ON meta.automation_runs
     FOR EACH ROW EXECUTE FUNCTION meta.set_updated_at()`,

  `CREATE TABLE meta.automation_run_steps (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     run_id text NOT NULL,
     action_id text NOT NULL,
     status text NOT NULL DEFAULT 'running',
     attempt integer NOT NULL DEFAULT 1,
     idempotency_key text NOT NULL,
     started_at timestamptz NOT NULL DEFAULT now(),
     finished_at timestamptz,
     input jsonb,
     output jsonb,
     error jsonb,
     created_at timestamptz NOT NULL DEFAULT now(),
     updated_at timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT automation_run_steps_organization_id_id_key UNIQUE (organization_id, id),
     CONSTRAINT automation_run_steps_idempotency_key_key UNIQUE (idempotency_key),
     CONSTRAINT automation_run_steps_run_fkey FOREIGN KEY (organization_id, run_id)
       REFERENCES meta.automation_runs (organization_id, id) ON DELETE CASCADE,
     CONSTRAINT automation_run_steps_status_check CHECK (status IN
       ('running', 'waiting', 'succeeded', 'failed', 'skipped', 'cancelled')),
     CONSTRAINT automation_run_steps_attempt_check CHECK (attempt >= 1)
   )`,
  `CREATE INDEX automation_run_steps_run_idx
     ON meta.automation_run_steps (organization_id, run_id, started_at)`,
  `CREATE TRIGGER automation_run_steps_set_updated_at BEFORE UPDATE ON meta.automation_run_steps
     FOR EACH ROW EXECUTE FUNCTION meta.set_updated_at()`,

  `CREATE TABLE meta.automation_batch_counters (
     organization_id text NOT NULL,
     automation_id text NOT NULL,
     batch_id text NOT NULL,
     runs integer NOT NULL DEFAULT 0,
     skipped integer NOT NULL DEFAULT 0,
     created_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (automation_id, batch_id),
     CONSTRAINT automation_batch_counters_automation_fkey
       FOREIGN KEY (organization_id, automation_id)
       REFERENCES meta.automations (organization_id, id) ON DELETE CASCADE,
     CONSTRAINT automation_batch_counters_counts_check CHECK (runs >= 0 AND skipped >= 0)
   )`,
  `CREATE INDEX automation_batch_counters_org_idx
     ON meta.automation_batch_counters (organization_id, automation_id)`,
  `CREATE INDEX automation_batch_counters_created_idx
     ON meta.automation_batch_counters (created_at)`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
