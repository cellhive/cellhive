import {
  createdApiTokenSchema,
  createdShareLinkSchema,
  fieldSchema,
  jobSchema,
  roleListSchema,
  type ApiTokenScope,
  type CreatedApiToken,
  type FieldDto,
  type Id,
  type RealtimeServerMessage,
  type RoleDto,
} from '@cellhive/contracts';
import { type Db, type RealtimePublisher } from '@cellhive/server-core';
import { startFakeOpenAiServer, type FakeOpenAiServer } from '@cellhive/server-core/testing';
import { buildTaskList, createWorker, type WorkerHandle } from '@cellhive/worker';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ApiRateLimits } from '../../src/common/rate-limit/api-rate-limits.js';
import { REALTIME_BUS } from '../../src/common/tokens.js';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { closeSockets, listen, TestSocket } from './realtime-support.js';
import { buildRecordFixture, type FixtureUser, type RecordFixture } from './record-fixture.js';
import { captureLogger, startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

const DAY_MS = 86_400_000;
const LOCALHOST = () => Promise.resolve(['127.0.0.1']);
const PROMPT = 'Tóm tắt {{ [title] }} — chi phí {{ [cost] }}';
const INSTRUCTIONS = 'Một câu, giọng trung tính, không nêu khách hàng.';
const CONV_PROMPT = 'Một dòng về {{ [title] }} và {{ [cost] }}';
/** Words of the prompts and instructions: none may reach a reader without the whole configuration. */
const CONFIG_WORDS = ['Tóm tắt', 'chi phí', 'Một dòng', 'giọng trung tính', '{{', '#REF'];
const ACCEPT = 'application/json, text/event-stream';

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
type Actor = 'u_reader' | 'u_editor' | 'manager' | 'u_admin' | 'tk_sales_r';
type Response = LightMyRequestResponse;

/**
 * BACKLOG T1006 (Quyết định S9 #14, #15; CONTRACTS §5 P111, P112, §29.5):
 * who reads the configuration of an AI field, on every output path of the
 * appendix S9 — the field list, one field, the answers of `POST`, `PATCH`,
 * the `202` of `PUT`, `convert-preview`, revert (and restore as a new
 * field), the field trash (list and restore), `schema.changed`, the share
 * link and MCP `describe_table` — for each actor: u_reader, u_editor, the
 * "Sales manager" (the Sales role with Orders `manage`, `cost: no_perm`, so
 * locked out of `ai_note`; a direct role of u_sales2 so that u_sales1 keeps
 * plain Sales for `tk_sales_r`), u_admin, the anonymous viewer of `shl_V`
 * (u_editor's link) and `tk_sales_r` (u_sales1, `records:read` +
 * `schema:read`, REST, WebSocket and MCP). Only u_admin gets the whole
 * `options.ai` (prompt in names, `instructions`, `auto_update`,
 * `max_output_tokens`) and `ai_state`; everyone else gets `{ task }` and no
 * `ai_state` key, and no response of theirs holds a word of the prompt.
 * T1007 adds P113–P117 to this file.
 *
 * Fixture: one API instance listening (WebSocket, MCP), a real worker
 * (`field.convert`, the AI runner) on the app's realtime bus, the fake
 * OpenAI-compatible provider on loopback with its allowlist entry, AI with
 * record data on; `ai_note` (text, `PROMPT`, `INSTRUCTIONS`,
 * `auto_update: false`) on Orders r1 (u_sales1), r2 (u_sales2), r3.
 */
describe('permission matrix S9 — AI field configuration (T1006)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let fake: FakeOpenAiServer;
  let worker: WorkerHandle;
  let http: string;
  let ws: string;
  let note: FieldDto;
  let conv: FieldDto;
  let viwAi: Id<'viw'>;
  const sockets: TestSocket[] = [];
  const tk = {} as Record<'sales_r' | 'admin_schema', CreatedApiToken>;

  const user = (actor: Exclude<Actor, 'tk_sales_r'>): FixtureUser =>
    actor === 'manager' ? 'u_sales2' : actor;

  /** A request of `actor`: session cookie, or `tk_sales_r` as a Bearer token. */
  async function as(actor: Actor, method: Method, path: string, body?: unknown) {
    if (actor !== 'tk_sales_r') return fx.call(user(actor), method, path, body);
    return t.app.inject({
      method,
      url: `/api/v1${path}`,
      headers: { authorization: `Bearer ${tk.sales_r.token}` },
      ...(body === undefined ? {} : { payload: body as object }),
    });
  }

  function ok(response: Response, status = 200): Response {
    expect(response.statusCode, response.body).toBe(status);
    return response;
  }

  function expectProblem(response: Response, status: number, code: string): void {
    expect(
      { status: response.statusCode, code: response.json<{ code?: string }>().code },
      response.body,
    ).toEqual({ status, code });
  }

  /** Nothing of the configuration (prompt, instructions, source ids) in `text`. */
  function expectNoConfig(text: string, sources: readonly Id<'fld'>[] = sourcesOf()): void {
    for (const word of CONFIG_WORDS) expect(text).not.toContain(word);
    for (const id of sources) expect(text).not.toContain(id);
  }

  const sourcesOf = () => [F('title'), F('cost')];
  const F = (name: string): Id<'fld'> => {
    const id = fx.fld[name]?.id;
    if (id === undefined) throw new Error(`no field ${name}`);
    return id;
  };

  /** u_admin's view of an AI field: the whole configuration, names, `ai_state`. */
  function expectWhole(
    field: FieldDto | undefined,
    expected: { prompt: string; instructions?: string | null; auto_update?: boolean },
  ): void {
    expect(field?.options['ai']).toEqual({
      task: 'summarize',
      prompt: expected.prompt,
      instructions: expected.instructions ?? null,
      auto_update: expected.auto_update ?? false,
      max_output_tokens: 300,
    });
    expect(field).toHaveProperty('ai_state');
  }

  /** Every other reader: `{ task }`, no `ai_state` key, nothing of the prompt. */
  function expectRedacted(field: FieldDto | undefined): void {
    expect(field).toBeDefined();
    expect(field?.options['ai']).toEqual({ task: 'summarize' });
    expect(field).not.toHaveProperty('ai_state');
    expectNoConfig(JSON.stringify({ ...field, id: undefined, table_id: undefined }));
  }

  const itemOf = (response: Response, id: Id<'fld'>) =>
    ok(response)
      .json<{ items: FieldDto[] }>()
      .items.find((item) => item.id === id);

  async function createToken(owner: FixtureUser, scopes: ApiTokenScope[]) {
    const response = ok(
      await fx.call(owner, 'POST', `/orgs/${fx.orgId}/me/api-tokens`, {
        name: `${owner} ${scopes.join(' ')}`,
        scopes,
        expires_at: new Date(Date.now() + 30 * DAY_MS).toISOString(),
      }),
      201,
    );
    return createdApiTokenSchema.parse(response.json());
  }

  /** Polls until `check` returns a value (jobs run in the worker). */
  async function eventually<T>(check: () => Promise<T | undefined>, ms = 60_000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await check();
      if (value !== undefined) return value;
      if (Date.now() > deadline) throw new Error('eventually: timed out');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  const jobDone = (jobId: Id<'job'>) =>
    eventually(async () => {
      const job = jobSchema.parse((await fx.call('u_admin', 'GET', `/jobs/${jobId}`)).json());
      return job.status === 'succeeded' || job.status === 'failed' ? job : undefined;
    });

  /** An AI text field to a select, by u_admin, until its values are converted. */
  async function convertToSelect(fieldId: Id<'fld'> = conv.id): Promise<Response> {
    const response = ok(
      await fx.call('u_admin', 'PUT', `/fields/${fieldId}`, {
        type: 'select',
        options: { multiple: false, options: [{ name: 'A', color: 1 }] },
        confirm: true,
      }),
      202,
    );
    const jobId = response.json<{ job_id: Id<'job'> | null }>().job_id;
    if (jobId !== null) expect((await jobDone(jobId)).status).toBe('succeeded');
    return response;
  }

  async function socketOf(actor: Actor): Promise<TestSocket> {
    const socket = await TestSocket.connect(ws, {
      origin: TEST_PUBLIC_URL,
      ...(actor === 'tk_sales_r'
        ? { authorization: `Bearer ${tk.sales_r.token}` }
        : { cookie: await fx.cookie(user(actor)) }),
    });
    sockets.push(socket);
    expect(await socket.subscribe(`table:${fx.orders.id}`, `s-${actor}`)).toMatchObject({
      type: 'subscribed',
    });
    return socket;
  }

  /** One MCP tool call as JSON-RPC over HTTP (stateless, no SDK). */
  async function mcp(token: CreatedApiToken, name: string, args: Record<string, unknown>) {
    const response = await fetch(`${http}/api/v1/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: ACCEPT,
        authorization: `Bearer ${token.token}`,
        'mcp-protocol-version': '2025-06-18',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    const text = await response.text();
    expect(response.status, text).toBe(200);
    return {
      text,
      result: (JSON.parse(text) as { result: { isError?: boolean; structuredContent: unknown } })
        .result,
    };
  }

  const fieldChanged = (fieldId: Id<'fld'>) => (message: RealtimeServerMessage) =>
    message.type === 'schema.changed' && message.entity_id === fieldId;

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url }, { outboundLookup: LOCALHOST });
    ws = await listen(t.app);
    http = ws.replace('ws://', 'http://').replace(/\/ws$/u, '');
    fx = await buildRecordFixture(t, db);
    t.app.get(ApiRateLimits).ai = { limit: 10_000, windowSeconds: 60 };
    fake = await startFakeOpenAiServer();

    ok(
      await fx.call('owner', 'POST', `/orgs/${fx.orgId}/http-allowlist`, {
        pattern: `localhost:${String(fake.port)}`,
      }),
      201,
    );
    ok(
      await fx.call('owner', 'PUT', `/orgs/${fx.orgId}/ai-settings`, {
        enabled: true,
        provider_base_url: fake.baseUrl,
        model: 'fake-model',
      }),
    );
    ok(
      await fx.call('owner', 'PUT', `/orgs/${fx.orgId}/ai-settings`, {
        allow_record_data: true,
        confirm: true,
      }),
    );
    ok(
      await fx.call('owner', 'PATCH', `/orgs/${fx.orgId}`, {
        settings: { mcp: { enabled: true } },
      }),
    );

    // r1 (u_sales1), r2 (u_sales2), r3: the rows the queue of `ai_note` takes in P112.
    ok(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/records?typecast=true`, {
        records: [
          {
            fields: {
              title: 'Máy POS lỗi in',
              amount: 100,
              cost: 10,
              owner: [{ id: fx.users.u_sales1.id }],
            },
          },
          {
            fields: {
              title: 'Wifi chập chờn',
              amount: 200,
              cost: 20,
              owner: [{ id: fx.users.u_sales2.id }],
            },
          },
          { fields: { title: 'Đổi máy in', amount: 300, cost: 30 } },
        ],
      }),
      201,
    );

    // "Sales manager": the Sales role with Orders `manage` (`cost` stays `no_perm`), u_sales2's
    // direct role — a direct role wins over the group's (u_sales1 keeps plain Sales).
    const sales = roleListSchema
      .parse(ok(await fx.call('u_admin', 'GET', `/bases/${fx.baseId}/roles`)).json())
      .items.find((role) => role.name === 'Sales') as RoleDto;
    const tables = structuredClone(sales.config.tables) as Record<string, Record<string, unknown>>;
    tables[fx.orders.id] = { ...tables[fx.orders.id], perm: 'manage' };
    const manager = ok(
      await fx.call('owner', 'POST', `/bases/${fx.baseId}/roles`, {
        name: 'Sales quản lý',
        config: { ...sales.config, tables },
      }),
      201,
    ).json<{ id: Id<'rol'> }>().id;
    ok(
      await fx.call('owner', 'PUT', `/bases/${fx.baseId}/role-assignments`, {
        principal_type: 'user',
        principal_id: fx.users.u_sales2.id,
        role_id: manager,
      }),
    );

    note = fieldSchema.parse(
      ok(
        await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
          name: 'ai_note',
          type: 'text',
          options: {
            ai: {
              task: 'summarize',
              prompt: PROMPT,
              instructions: INSTRUCTIONS,
              auto_update: false,
            },
          },
        }),
        201,
      ).json(),
    );
    conv = fieldSchema.parse(
      ok(
        await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
          name: 'ai_conv',
          type: 'text',
          options: { ai: { task: 'summarize', prompt: CONV_PROMPT, auto_update: false } },
        }),
        201,
      ).json(),
    );
    viwAi = ok(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/views`, {
        name: 'viw_ai',
        type: 'grid',
      }),
      201,
    ).json<{ id: Id<'viw'> }>().id;

    tk.sales_r = await createToken('u_sales1', ['records:read', 'schema:read']);
    tk.admin_schema = await createToken('u_admin', ['schema:read']);

    const { logger } = captureLogger();
    worker = await createWorker(t.config, {
      logger,
      pollIntervalMs: 50,
      taskList: buildTaskList({
        config: t.config,
        db,
        logger,
        realtime: t.app.get<RealtimePublisher>(REALTIME_BUS),
        ai: { lookup: LOCALHOST },
      }),
    });
  }, 180_000);

  afterAll(async () => {
    await closeSockets(sockets);
    await worker.close();
    await fake.close();
    await t.close();
    await db.destroy();
    await database.drop();
  });

  // --- P111 -----------------------------------------------------------------------------------

  it('P111 list: GET /tables/Orders/fields — the whole options.ai for u_admin only, { task } for the others', async () => {
    const path = `/tables/${fx.orders.id}/fields`;
    expectWhole(itemOf(await as('u_admin', 'GET', path), note.id), {
      prompt: PROMPT,
      instructions: INSTRUCTIONS,
    });
    for (const actor of ['u_reader', 'u_editor', 'manager', 'tk_sales_r'] as const) {
      expectRedacted(itemOf(await as(actor, 'GET', path), note.id));
    }
    // Only the readers who cannot read `cost` are locked out of its values.
    const locked = async (actor: Actor) => itemOf(await as(actor, 'GET', path), note.id)?.locked;
    expect(await locked('u_reader')).toBe(false);
    expect(await locked('u_editor')).toBe(false);
    expect(await locked('manager')).toBe(true);
    expect(await locked('tk_sales_r')).toBe(true);
    // A token of u_admin reads it like u_admin.
    const viaToken = await t.app.inject({
      method: 'GET',
      url: `/api/v1${path}`,
      headers: { authorization: `Bearer ${tk.admin_schema.token}` },
    });
    expectWhole(itemOf(viaToken, note.id), { prompt: PROMPT, instructions: INSTRUCTIONS });
  });

  it('P111 get: GET /fields/ai_note — the whole options.ai for u_admin only; 404 outside the base', async () => {
    const path = `/fields/${note.id}`;
    expectWhole(fieldSchema.parse(ok(await as('u_admin', 'GET', path)).json()), {
      prompt: PROMPT,
      instructions: INSTRUCTIONS,
    });
    for (const actor of ['u_reader', 'u_editor', 'manager', 'tk_sales_r'] as const) {
      expectRedacted(fieldSchema.parse(ok(await as(actor, 'GET', path)).json()));
    }
    for (const outsider of ['u_out', 'stranger'] as const) {
      const response = await fx.call(outsider, 'GET', path);
      expectProblem(response, 404, 'NOT_FOUND');
      expectNoConfig(response.body);
    }
  });

  it('P111 create: the answer of POST /tables/Orders/fields — the creator reads every source; 403/422 say nothing', async () => {
    const path = `/tables/${fx.orders.id}/fields`;
    const body = (name: string, prompt: string) => ({
      name,
      type: 'text',
      options: { ai: { task: 'summarize', prompt, instructions: INSTRUCTIONS } },
    });
    const admin = fieldSchema.parse(
      ok(await as('u_admin', 'POST', path, body('ai_admin', PROMPT)), 201).json(),
    );
    expectWhole(admin, { prompt: PROMPT, instructions: INSTRUCTIONS, auto_update: true });
    // The Sales manager may only name what they read: `cost` does not exist for them.
    const hidden = await as('manager', 'POST', path, body('ai_manager_cost', PROMPT));
    expectProblem(hidden, 422, 'VALIDATION_FAILED');
    expect(hidden.json<{ errors: { code: string }[] }>().errors[0]?.code).toBe('UNKNOWN_FIELD');
    expect(hidden.body).not.toContain(F('cost'));
    const own = fieldSchema.parse(
      ok(
        await as('manager', 'POST', path, body('ai_manager', 'Tóm tắt {{ [title] }}')),
        201,
      ).json(),
    );
    expect(own.options['ai']).toMatchObject({
      prompt: 'Tóm tắt {{ [title] }}',
      instructions: INSTRUCTIONS,
    });
    expect(own).toHaveProperty('ai_state');
    // …and u_admin reads that one whole too, the others `{ task }`.
    expectWhole(fieldSchema.parse(ok(await as('u_admin', 'GET', `/fields/${own.id}`)).json()), {
      prompt: 'Tóm tắt {{ [title] }}',
      instructions: INSTRUCTIONS,
      auto_update: true,
    });
    for (const actor of ['u_reader', 'u_editor'] as const) {
      const field = fieldSchema.parse(ok(await as(actor, 'GET', `/fields/${own.id}`)).json());
      expect(field.options['ai']).toEqual({ task: 'summarize' });
      expect(field).not.toHaveProperty('ai_state');
    }
    for (const actor of ['u_reader', 'u_editor'] as const) {
      const response = await as(actor, 'POST', path, body(`ai_${actor}`, PROMPT));
      expectProblem(response, 403, 'PERMISSION_DENIED');
      expectNoConfig(response.body);
    }
    const token = await as('tk_sales_r', 'POST', path, body('ai_token', PROMPT));
    expectProblem(token, 403, 'INSUFFICIENT_SCOPE');
    expectNoConfig(token.body);
    for (const id of [admin.id, own.id]) ok(await as('u_admin', 'DELETE', `/fields/${id}`), 204);
  });

  it('P111 patch: the answer of PATCH /fields/ai_note — the Sales manager renames it and gets { task }', async () => {
    const path = `/fields/${note.id}`;
    const manager = await as('manager', 'PATCH', path, { description: 'Ghi chú do AI viết' });
    expectRedacted(fieldSchema.parse(ok(manager).json()));
    expect(manager.json()).toMatchObject({ description: 'Ghi chú do AI viết', locked: true });
    // Its AI settings stay out of reach (CONTRACTS §29.5).
    const refused = await as('manager', 'PATCH', path, {
      options: { ai: { task: 'custom', prompt: '{{ [title] }}' } },
    });
    expectProblem(refused, 403, 'PERMISSION_DENIED');
    expectNoConfig(refused.body);
    const admin = fieldSchema.parse(
      ok(await as('u_admin', 'PATCH', path, { description: null })).json(),
    );
    expectWhole(admin, { prompt: PROMPT, instructions: INSTRUCTIONS });
    for (const actor of ['u_reader', 'u_editor'] as const) {
      const response = await as(actor, 'PATCH', path, { description: 'x' });
      expectProblem(response, 403, 'PERMISSION_DENIED');
      expectNoConfig(response.body);
    }
    const token = await as('tk_sales_r', 'PATCH', path, { description: 'x' });
    expectProblem(token, 403, 'INSUFFICIENT_SCOPE');
    expectNoConfig(token.body);
  });

  it('P111 convert-preview: POST /fields/ai_conv/convert-preview — no configuration in any answer', async () => {
    const path = `/fields/${conv.id}/convert-preview`;
    const body = {
      type: 'select',
      options: { multiple: false, options: [{ name: 'A', color: 1 }] },
    };
    const admin = ok(await as('u_admin', 'POST', path, body));
    expectNoConfig(admin.body);
    expect(admin.body).not.toContain('"ai"');
    for (const actor of ['u_reader', 'u_editor', 'manager'] as const) {
      const response = await as(actor, 'POST', path, body);
      expectProblem(response, 403, 'PERMISSION_DENIED');
      expectNoConfig(response.body);
    }
    const token = await as('tk_sales_r', 'POST', path, body);
    expectProblem(token, 403, 'INSUFFICIENT_SCOPE');
    expectNoConfig(token.body);
  });

  it('P111 put: the 202 of PUT /fields/ai_conv — the prompt in names, never with ids; refused before anything for the others', async () => {
    const body = {
      type: 'select',
      options: { multiple: false, options: [{ name: 'A', color: 1 }] },
      confirm: true,
    };
    for (const actor of ['u_reader', 'u_editor', 'manager'] as const) {
      const response = await as(actor, 'PUT', `/fields/${conv.id}`, body);
      expectProblem(response, 403, 'PERMISSION_DENIED');
      expectNoConfig(response.body);
    }
    const token = await as('tk_sales_r', 'PUT', `/fields/${conv.id}`, body);
    expectProblem(token, 403, 'INSUFFICIENT_SCOPE');
    expectNoConfig(token.body);
    const accepted = await convertToSelect();
    const field = accepted.json<{ field: FieldDto }>().field;
    expect(accepted.body).not.toContain(F('title'));
    expect(accepted.body).not.toContain(F('cost'));
    // The field as the conversion started (its old definition): the AI text field, in names.
    expect(field.type).toBe('text');
    expectWhole(field, { prompt: CONV_PROMPT });
  });

  it('P111 revert: POST /fields/ai_conv/revert-conversion — u_admin gets the whole options.ai, the Sales manager { task }', async () => {
    const path = `/fields/${conv.id}/revert-conversion`;
    for (const actor of ['u_reader', 'u_editor'] as const) {
      const response = await as(actor, 'POST', path, {
        mode: 'overwrite_later_edits',
        confirm: true,
      });
      expectProblem(response, 403, 'PERMISSION_DENIED');
      expectNoConfig(response.body);
    }
    const token = await as('tk_sales_r', 'POST', path, {
      mode: 'overwrite_later_edits',
      confirm: true,
    });
    expectProblem(token, 403, 'INSUFFICIENT_SCOPE');
    // The Sales manager reverts the conversion u_admin made: the AI field comes back as `{ task }`.
    const manager = fieldSchema.parse(
      ok(
        await as('manager', 'POST', path, { mode: 'overwrite_later_edits', confirm: true }),
      ).json(),
    );
    expect(manager.type).toBe('text');
    expectRedacted(manager);
    // Converted again, u_admin reverts it: the whole configuration, in names.
    await convertToSelect();
    const admin = fieldSchema.parse(
      ok(
        await as('u_admin', 'POST', path, { mode: 'overwrite_later_edits', confirm: true }),
      ).json(),
    );
    expect(admin.type).toBe('text');
    expectWhole(admin, { prompt: CONV_PROMPT });
  });

  it('P111 restore: revert-conversion as a new field — the old AI field for u_admin whole, for the Sales manager { task }', async () => {
    const restore = (actor: Actor, fieldId: Id<'fld'>, name: string) =>
      as(actor, 'POST', `/fields/${fieldId}/revert-conversion`, { mode: 'new_field', name });
    await convertToSelect();
    for (const actor of ['u_reader', 'u_editor'] as const) {
      const response = await restore(actor, conv.id, `ai_conv (${actor})`);
      expectProblem(response, 403, 'PERMISSION_DENIED');
      expectNoConfig(response.body);
    }
    const admin = fieldSchema.parse(
      ok(await restore('u_admin', conv.id, 'ai_conv (u_admin)')).json(),
    );
    expect(admin.id).not.toBe(conv.id);
    expect(admin.type).toBe('text');
    expectWhole(admin, { prompt: CONV_PROMPT });
    // The restored AI field, converted in turn; the Sales manager restores it as a new field.
    await convertToSelect(admin.id);
    const manager = fieldSchema.parse(
      ok(await restore('manager', admin.id, 'ai_conv (manager)')).json(),
    );
    expect(manager.type).toBe('text');
    expectRedacted(manager);
    for (const actor of ['u_reader', 'u_editor', 'tk_sales_r'] as const) {
      expectRedacted(fieldSchema.parse(ok(await as(actor, 'GET', `/fields/${manager.id}`)).json()));
    }
    expectWhole(fieldSchema.parse(ok(await as('u_admin', 'GET', `/fields/${manager.id}`)).json()), {
      prompt: CONV_PROMPT,
    });
    for (const id of [admin.id, manager.id])
      ok(await as('u_admin', 'DELETE', `/fields/${id}`), 204);
  });

  it('P111 trash: GET …/fields?include_deleted=true and POST /fields/:id/restore — managers only, whole for u_admin', async () => {
    const trashed = fieldSchema.parse(
      ok(
        await as('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
          name: 'ai_trash',
          type: 'text',
          options: { ai: { task: 'summarize', prompt: PROMPT, instructions: INSTRUCTIONS } },
        }),
        201,
      ).json(),
    );
    ok(await as('u_admin', 'DELETE', `/fields/${trashed.id}`), 204);
    const list = `/tables/${fx.orders.id}/fields?include_deleted=true`;
    const adminItem = itemOf(await as('u_admin', 'GET', list), trashed.id);
    expect(adminItem).toHaveProperty('deleted_at');
    expect(adminItem?.options['ai']).toMatchObject({ prompt: PROMPT, instructions: INSTRUCTIONS });
    const managerItem = itemOf(await as('manager', 'GET', list), trashed.id);
    expect(managerItem).toHaveProperty('deleted_at');
    expectRedacted(managerItem);
    for (const actor of ['u_reader', 'u_editor', 'tk_sales_r'] as const) {
      const response = await as(actor, 'GET', list);
      expect(response.statusCode, response.body).toBe(403);
      expectNoConfig(response.body);
    }
    for (const actor of ['u_reader', 'u_editor'] as const) {
      const response = await as(actor, 'POST', `/fields/${trashed.id}/restore`);
      expectProblem(response, 404, 'NOT_FOUND');
      expectNoConfig(response.body);
    }
    const manager = fieldSchema.parse(
      ok(await as('manager', 'POST', `/fields/${trashed.id}/restore`)).json(),
    );
    expectRedacted(manager);
    ok(await as('u_admin', 'DELETE', `/fields/${trashed.id}`), 204);
    const admin = fieldSchema.parse(
      ok(await as('u_admin', 'POST', `/fields/${trashed.id}/restore`)).json(),
    );
    expectWhole(admin, { prompt: PROMPT, instructions: INSTRUCTIONS, auto_update: true });
    ok(await as('u_admin', 'DELETE', `/fields/${trashed.id}`), 204);
  });

  it('P111 schema.changed: a change of ai_note reaches every reader as ids and an action only', async () => {
    const actors = ['u_reader', 'u_editor', 'manager', 'u_admin', 'tk_sales_r'] as const;
    const watching = await Promise.all(actors.map((actor) => socketOf(actor)));
    ok(await as('u_admin', 'PATCH', `/fields/${note.id}`, { name: 'ai_note', description: 'v2' }));
    for (const [index, socket] of watching.entries()) {
      const message = await socket.next(fieldChanged(note.id));
      expect(message, actors[index]).toEqual({
        type: 'schema.changed',
        channel: `table:${fx.orders.id}`,
        entity: 'field',
        entity_id: note.id,
        action: 'updated',
      });
    }
    for (const socket of watching) socket.close();
  });

  it('P111 share link: /shares/:t/meta of shl_V has no ai, no prompt', async () => {
    const link = createdShareLinkSchema.parse(
      ok(
        await fx.call('u_editor', 'POST', `/views/${viwAi}/share-links`, { audience: 'public' }),
        201,
      ).json(),
    );
    const meta = ok(
      await t.app.inject({ method: 'GET', url: `/api/v1/shares/${link.token}/meta` }),
    );
    const shared = meta
      .json<{ fields: { id: string; options: Record<string, unknown> }[] }>()
      .fields.find((field) => field.id === note.id);
    expect(shared).toBeDefined();
    expect(shared?.options).not.toHaveProperty('ai');
    expect(meta.json()).not.toHaveProperty('ai');
    // (u_editor reads every field: ids are in the meta, the words of the prompt are not.)
    expectNoConfig(meta.body, []);
    // No field API under the link.
    for (const path of [`/fields/${note.id}`, `/tables/${fx.orders.id}/fields`]) {
      const response = await t.app.inject({
        method: 'GET',
        url: `/api/v1/shares/${link.token}${path}`,
      });
      expect(response.statusCode).toBe(404);
      expectNoConfig(response.body);
    }
  });

  it('P111 MCP: describe_table Orders has no AI options for tk_sales_r (nor an admin token)', async () => {
    for (const token of [
      tk.sales_r,
      await createToken('u_admin', ['records:read', 'schema:read']),
    ]) {
      const { text, result } = await mcp(token, 'describe_table', { table_id: fx.orders.id });
      expect(result.isError ?? false).toBe(false);
      const field = (result.structuredContent as { fields: Record<string, unknown>[] }).fields.find(
        (item) => item['name'] === 'ai_note',
      );
      expect(field).toMatchObject({ type: 'text', read_only: true });
      expect(Object.keys(field ?? {}).sort()).toEqual(
        ['description', 'is_primary', 'name', 'read_only', 'type'].sort(),
      );
      expectNoConfig(text, [F('cost'), F('title')]);
    }
  });

  // --- P112 -----------------------------------------------------------------------------------

  it('P112: ai_state through the field API and schema.changed when the queue pauses and resumes — u_admin only', async () => {
    const actors = ['u_reader', 'u_editor', 'manager', 'u_admin', 'tk_sales_r'] as const;
    const watching = new Map(
      await Promise.all(actors.map(async (actor) => [actor, await socketOf(actor)] as const)),
    );
    // The provider rejects the key: the worker pauses every queued row of the organization.
    fake.capabilities.failWith = 401;
    const generated = ok(
      await fx.call('u_admin', 'POST', `/fields/${note.id}/ai/generate`, { scope: 'all' }),
      202,
    ).json<{ rows: number }>();
    expect(generated.rows).toBe(3);
    const paused = await (watching.get('u_admin') as TestSocket).next(
      (message) => fieldChanged(note.id)(message) && 'ai_state' in message,
      60_000,
    );
    expect(paused).toMatchObject({
      ai_state: { paused: 3, paused_reason: 'provider_error', paused_detail: 'unauthorized' },
    });
    for (const actor of ['u_reader', 'u_editor', 'manager', 'tk_sales_r'] as const) {
      const message = await (watching.get(actor) as TestSocket).next(fieldChanged(note.id));
      expect(message, actor).not.toHaveProperty('ai_state');
      expectNoConfig(JSON.stringify(message));
    }
    // The field API: the counts for u_admin, no key for anyone else.
    expect(
      fieldSchema.parse(ok(await as('u_admin', 'GET', `/fields/${note.id}`)).json()).ai_state,
    ).toEqual({
      queued: 0,
      failed: 0,
      paused: 3,
      paused_reason: 'provider_error',
      paused_detail: 'unauthorized',
      retry_at: null,
    });
    for (const actor of ['u_reader', 'u_editor', 'manager', 'tk_sales_r'] as const) {
      const one = ok(await as(actor, 'GET', `/fields/${note.id}`));
      expect(one.json(), actor).not.toHaveProperty('ai_state');
      const listed = itemOf(await as(actor, 'GET', `/tables/${fx.orders.id}/fields`), note.id);
      expect(listed, actor).not.toHaveProperty('ai_state');
      expect(one.body).not.toContain('provider_error');
    }

    // Saving the AI settings with another model resumes the rows (the API announces it).
    fake.capabilities.failWith = null;
    ok(await fx.call('owner', 'PUT', `/orgs/${fx.orgId}/ai-settings`, { model: 'fake-model-2' }));
    const resumed = await (watching.get('u_admin') as TestSocket).next(
      (message) =>
        fieldChanged(note.id)(message) &&
        'ai_state' in message &&
        (message as { ai_state: { paused: number } }).ai_state.paused === 0,
    );
    expect(resumed).toMatchObject({ ai_state: { paused: 0, paused_reason: null } });
    for (const actor of ['u_reader', 'u_editor', 'manager', 'tk_sales_r'] as const) {
      const socket = watching.get(actor) as TestSocket;
      const message = await socket.next(fieldChanged(note.id));
      expect(message, actor).not.toHaveProperty('ai_state');
      await socket.expectNone((next) => 'ai_state' in next);
    }
    // The worker writes the values; the queue empties.
    await eventually(async () => {
      const { rows } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM meta.ai_generation_queue WHERE field_id = ${note.id}`.execute(
        db.kysely,
      );
      return rows[0]?.n === 0 ? true : undefined;
    });
    for (const socket of watching.values()) socket.close();
  });
});
