import { sql, type Kysely } from 'kysely';

/**
 * Migration 0037 (BACKLOG T528): index of `meta.events` by entity.
 *
 * `EventsRepository.laterRecordChanges` (T527) reads, for each event
 * dispatched against a `record.matches` automation, the `record.updated`
 * events of the same record written after it. With only
 * `events_organization_idx (organization_id, created_at)` it walks every
 * event of the organization since then: a backlog of n events (an import or
 * an `update_records` dispatched late) costs O(n²) rows. Measured in T528 on
 * 2 000 000 events + a 50 000-event backlog (S5-review §3): p95 7.5 ms and
 * ~50 000 rows read per call without it, p95 0.34 ms and ~10 rows with it;
 * bulk inserts of events cost ~6 µs more per event.
 *
 * Not partial on `type`/`entity_type`: the repository passes them as
 * parameters. Indexes on the partitioned parent are created on every
 * partition, including future ones; the build takes a SHARE lock on each
 * partition (writes of events wait while it runs — S5-review §7).
 *
 * Static DDL on `meta.*` only.
 * This file is locked by `migrations.lock.json`: never edit it once merged.
 */

const STATEMENTS = [
  `CREATE INDEX events_entity_idx
     ON meta.events (organization_id, entity_id, created_at)`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  // Static DDL only: no value in these statements comes from input.
  for (const statement of STATEMENTS) {
    await sql.raw(statement).execute(db);
  }
}
