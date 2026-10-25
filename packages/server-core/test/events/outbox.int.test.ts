import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditWriter, type AuditContext } from '../../src/audit/index.js';
import { orgScope, type Db } from '../../src/db/index.js';
import { emit, EventsRepository, EventWriter, type EventInput } from '../../src/events/index.js';
import { enqueue, JobsRepository } from '../../src/jobs/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';

const ORG_A = 'org_OutboxOrgA000001';
const ORG_B = 'org_OutboxOrgB000001';
const USER = 'usr_OutboxUser000001';

const context: AuditContext = {
  actor: { type: 'user', id: USER },
  via: null,
  batch_id: 'req_OutboxRequest001',
  request_id: 'req_OutboxRequest001',
  ip: '198.51.100.4',
  user_agent: 'vitest',
};

const recordUpdated: EventInput = {
  type: 'record.updated',
  organizationId: ORG_A,
  baseId: 'bse_OutboxBase000001',
  tableId: 'tbl_OutboxTable00001',
  entityId: 'rec_OutboxRecord0001',
  actor: { type: 'user', id: USER },
  changes: { fld_status: { from: ['opt_new'], to: ['opt_done'] } },
  recordVersion: 6,
};

interface QueueJob {
  id: string;
  task_identifier: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  key: string | null;
  queue_name: string | null;
}

class Rollback extends Error {}

