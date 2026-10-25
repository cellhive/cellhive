import { sql, type Kysely } from 'kysely';

/**
 * Migration 0045 (BACKLOG T603; ADR-35 §1, CONTRACTS §8): actor type
 * `webhook` for events.
 *
 * The `webhook.received` event of an incoming webhook has
 * `actor = { type: webhook, id: hok_… }` (ADR-35 §1). `meta.events`
 * allowed the five actor types of migration 0001 only; the CHECK is
 * replaced by one that also allows `webhook`. A wider CHECK accepts every
 * existing row. `meta.audit_logs` keeps its CHECK: `webhook.received` is not
 * audited (the request log is its record, CONTRACTS §8), so no audit entry
 * ever has this actor.
 *
 * Self-contained (only `meta.events` of 0001), so its number can change at
 * merge. This file is locked by `migrations.lock.json`: never edit it once
 * merged.
 */

const STATEMENTS = [
  `ALTER TABLE meta.events DROP CONSTRAINT events_actor_type_check`,
  `ALTER TABLE meta.events ADD CONSTRAINT events_actor_type_check
     CHECK (actor_type IN ('user', 'api_token', 'automation', 'share_link', 'system', 'webhook'))`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
