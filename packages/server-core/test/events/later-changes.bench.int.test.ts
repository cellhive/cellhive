/**
 * Opt-in bench (BACKLOG T528): `EVENTS_BENCH=1 pnpm --filter
 * @cellhive/server-core test:int test/events/later-changes.bench`.
 *
 * `EventsRepository.laterRecordChanges` (T527) runs once per event
 * dispatched against a `record.matches` automation. It reads the
 * `record.updated` events of one record written after the event. With the
 * index `(organization_id, created_at)` alone it walks every event of the
 * organization since then: cheap when dispatch keeps up, quadratic for a
 * backlog (an import or an `update_records` of thousands of rows dispatched
 * late). This bench measures it on a realistic volume, then with the
 * index `(organization_id, entity_id, created_at)` (migration 0037), and the
 * cost of that index on inserts.
 *
 * Volume (`EVENTS_BENCH_HISTORY` to change it): per organization, 1 000 000
 * events over 30 days on 50 000 records; organization A also has a backlog
 * of 50 000 events in the last 30 minutes (5 000 records × 10 changes).
 *
 * Reports numbers; never fails on them. Measured only when the 1-minute
 * load is below 8, else reported as pending.
 */
import os from 'node:os';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { orgScope, type Db } from '../../src/db/index.js';
import { EventsRepository } from '../../src/events/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';

const ORG_A = 'org_T528EventsBenchA';
const ORG_B = 'org_T528EventsBenchB';
const HISTORY = Number(process.env['EVENTS_BENCH_HISTORY'] ?? '1000000');
const RECORDS = 50_000;
const BACKLOG_RECORDS = 5_000;
const BACKLOG_PER_RECORD = 10;
const SAMPLES = 200;
const INSERTS = 100_000;
const LOAD_LIMIT = 8;

const load = () => os.loadavg()[0] ?? 0;

