import {
  automationRunDetailSchema,
  automationRunListSchema,
  automationSchema,
  roleListSchema,
  roleSchema,
  type AutomationDto,
  type Id,
} from '@cellhive/contracts';
import { createWorker, type WorkerHandle } from '@cellhive/worker';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { buildRecordFixture, expectProblem, type RecordFixture } from './record-fixture.js';
import { captureLogger, startTestApp, type TestApp } from './support.js';

import type { Db } from '@cellhive/server-core';

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
 * The automation rows of the CONTRACTS §5 matrix over HTTP (BACKLOG T519),
 * with the fixture variant of P29/P32/P33 — role Sales with `manage` on
 * Orders, set here through `PATCH /bases/:id/roles/:roleId` — and the real
 * worker. Where the other rows run:
 *
 * | Row | Over HTTP in |
 * |---|---|
 * | P29 | this file (the service-level case is `automation-run.int.test.ts`) |
 * | P31, P32 | `automation-crud.int.test.ts` |
 * | P33 | `automation-revalidate-run-as.int.test.ts` |
 * | P37, P38 | `automation-buttons.int.test.ts`; on the `seed:demo` data, `seed.int.test.ts` |
 * | P43 | `automation-duplicate.int.test.ts` (T551) |
 *
 * P31 is repeated here on the variant: managing Orders does not make
 * u_sales1 a manager of Tickets automations, and an editor still manages none.
 */
