import { performance } from 'node:perf_hooks';

import {
  MAX_RECORDS_PER_REQUEST,
  recordsResponseSchema,
  REALTIME_RECORD_BATCH_THRESHOLD,
  type Id,
  type RealtimeServerMessage,
  type RecordDto,
} from '@cellhive/contracts';
import { createWorker, type WorkerHandle } from '@cellhive/worker';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { closeSockets, listen, TestSocket } from './realtime-support.js';
import {
  buildRecordFixture,
  relaxRateLimits,
  type FixtureUser,
  type RecordFixture,
} from './record-fixture.js';
import { captureLogger, startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

import type { Db } from '@cellhive/server-core';
import type { LightMyRequestResponse } from 'fastify';

type Message = RealtimeServerMessage;

const BULK = MAX_RECORDS_PER_REQUEST; // 1 000

/**
 * T303: a write that changes more than `REALTIME_RECORD_BATCH_THRESHOLD`
 * records a subscriber can read reaches it as one `record.batch` (CONTRACTS
 * §7), still filtered per subscriber. Writes go through instance A; clients
 * listen on instance B unless stated otherwise.
 */
describe('realtime record batches (T303)', () => {
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
  /** 1 000 records: the first 10 owned by u_sales1, the others by u_sales2. */
  let bulk: RecordDto[];
  const sockets: TestSocket[] = [];

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    a = await startTestApp({ DATABASE_URL: database.url });
    b = await startTestApp({ DATABASE_URL: database.url });
    relaxRateLimits(a);
    urlA = await listen(a.app);
    urlB = await listen(b.app);
    fx = await buildRecordFixture(a, db);
    orders = `/tables/${fx.orders.id}/records?field_key_type=id`;
    channel = `table:${fx.orders.id}`;
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

  async function watch(user: FixtureUser, url = urlB): Promise<TestSocket> {
    const socket = await TestSocket.connect(url, {
      origin: TEST_PUBLIC_URL,
      cookie: await fx.cookie(user),
    });
    sockets.push(socket);
    expect(await socket.subscribe(channel)).toMatchObject({ type: 'subscribed' });
    return socket;
  }

  const isRecordMessage = (message: Message): boolean => message.type.startsWith('record.');
  const isBatch = (message: Message): boolean => message.type === 'record.batch';

  /** Every record message received so far (after a round trip through `ping`). */
  async function drain(socket: TestSocket): Promise<Message[]> {
    await socket.expectNone(() => false, 300);
    const taken = socket.received.filter(isRecordMessage);
    socket.received.length = 0;
    return taken;
  }

  it('sends one record.batch per subscriber for a 1 000-record create, filtered per subscriber', async () => {
    const editor = await watch('u_editor');
    const sales1 = await watch('u_sales1', urlA);
    bulk = records(
      await fx.call('u_editor', 'POST', orders, {
        records: Array.from({ length: BULK }, (_, index) => ({
          fields: {
            [F('title')]: `bulk ${String(index)}`,
            ...owned(index < 10 ? 'u_sales1' : 'u_sales2'),
          },
        })),
      }),
    );
    expect(bulk).toHaveLength(BULK);
    expect(await editor.next(isBatch, 15_000)).toEqual({
      type: 'record.batch',
      channel,
      actor_id: fx.users.u_editor.id,
      count: BULK,
      ops: { created: BULK, updated: 0, added: 0, removed_from_view: 0, deleted: 0, restored: 0 },
    });
    expect(await drain(editor)).toEqual([]);
    // u_sales1 reads 10 of them: below the threshold, one record.created each.
    const own = [] as Message[];
    for (const record of bulk.slice(0, 10)) {
      own.push(
        await sales1.next(
          (message) => message.type === 'record.created' && message.record_id === record.id,
        ),
      );
    }
    expect(own).toHaveLength(10);
    expect(await drain(sales1)).toEqual([]);
  });

  it('bulk PATCH of 1 000 records: 1 message per tab, per-subscriber counts, latency within T210 targets', async () => {
    const editor = await watch('u_editor', urlB);
    const reader = await watch('u_reader', urlA);
    const sales1 = await watch('u_sales1', urlB);
    const sales2 = await watch('u_sales2', urlB);
    const rounds = 5;
    const toEditor: number[] = [];
    const toReader: number[] = [];
    const afterResponse: number[] = [];
    let versions = new Map(bulk.map((record) => [record.id, record.version]));
    for (let round = 0; round < rounds; round += 1) {
      const start = performance.now();
      const arrivals = Promise.all(
        [editor, reader].map(async (socket) => {
          await socket.next(isBatch, 15_000);
          return performance.now();
        }),
      );
      const response = records(
        await patch(
          'u_admin',
          bulk.map((record, index) => ({
            id: record.id,
            version: versions.get(record.id) as number,
            fields: { [F('amount')]: round * BULK + index },
          })),
        ),
      );
      const answered = performance.now();
      const [atEditor, atReader] = (await arrivals) as [number, number];
      toEditor.push(atEditor - start);
      toReader.push(atReader - start);
      afterResponse.push(Math.max(0, Math.max(atEditor, atReader) - answered));
      versions = new Map(response.map((record) => [record.id, record.version]));
    }
    // Exactly one message per write for the two tabs with other roles.
    expect(await drain(editor)).toEqual([]);
    expect(await drain(reader)).toEqual([]);
    // u_sales1: 10 readable records per write, per record; u_sales2: one batch of 990 per write.
    const salesMessages = await drain(sales1);
    expect(salesMessages).toHaveLength(10 * rounds);
    expect(salesMessages.every((message) => message.type === 'record.updated')).toBe(true);
    const sales2Messages = await drain(sales2);
    expect(sales2Messages).toHaveLength(rounds);
    for (const message of sales2Messages) {
      expect(message).toMatchObject({ type: 'record.batch', count: BULK - 10 });
      expect(JSON.stringify(message)).not.toContain(F('cost'));
    }

    const stats = (values: number[]) => {
      const sorted = [...values].sort((x, y) => x - y);
      const at = (q: number) =>
        sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0;
      return { p50: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? 0 };
    };
    const line = (name: string, values: number[]) => {
      const { p50, p95, max } = stats(values);
      return `${name}: p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms, max ${max.toFixed(1)} ms`;
    };
    process.stdout.write(
      `[latency] bulk PATCH ${String(BULK)} records on A (${String(rounds)} writes) → record.batch; ` +
        `messages per write: editor 1, reader 1, sales1 10 (per record), sales2 1; ` +
        `${line('request start → editor (B)', toEditor)}; ` +
        `${line('request start → reader (A)', toReader)}; ` +
        `${line('HTTP response → last tab', afterResponse)}\n`,
    );
    // T210 target: another tab shows the change < 1 s (p95) after the write.
    expect(stats(afterResponse).p95).toBeLessThan(1_000);
  }, 180_000);

  it('P22: u_sales1 hears nothing when every changed record is out of its read scope', async () => {
    const sales1 = await watch('u_sales1');
    const editor = await watch('u_editor');
    const others = bulk.slice(10);
    records(
      await patch(
        'u_editor',
        others.map((record) => ({ id: record.id, fields: { [F('cost')]: 1 } })),
      ),
    );
    expect(await editor.next(isBatch, 15_000)).toMatchObject({ count: others.length });
    expect(await drain(sales1)).toEqual([]);
  });

  it('publishes nothing for a bulk write that rolls back', async () => {
    const editor = await watch('u_editor');
    const stale = await patch(
      'u_editor',
      bulk.map((record, index) => ({
        id: record.id,
        ...(index === BULK - 1 ? { version: 1 } : {}),
        fields: { [F('amount')]: -1 },
      })),
    );
    expect(stale.statusCode).toBe(409);
    expect(await drain(editor)).toEqual([]);
  });

  it('sends one record.batch for a bulk delete and one for the restore', async () => {
    const editor = await watch('u_editor');
    const sales1 = await watch('u_sales1');
    const ids = bulk.map((record) => record.id);
    expect((await fx.call('u_editor', 'DELETE', orders, { ids })).statusCode).toBe(200);
    expect(await editor.next(isBatch, 15_000)).toMatchObject({
      count: BULK,
      ops: { deleted: BULK },
    });
    // u_sales1: its 10 records in one record.deleted, as before.
    expect(await sales1.next((message) => message.type === 'record.deleted')).toMatchObject({
      record_ids: ids.slice(0, 10),
    });
    const restored = await fx.call('u_editor', 'POST', `/tables/${fx.orders.id}/records/restore`, {
      ids,
    });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(await editor.next(isBatch, 15_000)).toMatchObject({
      count: BULK,
      ops: { restored: BULK },
    });
    expect(await drain(editor)).toEqual([]);
  });

  it('batches the worker updates of a removed select option per lot', async () => {
    const tagged = bulk.slice(0, REALTIME_RECORD_BATCH_THRESHOLD + 50);
    records(
      await patch(
        'u_admin',
        tagged.map((record) => ({ id: record.id, fields: { [F('status')]: 'Xong' } })),
      ),
    );
    const editor = await watch('u_editor');
    const status = fx.fld.status;
    const options = (status?.options as { options: { id: string; name: string }[] }).options;
    const changed = await fx.call('u_admin', 'PATCH', `/fields/${F('status')}`, {
      options: { options: options.filter((option) => option.name !== 'Xong') },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    // The bulk writes above queued thousands of `events.dispatch` jobs
    // (automations, not under test here) ahead of the option removal.
    await sql`
      select graphile_worker.complete_jobs(
        array(select id from graphile_worker.jobs where task_identifier = 'events.dispatch')
      )
    `.execute(db.kysely);
    worker = await createWorker(a.config, { logger: captureLogger().logger, pollIntervalMs: 100 });
    const fromWorker = (message: Message) =>
      isBatch(message) && 'actor_id' in message && message.actor_id === null;
    expect(await editor.next(fromWorker, 30_000)).toEqual({
      type: 'record.batch',
      channel,
      actor_id: null,
      count: tagged.length,
      ops: {
        created: 0,
        updated: tagged.length,
        added: 0,
        removed_from_view: 0,
        deleted: 0,
        restored: 0,
      },
    });
    expect((await drain(editor)).filter(fromWorker)).toEqual([]);
  });
});
