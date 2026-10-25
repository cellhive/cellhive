import { loadavg } from 'node:os';

import {
  automationSchema,
  fieldSchema,
  importUploadSchema,
  jobSchema,
  newId,
  type AutomationDto,
  type FieldDto,
  type Id,
} from '@cellhive/contracts';
import {
  ComputedRecomputeService,
  GroupMembersRepository,
  orgScope,
  RecordMutationService,
  SchemaService,
  systemAuditContext,
  toEventDocument,
  type AuditContext,
  type Causation,
  type Db,
  type EventDocument,
  type FieldRow,
  type RecordAccessContext,
  type TableRow,
} from '@cellhive/server-core';
import { buildTaskList, createWorker, type WorkerHandle } from '@cellhive/worker';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AccessService } from '../../src/common/access/access.service.js';
import { recordAccessContextOf } from '../../src/common/access/record-access-context.js';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { buildRecordFixture, expectProblem, type RecordFixture } from './record-fixture.js';
import { captureLogger, problemOf, startTestApp, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

const BOUNDARY = 'cellhive-recompute-boundary';
/** Rows of the fan-out test (BACKLOG T509 acceptance: 200k). */
const BULK_ROWS = 200_000;

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
  readonly error: Record<string, unknown> | null;
}

/**
 * BACKLOG T509 (`docs/reviews/S4b-decisions-followup.md` §3.5) through the
 * real API and worker: recomputed stored formula/lookup values become
 * `record.updated` events (`via.computed_recompute`) for automations
 * watching them — with the batch and causation of the write that recomputed
 * them, or `batch.id = job_…` of a `computed.recompute` run (a bulk event,
 * one trigger unit) with the causation kept through the queue. First values
 * of new records give no event; virtual fields cannot be watched. Runs stay
 * `queued` (the run engine, T505, is left out of this worker).
 */
