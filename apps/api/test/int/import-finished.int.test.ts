import { rm } from 'node:fs/promises';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  importUploadSchema,
  jobSchema,
  notificationListSchema,
  notificationPreferencesSchema,
  type Id,
  type JobDto,
  type NotificationDto,
  type RealtimeServerMessage,
} from '@cellhive/contracts';
import {
  BaseRoleMembersRepository,
  enqueue,
  ImportsRepository,
  importUploadKey,
  JobsRepository,
  orgScope,
  type Db,
  type StorageDriver,
} from '@cellhive/server-core';
import { createWorker, type WorkerHandle } from '@cellhive/worker';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { STORAGE_DRIVER } from '../../src/common/tokens.js';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { closeSockets, listen, TestSocket } from './realtime-support.js';
import { buildRecordFixture, type FixtureUser, type RecordFixture } from './record-fixture.js';
import { captureLogger, startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

const BOUNDARY = 'cellhive-import-finished';

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

const csv = (lines: string[]) => Buffer.from(`${lines.join('\r\n')}\r\n`);

async function eventually<T>(
  probe: () => Promise<T | undefined>,
  label: string,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * T548 (ADR-34 §4, CONTRACTS §19, §22.1): `import.finished` through the real
 * API and worker — the importer gets one realtime notification with the
 * counts when the CSV import ends (`succeeded`, `failed`, `cancelled`),
 * nobody else does, a retried job never notifies twice, and an importer who
 * lost access to the table before the end gets nothing.
 */
describe('import.finished (T548)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let url: string;
  let fx: RecordFixture;
  let worker: WorkerHandle;
  const sockets: TestSocket[] = [];

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    url = await listen(t.app);
    fx = await buildRecordFixture(t, db);
    worker = await createWorker(t.config, { logger: captureLogger().logger, pollIntervalMs: 100 });
  });

  afterAll(async () => {
    await closeSockets(sockets);
    await worker.close();
    await t.close();
    await db.destroy();
    await database.drop();
  });

  const F = (name: string): Id<'fld'> => {
    const field = fx.fld[name];
    if (field === undefined) throw new Error(`no field ${name}`);
    return field.id;
  };
  const me = (path: string) => `/orgs/${fx.orgId}/me${path}`;

  async function socketOf(user: FixtureUser): Promise<TestSocket> {
    const socket = await TestSocket.connect(url, {
      origin: TEST_PUBLIC_URL,
      cookie: await fx.cookie(user),
    });
    sockets.push(socket);
    expect(await socket.subscribe(`user:${fx.users[user].id}`)).toMatchObject({
      type: 'subscribed',
    });
    return socket;
  }

  async function uploaded(user: FixtureUser, lines: string[]) {
    const response = await fx.call(
      user,
      'POST',
      `/bases/${fx.baseId}/imports/uploads`,
      multipart('tickets.csv', csv(lines)),
      { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    );
    expect(response.statusCode, response.body).toBe(201);
    return importUploadSchema.parse(response.json());
  }

  async function start(user: FixtureUser, body: object): Promise<Id<'job'>> {
    const response = await fx.call(user, 'POST', `/bases/${fx.baseId}/imports`, body);
    expect(response.statusCode, response.body).toBe(202);
    return response.json<{ job_id: Id<'job'> }>().job_id;
  }

  const appendTickets = (uploadId: string) => ({
    upload_id: uploadId,
    mode: 'append',
    table_id: fx.tickets.id,
    mapping: [
      { column: 0, field_id: F('ticketTitle') },
      { column: 1, field_id: F('ticketAmount') },
    ],
  });

  async function finished(user: FixtureUser, jobId: Id<'job'>): Promise<JobDto> {
    return eventually(async () => {
      const job = jobSchema.parse((await fx.call(user, 'GET', `/jobs/${jobId}`)).json());
      return ['succeeded', 'failed', 'cancelled'].includes(job.status) ? job : undefined;
    }, `job ${jobId}`);
  }

  /** The caller's `import.finished` notifications about one job. */
  async function noticesOf(user: FixtureUser, jobId: Id<'job'>): Promise<NotificationDto[]> {
    const response = await fx.call(user, 'GET', me('/notifications?limit=200'));
    expect(response.statusCode, response.body).toBe(200);
    return notificationListSchema
      .parse(response.json())
      .items.filter((item) => item.type === 'import.finished' && item.entity.id === jobId);
  }

  /** Rows about one job, every recipient (to prove nobody else got one). */
  async function rowsOf(jobId: Id<'job'>) {
    return db.kysely
      .selectFrom('meta.notifications')
      .select(['user_id', 'type', 'payload'])
      .where('entity_type', '=', 'job')
      .where('entity_id', '=', jobId)
      .execute();
  }

  /** Waits until no `table.import` / `notifications.fanout` job is left in the queue. */
  async function drained(): Promise<void> {
    await eventually(async () => {
      const { rows } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM graphile_worker.jobs
         WHERE task_identifier IN ('table.import', 'notifications.fanout')
      `.execute(db.kysely);
      return rows[0]?.n === 0 ? true : undefined;
    }, 'an empty queue');
  }

  const isNotice = (message: RealtimeServerMessage) =>
    message.type === 'notification.created' && message.notification_type === 'import.finished';

  it('import.finished is produced: preferences list it, email off by default', async () => {
    const preferences = notificationPreferencesSchema.parse(
      (await fx.call('u_editor', 'GET', me('/notification-preferences'))).json(),
    );
    expect(preferences.items).toContainEqual({
      type: 'import.finished',
      channel: 'in_app',
      enabled: true,
      locked: false,
    });
  });

  it('1 000 rows imported → one realtime notification to the importer with the counts, nobody else', async () => {
    const importer = await socketOf('u_editor');
    const others = await Promise.all((['owner', 'u_admin', 'u_reader'] as const).map(socketOf));
    const lines = ['Tiêu đề,Số tiền'];
    for (let i = 0; i < 1_000; i += 1) lines.push(`Phiếu ${String(i)},${String(i)}`);
    lines.push('Phiếu lỗi,abc');
    const file = await uploaded('u_editor', lines);
    const jobId = await start('u_editor', appendTickets(file.id));

    const done = await importer.next(
      (message) =>
        message.type === 'job.progress' &&
        message.job_id === jobId &&
        message.status === 'succeeded',
      60_000,
    );
    expect(done).toMatchObject({ status: 'succeeded' });
    const ended = performance.now();
    const created = await importer.next(isNotice, 15_000);
    const latency = performance.now() - ended;
    expect(created).toMatchObject({
      type: 'notification.created',
      organization_id: fx.orgId,
      base_id: fx.baseId,
    });
    const load = loadavg()[0] ?? 0;
    process.stdout.write(
      `T548 import succeeded → notification.created: ${latency.toFixed(0)} ms (load ${load.toFixed(2)})\n`,
    );
    // Latency is only meaningful on an idle machine (BACKLOG S5 conventions).
    if (load < 8) expect(latency).toBeLessThan(1_000);

    const [notice, ...more] = await noticesOf('u_editor', jobId);
    expect(more).toEqual([]);
    expect(created).toMatchObject({ notification_id: notice?.id });
    expect(notice).toMatchObject({
      type: 'import.finished',
      base: { id: fx.baseId },
      table_id: fx.tickets.id,
      entity: { type: 'job', id: jobId, title: null },
      actor: { type: 'user', id: fx.users.u_editor.id },
      data: { job_id: jobId, status: 'succeeded', created: 1_000, updated: 0, failed_rows: 1 },
      read_at: null,
    });
    // The error report stays where it was: the importer's job (CONTRACTS §19).
    const job = jobSchema.parse((await fx.call('u_editor', 'GET', `/jobs/${jobId}`)).json());
    expect(job.result).toMatchObject({ download_url: expect.stringContaining(jobId) as unknown });

    // Nobody else: not the organization owner, not a base admin, not a reader.
    await Promise.all(others.map((socket) => socket.expectNone(isNotice)));
    expect((await rowsOf(jobId)).map((row) => row.user_id)).toEqual([fx.users.u_editor.id]);
    for (const user of ['owner', 'u_admin', 'u_reader'] as const) {
      expect(await noticesOf(user, jobId)).toEqual([]);
    }
    // Email is off by default: no delivery queued.
    const deliveries = await db.kysely
      .selectFrom('meta.notification_deliveries')
      .innerJoin(
        'meta.notifications',
        'meta.notifications.id',
        'meta.notification_deliveries.notification_id',
      )
      .select('meta.notification_deliveries.status')
      .where('meta.notifications.entity_id', '=', jobId)
      .execute();
    expect(deliveries).toEqual([]);

    // A retried job and a fan-out run again never notify twice (`group_key = job_id`).
    const payload = await db.kysely
      .selectFrom('meta.imports')
      .select(['id'])
      .where('job_id', '=', jobId)
      .executeTakeFirstOrThrow();
    await db.withTx(async (tx) => {
      await enqueue(tx, 'table.import', {
        organization_id: fx.orgId,
        job_id: jobId,
        import_id: payload.id,
        base_id: fx.baseId,
        user_id: fx.users.u_editor.id,
        spec: {
          mode: 'append',
          table_id: fx.tickets.id,
          mapping: [{ column: 0, field_id: F('ticketTitle') }],
        },
      });
      await enqueue(tx, 'notifications.fanout', {
        organization_id: fx.orgId,
        type: 'import.finished',
        base_id: fx.baseId,
        table_id: fx.tickets.id,
        entity_type: 'job',
        entity_id: jobId,
        actor: { type: 'user', id: fx.users.u_editor.id },
        group_key: jobId,
        recipients: { user_ids: [fx.users.u_editor.id], base_admins: false },
        requires: { record_id: null, field_ids: [] },
        skip_actor: false,
        data: { job_id: jobId, status: 'succeeded', created: 1_000, updated: 0, failed_rows: 1 },
      });
    });
    await drained();
    expect(await rowsOf(jobId)).toHaveLength(1);
    await importer.expectNone(isNotice);
    expect((await finished('u_editor', jobId)).status).toBe('succeeded');
  });

  it('a failed import notifies `failed`; its trashed new table is not named', async () => {
    const importer = await socketOf('owner');
    const file = await uploaded('owner', ['Tên,Số', 'A,1']);
    // The uploaded file disappears before the job reads it.
    await rm(join(t.storageRoot, 'objects', fx.orgId, file.id), { force: true });
    const jobId = await start('owner', {
      upload_id: file.id,
      mode: 'create_table',
      table: {
        name: 'Lost import',
        columns: [
          { column: 0, name: 'Tên', type: 'text' },
          { column: 1, name: 'Số', type: 'number' },
        ],
      },
    });
    expect((await finished('owner', jobId)).status).toBe('failed');
    await importer.next(isNotice, 15_000);
    expect(await noticesOf('owner', jobId)).toEqual([
      expect.objectContaining({
        table_id: null,
        base: expect.objectContaining({ id: fx.baseId }) as unknown,
        entity: { type: 'job', id: jobId, title: null },
        data: { job_id: jobId, status: 'failed', created: 0, updated: 0, failed_rows: 0 },
      }),
    ]);
    expect((await rowsOf(jobId)).map((row) => row.user_id)).toEqual([fx.users.owner.id]);
  });

  it('cancelling a queued import notifies its importer at once (actor: who cancelled)', async () => {
    const importer = await socketOf('u_editor');
    // The organization already runs an import (cap 1): this one stays queued.
    const jobs = new JobsRepository(db);
    const busy = await jobs.create(orgScope(fx.orgId), {
      type: 'table.import',
      createdBy: fx.users.owner.id,
    });
    await jobs.markRunning(orgScope(fx.orgId), busy.id);
    try {
      const file = await uploaded('u_editor', ['Tiêu đề,Số tiền', 'X,1']);
      const jobId = await start('u_editor', appendTickets(file.id));
      expect(
        jobSchema.parse((await fx.call('u_editor', 'GET', `/jobs/${jobId}`)).json()).status,
      ).toBe('queued');
      const cancel = await fx.call('owner', 'POST', `/bases/${fx.baseId}/imports/${jobId}/cancel`);
      expect(cancel.statusCode, cancel.body).toBe(200);
      expect(cancel.json<JobDto>().status).toBe('cancelled');
      await importer.next(isNotice, 15_000);
      expect(await noticesOf('u_editor', jobId)).toEqual([
        expect.objectContaining({
          table_id: null,
          actor: expect.objectContaining({ type: 'user', id: fx.users.owner.id }) as unknown,
          data: { job_id: jobId, status: 'cancelled', created: 0, updated: 0, failed_rows: 0 },
        }),
      ]);
      // Cancelling again returns the job unchanged and notifies nothing more.
      await fx.call('owner', 'POST', `/bases/${fx.baseId}/imports/${jobId}/cancel`);
      await drained();
      expect(await rowsOf(jobId)).toHaveLength(1);
    } finally {
      await jobs.markSucceeded(orgScope(fx.orgId), busy.id, {});
    }
  });

  it('a job cancelled while its worker was stopped is settled when its task runs again', async () => {
    const importer = await socketOf('owner');
    const file = await uploaded('owner', ['Tiêu đề,Số tiền', 'A,1']);
    // A worker started the job and stopped; the job was cancelled meanwhile.
    const scope = orgScope(fx.orgId);
    const jobs = new JobsRepository(db);
    const job = await jobs.create(scope, { type: 'table.import', createdBy: fx.users.owner.id });
    await new ImportsRepository(db).claim(
      scope,
      { id: file.id, baseId: fx.baseId, userId: fx.users.owner.id },
      job.id,
    );
    await jobs.markRunning(scope, job.id);
    await jobs.markCancelled(scope, job.id);
    await db.withTx((tx) =>
      enqueue(tx, 'table.import', {
        organization_id: fx.orgId,
        job_id: job.id,
        import_id: file.id,
        base_id: fx.baseId,
        user_id: fx.users.owner.id,
        spec: {
          mode: 'append',
          table_id: fx.tickets.id,
          mapping: [{ column: 0, field_id: F('ticketTitle') }],
        },
      }),
    );
    await importer.next(isNotice, 15_000);
    expect(await noticesOf('owner', job.id)).toEqual([
      expect.objectContaining({
        table_id: fx.tickets.id,
        data: { job_id: job.id, status: 'cancelled', created: 0, updated: 0, failed_rows: 0 },
      }),
    ]);
    expect((await finished('owner', job.id)).status).toBe('cancelled');
    // The uploaded file is gone with it.
    await expect(
      t.app.get<StorageDriver>(STORAGE_DRIVER).getStream(importUploadKey(fx.orgId, file.id)),
    ).resolves.toBeNull();
  });

  it('an importer who loses access to the table before the import ends gets nothing', async () => {
    const importer = await socketOf('u_editor');
    const lines = ['Tiêu đề,Số tiền'];
    for (let i = 0; i < 20_000; i += 1) lines.push(`Phiếu ${String(i)},${String(i)}`);
    const file = await uploaded('u_editor', lines);
    const jobId = await start('u_editor', appendTickets(file.id));
    await eventually(async () => {
      const job = jobSchema.parse((await fx.call('u_editor', 'GET', `/jobs/${jobId}`)).json());
      return job.progress > 0 ? job : undefined;
    }, 'the first batch');
    // The base editor role is removed while the job runs.
    expect(
      await new BaseRoleMembersRepository(db).remove(
        orgScope(fx.orgId),
        fx.baseId,
        'user',
        fx.users.u_editor.id,
      ),
    ).toBeDefined();
    const job = await eventually(async () => {
      const row = await new JobsRepository(db).getById(orgScope(fx.orgId), jobId);
      return row !== undefined && ['succeeded', 'failed', 'cancelled'].includes(row.status)
        ? row
        : undefined;
    }, 'the end of the import');
    process.stdout.write(`T548 import after the role was removed: ${job.status}\n`);
    await drained();
    expect(await rowsOf(jobId)).toEqual([]);
    await importer.expectNone(isNotice);
  });
});
