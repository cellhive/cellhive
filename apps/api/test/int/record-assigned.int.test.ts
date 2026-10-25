import { cpus, loadavg } from 'node:os';
import { performance } from 'node:perf_hooks';

import {
  importUploadSchema,
  jobSchema,
  recordFollowSchema,
  recordsResponseSchema,
  type Id,
  type RealtimeServerMessage,
} from '@cellhive/contracts';
import { type Db } from '@cellhive/server-core';
import { buildTaskList, createWorker, type WorkerHandle } from '@cellhive/worker';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DB } from '../../src/common/tokens.js';

import { startSmtpCapture, type SmtpCapture } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { closeSockets, listen, TestSocket } from './realtime-support.js';
import { buildRecordFixture, type FixtureUser, type RecordFixture } from './record-fixture.js';
import { captureLogger, startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

type TaskList = ReturnType<typeof buildTaskList>;
type AnyTask = NonNullable<TaskList[string]>;

const BOUNDARY = 'cellhive-record-assigned';

function multipart(filename: string, bytes: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        'Content-Type: text/csv\r\n\r\n',
    ),
    bytes,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
}

async function eventually<T>(
  probe: () => Promise<T | undefined | false>,
  label: string,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** The decoded `text/plain` part of a raw `multipart/alternative` message. */
function plainText(raw: string): string {
  const boundary = /boundary="?([^";\r\n]+)"?/.exec(raw)?.[1] ?? '';
  for (const part of raw.split(`--${boundary}`)) {
    const split = part.search(/\r?\n\r?\n/);
    if (split < 0 || !/content-type:\s*text\/plain/i.test(part.slice(0, split))) continue;
    const head = part.slice(0, split);
    const body = part.slice(split).trim();
    if (/content-transfer-encoding:\s*base64/i.test(head)) {
      return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
    }
    if (/content-transfer-encoding:\s*quoted-printable/i.test(head)) {
      const bytes: number[] = [];
      const value = body.replace(/=\r?\n/g, '');
      for (let i = 0; i < value.length; i += 1) {
        const hex = value.slice(i + 1, i + 3);
        if (value[i] === '=' && /^[0-9A-F]{2}$/i.test(hex)) {
          bytes.push(parseInt(hex, 16));
          i += 2;
        } else {
          bytes.push(value.charCodeAt(i));
        }
      }
      return Buffer.from(bytes).toString('utf8');
    }
    return body;
  }
  return '';
}

/** p-th percentile (nearest rank) of a sample. */
function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? Number.NaN;
}

/**
 * BACKLOG T544 acceptance through the real API and worker (graphile-worker,
 * PostgreSQL, fake SMTP; ADR-34 §2, "Quyết định S5b" #7, mốc S5b):
 *
 * - u_editor assigns u_sales1 to `owner` (flag on) → `notification.created`
 *   on `user:<u_sales1>` (p95 < 1 s on an idle machine), the notification
 *   email (`immediate`, batch shortened), u_sales1 follows the record;
 * - a paste of 200 rows assigning u_sales2 → **one** notification
 *   "200 records" and one email;
 * - P40: assigned to `reviewers` of a record they cannot read → nothing on
 *   any channel, no follow;
 * - a worker stopped in the middle of a batch → exactly one notification
 *   once it runs again;
 * - an import of 5 000 rows → one notification per assignee.
 */
