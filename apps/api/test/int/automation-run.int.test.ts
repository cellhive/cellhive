import { automationSchema, newId, type AutomationDto, type Id } from '@cellhive/contracts';
import {
  AutomationsRepository,
  orgScope,
  toEventDocument,
  type Db,
  type EventDocument,
  type JsonObject,
} from '@cellhive/server-core';
import { createWorker, type WorkerHandle } from '@cellhive/worker';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { buildRecordFixture, type FixtureUser, type RecordFixture } from './record-fixture.js';
import { captureLogger, startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

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
  readonly depth: number;
  readonly error: Record<string, unknown> | null;
  readonly trigger_event_id: Id<'evt'> | null;
}

interface StepRow {
  readonly action_id: string;
  readonly status: string;
  readonly attempt: number;
  readonly idempotency_key: string;
  readonly output: Record<string, unknown> | null;
  readonly error: Record<string, unknown> | null;
}

/**
 * BACKLOG T505 through the real API and worker: `events.dispatch` queues a
 * run, `automation.run` executes it — record actions as `run_as` with
 * `actor_type = automation`, `via`, `batch_id = run_…` and causation one
 * level deeper (the loop guard stops a ping-pong), `if` branches, templates
 * reading the trigger data and earlier step records, P29 (a record outside
 * `run_as`'s rules fails the run, the automation stays on), `find_records`
 * never returning a field `run_as` cannot read, `REGEX*` refused at run
 * time, and `automation.run.succeeded|failed` events.
 */