describe('automation permission matrix over HTTP (T519)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let worker: WorkerHandle;
  let r1: Id<'rec'>;
  let r2: Id<'rec'>;

  const F = (name: string) => fx.fld[name]?.id as Id<'fld'>;

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

  async function amountOf(id: Id<'rec'>): Promise<unknown> {
    const response = await fx.call(
      'u_admin',
      'GET',
      `/tables/${fx.orders.id}/records/${id}?field_key_type=id`,
    );
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ fields: Record<string, unknown> }>().fields[F('amount')] ?? null;
  }

  async function idle(): Promise<void> {
    await eventually(async () => {
      const { rows } = await sql<{ events: number; runs: number }>`
        SELECT (SELECT count(*)::int FROM meta.events WHERE dispatched_at IS NULL) AS events,
               (SELECT count(*)::int FROM meta.automation_runs
                 WHERE status IN ('queued', 'running')) AS runs
      `.execute(db.kysely);
      return rows[0]?.events === 0 && rows[0].runs === 0;
    }, 'events dispatched and runs finished');
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    fx = await buildRecordFixture(t, db);
    // The fixture variant of P29/P32/P33, through the API: Sales `manage`s Orders.
    const roles = roleListSchema.parse(
      (await fx.call('u_admin', 'GET', `/bases/${fx.baseId}/roles`)).json(),
    ).items;
    const sales = roles.find((role) => role.name === 'Sales');
    if (sales === undefined) throw new Error('no Sales role');
    const tables = sales.config.tables as Record<string, Record<string, unknown>>;
    const patched = await fx.call('u_admin', 'PATCH', `/bases/${fx.baseId}/roles/${sales.id}`, {
      config: {
        ...sales.config,
        tables: { ...tables, [fx.orders.id]: { ...tables[fx.orders.id], perm: 'manage' } },
      },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    const saved = roleSchema.parse(patched.json()).config.tables as Record<
      string,
      { perm: string }
    >;
    expect(saved[fx.orders.id]?.perm).toBe('manage');
    r1 = await createOrder({
      [F('title')]: 'r1',
      [F('amount')]: 1,
      [F('owner')]: [{ id: fx.users.u_sales1.id }],
    });
    r2 = await createOrder({
      [F('title')]: 'r2',
      [F('amount')]: 2,
      [F('owner')]: [{ id: fx.users.u_sales2.id }],
    });
    worker = await createWorker(t.config, { logger: captureLogger().logger, pollIntervalMs: 50 });
    await idle();
  });

  afterAll(async () => {
    await idle().catch(() => undefined);
    await worker.close();
    await t.close();
    await db.destroy();
    await database.drop();
  });

  it('P29: an automation of u_sales1 writing r2 fails that run permission_denied and stays on', async () => {
    // u_sales1 creates it over HTTP: `run_as` = u_sales1.
    const created = await fx.call('u_sales1', 'POST', `/bases/${fx.baseId}/automations`, {
      name: 'P29',
      enabled: true,
      definition: {
        trigger: { type: 'record.updated', table_id: fx.orders.id, watch_fields: [F('title')] },
        actions: [
          {
            id: 'act_1',
            type: 'update_record',
            config: { table_id: fx.orders.id, fields: { [F('amount')]: { literal: 9 } } },
          },
        ],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const automation: AutomationDto = automationSchema.parse(created.json());
    expect(automation).toMatchObject({ enabled: true, run_as: { id: fx.users.u_sales1.id } });

    // u_admin changes both orders (only r1 is in the edit rule of u_sales1).
    for (const id of [r1, r2]) {
      const response = await fx.call(
        'u_admin',
        'PATCH',
        `/tables/${fx.orders.id}/records/${id}?field_key_type=id`,
        { fields: { [F('title')]: `${id} sửa` } },
      );
      expect(response.statusCode, response.body).toBe(200);
    }
    await idle();

    const runs = automationRunListSchema.parse(
      (await fx.call('u_sales1', 'GET', `/automations/${automation.id}/runs`)).json(),
    ).items;
    expect(runs.map((run) => run.status).sort()).toEqual(['failed', 'succeeded']);
    const failed = runs.find((run) => run.status === 'failed');
    expect(failed?.error).toMatchObject({ code: 'permission_denied', step: 'act_1' });
    const detail = await fx.call('u_admin', 'GET', `/automation-runs/${failed?.id ?? ''}`);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(automationRunDetailSchema.parse(detail.json()).error).toMatchObject({
      code: 'permission_denied',
      params: { scope: 'record' },
    });
    // A failure on one record is not a loss of access: the automation stays on.
    const after = automationSchema.parse(
      (await fx.call('u_sales1', 'GET', `/automations/${automation.id}`)).json(),
    );
    expect(after).toMatchObject({ enabled: true, disabled_reason: null });
    expect(await amountOf(r1)).toBe(9);
    expect(await amountOf(r2)).toBe(2);
  });

  it('P31 on the variant: managing Orders is not managing Tickets; an editor manages none', async () => {
    const tickets = await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/automations`, {
      name: 'Tickets',
      definition: { trigger: { type: 'record.created', table_id: fx.tickets.id } },
    });
    expect(tickets.statusCode, tickets.body).toBe(201);
    const id = automationSchema.parse(tickets.json()).id;
    // u_sales1 cannot read Tickets: the automation does not exist for them.
    expectProblem(await fx.call('u_sales1', 'GET', `/automations/${id}`), 404, 'NOT_FOUND');
    expectProblem(
      await fx.call('u_sales1', 'POST', `/bases/${fx.baseId}/automations`, {
        name: 'x',
        definition: { trigger: { type: 'record.created', table_id: fx.tickets.id } },
      }),
      422,
      'AUTOMATION_INVALID',
    );
    for (const [method, url] of [
      ['GET', `/automations/${id}`],
      ['POST', `/automations/${id}/enable`],
      ['GET', `/bases/${fx.baseId}/automations`],
    ] as const) {
      expectProblem(await fx.call('u_editor', method, url), 403, 'PERMISSION_DENIED');
    }
    // The automations u_sales1 lists are those of Orders only.
    const listed = await fx.call('u_sales1', 'GET', `/bases/${fx.baseId}/automations`);
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json<{ items: { name: string }[] }>().items.map((item) => item.name)).toEqual([
      'P29',
    ]);
  });
});