describe('record.assigned through the API and worker (T544)', () => {
  let database: TestDatabase;
  let db: Db;
  let smtp: SmtpCapture;
  let t: TestApp;
  let url: string;
  let fx: RecordFixture;
  let worker: WorkerHandle | null = null;
  let reviewers: Id<'fld'>;
  const sockets: TestSocket[] = [];
  const { logger } = captureLogger();

  const F = (name: string) => fx.fld[name]?.id as Id<'fld'>;
  const U = (user: FixtureUser) => fx.users[user].id;
  const users = (...keys: FixtureUser[]) => keys.map((key) => ({ id: U(key) }));

  // Notification emails batched for 1 s (5 min in production); the api's database
  // handle, whose realtime bus is attached, so that `notification.created` is published.
  const tasks = (): TaskList =>
    buildTaskList({
      config: t.config,
      db: t.app.get<Db>(DB),
      logger,
      notificationEmailBatchMs: 1_000,
    });

  async function startWorker(taskList: TaskList = tasks()): Promise<WorkerHandle> {
    return createWorker(t.config, { logger, pollIntervalMs: 50, taskList });
  }

  async function socketOf(user: FixtureUser): Promise<TestSocket> {
    const socket = await TestSocket.connect(url, {
      origin: TEST_PUBLIC_URL,
      cookie: await fx.cookie(user),
    });
    sockets.push(socket);
    expect(await socket.subscribe(`user:${U(user)}`)).toMatchObject({ type: 'subscribed' });
    return socket;
  }

  async function createOrders(
    user: FixtureUser,
    records: readonly Record<string, unknown>[],
  ): Promise<Id<'rec'>[]> {
    const response = await fx.call(
      user,
      'POST',
      `/tables/${fx.orders.id}/records?field_key_type=id`,
      { records: records.map((fields) => ({ fields })) },
    );
    expect(response.statusCode, response.body).toBe(201);
    return recordsResponseSchema.parse(response.json()).records.map((record) => record.id);
  }

  async function update(
    user: FixtureUser,
    records: readonly { id: Id<'rec'>; fields: Record<string, unknown> }[],
  ): Promise<void> {
    const response = await fx.call(
      user,
      'PATCH',
      `/tables/${fx.orders.id}/records?field_key_type=id`,
      { records },
    );
    expect(response.statusCode, response.body).toBe(200);
  }

  /** Every event dispatched, every fan-out and `assigned` flush run (follow flushes wait 60 s, T545). */
  async function settled(timeoutMs = 120_000): Promise<void> {
    await eventually(
      async () => {
        const { rows } = await sql<{ events: number; jobs: number; buffered: number }>`
          SELECT (SELECT count(*)::int FROM meta.events WHERE dispatched_at IS NULL) AS events,
                 (SELECT count(*)::int FROM graphile_worker._private_jobs p
                    JOIN graphile_worker._private_tasks t ON t.id = p.task_id
                   WHERE t.identifier = 'notifications.fanout'
                      OR (t.identifier = 'notifications.flush' AND p.payload->>'kind' = 'assigned')) AS jobs,
                 (SELECT count(*)::int FROM meta.notification_buffer WHERE kind = 'assigned') AS buffered
        `.execute(db.kysely);
        const row = rows[0];
        return row !== undefined && row.events === 0 && row.jobs === 0 && row.buffered === 0;
      },
      'events, fan-outs and flushes to settle',
      timeoutMs,
    );
  }

  async function assignedTo(user: FixtureUser) {
    return db.kysely
      .selectFrom('meta.notifications')
      .select(['id', 'entity_type', 'entity_id', 'actor_id', 'payload'])
      .where('organization_id', '=', fx.orgId)
      .where('user_id', '=', U(user))
      .where('type', '=', 'record.assigned')
      .orderBy('created_at')
      .orderBy('id')
      .execute();
  }

  const mailsTo = (user: FixtureUser) =>
    smtp.messages.filter((message) => message.to.includes(fx.users[user].email));

  const isAssigned = (message: RealtimeServerMessage) =>
    message.type === 'notification.created' && message.notification_type === 'record.assigned';

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    smtp = await startSmtpCapture();
    t = await startTestApp({
      DATABASE_URL: database.url,
      SMTP_URL: smtp.url,
      SMTP_FROM: 'Cellhive <noreply@cellhive.test>',
      SMTP_ALLOW_INSECURE: 'true',
    });
    url = await listen(t.app);
    fx = await buildRecordFixture(t, db);
    const patched = await fx.call('owner', 'PATCH', `/fields/${F('owner')}`, {
      options: { multiple: false, notify_on_assign: true },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    const added = await fx.call('owner', 'POST', `/tables/${fx.orders.id}/fields`, {
      name: 'reviewers',
      type: 'user',
      options: { multiple: true, notify_on_assign: true },
    });
    expect(added.statusCode, added.body).toBe(201);
    reviewers = added.json<{ id: Id<'fld'> }>().id;
    worker = await startWorker();
  }, 120_000);

  afterAll(async () => {
    await closeSockets(sockets);
    await worker?.close();
    await t.close();
    await smtp.close();
    await db.destroy();
    await database.drop();
  });

  it('mốc S5b: u_editor assigns u_sales1 to owner → realtime < 1 s (p95), email, follow', async () => {
    const socket = await socketOf('u_sales1');
    const records = await createOrders(
      'u_editor',
      Array.from({ length: 11 }, (_, i) => ({ [F('title')]: `Đơn mốc ${String(i)}` })),
    );
    await settled();

    // First assignment: the notification, then its email (immediate, 1 s batch here).
    const first = records[0] as Id<'rec'>;
    await update('u_editor', [{ id: first, fields: { [F('owner')]: users('u_sales1') } }]);
    const created = await socket.next(isAssigned, 30_000);
    expect(created).toMatchObject({ organization_id: fx.orgId, base_id: fx.baseId });
    const mail = await eventually(
      () => Promise.resolve(mailsTo('u_sales1')[0]),
      'the notification email',
    );
    const text = plainText(mail.raw);
    // In the recipient's language (the fixture organization is `vi`).
    expect(text).toContain('Bạn được gán một bản ghi trong “Orders”');
    expect(text).toContain('Đơn mốc 0');
    expect(text).toContain(`${TEST_PUBLIC_URL}/b/${fx.baseId}/t/${fx.orders.id}?record=${first}`);
    const follow = await fx.call(
      'u_sales1',
      'GET',
      `/tables/${fx.orders.id}/records/${first}/follow`,
    );
    expect(recordFollowSchema.parse(follow.json())).toEqual({
      following: true,
      source: 'assigned',
    });

    // Latency of 10 more single assignments: PATCH answered → notification.created.
    const latencies: number[] = [];
    for (const id of records.slice(1)) {
      await update('u_editor', [{ id, fields: { [F('owner')]: users('u_sales1') } }]);
      const answered = performance.now();
      const message = await socket.next(isAssigned, 30_000);
      latencies.push(performance.now() - answered);
      expect(message).toMatchObject({ type: 'notification.created' });
    }
    const p95 = percentile(latencies, 95);
    const load = loadavg()[0] ?? 0;
    process.stdout.write(
      `T544 single assignment → notification.created: p95 ${p95.toFixed(0)} ms, max ${Math.max(...latencies).toFixed(0)} ms (load ${load.toFixed(2)}, ${String(cpus().length)} CPUs)\n`,
    );
    // Performance is only asserted on a machine that is not overloaded (BACKLOG S5b conventions).
    if (load < 2 * cpus().length) expect(p95).toBeLessThan(1_000);
    await settled();
    expect(await assignedTo('u_sales1')).toHaveLength(11);
    // Nobody else, and never the actor.
    expect(await assignedTo('u_editor')).toEqual([]);
  }, 300_000);

  it('a paste of 200 rows assigning u_sales2 → one notification "200 records", one email', async () => {
    const socket = await socketOf('u_sales2');
    const records = await createOrders(
      'u_admin',
      Array.from({ length: 200 }, (_, i) => ({ [F('title')]: `Dán ${String(i)}` })),
    );
    await settled();
    expect(await assignedTo('u_sales2')).toEqual([]);

    await update(
      'u_editor',
      records.map((id) => ({ id, fields: { [F('owner')]: users('u_sales2') } })),
    );
    const created = await socket.next(isAssigned, 60_000);
    expect(created).toMatchObject({ type: 'notification.created' });
    await settled();
    await socket.expectNone(isAssigned, 1_500);
    const [notice, ...more] = await assignedTo('u_sales2');
    expect(more).toEqual([]);
    expect(notice).toMatchObject({
      entity_type: 'table',
      entity_id: fx.orders.id,
      actor_id: U('u_editor'),
      payload: { count: 200, field_ids: [F('owner')] },
    });
    const payload = notice?.payload as { record_ids: string[]; batch_id: string };
    expect(payload.record_ids).toHaveLength(20);
    expect(payload.batch_id).toMatch(/^req_/);

    const mail = await eventually(
      () => Promise.resolve(mailsTo('u_sales2')[0]),
      'the grouped notification email',
    );
    const text = plainText(mail.raw);
    expect(text).toContain('Bạn được gán 200 bản ghi trong “Orders”');
    expect(text).toContain('Và 180 bản ghi khác');
    // One email, even after another batch window.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(mailsTo('u_sales2')).toHaveLength(1);
  }, 300_000);

  it('P40: u_editor assigns u_sales1 to reviewers of r2 (unreadable) → nothing on any channel, no follow', async () => {
    const socket = await socketOf('u_sales1');
    const [r2] = await createOrders('u_editor', [
      { [F('title')]: 'P40 R2', [F('owner')]: users('u_sales2') },
    ]);
    await settled();
    const before = {
      notices: (await assignedTo('u_sales1')).length,
      mails: mailsTo('u_sales1').length,
    };
    socket.received.splice(0);

    await update('u_editor', [{ id: r2 as Id<'rec'>, fields: { [reviewers]: users('u_sales1') } }]);
    await settled();
    await socket.expectNone(isAssigned, 1_500);
    expect(await assignedTo('u_sales1')).toHaveLength(before.notices);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(mailsTo('u_sales1')).toHaveLength(before.mails);
    const follows = await db.kysely
      .selectFrom('meta.record_follows')
      .select('user_id')
      .where('record_id', '=', r2 as Id<'rec'>)
      .where('user_id', '=', U('u_sales1'))
      .execute();
    expect(follows).toEqual([]);
  }, 120_000);

  it('a worker stopped in the middle of a batch → exactly one notification after it runs again', async () => {
    const records = await createOrders(
      'u_admin',
      Array.from({ length: 50 }, (_, i) => ({ [F('title')]: `Dừng ${String(i)}` })),
    );
    await settled();
    const before = (await assignedTo('u_reader')).length;

    // A worker that stops itself after dispatching 20 events.
    await worker?.close();
    let dispatched = 0;
    const state: { stopping: Promise<void> | null } = { stopping: null };
    const list = tasks();
    const dispatch = list['events.dispatch'] as AnyTask;
    const stopped = await startWorker({
      ...list,
      'events.dispatch': async (...args: Parameters<AnyTask>) => {
        await dispatch(...args);
        dispatched += 1;
        if (dispatched === 20) state.stopping = stopped.close();
      },
    });
    worker = stopped;
    await update(
      'u_editor',
      records.map((id) => ({ id, fields: { [reviewers]: users('u_reader') } })),
    );
    await eventually(() => Promise.resolve(state.stopping !== null), 'the worker to stop itself');
    await state.stopping;
    const buffered = await db.kysely
      .selectFrom('meta.notification_buffer')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('kind', '=', 'assigned')
      .executeTakeFirstOrThrow();
    expect(Number(buffered.n)).toBeGreaterThanOrEqual(20);
    expect(Number(buffered.n)).toBeLessThan(50);
    expect(await assignedTo('u_reader')).toHaveLength(before);

    // It runs again.
    worker = await startWorker();
    await settled();
    const fresh = (await assignedTo('u_reader')).slice(before);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.payload).toMatchObject({ count: 50, field_ids: [reviewers] });
  }, 300_000);

  it('import of 5 000 rows → one notification per assignee', async () => {
    const lines = ['title,owner,reviewers'];
    for (let i = 0; i < 5000; i += 1) {
      lines.push(`Nhập ${String(i)},${fx.users.u_sales1.email},${fx.users.u_reader.email}`);
    }
    const upload = await fx.call(
      'u_admin',
      'POST',
      `/bases/${fx.baseId}/imports/uploads`,
      multipart('orders.csv', Buffer.from(`${lines.join('\r\n')}\r\n`)),
      { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    );
    expect(upload.statusCode, upload.body).toBe(201);
    const before = {
      sales1: (await assignedTo('u_sales1')).length,
      reader: (await assignedTo('u_reader')).length,
    };
    const start = await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/imports`, {
      upload_id: importUploadSchema.parse(upload.json()).id,
      mode: 'append',
      table_id: fx.orders.id,
      mapping: [
        { column: 0, field_id: F('title') },
        { column: 1, field_id: F('owner') },
        { column: 2, field_id: reviewers },
      ],
    });
    expect(start.statusCode, start.body).toBe(202);
    const jobId = start.json<{ job_id: Id<'job'> }>().job_id;
    const job = await eventually(
      async () => {
        const dto = jobSchema.parse((await fx.call('u_admin', 'GET', `/jobs/${jobId}`)).json());
        return ['succeeded', 'failed', 'cancelled'].includes(dto.status) ? dto : undefined;
      },
      'the import',
      300_000,
    );
    expect(job.status).toBe('succeeded');
    expect(job.result).toMatchObject({ imported: 5000, failed: 0 });
    await settled(600_000);

    const sales1 = (await assignedTo('u_sales1')).slice(before.sales1);
    const reader = (await assignedTo('u_reader')).slice(before.reader);
    expect(sales1).toHaveLength(1);
    expect(reader).toHaveLength(1);
    expect(sales1[0]).toMatchObject({
      entity_type: 'table',
      actor_id: U('u_admin'),
      payload: { batch_id: jobId, count: 5000, field_ids: [F('owner')] },
    });
    expect(reader[0]).toMatchObject({
      payload: { batch_id: jobId, count: 5000, field_ids: [reviewers] },
    });
  }, 900_000);
});
