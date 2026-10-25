import {
  notificationListSchema,
  notificationPreferencesSchema,
  type Id,
  type NotificationDto,
} from '@cellhive/contracts';
import { scheduleNotificationFlush, type Db } from '@cellhive/server-core';
import { createWorker, type WorkerHandle } from '@cellhive/worker';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { buildRecordFixture, type FixtureUser, type RecordFixture } from './record-fixture.js';
import { captureLogger, startTestApp, type TestApp } from './support.js';

async function eventually<T>(
  probe: () => Promise<T | undefined>,
  label: string,
  timeoutMs = 120_000,
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
 * BACKLOG T545 through the real API and worker (CONTRACTS §22.1–22.2; P39
 * notification part; S5b milestone): a follower is told about single
 * changes of a record by others — the default `followed` grouper of the
 * worker's `notifications.flush`, `data.field_ids` limited to the fields the
 * recipient reads — and never about a change they cannot read, a paste of
 * 200 rows, nor formula values recomputed by the write itself or after
 * the formula changes. The 60 s debounce is not waited for: the test
 * moves the group's pending flush to now, as time would.
 */
describe('record.followed_changed (T545)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let worker: WorkerHandle;
  let r1: Id<'rec'>;
  let r2: Id<'rec'>;

  const F = (name: string) => fx.fld[name]?.id as Id<'fld'>;
  const followUrl = (recordId: string) => `/tables/${fx.orders.id}/records/${recordId}/follow`;
  const me = (path: string) => `/orgs/${fx.orgId}/me${path}`;

  async function createOrders(
    records: { title: string; owner?: FixtureUser }[],
  ): Promise<Id<'rec'>[]> {
    const response = await fx.call(
      'u_admin',
      'POST',
      `/tables/${fx.orders.id}/records?field_key_type=id`,
      {
        records: records.map((record) => ({
          fields: {
            [F('title')]: record.title,
            ...(record.owner === undefined
              ? {}
              : { [F('owner')]: [{ id: fx.users[record.owner].id }] }),
          },
        })),
      },
    );
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ records: { id: Id<'rec'> }[] }>().records.map((record) => record.id);
  }

  async function edit(
    user: FixtureUser,
    records: { id: Id<'rec'>; fields: Record<string, unknown> }[],
  ): Promise<void> {
    const response = await fx.call(
      user,
      'PATCH',
      `/tables/${fx.orders.id}/records?field_key_type=id`,
      { records },
    );
    expect(response.statusCode, response.body).toBe(200);
  }

  /** Every event dispatched and no recompute or dispatch job left. */
  async function settled(): Promise<void> {
    await eventually(async () => {
      const { rows } = await sql<{ events: number; jobs: number }>`
        SELECT (SELECT count(*)::int FROM meta.events
                 WHERE organization_id = ${fx.orgId} AND dispatched_at IS NULL) AS events,
               (SELECT count(*)::int FROM graphile_worker.jobs
                 WHERE task_identifier IN ('events.dispatch', 'computed.recompute',
                                           'computed.backfill', 'notifications.fanout')) AS jobs
      `.execute(db.kysely);
      return rows[0]?.events === 0 && rows[0].jobs === 0 ? true : undefined;
    }, 'dispatched events');
  }

  async function bufferRows(recordId: Id<'rec'>) {
    return db.kysely
      .selectFrom('meta.notification_buffer')
      .select(['field_ids', 'actor_id'])
      .where('organization_id', '=', fx.orgId)
      .where('kind', '=', 'followed')
      .where('group_key', '=', recordId)
      .orderBy('id')
      .execute();
  }

  /** Lets the debounce window of the record end now, and waits for its flush. */
  async function flushNow(recordId: Id<'rec'>): Promise<void> {
    await db.withTx((tx) =>
      scheduleNotificationFlush(
        tx,
        { organization_id: fx.orgId, kind: 'followed', group_key: recordId },
        new Date(),
      ),
    );
    await eventually(
      async () => ((await bufferRows(recordId)).length === 0 ? true : undefined),
      `the flush of ${recordId}`,
    );
    await eventually(async () => {
      const { rows } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM graphile_worker.jobs
         WHERE task_identifier = 'notifications.flush' AND key = ${`followed:${recordId}`}
      `.execute(db.kysely);
      return rows[0]?.n === 0 ? true : undefined;
    }, 'the flush job to complete');
  }

  async function noticesOf(user: FixtureUser, recordId: Id<'rec'>): Promise<NotificationDto[]> {
    const response = await fx.call(user, 'GET', me('/notifications?limit=200'));
    expect(response.statusCode, response.body).toBe(200);
    return notificationListSchema
      .parse(response.json())
      .items.filter(
        (item) => item.type === 'record.followed_changed' && item.entity.id === recordId,
      );
  }

  async function rowsOf(recordId: Id<'rec'>) {
    return db.kysely
      .selectFrom('meta.notifications')
      .select(['user_id', 'payload'])
      .where('type', '=', 'record.followed_changed')
      .where('entity_id', '=', recordId)
      .orderBy('created_at')
      .orderBy('user_id')
      .execute();
  }

  async function clear(recordId: Id<'rec'>): Promise<void> {
    await sql`DELETE FROM meta.notifications WHERE entity_id = ${recordId}`.execute(db.kysely);
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    fx = await buildRecordFixture(t, db);
    // The worker's own task list: its default groupers include `followed`.
    worker = await createWorker(t.config, { logger: captureLogger().logger, pollIntervalMs: 50 });
    const [first, second] = await createOrders([
      { title: 'Đơn R1', owner: 'u_sales1' },
      { title: 'Đơn R2', owner: 'u_sales2' },
    ]);
    r1 = first as Id<'rec'>;
    r2 = second as Id<'rec'>;
    await settled();
  }, 300_000);

  afterAll(async () => {
    await worker.close();
    await t.close();
    await db.destroy();
    await database.drop();
  });

  it('record.followed_changed is produced: preferences list it, email off by default', async () => {
    const preferences = notificationPreferencesSchema.parse(
      (await fx.call('u_sales1', 'GET', me('/notification-preferences'))).json(),
    );
    expect(preferences.items).toContainEqual({
      type: 'record.followed_changed',
      channel: 'in_app',
      enabled: true,
      locked: false,
    });
    expect(
      preferences.items.find(
        (item) => item.type === 'record.followed_changed' && item.channel === 'email',
      )?.enabled ?? false,
    ).toBe(false);
  });

  it('P39: u_sales1 follows r1 (r2 → 404); u_editor changes cost → nothing; amount → told with [amount]', async () => {
    expect((await fx.call('u_sales1', 'PUT', followUrl(r2))).statusCode).toBe(404);
    expect((await fx.call('u_sales1', 'PUT', followUrl(r1))).statusCode).toBe(204);

    await edit('u_editor', [{ id: r1, fields: { [F('cost')]: 10 } }]);
    await settled();
    expect(await bufferRows(r1)).toEqual([
      { field_ids: [F('cost')], actor_id: fx.users.u_editor.id },
    ]);
    await flushNow(r1);
    expect(await noticesOf('u_sales1', r1)).toEqual([]);
    expect(await rowsOf(r1)).toEqual([]);

    await edit('u_editor', [{ id: r1, fields: { [F('amount')]: 900 } }]);
    await settled();
    await flushNow(r1);
    const [notice, ...others] = await noticesOf('u_sales1', r1);
    expect(others).toEqual([]);
    expect(notice).toMatchObject({
      type: 'record.followed_changed',
      base: { id: fx.baseId },
      table_id: fx.orders.id,
      entity: { type: 'record', id: r1, title: 'Đơn R1' },
      actor: { type: 'user', id: fx.users.u_editor.id, name: 'User editor' },
      data: { field_ids: [F('amount')], change_count: 1, actor_ids: [fx.users.u_editor.id] },
      read_at: null,
    });
    // Nobody else follows r1: no other row.
    expect((await rowsOf(r1)).map((row) => row.user_id)).toEqual([fx.users.u_sales1.id]);
    await clear(r1);
  });

  it('amount + cost in one change → [amount]; five changes → one notification, change_count 5', async () => {
    await edit('u_editor', [{ id: r1, fields: { [F('amount')]: 901, [F('cost')]: 11 } }]);
    await settled();
    await flushNow(r1);
    expect((await noticesOf('u_sales1', r1)).map((item) => item.data)).toEqual([
      { field_ids: [F('amount')], change_count: 1, actor_ids: [fx.users.u_editor.id] },
    ]);
    await clear(r1);

    for (let i = 0; i < 5; i += 1) {
      await edit('u_editor', [{ id: r1, fields: { [F('amount')]: 1000 + i } }]);
    }
    await settled();
    expect(await bufferRows(r1)).toHaveLength(5);
    await flushNow(r1);
    expect((await noticesOf('u_sales1', r1)).map((item) => item.data)).toEqual([
      { field_ids: [F('amount')], change_count: 5, actor_ids: [fx.users.u_editor.id] },
    ]);
    await clear(r1);
  });

  it('the follower who edits is not told; u_reader following r1 is told about their change', async () => {
    expect((await fx.call('u_reader', 'PUT', followUrl(r1))).statusCode).toBe(204);
    await edit('u_sales1', [{ id: r1, fields: { [F('amount')]: 2000 } }]);
    await settled();
    await flushNow(r1);
    expect(await noticesOf('u_sales1', r1)).toEqual([]);
    expect((await noticesOf('u_reader', r1)).map((item) => [item.actor?.id, item.data])).toEqual([
      [
        fx.users.u_sales1.id,
        { field_ids: [F('amount')], change_count: 1, actor_ids: [fx.users.u_sales1.id] },
      ],
    ]);
    expect((await fx.call('u_reader', 'DELETE', followUrl(r1))).statusCode).toBe(204);
    await clear(r1);
  });

  it('a paste of 200 rows including r1 → the follower gets nothing', async () => {
    const pasted = await createOrders(
      Array.from({ length: 199 }, (_, i) => ({ title: `Paste ${String(i)}`, owner: 'u_sales1' })),
    );
    await settled();
    await edit('u_editor', [
      { id: r1, fields: { [F('amount')]: 3000 } },
      ...pasted.map((id, i) => ({ id, fields: { [F('amount')]: i } })),
    ]);
    await settled();
    expect(await bufferRows(r1)).toEqual([]);
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM graphile_worker.jobs
       WHERE task_identifier = 'notifications.flush'
    `.execute(db.kysely);
    expect(rows[0]?.n).toBe(0);
    expect(await rowsOf(r1)).toEqual([]);
  });

  it('formula values recomputed by the write or after an expression change are never a change', async () => {
    expect((await fx.call('u_reader', 'PUT', followUrl(r1))).statusCode).toBe(204);
    const created = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
      name: 'double',
      type: 'formula',
      options: { expression: '[amount] * 2' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const double = created.json<{ id: Id<'fld'>; compute_mode: string }>();
    expect(double.compute_mode).toBe('stored');
    // An automation watching the formula makes Cellhive emit its recomputed values.
    const automation = await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/automations`, {
      name: 'Watch double',
      enabled: true,
      definition: {
        trigger: { type: 'record.updated', table_id: fx.orders.id, watch_fields: [double.id] },
        condition: null,
        // Creates a customer: no change to any order, so nothing for the followers.
        actions: [
          {
            id: 'act_1',
            type: 'create_record',
            config: {
              table_id: fx.customers.id,
              fields: { [F('customerName')]: { literal: 'Từ automation' } },
            },
          },
        ],
      },
    });
    expect(automation.statusCode, automation.body).toBe(201);
    await settled();

    // The write's own event carries `double` too: only `amount` is a change.
    await edit('u_editor', [{ id: r1, fields: { [F('amount')]: 4000 } }]);
    await settled();
    const written = await sql<{ fields: string[] }>`
      SELECT ARRAY(SELECT jsonb_object_keys(payload->'changes')) AS fields
        FROM meta.events
       WHERE organization_id = ${fx.orgId} AND entity_id = ${r1} AND type = 'record.updated'
       ORDER BY created_at DESC LIMIT 1
    `.execute(db.kysely);
    // The recomputed `double` was folded into the write's own event.
    expect([...(written.rows[0]?.fields ?? [])].sort()).toEqual([F('amount'), double.id].sort());
    expect((await bufferRows(r1)).map((row) => row.field_ids)).toEqual([[F('amount')]]);
    await flushNow(r1);
    expect((await noticesOf('u_reader', r1)).map((item) => item.data)).toEqual([
      { field_ids: [F('amount')], change_count: 1, actor_ids: [fx.users.u_editor.id] },
    ]);
    await clear(r1);

    // Changing the expression recomputes every row: no notification.
    const changed = await fx.call('u_admin', 'PATCH', `/fields/${double.id}`, {
      options: { expression: '[amount] * 3' },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    await settled();
    expect(await bufferRows(r1)).toEqual([]);
    expect(await rowsOf(r1)).toEqual([]);
    expect((await fx.call('u_reader', 'DELETE', followUrl(r1))).statusCode).toBe(204);
  });
});
