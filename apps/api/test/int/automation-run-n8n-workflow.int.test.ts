import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server } from 'node:http';

import {
  automationRunDetailSchema,
  automationSchema,
  httpDeliveryResultSchema,
  n8nWorkflowPayloadSchema,
  newId,
  roleListSchema,
  secretWithValueSchema,
  type AutomationDto,
  type Id,
  type N8nWorkflowPayload,
  type SecretWithValueDto,
} from '@cellhive/contracts';
import { AutomationRunsRepository, orgScope, verifyWebhook, type Db } from '@cellhive/server-core';
import { buildTaskList, createWorker, type WorkerHandle } from '@cellhive/worker';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DB } from '../../src/common/tokens.js';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { buildRecordFixture, expectProblem, type RecordFixture } from './record-fixture.js';
import { captureLogger, startTestApp, type TestApp } from './support.js';

import type { AddressInfo, Socket } from 'node:net';

async function eventually<T>(
  probe: () => Promise<T | undefined | false>,
  label: string,
  timeoutMs = 45_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

interface Received {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: string;
}

/** A loopback "n8n": every request recorded, answered `200 { ok: true }`. */
interface FakeN8n {
  readonly port: number;
  readonly received: Received[];
  close(): Promise<void>;
}

async function startN8n(): Promise<FakeN8n> {
  const sockets = new Set<Socket>();
  const received: Received[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, echo: 'canary-n8n-response' }));
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: (server.address() as AddressInfo).port,
    received,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, 'close');
    },
  };
}

/**
 * BACKLOG T607 (SPEC §11.5, §13.3; CONTRACTS §21 "run_n8n_workflow";
 * ADR-25, ADR-35 §4) through the real API and worker: saving checks the
 * signing secret and the fields (P47: a field the saver cannot read), the
 * payload is built as `run_as` when the step runs (P47: u_sales1 — no
 * `cost` in `fields`/`fields_by_id`/`changes`, the linked customer with its
 * `id` and `title: null`), delivered through the outbox signed with
 * Standard Webhooks and the outbox headers; a `schedule` trigger sends
 * `record: null`; a payload over 1 MiB fails `http_request_too_large`;
 * the signing secret never leaves the outbox.
 */
