import {
  automationListSchema,
  automationRunDetailSchema,
  automationRunListSchema,
  automationRunSchema,
  automationSchema,
  newId,
  type AutomationDto,
  type AutomationRunDetailDto,
  type Id,
} from '@cellhive/contracts';
import {
  AutomationRunStepsRepository,
  AutomationRunsRepository,
  AutomationsRepository,
  orgScope,
  type Db,
} from '@cellhive/server-core';
import { createWorker, type WorkerHandle } from '@cellhive/worker';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import {
  buildRecordFixture,
  expectProblem,
  type FixtureUser,
  type RecordFixture,
} from './record-fixture.js';
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

/**
 * BACKLOG T518 through the real API and worker: run lists (per automation,
 * per base, filters, cursor), run detail with step outputs hidden by the
 * viewer's current permissions (u_sales1 manages Orders but cannot read
 * `cost` nor other people's orders), re-run of a failed run after fixing the
 * data (succeeded steps not repeated), cancel, `404` for anyone who does not
 * manage the automation, `403` on the base list for a reader who manages
 * nothing, and the run counts of the automation list.
 */
describe('automation run history (T518)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let worker: WorkerHandle;

  const F = (name: string) => fx.fld[name]?.id as Id<'fld'>;
  const call = (
    user: FixtureUser,
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    payload?: unknown,
  ) => fx.call(user, method, url, payload);

  async function automation(definition: object, name: string): Promise<AutomationDto> {
    const response = await call('u_admin', 'POST', `/bases/${fx.baseId}/automations`, {
      name,
      enabled: true,
      definition,
    });
    expect(response.statusCode, response.body).toBe(201);
    return automationSchema.parse(response.json());
  }

  async function settled(): Promise<void> {
    await eventually(async () => {
      const { rows } = await sql<{ events: number; runs: number }>`
        SELECT (SELECT count(*)::int FROM meta.events WHERE dispatched_at IS NULL) AS events,
               (SELECT count(*)::int FROM meta.automation_runs
                 WHERE status IN ('queued', 'running')) AS runs
      `.execute(db.kysely);
      return rows[0]?.events === 0 && rows[0].runs === 0;
    }, 'events dispatched and runs finished');
  }

  async function createOrder(fields: Record<string, unknown>): Promise<Id<'rec'>> {
    const response = await call(
      'u_admin',
      'POST',
      `/tables/${fx.orders.id}/records?field_key_type=id`,
      { records: [{ fields }] },
    );
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ records: { id: Id<'rec'> }[] }>().records[0]?.id as Id<'rec'>;
  }

  async function runIdsOf(automationId: Id<'aut'>): Promise<Id<'run'>[]> {
    const { rows } = await sql<{ id: Id<'run'> }>`
      SELECT id FROM meta.automation_runs WHERE automation_id = ${automationId}
       ORDER BY created_at, id
    `.execute(db.kysely);
    return rows.map((row) => row.id);
  }

  async function detail(user: FixtureUser, runId: Id<'run'>): Promise<AutomationRunDetailDto> {
    const response = await call(user, 'GET', `/automation-runs/${runId}`);
    expect(response.statusCode, response.body).toBe(200);
    return automationRunDetailSchema.parse(response.json());
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    fx = await buildRecordFixture(t, db);
    // CONTRACTS §5 role Sales, variant of P32 (as in T502): `manage` on Orders.
    const roles = (await call('owner', 'GET', `/bases/${fx.baseId}/roles`)).json<{
      items: { id: Id<'rol'>; name: string; config: { tables: Record<string, object> } }[];
    }>();
    const sales = roles.items.find((role) => role.name === 'Sales');
    if (sales === undefined) throw new Error('missing Sales role');
    const patched = await call('owner', 'PATCH', `/bases/${fx.baseId}/roles/${sales.id}`, {
      config: {
        ...sales.config,
        tables: {
          ...sales.config.tables,
          [fx.orders.id]: { ...sales.config.tables[fx.orders.id], perm: 'manage' },
        },
      },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    worker = await createWorker(t.config, { logger: captureLogger().logger, pollIntervalMs: 50 });
  });

  afterAll(async () => {
    await worker.close();
    await t.close();
    await db.destroy();
    await database.drop();
  });

  describe('find_records output and who sees it', () => {
    let automationId: Id<'aut'>;
    let runId: Id<'run'>;
    let mine: Id<'rec'>;
    let theirs: Id<'rec'>;

    beforeAll(async () => {
      mine = await createOrder({
        [F('title')]: 'rl-1',
        [F('cost')]: 5,
        [F('owner')]: [{ id: fx.users.u_sales1.id }],
      });
      theirs = await createOrder({
        [F('title')]: 'rl-2',
        [F('cost')]: 6,
        [F('owner')]: [{ id: fx.users.u_sales2.id }],
      });
      await settled();
      const created = await automation(
        {
          trigger: { type: 'record.created', table_id: fx.orders.id },
          actions: [
            {
              id: 'act_find',
              type: 'find_records',
              config: {
                table_id: fx.orders.id,
                filter: { field: F('title'), operator: 'contains', value: 'rl-' },
                fields: [F('title'), F('cost')],
              },
            },
          ],
        },
        'Find orders',
      );
      automationId = created.id;
      await createOrder({ [F('title')]: 'zz trigger' });
      await settled();
      [runId] = (await runIdsOf(automationId)) as [Id<'run'>];
    });

    it('shows every value to a base admin', async () => {
      const run = await detail('u_admin', runId);
      expect(run).toMatchObject({
        id: runId,
        automation_id: automationId,
        status: 'succeeded',
        automation_version: 1,
        automation: { id: automationId, version: 1, name: 'Find orders' },
        trigger: { event_type: 'record.created', table_id: fx.orders.id, bulk: false },
        rerun_of: null,
        rerun_by: null,
        reruns: [],
      });
      expect(run.definition?.actions[0]?.id).toBe('act_find');
      const [find] = run.steps;
      expect(find).toMatchObject({ action_id: 'act_find', action_type: 'find_records' });
      expect(find?.redacted).toBe(false);
      expect(find?.output).toMatchObject({
        records: expect.arrayContaining([
          expect.objectContaining({
            id: mine,
            fields: { [F('title')]: 'rl-1', [F('cost')]: 5 },
            redacted: false,
          }),
          expect.objectContaining({ id: theirs, redacted: false }),
        ]) as unknown,
      });
    });

    it('hides cost and the orders u_sales1 cannot read', async () => {
      const run = await detail('u_sales1', runId);
      const [find] = run.steps;
      expect(find?.redacted).toBe(true);
      const records = (find?.output as { records: { id: string }[] }).records;
      expect(records.find((record) => record.id === mine)).toEqual({
        id: mine,
        fields: { [F('title')]: 'rl-1', [F('cost')]: null },
        redacted: false,
        redacted_fields: [F('cost')],
      });
      expect(records.find((record) => record.id === theirs)).toEqual({
        id: theirs,
        fields: { [F('title')]: null, [F('cost')]: null },
        redacted: true,
        // Stored `jsonb`: key order is not kept.
        redacted_fields: expect.arrayContaining([F('title'), F('cost')]) as unknown,
      });
      const list = automationRunListSchema.parse(
        (await call('u_sales1', 'GET', `/automations/${automationId}/runs`)).json(),
      );
      expect(list.items.map((item) => item.id)).toEqual([runId]);
    });

    it('QA S6: an API token without records:read reads no record value of the run', async () => {
      const tokenOf = async (scopes: string[]) => {
        const response = await call('u_admin', 'POST', `/orgs/${fx.orgId}/me/api-tokens`, {
          name: `runs ${scopes.join(' ')}`,
          scopes,
          expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        });
        expect(response.statusCode, response.body).toBe(201);
        return response.json<{ token: string }>().token;
      };
      const viaToken = async (token: string) => {
        const response = await t.app.inject({
          method: 'GET',
          url: `/api/v1/automation-runs/${runId}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(response.statusCode, response.body).toBe(200);
        return automationRunDetailSchema.parse(response.json());
      };
      // `automations:read` alone: the run, never the values (CONTRACTS §26.2).
      const [hidden] = (await viaToken(await tokenOf(['automations:read']))).steps;
      expect(hidden?.redacted).toBe(true);
      const records = (hidden?.output as { records: { id: string; redacted: boolean }[] }).records;
      expect(records.length).toBeGreaterThan(0);
      expect(records.every((record) => record.redacted)).toBe(true);
      expect(JSON.stringify(hidden?.output)).not.toContain('rl-1');
      // With records:read too: what u_admin reads.
      const [shown] = (await viaToken(await tokenOf(['automations:read', 'records:read']))).steps;
      expect(shown?.redacted).toBe(false);
      expect(JSON.stringify(shown?.output)).toContain('rl-1');
    });

    it('answers 404 to anyone who does not manage the automation', async () => {
      for (const user of ['u_editor', 'u_reader', 'u_out', 'stranger'] as const) {
        expectProblem(await call(user, 'GET', `/automation-runs/${runId}`), 404, 'NOT_FOUND');
        expectProblem(
          await call(user, 'GET', `/automations/${automationId}/runs`),
          404,
          'NOT_FOUND',
        );
        expectProblem(
          await call(user, 'POST', `/automation-runs/${runId}/rerun`),
          404,
          'NOT_FOUND',
        );
        expectProblem(
          await call(user, 'POST', `/automation-runs/${runId}/cancel`),
          404,
          'NOT_FOUND',
        );
      }
      expectProblem(
        await call('u_admin', 'GET', `/automation-runs/run_Missing000000001`),
        404,
        'NOT_FOUND',
      );
      // The base list: a reader of the base who manages nothing → 403; outside → 404.
      for (const user of ['u_editor', 'u_reader'] as const) {
        expectProblem(
          await call(user, 'GET', `/bases/${fx.baseId}/automation-runs`),
          403,
          'PERMISSION_DENIED',
        );
      }
      for (const user of ['u_out', 'stranger'] as const) {
        expectProblem(
          await call(user, 'GET', `/bases/${fx.baseId}/automation-runs`),
          404,
          'NOT_FOUND',
        );
      }
    });

    it('lists the runs of the base by what the caller manages', async () => {
      // A `schedule` automation (base admins only) with one run.
      const scope = orgScope(fx.orgId);
      const scheduled = newId('aut');
      await new AutomationsRepository(db).insert(scope, {
        id: scheduled,
        baseId: fx.baseId,
        name: 'Nightly',
        description: '',
        enabled: false,
        definition: { trigger: { type: 'schedule', cron: '0 9 * * *' }, actions: [] },
        triggerType: 'schedule',
        triggerTableId: null,
        createdBy: fx.users.u_admin.id,
      });
      const scheduledRun = newId('run');
      await new AutomationRunsRepository(db).insert(scope, {
        id: scheduledRun,
        automationId: scheduled,
        automationVersion: 1,
        triggerEventId: null,
        triggerUnit: scheduledRun,
        status: 'skipped',
        depth: 0,
        input: {},
      });
      const ids = async (user: FixtureUser, query = '') =>
        automationRunListSchema
          .parse((await call(user, 'GET', `/bases/${fx.baseId}/automation-runs${query}`)).json())
          .items.map((item) => item.id);
      expect(await ids('u_admin')).toEqual(expect.arrayContaining([scheduledRun, runId]));
      expect(await ids('u_sales1')).toContain(runId);
      expect(await ids('u_sales1')).not.toContain(scheduledRun);
      expect(await ids('u_admin', `?automation_id=${scheduled}`)).toEqual([scheduledRun]);
      expect(await ids('u_admin', '?status=skipped')).toEqual([scheduledRun]);
      expect(await ids('u_admin', `?to=2000-01-01T00:00:00.000Z`)).toEqual([]);
      // T616: the runs of one trigger event (the "Run history" link of a webhook request).
      const { rows: events } = await sql<{ trigger_event_id: Id<'evt'> }>`
        SELECT trigger_event_id FROM meta.automation_runs WHERE id = ${runId}
      `.execute(db.kysely);
      const eventId = events[0]?.trigger_event_id as Id<'evt'>;
      expect(eventId).toMatch(/^evt_/u);
      expect(await ids('u_admin', `?event_id=${eventId}`)).toEqual([runId]);
      expect(await ids('u_sales1', `?event_id=${eventId}`)).toEqual([runId]);
      expect(await ids('u_admin', `?event_id=${newId('evt')}`)).toEqual([]);
      expectProblem(
        await call('u_admin', 'GET', `/bases/${fx.baseId}/automation-runs?event_id=run_x`),
        422,
        'VALIDATION_FAILED',
      );
      expectProblem(
        await call('u_admin', 'GET', `/bases/${fx.baseId}/automation-runs?status=lost`),
        422,
        'VALIDATION_FAILED',
      );
      expectProblem(
        await call('u_admin', 'GET', `/bases/${fx.baseId}/automation-runs?cursor=nope!`),
        422,
        'VALIDATION_FAILED',
      );
      // Cursor pages, newest first, no overlap.
      const first = automationRunListSchema.parse(
        (await call('u_admin', 'GET', `/bases/${fx.baseId}/automation-runs?limit=1`)).json(),
      );
      expect(first.items).toHaveLength(1);
      expect(first.next_cursor).not.toBeNull();
      const second = automationRunListSchema.parse(
        (
          await call(
            'u_admin',
            'GET',
            `/bases/${fx.baseId}/automation-runs?limit=1&cursor=${first.next_cursor ?? ''}`,
          )
        ).json(),
      );
      expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    });
  });

  describe('re-run, cancel and the list counts', () => {
    let automationId: Id<'aut'>;
    let order: Id<'rec'>;
    let failedRun: Id<'run'>;

    /** Customers created by automations (only this one writes Customers here). */
    const customersNamed = async () => {
      const { rows } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM meta.audit_logs
         WHERE action = 'record.created' AND table_id = ${fx.customers.id}
           AND actor_type = 'automation'
      `.execute(db.kysely);
      return rows[0]?.n ?? 0;
    };

    beforeAll(async () => {
      const created = await automation(
        {
          trigger: { type: 'record.created', table_id: fx.orders.id },
          actions: [
            {
              id: 'act_side',
              type: 'create_record',
              config: {
                table_id: fx.customers.id,
                fields: { [F('customerName')]: { literal: 'rerun-side' } },
              },
            },
            {
              id: 'act_fix',
              type: 'update_record',
              config: {
                table_id: fx.orders.id,
                record_id: { field: F('title') },
                fields: { [F('amount')]: { literal: 9 } },
              },
            },
          ],
        },
        'Needs a record id',
      );
      automationId = created.id;
      order = await createOrder({ [F('title')]: 'not-a-record-id' });
      await settled();
      [failedRun] = (await runIdsOf(automationId)) as [Id<'run'>];
    });

    it('re-runs a failed run with the current definition after the data is fixed', async () => {
      const failed = await detail('u_admin', failedRun);
      expect(failed).toMatchObject({
        status: 'failed',
        error: { code: 'invalid_value', step: 'act_fix' },
      });
      expect(failed.steps.map((step) => [step.action_id, step.status])).toEqual([
        ['act_side', 'succeeded'],
        ['act_fix', 'failed'],
      ]);
      const sideEffects = await customersNamed();
      expect(sideEffects).toBeGreaterThanOrEqual(1);

      // Fix the data; rename the automation (version 2).
      const fixed = await call(
        'u_admin',
        'PATCH',
        `/tables/${fx.orders.id}/records/${order}?field_key_type=id`,
        { fields: { [F('title')]: order } },
      );
      expect(fixed.statusCode, fixed.body).toBe(200);
      const renamed = await call('u_admin', 'PATCH', `/automations/${automationId}`, {
        name: 'Needs a record id (v2)',
      });
      expect(renamed.statusCode, renamed.body).toBe(200);

      const response = await call('u_sales1', 'POST', `/automation-runs/${failedRun}/rerun`);
      expect(response.statusCode, response.body).toBe(201);
      const rerun = automationRunSchema.parse(response.json());
      expect(rerun).toMatchObject({
        status: 'queued',
        rerun_of: failedRun,
        rerun_by: { id: fx.users.u_sales1.id },
        automation_version: 2,
        trigger: { event_type: 'record.created', record_id: order },
      });
      await settled();
      const done = await detail('u_admin', rerun.id);
      expect(done.status).toBe('succeeded');
      expect(done.steps.map((step) => [step.action_id, step.status, step.reused])).toEqual([
        ['act_side', 'succeeded', true],
        ['act_fix', 'succeeded', false],
      ]);
      // The side effect of the step that had succeeded was not repeated.
      expect(await customersNamed()).toBe(sideEffects);
      const record = await call(
        'u_admin',
        'GET',
        `/tables/${fx.orders.id}/records/${order}?field_key_type=id`,
      );
      expect(record.json<{ fields: Record<string, unknown> }>().fields[F('amount')]).toBe(9);
      expect((await detail('u_admin', failedRun)).reruns).toEqual([
        expect.objectContaining({ id: rerun.id, status: 'succeeded' }),
      ]);

      // A succeeded run is not run again.
      expectProblem(
        await call('u_admin', 'POST', `/automation-runs/${rerun.id}/rerun`),
        409,
        'RUN_STATE_CONFLICT',
      );
      const { rows } = await sql<{ action: string; actor_id: string }>`
        SELECT action, actor_id FROM meta.audit_logs WHERE entity_id = ${rerun.id}
         AND action = 'automation.run.rerun'
      `.execute(db.kysely);
      expect(rows).toEqual([{ action: 'automation.run.rerun', actor_id: fx.users.u_sales1.id }]);
    });

    it('cancels a waiting run once', async () => {
      const scope = orgScope(fx.orgId);
      const waiting = newId('run');
      await new AutomationRunsRepository(db).insert(scope, {
        id: waiting,
        automationId,
        automationVersion: 2,
        triggerEventId: null,
        triggerUnit: waiting,
        status: 'queued',
        depth: 0,
        input: {},
      });
      await sql`UPDATE meta.automation_runs SET status = 'waiting' WHERE id = ${waiting}`.execute(
        db.kysely,
      );
      const steps = new AutomationRunStepsRepository(db);
      const stepId = newId('stp');
      await steps.begin(scope, {
        id: stepId,
        runId: waiting,
        actionId: 'act_wait',
        idempotencyKey: `${automationId}:${waiting}:act_wait`,
        input: { type: 'delay' },
        at: new Date(),
      });
      await steps.finish(scope, stepId, { status: 'waiting', at: new Date() });

      const response = await call('u_admin', 'POST', `/automation-runs/${waiting}/cancel`);
      expect(response.statusCode, response.body).toBe(200);
      expect(automationRunSchema.parse(response.json())).toMatchObject({
        status: 'cancelled',
        error: { code: 'cancelled_by_user', params: { user_id: fx.users.u_admin.id } },
      });
      expect((await detail('u_admin', waiting)).steps[0]?.status).toBe('cancelled');
      expectProblem(
        await call('u_admin', 'POST', `/automation-runs/${waiting}/cancel`),
        409,
        'RUN_STATE_CONFLICT',
      );
      expectProblem(
        await call('u_admin', 'POST', `/automation-runs/${failedRun}/cancel`),
        409,
        'RUN_STATE_CONFLICT',
      );
    });

    it('filters the runs of one automation and counts them in the automation list', async () => {
      const failed = automationRunListSchema.parse(
        (await call('u_admin', 'GET', `/automations/${automationId}/runs?status=failed`)).json(),
      );
      expect(failed.items.map((item) => item.id)).toEqual([failedRun]);
      const list = automationListSchema.parse(
        (await call('u_admin', 'GET', `/bases/${fx.baseId}/automations`)).json(),
      );
      const item = list.items.find((entry) => entry.id === automationId);
      expect(item).toMatchObject({
        errors_24h: 1,
        last_run: { status: 'cancelled', error_code: 'cancelled_by_user' },
        run_counts_24h: { failed: 1, succeeded: 1, cancelled: 1, queued: 0 },
        run_counts_7d: { failed: 1, succeeded: 1, cancelled: 1 },
      });
    });
  });

  describe('delay times read from a field', () => {
    it('shows `until` only to a viewer who reads the date field', async () => {
      // A date field of Orders that Sales cannot read.
      const field = await call('owner', 'POST', `/tables/${fx.orders.id}/fields`, {
        name: 'deadline',
        type: 'datetime',
      });
      expect(field.statusCode, field.body).toBe(201);
      const deadline = field.json<{ id: Id<'fld'> }>().id;
      const roles = (await call('owner', 'GET', `/bases/${fx.baseId}/roles`)).json<{
        items: {
          id: Id<'rol'>;
          name: string;
          config: {
            tables: Record<string, { field_rule: { fields: Record<string, string> } }>;
          };
        }[];
      }>();
      const sales = roles.items.find((role) => role.name === 'Sales');
      if (sales === undefined) throw new Error('missing Sales role');
      const orders = sales.config.tables[fx.orders.id];
      if (orders === undefined) throw new Error('missing Orders access');
      const patched = await call('owner', 'PATCH', `/bases/${fx.baseId}/roles/${sales.id}`, {
        config: {
          ...sales.config,
          tables: {
            ...sales.config.tables,
            [fx.orders.id]: {
              ...orders,
              field_rule: {
                ...orders.field_rule,
                fields: { ...orders.field_rule.fields, [deadline]: 'no_perm' },
              },
            },
          },
        },
      });
      expect(patched.statusCode, patched.body).toBe(200);

      const delayed = await automation(
        {
          trigger: { type: 'record.created', table_id: fx.orders.id },
          actions: [
            { id: 'act_wait', type: 'delay', config: { until: { field: deadline } } },
            { id: 'act_short', type: 'delay', config: { minutes: 5 } },
          ],
        },
        'Wait for the deadline',
      );
      await createOrder({
        [F('title')]: 'delay-1',
        [F('owner')]: [{ id: fx.users.u_sales1.id }],
        [deadline]: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10),
      });
      const runId = await eventually(async () => {
        const [id] = await runIdsOf(delayed.id);
        if (id === undefined) return undefined;
        const { rows } = await sql<{ status: string }>`
          SELECT status FROM meta.automation_runs WHERE id = ${id}
        `.execute(db.kysely);
        return rows[0]?.status === 'waiting' ? id : undefined;
      }, 'the run waiting in its delay');

      const adminStep = (await detail('u_admin', runId)).steps.find(
        (step) => step.action_id === 'act_wait',
      );
      expect(adminStep?.redacted).toBe(false);
      expect((adminStep?.output as { until: string | null }).until).toEqual(expect.any(String));
      const salesStep = (await detail('u_sales1', runId)).steps.find(
        (step) => step.action_id === 'act_wait',
      );
      expect(salesStep).toMatchObject({ redacted: true, output: { until: null } });

      // Cancel it so it never resumes.
      const cancelled = await call('u_admin', 'POST', `/automation-runs/${runId}/cancel`);
      expect(cancelled.statusCode, cancelled.body).toBe(200);
    });
  });
});
