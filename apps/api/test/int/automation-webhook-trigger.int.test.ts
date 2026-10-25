import {
  automationRunDetailSchema,
  automationSchema,
  incomingWebhookWithSecretsSchema,
  newId,
  roleListSchema,
  type AutomationDto,
  type Id,
  type IncomingWebhookWithSecretsDto,
} from '@cellhive/contracts';
import {
  automationWaitJobKey,
  deriveCausationKey,
  encodeCausationToken,
  toEventDocument,
  type Db,
} from '@cellhive/server-core';
import { createWorker, type WorkerHandle } from '@cellhive/worker';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IncomingWebhookRateLimits } from '../../src/common/rate-limit/incoming-webhook-rate-limits.js';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import {
  buildRecordFixture,
  expectProblem,
  type FixtureUser,
  type RecordFixture,
} from './record-fixture.js';
import { captureLogger, startTestApp, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

async function eventually<T>(
  probe: () => Promise<T | undefined | false>,
  label: string,
  timeoutMs = 90_000,
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
  readonly trigger_unit: string;
  readonly error: Record<string, unknown> | null;
  readonly input: { trigger?: Record<string, unknown> } | null;
}

function tokenOf(hook: Pick<IncomingWebhookWithSecretsDto, 'url'>): string {
  const token = hook.url.split('/api/v1/hooks/')[1];
  if (token === undefined) throw new Error(`unexpected url ${hook.url}`);
  return token;
}

/**
 * BACKLOG T604 (ADR-35 §2, §5, §6; CONTRACTS §21) through the real API and
 * worker: a request to an incoming webhook runs the automations listening
 * to it — values and templates read the stored request (`body`, `headers`,
 * `query`; sensitive headers `null`), writes carry `via.incoming_webhook_id`,
 * the trigger unit is one second of the hook (a burst does not trip the
 * breaker) or the causation root (50 failing chains do), a purged request
 * fails a re-run `trigger_data_expired`, a hook deleted while a run waits
 * fails it `webhook_deleted`; P44 for automations (base admins only).
 */
describe('webhook.received trigger (T604)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let worker: WorkerHandle;

  const F = (name: string) => fx.fld[name]?.id as Id<'fld'>;
  const call = (
    user: FixtureUser,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
  ) => fx.call(user, method, url, payload);

  async function hook(): Promise<IncomingWebhookWithSecretsDto> {
    const response = await call('u_admin', 'POST', `/bases/${fx.baseId}/incoming-webhooks`, {
      name: `Hook ${newId('hok').slice(4, 12)}`,
      auth: 'none',
      rate_limit_per_sec: 1000,
    });
    expect(response.statusCode, response.body).toBe(201);
    return incomingWebhookWithSecretsSchema.parse(response.json());
  }

  async function automation(definition: object, enabled = true): Promise<AutomationDto> {
    const response = await call('u_admin', 'POST', `/bases/${fx.baseId}/automations`, {
      name: `Webhook ${newId('aut').slice(4, 10)}`,
      enabled,
      definition,
    });
    expect(response.statusCode, response.body).toBe(201);
    return automationSchema.parse(response.json());
  }

  function post(
    target: IncomingWebhookWithSecretsDto,
    body: unknown,
    options: { query?: string; headers?: Record<string, string> } = {},
  ): Promise<LightMyRequestResponse> {
    return t.app.inject({
      method: 'POST',
      url: `/api/v1/hooks/${tokenOf(target)}${options.query === undefined ? '' : `?${options.query}`}`,
      payload: JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...options.headers },
      remoteAddress: '198.51.100.9',
    });
  }

  async function runsOf(id: Id<'aut'>): Promise<RunRow[]> {
    const { rows } = await sql<RunRow>`
      SELECT id, status, trigger_unit, error, input FROM meta.automation_runs
       WHERE automation_id = ${id} ORDER BY created_at, id
    `.execute(db.kysely);
    return rows;
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

  async function automationNow(id: Id<'aut'>): Promise<AutomationDto> {
    const response = await call('u_admin', 'GET', `/automations/${id}`);
    expect(response.statusCode, response.body).toBe(200);
    return automationSchema.parse(response.json());
  }

  /** An `update_record` of a record that does not exist: the step fails (`permission_denied`). */
  const failingStep = () => ({
    id: 'act_1',
    type: 'update_record',
    config: {
      table_id: fx.orders.id,
      record_id: { literal: 'rec_NoSuchRecord000001' },
      fields: { [F('amount')]: { literal: 1 } },
    },
  });

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url, WEBHOOK_MAX_RATE_PER_SEC: '1000' });
    fx = await buildRecordFixture(t, db);
    const limits = t.app.get(IncomingWebhookRateLimits);
    limits.ip = { limit: 100_000, windowSeconds: 1 };
    limits.base = { ratePerSec: 100_000, burst: 100_000 };
    // The fixture variant of P29/P32 (P44): Sales `manage`s Orders.
    const roles = roleListSchema.parse(
      (await call('u_admin', 'GET', `/bases/${fx.baseId}/roles`)).json(),
    ).items;
    const sales = roles.find((role) => role.name === 'Sales');
    if (sales === undefined) throw new Error('no Sales role');
    const tables = sales.config.tables as Record<string, Record<string, unknown>>;
    const patched = await call('u_admin', 'PATCH', `/bases/${fx.baseId}/roles/${sales.id}`, {
      config: {
        ...sales.config,
        tables: { ...tables, [fx.orders.id]: { ...tables[fx.orders.id], perm: 'manage' } },
      },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    worker = await createWorker(t.config, { logger: captureLogger().logger, pollIntervalMs: 50 });
  });

  afterAll(async () => {
    await settled().catch(() => undefined);
    await worker.close();
    await t.close();
    await db.destroy();
    await database.drop();
  });

  it('creates a record from body.customer.email and query.source; authorization is null; writes carry via.incoming_webhook_id', async () => {
    const target = await hook();
    const flow = await automation({
      trigger: { type: 'webhook.received', incoming_webhook_id: target.id },
      actions: [
        {
          id: 'act_order',
          type: 'create_record',
          config: {
            table_id: fx.orders.id,
            fields: {
              [F('title')]: {
                template:
                  '{{ [@body.customer.email] }} / {{ [@query.source] }} / ' +
                  '{{ [@headers.x-shop-topic] }} / [{{ [@headers.authorization] }}] / ' +
                  '{{ [@body.items[0\\].sku] }}',
              },
              [F('amount')]: { trigger: 'body', path: 'total' },
            },
          },
        },
        {
          id: 'act_customer',
          type: 'create_record',
          config: {
            table_id: fx.customers.id,
            fields: {
              [F('customerName')]: { trigger: 'body', path: 'customer.email' },
              [F('customerCode')]: { trigger: 'headers', path: 'authorization' },
            },
          },
        },
      ],
    });
    // The hook is in use now: it cannot be deleted (T602).
    expectProblem(
      await call('u_admin', 'DELETE', `/incoming-webhooks/${target.id}`),
      409,
      'WEBHOOK_IN_USE',
    );

    const response = await post(
      target,
      { customer: { email: 'an@shop.test' }, total: 250_000, items: [{ sku: 'A-1' }] },
      {
        query: 'source=shopify',
        headers: { 'x-shop-topic': 'orders/create', authorization: 'Bearer canary-t604' },
      },
    );
    expect(response.statusCode, response.body).toBe(202);
    const requestId = response.json<{ request_id: Id<'whr'> }>().request_id;
    await settled();

    const [run] = await runsOf(flow.id);
    expect(run?.status, JSON.stringify(run?.error)).toBe('succeeded');
    expect(run?.input?.trigger).toMatchObject({
      type: 'webhook.received',
      table_id: null,
      record_id: null,
      incoming_webhook_id: target.id,
      request_id: requestId,
    });
    const steps = (
      await sql<{ action_id: string; output: { id: Id<'rec'> } }>`
        SELECT action_id, output FROM meta.automation_run_steps
         WHERE run_id = ${run?.id ?? ''} ORDER BY created_at, id
      `.execute(db.kysely)
    ).rows;
    const recordOf = async (tableId: Id<'tbl'>, actionId: string) => {
      const id = steps.find((step) => step.action_id === actionId)?.output.id;
      const got = await call(
        'u_admin',
        'GET',
        `/tables/${tableId}/records/${id ?? ''}?field_key_type=id`,
      );
      expect(got.statusCode, got.body).toBe(200);
      return {
        id: id as Id<'rec'>,
        fields: got.json<{ fields: Record<string, unknown> }>().fields,
      };
    };
    const order = await recordOf(fx.orders.id, 'act_order');
    expect(order.fields[F('title')]).toBe('an@shop.test / shopify / orders/create / [] / A-1');
    expect(order.fields[F('amount')]).toBe(250_000);
    const customer = await recordOf(fx.customers.id, 'act_customer');
    expect(customer.fields[F('customerName')]).toBe('an@shop.test');
    expect(customer.fields[F('customerCode')] ?? null).toBeNull();

    // The events of the run's writes name the hook (ADR-35 §6, used by T608).
    for (const id of [order.id, customer.id]) {
      const rows = await db.kysely
        .selectFrom('meta.events')
        .selectAll()
        .where('entity_id', '=', id)
        .execute();
      const created = rows
        .map((row) => toEventDocument(row))
        .find((e) => e.type === 'record.created');
      expect(created?.via).toEqual({
        automation_id: flow.id,
        run_id: run?.id,
        incoming_webhook_id: target.id,
      });
      expect(created?.actor).toEqual({ type: 'automation', id: flow.id });
    }
    const audit = await sql<{ via: unknown }>`
      SELECT via FROM meta.audit_logs WHERE entity_id = ${order.id} ORDER BY created_at LIMIT 1
    `.execute(db.kysely);
    expect(audit.rows[0]?.via).toMatchObject({ incoming_webhook_id: target.id });
    // The Bearer value never reached a stored row.
    const leaked = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM meta.automation_run_steps WHERE output::text LIKE '%canary-t604%'
    `.execute(db.kysely);
    expect(leaked.rows[0]?.n).toBe(0);
  });

  it('P44: only base admins create such an automation; a missing hook or a condition is 422', async () => {
    const target = await hook();
    const definition = {
      trigger: { type: 'webhook.received', incoming_webhook_id: target.id },
      actions: [failingStep()],
    };
    for (const user of ['u_sales1', 'u_editor', 'u_reader'] as const) {
      expectProblem(
        await call(user, 'POST', `/bases/${fx.baseId}/automations`, { name: 'P44', definition }),
        403,
        'PERMISSION_DENIED',
      );
    }
    // A table manager learns nothing about hooks: an unknown hook is 403 too.
    expectProblem(
      await call('u_sales1', 'POST', `/bases/${fx.baseId}/automations`, {
        name: 'P44',
        definition: {
          ...definition,
          trigger: { type: 'webhook.received', incoming_webhook_id: newId('hok') },
        },
      }),
      403,
      'PERMISSION_DENIED',
    );
    expectProblem(
      await call('u_out', 'POST', `/bases/${fx.baseId}/automations`, { name: 'P44', definition }),
      404,
      'NOT_FOUND',
    );
    // u_sales1 cannot take over or edit one either.
    const flow = await automation(definition, false);
    expectProblem(
      await call('u_sales1', 'POST', `/automations/${flow.id}/take-over`, { enable: true }),
      403,
      'PERMISSION_DENIED',
    );

    // A deleted hook (or one of another base) is unknown; any condition is refused.
    const gone = await hook();
    expect((await call('u_admin', 'DELETE', `/incoming-webhooks/${gone.id}`)).statusCode).toBe(204);
    const invalid = await call('u_admin', 'POST', `/bases/${fx.baseId}/automations`, {
      name: 'Invalid',
      definition: {
        trigger: { type: 'webhook.received', incoming_webhook_id: gone.id },
        condition: { field: F('title'), operator: 'is_not_empty' },
        actions: [failingStep()],
      },
    });
    expect(invalid.statusCode, invalid.body).toBe(422);
    expect(
      invalid
        .json<{ errors: { path: string; code: string }[] }>()
        .errors.map(({ path, code }) => ({ path, code })),
    ).toEqual([
      { path: 'definition.trigger.incoming_webhook_id', code: 'UNKNOWN_WEBHOOK' },
      { path: 'definition.condition', code: 'INVALID_CONDITION' },
    ]);
  });

  it('validate-template accepts the webhook references with trigger_type webhook.received', async () => {
    const response = await call(
      'u_admin',
      'POST',
      `/bases/${fx.baseId}/automations/validate-template`,
      {
        table_id: null,
        template: '{{ [@body.customer.email] }} {{ [@headers.x-topic] }} {{ [@query.a[0\\]] }}',
        form: 'stored',
        trigger_type: 'webhook.received',
      },
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ valid: true, errors: [] });
    const other = await call(
      'u_admin',
      'POST',
      `/bases/${fx.baseId}/automations/validate-template`,
      {
        table_id: null,
        template: '{{ [@body.customer.email] }}',
        form: 'stored',
        trigger_type: 'schedule',
      },
    );
    expect(other.json()).toMatchObject({ valid: false });
  });

  it('a burst of 120 requests (more than 100 per minute) does not trip the breaker: one unit per second', async () => {
    const target = await hook();
    const flow = await automation({
      trigger: { type: 'webhook.received', incoming_webhook_id: target.id },
      actions: [
        {
          id: 'act_find',
          type: 'find_records',
          config: { table_id: fx.customers.id, limit: 1 },
        },
      ],
    });
    const startedAt = Date.now();
    for (let index = 0; index < 120; index += 1) {
      const response = await post(target, { n: index });
      expect(response.statusCode, response.body).toBe(202);
    }
    const seconds = Math.ceil((Date.now() - startedAt) / 1000) + 1;
    await settled();
    const runs = await runsOf(flow.id);
    expect(runs).toHaveLength(120);
    expect(runs.every((run) => run.status === 'succeeded')).toBe(true);
    const units = new Set(runs.map((run) => run.trigger_unit));
    expect(units.size).toBeLessThanOrEqual(seconds);
    for (const unit of units) expect(unit).toMatch(new RegExp(`^webhook:${target.id}:\\d+$`));
    expect(await automationNow(flow.id)).toMatchObject({ enabled: true, disabled_reason: null });
  });

  it('50 failing chains in a row (valid causation: one unit each) turn the automation off', async () => {
    const target = await hook();
    const flow = await automation({
      trigger: { type: 'webhook.received', incoming_webhook_id: target.id },
      actions: [failingStep()],
    });
    const key = deriveCausationKey(t.config.security.appMasterKey);
    const roots: string[] = [];
    for (let index = 0; index < 50; index += 1) {
      const root = newId('evt');
      roots.push(root);
      const header = encodeCausationToken(
        { root_event_id: root, depth: 0, automation_chain: [newId('aut')] },
        { key, host: 'api:3000', path: '/api/v1/hooks', now: new Date() },
      );
      const response = await post(
        target,
        { n: index },
        {
          headers: { host: 'api:3000', 'x-cellhive-causation': header },
        },
      );
      expect(response.statusCode, response.body).toBe(202);
    }
    await settled();
    const runs = await runsOf(flow.id);
    expect(runs.map((run) => run.trigger_unit).sort()).toEqual([...roots].sort());
    expect(runs.every((run) => run.status === 'failed')).toBe(true);
    expect(await automationNow(flow.id)).toMatchObject({
      enabled: false,
      disabled_reason: 'circuit_breaker',
    });
  });

  it('a re-run after the request was purged fails trigger_data_expired', async () => {
    const target = await hook();
    const flow = await automation({
      trigger: { type: 'webhook.received', incoming_webhook_id: target.id },
      actions: [failingStep()],
    });
    const response = await post(target, { customer: { email: 'old@shop.test' } });
    expect(response.statusCode, response.body).toBe(202);
    await settled();
    const [failed] = await runsOf(flow.id);
    expect(failed?.status).toBe('failed');
    // Older than 7 days: the purge removed it (cron of T602).
    await sql`DELETE FROM meta.incoming_webhook_requests WHERE id = ${response.json<{ request_id: string }>().request_id}`.execute(
      db.kysely,
    );
    const edited = await call('u_admin', 'PATCH', `/automations/${flow.id}`, {
      definition: {
        trigger: { type: 'webhook.received', incoming_webhook_id: target.id },
        actions: [
          {
            id: 'act_1',
            type: 'create_record',
            config: {
              table_id: fx.customers.id,
              fields: { [F('customerName')]: { trigger: 'body', path: 'customer.email' } },
            },
          },
        ],
      },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const rerun = await call('u_admin', 'POST', `/automation-runs/${failed?.id ?? ''}/rerun`);
    expect(rerun.statusCode, rerun.body).toBe(201);
    const rerunId = rerun.json<{ id: Id<'run'> }>().id;
    await settled();
    const detail = automationRunDetailSchema.parse(
      (await call('u_admin', 'GET', `/automation-runs/${rerunId}`)).json(),
    );
    expect(detail.status).toBe('failed');
    expect(detail.error).toMatchObject({ code: 'trigger_data_expired', step: 'act_1' });
  });

  it('a hook deleted while a run waits in a delay fails the run webhook_deleted', async () => {
    const target = await hook();
    const flow = await automation({
      trigger: { type: 'webhook.received', incoming_webhook_id: target.id },
      actions: [
        { id: 'act_wait', type: 'delay', config: { minutes: 1 } },
        {
          id: 'act_2',
          type: 'create_record',
          config: {
            table_id: fx.customers.id,
            fields: { [F('customerName')]: { trigger: 'body', path: 'name' } },
          },
        },
      ],
    });
    expect((await post(target, { name: 'late' })).statusCode).toBe(202);
    const waiting = await eventually(
      async () => (await runsOf(flow.id)).find((run) => run.status === 'waiting'),
      'waiting run',
    );
    await sql`UPDATE meta.incoming_webhooks SET deleted_at = now() WHERE id = ${target.id}`.execute(
      db.kysely,
    );
    // The delay is over: its end and its job move to now.
    await sql`
      UPDATE meta.automation_run_steps
         SET output = jsonb_set(output, '{until}', to_jsonb(${new Date(Date.now() - 1_000).toISOString()}::text))
       WHERE run_id = ${waiting.id} AND status = 'waiting'
    `.execute(db.kysely);
    await sql`
      UPDATE graphile_worker._private_jobs SET run_at = now() WHERE key = ${automationWaitJobKey(waiting.id)}
    `.execute(db.kysely);
    const ended = await eventually(
      async () => (await runsOf(flow.id)).find((run) => run.status === 'failed'),
      'failed run',
    );
    expect(ended.error).toMatchObject({ code: 'webhook_deleted' });
    const steps = (
      await sql<{ action_id: string; status: string }>`
        SELECT action_id, status FROM meta.automation_run_steps WHERE run_id = ${ended.id}
      `.execute(db.kysely)
    ).rows;
    expect(steps).toEqual([{ action_id: 'act_wait', status: 'cancelled' }]);
  });
});