describe('automation run engine end to end (T505)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let worker: WorkerHandle;
  const created: Id<'aut'>[] = [];

  const F = (name: string) => fx.fld[name]?.id as Id<'fld'>;
  const call = (
    user: FixtureUser,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
  ) => fx.call(user, method, url, payload);

  async function automation(definition: object, name = 'Run test'): Promise<AutomationDto> {
    const response = await call('u_admin', 'POST', `/bases/${fx.baseId}/automations`, {
      name,
      enabled: true,
      definition,
    });
    expect(response.statusCode, response.body).toBe(201);
    const dto = automationSchema.parse(response.json());
    created.push(dto.id);
    return dto;
  }

  /** An automation stored as is (another `run_as`, or a definition saved before a rule). */
  async function storedAutomation(
    definition: Record<string, unknown>,
    runAs: FixtureUser,
  ): Promise<Id<'aut'>> {
    const id = newId('aut');
    const trigger = definition['trigger'] as { type: string; table_id: Id<'tbl'> };
    await new AutomationsRepository(db).insert(orgScope(fx.orgId), {
      id,
      baseId: fx.baseId,
      name: id,
      description: '',
      enabled: true,
      definition: definition as JsonObject,
      triggerType: trigger.type,
      triggerTableId: trigger.table_id,
      // `run_as` is the creator.
      createdBy: fx.users[runAs].id,
    });
    created.push(id);
    return id;
  }

  /** Every event dispatched and every run of `automationIds` finished. */
  async function settled(automationIds: readonly Id<'aut'>[] = created): Promise<void> {
    await eventually(async () => {
      const { rows } = await sql<{ events: number; runs: number }>`
        SELECT (SELECT count(*)::int FROM meta.events WHERE dispatched_at IS NULL) AS events,
               (SELECT count(*)::int FROM meta.automation_runs
                 WHERE status IN ('queued', 'running')
                   AND automation_id = ANY(${[...automationIds]}::text[])) AS runs
      `.execute(db.kysely);
      return rows[0]?.events === 0 && rows[0].runs === 0;
    }, 'events dispatched and runs finished');
  }

  async function runsOf(id: Id<'aut'>): Promise<RunRow[]> {
    const { rows } = await sql<RunRow>`
      SELECT id, status, depth, error, trigger_event_id FROM meta.automation_runs
       WHERE automation_id = ${id} ORDER BY created_at, id
    `.execute(db.kysely);
    return rows;
  }

  async function stepsOf(runId: Id<'run'>): Promise<StepRow[]> {
    const { rows } = await sql<StepRow>`
      SELECT action_id, status, attempt, idempotency_key, output, error
        FROM meta.automation_run_steps WHERE run_id = ${runId} ORDER BY created_at, id
    `.execute(db.kysely);
    return rows;
  }

  async function createOrder(fields: Record<string, unknown>): Promise<Id<'rec'>> {
    const response = await call(
      'u_admin',
      'POST',
      `/tables/${fx.orders.id}/records?field_key_type=id`,
      {
        records: [{ fields }],
      },
    );
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ records: { id: Id<'rec'> }[] }>().records[0]?.id as Id<'rec'>;
  }

  async function recordOf(
    tableId: Id<'tbl'>,
    recordId: Id<'rec'>,
  ): Promise<Record<string, unknown>> {
    const response = await call(
      'u_admin',
      'GET',
      `/tables/${tableId}/records/${recordId}?field_key_type=id`,
    );
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ fields: Record<string, unknown> }>().fields;
  }

  async function eventsOf(entityId: string): Promise<EventDocument[]> {
    const rows = await db.kysely
      .selectFrom('meta.events')
      .selectAll()
      .where('entity_id', '=', entityId)
      .orderBy('created_at')
      .execute();
    return rows.map((row) => toEventDocument(row));
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    fx = await buildRecordFixture(t, db);
    worker = await createWorker(t.config, { logger: captureLogger().logger, pollIntervalMs: 50 });
  });

  afterEach(async () => {
    await settled();
    for (const id of created.splice(0)) {
      await db.kysely
        .updateTable('meta.automations')
        .set({ enabled: false })
        .where('id', '=', id)
        .execute();
    }
  });

  afterAll(async () => {
    await worker.close();
    await t.close();
    await db.destroy();
    await database.drop();
  });

  it('creates, finds, branches and updates as run_as, with step references in templates', async () => {
    const flow = await automation({
      trigger: { type: 'record.created', table_id: fx.orders.id },
      actions: [
        {
          id: 'act_new',
          type: 'create_record',
          config: {
            table_id: fx.customers.id,
            fields: {
              [F('customerName')]: { template: `KH {{ [${F('title')}] }}` },
              [F('customerCode')]: { literal: 'RUN-1' },
            },
          },
        },
        {
          id: 'act_find',
          type: 'find_records',
          config: {
            table_id: fx.customers.id,
            filter: { field: F('customerCode'), operator: 'eq', value: 'RUN-1' },
            fields: [F('customerName')],
          },
        },
        {
          id: 'act_if',
          type: 'if',
          config: {
            conditions: [
              {
                value: { step: 'act_find', path: 'count' },
                operator: 'gte',
                compare: { literal: 1 },
              },
              { filter: { field: F('amount'), operator: 'is_empty' } },
            ],
            then: [
              {
                id: 'act_upd',
                type: 'update_record',
                config: {
                  table_id: fx.orders.id,
                  fields: {
                    [F('title')]: {
                      template:
                        `{{ [act_new].[${F('customerName')}] }} | {{ [act_new].[@url] }} | ` +
                        '{{ [act_find].[@id] = [act_new].[@id] }} | {{ YEAR([@fired_at]) }}',
                    },
                    [F('amount')]: { literal: 42 },
                  },
                },
              },
            ],
            else: [
              {
                id: 'act_else',
                type: 'update_record',
                config: { table_id: fx.orders.id, fields: { [F('cost')]: { literal: 1 } } },
              },
            ],
          },
        },
      ],
    });
    const orderId = await createOrder({ [F('title')]: 'Đơn A' });
    await settled();

    const [run] = await runsOf(flow.id);
    expect(run).toMatchObject({ status: 'succeeded', error: null, depth: 0 });
    const steps = await stepsOf(run?.id as Id<'run'>);
    expect(steps.map((step) => [step.action_id, step.status, step.attempt])).toEqual([
      ['act_new', 'succeeded', 1],
      ['act_find', 'succeeded', 1],
      ['act_if', 'succeeded', 1],
      ['act_upd', 'succeeded', 1],
    ]);
    const triggerEvent = run?.trigger_event_id;
    expect(steps[0]?.idempotency_key).toBe(`${flow.id}:${String(triggerEvent)}:act_new`);
    const customerId = steps[0]?.output?.['id'] as Id<'rec'>;
    expect(steps[1]?.output).toMatchObject({
      records: [{ id: customerId, fields: { [F('customerName')]: 'KH Đơn A' } }],
      count: 1,
      truncated: false,
    });
    expect(steps[2]?.output).toMatchObject({ result: true, branch: 'then' });

    expect(await recordOf(fx.customers.id, customerId)).toMatchObject({
      [F('customerName')]: 'KH Đơn A',
      [F('customerCode')]: 'RUN-1',
    });
    const year = new Date().getUTCFullYear();
    expect(await recordOf(fx.orders.id, orderId)).toMatchObject({
      [F('title')]:
        `KH Đơn A | ${TEST_PUBLIC_URL}/b/${fx.baseId}/t/${fx.customers.id}?record=${customerId} | ` +
        `TRUE | ${String(year)}`,
      [F('amount')]: 42,
    });

    // Writes of the run: actor automation, via, batch = run, causation one level deeper.
    const [rootEvent] = await eventsOf(orderId);
    const updated = (await eventsOf(orderId)).find((event) => event.type === 'record.updated');
    expect(updated).toMatchObject({
      actor: { type: 'automation', id: flow.id },
      via: { automation_id: flow.id, run_id: run?.id },
      batch: { id: run?.id, size: 1 },
      causation: {
        root_event_id: rootEvent?.id,
        depth: 1,
        automation_chain: [flow.id],
      },
    });
    const { rows: audits } = await sql<{ actor_type: string; batch_id: string; via: unknown }>`
      SELECT actor_type, batch_id, via FROM meta.audit_logs
       WHERE entity_id = ${customerId} AND action = 'record.created'
    `.execute(db.kysely);
    expect(audits).toEqual([
      {
        actor_type: 'automation',
        batch_id: run?.id,
        via: { automation_id: flow.id, run_id: run?.id },
      },
    ]);
    const [done] = await eventsOf(run?.id as string);
    expect(done).toMatchObject({
      type: 'automation.run.succeeded',
      entity_type: 'automation_run',
      actor: { type: 'automation', id: flow.id },
      data: { automation_id: flow.id, status: 'succeeded', error_code: null, steps: 4 },
    });
  });

  it('if on_false stop ends the run succeeded; else with no action runs nothing', async () => {
    const guard = (onFalse: 'stop' | 'else') =>
      automation({
        trigger: { type: 'record.created', table_id: fx.orders.id },
        actions: [
          {
            id: 'act_if',
            type: 'if',
            config: {
              match: 'or',
              conditions: [
                { value: { field: F('amount') }, operator: 'gt', compare: { literal: 100 } },
              ],
              on_false: onFalse,
              then: [
                {
                  id: 'act_then',
                  type: 'update_record',
                  config: { table_id: fx.orders.id, fields: { [F('cost')]: { literal: 1 } } },
                },
              ],
            },
          },
          {
            id: 'act_after',
            type: 'update_record',
            config: { table_id: fx.orders.id, fields: { [F('cost')]: { literal: 7 } } },
          },
        ],
      });
    const stop = await guard('stop');
    const otherwise = await guard('else');
    const orderId = await createOrder({ [F('title')]: 'Nhỏ', [F('amount')]: 5 });
    await settled();
    const [stopped] = await runsOf(stop.id);
    expect(stopped?.status).toBe('succeeded');
    expect((await stepsOf(stopped?.id as Id<'run'>)).map((step) => step.action_id)).toEqual([
      'act_if',
    ]);
    const [elsed] = await runsOf(otherwise.id);
    expect(elsed?.status).toBe('succeeded');
    expect((await stepsOf(elsed?.id as Id<'run'>)).map((step) => step.action_id)).toEqual([
      'act_if',
      'act_after',
    ]);
    expect((await recordOf(fx.orders.id, orderId))[F('cost')]).toBe(7);
  });

  it('[@actor] and [@previous] come from the trigger event (T521 follow-up)', async () => {
    const watched = await automation({
      trigger: { type: 'record.updated', table_id: fx.orders.id, watch_fields: [F('amount')] },
      actions: [
        {
          id: 'act_note',
          type: 'update_record',
          config: {
            table_id: fx.orders.id,
            fields: {
              [F('title')]: {
                template: `{{ [@actor] }}: {{ [@previous].[${F('amount')}] }} → {{ [${F('amount')}] }}`,
              },
            },
          },
        },
      ],
    });
    const orderId = await createOrder({ [F('title')]: 'Đơn', [F('amount')]: 5 });
    await settled();
    const response = await call(
      'u_admin',
      'PATCH',
      `/tables/${fx.orders.id}/records/${orderId}?field_key_type=id`,
      { fields: { [F('amount')]: 9 } },
    );
    expect(response.statusCode, response.body).toBe(200);
    await settled();
    const [run] = await runsOf(watched.id);
    expect(run?.status).toBe('succeeded');
    expect((await recordOf(fx.orders.id, orderId))[F('title')]).toBe('User admin: 5 → 9');
  });

  it('the loop guard stops a ping-pong between two automations writing each other', async () => {
    const ping = await automation(
      {
        trigger: { type: 'record.updated', table_id: fx.orders.id, watch_fields: [F('amount')] },
        actions: [
          {
            id: 'act_1',
            type: 'update_record',
            config: {
              table_id: fx.orders.id,
              fields: { [F('cost')]: { template: `{{ [${F('amount')}] + 1 }}` } },
            },
          },
        ],
      },
      'Ping',
    );
    const pong = await automation(
      {
        trigger: { type: 'record.updated', table_id: fx.orders.id, watch_fields: [F('cost')] },
        actions: [
          {
            id: 'act_1',
            type: 'update_record',
            config: {
              table_id: fx.orders.id,
              fields: { [F('amount')]: { template: `{{ [${F('cost')}] + 1 }}` } },
            },
          },
        ],
      },
      'Pong',
    );
    const orderId = await createOrder({ [F('title')]: 'Bóng' });
    const response = await call(
      'u_admin',
      'PATCH',
      `/tables/${fx.orders.id}/records/${orderId}?field_key_type=id`,
      {
        fields: { [F('amount')]: 1 },
      },
    );
    expect(response.statusCode, response.body).toBe(200);
    await settled();
    // ping (depth 0) → pong (depth 1) → ping already in the chain: stops.
    expect((await runsOf(ping.id)).map((run) => [run.status, run.depth])).toEqual([
      ['succeeded', 0],
    ]);
    expect((await runsOf(pong.id)).map((run) => [run.status, run.depth])).toEqual([
      ['succeeded', 1],
    ]);
    expect(await recordOf(fx.orders.id, orderId)).toMatchObject({
      [F('amount')]: 3,
      [F('cost')]: 2,
    });
  });

  it('P29: a record outside the edit rule of run_as fails the run, the automation stays on', async () => {
    const r1 = await createOrder({
      [F('title')]: 'r1',
      [F('owner')]: [{ id: fx.users.u_sales1.id }],
    });
    const r2 = await createOrder({
      [F('title')]: 'r2',
      [F('owner')]: [{ id: fx.users.u_sales2.id }],
    });
    await settled();
    const id = await storedAutomation(
      {
        trigger: {
          type: 'record.updated',
          table_id: fx.orders.id,
          watch_fields: [F('title')],
          skip_bulk: false,
        },
        condition: null,
        actions: [
          {
            id: 'act_1',
            type: 'update_record',
            config: {
              table_id: fx.orders.id,
              record_id: null,
              fields: { [F('amount')]: { literal: 9 } },
            },
          },
        ],
      },
      'u_sales1',
    );
    for (const recordId of [r1, r2]) {
      const response = await call(
        'u_admin',
        'PATCH',
        `/tables/${fx.orders.id}/records/${recordId}?field_key_type=id`,
        {
          fields: { [F('title')]: 'sửa' },
        },
      );
      expect(response.statusCode, response.body).toBe(200);
    }
    await settled([id]);
    const runs = await runsOf(id);
    expect(runs.map((run) => run.status).sort()).toEqual(['failed', 'succeeded']);
    const failed = runs.find((run) => run.status === 'failed');
    expect(failed?.error).toMatchObject({
      code: 'permission_denied',
      step: 'act_1',
      params: { scope: 'record' },
    });
    expect(JSON.stringify(failed?.error)).not.toContain('r2');
    expect((await recordOf(fx.orders.id, r1))[F('amount')]).toBe(9);
    expect((await recordOf(fx.orders.id, r2))[F('amount')]).not.toBe(9);
    const { rows } = await sql<{ enabled: boolean; disabled_reason: string | null }>`
      SELECT enabled, disabled_reason FROM meta.automations WHERE id = ${id}
    `.execute(db.kysely);
    expect(rows[0]).toEqual({ enabled: true, disabled_reason: null });
    const [failedEvent] = await eventsOf(failed?.id as string);
    expect(failedEvent).toMatchObject({
      type: 'automation.run.failed',
      data: { error_code: 'permission_denied', step: 'act_1' },
    });
  });

  it('find_records never returns a field run_as cannot read; a lost table fails as permission_denied', async () => {
    const r1 = await createOrder({
      [F('title')]: 'r1 tìm',
      [F('cost')]: 77,
      [F('owner')]: [{ id: fx.users.u_sales1.id }],
    });
    await createOrder({ [F('title')]: 'r2 tìm', [F('owner')]: [{ id: fx.users.u_sales2.id }] });
    await settled();
    const id = await storedAutomation(
      {
        trigger: {
          type: 'record.updated',
          table_id: fx.orders.id,
          watch_fields: [F('amount')],
          skip_bulk: false,
        },
        condition: null,
        actions: [
          {
            id: 'act_find',
            type: 'find_records',
            config: {
              table_id: fx.orders.id,
              filter: { field: F('title'), operator: 'contains', value: 'tìm' },
              sort: [],
              fields: [F('title'), F('cost')],
              limit: 50,
            },
          },
          {
            id: 'act_lost',
            type: 'create_record',
            config: {
              table_id: fx.customers.id,
              fields: { [F('customerName')]: { literal: 'x' } },
            },
          },
        ],
      },
      'u_sales1',
    );
    const response = await call(
      'u_admin',
      'PATCH',
      `/tables/${fx.orders.id}/records/${r1}?field_key_type=id`,
      {
        fields: { [F('amount')]: 1 },
      },
    );
    expect(response.statusCode, response.body).toBe(200);
    await settled([id]);
    const [run] = await runsOf(id);
    const [find, lost] = await stepsOf(run?.id as Id<'run'>);
    // Only r1 (read scope `editable`), only `title` (`cost` is no_perm for Sales).
    expect(find?.output).toEqual({
      records: [{ id: r1, fields: { [F('title')]: 'r1 tìm' } }],
      count: 1,
      truncated: false,
    });
    expect(lost).toMatchObject({
      status: 'failed',
      error: { code: 'permission_denied', params: { scope: 'table' } },
    });
    expect(run).toMatchObject({
      status: 'failed',
      error: { code: 'permission_denied', step: 'act_lost' },
    });
  });

  it('REGEX in a stored template: the step fails unsupported_function before any write', async () => {
    const id = await storedAutomation(
      {
        trigger: { type: 'record.created', table_id: fx.orders.id, skip_bulk: false },
        condition: null,
        actions: [
          {
            id: 'act_ok',
            type: 'update_record',
            config: {
              table_id: fx.orders.id,
              record_id: null,
              fields: { [F('cost')]: { literal: 1 } },
            },
          },
          {
            id: 'act_re',
            type: 'update_record',
            config: {
              table_id: fx.orders.id,
              record_id: null,
              fields: { [F('title')]: { template: '{{ REGEXREPLACE("aaaa", "^(a+)+$", "b") }}' } },
            },
          },
        ],
      },
      'u_admin',
    );
    const orderId = await createOrder({ [F('title')]: 'regex' });
    await settled([id]);
    const [run] = await runsOf(id);
    expect(run).toMatchObject({
      status: 'failed',
      error: { code: 'unsupported_function', step: 'act_re', params: { function: 'REGEXREPLACE' } },
    });
    expect(
      (await stepsOf(run?.id as Id<'run'>)).map((step) => [step.action_id, step.status]),
    ).toEqual([['act_re', 'failed']]);
    expect((await recordOf(fx.orders.id, orderId))[F('cost')]).toBeNull();
  });
});
