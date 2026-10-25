import { sql, type Kysely } from 'kysely';

/**
 * Migration 0044 (BACKLOG T605; ADR-35 §4, SPEC §5.10, §11.7, CONTRACTS
 * §25.5): the outbox of outbound HTTP calls.
 *
 * `meta.http_deliveries` holds one row per HTTP call an automation step
 * (`kind = action`) or a "send a test" (`kind = test`, T606) asks for. The
 * step's transaction inserts it `pending` (phase 1); the job `http.deliver`
 * leases it (`sending`, `lease_until`), commits, calls the destination,
 * then records the result in another transaction (phase 2):
 *
 * - `idempotency_key` is the `Idempotency-Key` header
 *   (`<aut>:<event|run>:<act>` for a step), unique in the organization, so
 *   a step that runs again reuses its row; `message_id` is `webhook-id`
 *   (the root event, or the run), the same for every attempt;
 * - `request_enc` is the rendered request (URL, non-secret headers, body,
 *   causation) sealed with AES-256-GCM (HKDF `http-delivery:v1`); it
 *   is erased once the row is final (`succeeded`, `failed`, `cancelled`) —
 *   the CHECK enforces it;
 * - `target_host` is the URL's host only (shown in the run detail, safe to
 *   log); secrets are referenced by id (`ON DELETE SET NULL`: a deleted
 *   secret fails the next attempt with `secret_unavailable`);
 * - `last_status`, `last_error` (code + params) and `response` (status,
 *   `content-type`, body cut at 10 KB) describe the outcome.
 *
 * Every reference is composite with `organization_id` (SPEC §5.10, T501
 * catalog test): the run and the automation cascade (rows follow the run
 * retention of T518), the requester of a test is cleared when the member
 * leaves. The partial index on `next_attempt_at` serves the rows still to
 * deliver (the backlog gauge, recovery).
 *
 * Self-contained: no object of another migration than 0001, 0027 and 0036
 * is used, so its number can change at merge. This file is locked by
 * `migrations.lock.json`: never edit it once merged.
 */

const STATEMENTS = [
  `CREATE TABLE meta.http_deliveries (
     id text PRIMARY KEY,
     organization_id text NOT NULL,
     kind text NOT NULL,
     automation_id text,
     run_id text,
     action_id text,
     requested_by text,
     idempotency_key text NOT NULL,
     message_id text NOT NULL,
     method text NOT NULL,
     target_host text NOT NULL,
     request_enc text,
     auth_secret_id text,
     signing_secret_id text,
     status text NOT NULL DEFAULT 'pending',
     attempts integer NOT NULL DEFAULT 0,
     next_attempt_at timestamptz NOT NULL DEFAULT now(),
     lease_until timestamptz,
     last_status integer,
     last_error jsonb,
     response jsonb,
     created_at timestamptz NOT NULL DEFAULT now(),
     completed_at timestamptz,
     CONSTRAINT http_deliveries_org_fkey FOREIGN KEY (organization_id)
       REFERENCES meta.organizations (id) ON DELETE CASCADE,
     CONSTRAINT http_deliveries_automation_fkey FOREIGN KEY (organization_id, automation_id)
       REFERENCES meta.automations (organization_id, id) ON DELETE CASCADE,
     CONSTRAINT http_deliveries_run_fkey FOREIGN KEY (organization_id, run_id)
       REFERENCES meta.automation_runs (organization_id, id) ON DELETE CASCADE,
     CONSTRAINT http_deliveries_requester_fkey FOREIGN KEY (organization_id, requested_by)
       REFERENCES meta.org_members (organization_id, user_id) ON DELETE SET NULL (requested_by),
     CONSTRAINT http_deliveries_auth_secret_fkey FOREIGN KEY (organization_id, auth_secret_id)
       REFERENCES meta.secrets (organization_id, id) ON DELETE SET NULL (auth_secret_id),
     CONSTRAINT http_deliveries_signing_secret_fkey FOREIGN KEY (organization_id, signing_secret_id)
       REFERENCES meta.secrets (organization_id, id) ON DELETE SET NULL (signing_secret_id),
     CONSTRAINT http_deliveries_organization_id_id_key UNIQUE (organization_id, id),
     CONSTRAINT http_deliveries_idempotency_key UNIQUE (organization_id, idempotency_key),
     CONSTRAINT http_deliveries_id_check CHECK (id LIKE 'hdl\\_%'),
     CONSTRAINT http_deliveries_kind_check CHECK (kind IN ('action', 'test')),
     CONSTRAINT http_deliveries_action_check CHECK (kind <> 'action' OR
       (automation_id IS NOT NULL AND run_id IS NOT NULL AND action_id IS NOT NULL)),
     CONSTRAINT http_deliveries_status_check CHECK (status IN
       ('pending', 'sending', 'succeeded', 'failed', 'cancelled')),
     CONSTRAINT http_deliveries_request_check CHECK (
       (status IN ('succeeded', 'failed', 'cancelled')) = (request_enc IS NULL)),
     CONSTRAINT http_deliveries_method_check CHECK (method IN
       ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
     CONSTRAINT http_deliveries_attempts_check CHECK (attempts >= 0),
     CONSTRAINT http_deliveries_target_host_check CHECK (char_length(target_host) BETWEEN 1 AND 253),
     CONSTRAINT http_deliveries_key_check CHECK (char_length(idempotency_key) BETWEEN 1 AND 255),
     CONSTRAINT http_deliveries_message_id_check CHECK (char_length(message_id) BETWEEN 1 AND 255),
     CONSTRAINT http_deliveries_last_status_check CHECK (
       last_status IS NULL OR last_status BETWEEN 100 AND 599)
   )`,
  // Rows still to deliver (backlog gauge, recovery): ADR-35 §4.
  `CREATE INDEX http_deliveries_due_idx ON meta.http_deliveries (next_attempt_at)
     WHERE status IN ('pending', 'sending')`,
  // Run detail and cancellation by run; the run FK's cascade.
  `CREATE INDEX http_deliveries_run_idx ON meta.http_deliveries (organization_id, run_id)
     WHERE run_id IS NOT NULL`,
  // The automation FK's cascade.
  `CREATE INDEX http_deliveries_automation_idx ON meta.http_deliveries (organization_id, automation_id)
     WHERE automation_id IS NOT NULL`,
  // The `SET NULL` of the requester and secret FKs.
  `CREATE INDEX http_deliveries_requested_by_idx ON meta.http_deliveries (organization_id, requested_by)
     WHERE requested_by IS NOT NULL`,
  `CREATE INDEX http_deliveries_auth_secret_idx ON meta.http_deliveries (organization_id, auth_secret_id)
     WHERE auth_secret_id IS NOT NULL`,
  `CREATE INDEX http_deliveries_signing_secret_idx
     ON meta.http_deliveries (organization_id, signing_secret_id)
     WHERE signing_secret_id IS NOT NULL`,
  // `test` rows are deleted after 24 hours (maintenance.cleanup).
  `CREATE INDEX http_deliveries_test_created_idx ON meta.http_deliveries (created_at)
     WHERE kind = 'test'`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