describe('events, audit and jobs share the caller transaction', () => {
  let database: TestDatabase;
  let db: Db;
  const audit = new AuditWriter();
  const events = new EventWriter();
  let jobs: JobsRepository;
  let eventsRepo: EventsRepository;

  async function queueJobs(): Promise<QueueJob[]> {
    const { rows } = await sql<QueueJob>`
      SELECT id::text AS id, task_identifier, payload, jobs.attempts, jobs.max_attempts, jobs.key, queue_name
        FROM graphile_worker.jobs JOIN graphile_worker._private_jobs USING (id) ORDER BY id
    `.execute(db.kysely);
    return rows;
  }

  async function count(table: 'meta.events' | 'meta.audit_logs' | 'meta.jobs'): Promise<number> {
    const row = await db.kysely
      .selectFrom(table)
      .select((eb) => eb.fn.countAll<bigint>().as('n'))
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  async function clearQueue(): Promise<void> {
    await sql`DELETE FROM graphile_worker._private_jobs`.execute(db.kysely);
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    await db.kysely
      .insertInto('meta.organizations')
      .values([
        { id: ORG_A, name: 'A', slug: 'outbox-a' },
        { id: ORG_B, name: 'B', slug: 'outbox-b' },
      ])
      .execute();
    await db.kysely
      .insertInto('meta.users')
      .values({ id: USER, email: 'outbox@example.com', display_name: 'Outbox' })
      .execute();
    jobs = new JobsRepository(db);
    eventsRepo = new EventsRepository(db);
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('rollback leaves no event, no audit entry, no queued job and no meta.jobs row', async () => {
    await clearQueue();
    await expect(
      db.withTx(async (tx) => {
        await emit(tx, recordUpdated);
        await audit.write(tx, {
          action: 'record.updated',
          organizationId: ORG_A,
          tableId: 'tbl_OutboxTable00001',
          entityType: 'record',
          entityId: 'rec_OutboxRecord0001',
          before: { fld_status: ['opt_new'] },
          after: { fld_status: ['opt_done'] },
          context,
        });
        await jobs.create(orgScope(ORG_A, tx), { type: 'base.export', createdBy: USER });
        await enqueue(tx, 'partitions.maintain', {});
        // Visible inside the transaction…
        expect(await tx.selectFrom('meta.events').select('id').execute()).toHaveLength(1);
        throw new Rollback('abort');
      }),
    ).rejects.toBeInstanceOf(Rollback);

    // …and gone after the rollback.
    expect(await count('meta.events')).toBe(0);
    expect(await count('meta.audit_logs')).toBe(0);
    expect(await count('meta.jobs')).toBe(0);
    expect(await queueJobs()).toEqual([]);
  });

  it('commit stores the event and its events.dispatch job together', async () => {
    await clearQueue();
    const written = await db.withTx((tx) => events.write(tx, recordUpdated));

    const row = await db.kysely
      .selectFrom('meta.events')
      .selectAll()
      .where('id', '=', written.id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      organization_id: ORG_A,
      type: 'record.updated',
      entity_type: 'record',
      entity_id: 'rec_OutboxRecord0001',
      actor_type: 'user',
      actor_id: USER,
      payload: {
        base_id: 'bse_OutboxBase000001',
        table_id: 'tbl_OutboxTable00001',
        changes: { fld_status: { from: ['opt_new'], to: ['opt_done'] } },
        record_version: 6,
      },
      causation: { root_event_id: written.id, depth: 0, automation_chain: [] },
      dispatched_at: null,
    });

    const queued = await queueJobs();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      id: written.dispatchJob.id,
      task_identifier: 'events.dispatch',
      attempts: 0,
      key: null,
      // ADR-18: never a named queue for dispatch.
      queue_name: null,
      payload: { event_id: written.id, organization_id: ORG_A },
    });

    // The payload's created_at matches the partition key exactly (µs).
    const key = { id: written.id, createdAt: String(queued[0]?.payload.created_at) };
    expect(key.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    const scopeA = orgScope(ORG_A);
    expect(await eventsRepo.getByKey(scopeA, key)).toMatchObject({ id: written.id });
    // Tenant isolation: another organization sees nothing and changes nothing.
    const scopeB = orgScope(ORG_B);
    expect(await eventsRepo.getByKey(scopeB, key)).toBeUndefined();
    expect(await eventsRepo.markDispatched(scopeB, key)).toBe(false);
    expect(await eventsRepo.markDispatched(scopeA, key)).toBe(true);
    expect(await eventsRepo.markDispatched(scopeA, key)).toBe(false);
    expect((await eventsRepo.getByKey(scopeA, key))?.dispatched_at).toBeInstanceOf(Date);
  });

  it('laterRecordChanges: record.updated after a version, oldest first, own organization only (T527)', async () => {
    await clearQueue();
    const first = await db.withTx((tx) =>
      events.write(tx, { ...recordUpdated, entityId: 'rec_LaterRecord00001', recordVersion: 2 }),
    );
    await db.withTx((tx) =>
      events.write(tx, {
        ...recordUpdated,
        entityId: 'rec_LaterRecord00001',
        recordVersion: 4,
        changes: { fld_title: { from: 'b', to: 'c' } },
      }),
    );
    await db.withTx((tx) =>
      events.write(tx, {
        ...recordUpdated,
        entityId: 'rec_LaterRecord00001',
        recordVersion: 3,
        changes: { fld_title: { from: 'a', to: 'b' } },
      }),
    );
    // Another organization with the same record id.
    await db.withTx((tx) =>
      events.write(tx, {
        ...recordUpdated,
        organizationId: ORG_B,
        entityId: 'rec_LaterRecord00001',
        recordVersion: 5,
        changes: { fld_other: { from: 1, to: 2 } },
      }),
    );
    const since = first.createdAt.toISOString();
    expect(
      await eventsRepo.laterRecordChanges(orgScope(ORG_A), {
        recordId: 'rec_LaterRecord00001',
        afterVersion: 2,
        since,
      }),
    ).toEqual([{ fld_title: { from: 'a', to: 'b' } }, { fld_title: { from: 'b', to: 'c' } }]);
    expect(
      await eventsRepo.laterRecordChanges(orgScope(ORG_B), {
        recordId: 'rec_LaterRecord00001',
        afterVersion: 2,
        since,
      }),
    ).toEqual([{ fld_other: { from: 1, to: 2 } }]);
  });

  it('writeMany stores many events with one dispatch job each, like write', async () => {
    await clearQueue();
    const inputs: EventInput[] = [
      recordUpdated,
      { ...recordUpdated, entityId: 'rec_OutboxRecord0002', organizationId: ORG_B },
      { ...recordUpdated, entityId: 'rec_OutboxRecord0003', recordVersion: 1 },
    ];
    const ids = ['evt_OutboxMany000001', 'evt_OutboxMany000002', 'evt_OutboxMany000003'] as const;
    const written = await db.withTx((tx) => events.writeMany(tx, inputs, [...ids]));
    expect(written.map((event) => event.id)).toEqual(ids);
    expect(written.map((event) => event.organizationId)).toEqual([ORG_A, ORG_B, ORG_A]);

    const queued = await queueJobs();
    expect(queued).toHaveLength(3);
    for (const [index, event] of written.entries()) {
      const job = queued.find((item) => item.id === event.dispatchJob.id);
      expect(job).toMatchObject({
        task_identifier: 'events.dispatch',
        queue_name: null,
        key: null,
        payload: { event_id: event.id, organization_id: inputs[index]?.organizationId },
      });
      // Same partition key format as `write`: the dispatcher finds the row.
      const createdAt = String(job?.payload.created_at);
      expect(createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
      const scope = orgScope(event.organizationId);
      expect(await eventsRepo.getByKey(scope, { id: event.id, createdAt })).toMatchObject({
        entity_id: inputs[index]?.entityId,
        causation: { root_event_id: event.id, depth: 0, automation_chain: [] },
      });
    }

    const entries = await db.withTx((tx) =>
      audit.writeMany(
        tx,
        written.map((event, index) => ({
          action: 'record.updated' as const,
          organizationId: event.organizationId,
          tableId: 'tbl_OutboxTable00001',
          entityType: 'record',
          entityId: inputs[index]?.entityId ?? '',
          before: null,
          after: { fld_status: ['opt_done'] },
          context,
        })),
      ),
    );
    expect(entries).toHaveLength(3);
    const stored = await db.kysely
      .selectFrom('meta.audit_logs')
      .select(['id', 'entity_id', 'organization_id', 'batch_id'])
      .where(
        'id',
        'in',
        entries.map((entry) => entry.id),
      )
      .execute();
    expect(stored).toHaveLength(3);
    expect(new Set(stored.map((row) => row.batch_id))).toEqual(new Set([context.batch_id]));
    await expect(
      db.withTx((tx) =>
        audit.writeMany(tx, [
          {
            action: 'record.updated',
            organizationId: ORG_A,
            entityType: 'record',
            entityId: 'rec_x',
            after: { password: 'x' },
            context,
          },
        ]),
      ),
    ).rejects.toThrow(/secret/);
  });

  it('an unknown event type or audit action is rejected before anything is written', async () => {
    const before = await Promise.all([count('meta.events'), count('meta.audit_logs')]);
    await expect(
      db.withTx((tx) => emit(tx, { ...recordUpdated, type: 'record.exploded' as never })),
    ).rejects.toThrow(TypeError);
    await expect(
      db.withTx((tx) =>
        audit.write(tx, {
          action: 'record.exploded' as never,
          organizationId: ORG_A,
          entityType: 'record',
          context,
        }),
      ),
    ).rejects.toThrow(/unknown action 'record\.exploded'/);
    expect(await Promise.all([count('meta.events'), count('meta.audit_logs')])).toEqual(before);
  });

  it('writes audit entries, including auth.* without an organization', async () => {
    const { id } = await db.withTx((tx) =>
      audit.write(tx, {
        action: 'record.updated',
        organizationId: ORG_A,
        entityType: 'record',
        entityId: 'rec_OutboxRecord0001',
        after: { fld_status: ['opt_done'] },
        context: {
          ...context,
          actor: { type: 'automation', id: 'aut_OutboxAutomation' },
          via: { automation_id: 'aut_OutboxAutomation', run_id: 'run_OutboxRun0000001' },
        },
      }),
    );
    expect(
      await db.kysely
        .selectFrom('meta.audit_logs')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({
      organization_id: ORG_A,
      actor_type: 'automation',
      actor_id: 'aut_OutboxAutomation',
      via: { automation_id: 'aut_OutboxAutomation', run_id: 'run_OutboxRun0000001' },
      batch_id: 'req_OutboxRequest001',
      request_id: 'req_OutboxRequest001',
      before: null,
      ip: '198.51.100.4',
    });

    const anonymous = await db.withTx((tx) =>
      audit.write(tx, {
        action: 'auth.login_failed',
        organizationId: null,
        entityType: 'user',
        context: { ...context, actor: { type: 'system', id: null }, batch_id: null },
      }),
    );
    expect(
      (
        await db.kysely
          .selectFrom('meta.audit_logs')
          .select('organization_id')
          .where('id', '=', anonymous.id)
          .executeTakeFirstOrThrow()
      ).organization_id,
    ).toBeNull();
  });

  it('enqueue passes options to add_job and deduplicates by job key', async () => {
    await clearQueue();
    const runAt = new Date(Date.now() + 60_000);
    await db.withTx(async (tx) => {
      await enqueue(
        tx,
        'partitions.maintain',
        {},
        {
          jobKey: 'partitions',
          runAt,
          maxAttempts: 3,
          priority: 5,
          queueName: 'schema:tbl_OutboxTable00001',
        },
      );
      await enqueue(tx, 'partitions.maintain', {}, { jobKey: 'partitions', maxAttempts: 4 });
    });
    const queued = await queueJobs();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ key: 'partitions', max_attempts: 4, queue_name: null });

    await expect(
      db.withTx((tx) =>
        enqueue(tx, 'partitions.maintain', {}, { queueName: `org:${ORG_A}` as never }),
      ),
    ).rejects.toThrow(/ADR-18/);
  });
});