describe('automation events of recomputed values (T509)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let worker: WorkerHandle;
  let double: FieldDto;
  let recent: FieldDto;
  const created: Id<'aut'>[] = [];

  const F = (name: string) => fx.fld[name]?.id as Id<'fld'>;

  function fieldOf(response: LightMyRequestResponse): FieldDto {
    expect(response.statusCode, response.body).toBe(201);
    return fieldSchema.parse(response.json());
  }

  async function automation(
    trigger: Record<string, unknown>,
    condition: unknown = null,
    name = 'Recompute test',
  ): Promise<AutomationDto> {
    const response = await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/automations`, {
      name,
      enabled: true,
      definition: {
        trigger: { type: 'record.updated', ...trigger },
        condition,
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
  async function settled(timeoutMs = 120_000): Promise<void> {
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

  /** Nothing queued for `computed.recompute` and no such job left, then every event dispatched. */
  async function recomputed(timeoutMs = 300_000): Promise<void> {
    await eventually(
      async () => {
        const { rows } = await sql<{ queued: number; jobs: number }>`
          SELECT (SELECT count(*)::int FROM meta.computed_recompute_queue) AS queued,
                 (SELECT count(*)::int FROM graphile_worker._private_jobs p
                    JOIN graphile_worker._private_tasks k ON k.id = p.task_id
                   WHERE k.identifier IN ('computed.recompute', 'computed.backfill')) AS jobs
        `.execute(db.kysely);
        return rows[0]?.queued === 0 && rows[0].jobs === 0;
      },
      'the recompute jobs',
      timeoutMs,
    );
    await settled(timeoutMs);
  }

  async function runsOf(id: Id<'aut'>): Promise<RunRow[]> {
    const { rows } = await sql<RunRow>`
      SELECT id, status, trigger_event_id, trigger_unit, depth, error
        FROM meta.automation_runs WHERE automation_id = ${id}
       ORDER BY created_at, id
    `.execute(db.kysely);
    return rows;
  }

  /** `record.updated` events of a record, oldest first; `computed`: only recomputed ones. */
  async function eventsOf(recordId: string, computed?: boolean): Promise<EventDocument[]> {
    const rows = await db.kysely
      .selectFrom('meta.events')
      .selectAll()
      .where('entity_id', '=', recordId)
      .where('type', '=', 'record.updated')
      .orderBy('created_at')
      .execute();
    return rows
      .map((row) => toEventDocument(row))
      .filter(
        (event) => computed === undefined || (event.via?.computed_recompute === true) === computed,
      );
  }

  async function createOrders(fields: Record<string, unknown>[]): Promise<Id<'rec'>[]> {
    const response = await fx.call(
      'u_admin',
      'POST',
      `/tables/${fx.orders.id}/records?field_key_type=id`,
      { records: fields.map((item) => ({ fields: item })) },
    );
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ records: { id: Id<'rec'> }[] }>().records.map((record) => record.id);
  }

  async function adminAccess(): Promise<RecordAccessContext> {
    const base = await t.app
      .get(AccessService)
      .findBaseForUser(fx.orgId, fx.users.u_admin.id, fx.baseId);
    if (base === undefined) throw new Error('no access');
    return recordAccessContextOf(
      { groupMembers: new GroupMembersRepository(db), config: t.config },
      { id: fx.users.u_admin.id, locale: null, timezone: null },
      base,
    );
  }

  /** A record service whose writes leave every recompute to the `computed.recompute` job. */
  function deferring(): RecordMutationService {
    return new RecordMutationService(db, {
      schema: t.app.get(SchemaService),
      recompute: new ComputedRecomputeService(db, { syncRowLimit: 0 }),
    });
  }

  async function fieldState(fieldId: Id<'fld'>): Promise<string | null> {
    const row = await db.kysely
      .selectFrom('meta.fields')
      .select('compute_state')
      .where('id', '=', fieldId)
      .executeTakeFirstOrThrow();
    return row.compute_state;
  }

  async function importCsv(tableId: Id<'tbl'>, lines: string[], mapping: object[]) {
    const uploadResponse = await fx.call(
      'u_admin',
      'POST',
      `/bases/${fx.baseId}/imports/uploads`,
      multipart('rows.csv', Buffer.from(`${lines.join('\r\n')}\r\n`)),
      { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    );
    expect(uploadResponse.statusCode, uploadResponse.body).toBe(201);
    const upload = importUploadSchema.parse(uploadResponse.json());
    const startResponse = await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/imports`, {
      upload_id: upload.id,
      mode: 'append',
      table_id: tableId,
      mapping,
    });
    expect(startResponse.statusCode, startResponse.body).toBe(202);
    const jobId = startResponse.json<{ job_id: Id<'job'> }>().job_id;
    const job = await eventually(
      async () => {
        const dto = jobSchema.parse((await fx.call('u_admin', 'GET', `/jobs/${jobId}`)).json());
        return ['succeeded', 'failed', 'cancelled'].includes(dto.status) ? dto : undefined;
      },
      'the import',
      300_000,
    );
    expect(job.status).toBe('succeeded');
    return jobId;
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    fx = await buildRecordFixture(t, db);
    // Runs stay `queued` here: the engine (T505) has its own tests (automation-run*).
    const { logger } = captureLogger();
    const taskList = Object.fromEntries(
      Object.entries(buildTaskList({ config: t.config, db, logger })).filter(
        ([name]) => name !== 'automation.run',
      ),
    );
    worker = await createWorker(t.config, { logger, pollIntervalMs: 50, taskList });
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
    await recomputed();
    expect(await fieldState(double.id)).toBe('ready');
  }, 300_000);

  afterEach(async () => {
    // Earlier automations must not answer the next test's events.
    await recomputed();
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

  it('virtual formulas cannot be watched nor tested with changed* (422 INVALID_FIELD_TYPE)', async () => {
    for (const [definition, path] of [
      [
        { trigger: { type: 'record.updated', table_id: fx.orders.id, watch_fields: [recent.id] } },
        'definition.trigger.watch_fields[0]',
      ],
      [
        {
          trigger: { type: 'record.updated', table_id: fx.orders.id, watch_fields: [F('title')] },
          condition: { op: 'and', items: [{ field: recent.id, operator: 'changed' }] },
        },
        'definition.condition.items[0].field',
      ],
    ] as const) {
      const response = await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/automations`, {
        name: 'Virtual',
        enabled: false,
        definition: { condition: null, ...definition, actions: [] },
      });
      expectProblem(response, 422, 'AUTOMATION_INVALID');
      expect(problemOf(response.body).errors).toEqual([
        expect.objectContaining({
          path,
          code: 'INVALID_FIELD_TYPE',
          params: { expected: 'stored', type: 'formula', compute_mode: 'virtual' },
        }),
      ]);
    }
    // Stored formulas can.
    await automation({ table_id: fx.orders.id, watch_fields: [double.id] });
  });

  it('a write recomputing its own record in its transaction: one event with both changes, one run (v: none for a new record)', async () => {
    const watcher = await automation({ table_id: fx.orders.id, watch_fields: [double.id] });
    const both = await automation(
      { table_id: fx.orders.id, watch_fields: [F('amount'), double.id] },
      null,
      'Source and formula',
    );
    const onTitle = await automation({ table_id: fx.orders.id, watch_fields: [F('title')] });
    const [id] = (await createOrders([{ [F('title')]: 'Sync', [F('amount')]: 10 }])) as [Id<'rec'>];
    await settled();
    // (v) The first value of a new record is part of record.created.
    expect(await eventsOf(id)).toEqual([]);
    expect(await runsOf(watcher.id)).toEqual([]);

    const patched = await fx.call(
      'u_admin',
      'PATCH',
      `/tables/${fx.orders.id}/records?field_key_type=id`,
      { records: [{ id, fields: { [F('amount')]: 20 } }] },
    );
    expect(patched.statusCode, patched.body).toBe(200);
    await settled();
    // The recomputed value joins the write's own event: no second event.
    const [write, ...others] = await eventsOf(id);
    expect(others).toEqual([]);
    expect(write?.batch?.id).toMatch(/^req_/);
    expect(write).toMatchObject({
      actor: { type: 'user', id: fx.users.u_admin.id },
      changes: {
        [F('amount')]: { from: 10, to: 20 },
        [double.id]: { from: 20, to: 40 },
      },
    });
    expect(write).not.toHaveProperty('via');
    // An automation watching the source and the formula runs once.
    for (const automationId of [watcher.id, both.id]) {
      expect(await runsOf(automationId)).toEqual([
        expect.objectContaining({
          status: 'queued',
          trigger_event_id: write?.id,
          trigger_unit: write?.id,
          depth: 0,
        }),
      ]);
    }
    expect(await runsOf(onTitle.id)).toEqual([]);
  });

  it('through the job: causation kept (iii: A not again, B at the same depth), job batch, no event for created records (v)', async () => {
    const a = await automation({ table_id: fx.orders.id, watch_fields: [double.id] }, null, 'A');
    const b = await automation({ table_id: fx.orders.id, watch_fields: [double.id] }, null, 'B');
    const service = deferring();
    const access = await adminAccess();
    const scope = orgScope(fx.orgId);
    const runId = newId('run');
    const audit: AuditContext = {
      actor: { type: 'automation', id: a.id },
      via: { automation_id: a.id, run_id: runId },
      batch_id: runId,
      request_id: null,
      ip: null,
      user_agent: null,
    };
    const rootId = newId('evt');
    const causation: Causation = { root_event_id: rootId, depth: 1, automation_chain: [a.id] };

    // (v) Records created by a write whose recompute all goes to the job.
    const createdRecords = await service.create(
      scope,
      fx.orders.id,
      access,
      {
        field_key_type: 'id',
        records: [
          { fields: { [F('title')]: 'Job 1', [F('amount')]: 1 } },
          { fields: { [F('title')]: 'Job 2', [F('amount')]: 2 } },
        ],
      },
      audit,
      { causation },
    );
    const [first, second] = createdRecords.records.map((record) => record.id);
    await recomputed();
    for (const id of [first, second]) expect(await eventsOf(id as string, true)).toEqual([]);
    expect(await runsOf(a.id)).toEqual([]);
    expect(await runsOf(b.id)).toEqual([]);

    // (iii) A (depth 1) writes amount; the job recomputes double.
    await service.update(
      scope,
      fx.orders.id,
      access,
      {
        field_key_type: 'id',
        records: [
          { id: first as Id<'rec'>, fields: { [F('amount')]: 5 } },
          { id: second as Id<'rec'>, fields: { [F('amount')]: 6 } },
        ],
      },
      audit,
      { causation },
    );
    await recomputed();
    const events = [
      ...(await eventsOf(first as string, true)),
      ...(await eventsOf(second as string, true)),
    ];
    expect(events).toHaveLength(2);
    const batchId = events[0]?.batch?.id;
    expect(batchId).toMatch(/^job_[0-9A-Za-z]{16}$/);
    for (const event of events) {
      expect(event).toMatchObject({
        actor: { type: 'system', id: null },
        batch: { id: batchId, size: 2 },
        via: { computed_recompute: true, job_id: batchId },
        // Depth unchanged: the recompute is a consequence of A's write.
        causation: { root_event_id: rootId, depth: 1, automation_chain: [a.id] },
      });
    }
    expect(events.map((event) => event.changes)).toEqual([
      { [double.id]: { from: 2, to: 10 } },
      { [double.id]: { from: 4, to: 12 } },
    ]);
    expect(await runsOf(a.id)).toEqual([]);
    const runs = await runsOf(b.id);
    expect(runs).toHaveLength(2);
    // A bulk event: the job run is the trigger unit.
    for (const run of runs) {
      expect(run).toMatchObject({ status: 'queued', depth: 1, trigger_unit: batchId });
    }
  });

  it(`(i, ii) renaming an option recomputes ${String(BULK_ROWS)} rows: 1 000 runs + 1 skipped, 1 001 events, skip_bulk none, still on`, async () => {
    const schema = t.app.get(SchemaService);
    const scope = orgScope(fx.orgId);
    const context = systemAuditContext();
    const optNew = newId('opt');
    const optOld = newId('opt');
    const { table } = await schema.createTable(
      scope,
      { baseId: fx.baseId, name: 'Bulk', primaryFieldName: 'name' },
      context,
    );
    const stage: FieldRow = await schema.addField(
      scope,
      table.id,
      {
        name: 'stage',
        type: 'select',
        options: {
          options: [
            { id: optNew, name: 'Mới' },
            { id: optOld, name: 'Cũ' },
          ],
        },
      },
      context,
    );
    const bulkTable: TableRow = table;
    // TEST FIXTURE: bulk rows written directly.
    await sql`
      INSERT INTO ${sql.id('data', bulkTable.db_table_name)} (__id, ${sql.id(stage.db_column_name as string)})
      SELECT 'rec_' || lpad(to_hex(g), 16, '0'), ARRAY[${optNew}]::text[]
        FROM generate_series(1, ${BULK_ROWS}) g
    `.execute(db.kysely);
    const label = fieldOf(
      await fx.call('u_admin', 'POST', `/tables/${table.id}/fields`, {
        name: 'label',
        type: 'formula',
        options: { expression: '[stage] & "!"' },
      }),
    );
    expect(label).toMatchObject({ compute_mode: 'stored' });
    await recomputed(600_000);
    expect(await fieldState(label.id)).toBe('ready');

    const capped = await automation({ table_id: table.id, watch_fields: [label.id] }, null, 'Cap');
    const skipBulk = await automation(
      { table_id: table.id, watch_fields: [label.id], skip_bulk: true },
      null,
      'Skip bulk',
    );
    const started = performance.now();
    const renamed = await fx.call('u_admin', 'PATCH', `/fields/${stage.id}`, {
      options: {
        options: [
          { id: optNew, name: 'Mới 2' },
          { id: optOld, name: 'Cũ' },
        ],
      },
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    const patched = performance.now() - started;
    await recomputed(600_000);
    // Numbers for the retrospective (S5-review §3); never asserted.
    process.stdout.write(
      `T509 recompute ${String(BULK_ROWS)} + watch_fields: PATCH ${patched.toFixed(0)} ms, ` +
        `recompute + dispatch ${((performance.now() - started) / 1000).toFixed(1)} s ` +
        `(load ${(loadavg()[0] ?? 0).toFixed(2)})\n`,
    );

    const runs = await runsOf(capped.id);
    const queued = runs.filter((run) => run.status === 'queued');
    const skipped = runs.filter((run) => run.status === 'skipped');
    expect(queued).toHaveLength(1000);
    expect(skipped).toHaveLength(1);
    const batchId = skipped[0]?.error?.batch_id as string;
    expect(batchId).toMatch(/^job_/);
    expect(skipped[0]?.error).toEqual({
      code: 'batch_fanout_exceeded',
      batch_id: batchId,
      limit: 1000,
      skipped: BULK_ROWS - 1000,
    });
    expect(new Set(runs.map((run) => run.trigger_unit))).toEqual(new Set([batchId]));
    expect(
      (
        await sql<{ runs: number; skipped: number; events: number }>`
          SELECT runs, skipped, events FROM meta.automation_batch_counters
           WHERE automation_id = ${capped.id} AND batch_id = ${batchId}
        `.execute(db.kysely)
      ).rows,
    ).toEqual([{ runs: 1000, skipped: BULK_ROWS - 1000, events: 1001 }]);
    // No more than the cap + 1 events were written for the run.
    const { rows: written } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM meta.events
       WHERE type = 'record.updated' AND payload->'batch'->>'id' = ${batchId}
    `.execute(db.kysely);
    expect(written[0]?.n).toBe(1001);
    // (ii) skip_bulk: a recompute run is a bulk change.
    expect(await runsOf(skipBulk.id)).toEqual([]);
    for (const id of [capped.id, skipBulk.id]) {
      expect(
        automationSchema.parse((await fx.call('u_admin', 'GET', `/automations/${id}`)).json()),
      ).toMatchObject({ enabled: true, disabled_reason: null });
    }
  }, 900_000);

  it('(iv) importing 10 000 rows linked both ways: runs on the other table capped, breaker not tripped', async () => {
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
    const SHOPS = 200;
    const shopNames = Array.from({ length: SHOPS }, (_, i) => `S${String(i).padStart(3, '0')}`);
    const shopResponse = await fx.call('u_admin', 'POST', `/tables/${shops.id}/records`, {
      records: shopNames.map((name) => ({ fields: { name } })),
    });
    expect(shopResponse.statusCode, shopResponse.body).toBe(201);
    await recomputed();
    const watcher = await automation(
      { table_id: shops.id, watch_fields: [total.id] },
      null,
      'Shops',
    );

    const lines = ['ref,value,shop'];
    for (let i = 0; i < 10_000; i += 1) {
      lines.push(`R${String(i)},${String(i % 7)},${shopNames[i % SHOPS] as string}`);
    }
    const jobId = await importCsv(sales.id, lines, [
      { column: 0, field_id: sales.primary_field_id as string },
      { column: 1, field_id: value.id },
      { column: 2, field_id: link.id },
    ]);
    await recomputed(600_000);

    const runs = await runsOf(watcher.id);
    const queued = runs.filter((run) => run.status === 'queued');
    const skipped = runs.filter((run) => run.status === 'skipped');
    // Every import batch recomputed the 200 totals in its transaction: one unit, the import.
    expect(queued).toHaveLength(1000);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.error).toMatchObject({
      code: 'batch_fanout_exceeded',
      batch_id: jobId,
      skipped: 10 * SHOPS - 1000,
    });
    expect(new Set(runs.map((run) => run.trigger_unit))).toEqual(new Set([jobId]));
    expect(
      automationSchema.parse(
        (await fx.call('u_admin', 'GET', `/automations/${watcher.id}`)).json(),
      ),
    ).toMatchObject({ enabled: true, disabled_reason: null });
    const [sample] = (
      await sql<{ payload: Record<string, unknown> }>`
        SELECT payload FROM meta.events
         WHERE type = 'record.updated' AND payload->'via'->>'computed_recompute' = 'true'
           AND payload->'batch'->>'id' = ${jobId}
         LIMIT 1
      `.execute(db.kysely)
    ).rows;
    expect(sample?.payload).toMatchObject({
      batch: { id: jobId },
      via: { import_job_id: jobId, computed_recompute: true, job_id: null },
    });
  }, 900_000);
});
