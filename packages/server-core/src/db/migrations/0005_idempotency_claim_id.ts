import { sql, type Kysely } from 'kysely';

/**
 * Migration 0005: `meta.idempotency_keys.claim_id` (CONTRACTS §1.1).
 *
 * Each claim of a key gets a random id. Completing or releasing a key
 * matches it, so a request whose key was taken over after 60 seconds in
 * progress can no longer store its late response over the new claim, nor
 * delete the new claim. Rows written before this migration have no claim
 * id: they are completed or released by nobody and expire as usual.
 *
 * This file is locked by `migrations.lock.json`: never edit it once merged.
 */

const STATEMENTS = ['ALTER TABLE meta.idempotency_keys ADD COLUMN claim_id text'];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
