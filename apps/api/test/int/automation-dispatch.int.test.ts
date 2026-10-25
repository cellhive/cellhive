import { loadavg } from 'node:os';

import {
  automationSchema,
  importUploadSchema,
  jobSchema,
  viewSchema,
  type AutomationDto,
  type Id,
} from '@cellhive/contracts';
import {
  AutomationDispatcher,
  childCausation,
  emit,
  orgScope,
  toEventDocument,
  type Causation,
  type Db,
  type EventDocument,
} from '@cellhive/server-core';
import { buildTaskList, createWorker, type WorkerHandle } from '@cellhive/worker';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { buildRecordFixture, type FixtureUser, type RecordFixture } from './record-fixture.js';
import { captureLogger, startTestApp, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

const BOUNDARY = 'cellhive-dispatch-boundary';

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

interface RunRow {
  readonly id: Id<'run'>;
  readonly status: string;
  readonly trigger_event_id: Id<'evt'> | null;
  readonly trigger_unit: string;
  readonly depth: number;
  readonly automation_version: number;
  readonly error: Record<string, unknown> | null;
  readonly input: Record<string, unknown>;
}

/**
 * BACKLOG T503 acceptance, through the real API and worker: `record.*`
 * events carry `batch`/`via`; `events.dispatch` creates `queued` runs for
 * matching automations (type + table, `watch_fields`, `form.submitted` by
 * view), skips bulk changes with `skip_bulk`, evaluates `changed*` on the
 * event and the rest on the latest record as `run_as`, stops loops
 * (depth 3, own chain), caps the fan-out per batch (1 000 runs + one
 * `skipped` run) and trips the circuit breaker beyond 100 units a minute.
 * Runs stay `queued`: the run engine (T505) is left out of this worker.
 */
describe('automation dispatch (T503)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let worker: WorkerHandle;
  const created: Id<'aut'>[] = [];
  let opt: { new: string; done: string };

  const F = (name: string) => fx.fld[name]?.id as Id<'fld'>;

  async function call(
    user: FixtureUser,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
    headers?: Record<string, string>,
  ): Promise<LightMyRequestResponse> {
    return fx.call(user, method, url, payload, headers);
  }

  async function automation(definition: object, name = 'Dispatch test'): Promise<AutomationDto> {
    const response = await call('u_admin', 'POST', `/bases/${fx.baseId}/automations`, {
      name,
      enabled: true,
      definition: {
        ...definition,
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

  /** Every event dispatched (the worker runs `events.dispatch` in the background). */
  async function settled(timeoutMs = 60_000): Promise<void> {
    await eventually(
      async () => {
        const { rows } = await sql<{ n: number }>`
          SELECT count(*)::int AS n FROM meta.events WHERE dispatched_at IS NULL
        `.execute(db.kysely);
        return rows[0]?.n === 0;
      },
      'every event to be dispatched',
      timeoutMs,
    );
  }

  async function runsOf(id: Id<'aut'>): Promise<RunRow[]> {
    const { rows } = await sql<RunRow>`
      SELECT id, status, trigger_event_id, trigger_unit, depth, automation_version, error, input
        FROM meta.automation_runs WHERE automation_id = ${id}
       ORDER BY created_at, id
    `.execute(db.kysely);
    return rows;
  }

  async function createOrders(titles: string[]): Promise<Id<'rec'>[]> {
    const response = await call(
      'u_admin',
      'POST',
      `/tables/${fx.orders.id}/records?field_key_type=id`,
      {
        records: titles.map((title) => ({ fields: { [F('title')]: title } })),
      },
    );
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ records: { id: Id<'rec'> }[] }>().records.map((record) => record.id);
  }

  async function recordEvents(recordId: Id<'rec'>): Promise<EventDocument[]> {
    const rows = await db.kysely
      .selectFrom('meta.events')
      .selectAll()
      .where('entity_id', '=', recordId)
      .orderBy('created_at')
      .execute();
    return rows.map((row) => toEventDocument(row));
  }

  /** Users notified of `type` about automation `id` (T511 fan-out, run by the worker). */
  async function notified(type: string, id: Id<'aut'>): Promise<string[]> {
    return eventually(async () => {
      const { rows } = await sql<{ user_id: string }>`
          SELECT user_id FROM meta.notifications
           WHERE type = ${type} AND entity_id = ${id} ORDER BY user_id
        `.execute(db.kysely);
      return rows.length > 0 ? rows.map((row) => row.user_id) : undefined;
    }, `${type} notifications`);
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    fx = await buildRecordFixture(t, db);
    const options = (fx.fld.status?.options as { options: { id: string; name: string }[] }).options;
    opt = {
      new: options.find((option) => option.name === 'Mới')?.id ?? '',
      done: options.find((option) => option.name === 'Xong')?.id ?? '',
    };
    // Runs stay `queued` here: the engine (T505) has its own tests (automation-run*).
    const { logger } = captureLogger();
    const taskList = Object.fromEntries(
      Object.entries(buildTaskList({ config: t.config, db, logger })).filter(
        ([name]) => name !== 'automation.run',
      ),
    );
    worker = await createWorker(t.config, { logger, pollIntervalMs: 50, taskList });
  });

  afterEach(async () => {
    // Earlier automations must not answer the next test's events.
    await settled();
    for (const id of created.splice(0)) {
      await call('u_admin', 'POST', `/automations/${id}/disable`);
    }
  });

  afterAll(async () => {
    await worker.close();
    await t.close();
    await db.destroy();
    await database.drop();
  });

  it('a single record: batch { req, 1 }, one queued run per matching automation, job queued', async () => {
    const onCreate = await automation({
      trigger: { type: 'record.created', table_id: fx.orders.id },
    });
    const otherTable = await automation({
      trigger: { type: 'record.created', table_id: fx.tickets.id },
    });
    const [id] = await createOrders(['Đơn lẻ']);
    await settled();
    const [event] = await recordEvents(id as Id<'rec'>);
    expect(event).toMatchObject({ type: 'record.created', batch: { size: 1 } });
    expect(event?.batch?.id).toMatch(/^req_/);
    expect(event).not.toHaveProperty('via');

    const runs = await runsOf(onCreate.id);
    expect(runs).toEqual([
      expect.objectContaining({
        status: 'queued',
        trigger_event_id: event?.id,
        trigger_unit: event?.causation.root_event_id,
        depth: 0,
        automation_version: onCreate.version,
      }),
    ]);
    expect(runs[0]?.input).toMatchObject({
      automation_version: onCreate.version,
      definition: { trigger: { type: 'record.created', table_id: fx.orders.id } },
      trigger: { event_id: event?.id, record_id: id, bulk: false, type: 'record.created' },
    });
    expect(await runsOf(otherTable.id)).toEqual([]);
    const { rows: jobs } = await sql<{ payload: { run_id: string } }>`
      SELECT p.payload FROM graphile_worker._private_jobs p
        JOIN graphile_worker._private_tasks t ON t.id = p.task_id
       WHERE t.identifier = 'automation.run'
    `.execute(db.kysely);
    expect(jobs.map((job) => job.payload.run_id)).toContain(runs[0]?.id);
  });

  it('two records in one request are a bulk change: skip_bulk skips them, the default runs both', async () => {
    const always = await automation({
      trigger: { type: 'record.created', table_id: fx.orders.id },
    });
    const skipBulk = await automation({
      trigger: { type: 'record.created', table_id: fx.orders.id, skip_bulk: true },
    });
    const ids = await createOrders(['Dán 1', 'Dán 2']);
    await settled();
    const events = (await Promise.all(ids.map(recordEvents))).flat();
    expect(events.map((event) => event.batch?.size)).toEqual([2, 2]);
    expect(new Set(events.map((event) => event.batch?.id)).size).toBe(1);
    const runs = await runsOf(always.id);
    expect(runs).toHaveLength(2);
    // A bulk event's unit is its batch.
    expect(runs.map((run) => run.trigger_unit)).toEqual([
      events[0]?.batch?.id,
      events[0]?.batch?.id,
    ]);
    expect(await runsOf(skipBulk.id)).toEqual([]);

    // One record later: not bulk, the skip_bulk automation runs.
    await createOrders(['Một mình']);
    await settled();
    expect(await runsOf(skipBulk.id)).toHaveLength(1);
  });

  it('a member form submission is one record (not bulk) and starts form.submitted of that form', async () => {
    const form = viewSchema.parse(
      (
        await call('owner', 'POST', `/tables/${fx.orders.id}/views`, {
          name: 'Đặt hàng',
          type: 'form',
        })
      ).json(),
    );
    const otherForm = viewSchema.parse(
      (
        await call('owner', 'POST', `/tables/${fx.orders.id}/views`, { name: 'Khác', type: 'form' })
      ).json(),
    );
    const onForm = await automation({
      trigger: { type: 'form.submitted', view_id: form.id },
      condition: { field: F('title'), operator: 'eq', value: 'Từ form' },
    });
    const onOther = await automation({
      trigger: { type: 'form.submitted', view_id: otherForm.id },
    });
    const skipBulk = await automation({
      trigger: { type: 'record.created', table_id: fx.orders.id, skip_bulk: true },
    });
    for (const title of ['Từ form', 'Khác tiêu đề']) {
      const response = await call('u_admin', 'POST', `/views/${form.id}/submit`, {
        fields: { [F('title')]: title },
      });
      expect(response.statusCode, response.body).toBe(200);
    }
    await settled();
    const runs = await runsOf(onForm.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.input).toMatchObject({ trigger: { type: 'form.submitted' } });
    expect(await runsOf(onOther.id)).toEqual([]);
    expect(await runsOf(skipBulk.id)).toHaveLength(2);
  });

  it('changed_to fires on the transition only, not when another field of a DONE record changes', async () => {
    const [id] = await createOrders(['Chuyển trạng thái']);
    const recordId = id as Id<'rec'>;
    const toDone = await automation({
      trigger: {
        type: 'record.updated',
        table_id: fx.orders.id,
        watch_fields: [F('status'), F('amount')],
      },
      condition: { field: F('status'), operator: 'changed_to', value: opt.done },
    });
    const patch = async (fields: Record<string, unknown>) => {
      const response = await call(
        'u_admin',
        'PATCH',
        `/tables/${fx.orders.id}/records?field_key_type=id`,
        {
          records: [{ id: recordId, fields }],
        },
      );
      expect(response.statusCode, response.body).toBe(200);
      await settled();
    };
    await patch({ [F('status')]: opt.new });
    expect(await runsOf(toDone.id)).toHaveLength(0);
    await patch({ [F('status')]: opt.done });
    expect(await runsOf(toDone.id)).toHaveLength(1);
    // Already DONE: editing the amount (a watched field) does not fire again (SPEC §11.3).
    await patch({ [F('amount')]: 5 });
    await patch({ [F('title')]: 'Đổi tên' });
    expect(await runsOf(toDone.id)).toHaveLength(1);
  });

  it('tests the rest of the condition on the latest record; record.deleted reads the trashed record', async () => {
    const [big, small] = await createOrders(['Lớn', 'Nhỏ']);
    for (const [id, amount] of [
      [big, 1000],
      [small, 1],
    ] as const) {
      const response = await call(
        'u_admin',
        'PATCH',
        `/tables/${fx.orders.id}/records?field_key_type=id`,
        {
          records: [{ id, fields: { [F('amount')]: amount } }],
        },
      );
      expect(response.statusCode, response.body).toBe(200);
    }
    await settled();
    const onDelete = await automation({
      trigger: { type: 'record.deleted', table_id: fx.orders.id },
      condition: { field: F('amount'), operator: 'gte', value: 100 },
    });
    for (const id of [big, small]) {
      const response = await call(
        'u_admin',
        'DELETE',
        `/tables/${fx.orders.id}/records/${String(id)}`,
      );
      expect(response.statusCode, response.body).toBe(204);
    }
    await settled();
    const runs = await runsOf(onDelete.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.input).toMatchObject({ trigger: { record_id: big } });
  });

  it('loop guard: an automation never re-triggers itself, a chain A → B → C → D stops at depth 3', async () => {
    const [id] = await createOrders(['Chuỗi']);
    const recordId = id as Id<'rec'>;
    const watch = (field: string, name: string) =>
      automation(
        { trigger: { type: 'record.updated', table_id: fx.orders.id, watch_fields: [F(field)] } },
        name,
      );
    const a = await watch('title', 'A');
    const b = await watch('amount', 'B');
    const c = await watch('cost', 'C');
    const d = await watch('owner', 'D');
    await settled();
    // What the run engine (T505) will write: each step one level deeper, same root.
    const write = async (field: string, causation: Causation | undefined) =>
      db.withTx((tx) =>
        emit(tx, {
          type: 'record.updated',
          organizationId: fx.orgId,
          baseId: fx.baseId,
          tableId: fx.orders.id,
          entityId: recordId,
          actor:
            causation === undefined
              ? { type: 'user', id: fx.users.u_admin.id }
              : { type: 'automation', id: causation.automation_chain.at(-1) ?? null },
          changes: {
            [F(field)]: { from: null, to: field === 'owner' ? [fx.users.u_admin.id] : 1 },
          },
          ...(causation === undefined ? {} : { causation }),
        }),
      );
    const doc = async (eventId: Id<'evt'>) =>
      toEventDocument(
        await db.kysely
          .selectFrom('meta.events')
          .selectAll()
          .where('id', '=', eventId)
          .executeTakeFirstOrThrow(),
      );
    const e0 = await doc((await write('title', undefined)).id);
    const e1 = await doc((await write('amount', childCausation(e0, a.id))).id);
    const e2 = await doc((await write('cost', childCausation(e1, b.id))).id);
    const e3 = await doc((await write('owner', childCausation(e2, c.id))).id);
    // A writes the field it watches: its own change is not dispatched to it again.
    await write('title', childCausation(e0, a.id));
    await settled();
    expect((await runsOf(a.id)).map((run) => run.trigger_event_id)).toEqual([e0.id]);
    expect(await runsOf(b.id)).toEqual([
      expect.objectContaining({ trigger_event_id: e1.id, depth: 1 }),
    ]);
    expect(await runsOf(c.id)).toEqual([
      expect.objectContaining({ trigger_event_id: e2.id, depth: 2 }),
    ]);
    expect(e3.causation).toMatchObject({ depth: 3, root_event_id: e0.id });
    expect(await runsOf(d.id)).toEqual([]);
    // Every run of the chain counts as the same trigger unit (its root event).
    expect(
      new Set([...(await runsOf(b.id)), ...(await runsOf(c.id))].map((run) => run.trigger_unit)),
    ).toEqual(new Set([e0.id]));
  });

  it('dispatching an event twice creates no second run', async () => {
    const onCreate = await automation({
      trigger: { type: 'record.created', table_id: fx.orders.id },
    });
    const [id] = await createOrders(['Hai lần']);
    await settled();
    const [event] = await recordEvents(id as Id<'rec'>);
    const key = {
      id: event?.id as Id<'evt'>,
      createdAt: (
        await sql<{ at: string }>`
          SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
            FROM meta.events WHERE id = ${event?.id ?? ''}
        `.execute(db.kysely)
      ).rows[0]?.at as string,
    };
    const dispatcher = new AutomationDispatcher(db, {
      defaults: { timeZone: 'UTC', locale: 'en' },
    });
    expect(await dispatcher.dispatch(orgScope(fx.orgId), key)).toMatchObject({
      status: 'redelivered',
    });
    // Even when the dispatched mark is lost, the (automation, event) key holds.
    await sql`UPDATE meta.events SET dispatched_at = NULL WHERE id = ${key.id}`.execute(db.kysely);
    const again = await dispatcher.dispatch(orgScope(fx.orgId), key);
    expect(again).toMatchObject({
      status: 'dispatched',
      automations: [{ automationId: onCreate.id, outcome: 'duplicate' }],
    });
    expect(await runsOf(onCreate.id)).toHaveLength(1);
  });

  it('101 single changes within a minute trip the circuit breaker (event + audit, run_as kept)', async () => {
    const busy = await automation({ trigger: { type: 'record.created', table_id: fx.tickets.id } });
    for (let i = 0; i < 101; i += 1) {
      const response = await call(
        'u_admin',
        'POST',
        `/tables/${fx.tickets.id}/records?field_key_type=id`,
        {
          records: [{ fields: { [F('ticketTitle')]: `Ticket ${String(i)}` } }],
        },
      );
      expect(response.statusCode, response.body).toBe(201);
    }
    await settled();
    expect(await runsOf(busy.id)).toHaveLength(100);
    const after = automationSchema.parse(
      (await call('u_admin', 'GET', `/automations/${busy.id}`)).json(),
    );
    expect(after).toMatchObject({
      enabled: false,
      disabled_reason: 'circuit_breaker',
      run_as: { id: fx.users.u_admin.id },
      version: busy.version + 1,
    });
    const { rows } = await sql<{ action: string; actor_type: string; after: unknown }>`
      SELECT action, actor_type, after FROM meta.audit_logs
       WHERE entity_id = ${busy.id} AND action = 'automation.disabled'
    `.execute(db.kysely);
    expect(rows).toEqual([
      {
        action: 'automation.disabled',
        actor_type: 'system',
        after: { enabled: false, disabled_reason: 'circuit_breaker' },
      },
    ]);
    // run_as + base admins hear about it (T511).
    expect(await notified('automation.disabled', busy.id)).toContain(fx.users.u_admin.id);
    // A manager turns it back on: the reason is cleared.
    const enabled = automationSchema.parse(
      (await call('u_admin', 'POST', `/automations/${busy.id}/enable`)).json(),
    );
    expect(enabled).toMatchObject({ enabled: true, disabled_reason: null });
  });

  it('an import of 5 000 rows: 1 000 runs + one skipped run, skip_bulk none, automation stays on', async () => {
    const capped = await automation({
      trigger: { type: 'record.created', table_id: fx.orders.id },
    });
    const skipBulk = await automation({
      trigger: { type: 'record.created', table_id: fx.orders.id, skip_bulk: true },
    });
    const lines = ['title'];
    for (let i = 0; i < 5000; i += 1) lines.push(`Nhập ${String(i)}`);
    const uploadResponse = await call(
      'u_admin',
      'POST',
      `/bases/${fx.baseId}/imports/uploads`,
      multipart('orders.csv', Buffer.from(`${lines.join('\r\n')}\r\n`)),
      { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    );
    expect(uploadResponse.statusCode, uploadResponse.body).toBe(201);
    const upload = importUploadSchema.parse(uploadResponse.json());
    const startResponse = await call('u_admin', 'POST', `/bases/${fx.baseId}/imports`, {
      upload_id: upload.id,
      mode: 'append',
      table_id: fx.orders.id,
      mapping: [{ column: 0, field_id: F('title') }],
    });
    expect(startResponse.statusCode, startResponse.body).toBe(202);
    const started = performance.now();
    const jobId = startResponse.json<{ job_id: Id<'job'> }>().job_id;
    const job = await eventually(
      async () => {
        const dto = jobSchema.parse((await call('u_admin', 'GET', `/jobs/${jobId}`)).json());
        return ['succeeded', 'failed', 'cancelled'].includes(dto.status) ? dto : undefined;
      },
      'the import',
      180_000,
    );
    expect(job.status).toBe('succeeded');
    const imported = performance.now() - started;
    await settled(300_000);
    // Numbers for the retrospective (S5-review §3); never asserted.
    process.stdout.write(
      `T503 import 5 000 rows + 2 record.created automations: import ${(imported / 1000).toFixed(1)} s, ` +
        `every event dispatched after ${((performance.now() - started) / 1000).toFixed(1)} s ` +
        `(load ${(loadavg()[0] ?? 0).toFixed(2)})\n`,
    );

    const runs = await runsOf(capped.id);
    const queued = runs.filter((run) => run.status === 'queued');
    const skipped = runs.filter((run) => run.status === 'skipped');
    expect(queued).toHaveLength(1000);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.error).toEqual({
      code: 'batch_fanout_exceeded',
      batch_id: jobId,
      limit: 1000,
      skipped: 4000,
    });
    // One trigger unit: the import job.
    expect(new Set(runs.map((run) => run.trigger_unit))).toEqual(new Set([jobId]));
    expect(
      (
        await sql<{ runs: number; skipped: number }>`
        SELECT runs, skipped FROM meta.automation_batch_counters
         WHERE automation_id = ${capped.id} AND batch_id = ${jobId}
      `.execute(db.kysely)
      ).rows,
    ).toEqual([{ runs: 1000, skipped: 4000 }]);
    expect(await runsOf(skipBulk.id)).toEqual([]);
    expect(await notified('automation.batch_overflow', capped.id)).toContain(fx.users.u_admin.id);
    const state = automationSchema.parse(
      (await call('u_admin', 'GET', `/automations/${capped.id}`)).json(),
    );
    expect(state).toMatchObject({ enabled: true, disabled_reason: null });

    const [first] = (
      await sql<{ payload: Record<string, unknown> }>`
        SELECT payload FROM meta.events
         WHERE type = 'record.created' AND payload->'via'->>'import_job_id' = ${jobId}
         LIMIT 1
      `.execute(db.kysely)
    ).rows;
    expect(first?.payload).toMatchObject({ batch: { id: jobId }, via: { import_job_id: jobId } });
  }, 600_000);
});
