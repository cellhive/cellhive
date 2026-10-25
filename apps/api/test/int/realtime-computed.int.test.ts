import { loadavg } from 'node:os';
import { performance } from 'node:perf_hooks';

import {
  fieldSchema,
  newId,
  recordsResponseSchema,
  type FieldDto,
  type Id,
  type RealtimeServerMessage,
  type RecordDto,
} from '@cellhive/contracts';
import { roleConfigSchema } from '@cellhive/permissions';
import {
  BaseRoleMembersRepository,
  BaseRolesRepository,
  orgScope,
  RecordMutationService,
  systemAuditContext,
  type Db,
  type JsonObject,
} from '@cellhive/server-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { closeSockets, listen, TestSocket } from './realtime-support.js';
import { buildRecordFixture, type FixtureUser, type RecordFixture } from './record-fixture.js';
import { startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

type Message = RealtimeServerMessage;

/**
 * T459 over HTTP + WebSocket (writes on instance A, clients on instance B):
 * recomputed formula/lookup values reach subscribers as `record.updated`
 * (`event_id: null`, version unchanged) under each subscriber's permissions
 * (T457): `locked` fields never, values computed with the subscriber's own
 * read scope as one `record.batch`; bulk writes give one `record.batch` per
 * group; view filters on computed fields move records in and out of views;
 * a change of the primary field refreshes link cells of other tables; the
 * base setting `strict_computed_permissions` sends `schema.changed`.
 */
describe('realtime of recomputed values (T459)', () => {
  let database: TestDatabase;
  let db: Db;
  let a: TestApp;
  let b: TestApp;
  let urlB: string;
  let fx: RecordFixture;
  let customerLink: FieldDto;
  let total: FieldDto;
  let code: FieldDto;
  let bigView: string;
  let c1: Id<'rec'>;
  let o1: Id<'rec'>;
  const sockets: TestSocket[] = [];

  const F = (name: string): Id<'fld'> => {
    const field = fx.fld[name];
    if (field === undefined) throw new Error(`no field ${name}`);
    return field.id;
  };
  const customersChannel = () => `table:${fx.customers.id}`;
  const ordersChannel = () => `table:${fx.orders.id}`;

  function created(response: LightMyRequestResponse): FieldDto {
    expect(response.statusCode, response.body).toBe(201);
    return fieldSchema.parse(response.json());
  }

  function records(response: LightMyRequestResponse): RecordDto[] {
    expect(response.statusCode, response.body).toBeLessThan(300);
    return recordsResponseSchema.parse(response.json()).records;
  }

  async function watch(
    user: FixtureUser,
    channel: string,
    view?: Record<string, unknown>,
  ): Promise<TestSocket> {
    const socket = await TestSocket.connect(urlB, {
      origin: TEST_PUBLIC_URL,
      cookie: await fx.cookie(user),
    });
    sockets.push(socket);
    expect(await socket.subscribe(channel, 's1', view === undefined ? {} : { view })).toMatchObject(
      { type: 'subscribed' },
    );
    return socket;
  }

  const setAmount = async (recordId: Id<'rec'>, amount: number) =>
    records(
      await fx.call('u_admin', 'PATCH', `/tables/${fx.orders.id}/records?field_key_type=id`, {
        records: [{ id: recordId, fields: { [F('amount')]: amount } }],
      }),
    );

  const about =
    (type: Message['type'], recordId?: string) =>
    (message: Message): boolean =>
      message.type === type &&
      (recordId === undefined || ('record_id' in message && message.record_id === recordId));
  const isRecordMessage = (message: Message) => message.type.startsWith('record.');

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    a = await startTestApp({ DATABASE_URL: database.url });
    b = await startTestApp({ DATABASE_URL: database.url });
    await listen(a.app);
    urlB = await listen(b.app);
    fx = await buildRecordFixture(a, db);

    // u_out: every customer, only the orders they own (a record rule on the lookup's source).
    const scope = orgScope(fx.orgId);
    const ownerIsMe = {
      op: 'and',
      items: [{ field: F('owner'), operator: 'has_any_of', value: [{ $var: 'current_user' }] }],
    };
    const role = await new BaseRolesRepository(db).create(scope, {
      baseId: fx.baseId,
      name: 'Own orders',
      kind: 'custom',
      config: roleConfigSchema.parse({
        base_rule: { copy: false, download: false, share_link: false },
        tables: {
          [fx.orders.id]: {
            perm: 'read_only',
            record_rule: { operations: [], read_scope: 'filter', read_filter: ownerIsMe },
          },
          [fx.customers.id]: {
            perm: 'read_only',
            record_rule: { operations: [], read_scope: 'all' },
          },
        },
        dashboards: {},
      }) as unknown as JsonObject,
    });
    await new BaseRoleMembersRepository(db).assign(scope, {
      baseId: fx.baseId,
      roleId: role.id,
      principalType: 'user',
      principalId: fx.users.u_out.id,
    });

    customerLink = created(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
        name: 'customer',
        type: 'link',
        options: { link_table: fx.customers.id },
      }),
    );
    [c1] = records(
      await fx.call('u_admin', 'POST', `/tables/${fx.customers.id}/records`, {
        records: [{ fields: { Tên: 'An Phát', 'Mã khách hàng': 'K1' } }],
      }),
    ).map((record) => record.id) as [Id<'rec'>];
    [o1] = records(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/records`, {
        records: [
          {
            fields: {
              title: 'o1',
              amount: 1000,
              owner: [{ id: fx.users.u_sales1.id }],
              customer: [c1],
            },
          },
          { fields: { title: 'o2', amount: 500, customer: [c1] } },
        ],
      }),
    ).map((record) => record.id) as [Id<'rec'>];
    total = created(
      await fx.call('u_admin', 'POST', `/tables/${fx.customers.id}/fields`, {
        name: 'total',
        type: 'lookup',
        options: {
          from: fx.orders.id,
          select: F('amount'),
          where: {
            field: customerLink.id,
            operator: 'intersects',
            value: { field_ref: '__id' },
          },
          aggregate: 'sum',
        },
      }),
    );
    // Reads Customers through the link: locked for u_sales1 (no access to Customers).
    code = created(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
        name: 'code',
        type: 'formula',
        options: { expression: '[customer].[Mã khách hàng]' },
      }),
    );
    const view = await fx.call('u_admin', 'POST', `/tables/${fx.customers.id}/views`, {
      name: 'Tổng > 10 triệu',
      type: 'grid',
      config: {
        filter: { op: 'and', items: [{ field: total.id, operator: 'gt', value: 10_000_000 }] },
      },
    });
    expect(view.statusCode, view.body).toBe(201);
    bigView = view.json<{ id: string }>().id;
    // The backfill job does not run here: a first write computes the stored values.
    await setAmount(o1, 1000);
  }, 120_000);

  afterAll(async () => {
    await closeSockets(sockets);
    await Promise.all([a.close(), b.close()]);
    await db.destroy();
    await database.drop();
  });

  it('amount of an order changes → the Customers tab gets the new total (p95 < 1 s); a scoped reader a record.batch', async () => {
    const reader = await watch('u_reader', customersChannel());
    const scoped = await watch('u_out', customersChannel());
    const samples: number[] = [];
    for (let index = 1; index <= 20; index += 1) {
      const started = performance.now();
      await setAmount(o1, 1000 + index);
      const message = await reader.next(about('record.updated', c1));
      samples.push(performance.now() - started);
      expect(message).toEqual({
        type: 'record.updated',
        channel: customersChannel(),
        record_id: c1,
        version: expect.any(Number) as number,
        fields: { [total.id]: 1500 + index },
        actor_id: null,
        event_id: null,
      });
      expect(await scoped.next(about('record.batch'))).toEqual({
        type: 'record.batch',
        channel: customersChannel(),
        actor_id: null,
        count: 1,
        ops: { created: 0, updated: 1, added: 0, removed_from_view: 0, deleted: 0, restored: 0 },
      });
    }
    await scoped.expectNone((message) => message.type === 'record.updated');
    samples.sort((x, y) => x - y);
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1] ?? 0;
    const load = loadavg()[0] ?? 0;
    process.stdout.write(
      `T459 PATCH amount → WS total: p50 ${samples[10]?.toFixed(1) ?? '?'} ms, p95 ${p95.toFixed(1)} ms (load ${load.toFixed(2)})\n`,
    );
    // Latency is only meaningful on an idle machine (BACKLOG S4b conventions).
    if (load < 8) expect(p95).toBeLessThan(1_000);
  });

  it('u_sales1 (the field is locked for them) receives nothing when a customer code changes', async () => {
    const admin = await watch('u_admin', ordersChannel());
    const sales = await watch('u_sales1', ordersChannel());
    records(
      await fx.call('u_admin', 'PATCH', `/tables/${fx.customers.id}/records?field_key_type=id`, {
        records: [{ id: c1, fields: { [F('customerCode')]: 'K9' } }],
      }),
    );
    expect(await admin.next(about('record.updated', o1))).toMatchObject({
      fields: { [code.id]: ['K9'] },
      event_id: null,
    });
    await sales.expectNone(isRecordMessage);
  });

  it('bulk 1 000 orders → one record.batch per Customers group', async () => {
    const customers = records(
      await fx.call('u_admin', 'POST', `/tables/${fx.customers.id}/records`, {
        records: Array.from({ length: 150 }, (_, index) => ({
          fields: { Tên: `Khách ${String(index)}` },
        })),
      }),
    );
    const orders = records(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/records`, {
        records: Array.from({ length: 1000 }, (_, index) => ({
          fields: {
            title: `bulk ${String(index)}`,
            amount: 1,
            customer: [customers[index % customers.length]?.id],
          },
        })),
      }),
    );
    const reader = await watch('u_reader', customersChannel());
    const scoped = await watch('u_out', customersChannel());
    records(
      await fx.call('u_admin', 'PATCH', `/tables/${fx.orders.id}/records?field_key_type=id`, {
        records: orders.map((order) => ({ id: order.id, fields: { [F('amount')]: 2 } })),
      }),
    );
    for (const socket of [reader, scoped]) {
      expect(await socket.next(about('record.batch'))).toMatchObject({
        type: 'record.batch',
        actor_id: null,
        count: 150,
        ops: { updated: 150 },
      });
      await socket.expectNone(isRecordMessage);
    }
  });

  it('view "Tổng > 10 triệu": a customer crossing it gets record.added, then record.removed_from_view', async () => {
    const reader = await watch('u_reader', customersChannel(), { id: bigView });
    await setAmount(o1, 20_000_000);
    expect(await reader.next(about('record.added', c1))).toEqual({
      type: 'record.added',
      channel: customersChannel(),
      record_id: c1,
    });
    await setAmount(o1, 1000);
    expect(await reader.next(about('record.removed_from_view', c1))).toEqual({
      type: 'record.removed_from_view',
      channel: customersChannel(),
      record_id: c1,
    });
  });

  it('a change of the Customers primary field refreshes link cells of Orders (record.batch after refetch)', async () => {
    const reader = await watch('u_reader', ordersChannel());
    // u_sales1 cannot see customer titles: titles only change, so nothing.
    const sales = await watch('u_sales1', ordersChannel());
    const response = await fx.call('u_admin', 'PATCH', `/fields/${F('customerName')}`, {
      options: { style: { type: 'phone' } },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(await reader.next(about('record.batch'))).toMatchObject({
      type: 'record.batch',
      actor_id: null,
      ops: { updated: expect.any(Number) as number },
    });
    await sales.expectNone(isRecordMessage);
  });

  it('strict_computed_permissions toggles → schema.changed for the computed fields', async () => {
    const reader = await watch('u_reader', ordersChannel());
    const response = await fx.call('owner', 'PATCH', `/bases/${fx.baseId}`, {
      settings: { strict_computed_permissions: true },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(
      await reader.next(
        (message) => message.type === 'schema.changed' && message.entity_id === code.id,
      ),
    ).toEqual({
      type: 'schema.changed',
      channel: ordersChannel(),
      entity: 'field',
      entity_id: code.id,
      action: 'updated',
    });
    // Only fields of the subscribed table, only once per change.
    await reader.expectNone(
      (message) => message.type === 'schema.changed' && message.entity_id === total.id,
    );
    const back = await fx.call('owner', 'PATCH', `/bases/${fx.baseId}`, {
      settings: { strict_computed_permissions: false },
    });
    expect(back.statusCode, back.body).toBe(200);
  });

  /**
   * T462 (gaps of T459): a view filter naming a virtual formula (no stored
   * value for images) or — with `filter_mode: replace` — a field locked
   * for the subscriber over a table they cannot read cannot be decided on
   * images: the subscriber gets one `record.batch` (refetch), never a
   * per-record message that silently ignored the condition.
   */
  it('view filters on a virtual formula / a locked field (replace) → record.batch', async () => {
    const recent = created(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
        name: 'recent',
        type: 'formula',
        options: { expression: '[amount] + DAY(TODAY()) * 0' },
      }),
    );
    expect(recent).toMatchObject({ compute_mode: 'virtual' });
    const views: Record<string, string> = {};
    for (const [name, filter] of [
      ['recent', { op: 'and', items: [{ field: recent.id, operator: 'gte', value: 0 }] }],
      ['coded', { op: 'and', items: [{ field: code.id, operator: 'is_not_empty' }] }],
    ] as const) {
      const response = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/views`, {
        name,
        type: 'grid',
        config: { filter },
      });
      expect(response.statusCode, response.body).toBe(201);
      views[name] = response.json<{ id: string }>().id;
    }
    const onVirtual = await watch('u_reader', ordersChannel(), { id: views['recent'] });
    const plain = await watch('u_reader', ordersChannel());
    const onLocked = await watch('u_sales1', ordersChannel(), {
      id: views['coded'],
      filter_mode: 'replace',
    });
    records(
      await fx.call('u_admin', 'PATCH', `/tables/${fx.orders.id}/records?field_key_type=id`, {
        records: [{ id: o1, fields: { [F('title')]: 'o1 renamed' } }],
      }),
    );
    expect(await plain.next(about('record.updated', o1))).toMatchObject({
      fields: { [F('title')]: 'o1 renamed' },
    });
    for (const socket of [onVirtual, onLocked]) {
      expect(await socket.next(isRecordMessage)).toEqual({
        type: 'record.batch',
        channel: ordersChannel(),
        actor_id: fx.users.u_admin.id,
        count: 1,
        ops: { created: 0, updated: 1, added: 0, removed_from_view: 0, deleted: 0, restored: 0 },
      });
      await socket.expectNone((message) => message.type === 'record.updated');
    }
  });

  /**
   * T509 (S4b-review §4 #13): writes of system jobs (here the removal of a
   * select option, `schema.remove_select_options`) go through the same
   * publisher as request writes, with the meta of virtual fields: a view
   * filtering on a virtual formula gets one `record.batch`, never a patch.
   */
  it('a system job write → a view filtering on a virtual formula gets record.batch', async () => {
    const status = fx.fld['status'];
    if (status === undefined) throw new Error('no status');
    const options = (status.options as { options: { id: Id<'opt'>; name: string }[] }).options;
    const removed = options.find((option) => option.name === 'Mới');
    if (removed === undefined) throw new Error('no option');
    const daily = created(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
        name: 'daily',
        type: 'formula',
        options: { expression: '[amount] + DAY(TODAY()) * 0' },
      }),
    );
    expect(daily).toMatchObject({ compute_mode: 'virtual' });
    const view = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/views`, {
      name: 'daily',
      type: 'grid',
      config: { filter: { op: 'and', items: [{ field: daily.id, operator: 'gte', value: 0 }] } },
    });
    expect(view.statusCode, view.body).toBe(201);
    records(
      await fx.call('u_admin', 'PATCH', `/tables/${fx.orders.id}/records?field_key_type=id`, {
        records: [{ id: o1, fields: { [F('status')]: removed.id } }],
      }),
    );
    const socket = await watch('u_reader', ordersChannel(), { id: view.json<{ id: string }>().id });
    // The option is gone from the field; the job clears it from the cells.
    const patched = await fx.call('u_admin', 'PATCH', `/fields/${F('status')}`, {
      options: { options: options.filter((option) => option.id !== removed.id) },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    await socket.expectNone(isRecordMessage);
    const result = await a.app
      .get(RecordMutationService)
      .removeSelectOptionValues(
        orgScope(fx.orgId),
        fx.orders.id,
        F('status'),
        [removed.id],
        systemAuditContext(newId('job')),
      );
    expect(result.updated).toBeGreaterThanOrEqual(1);
    expect(await socket.next(isRecordMessage)).toMatchObject({
      type: 'record.batch',
      channel: ordersChannel(),
      actor_id: null,
      ops: { updated: result.updated },
    });
    await socket.expectNone((message) => message.type === 'record.updated');
  });
});
