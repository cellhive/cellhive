import {
  BasesRepository,
  NotificationBuffer,
  orgScope,
  SchemaService,
  systemAuditContext,
  type Db,
  type NotificationGrouper,
  type TableRow,
} from '@cellhive/server-core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createWorker, type WorkerHandle } from '../../src/index.js';
import { buildTaskList } from '../../src/tasks/index.js';
import { createNotificationsCleanupTask } from '../../src/tasks/notifications-cleanup.js';

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

import type { Id } from '@cellhive/contracts';
import type { JobHelpers } from 'graphile-worker';

const ORG: Id<'org'> = 'org_NtfFlushOrg00001';
const OWNER: Id<'usr'> = 'usr_NtfFlushOwner001';
const ANN: Id<'usr'> = 'usr_NtfFlushAnn00001';
const BOB: Id<'usr'> = 'usr_NtfFlushBob00001';
const FIELD: Id<'fld'> = 'fld_NtfFlushField001';

/** Test grouper (the real ones arrive with T544/T545): one notification per recipient. */
const grouper: NotificationGrouper = {
  kind: 'assigned',
  group(group) {
    const byUser = new Map<Id<'usr'>, Id<'rec'>[]>();
    for (const row of group.rows) {
      if (row.user_id === null) continue;
      byUser.set(row.user_id, [...(byUser.get(row.user_id) ?? []), row.record_id]);
    }
    return [...byUser].map(([userId, records]) => ({
      type: 'record.assigned' as const,
      baseId: baseIdOf(),
      tableId: group.rows[0]?.table_id ?? null,
      entityType: 'table' as const,
      entityId: group.rows[0]?.table_id ?? '',
      actor: null,
      groupKey: group.groupKey,
      recipients: [userId],
      dataFor: () => ({
        batch_id: group.groupKey,
        count: records.length,
        record_ids: records.slice(0, 20),
        field_ids: [FIELD],
      }),
    }));
  },
};

let currentBase: Id<'bse'> | null = null;
function baseIdOf(): Id<'bse'> | null {
  return currentBase;
}

/**
 * BACKLOG T542 through the real worker (graphile-worker + PostgreSQL): the
 * buffer's job runs once per group after its debounce, early with
 * `flushWhenCount`, never writes twice, and a group whose job was lost is
 * flushed again by `notifications.cleanup`.
 */
