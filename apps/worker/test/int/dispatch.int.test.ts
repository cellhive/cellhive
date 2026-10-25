import { emit, type Db } from '@cellhive/server-core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createWorker, type WorkerHandle } from '../../src/index.js';

import {
  captureLogger,
  createMigratedDatabase,
  createTestDb,
  queuedJobs,
  testConfig,
  waitFor,
  type CapturedLogger,
  type TestDatabase,
} from './support.js';

const ORG = 'org_DispatchOrg00001';
const SENSITIVE = 'Nguyễn Văn Ánh 0912345678';

/** `YYYYMM` of the UTC month `offset` months from now. */
function monthSuffix(offset: number): string {
  const now = new Date();
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  return `${String(month.getUTCFullYear())}${String(month.getUTCMonth() + 1).padStart(2, '0')}`;
}

describe('worker: events.dispatch and startup maintenance', () => {
  let database: TestDatabase;
  let db: Db;
  let worker: WorkerHandle;
  let captured: CapturedLogger;

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    await db.kysely
      .insertInto('meta.organizations')
      .values({ id: ORG, name: 'Dispatch', slug: 'dispatch' })
      .execute();
    captured = captureLogger();
    worker = await createWorker(testConfig(database.url), {
      logger: captured.logger,
      pollIntervalMs: 200,
    });
  });

  afterAll(async () => {
    await worker.close();
    await db.destroy();
    await database.drop();
  });

  it('dispatches a committed event: sets dispatched_at and logs no payload values', async () => {
    const written = await db.withTx((tx) =>
      emit(tx, {
        type: 'record.updated',
        organizationId: ORG,
        tableId: 'tbl_DispatchTable001',
        entityId: 'rec_DispatchRecord01',
        actor: { type: 'user', id: 'usr_DispatchUser0001' },
        changes: { fld_name: { from: 'x', to: SENSITIVE } },
      }),
    );

    const dispatchedAt = await waitFor(
      async () =>
        (
          await db.kysely
            .selectFrom('meta.events')
            .select('dispatched_at')
            .where('id', '=', written.id)
            .executeTakeFirstOrThrow()
        ).dispatched_at ?? undefined,
      { what: 'dispatched_at' },
    );
    expect(dispatchedAt).toBeInstanceOf(Date);
    // Completed jobs leave graphile-worker's queue.
    await waitFor(async () => (await queuedJobs(db, 'events.dispatch')).length === 0, {
      what: 'the dispatch job to complete',
    });

    const line = captured.lines.find((entry) => entry.msg === 'event dispatched');
    expect(line).toMatchObject({
      event_id: written.id,
      org_id: ORG,
      event_type: 'record.updated',
      entity_type: 'record',
      entity_id: 'rec_DispatchRecord01',
      redelivery: false,
    });
    expect(captured.raw()).not.toContain(SENSITIVE);
  });

  it('a rolled-back event is never dispatched', async () => {
    await expect(
      db.withTx(async (tx) => {
        await emit(tx, {
          type: 'record.created',
          organizationId: ORG,
          entityId: 'rec_DispatchRollback',
          actor: { type: 'system', id: null },
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    const { rows } = await sql<{ n: bigint }>`
      SELECT count(*) AS n FROM meta.events WHERE entity_id = 'rec_DispatchRollback'
    `.execute(db.kysely);
    expect(rows[0]?.n).toBe(0n);
    expect(await queuedJobs(db, 'events.dispatch')).toEqual([]);
  });

  it('runs partitions.maintain at start: partitions exist up to two months ahead', async () => {
    const expected = [0, 1, 2].flatMap((offset) => [
      `audit_logs_p${monthSuffix(offset)}`,
      `events_p${monthSuffix(offset)}`,
    ]);
    // Logged once the job has created every partition.
    await waitFor(
      () => Promise.resolve(captured.lines.some((entry) => entry.msg === 'partitions maintained')),
      { what: 'the startup partitions.maintain run' },
    );
    const { rows } = await sql<{ name: string }>`
      SELECT relname AS name FROM pg_class
       WHERE relnamespace = 'meta'::regnamespace AND relname = ANY (${expected}::text[])
       ORDER BY 1
    `.execute(db.kysely);
    expect(rows.map((row) => row.name)).toEqual([...expected].sort());
  });

  it('registers the daily partitions.maintain cron item', async () => {
    const { rows } = await sql<{ identifier: string }>`
      SELECT identifier FROM graphile_worker._private_known_crontabs
    `.execute(db.kysely);
    expect(rows.map((row) => row.identifier)).toContain('partitions.maintain');
  });
});
