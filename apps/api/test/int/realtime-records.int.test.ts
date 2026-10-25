import { performance } from 'node:perf_hooks';

import {
  fieldSchema,
  recordsResponseSchema,
  REALTIME_RECORD_BATCH_THRESHOLD,
  type Id,
  type RealtimeServerMessage,
  type RecordDto,
} from '@cellhive/contracts';
import { createWorker, type WorkerHandle } from '@cellhive/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { closeSockets, listen, TestSocket } from './realtime-support.js';
import { buildRecordFixture, type FixtureUser, type RecordFixture } from './record-fixture.js';
import { captureLogger, startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

import type { Db } from '@cellhive/server-core';
import type { LightMyRequestResponse } from 'fastify';

type Message = RealtimeServerMessage;

/**
 * T210: record changes reach WebSocket subscribers filtered per subscriber
 * (CONTRACTS §7, §5 P22–P24), across two api instances sharing PostgreSQL
 * and Valkey, and from the worker. Writes go through the HTTP API of
 * instance A; clients listen on instance B unless stated otherwise.
 */
describe('realtime record changes (T210)', () => {
  let database: TestDatabase;
  let db: Db;
  let a: TestApp;
  let b: TestApp;
  let urlA: string;
  let urlB: string;
  let worker: WorkerHandle | undefined;
  let fx: RecordFixture;
  let orders: string;
  let channel: string;
  let r1: Id<'rec'>, r2: Id<'rec'>, r3: Id<'rec'>;
  const sockets: TestSocket[] = [];

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    a = await startTestApp({ DATABASE_URL: database.url });
    b = await startTestApp({ DATABASE_URL: database.url });
    urlA = await listen(a.app);
    urlB = await listen(b.app);
    fx = await buildRecordFixture(a, db);
    orders = `/tables/${fx.orders.id}/records?field_key_type=id`;
    channel = `table:${fx.orders.id}`;
    const created = records(
      await fx.call('u_admin', 'POST', orders, {
        records: [
          {
            fields: {
              [F('title')]: 'r1',
              [F('amount')]: 100,
              [F('cost')]: 60,
              ...owned('u_sales1'),
            },
          },
          { fields: { [F('title')]: 'r2', ...owned('u_sales2') } },
          { fields: { [F('title')]: 'r3' } },
        ],
      }),
    );
    [r1, r2, r3] = created.map((record) => record.id) as [Id<'rec'>, Id<'rec'>, Id<'rec'>];
  });

  afterAll(async () => {
    await closeSockets(sockets);
    await worker?.close();
    await Promise.all([a.close(), b.close()]);
    await db.destroy();
    await database.drop();
  });

  const F = (name: string): Id<'fld'> => {
    const field = fx.fld[name];
    if (field === undefined) throw new Error(`no field ${name}`);
    return field.id;
  };
  const owned = (user: FixtureUser) => ({ [F('owner')]: [{ id: fx.users[user].id }] });

  function records(response: LightMyRequestResponse): RecordDto[] {
    expect(response.statusCode, response.body).toBeLessThan(300);
    return recordsResponseSchema.parse(response.json()).records;
  }

  function patch(user: FixtureUser, list: { id: string; version?: number; fields: object }[]) {
    return fx.call(user, 'PATCH', orders, { records: list });
  }

  /** A client of `user` on the instance at `url`, subscribed to the Orders table. */
  async function watch(user: FixtureUser, url = urlB): Promise<TestSocket> {
    const socket = await TestSocket.connect(url, {
      origin: TEST_PUBLIC_URL,
      cookie: await fx.cookie(user),
    });
    sockets.push(socket);
    expect(await socket.subscribe(channel)).toMatchObject({ type: 'subscribed' });
    return socket;
  }

  const about =
    (type: Message['type'], recordId?: string) =>
    (message: Message): boolean =>
      message.type === type &&
      (recordId === undefined ||
        ('record_id' in message && message.record_id === recordId) ||
        ('record_ids' in message && message.record_ids.includes(recordId as Id<'rec'>)));
  const anyAbout =
    (recordId: string) =>
    (message: Message): boolean =>
      ('record_id' in message && message.record_id === recordId) ||
      ('record_ids' in message && message.record_ids.includes(recordId as Id<'rec'>));

  it('P22: u_sales1 hears nothing about r2 when u_editor edits it', async () => {
    const sales1 = await watch('u_sales1');
    const editor = await watch('u_editor');
    records(await patch('u_editor', [{ id: r2, fields: { [F('amount')]: 5 } }]));
    expect(await editor.next(about('record.updated', r2))).toMatchObject({
      channel,
      fields: { [F('amount')]: 5 },
      actor_id: fx.users.u_editor.id,
    });
    await sales1.expectNone(anyAbout(r2));
  });

  it('P23: an edit of r1.cost is not sent to u_sales1; r1.amount arrives alone', async () => {
    const sales1 = await watch('u_sales1');
    const editor = await watch('u_editor');
    const [costEdit] = records(await patch('u_editor', [{ id: r1, fields: { [F('cost')]: 61 } }]));
    expect(await editor.next(about('record.updated', r1))).toMatchObject({
      version: costEdit?.version,
      fields: { [F('cost')]: 61 },
    });
    await sales1.expectNone(anyAbout(r1));

    const [amountEdit] = records(
      await patch('u_editor', [{ id: r1, fields: { [F('amount')]: 2_000_000 } }]),
    );
    const patchMessage = await sales1.next(about('record.updated', r1));
    expect(patchMessage).toEqual({
      type: 'record.updated',
      channel,
      record_id: r1,
      version: amountEdit?.version,
      fields: { [F('amount')]: 2_000_000 },
      actor_id: fx.users.u_editor.id,
      event_id: expect.stringMatching(/^evt_/) as unknown,
    });
  });

  it('P24: moving r1 to u_sales2 removes it from u_sales1 and adds it for u_sales2', async () => {
    const sales1 = await watch('u_sales1');
    const sales2 = await watch('u_sales2', urlA);
    records(await patch('u_editor', [{ id: r1, fields: owned('u_sales2') }]));
    expect(await sales1.next(about('record.removed_from_view', r1))).toEqual({
      type: 'record.removed_from_view',
      channel,
      record_id: r1,
    });
    expect(await sales2.next(about('record.added', r1))).toEqual({
      type: 'record.added',
      channel,
      record_id: r1,
    });
    await sales1.expectNone(about('record.updated', r1));
    await sales2.expectNone(about('record.updated', r1));

    // And back.
    records(await patch('u_admin', [{ id: r1, fields: owned('u_sales1') }]));
    await sales1.next(about('record.added', r1));
    await sales2.next(about('record.removed_from_view', r1));
  });

  it('delivers create, delete and restore to those who can read the record, without no_perm fields', async () => {
    const sales1 = await watch('u_sales1');
    const sales2 = await watch('u_sales2');
    const admin = await watch('u_admin');
    const [record] = records(
      await fx.call('u_sales1', 'POST', orders, {
        records: [{ fields: { [F('title')]: 'new', [F('amount')]: 7, ...owned('u_sales1') } }],
      }),
    );
    const id = record?.id as Id<'rec'>;
    const created = await sales1.next(about('record.created', id));
    expect(created).toMatchObject({ version: 1, actor_id: fx.users.u_sales1.id });
    expect(Object.keys('fields' in created ? created.fields : {}).sort()).toEqual(
      [F('title'), F('amount'), F('status'), F('owner')].sort(),
    );
    expect(created).toMatchObject({
      fields: {
        [F('title')]: 'new',
        [F('amount')]: 7,
        [F('status')]: null,
        [F('owner')]: [
          {
            id: fx.users.u_sales1.id,
            name: expect.any(String) as unknown,
            email: fx.users.u_sales1.email,
          },
        ],
      },
    });
    expect(await admin.next(about('record.created', id))).toMatchObject({
      fields: { [F('cost')]: null },
    });
    await sales2.expectNone(anyAbout(id));

    expect((await fx.call('u_admin', 'DELETE', orders, { ids: [id, r2] })).statusCode).toBe(200);
    expect(await sales1.next(about('record.deleted', id))).toEqual({
      type: 'record.deleted',
      channel,
      record_ids: [id],
    });
    expect(await admin.next(about('record.deleted', id))).toMatchObject({ record_ids: [id, r2] });
    expect(await sales2.next(about('record.deleted', r2))).toMatchObject({ record_ids: [r2] });

    expect(
      (
        await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/records/restore`, {
          ids: [id, r2],
        })
      ).statusCode,
    ).toBe(200);
    expect(await sales1.next(about('record.restored', id))).toEqual({
      type: 'record.restored',
      channel,
      record_ids: [id],
    });
    expect(await admin.next(about('record.restored', id))).toMatchObject({ record_ids: [id, r2] });
  });

  it('publishes nothing for a write that rolls back', async () => {
    const editor = await watch('u_editor');
    const stale = await patch('u_editor', [
      { id: r3, fields: { [F('amount')]: 1 } },
      { id: r2, version: 1, fields: { [F('amount')]: 2 } },
    ]);
    expect(stale.statusCode).toBe(409);
    await editor.expectNone((message) => anyAbout(r3)(message) || anyAbout(r2)(message));
  });

  it('delivers every change of a bulk paste up to the batch threshold record by record', async () => {
    // Larger writes: one `record.batch` per subscriber (T303, realtime-batch.int.test.ts).
    const editor = await watch('u_editor');
    const created = records(
      await fx.call('u_editor', 'POST', orders, {
        records: Array.from({ length: REALTIME_RECORD_BATCH_THRESHOLD }, (_, index) => ({
          fields: { [F('title')]: `bulk ${String(index)}` },
        })),
      }),
    );
    for (const record of created) await editor.next(about('record.created', record.id), 15_000);

    const updated = records(
      await patch(
        'u_editor',
        created.map((record, index) => ({ id: record.id, fields: { [F('amount')]: index } })),
      ),
    );
    const seen = new Map<string, Message>();
    for (const record of updated) {
      seen.set(record.id, await editor.next(about('record.updated', record.id), 15_000));
    }
    expect(seen.size).toBe(REALTIME_RECORD_BATCH_THRESHOLD);
    updated.forEach((record, index) => {
      expect(seen.get(record.id)).toMatchObject({
        version: record.version,
        fields: { [F('amount')]: index },
      });
    });
    await editor.expectNone((message) => message.type === 'record.batch');
  });

  it('delivers updates made by the worker when select options are removed', async () => {
    records(await patch('u_admin', [{ id: r3, fields: { [F('status')]: 'Xong' } }]));
    const editor = await watch('u_editor');
    const status = fx.fld.status;
    const options = (status?.options as { options: { id: string; name: string }[] }).options;
    const kept = options.filter((option) => option.name !== 'Xong');
    const changed = await fx.call('u_admin', 'PATCH', `/fields/${F('status')}`, {
      options: { options: kept },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(fieldSchema.parse(changed.json()).options).toMatchObject({ options: kept });

    worker = await createWorker(a.config, { logger: captureLogger().logger, pollIntervalMs: 100 });
    expect(await editor.next(about('record.updated', r3), 15_000)).toMatchObject({
      fields: { [F('status')]: null },
      actor_id: null,
      event_id: expect.stringMatching(/^evt_/) as unknown,
    });
  });

  it('shows an edit made through instance A on a client of instance B within 1 s (p95 of 50)', async () => {
    const reader = await watch('u_reader', urlB);
    const latencies: number[] = [];
    for (let index = 0; index < 50; index += 1) {
      const start = performance.now();
      const [record] = records(
        await patch('u_editor', [{ id: r3, fields: { [F('amount')]: index } }]),
      );
      await reader.next(
        (message) =>
          about('record.updated', r3)(message) &&
          'version' in message &&
          message.version === record?.version,
      );
      latencies.push(performance.now() - start);
    }
    latencies.sort((x, y) => x - y);
    const p50 = latencies[24] ?? 0;
    const p95 = latencies[47] ?? 0;
    const max = latencies[49] ?? 0;
    process.stdout.write(
      `[latency] HTTP edit on A → WS message on B, 50 edits: p50 ${p50.toFixed(1)} ms, ` +
        `p95 ${p95.toFixed(1)} ms, max ${max.toFixed(1)} ms\n`,
    );
    expect(p95).toBeLessThan(1_000);
  });
});
