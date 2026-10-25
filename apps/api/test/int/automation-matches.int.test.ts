import {
  automationSchema,
  fieldSchema,
  type AutomationDto,
  type FieldDto,
  type Id,
} from '@cellhive/contracts';
import { emit, orgScope, SchemaService, systemAuditContext, type Db } from '@cellhive/server-core';
import { createWorker, type WorkerHandle } from '@cellhive/worker';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { buildRecordFixture, expectProblem, type RecordFixture } from './record-fixture.js';
import { captureLogger, problemOf, startTestApp, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

/** `AUTOMATION_MAX_RUNS_PER_BATCH` of this file: small, so a paste of 500 hits it. */
const MAX_RUNS_PER_BATCH = 200;

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

interface RunRow {
  readonly id: Id<'run'>;
  readonly status: string;
  readonly trigger_event_id: Id<'evt'> | null;
  readonly trigger_unit: string;
  readonly error: Record<string, unknown> | null;
  readonly record_id: string | null;
  readonly event_type: string | null;
}

/**
 * BACKLOG T510 through the real API and worker: a `record.matches`
 * automation gets a run when a record goes from not matching its condition
 * to matching it — created matching, changed into it (computed values
 * recomputed by T509 included), restored matching — and never again while
 * it keeps matching; leaving and entering again fires again. The condition
 * is tested as `run_as`; bulk changes follow `skip_bulk` and the fan-out
 * cap. The worker also runs them (T505): only their creation is asserted.
 */
describe('record.matches trigger (T510)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let worker: WorkerHandle;
  let priority: FieldDto;
  let double: FieldDto;
  let recent: FieldDto;
  const created: Id<'aut'>[] = [];
  const opt = { urgent: '', normal: '', ordersNew: '', ordersDone: '' };

  const F = (name: string) => fx.fld[name]?.id as Id<'fld'>;

  function fieldOf(response: LightMyRequestResponse): FieldDto {
    expect(response.statusCode, response.body).toBe(201);
    return fieldSchema.parse(response.json());
  }

  async function automation(
    trigger: Record<string, unknown>,
    name = 'Matches test',
  ): Promise<AutomationDto> {
    const response = await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/automations`, {
      name,
      enabled: true,
      definition: {
        trigger: { type: 'record.matches', ...trigger },
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
    expect(response.statusCode, response.body).toBe(201);
    const dto = automationSchema.parse(response.json());
    created.push(dto.id);
    return dto;
  }

  /** Nothing left to recompute, then every event dispatched. */
  async function settled(timeoutMs = 120_000): Promise<void> {
    await eventually(
      async () => {
        const { rows } = await sql<{ queued: number; jobs: number; events: number }>`
          SELECT (SELECT count(*)::int FROM meta.computed_recompute_queue) AS queued,
                 (SELECT count(*)::int FROM graphile_worker._private_jobs p
                    JOIN graphile_worker._private_tasks k ON k.id = p.task_id
                   WHERE k.identifier IN ('computed.recompute', 'computed.backfill')) AS jobs,
                 (SELECT count(*)::int FROM meta.events WHERE dispatched_at IS NULL) AS events
        `.execute(db.kysely);
        const row = rows[0];
        return row?.queued === 0 && row.jobs === 0 && row.events === 0;
      },
      'recomputes and dispatches',
      timeoutMs,
    );
  }

  async function runsOf(id: Id<'aut'>): Promise<RunRow[]> {
    const { rows } = await sql<RunRow>`
      SELECT r.id, r.status, r.trigger_event_id, r.trigger_unit, r.error,
             r.input->'trigger'->>'record_id' AS record_id,
             r.input->'trigger'->>'type' AS event_type
        FROM meta.automation_runs r WHERE r.automation_id = ${id}
       ORDER BY r.created_at, r.id
    `.execute(db.kysely);
    return rows;
  }

  async function create(
    tableId: Id<'tbl'>,
    records: Record<string, unknown>[],
    user: 'u_admin' | 'u_sales1' = 'u_admin',
  ): Promise<Id<'rec'>[]> {
    const response = await fx.call(user, 'POST', `/tables/${tableId}/records?field_key_type=id`, {
      records: records.map((fields) => ({ fields })),
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ records: { id: Id<'rec'> }[] }>().records.map((record) => record.id);
  }

  async function patch(
    tableId: Id<'tbl'>,
    id: Id<'rec'>,
    fields: Record<string, unknown>,
  ): Promise<void> {
    const response = await fx.call(
      'u_admin',
      'PATCH',
      `/tables/${tableId}/records?field_key_type=id`,
      { records: [{ id, fields }] },
    );
    expect(response.statusCode, response.body).toBe(200);
    await settled();
  }

  const ticket = (title: string, level: 'urgent' | 'normal' | null) => ({
    [F('ticketTitle')]: title,
    ...(level === null ? {} : { [priority.id]: opt[level] }),
  });

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({
      DATABASE_URL: database.url,
      AUTOMATION_MAX_RUNS_PER_BATCH: String(MAX_RUNS_PER_BATCH),
    });
    fx = await buildRecordFixture(t, db);
    worker = await createWorker(t.config, { logger: captureLogger().logger, pollIntervalMs: 50 });
    priority = fieldOf(
      await fx.call('u_admin', 'POST', `/tables/${fx.tickets.id}/fields`, {
        name: 'Ưu tiên',
        type: 'select',
        options: { options: [{ name: 'Khẩn' }, { name: 'Thường' }] },
      }),
    );
    const options = (priority.options as { options: { id: string; name: string }[] }).options;
    opt.urgent = options.find((option) => option.name === 'Khẩn')?.id ?? '';
    opt.normal = options.find((option) => option.name === 'Thường')?.id ?? '';
    const statusOptions = (fx.fld.status?.options as { options: { id: string; name: string }[] })
      .options;
    opt.ordersNew = statusOptions.find((option) => option.name === 'Mới')?.id ?? '';
    opt.ordersDone = statusOptions.find((option) => option.name === 'Xong')?.id ?? '';
    double = fieldOf(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
        name: 'double',
        type: 'formula',
        options: { expression: '[amount] * 2' },
      }),
    );
    expect(double).toMatchObject({ compute_mode: 'stored' });
    recent = fieldOf(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
        name: 'recent',
        type: 'formula',
        options: { expression: '[amount] + DAY(TODAY()) * 0' },
      }),
    );
    expect(recent).toMatchObject({ compute_mode: 'virtual' });
    await settled(300_000);
  }, 300_000);

  afterEach(async () => {
    // Earlier automations must not answer the next test's events.
    await settled();
    for (const id of created.splice(0)) {
      await fx.call('u_admin', 'POST', `/automations/${id}/disable`);
    }
  });

  afterAll(async () => {
    await worker.close();
    await t.close();
    await db.destroy();
    await database.drop();
  });

  it('checks the condition when saved: at least one condition, no changed*, no virtual field (422)', async () => {
    for (const [condition, path, code] of [
      [{ op: 'and', items: [] }, 'definition.trigger.condition', 'EMPTY_FILTER'],
      [
        { field: F('status'), operator: 'changed_to', value: opt.ordersDone },
        'definition.trigger.condition.operator',
        'OPERATOR_NOT_ALLOWED',
      ],
      [
        { op: 'and', items: [{ field: recent.id, operator: 'gt', value: 1 }] },
        'definition.trigger.condition.items[0].field',
        'INVALID_FIELD_TYPE',
      ],
    ] as const) {
      const response = await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/automations`, {
        name: 'Invalid',
        enabled: false,
        definition: {
          trigger: { type: 'record.matches', table_id: fx.orders.id, condition },
          actions: [],
        },
      });
      expectProblem(response, 422, 'AUTOMATION_INVALID');
      expect(problemOf(response.body).errors).toEqual([expect.objectContaining({ path, code })]);
    }
  });

  it('created matching fires; editing another field does not; Khẩn → Thường → Khẩn fires twice', async () => {
    const urgent = await automation({
      table_id: fx.tickets.id,
      condition: { field: priority.id, operator: 'is', value: opt.urgent },
    });
    const [hot, cold] = (await create(fx.tickets.id, [ticket('Nóng', 'urgent')]).then(
      async (first) => [...first, ...(await create(fx.tickets.id, [ticket('Nguội', 'normal')]))],
    )) as [Id<'rec'>, Id<'rec'>];
    await settled();
    expect(await runsOf(urgent.id)).toEqual([
      expect.objectContaining({ record_id: hot, event_type: 'record.created' }),
    ]);

    // Already "Khẩn": editing the title (or saving the same value) does not fire again.
    await patch(fx.tickets.id, hot, { [F('ticketTitle')]: 'Nóng (sửa)' });
    await patch(fx.tickets.id, hot, { [priority.id]: opt.urgent, [F('ticketAmount')]: 5 });
    expect(await runsOf(urgent.id)).toHaveLength(1);

    // Out and in again: fires each time it enters.
    await patch(fx.tickets.id, cold, { [priority.id]: opt.urgent });
    await patch(fx.tickets.id, cold, { [priority.id]: opt.normal });
    await patch(fx.tickets.id, cold, { [priority.id]: opt.urgent });
    const runs = await runsOf(urgent.id);
    expect(runs.filter((run) => run.record_id === cold)).toEqual([
      expect.objectContaining({ event_type: 'record.updated' }),
      expect.objectContaining({ event_type: 'record.updated' }),
    ]);
    expect(runs).toHaveLength(3);
  });

  it('a record changed before its creation is dispatched fires once, on the right event (T527)', async () => {
    const urgent = await automation({
      table_id: fx.tickets.id,
      condition: { field: priority.id, operator: 'is', value: opt.urgent },
    });
    // The worker stops: both writes wait for dispatch, as with a backlog.
    await worker.close();
    const write = async (method: 'POST' | 'PATCH', body: object) => {
      const response = await fx.call(
        'u_admin',
        method,
        `/tables/${fx.tickets.id}/records?field_key_type=id`,
        body,
      );
      expect(response.statusCode, response.body).toBeLessThan(300);
      return response.json<{ records: { id: Id<'rec'> }[] }>().records.map((item) => item.id);
    };
    // Created without priority, then made Khẩn: only the change enters the condition.
    const [late] = (await write('POST', { records: [{ fields: ticket('Muộn', null) }] })) as [
      Id<'rec'>,
    ];
    await write('PATCH', { records: [{ id: late, fields: { [priority.id]: opt.urgent } }] });
    // Created Khẩn, then its title edited: the creation entered it, the edit did not.
    const [early] = (await write('POST', { records: [{ fields: ticket('Sớm', 'urgent') }] })) as [
      Id<'rec'>,
    ];
    await write('PATCH', { records: [{ id: early, fields: { [F('ticketTitle')]: 'Sớm (sửa)' } }] });
    worker = await createWorker(t.config, { logger: captureLogger().logger, pollIntervalMs: 50 });
    await settled();
    const runs = await runsOf(urgent.id);
    expect(runs.filter((run) => run.record_id === late)).toEqual([
      expect.objectContaining({ event_type: 'record.updated' }),
    ]);
    expect(runs.filter((run) => run.record_id === early)).toEqual([
      expect.objectContaining({ event_type: 'record.created' }),
    ]);
    expect(runs).toHaveLength(2);
  });

  it('fields outside the change use the current value on both sides', async () => {
    // "Khẩn and has an amount": entering through either field fires, once.
    const both = await automation({
      table_id: fx.tickets.id,
      condition: {
        op: 'and',
        items: [
          { field: priority.id, operator: 'is', value: opt.urgent },
          { field: F('ticketAmount'), operator: 'is_not_empty' },
        ],
      },
    });
    // "Khẩn or has an amount": already matching through the amount, Khẩn changes nothing.
    const either = await automation({
      table_id: fx.tickets.id,
      condition: {
        op: 'or',
        items: [
          { field: priority.id, operator: 'is', value: opt.urgent },
          { field: F('ticketAmount'), operator: 'is_not_empty' },
        ],
      },
    });
    const [id] = (await create(fx.tickets.id, [ticket('Hai điều kiện', 'normal')])) as [Id<'rec'>];
    await settled();
    expect(await runsOf(both.id)).toEqual([]);
    expect(await runsOf(either.id)).toEqual([]);
    await patch(fx.tickets.id, id, { [priority.id]: opt.urgent });
    expect(await runsOf(both.id)).toEqual([]);
    expect(await runsOf(either.id)).toHaveLength(1);
    await patch(fx.tickets.id, id, { [F('ticketAmount')]: 10 });
    expect(await runsOf(both.id)).toHaveLength(1);
    expect(await runsOf(either.id)).toHaveLength(1);
  });

  it('a record restored from the trash counts as new: fires when it matches', async () => {
    const [matching, other] = await create(fx.tickets.id, [
      ticket('Khôi phục khẩn', 'urgent'),
      ticket('Khôi phục thường', 'normal'),
    ]);
    await settled();
    const urgent = await automation({
      table_id: fx.tickets.id,
      condition: { field: priority.id, operator: 'is', value: opt.urgent },
    });
    for (const id of [matching, other]) {
      const response = await fx.call(
        'u_admin',
        'DELETE',
        `/tables/${fx.tickets.id}/records/${String(id)}`,
      );
      expect(response.statusCode, response.body).toBe(204);
    }
    const restored = await fx.call('u_admin', 'POST', `/tables/${fx.tickets.id}/records/restore`, {
      ids: [matching],
    });
    expect(restored.statusCode, restored.body).toBe(200);
    const restoredOther = await fx.call(
      'u_admin',
      'POST',
      `/tables/${fx.tickets.id}/records/restore`,
      { ids: [other] },
    );
    expect(restoredOther.statusCode, restoredOther.body).toBe(200);
    await settled();
    expect(await runsOf(urgent.id)).toEqual([
      expect.objectContaining({ record_id: matching, event_type: 'record.restored' }),
    ]);
  });

  it('a stored formula entering the condition fires once, in the write’s own event', async () => {
    const big = await automation({
      table_id: fx.orders.id,
      condition: { field: double.id, operator: 'gt', value: 100 },
    });
    const [id] = (await create(fx.orders.id, [
      { [F('title')]: 'Công thức', [F('amount')]: 10 },
    ])) as [Id<'rec'>];
    await settled();
    expect(await runsOf(big.id)).toEqual([]);
    await patch(fx.orders.id, id, { [F('amount')]: 60 });
    await patch(fx.orders.id, id, { [F('amount')]: 70 });
    const runs = await runsOf(big.id);
    expect(runs).toEqual([
      expect.objectContaining({ record_id: id, event_type: 'record.updated' }),
    ]);
  });

  it('a stored lookup recomputed past a threshold (T509 event) fires once', async () => {
    const schema = t.app.get(SchemaService);
    const scope = orgScope(fx.orgId);
    const context = systemAuditContext();
    const { table: shops } = await schema.createTable(
      scope,
      { baseId: fx.baseId, name: 'Shops', primaryFieldName: 'name' },
      context,
    );
    const { table: sales } = await schema.createTable(
      scope,
      { baseId: fx.baseId, name: 'Sales', primaryFieldName: 'ref' },
      context,
    );
    const value = await schema.addField(
      scope,
      sales.id,
      { name: 'value', type: 'number', options: {} },
      context,
    );
    const link = fieldOf(
      await fx.call('u_admin', 'POST', `/tables/${sales.id}/fields`, {
        name: 'shop',
        type: 'link',
        options: { link_table: shops.id },
      }),
    );
    const total = fieldOf(
      await fx.call('u_admin', 'POST', `/tables/${shops.id}/fields`, {
        name: 'total',
        type: 'lookup',
        options: {
          from: sales.id,
          select: value.id,
          where: { field: link.id, operator: 'intersects', value: { field_ref: '__id' } },
          aggregate: 'sum',
        },
      }),
    );
    expect(total).toMatchObject({ compute_mode: 'stored' });
    const [shop] = (await create(shops.id, [{ [shops.primary_field_id as string]: 'S1' }])) as [
      Id<'rec'>,
    ];
    await settled();
    const over = await automation({
      table_id: shops.id,
      condition: { field: total.id, operator: 'gte', value: 100 },
    });
    const sale = (amount: number) => ({
      [sales.primary_field_id as string]: `R${String(amount)}`,
      [value.id]: amount,
      [link.id]: [shop],
    });
    await create(sales.id, [sale(60)]);
    await settled();
    expect(await runsOf(over.id)).toEqual([]);
    // 60 + 50 ≥ 100: the shop enters through its recomputed total.
    await create(sales.id, [sale(50)]);
    await settled();
    // Still above: no second run.
    await create(sales.id, [sale(5)]);
    await settled();
    const runs = await runsOf(over.id);
    expect(runs).toEqual([
      expect.objectContaining({ record_id: shop, event_type: 'record.updated' }),
    ]);
    const [event] = (
      await sql<{ payload: Record<string, unknown> }>`
        SELECT payload FROM meta.events WHERE id = ${runs[0]?.trigger_event_id ?? ''}
      `.execute(db.kysely)
    ).rows;
    expect(event?.payload).toMatchObject({
      via: { computed_recompute: true },
      changes: { [total.id]: { from: 60, to: 110 } },
    });
  });

  it('a paste of 500 matching records is bulk: skip_bulk skips it, otherwise the fan-out cap applies', async () => {
    const always = await automation({
      table_id: fx.tickets.id,
      condition: { field: priority.id, operator: 'is', value: opt.urgent },
    });
    const skipBulk = await automation({
      table_id: fx.tickets.id,
      condition: { field: priority.id, operator: 'is', value: opt.urgent },
      skip_bulk: true,
    });
    await create(
      fx.tickets.id,
      Array.from({ length: 500 }, (_, i) => ticket(`Dán ${String(i)}`, 'urgent')),
    );
    await settled(300_000);
    expect(await runsOf(skipBulk.id)).toEqual([]);
    const runs = await runsOf(always.id);
    expect(runs.filter((run) => run.status !== 'skipped')).toHaveLength(MAX_RUNS_PER_BATCH);
    const skipped = runs.filter((run) => run.status === 'skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.error).toMatchObject({
      code: 'batch_fanout_exceeded',
      limit: MAX_RUNS_PER_BATCH,
      skipped: 500 - MAX_RUNS_PER_BATCH,
    });
    // One trigger unit (the paste): the breaker is not tripped.
    expect(new Set(runs.map((run) => run.trigger_unit)).size).toBe(1);
    expect(
      automationSchema.parse((await fx.call('u_admin', 'GET', `/automations/${always.id}`)).json()),
    ).toMatchObject({ enabled: true, disabled_reason: null });
  }, 600_000);

  it('evaluates as run_as: records outside its read rule and fields it cannot read start nothing', async () => {
    const onStatus = await automation({
      table_id: fx.orders.id,
      condition: { field: F('status'), operator: 'is', value: opt.ordersDone },
    });
    // u_sales1 reads `cost` nowhere (no_perm).
    const onCost = await automation({
      table_id: fx.orders.id,
      condition: { field: F('cost'), operator: 'gt', value: 10 },
    });
    // What take-over by u_sales1 would leave (P32 is T502's): run_as = u_sales1.
    await db.kysely
      .updateTable('meta.automations')
      .set({ run_as_user_id: fx.users.u_sales1.id })
      .where('id', 'in', [onStatus.id, onCost.id])
      .execute();
    const [mine, others] = (await create(fx.orders.id, [
      { [F('title')]: 'Của sales1', [F('owner')]: [{ id: fx.users.u_sales1.id }] },
      { [F('title')]: 'Của admin', [F('owner')]: [{ id: fx.users.u_admin.id }] },
    ])) as [Id<'rec'>, Id<'rec'>];
    await settled();
    for (const id of [mine, others]) {
      await patch(fx.orders.id, id, { [F('status')]: opt.ordersDone, [F('cost')]: 50 });
    }
    expect(await runsOf(onStatus.id)).toEqual([
      expect.objectContaining({ record_id: mine, event_type: 'record.updated' }),
    ]);
    expect(await runsOf(onCost.id)).toEqual([]);
  });

  it('loop guard: an event caused by the automation itself does not start it again', async () => {
    const urgent = await automation({
      table_id: fx.tickets.id,
      condition: { field: priority.id, operator: 'is', value: opt.urgent },
    });
    const [id] = (await create(fx.tickets.id, [ticket('Vòng lặp', 'normal')])) as [Id<'rec'>];
    await settled();
    await db.withTx((tx) =>
      emit(tx, {
        type: 'record.updated',
        organizationId: fx.orgId,
        baseId: fx.baseId,
        tableId: fx.tickets.id,
        entityId: id,
        actor: { type: 'automation', id: urgent.id },
        changes: { [priority.id]: { from: [opt.normal], to: [opt.urgent] } },
        causation: {
          root_event_id: 'evt_Root000000000001',
          depth: 1,
          automation_chain: [urgent.id],
        },
      }),
    );
    await settled();
    expect(await runsOf(urgent.id)).toEqual([]);
  });
});
