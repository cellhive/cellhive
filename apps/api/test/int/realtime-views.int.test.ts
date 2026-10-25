import { performance } from 'node:perf_hooks';

import {
  recordListResponseSchema,
  recordsResponseSchema,
  type Id,
  type RealtimeServerMessage,
  type RecordDto,
} from '@cellhive/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { closeSockets, listen, TestSocket } from './realtime-support.js';
import { buildRecordFixture, type FixtureUser, type RecordFixture } from './record-fixture.js';
import { startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

import type { Db } from '@cellhive/server-core';
import type { LightMyRequestResponse } from 'fastify';

type Message = RealtimeServerMessage;

/**
 * T313 (ADR-0031, CONTRACTS §7): a `table:` subscription made with the
 * view open on screen gets record messages that follow the view's saved
 * filter — conditions hidden from the subscriber included — on top of the
 * read rule; view changes reload the scope before the next record change.
 * Writes go through instance A, clients listen on instance B.
 */
describe('realtime record changes per view (T313)', () => {
  let database: TestDatabase;
  let db: Db;
  let a: TestApp;
  let b: TestApp;
  let urlB: string;
  let fx: RecordFixture;
  let orders: string;
  let channel: string;
  let r1: Id<'rec'>;
  let highCost: string;
  const sockets: TestSocket[] = [];

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    a = await startTestApp({ DATABASE_URL: database.url });
    b = await startTestApp({ DATABASE_URL: database.url });
    await listen(a.app);
    urlB = await listen(b.app);
    fx = await buildRecordFixture(a, db);
    orders = `/tables/${fx.orders.id}/records?field_key_type=id`;
    channel = `table:${fx.orders.id}`;
    const created = records(
      await fx.call('u_admin', 'POST', orders, {
        records: [
          { fields: { [F('title')]: 'r1', [F('cost')]: 60, ...owned('u_sales1') } },
          { fields: { [F('title')]: 'r2', [F('cost')]: 60, ...owned('u_sales2') } },
        ],
      }),
    );
    r1 = created[0]?.id as Id<'rec'>;
    // "High cost": cost > 50 — `cost` is no_perm for u_sales1 (a hidden condition).
    const view = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/views`, {
      name: 'High cost',
      type: 'grid',
      config: { filter: { op: 'and', items: [{ field: F('cost'), operator: 'gt', value: 50 }] } },
    });
    expect(view.statusCode, view.body).toBe(201);
    highCost = view.json<{ id: string }>().id;
  });

  afterAll(async () => {
    await closeSockets(sockets);
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

  async function connect(user: FixtureUser): Promise<TestSocket> {
    const socket = await TestSocket.connect(urlB, {
      origin: TEST_PUBLIC_URL,
      cookie: await fx.cookie(user),
    });
    sockets.push(socket);
    return socket;
  }

  /** A client of `user` subscribed to Orders, through `view` when given. */
  async function watch(user: FixtureUser, view?: Record<string, unknown>): Promise<TestSocket> {
    const socket = await connect(user);
    expect(await socket.subscribe(channel, 's1', view === undefined ? {} : { view })).toMatchObject(
      { type: 'subscribed' },
    );
    return socket;
  }

  const setCost = async (cost: number) =>
    records(
      await fx.call('u_admin', 'PATCH', orders, {
        records: [{ id: r1, fields: { [F('cost')]: cost } }],
      }),
    );

  const about =
    (type: Message['type'], recordId?: string) =>
    (message: Message): boolean =>
      message.type === type &&
      (recordId === undefined || ('record_id' in message && message.record_id === recordId));
  const anyAbout = (recordId: string) => (message: Message) =>
    'record_id' in message && message.record_id === recordId;

  it('hidden condition: u_sales1 sees r1 leave and re-enter the view, never a cost value', async () => {
    const salesView = await watch('u_sales1', { id: highCost });
    const salesTable = await watch('u_sales1');
    const editorView = await watch('u_editor', { id: highCost });

    const started = performance.now();
    await setCost(10);
    expect(await salesView.next(about('record.removed_from_view', r1))).toEqual({
      type: 'record.removed_from_view',
      channel,
      record_id: r1,
    });
    expect(performance.now() - started).toBeLessThan(1_000);
    await editorView.next(about('record.removed_from_view', r1));
    // Without the view, a change of a no_perm field sends nothing (P23).
    await salesTable.expectNone(anyAbout(r1));

    await setCost(70);
    expect(await salesView.next(about('record.added', r1))).toEqual({
      type: 'record.added',
      channel,
      record_id: r1,
    });
    await editorView.next(about('record.added', r1));
    // What the client fetches through the view is r1 (the query applies the same hidden condition).
    const lookup = await fx.call(
      'u_sales1',
      'POST',
      `/tables/${fx.orders.id}/records/query?field_key_type=id`,
      { view_id: highCost, ids: [r1] },
    );
    expect(lookup.statusCode, lookup.body).toBe(200);
    const found = recordListResponseSchema.parse(lookup.json()).records;
    expect(found.map((record) => record.id)).toEqual([r1]);
    expect(Object.keys(found[0]?.fields ?? {})).not.toContain(F('cost'));
  });

  it('created: only records in the view reach its subscribers', async () => {
    const salesView = await watch('u_sales1', { id: highCost });
    const salesTable = await watch('u_sales1');
    const [low, high] = records(
      await fx.call('u_editor', 'POST', orders, {
        records: [
          { fields: { [F('title')]: 'low', [F('cost')]: 5, ...owned('u_sales1') } },
          { fields: { [F('title')]: 'high', [F('cost')]: 500, ...owned('u_sales1') } },
        ],
      }),
    );
    const created = await salesView.next(about('record.created', high?.id));
    expect(Object.keys('fields' in created ? created.fields : {})).not.toContain(F('cost'));
    await salesTable.next(about('record.created', low?.id));
    await salesTable.next(about('record.created', high?.id));
    await salesView.expectNone(anyAbout(low?.id ?? ''));
  });

  it('filter_mode replace keeps only the hidden part on the server', async () => {
    const titled = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/views`, {
      name: 'Titled high cost',
      type: 'grid',
      config: {
        filter: {
          op: 'and',
          items: [
            { field: F('title'), operator: 'eq', value: 'r1' },
            { field: F('cost'), operator: 'gt', value: 50 },
          ],
        },
      },
    });
    expect(titled.statusCode, titled.body).toBe(201);
    const id = titled.json<{ id: string }>().id;
    const replace = await watch('u_sales1', { id, filter_mode: 'replace' });
    const and = await watch('u_sales1', { id });
    records(
      await fx.call('u_admin', 'PATCH', orders, {
        records: [{ id: r1, fields: { [F('title')]: 'renamed' } }],
      }),
    );
    // The temporary filter replaced `title = r1`: the client checks it itself (`ids`).
    await replace.next(about('record.updated', r1));
    await and.next(about('record.removed_from_view', r1));
    await setCost(20);
    await replace.next(about('record.removed_from_view', r1));
    records(
      await fx.call('u_admin', 'PATCH', orders, {
        records: [{ id: r1, fields: { [F('title')]: 'r1', [F('cost')]: 70 } }],
      }),
    );
    await replace.next(about('record.added', r1));
  });

  it('refuses a view the subscriber cannot see, naming it; a view on another channel is invalid', async () => {
    const personal = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/views`, {
      name: 'Mine',
      type: 'grid',
      is_personal: true,
    });
    expect(personal.statusCode, personal.body).toBe(201);
    const id = personal.json<{ id: string }>().id;
    const editor = await connect('u_editor');
    expect(await editor.subscribe(channel, 'v1', { view: { id } })).toEqual({
      type: 'error',
      req_id: 'v1',
      code: 'NOT_FOUND',
      channel,
      view_id: id,
    });
    expect(
      await editor.subscribe(`base:${fx.baseId}`, 'v2', { view: { id: highCost } }),
    ).toMatchObject({
      type: 'error',
      code: 'VALIDATION_FAILED',
      errors: [{ path: 'view', code: 'NOT_ALLOWED' }],
    });
  });

  it('a changed view filter applies to the next record change; a deleted view ends the subscription', async () => {
    const view = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/views`, {
      name: 'Cheap',
      type: 'grid',
      config: { filter: { op: 'and', items: [{ field: F('cost'), operator: 'gt', value: 50 }] } },
    });
    const id = view.json<{ id: string }>().id;
    await setCost(70);
    const sales = await watch('u_sales1', { id });
    const changed = await fx.call('u_admin', 'PATCH', `/views/${id}`, {
      config: { filter: { op: 'and', items: [{ field: F('cost'), operator: 'lt', value: 50 }] } },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    await sales.next((message) => message.type === 'schema.changed' && message.entity_id === id);
    // Under the old filter this would leave the view; under the new one it enters it.
    await setCost(20);
    await sales.next(about('record.added', r1));

    const deleted = await fx.call('u_admin', 'DELETE', `/views/${id}`);
    expect(deleted.statusCode, deleted.body).toBeLessThan(300);
    expect(
      await sales.next((message) => message.type === 'error' && message.req_id === null),
    ).toEqual({ type: 'error', req_id: null, code: 'NOT_FOUND', channel, view_id: id });
    await setCost(80);
    await sales.expectNone(anyAbout(r1));
  });
});