function percentile(samples: readonly number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

interface Probe {
  readonly entity_id: string;
  readonly version: number;
  readonly created_at: string;
}

describe.skipIf(process.env['EVENTS_BENCH'] !== '1')('laterRecordChanges bench (T528)', () => {
  let database: TestDatabase;
  let db: Db;
  let repo: EventsRepository;
  const report: string[] = [];

  /** `count` events of `org` on `records` records spread over [from, to] ago. */
  async function insertEvents(input: {
    org: string;
    count: number;
    records: number;
    recordPrefix: string;
    fromAgo: string;
    toAgo: string;
  }): Promise<void> {
    await sql`
      INSERT INTO meta.events
        (id, organization_id, type, entity_type, entity_id, actor_type, payload, created_at, dispatched_at)
      SELECT
        'evt_' || md5(${input.org} || ${input.recordPrefix} || g::text),
        ${input.org},
        CASE WHEN g % 5 = 0 THEN 'record.created' ELSE 'record.updated' END,
        'record',
        ${input.recordPrefix} || lpad((g % ${input.records})::text, 10, '0'),
        'user',
        jsonb_build_object(
          'record_version', g / ${input.records} + 1,
          'changes', jsonb_build_object('fld_status', jsonb_build_object('from', g - 1, 'to', g))
        ),
        now() - ${input.fromAgo}::interval
          + (${input.fromAgo}::interval - ${input.toAgo}::interval) * (g::float8 / ${input.count}),
        now()
      FROM generate_series(1, ${input.count}) AS g
    `.execute(db.kysely);
  }

  async function probes(): Promise<Probe[]> {
    // Backlog events, earliest first (the worst case: the most events after them).
    const { rows } = await sql<Probe>`
      SELECT entity_id, (payload->>'record_version')::int AS version,
             to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
        FROM meta.events
       WHERE organization_id = ${ORG_A} AND entity_id LIKE 'rec_backlog%'
       ORDER BY created_at
       LIMIT ${SAMPLES}
    `.execute(db.kysely);
    return rows;
  }

  async function measure(label: string): Promise<void> {
    const scope = orgScope(ORG_A);
    const targets = await probes();
    const samples: number[] = [];
    let found = 0;
    for (const probe of targets) {
      const started = performance.now();
      const changes = await repo.laterRecordChanges(scope, {
        recordId: probe.entity_id,
        afterVersion: probe.version,
        since: probe.created_at,
      });
      samples.push(performance.now() - started);
      found += changes.length;
    }
    const first = targets[0];
    if (first === undefined) throw new Error('no backlog event');
    const { rows } = await sql<{ 'QUERY PLAN': string }>`
      EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY ON)
      SELECT payload FROM meta.events
       WHERE organization_id = ${ORG_A}
         AND created_at >= ${first.created_at}::timestamptz
         AND entity_type = 'record'
         AND entity_id = ${first.entity_id}
         AND type = 'record.updated'
         AND (payload->>'record_version')::int > ${first.version}
       ORDER BY (payload->>'record_version')::int
    `.execute(db.kysely);
    const plan = rows.map((row) => row['QUERY PLAN']);
    const total = samples.reduce((sum, value) => sum + value, 0);
    report.push(
      `${label}: ${String(targets.length)} backlog events, p50 ${percentile(samples, 50).toFixed(2)} ms, ` +
        `p95 ${percentile(samples, 95).toFixed(2)} ms, max ${Math.max(...samples).toFixed(2)} ms, ` +
        `sum ${total.toFixed(0)} ms (${String(found)} later changes)`,
      ...plan
        .filter((line) => /Scan|Rows Removed|Buffers|Execution Time|Sort/.test(line))
        .map((line) => `    ${line.trim()}`),
    );
    expect(found).toBeGreaterThan(0);
  }

  async function insertCost(label: string, prefix: string): Promise<void> {
    const started = performance.now();
    await insertEvents({
      org: ORG_A,
      count: INSERTS,
      records: INSERTS / 10,
      recordPrefix: prefix,
      fromAgo: '10 minutes',
      toAgo: '5 minutes',
    });
    report.push(
      `${label}: INSERT ${String(INSERTS)} events ${(performance.now() - started).toFixed(0)} ms`,
    );
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    // Bulk seeding runs past the request statement timeout.
    db = createTestDb(database.url, { statementTimeoutMs: 0 });
    await migrateAll(database.url, db);
    await sql`SELECT meta.create_monthly_partition('events', (now() - interval '31 days')::date)`.execute(
      db.kysely,
    );
    await sql`SELECT meta.create_monthly_partition('events', now()::date)`.execute(db.kysely);
    repo = new EventsRepository(db);
    const started = performance.now();
    for (const org of [ORG_A, ORG_B]) {
      await insertEvents({
        org,
        count: HISTORY,
        records: RECORDS,
        recordPrefix: 'rec_history',
        fromAgo: '30 days',
        toAgo: '31 minutes',
      });
    }
    await insertEvents({
      org: ORG_A,
      count: BACKLOG_RECORDS * BACKLOG_PER_RECORD,
      records: BACKLOG_RECORDS,
      recordPrefix: 'rec_backlog',
      fromAgo: '30 minutes',
      toAgo: '1 second',
    });
    await sql`ANALYZE meta.events`.execute(db.kysely);
    report.push(
      `seed: ${String(2 * HISTORY + BACKLOG_RECORDS * BACKLOG_PER_RECORD)} events in ${(
        (performance.now() - started) /
        1000
      ).toFixed(1)} s (load ${load().toFixed(2)})`,
    );
  }, 1_800_000);

  afterAll(async () => {
    process.stdout.write(`\nT528 laterRecordChanges bench\n${report.join('\n')}\n`);
    await db.destroy();
    await database.drop();
  });

  it('measures the backlog with and without the entity index', async (context) => {
    if (load() >= LOAD_LIMIT) {
      report.push(`PENDING: load ${load().toFixed(2)} ≥ ${String(LOAD_LIMIT)}`);
      context.skip();
    }
    const migrated = await sql<{ indexname: string }>`
      SELECT indexname FROM pg_indexes
       WHERE schemaname = 'meta' AND tablename = 'events' AND indexname = 'events_entity_idx'
    `.execute(db.kysely);
    if (migrated.rows.length > 0) {
      // Migration 0037 is applied: measure with it, then without it.
      await measure('with (organization_id, entity_id, created_at)');
      await insertCost('with the index', 'rec_insert_a');
      await sql`DROP INDEX meta.events_entity_idx`.execute(db.kysely);
      await sql`ANALYZE meta.events`.execute(db.kysely);
      await measure('without (only organization_id, created_at)');
      await insertCost('without the index', 'rec_insert_b');
    } else {
      await measure('without (only organization_id, created_at)');
      await insertCost('without the index', 'rec_insert_b');
    }
  }, 1_800_000);
});