describe('worker: notifications.flush (T542)', () => {
  let database: TestDatabase;
  let db: Db;
  let worker: WorkerHandle;
  let captured: CapturedLogger;
  let table: TableRow;
  let seq = 0;
  const rec = () => `rec_NtfFlushRec${String((seq += 1)).padStart(5, '0')}` as Id<'rec'>;

  const notified = async (groupKey: string) =>
    db.kysely
      .selectFrom('meta.notifications')
      .select(['user_id', 'payload'])
      .where('group_key', '=', groupKey)
      .orderBy('user_id')
      .execute();

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    await db.kysely
      .insertInto('meta.organizations')
      .values({ id: ORG, name: 'Acme', slug: 'acme-flush' })
      .execute();
    await db.kysely
      .insertInto('meta.users')
      .values([OWNER, ANN, BOB].map((id) => ({ id, email: `${id}@flush.test`, display_name: id })))
      .execute();
    // Organization admins read every base (the access check runs for real).
    await db.kysely
      .insertInto('meta.org_members')
      .values([
        { organization_id: ORG, user_id: OWNER, role: 'owner' },
        { organization_id: ORG, user_id: ANN, role: 'admin' },
        { organization_id: ORG, user_id: BOB, role: 'admin' },
      ])
      .execute();
    await db.kysely
      .insertInto('meta.workspaces')
      .values({ id: 'wsp_NtfFlushWsp00001', organization_id: ORG, name: 'Main', slug: 'main' })
      .execute();
    const base = await new BasesRepository(db).create(orgScope(ORG), {
      workspaceId: 'wsp_NtfFlushWsp00001',
      ownerId: OWNER,
      name: 'Sales',
    });
    currentBase = base.id;
    table = (
      await new SchemaService(db, { maxFieldsPerTable: 50 }).createTable(
        orgScope(ORG),
        { baseId: base.id, name: 'Orders', primaryFieldName: 'title' },
        systemAuditContext(),
      )
    ).table;
    captured = captureLogger();
    const config = testConfig(database.url);
    worker = await createWorker(config, {
      logger: captured.logger,
      pollIntervalMs: 100,
      taskList: buildTaskList({
        config,
        db,
        logger: captured.logger,
        notificationGroupers: [grouper],
      }),
    });
  });

  afterAll(async () => {
    await worker.close();
    await db.destroy();
    await database.drop();
  });

  const append = (
    groupKey: string,
    rows: readonly { userId: Id<'usr'>; recordId: Id<'rec'> }[],
    options: { delayMs?: number; flushWhenCount?: number } = {},
  ) =>
    db.withTx((tx) =>
      new NotificationBuffer(db, {
        delays: { assigned: options.delayMs ?? 10_000 },
      }).append(tx, {
        organizationId: ORG,
        kind: 'assigned',
        groupKey,
        rows: rows.map((row) => ({
          userId: row.userId,
          tableId: table.id,
          recordId: row.recordId,
          fieldIds: [FIELD],
          actor: null,
        })),
        ...(options.flushWhenCount === undefined ? {} : { flushWhenCount: options.flushWhenCount }),
      }),
    );

  it('3 appends to one group → 1 job → 1 flush → 1 notification per recipient', async () => {
    const group = 'job_NtfFlushGroup001';
    const [a1, a2, b1] = [rec(), rec(), rec()];
    await append(group, [{ userId: ANN, recordId: a1 }], { delayMs: 1_500 });
    await append(group, [{ userId: ANN, recordId: a2 }], { delayMs: 1_500 });
    await append(group, [{ userId: BOB, recordId: b1 }], { delayMs: 1_500 });
    const jobs = (await queuedJobs(db, 'notifications.flush')).filter(
      (job) => job.payload.group_key === group,
    );
    expect(jobs).toHaveLength(1);
    const written = await waitFor(
      async () => {
        const rows = await notified(group);
        return rows.length === 2 ? rows : undefined;
      },
      { what: 'the flushed notifications' },
    );
    expect(written).toEqual([
      {
        user_id: ANN,
        payload: { batch_id: group, count: 2, record_ids: [a1, a2], field_ids: [FIELD] },
      },
      {
        user_id: BOB,
        payload: { batch_id: group, count: 1, record_ids: [b1], field_ids: [FIELD] },
      },
    ]);
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM meta.notification_buffer WHERE group_key = ${group}
    `.execute(db.kysely);
    expect(rows[0]?.n).toBe(0);
    const flushed = captured.lines.filter(
      (line) => line.msg === 'notification buffer flushed' && line.status === 'flushed',
    );
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toMatchObject({ org_id: ORG, kind: 'assigned', rows: 3, recorded: 2 });

    // The same job delivered again: nothing left, nothing written twice.
    await db.withTx((tx) =>
      sql`SELECT graphile_worker.add_job('notifications.flush',
            json_build_object('organization_id', ${ORG}::text, 'kind', 'assigned',
                              'group_key', ${group}::text))`.execute(tx),
    );
    await waitFor(
      () =>
        Promise.resolve(
          captured.lines.some(
            (line) => line.msg === 'notification buffer flushed' && line.status === 'empty',
          ),
        ),
      { what: 'the second run' },
    );
    expect(await notified(group)).toHaveLength(2);
  });

  it('flushWhenCount: flushed at once when the batch is complete', async () => {
    const group = 'job_NtfFlushGroup002';
    // A 10-minute debounce: only the count can flush it within the test.
    await append(group, [{ userId: ANN, recordId: rec() }], {
      delayMs: 600_000,
      flushWhenCount: 2,
    });
    const before = Date.now();
    await append(group, [{ userId: ANN, recordId: rec() }], {
      delayMs: 600_000,
      flushWhenCount: 2,
    });
    const written = await waitFor(
      async () => {
        const rows = await notified(group);
        return rows.length === 1 ? rows : undefined;
      },
      { what: 'the early flush', timeoutMs: 5_000 },
    );
    expect(Date.now() - before).toBeLessThan(5_000);
    expect(written[0]?.payload).toMatchObject({ count: 2 });
  });

  it('a group whose job was lost is flushed again by notifications.cleanup after 10 minutes', async () => {
    const group = 'job_NtfFlushGroup003';
    await append(group, [{ userId: BOB, recordId: rec() }], { delayMs: 600_000 });
    // The job is lost.
    await sql`SELECT graphile_worker.remove_job(${`assigned:${group}`})`.execute(db.kysely);
    const cleanup = createNotificationsCleanupTask({
      db,
      logger: captured.logger,
      retentionDays: 90,
    });
    const helpers = { job: { id: '1' } } as unknown as JobHelpers;
    // 9 minutes: not stale yet.
    await sql`
      UPDATE meta.notification_buffer SET created_at = now() - interval '9 minutes'
       WHERE group_key = ${group}
    `.execute(db.kysely);
    await cleanup({ buffers_only: true }, helpers);
    expect(
      (await queuedJobs(db, 'notifications.flush')).filter((j) => j.payload.group_key === group),
    ).toEqual([]);
    // 11 minutes: stale, flushed now.
    await sql`
      UPDATE meta.notification_buffer SET created_at = now() - interval '11 minutes'
       WHERE group_key = ${group}
    `.execute(db.kysely);
    await cleanup({ buffers_only: true }, helpers);
    const written = await waitFor(
      async () => {
        const rows = await notified(group);
        return rows.length === 1 ? rows : undefined;
      },
      { what: 'the re-flushed group' },
    );
    expect(written[0]?.user_id).toBe(BOB);
    expect(
      captured.lines.findLast((line) => line.msg === 'stale notification buffers flushed'),
    ).toMatchObject({ stale_buffer_groups: 1 });
    // The daily run does both: purge and the sweep (nothing stale left).
    await cleanup({}, helpers);
    expect(
      captured.lines.findLast((line) => line.msg === 'expired notifications purged'),
    ).toMatchObject({ notifications: 0, stale_buffer_groups: 0 });
  });
});