describe('run_n8n_workflow action (T607)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let worker: WorkerHandle;
  let n8n: FakeN8n;
  let signing: SecretWithValueDto;
  let customerField: Id<'fld'>;
  let noteField: Id<'fld'>;
  let customer: Id<'rec'>;
  const workerLogs = captureLogger();

  const F = (name: string) => fx.fld[name]?.id as Id<'fld'>;
  const n8nUrl = (path = '/webhook/cellhive') => `http://n8n.test:${String(n8n.port)}${path}`;

  async function secret(body: Record<string, unknown>): Promise<SecretWithValueDto> {
    const response = await fx.call('owner', 'POST', `/orgs/${fx.orgId}/secrets`, {
      name: `Secret ${newId('sec').slice(4, 12)}`,
      // T701: HTTP secrets name the hosts they may go to (the fake n8n).
      ...(body['kind'] === 'telegram_bot'
        ? {}
        : { allowed_hosts: [`n8n.test:${String(n8n.port)}`] }),
      ...body,
    });
    expect(response.statusCode, response.body).toBe(201);
    return secretWithValueSchema.parse(response.json());
  }

  const saveAutomation = (user: 'u_admin' | 'u_sales1', definition: object, enabled = true) =>
    fx.call(user, 'POST', `/bases/${fx.baseId}/automations`, {
      name: `n8n ${newId('aut').slice(4, 12)}`,
      enabled,
      definition,
    });

  async function automation(
    definition: object,
    user: 'u_admin' | 'u_sales1' = 'u_admin',
  ): Promise<AutomationDto> {
    const response = await saveAutomation(user, definition);
    expect(response.statusCode, response.body).toBe(201);
    return automationSchema.parse(response.json());
  }

  async function disable(id: Id<'aut'>): Promise<void> {
    const response = await fx.call('u_admin', 'POST', `/automations/${id}/disable`);
    expect(response.statusCode, response.body).toBe(200);
  }

  async function createRecord(tableId: Id<'tbl'>, fields: Record<string, unknown>) {
    const response = await fx.call(
      'u_admin',
      'POST',
      `/tables/${tableId}/records?field_key_type=id`,
      { records: [{ fields }] },
    );
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ records: { id: Id<'rec'> }[] }>().records[0]?.id as Id<'rec'>;
  }

  async function updateOrder(record: Id<'rec'>, fields: Record<string, unknown>): Promise<void> {
    const response = await fx.call(
      'u_admin',
      'PATCH',
      `/tables/${fx.orders.id}/records/${record}?field_key_type=id`,
      { fields },
    );
    expect(response.statusCode, response.body).toBe(200);
  }

  interface RunRow {
    readonly id: Id<'run'>;
    readonly status: string;
    readonly error: Record<string, unknown> | null;
  }

  async function finishedRun(id: Id<'aut'>): Promise<RunRow> {
    return eventually(async () => {
      const { rows } = await sql<RunRow>`
        SELECT id, status, error FROM meta.automation_runs
         WHERE automation_id = ${id} AND status IN ('succeeded', 'failed', 'skipped')
         ORDER BY created_at, id
      `.execute(db.kysely);
      return rows[0];
    }, `run of ${id}`);
  }

  const n8nStep = (config: Record<string, unknown> = {}) => ({
    id: 'act_n8n',
    type: 'run_n8n_workflow',
    config: { url: { literal: n8nUrl() }, signing_secret_id: signing.id, ...config },
  });
  const onOrderUpdated = () => ({
    type: 'record.updated',
    table_id: fx.orders.id,
    watch_fields: [F('status')],
  });

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    fx = await buildRecordFixture(t, db);
    // Orders → Customers link, and a long text for the oversize payload.
    const link = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
      name: 'customer',
      type: 'link',
      options: { link_table: fx.customers.id },
    });
    expect(link.statusCode, link.body).toBe(201);
    customerField = link.json<{ id: Id<'fld'> }>().id;
    const note = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
      name: 'note',
      type: 'text',
      options: {},
    });
    expect(note.statusCode, note.body).toBe(201);
    noteField = note.json<{ id: Id<'fld'> }>().id;
    // The fixture variant of P29/P32 (P47): Sales `manage`s Orders and reads the link —
    // but neither `cost` nor the Customers table.
    const roles = roleListSchema.parse(
      (await fx.call('u_admin', 'GET', `/bases/${fx.baseId}/roles`)).json(),
    ).items;
    const sales = roles.find((role) => role.name === 'Sales');
    if (sales === undefined) throw new Error('no Sales role');
    const tables = sales.config.tables as Record<string, Record<string, unknown>>;
    const orders = tables[fx.orders.id] as Record<string, unknown>;
    const fieldRule = orders['field_rule'] as Record<string, unknown>;
    const patched = await fx.call('u_admin', 'PATCH', `/bases/${fx.baseId}/roles/${sales.id}`, {
      config: {
        ...sales.config,
        tables: {
          ...tables,
          [fx.orders.id]: {
            ...orders,
            perm: 'manage',
            field_rule: {
              ...fieldRule,
              fields: {
                ...(fieldRule['fields'] as Record<string, string>),
                [customerField]: 'read',
                [noteField]: 'read',
              },
            },
          },
        },
      },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    n8n = await startN8n();
    const allowed = await fx.call('owner', 'POST', `/orgs/${fx.orgId}/http-allowlist`, {
      pattern: `n8n.test:${String(n8n.port)}`,
    });
    expect(allowed.statusCode, allowed.body).toBe(201);
    signing = await secret({ kind: 'webhook_signing', generate: true });
    customer = await createRecord(fx.customers.id, { [F('customerName')]: 'canary-customer-name' });
    worker = await createWorker(t.config, {
      logger: workerLogs.logger,
      pollIntervalMs: 50,
      taskList: buildTaskList({
        config: t.config,
        db: t.app.get<Db>(DB),
        logger: workerLogs.logger,
        httpDelivery: { lookup: () => Promise.resolve(['127.0.0.1']) },
      }),
    });
  });

  afterAll(async () => {
    await worker.close();
    await n8n.close();
    await t.close();
    await db.destroy();
    await database.drop();
  });

  it('saves only valid steps: signing secret required and usable, P47 fields, fields need a record', async () => {
    const P = 'definition.actions[0].config';
    const codes = (response: Awaited<ReturnType<typeof saveAutomation>>) =>
      response
        .json<{ errors: { path: string; code: string }[] }>()
        .errors.map(({ path, code }) => ({ path, code }));
    const save = (step: object, user: 'u_admin' | 'u_sales1' = 'u_admin', trigger?: object) =>
      saveAutomation(user, { trigger: trigger ?? onOrderUpdated(), actions: [step] }, false);

    const missing = await save({
      id: 'act_n8n',
      type: 'run_n8n_workflow',
      config: { url: { literal: n8nUrl() } },
    });
    expect(missing.statusCode, missing.body).toBe(422);

    const header = await secret({ kind: 'http_header', value: 'Bearer canary-header-value' });
    const wrongKind = await save(n8nStep({ signing_secret_id: header.id }));
    expectProblem(wrongKind, 422, 'AUTOMATION_INVALID');
    expect(codes(wrongKind)).toEqual([
      { path: `${P}.signing_secret_id`, code: 'SECRET_NOT_USABLE' },
    ]);

    // P47: u_sales1 manages Orders but does not read `cost`.
    const p47 = await save(n8nStep({ fields: [F('title'), F('cost')] }), 'u_sales1');
    expectProblem(p47, 422, 'AUTOMATION_INVALID');
    expect(codes(p47)).toEqual([{ path: `${P}.fields[1]`, code: 'UNKNOWN_FIELD' }]);

    const schedule = { type: 'schedule', cron: '0 0 1 1 *', timezone: null };
    const noRecord = await save(n8nStep({ fields: [F('title')] }), 'u_admin', schedule);
    expectProblem(noRecord, 422, 'AUTOMATION_INVALID');
    expect(codes(noRecord)).toEqual([{ path: `${P}.fields`, code: 'NO_TRIGGER_RECORD' }]);

    const url = await save(n8nStep({ url: { literal: 'ftp://n8n.test/' } }));
    expectProblem(url, 422, 'AUTOMATION_INVALID');
    expect(codes(url)).toEqual([{ path: `${P}.url`, code: 'INVALID_URL' }]);

    const valid = await save(n8nStep());
    expect(valid.statusCode, valid.body).toBe(201);
    const id = automationSchema.parse(valid.json()).id;
    // The signing secret is now in use by the step.
    const usages = await fx.call('owner', 'GET', `/secrets/${signing.id}/usages`);
    expect(usages.json()).toMatchObject({ items: [{ automation_id: id }] });
    expect((await fx.call('u_admin', 'DELETE', `/automations/${id}`)).statusCode).toBe(204);
  });

  it('P47: run_as u_sales1 sends no cost and a customer without title; signed, with the outbox headers', async () => {
    const order = await createRecord(fx.orders.id, {
      [F('title')]: 'canary-order-title',
      [F('amount')]: 5,
      [F('cost')]: 777_123,
      [F('owner')]: [{ id: fx.users.u_sales1.id }],
      [customerField]: [customer],
    });
    const flow = await automation({ trigger: onOrderUpdated(), actions: [n8nStep()] }, 'u_sales1');
    expect(flow.run_as.id).toBe(fx.users.u_sales1.id);
    const before = n8n.received.length;
    const statusDone = 'Xong';
    await updateOrder(order, { [F('status')]: statusDone, [F('cost')]: 888_456 });
    const run = await finishedRun(flow.id);
    expect(run.status, JSON.stringify(run.error)).toBe('succeeded');
    expect(n8n.received.length - before).toBe(1);
    const received = n8n.received.at(-1) as Received;
    expect(received.method).toBe('POST');
    expect(received.url).toBe('/webhook/cellhive');
    expect(received.headers['content-type']).toBe('application/json');
    expect(received.headers['webhook-id']).toMatch(/^hdl_/u);
    expect(String(received.headers['idempotency-key'])).toMatch(
      new RegExp(`^${flow.id}:evt_[0-9A-Za-z]{16}:act_n8n$`, 'u'),
    );
    expect(typeof received.headers['x-cellhive-causation']).toBe('string');
    expect(String(received.headers['user-agent'])).toMatch(/^Cellhive\//u);
    // Signed with the generated `webhook_signing` secret (Standard Webhooks).
    expect(
      verifyWebhook(received.headers, received.body, [signing.value as string], new Date()),
    ).toEqual({ ok: true });

    const payload: N8nWorkflowPayload = n8nWorkflowPayloadSchema.parse(JSON.parse(received.body));
    expect(payload).toMatchObject({
      event: { type: 'record.updated' },
      automation: { id: flow.id, name: flow.name, run_id: run.id },
      base: { id: fx.baseId },
      table: { id: fx.orders.id, name: 'Orders' },
    });
    expect(payload.event.id).toMatch(/^evt_/u);
    const record = payload.record;
    if (record === null) throw new Error('no record');
    expect(record.id).toBe(order);
    expect(record.fields).toMatchObject({ title: 'canary-order-title', status: statusDone });
    expect(record.fields_by_id[F('title')]).toBe('canary-order-title');
    // P47: `cost` is in none of fields, fields_by_id, changes.
    expect(Object.keys(record.fields)).not.toContain('cost');
    expect(Object.keys(record.fields_by_id)).not.toContain(F('cost'));
    expect(Object.keys(payload.changes ?? {})).not.toContain('cost');
    expect(received.body).not.toContain('777123');
    expect(received.body).not.toContain('888456');
    // The customer: id kept, title null (u_sales1 does not read Customers, P20).
    expect(record.fields_by_id[customerField]).toEqual([{ id: customer, title: null }]);
    expect(received.body).not.toContain('canary-customer-name');
    // Only the readable change, in the `[@previous]` form (option by name).
    expect(payload.changes).toEqual({ status: { from: null, to: statusDone } });

    // The run detail: the delivery, never the response body (always hidden), URL or secret.
    const detail = await fx.call('u_admin', 'GET', `/automation-runs/${run.id}`);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.body).not.toContain(signing.value as string);
    const step = automationRunDetailSchema.parse(detail.json()).steps[0];
    expect(step).toMatchObject({
      action_type: 'run_n8n_workflow',
      status: 'succeeded',
      output: { status: 200, body: null },
      delivery: { target_host: 'n8n.test', status: 'succeeded', attempts: 1 },
    });
    expect(JSON.stringify(step)).not.toContain('canary-n8n-response');
    await disable(flow.id);
  });

  it('a schedule trigger sends record: null and table: null', async () => {
    const flow = await automation({
      trigger: { type: 'schedule', cron: '0 0 1 1 *', timezone: null },
      actions: [n8nStep()],
    });
    const runId = newId('run');
    const firedAt = new Date().toISOString();
    await new AutomationRunsRepository(db).insert(orgScope(fx.orgId), {
      id: runId,
      automationId: flow.id,
      automationVersion: flow.version,
      triggerEventId: null,
      triggerUnit: newId('evt'),
      status: 'queued',
      depth: 0,
      input: {
        automation_version: flow.version,
        definition: flow.definition as never,
        trigger: {
          event_id: null,
          event_created_at: null,
          type: 'schedule',
          table_id: null,
          record_id: null,
          bulk: false,
          batch: null,
          data: { fired_at: firedAt },
        },
      },
    });
    const before = n8n.received.length;
    await sql`SELECT graphile_worker.add_job('automation.run',
      ${JSON.stringify({ organization_id: fx.orgId, run_id: runId })}::json)`.execute(db.kysely);
    const run = await finishedRun(flow.id);
    expect(run.status, JSON.stringify(run.error)).toBe('succeeded');
    expect(n8n.received.length - before).toBe(1);
    const received = n8n.received.at(-1) as Received;
    expect(
      verifyWebhook(received.headers, received.body, [signing.value as string], new Date()),
    ).toEqual({ ok: true });
    const payload = n8nWorkflowPayloadSchema.parse(JSON.parse(received.body));
    expect(payload).toMatchObject({
      event: { id: null, type: 'schedule', created_at: firedAt },
      automation: { id: flow.id, run_id: runId },
      table: null,
      record: null,
      changes: null,
    });
    await disable(flow.id);
  });

  it('T616: record.deleted sends record: null and event.entity_id = the deleted record', async () => {
    const flow = await automation({
      trigger: { type: 'record.deleted', table_id: fx.orders.id },
      actions: [n8nStep()],
    });
    const order = await createRecord(fx.orders.id, { [F('title')]: 'to delete' });
    const before = n8n.received.length;
    const removed = await fx.call('u_admin', 'DELETE', `/tables/${fx.orders.id}/records/${order}`);
    expect(removed.statusCode, removed.body).toBe(204);
    const run = await finishedRun(flow.id);
    expect(run.status, JSON.stringify(run.error)).toBe('succeeded');
    expect(n8n.received.length - before).toBe(1);
    const payload = n8nWorkflowPayloadSchema.parse(
      JSON.parse((n8n.received.at(-1) as Received).body),
    );
    expect(payload.event).toMatchObject({ type: 'record.deleted', entity_id: order });
    expect(payload.record).toBeNull();
    await disable(flow.id);
  });

  it('a payload over 1 MiB fails the step http_request_too_large, nothing is sent', async () => {
    const flow = await automation({
      trigger: { type: 'record.created', table_id: fx.orders.id },
      actions: [n8nStep({ fields: [F('title'), noteField] })],
    });
    const before = n8n.received.length;
    // The note is sent twice (`fields` and `fields_by_id`): 1.2 MB of JSON.
    await createRecord(fx.orders.id, {
      [F('title')]: 'big',
      [noteField]: 'x'.repeat(600 * 1024),
    });
    const run = await finishedRun(flow.id);
    expect(run.status).toBe('failed');
    expect(run.error).toMatchObject({ code: 'http_request_too_large', step: 'act_n8n' });
    expect(n8n.received.length - before).toBe(0);
    await disable(flow.id);
  });

  it('T616: "Send a test" of a run_n8n_workflow step — payload as the caller, signed, read by the sender only', async () => {
    const order = await createRecord(fx.orders.id, {
      [F('title')]: 'canary-test-title',
      [F('cost')]: 654_321,
      [F('owner')]: [{ id: fx.users.u_sales1.id }],
      [customerField]: [customer],
    });
    const flow = await automation({ trigger: onOrderUpdated(), actions: [n8nStep()] });
    await disable(flow.id);
    const testOf = (
      user: 'u_admin' | 'u_sales1' | 'u_editor' | 'u_reader',
      body: Record<string, unknown>,
      actionId = 'act_n8n',
    ) => fx.call(user, 'POST', `/automations/${flow.id}/actions/${actionId}/http-test`, body);
    const resultOf = (user: 'u_admin' | 'u_sales1', id: Id<'hdl'>) =>
      eventually(async () => {
        const response = await fx.call(user, 'GET', `/http-deliveries/${id}`);
        const body = httpDeliveryResultSchema.parse(response.json());
        return ['succeeded', 'failed'].includes(body.status) ? body : undefined;
      }, 'test delivery');

    // u_sales1 (manages Orders, no `cost`, no Customers): their own permissions, not run_as's.
    const before = n8n.received.length;
    const accepted = await testOf('u_sales1', { record_id: order });
    expect(accepted.statusCode, accepted.body).toBe(202);
    expect(accepted.json()).toMatchObject({ warnings: [] });
    const deliveryId = accepted.json<{ delivery_id: Id<'hdl'> }>().delivery_id;
    expect(await resultOf('u_sales1', deliveryId)).toMatchObject({
      kind: 'test',
      status: 'succeeded',
      target_host: 'n8n.test',
    });
    expect(n8n.received.length - before).toBe(1);
    const received = n8n.received.at(-1) as Received;
    expect(
      verifyWebhook(received.headers, received.body, [signing.value as string], new Date()),
    ).toEqual({ ok: true });
    expect(received.headers['x-cellhive-causation']).toBeUndefined();
    const payload = n8nWorkflowPayloadSchema.parse(JSON.parse(received.body));
    expect(payload).toMatchObject({
      event: { id: null, type: 'record.updated' },
      automation: { id: flow.id, name: flow.name, run_id: '' },
      base: { id: fx.baseId },
      table: { id: fx.orders.id, name: 'Orders' },
      changes: null,
    });
    expect(payload.record?.id).toBe(order);
    expect(payload.record?.fields).toMatchObject({ title: 'canary-test-title' });
    expect(Object.keys(payload.record?.fields ?? {})).not.toContain('cost');
    expect(received.body).not.toContain('654321');
    expect(payload.record?.fields_by_id[customerField]).toEqual([{ id: customer, title: null }]);
    expect(received.body).not.toContain('canary-customer-name');
    // Only the sender reads the result.
    expect((await fx.call('u_admin', 'GET', `/http-deliveries/${deliveryId}`)).statusCode).toBe(
      404,
    );

    // The admin's draft (unsaved fields list) is what is sent.
    const draft = await testOf('u_admin', {
      record_id: order,
      draft: {
        url: { literal: n8nUrl('/webhook/draft') },
        signing_secret_id: signing.id,
        fields: [F('title'), F('cost')],
      },
    });
    expect(draft.statusCode, draft.body).toBe(202);
    await resultOf('u_admin', draft.json<{ delivery_id: Id<'hdl'> }>().delivery_id);
    const sent = n8n.received.at(-1) as Received;
    expect(sent.url).toBe('/webhook/draft');
    expect(
      Object.keys(n8nWorkflowPayloadSchema.parse(JSON.parse(sent.body)).record?.fields ?? {}),
    ).toEqual(['title', 'cost']);

    // u_sales1's draft listing `cost`: checked as a save by them (P47).
    expectProblem(
      await testOf('u_sales1', {
        draft: { url: { literal: n8nUrl() }, signing_secret_id: signing.id, fields: [F('cost')] },
      }),
      422,
      'AUTOMATION_INVALID',
    );
    // A draft of another type than the saved step is not that step.
    expect(
      (
        await testOf('u_admin', {
          draft: { method: 'POST', url: { literal: n8nUrl() } },
        })
      ).statusCode,
    ).toBe(404);
    // A record u_sales1 does not read → 404; not a manager → 403.
    const hidden = await createRecord(fx.orders.id, { [F('title')]: 'not for sales' });
    expect((await testOf('u_sales1', { record_id: hidden })).statusCode).toBe(404);
    expectProblem(await testOf('u_editor', {}), 403, 'PERMISSION_DENIED');
  });

  it('canaries: the signing secret and record values never reach logs, audit, events, jobs or deliveries', async () => {
    const value = signing.value as string;
    expect(t.logs.raw()).not.toContain(value);
    expect(workerLogs.logs.raw()).not.toContain(value);
    expect(workerLogs.logs.raw()).not.toContain('canary-order-title');
    const { rows } = await sql<{ everything: string; outbox: string }>`
      SELECT (SELECT coalesce(string_agg(row_to_json(a)::text, ''), '') FROM meta.audit_logs a) ||
             (SELECT coalesce(string_agg(row_to_json(e)::text, ''), '') FROM meta.events e) AS everything,
             (SELECT coalesce(string_agg(row_to_json(d)::text, ''), '') FROM meta.http_deliveries d) ||
             (SELECT coalesce(string_agg(row_to_json(s)::text, ''), '') FROM meta.automation_run_steps s) ||
             (SELECT coalesce(string_agg(j.payload::text, ''), '') FROM graphile_worker._private_jobs j)
               AS outbox
    `.execute(db.kysely);
    expect(rows[0]?.everything ?? '').not.toContain(value);
    const outbox = rows[0]?.outbox ?? '';
    expect(outbox.length).toBeGreaterThan(0);
    for (const canary of [value, 'canary-order-title']) {
      expect(outbox).not.toContain(canary);
    }
    const { rows: open } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM meta.http_deliveries
       WHERE status IN ('succeeded', 'failed', 'cancelled') AND request_enc IS NOT NULL
    `.execute(db.kysely);
    expect(open[0]?.n).toBe(0);
  });
});
