import { loadavg } from 'node:os';

import {
  automationSchema,
  buttonClickResponseSchema,
  createdShareLinkSchema,
  fieldSchema,
  newId,
  recordsResponseSchema,
  viewSchema,
  type AutomationDto,
  type FieldDto,
  type Id,
  type RealtimeServerMessage,
} from '@cellhive/contracts';
import { orgScope, SchemaService, systemAuditContext, type Db } from '@cellhive/server-core';
import { createWorker, type WorkerHandle } from '@cellhive/worker';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Browser } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { closeSockets, listen, TestSocket } from './realtime-support.js';
import {
  buildRecordFixture,
  expectProblem,
  type FixtureUser,
  type RecordFixture,
} from './record-fixture.js';
import {
  captureLogger,
  problemOf,
  startTestApp,
  TEST_PUBLIC_URL,
  type TestApp,
} from './support.js';

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
  readonly trigger_event_id: string | null;
  readonly trigger_unit: string;
  readonly input: {
    readonly trigger: {
      readonly type: string;
      readonly event_id: string;
      readonly record_id: string;
      readonly data: { readonly clicked_by: string; readonly clicked_at: string };
    };
  };
}

/**
 * BACKLOG T517 (ADR-32 §2, CONTRACTS §2/§5/§21) through the real API and
 * worker: a `button` field without column, its per-viewer cell (`no_automation`,
 * `automation_disabled`, `permission`, `condition`), read-only, not
 * filterable/sortable; one automation per button (`BUTTON_IN_USE`); the
 * click route (`202 { run_id }`, event + audit, run as `run_as` with
 * `clicked_by`/`clicked_at`, `automation.run.finished` to the clicker only),
 * `422 BUTTON_DISABLED`, P37–P38, share links (disabled cell, no route),
 * rate limits, `Idempotency-Key`, other organizations.
 */
