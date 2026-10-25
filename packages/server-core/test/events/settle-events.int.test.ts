import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AutomationsRepository } from '../../src/automation/index.js';
import { orgScope, type Db } from '../../src/db/index.js';
import {
  EventsNotSettleableError,
  EventWriter,
  settleEventsWithoutAutomations,
  type EventInput,
} from '../../src/events/index.js';
import { enqueue } from '../../src/jobs/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { seedTenant, type SeededTenant } from '../support/tenant.js';

import type { Id } from '@cellhive/contracts';

const ORG_A: Id<'org'> = 'org_SettleOrgA000001';
const ORG_B: Id<'org'> = 'org_SettleOrgB000001';

function created(tenant: SeededTenant, index: number): EventInput {
  return {
    type: 'record.created',
    organizationId: tenant.orgId,
    baseId: tenant.baseId,
    tableId: 'tbl_SettleTable00001',
    entityId: `rec_Settle${String(index).padStart(10, '0')}`,
    actor: { type: 'user', id: tenant.userId },
    recordVersion: 1,
  };
}

/**
 * BACKLOG T519: the pending events of an organization without automations
 * are settled at once (no `events.dispatch` backlog after a bulk load);
 * never those of another organization, never once an automation exists.
 */
describe('settleEventsWithoutAutomations (T519)', () => {
  let database: TestDatabase;
  let db: Db;
  let a: SeededTenant;
  let b: SeededTenant;
  const writer = new EventWriter();

  async function pending(orgId: Id<'org'>): Promise<{ events: number; jobs: number }> {
    const { rows } = await sql<{ events: number; jobs: number }>`
      SELECT (SELECT count(*)::int FROM meta.events
               WHERE organization_id = ${orgId} AND dispatched_at IS NULL) AS events,
             (SELECT count(*)::int FROM graphile_worker.jobs JOIN graphile_worker._private_jobs USING (id)
               WHERE task_identifier = 'events.dispatch'
                 AND payload->>'organization_id' = ${orgId}) AS jobs
    `.execute(db.kysely);
    return rows[0] ?? { events: -1, jobs: -1 };
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    a = await seedTenant(db, ORG_A);
    b = await seedTenant(db, ORG_B);
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('marks the pending events of one organization dispatched and removes their jobs', async () => {
    await db.withTx((tx) =>
      writer.writeMany(
        tx,
        Array.from({ length: 1_500 }, (_, index) => created(a, index)),
      ),
    );
    await db.withTx((tx) => writer.write(tx, created(b, 1)));
    // Another task of the organization stays queued.
    await db.withTx((tx) => enqueue(tx, 'partitions.maintain', {}));
    expect(await pending(ORG_A)).toEqual({ events: 1_500, jobs: 1_500 });

    // In chunks of 400: four statements.
    expect(await settleEventsWithoutAutomations(db, orgScope(ORG_A), { chunkSize: 400 })).toEqual({
      events: 1_500,
      jobs: 1_500,
    });
    expect(await pending(ORG_A)).toEqual({ events: 0, jobs: 0 });
    // Tenant isolation: the other organization keeps its event and job.
    expect(await pending(ORG_B)).toEqual({ events: 1, jobs: 1 });
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM graphile_worker.jobs WHERE task_identifier = 'partitions.maintain'
    `.execute(db.kysely);
    expect(rows[0]?.n).toBe(1);
    // Nothing left: a second call is a no-op.
    expect(await settleEventsWithoutAutomations(db, orgScope(ORG_A))).toEqual({
      events: 0,
      jobs: 0,
    });
  });

  it('leaves a job a worker holds; the worker then finds its event dispatched', async () => {
    const written = await db.withTx((tx) => writer.write(tx, created(a, 9_000)));
    await sql`
      UPDATE graphile_worker._private_jobs SET locked_at = now(), locked_by = 'worker-1'
       WHERE id = ${written.dispatchJob.id}::bigint
    `.execute(db.kysely);
    expect(await settleEventsWithoutAutomations(db, orgScope(ORG_A))).toEqual({
      events: 1,
      jobs: 0,
    });
    expect(await pending(ORG_A)).toEqual({ events: 0, jobs: 1 });
    await sql`DELETE FROM graphile_worker._private_jobs WHERE id = ${written.dispatchJob.id}::bigint`.execute(
      db.kysely,
    );
  });

  it('commits chunk by chunk: a lock on a later event never holds back the earlier ones (T818)', async () => {
    const written = await db.withTx((tx) =>
      writer.writeMany(
        tx,
        Array.from({ length: 3 }, (_, index) => created(a, 9_100 + index)),
      ),
    );
    const last = written.at(-1);
    if (last === undefined) throw new Error('no event written');
    // What a dispatch job a worker holds does: lock the last event's row.
    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked = (): void => undefined;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = db.withTx(async (tx) => {
      await sql`
        SELECT 1 FROM meta.events WHERE id = ${last.id} FOR UPDATE
      `.execute(tx);
      locked();
      await released;
    });
    await isLocked;
    const settling = settleEventsWithoutAutomations(db, orgScope(ORG_A), { chunkSize: 1 });
    // The first two chunks are committed while the third waits on the lock.
    await expect
      .poll(async () => (await pending(ORG_A)).events, { timeout: 5_000, interval: 50 })
      .toBe(1);
    release();
    await holder;
    expect(await settling).toEqual({ events: 3, jobs: 3 });
    expect(await pending(ORG_A)).toEqual({ events: 0, jobs: 0 });
  });

  it('refuses once the organization has an automation, and changes nothing', async () => {
    await db.withTx((tx) => writer.write(tx, created(b, 2)));
    await new AutomationsRepository(db).insert(orgScope(ORG_B), {
      id: 'aut_SettleAutomat001',
      baseId: b.baseId,
      name: 'Daily',
      description: '',
      enabled: false,
      definition: { trigger: { type: 'schedule', cron: '0 8 * * *', timezone: null }, actions: [] },
      triggerType: 'schedule',
      triggerTableId: null,
      createdBy: b.userId,
    });
    await expect(settleEventsWithoutAutomations(db, orgScope(ORG_B))).rejects.toBeInstanceOf(
      EventsNotSettleableError,
    );
    expect(await pending(ORG_B)).toEqual({ events: 2, jobs: 2 });
  });
});
