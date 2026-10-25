import { automationSchema, type AutomationDto, type Id } from '@cellhive/contracts';
import { automationWaitJobKey, type Db } from '@cellhive/server-core';
import { createWorker, type WorkerHandle } from '@cellhive/worker';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { buildRecordFixture, type RecordFixture } from './record-fixture.js';
import { captureLogger, startTestApp, type TestApp } from './support.js';

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
  readonly trigger_unit: string;
  readonly error: Record<string, unknown> | null;
}

/**
 * BACKLOG T506 through the real API and worker: the SLA scenario of SPEC
 * §24 (`delay` + `recheck_condition`; the wait is shortened by moving the
 * end of the delay and its job to now — no real sleep), turning the
 * automation off while a run waits, and `update_records` whose writes are
 * bulk for the automations downstream (`skip_bulk`, causation, trigger
 * unit = the run).
 */
describe('delay and update_records end to end (T506)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let worker: WorkerHandle;
  const created: Id<'aut'>[] = [];

  const F = (name: string) => fx.fld[name]?.id as Id<'fld'>;

  async function automation(definition: object, name = 'T506'): Promise<AutomationDto> {
    const response = await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/automations`, {
      name,
      enabled: true,
      definition,
    });
    expect(response.statusCode, response.body).toBe(201);
    const dto = automationSchema.parse(response.json());
    created.push(dto.id);
    return dto;
  }

  async function createOrder(fields: Record<string, unknown>): Promise<Id<'rec'>> {
    const response = await fx.call(
      'u_admin',
      'POST',
      `/tables/${fx.orders.id}/records?field_key_type=id`,
      { records: [{ fields }] },
    );
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ records: { id: Id<'rec'> }[] }>().records[0]?.id as Id<'rec'>;
  }

  async function patchOrder(id: Id<'rec'>, fields: Record<string, unknown>): Promise<void> {
    const response = await fx.call(
      'u_admin',
      'PATCH',
      `/tables/${fx.orders.id}/records?field_key_type=id`,
      { records: [{ id, fields }] },
    );
    expect(response.statusCode, response.body).toBe(200);
  }

  async function amountOf(id: Id<'rec'>): Promise<unknown> {
    const response = await fx.call(
      'u_admin',
      'GET',
      `/tables/${fx.orders.id}/records/${id}?field_key_type=id`,
    );
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ fields: Record<string, unknown> }>().fields[F('amount')] ?? null;
  }

  async function runsOf(id: Id<'aut'>): Promise<RunRow[]> {
    const { rows } = await sql<RunRow>`
      SELECT id, status, depth, trigger_unit, error FROM meta.automation_runs
       WHERE automation_id = ${id} ORDER BY created_at, id
    `.execute(db.kysely);
    return rows;
  }

  const runIn = (id: Id<'aut'>, status: string) =>
    eventually(async () => (await runsOf(id)).find((row) => row.status === status), status);

  /** The delay is over: its end and its job are moved to now (instead of waiting a minute). */
  async function fastForward(runId: Id<'run'>): Promise<void> {
    await sql`
      UPDATE meta.automation_run_steps
         SET output = jsonb_set(output, '{until}', to_jsonb(${new Date(Date.now() - 1_000).toISOString()}::text))
       WHERE run_id = ${runId} AND status = 'waiting'
    `.execute(db.kysely);
    await sql`
      UPDATE graphile_worker._private_jobs SET run_at = now() WHERE key = ${automationWaitJobKey(runId)}
    `.execute(db.kysely);
  }

  async function settled(): Promise<void> {
    await eventually(async () => {
      const { rows } = await sql<{ events: number; runs: number }>`
        SELECT (SELECT count(*)::int FROM meta.events WHERE dispatched_at IS NULL) AS events,
               (SELECT count(*)::int FROM meta.automation_runs
                 WHERE status IN ('queued', 'running')
                   AND automation_id = ANY(${[...created]}::text[])) AS runs
      `.execute(db.kysely);
      return rows[0]?.events === 0 && rows[0].runs === 0;
    }, 'events dispatched and runs settled');
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

  const sla = () => ({
    trigger: { type: 'record.created', table_id: fx.orders.id },
    actions: [
      {
        id: 'act_wait',
        type: 'delay',
        config: {
          minutes: 1,
          recheck_condition: { field: F('status'), operator: 'is_not', value: 'Xong' },
        },
      },
      {
        id: 'act_late',
        type: 'update_record',
        config: { table_id: fx.orders.id, fields: { [F('amount')]: { literal: 999 } } },
      },
    ],
  });

  it('SLA (SPEC §24): done before the deadline → the run ends skipped, the late step never runs', async () => {
    const flow = await automation(sla(), 'SLA');
    const order = await createOrder({ [F('title')]: 'SLA done', [F('status')]: 'Mới' });
    const waiting = await runIn(flow.id, 'waiting');
    await patchOrder(order, { [F('status')]: 'Xong' });
    await fastForward(waiting.id);
    const skipped = await runIn(flow.id, 'skipped');
    expect(skipped.error).toEqual({ code: 'recheck_not_matched', step: 'act_wait' });
    expect(await amountOf(order)).toBeNull();
  });

  it('SLA (SPEC §24): still open at the deadline → the run goes on', async () => {
    const flow = await automation(sla(), 'SLA open');
    const order = await createOrder({ [F('title')]: 'SLA late', [F('status')]: 'Mới' });
    const waiting = await runIn(flow.id, 'waiting');
    await fastForward(waiting.id);
    await runIn(flow.id, 'succeeded');
    expect(await amountOf(order)).toBe(999);
  });

  it('turning the automation off while a run waits cancels it', async () => {
    const flow = await automation(sla(), 'SLA off');
    const order = await createOrder({ [F('title')]: 'SLA off', [F('status')]: 'Mới' });
    const waiting = await runIn(flow.id, 'waiting');
    const response = await fx.call('u_admin', 'POST', `/automations/${flow.id}/disable`);
    expect(response.statusCode, response.body).toBe(200);
    expect((await runsOf(flow.id))[0]).toMatchObject({
      id: waiting.id,
      status: 'cancelled',
      error: { code: 'automation_disabled' },
    });
    await fastForward(waiting.id);
    // The resume job runs and does nothing.
    await eventually(async () => {
      const { rows } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM graphile_worker._private_jobs
         WHERE key = ${automationWaitJobKey(waiting.id)}
      `.execute(db.kysely);
      return rows[0]?.n === 0;
    }, 'resume job done');
    expect((await runsOf(flow.id))[0]?.status).toBe('cancelled');
    expect(await amountOf(order)).toBeNull();
  });

  it('update_records writes in bulk: skip_bulk automations ignore it, others chain one level deeper', async () => {
    const orders = await Promise.all(
      ['Chain 1', 'Chain 2', 'Chain 3'].map((title) =>
        createOrder({ [F('title')]: title, [F('status')]: 'Mới' }),
      ),
    );
    const bulk = await automation(
      {
        trigger: { type: 'record.created', table_id: fx.customers.id },
        actions: [
          {
            id: 'act_many',
            type: 'update_records',
            config: {
              table_id: fx.orders.id,
              filter: { field: F('title'), operator: 'starts_with', value: 'Chain ' },
              fields: { [F('amount')]: { literal: 5 } },
            },
          },
        ],
      },
      'Bulk',
    );
    const watch = (skipBulk: boolean) => ({
      trigger: {
        type: 'record.updated',
        table_id: fx.orders.id,
        watch_fields: [F('amount')],
        skip_bulk: skipBulk,
      },
      actions: [
        {
          id: 'act_note',
          type: 'update_record',
          config: { table_id: fx.orders.id, fields: { [F('cost')]: { literal: 1 } } },
        },
      ],
    });
    const skipping = await automation(watch(true), 'Skip bulk');
    const following = await automation(watch(false), 'Follow bulk');

    const response = await fx.call(
      'u_admin',
      'POST',
      `/tables/${fx.customers.id}/records?field_key_type=id`,
      { records: [{ fields: { [F('customerName')]: 'Kick' } }] },
    );
    expect(response.statusCode, response.body).toBe(201);
    const [bulkRun] = await eventually(async () => {
      const runs = await runsOf(bulk.id);
      return runs[0]?.status === 'succeeded' ? runs : undefined;
    }, 'bulk run');
    await settled();
    for (const id of orders) expect(await amountOf(id)).toBe(5);
    expect(await runsOf(skipping.id)).toEqual([]);
    const followed = await runsOf(following.id);
    expect(followed).toHaveLength(3);
    for (const row of followed) {
      // One trigger unit for the whole batch (ADR-26 §5), one level deeper (SPEC §11.6).
      expect(row).toMatchObject({ status: 'succeeded', depth: 1, trigger_unit: bulkRun?.id });
    }
  });
});
