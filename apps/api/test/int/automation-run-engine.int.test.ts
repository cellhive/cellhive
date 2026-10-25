import { newId, type Id } from '@cellhive/contracts';
import {
  AppError,
  AutomationRunEngine,
  AutomationRunsRepository,
  AutomationRunStepsRepository,
  AutomationsRepository,
  BREAKER_MAX_FAILED_UNITS,
  defaultActionRegistry,
  NO_AUTOMATION_NOTIFICATIONS,
  orgScope,
  RecordMutationService,
  RecordQueryService,
  resolveMemberBaseAccess,
  type AutomationActionHandler,
  type MemberBaseAccess,
  type AutomationRunEngineOptions,
  type Db,
  type DeferrableJob,
  type JsonObject,
} from '@cellhive/server-core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { buildRecordFixture, type RecordFixture } from './record-fixture.js';
import { startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

const MINUTE = 60_000;

function jobOf(orgId: Id<'org'>, runId: Id<'run'>): DeferrableJob {
  return {
    task_identifier: 'automation.run',
    payload: { organization_id: orgId, run_id: runId },
    priority: 0,
    attempts: 1,
    max_attempts: 25,
    key: null,
    flags: null,
    queue_name: null,
  };
}

/** A gate a fake action waits on. */
function gate() {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

/**
 * BACKLOG T505 acceptance at the service level (`AutomationRunEngine`
 * called like the `automation.run` job, no background worker, clock and
 * randomness pinned): idempotent steps when the worker dies, the retry
 * schedule of temporary errors and immediate failure otherwise, the
 * per-organization cap (another organization is not blocked), the 15 minute
 * running timeout, `unsupported_action`, and the "50 failed units" breaker.
 */
describe('automation run engine (T505, service level)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let other: RecordFixture;
  let records: RecordMutationService;
  let query: RecordQueryService;

  const F = (name: string) => fx.fld[name]?.id as Id<'fld'>;

  function engine(overrides: Partial<AutomationRunEngineOptions> = {}): AutomationRunEngine {
    return new AutomationRunEngine(db, {
      defaults: { timeZone: 'Asia/Ho_Chi_Minh', locale: 'vi' },
      query,
      actions: defaultActionRegistry({ records, query }),
      publicUrl: TEST_PUBLIC_URL,
      notifier: NO_AUTOMATION_NOTIFICATIONS,
      random: () => 0,
      ...overrides,
    });
  }

  async function createOrder(fixture: RecordFixture, title: string): Promise<Id<'rec'>> {
    const response = await fixture.call(
      'u_admin',
      'POST',
      `/tables/${fixture.orders.id}/records?field_key_type=id`,
      { records: [{ fields: { [fixture.fld.title?.id as string]: title } }] },
    );
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ records: { id: Id<'rec'> }[] }>().records[0]?.id as Id<'rec'>;
  }

  /** An enabled automation of `fixture` (run as u_admin) and one `queued` run for `recordId`. */
  async function queuedRun(
    fixture: RecordFixture,
    actions: object[],
    recordId: Id<'rec'>,
    automationId: Id<'aut'> = newId('aut'),
  ): Promise<{ automationId: Id<'aut'>; runId: Id<'run'> }> {
    const scope = orgScope(fixture.orgId);
    const definition = {
      trigger: { type: 'record.created', table_id: fixture.orders.id, skip_bulk: false },
      condition: null,
      actions,
    } as unknown as JsonObject;
    if ((await new AutomationsRepository(db).get(scope, automationId)) === undefined) {
      await new AutomationsRepository(db).insert(scope, {
        id: automationId,
        baseId: fixture.baseId,
        name: automationId,
        description: '',
        enabled: true,
        definition,
        triggerType: 'record.created',
        triggerTableId: fixture.orders.id,
        createdBy: fixture.users.u_admin.id,
      });
    }
    const runId = newId('run');
    await new AutomationRunsRepository(db).insert(scope, {
      id: runId,
      automationId,
      automationVersion: 1,
      triggerEventId: null,
      triggerUnit: newId('evt'),
      status: 'queued',
      depth: 0,
      input: {
        automation_version: 1,
        definition,
        trigger: {
          event_id: null,
          event_created_at: null,
          type: 'record.created',
          table_id: fixture.orders.id,
          record_id: recordId,
          bulk: false,
          batch: null,
        },
      },
    });
    return { automationId, runId };
  }

  const createCustomer = (name: string) => ({
    id: 'act_new',
    type: 'create_record',
    config: { table_id: fx.customers.id, fields: { [F('customerName')]: { literal: name } } },
  });

  async function run(id: Id<'run'>, fixture: RecordFixture = fx) {
    return new AutomationRunsRepository(db).get(orgScope(fixture.orgId), id);
  }

  async function steps(id: Id<'run'>, fixture: RecordFixture = fx) {
    return new AutomationRunStepsRepository(db).listByRun(orgScope(fixture.orgId), id);
  }

  async function customersNamed(name: string): Promise<number> {
    const result = await query.query(orgScope(fx.orgId), fx.customers.id, await adminAccess(), {
      field_key_type: 'id',
      filter: { field: F('customerName'), operator: 'eq', value: name },
      limit: 10,
    });
    return result.records.length;
  }

  let access: MemberBaseAccess | undefined;
  async function adminAccess() {
    access ??= await resolveMemberBaseAccess(
      db,
      orgScope(fx.orgId),
      { userId: fx.users.u_admin.id, baseId: fx.baseId },
      { timeZone: 'UTC', locale: 'vi' },
    );
    if (access === undefined) throw new Error('admin has no access');
    return access.record;
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    fx = await buildRecordFixture(t, db);
    other = await buildRecordFixture(t, db);
    records = t.app.get(RecordMutationService);
    query = t.app.get(RecordQueryService);
  });

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
  });

  it('a worker dying after a step committed: the resumed run does not create the record again', async () => {
    const recordId = await createOrder(fx, 'Chết giữa chừng');
    const { runId, automationId } = await queuedRun(
      fx,
      [
        createCustomer('Idempotent 1'),
        {
          id: 'act_2',
          type: 'update_record',
          config: { table_id: fx.orders.id, fields: { [F('cost')]: { literal: 3 } } },
        },
      ],
      recordId,
    );
    const dying = engine({
      afterStep: () => Promise.reject(new Error('worker killed')),
    });
    await expect(dying.execute(orgScope(fx.orgId), runId, jobOf(fx.orgId, runId))).rejects.toThrow(
      'worker killed',
    );
    expect(await run(runId)).toMatchObject({ status: 'running' });
    expect((await steps(runId)).map((step) => [step.action_id, step.status])).toEqual([
      ['act_new', 'succeeded'],
    ]);

    // graphile-worker retries the job: the run resumes after the committed step.
    const result = await engine().execute(orgScope(fx.orgId), runId, jobOf(fx.orgId, runId));
    expect(result).toEqual({ status: 'succeeded' });
    expect(await customersNamed('Idempotent 1')).toBe(1);
    expect((await steps(runId)).map((step) => [step.action_id, step.status, step.attempt])).toEqual(
      [
        ['act_new', 'succeeded', 1],
        ['act_2', 'succeeded', 1],
      ],
    );
    expect((await steps(runId))[0]?.idempotency_key).toBe(`${automationId}:${runId}:act_new`);
    // A job delivered again does nothing.
    expect(await engine().execute(orgScope(fx.orgId), runId, jobOf(fx.orgId, runId))).toEqual({
      status: 'not_runnable',
    });
    expect(await customersNamed('Idempotent 1')).toBe(1);
  });

  it('a worker dying before the step committed: the step runs again once (attempt 2)', async () => {
    const recordId = await createOrder(fx, 'Chết trước commit');
    const { runId, automationId } = await queuedRun(fx, [createCustomer('Idempotent 2')], recordId);
    // The state a killed worker leaves: run running, step started, nothing written.
    await new AutomationRunsRepository(db).startSegment(orgScope(fx.orgId), runId, new Date());
    await new AutomationRunStepsRepository(db).begin(orgScope(fx.orgId), {
      id: newId('stp'),
      runId,
      actionId: 'act_new',
      idempotencyKey: `${automationId}:${runId}:act_new`,
      at: new Date(),
    });
    expect(await engine().execute(orgScope(fx.orgId), runId, jobOf(fx.orgId, runId))).toEqual({
      status: 'succeeded',
    });
    expect(await customersNamed('Idempotent 2')).toBe(1);
    expect((await steps(runId)).map((step) => [step.status, step.attempt])).toEqual([
      ['succeeded', 2],
    ]);
  });

  it('a temporary error is retried on schedule (10 s, 30 s, 2 min, 10 min, 30 min), then fails', async () => {
    const recordId = await createOrder(fx, 'Lỗi tạm');
    const { runId } = await queuedRun(fx, [createCustomer('never')], recordId);
    let clock = new Date('2026-10-05T03:00:00.000Z').getTime();
    let calls = 0;
    const failing: AutomationActionHandler = {
      execute: () => {
        calls += 1;
        return Promise.reject(new AppError('INTERNAL', { detail: 'upstream 5xx' }));
      },
    };
    const flaky = engine({
      now: () => new Date(clock),
      actions: new Map([['create_record', failing]]),
    });
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const result = await flaky.execute(orgScope(fx.orgId), runId, jobOf(fx.orgId, runId));
      if (attempt <= 5) {
        expect(result).toMatchObject({ status: 'retry_scheduled', step: 'act_new' });
        const { rows } = await sql<{ run_at: Date }>`
          SELECT j.run_at FROM graphile_worker._private_jobs j
            JOIN graphile_worker._private_tasks k ON k.id = j.task_id
           WHERE k.identifier = 'automation.run' AND j.payload->>'run_id' = ${runId}
           ORDER BY j.id DESC LIMIT 1
        `.execute(db.kysely);
        delays.push((rows[0]?.run_at.getTime() ?? 0) - clock);
        expect(await run(runId)).toMatchObject({
          status: 'queued',
          error: { code: 'temporary_error', step: 'act_new' },
        });
        const [step] = await steps(runId);
        expect(step).toMatchObject({ status: 'failed', attempt });
        clock += (delays.at(-1) ?? 0) + 1;
      } else {
        expect(result).toEqual({ status: 'failed', code: 'temporary_error', step: 'act_new' });
      }
    }
    expect(delays).toEqual([10_000, 30_000, 2 * MINUTE, 10 * MINUTE, 30 * MINUTE]);
    expect(calls).toBe(6);
    expect(await run(runId)).toMatchObject({
      status: 'failed',
      error: {
        code: 'temporary_error',
        step: 'act_new',
        params: { cause: 'server_error', attempts: 6 },
      },
    });
    // Waiting between retries is not running time.
    expect(Number((await run(runId))?.active_ms)).toBeLessThan(MINUTE);
  });

  it('a 422 from the record service fails the step at once, without retry', async () => {
    const recordId = await createOrder(fx, 'Lỗi 422');
    const { runId } = await queuedRun(
      fx,
      [
        {
          id: 'act_bad',
          type: 'update_record',
          config: {
            table_id: fx.orders.id,
            fields: { [F('amount')]: { literal: 'không phải số' } },
          },
        },
      ],
      recordId,
    );
    const result = await engine().execute(orgScope(fx.orgId), runId, jobOf(fx.orgId, runId));
    expect(result).toEqual({ status: 'failed', code: 'invalid_value', step: 'act_bad' });
    expect(await steps(runId)).toEqual([
      expect.objectContaining({
        status: 'failed',
        attempt: 1,
        error: expect.objectContaining({ code: 'invalid_value' }) as unknown,
      }),
    ]);
  });

  it('caps running runs per organization (5): the others are deferred, another organization is not blocked', async () => {
    const recordId = await createOrder(fx, 'Đồng thời');
    const otherRecord = await createOrder(other, 'Org khác');
    const held = gate();
    let entered = 0;
    const blocking: AutomationActionHandler = {
      async execute() {
        entered += 1;
        await held.opened;
        return { output: {} };
      },
    };
    const capped = engine({
      maxRunningPerOrg: 5,
      actions: new Map([['create_record', blocking]]),
    });
    const automationId = newId('aut');
    const runs: Id<'run'>[] = [];
    for (let index = 0; index < 10; index += 1) {
      runs.push((await queuedRun(fx, [createCustomer('cap')], recordId, automationId)).runId);
    }
    const results = runs.map((id) => capped.execute(orgScope(fx.orgId), id, jobOf(fx.orgId, id)));
    // Five runs are inside their step; the other five were put back for later.
    const settledEarly = await Promise.all(
      results.map((promise) =>
        Promise.race([
          promise,
          new Promise((resolve) =>
            setTimeout(() => {
              resolve('pending');
            }, 3_000),
          ),
        ]),
      ),
    );
    expect(settledEarly.filter((value) => value === 'pending')).toHaveLength(5);
    expect(
      settledEarly.filter((value) => (value as { status?: string }).status === 'deferred'),
    ).toHaveLength(5);
    expect(entered).toBe(5);
    const { rows } = await sql<{ status: string; n: number }>`
      SELECT status, count(*)::int AS n FROM meta.automation_runs
       WHERE automation_id = ${automationId} GROUP BY status ORDER BY status
    `.execute(db.kysely);
    expect(rows).toEqual([
      { status: 'queued', n: 5 },
      { status: 'running', n: 5 },
    ]);

    // Another organization runs while this one is at its cap.
    const { runId: otherRun } = await queuedRun(
      other,
      [
        {
          id: 'act_new',
          type: 'create_record',
          config: {
            table_id: other.customers.id,
            fields: { [other.fld.customerName?.id as string]: { literal: 'org B' } },
          },
        },
      ],
      otherRecord,
    );
    expect(
      await engine({ maxRunningPerOrg: 5 }).execute(
        orgScope(other.orgId),
        otherRun,
        jobOf(other.orgId, otherRun),
      ),
    ).toEqual({ status: 'succeeded' });

    held.open();
    const final = await Promise.all(results);
    expect(final.filter((result) => result.status === 'succeeded')).toHaveLength(5);
    expect(final.filter((result) => result.status === 'deferred')).toHaveLength(5);
    const { rows: deferredJobs } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM graphile_worker._private_jobs j
        JOIN graphile_worker._private_tasks k ON k.id = j.task_id
       WHERE k.identifier = 'automation.run' AND j.payload->>'run_id' = ANY(${runs}::text[])
         AND j.attempts = 0
    `.execute(db.kysely);
    expect(deferredJobs[0]?.n).toBe(5);
  });

  it('fails a run with run_timeout after 15 minutes of running', async () => {
    const recordId = await createOrder(fx, 'Quá giờ');
    const { runId } = await queuedRun(
      fx,
      [
        createCustomer('slow 1'),
        {
          id: 'act_2',
          type: 'update_record',
          config: { table_id: fx.orders.id, fields: { [F('cost')]: { literal: 1 } } },
        },
      ],
      recordId,
    );
    let clock = Date.now();
    const slow: AutomationActionHandler = {
      execute: () => {
        clock += 16 * MINUTE;
        return Promise.resolve({ output: { id: 'rec_x' } });
      },
    };
    const result = await engine({
      now: () => new Date(clock),
      actions: new Map([['create_record', slow]]),
    }).execute(orgScope(fx.orgId), runId, jobOf(fx.orgId, runId));
    expect(result).toEqual({ status: 'failed', code: 'run_timeout', step: 'act_2' });
    expect(await run(runId)).toMatchObject({
      status: 'failed',
      error: { code: 'run_timeout', step: 'act_2' },
    });
    expect((await steps(runId)).map((step) => step.action_id)).toEqual(['act_new']);
  });

  it('an action without a handler (here delay left out) fails as unsupported_action', async () => {
    const recordId = await createOrder(fx, 'Delay');
    const { runId } = await queuedRun(
      fx,
      [{ id: 'act_wait', type: 'delay', config: { minutes: 5, recheck_condition: null } }],
      recordId,
    );
    const withoutDelay = new Map(
      [...defaultActionRegistry({ records, query })].filter(([type]) => type !== 'delay'),
    );
    expect(
      await engine({ actions: withoutDelay }).execute(
        orgScope(fx.orgId),
        runId,
        jobOf(fx.orgId, runId),
      ),
    ).toEqual({
      status: 'failed',
      code: 'unsupported_action',
      step: 'act_wait',
    });
  });

  it('50 trigger units failing in a row turn the automation off (circuit_breaker)', async () => {
    const recordId = await createOrder(fx, 'Ngắt mạch');
    const automationId = newId('aut');
    const failing = engine({ actions: new Map() });
    for (let index = 0; index < BREAKER_MAX_FAILED_UNITS; index += 1) {
      const { runId } = await queuedRun(fx, [createCustomer('x')], recordId, automationId);
      const result = await failing.execute(orgScope(fx.orgId), runId, jobOf(fx.orgId, runId));
      expect(result).toMatchObject({ status: 'failed', code: 'unsupported_action' });
      const row = await new AutomationsRepository(db).get(orgScope(fx.orgId), automationId);
      expect(row?.enabled).toBe(index < BREAKER_MAX_FAILED_UNITS - 1);
    }
    expect(await new AutomationsRepository(db).get(orgScope(fx.orgId), automationId)).toMatchObject(
      {
        enabled: false,
        disabled_reason: 'circuit_breaker',
      },
    );
  });
});