describe('button field and button.clicked (T517)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let url: string;
  let worker: WorkerHandle;
  const sockets: TestSocket[] = [];
  let button: FieldDto;
  let note: Id<'fld'>;
  let automation: AutomationDto;
  let r1: Id<'rec'>;
  let r2: Id<'rec'>;
  let r3: Id<'rec'>;
  const extra: Id<'rec'>[] = [];
  let optNew: string;
  let optDone: string;

  const F = (name: string) => fx.fld[name]?.id as Id<'fld'>;
  const clickUrl = (recordId: string, fieldId: string = button.id) =>
    `/tables/${fx.orders.id}/records/${recordId}/buttons/${fieldId}/click`;
  const click = (user: FixtureUser, recordId: string, headers?: Record<string, string>) =>
    fx.call(user, 'POST', clickUrl(recordId), undefined, headers);

  async function cellsOf(user: FixtureUser, format = 'json'): Promise<Map<string, unknown>> {
    const response = await fx.call(
      user,
      'GET',
      `/tables/${fx.orders.id}/records?field_key_type=id&cell_format=${format}&limit=100`,
    );
    expect(response.statusCode, response.body).toBe(200);
    const records = response.json<{ records: { id: string; fields: Record<string, unknown> }[] }>()
      .records;
    return new Map(records.map((record) => [record.id, record.fields[button.id]]));
  }

  /** Errors the API logged (shown when a request unexpectedly fails). */
  const failuresLogged = () =>
    JSON.stringify(t.logs.lines.filter((line) => line['err'] !== undefined).slice(-3));

  async function amountOf(id: Id<'rec'>): Promise<unknown> {
    const response = await fx.call(
      'u_admin',
      'GET',
      `/tables/${fx.orders.id}/records/${id}?field_key_type=id`,
    );
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ fields: Record<string, unknown> }>().fields[F('amount')];
  }

  async function setAmount(id: Id<'rec'>, value: number | null): Promise<void> {
    const response = await fx.call(
      'u_admin',
      'PATCH',
      `/tables/${fx.orders.id}/records?field_key_type=id`,
      { records: [{ id, fields: { [F('amount')]: value } }] },
    );
    expect(response.statusCode, response.body).toBe(200);
  }

  async function runOf(id: Id<'run'>): Promise<RunRow> {
    const { rows } = await sql<RunRow>`
      SELECT id, status, depth, trigger_event_id, trigger_unit, input
        FROM meta.automation_runs WHERE id = ${id}
    `.execute(db.kysely);
    const row = rows[0];
    if (row === undefined) throw new Error(`no run ${id}`);
    return row;
  }

  async function settled(): Promise<void> {
    await eventually(async () => {
      const { rows } = await sql<{ runs: number }>`
        SELECT count(*)::int AS runs FROM meta.automation_runs
         WHERE status IN ('queued', 'running') AND organization_id = ${fx.orgId}
      `.execute(db.kysely);
      return rows[0]?.runs === 0;
    }, 'runs settled');
  }

  function definition(trigger: Record<string, unknown> = {}) {
    return {
      trigger: {
        type: 'button.clicked',
        table_id: fx.orders.id,
        field_id: button.id,
        enabled_when: { field: F('status'), operator: 'is', value: optNew },
        ...trigger,
      },
      condition: null,
      actions: [
        {
          id: 'act_1',
          type: 'update_record',
          config: {
            table_id: fx.orders.id,
            record_id: null,
            fields: {
              [F('amount')]: { literal: 7 },
              [note]: { template: 'by {{ [@clicked_by] }}' },
            },
          },
        },
      ],
    };
  }

  async function toggle(state: 'enable' | 'disable'): Promise<void> {
    const response = await fx.call('u_admin', 'POST', `/automations/${automation.id}/${state}`);
    expect(response.statusCode, response.body).toBe(200);
  }

  async function userSocket(user: FixtureUser): Promise<TestSocket> {
    const socket = await TestSocket.connect(url, {
      origin: TEST_PUBLIC_URL,
      cookie: await fx.cookie(user),
    });
    sockets.push(socket);
    expect(await socket.subscribe(`user:${fx.users[user].id}`)).toMatchObject({
      type: 'subscribed',
    });
    return socket;
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    url = await listen(t.app);
    fx = await buildRecordFixture(t, db);
    worker = await createWorker(t.config, { logger: captureLogger().logger, pollIntervalMs: 50 });
    note = (
      await t.app
        .get(SchemaService)
        .addField(
          orgScope(fx.orgId),
          fx.orders.id,
          { name: 'note', type: 'text', options: {} },
          systemAuditContext(),
        )
    ).id;
    const options = (fx.fld.status?.options as { options: { id: string }[] }).options;
    optNew = options[0]?.id as string;
    optDone = options[1]?.id as string;
    const created = await fx.call(
      'u_admin',
      'POST',
      `/tables/${fx.orders.id}/records?field_key_type=id`,
      {
        records: [
          {
            fields: {
              [F('title')]: 'r1',
              [F('status')]: optNew,
              [F('owner')]: [{ id: fx.users.u_sales1.id }],
            },
          },
          {
            fields: {
              [F('title')]: 'r2',
              [F('status')]: optNew,
              [F('owner')]: [{ id: fx.users.u_sales2.id }],
            },
          },
          { fields: { [F('title')]: 'r3', [F('status')]: optDone } },
          ...Array.from({ length: 11 }, (_, index) => ({
            fields: { [F('title')]: `x${String(index)}`, [F('status')]: optNew },
          })),
        ],
      },
    );
    expect(created.statusCode, created.body).toBe(201);
    const ids = recordsResponseSchema.parse(created.json()).records.map((record) => record.id);
    [r1, r2, r3] = ids as [Id<'rec'>, Id<'rec'>, Id<'rec'>];
    extra.push(...ids.slice(3));
  });

  afterAll(async () => {
    await closeSockets(sockets);
    await settled().catch(() => undefined);
    await worker.close();
    await t.close();
    await db.destroy();
    await database.drop();
  });

  it('adds a button field as meta only: no column, no slot; never unique nor required', async () => {
    const schema = t.app.get(SchemaService);
    const scope = orgScope(fx.orgId);
    const slots = await schema.usedSlots(scope, fx.orders.id);
    const response = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
      name: 'Duyệt',
      type: 'button',
      options: {
        label: 'Duyệt đơn',
        color: 3,
        confirm: { title: 'Duyệt?', confirm_label: 'Duyệt' },
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    button = fieldSchema.parse(response.json());
    expect(button).toMatchObject({
      type: 'button',
      options: {
        label: 'Duyệt đơn',
        color: 3,
        confirm: { title: 'Duyệt?', message: '', confirm_label: 'Duyệt' },
      },
      button: { automation_id: null, automation_enabled: false, min_permission: null },
    });
    expect(await schema.usedSlots(scope, fx.orders.id)).toBe(slots);
    const { rows } = await sql<{ db_column_name: string | null }>`
      SELECT db_column_name FROM meta.fields WHERE id = ${button.id}
    `.execute(db.kysely);
    expect(rows).toEqual([{ db_column_name: null }]);
    expect(await schema.checkConsistency(scope, fx.orders.id)).toEqual([]);

    const unique = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
      name: 'Khác',
      type: 'button',
      unique_values: true,
    });
    expectProblem(unique, 422, 'VALIDATION_FAILED');
    const renamed = await fx.call('u_admin', 'PATCH', `/fields/${button.id}`, {
      options: { label: 'Duyệt' },
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(fieldSchema.parse(renamed.json()).options).toMatchObject({ label: 'Duyệt', color: 3 });
    expectProblem(
      await fx.call('u_admin', 'PATCH', `/fields/${button.id}`, { options: { color: 99 } }),
      422,
      'VALIDATION_FAILED',
    );
  });

  it('reads a cell per viewer, the label as text; never written, filtered or sorted', async () => {
    const cells = await cellsOf('u_admin');
    expect(cells.get(r1)).toEqual({ state: 'disabled', reason: 'no_automation' });
    expect((await cellsOf('u_admin', 'text')).get(r1)).toBe('Duyệt');

    const write = await fx.call(
      'u_admin',
      'PATCH',
      `/tables/${fx.orders.id}/records?field_key_type=id`,
      {
        records: [{ id: r1, fields: { [button.id]: 'x' } }],
      },
    );
    expectProblem(write, 403, 'FIELD_READ_ONLY');
    const filter = await fx.call(
      'u_admin',
      'POST',
      `/tables/${fx.orders.id}/records/query?field_key_type=id`,
      { filter: { field: button.id, operator: 'is_empty' } },
    );
    expectProblem(filter, 422, 'INVALID_FILTER');
    const sort = await fx.call(
      'u_admin',
      'POST',
      `/tables/${fx.orders.id}/records/query?field_key_type=id`,
      { sort: [{ field: button.id }] },
    );
    expectProblem(sort, 422, 'INVALID_SORT');
    const only = await fx.call(
      'u_admin',
      'POST',
      `/tables/${fx.orders.id}/records/query?field_key_type=id`,
      { fields: [button.id], ids: [r1] },
    );
    expect(only.statusCode, only.body).toBe(200);
    expect(only.json<{ records: { fields: object }[] }>().records[0]?.fields).toEqual({
      [button.id]: { state: 'disabled', reason: 'no_automation' },
    });
    // Never converted (from or to), and unknown to formulas.
    expectProblem(
      await fx.call('u_admin', 'PUT', `/fields/${button.id}`, { type: 'text', options: {} }),
      422,
      'CONVERSION_NOT_ALLOWED',
    );
    expectProblem(
      await fx.call('u_admin', 'PUT', `/fields/${F('amount')}`, { type: 'button', options: {} }),
      422,
      'CONVERSION_NOT_ALLOWED',
    );
    const formula = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
      name: 'f',
      type: 'formula',
      options: { expression: '[Duyệt]' },
    });
    expect(formula.statusCode, formula.body).toBe(422);
  });

  it('allows one automation per button (BUTTON_IN_USE)', async () => {
    const response = await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/automations`, {
      name: 'Duyệt đơn',
      enabled: true,
      definition: definition(),
    });
    expect(response.statusCode, response.body).toBe(201);
    automation = automationSchema.parse(response.json());
    expect(automation.definition.trigger).toMatchObject({ min_permission: 'edit' });

    const second = await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/automations`, {
      name: 'Một nút hai việc',
      definition: definition(),
    });
    expectProblem(second, 422, 'AUTOMATION_INVALID');
    expect(problemOf(second.body)['errors']).toEqual([
      expect.objectContaining({
        path: 'definition.trigger.field_id',
        code: 'BUTTON_IN_USE',
        params: { automation_id: automation.id },
      }),
    ]);
    // Saving the attached automation again is not a conflict with itself.
    const resaved = await fx.call('u_admin', 'PATCH', `/automations/${automation.id}`, {
      definition: definition({
        enabled_when: { field: F('status'), operator: 'is', value: optNew },
      }),
      name: 'Duyệt đơn (1)',
    });
    expect(resaved.statusCode, resaved.body).toBe(200);
    const field = await fx.call('u_reader', 'GET', `/fields/${button.id}`);
    expect(fieldSchema.parse(field.json()).button).toEqual({
      automation_id: automation.id,
      automation_enabled: true,
      min_permission: 'edit',
    });
  });

  it('shows ready / condition / permission / automation_disabled per viewer', async () => {
    const admin = await cellsOf('u_admin');
    expect(admin.get(r1)).toEqual({ state: 'ready', reason: null });
    expect(admin.get(r2)).toEqual({ state: 'ready', reason: null });
    expect(admin.get(r3)).toEqual({ state: 'disabled', reason: 'condition' });
    // `min_permission = edit`: a reader can never click.
    const reader = await cellsOf('u_reader');
    expect(
      [...reader.values()].every(
        (cell) =>
          JSON.stringify(cell) === JSON.stringify({ state: 'disabled', reason: 'permission' }),
      ),
    ).toBe(true);
    // u_sales1 reads and edits r1 only (edit rule: owner = current user).
    const sales = await cellsOf('u_sales1');
    expect([...sales.keys()]).toEqual([r1]);
    expect(sales.get(r1)).toEqual({ state: 'ready', reason: null });

    await toggle('disable');
    expect((await cellsOf('u_admin')).get(r1)).toEqual({
      state: 'disabled',
      reason: 'automation_disabled',
    });
    await toggle('enable');
  });

  it('runs as run_as with clicked_by / clicked_at; only the clicker hears the end', async () => {
    const editor = await userSocket('u_editor');
    const admin = await userSocket('u_admin');
    const started = Date.now();
    const clickedAt = performance.now();
    const response = await click('u_editor', r1);
    expect(response.statusCode, `${response.body} ${failuresLogged()}`).toBe(202);
    const { run_id: runId } = buttonClickResponseSchema.parse(response.json());

    const run = await runOf(runId);
    expect(run).toMatchObject({
      depth: 0,
      trigger_unit: run.trigger_event_id,
      input: {
        trigger: {
          type: 'button.clicked',
          record_id: r1,
          data: { clicked_by: fx.users.u_editor.id },
        },
      },
    });
    expect(Date.parse(run.input.trigger.data.clicked_at)).toBeGreaterThan(started - 5_000);
    const { rows: events } = await sql<{ type: string; actor_id: string; entity_type: string }>`
      SELECT type, actor_id, entity_type FROM meta.events WHERE id = ${run.trigger_event_id}
    `.execute(db.kysely);
    expect(events).toEqual([
      { type: 'button.clicked', actor_id: fx.users.u_editor.id, entity_type: 'record' },
    ]);
    const { rows: audits } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM meta.audit_logs
       WHERE action = 'button.clicked' AND entity_id = ${r1} AND organization_id = ${fx.orgId}
    `.execute(db.kysely);
    expect(audits[0]?.n).toBe(1);

    const finished = (message: RealtimeServerMessage) =>
      message.type === 'automation.run.finished' && message.run_id === runId;
    const message = await editor.next(finished);
    const latency = performance.now() - clickedAt;
    const load = loadavg()[0] ?? 0;
    process.stdout.write(
      `T517 click → automation.run.finished: ${latency.toFixed(1)} ms (load ${load.toFixed(2)})\n`,
    );
    // Latency is only meaningful on an idle machine (BACKLOG S5 conventions).
    if (load < 8) expect(latency).toBeLessThan(1_000);
    expect(message).toMatchObject({
      type: 'automation.run.finished',
      run_id: runId,
      automation_id: automation.id,
      table_id: fx.orders.id,
      record_id: r1,
      status: 'succeeded',
    });
    await admin.expectNone(finished);
    expect(await amountOf(r1)).toBe(7);
    const record = await fx.call(
      'u_admin',
      'GET',
      `/tables/${fx.orders.id}/records/${r1}?field_key_type=id`,
    );
    expect(record.json<{ fields: Record<string, unknown> }>().fields[note]).toMatch(/^by .+/);
  });

  it('answers 422 BUTTON_DISABLED when the condition fails or the automation is off', async () => {
    const condition = await click('u_admin', r3);
    expectProblem(condition, 422, 'VALIDATION_FAILED');
    expect(problemOf(condition.body)['errors']).toEqual([
      expect.objectContaining({ code: 'BUTTON_DISABLED', params: { reason: 'condition' } }),
    ]);
    await toggle('disable');
    const off = await click('u_editor', r2);
    expect(problemOf(off.body)['errors']).toEqual([
      expect.objectContaining({
        code: 'BUTTON_DISABLED',
        params: { reason: 'automation_disabled' },
      }),
    ]);
    await toggle('enable');
  });

  it('P37: u_reader is refused below min_permission edit, runs it with read', async () => {
    await setAmount(r2, null);
    expectProblem(await click('u_reader', r1), 403, 'PERMISSION_DENIED');
    const patched = await fx.call('u_admin', 'PATCH', `/automations/${automation.id}`, {
      definition: definition({ min_permission: 'read' }),
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(automationSchema.parse(patched.json()).run_as.id).toBe(fx.users.u_admin.id);
    expect((await cellsOf('u_reader')).get(r2)).toEqual({ state: 'ready', reason: null });

    const response = await click('u_reader', r2);
    expect(response.statusCode, response.body).toBe(202);
    const { run_id: runId } = buttonClickResponseSchema.parse(response.json());
    await eventually(async () => (await runOf(runId)).status === 'succeeded', 'run of u_reader');
    // Written by run_as (u_admin), which the reader could never do.
    expect(await amountOf(r2)).toBe(7);
    expect((await runOf(runId)).input.trigger.data.clicked_by).toBe(fx.users.u_reader.id);
  });

  it('P38: u_sales1 gets 404 on r2; share links show a disabled cell and have no click route', async () => {
    expectProblem(await click('u_sales1', r2), 404, 'NOT_FOUND');
    // Another organization, a non-button field, an unknown field: 404 alike.
    expectProblem(await click('stranger', r1), 404, 'NOT_FOUND');
    expectProblem(await fx.call('u_admin', 'POST', clickUrl(r1, F('title'))), 404, 'NOT_FOUND');
    expectProblem(await fx.call('u_admin', 'POST', clickUrl(r1, newId('fld'))), 404, 'NOT_FOUND');

    const view = await fx.call('owner', 'POST', `/tables/${fx.orders.id}/views`, {
      name: 'Tất cả',
      type: 'grid',
    });
    expect(view.statusCode, view.body).toBe(201);
    const viewId = viewSchema.parse(view.json()).id;
    const created = await fx.call('owner', 'POST', `/views/${viewId}/share-links`, {
      audience: 'public',
    });
    expect(created.statusCode, created.body).toBe(201);
    const link = createdShareLinkSchema.parse(created.json());
    const anonymous = new Browser(t.app);
    const read = await anonymous.request({
      method: 'POST',
      url: `/api/v1/shares/${link.token}/records/query?field_key_type=id`,
      payload: {},
    });
    expect(read.statusCode, read.body).toBe(200);
    const shared = read.json<{ records: { id: string; fields: Record<string, unknown> }[] }>();
    const sharedR1 = shared.records.find((record) => record.id === r1);
    expect(sharedR1?.fields[button.id]).toEqual({ state: 'disabled', reason: 'permission' });
    const viaShare = await anonymous.request({
      method: 'POST',
      url: `/api/v1/shares/${link.token}/records/${r1}/buttons/${button.id}/click`,
    });
    expect(viaShare.statusCode).toBe(404);
  });

  it('limits clicks: 10 per minute per button and user, one per 2 s per record', async () => {
    // The owner (base admin) has not clicked yet.
    for (const id of extra.slice(0, 10)) {
      const response = await click('owner', id);
      expect(response.statusCode, response.body).toBe(202);
    }
    const eleventh = await click('owner', extra[10] as Id<'rec'>);
    expectProblem(eleventh, 429, 'RATE_LIMITED');
    expect(Number(eleventh.headers['retry-after'])).toBeGreaterThan(0);

    const twice = extra[10] as Id<'rec'>;
    expect((await click('u_editor', twice)).statusCode).toBe(202);
    expectProblem(await click('u_editor', twice), 429, 'RATE_LIMITED');
  });

  it('replays a click with the same Idempotency-Key', async () => {
    const headers = { 'idempotency-key': 'button-click-0001' };
    const first = await click('u_sales1', r1, headers);
    expect(first.statusCode, first.body).toBe(202);
    const again = await click('u_sales1', r1, headers);
    expect(again.statusCode, again.body).toBe(202);
    expect(again.json()).toEqual(first.json());
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM meta.automation_runs r
        JOIN meta.events e ON e.id = r.trigger_event_id
       WHERE e.actor_id = ${fx.users.u_sales1.id} AND r.automation_id = ${automation.id}
    `.execute(db.kysely);
    expect(rows[0]?.n).toBe(1);
    await settled();
  });
});
