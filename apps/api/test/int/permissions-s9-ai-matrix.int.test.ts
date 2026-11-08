import {
  createdApiTokenSchema,
  createdShareLinkSchema,
  fieldSchema,
  jobSchema,
  newId,
  roleListSchema,
  widgetDataSchema,
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
type Actor = 'u_reader' | 'u_editor' | 'u_sales1' | 'manager' | 'u_admin' | 'tk_sales_r';
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
 *
 * BACKLOG T1007 (CONTRACTS §5 P113–P117, §29.5, §29.6): every output path of
 * "always strict", one named case each — link/parent sources and sources
 * reading other records at any depth, also after the save and on a revert
 * (P113); formulas and lookups reading an AI field (P114); `options.ai`
 * edited or removed, a type change to or from an AI field, the revert, its
 * preview and the restore as a new field, with AI or record data off
 * (P115); automation `watch_fields`, conditions, templates and the
 * recipients of an AI text (P116); dashboard widgets, the Q&A digest, MCP
 * `aggregate_records`, kanban, color rules, `group-counts`, `summaries`,
 * record history and `record.meta.ai` (P117). Every blocked case checks
 * what the fake provider received.
 *
 * Fixture: one API instance listening (WebSocket, MCP), a real worker
 * (`field.convert`, the AI runner, automations) on the app's realtime bus,
 * the fake OpenAI-compatible provider on loopback with its allowlist entry,
 * AI with record data on; `ai_note` (text, `PROMPT`, `INSTRUCTIONS`,
 * `auto_update: false`) on Orders r1 (u_sales1), r2 (u_sales2), r3; the
 * fields of P113–P117 come from `extras`.
 */
describe('permission matrix S9 — AI fields always strict (T1006, T1007)', () => {
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

  it('P111 revert: POST /fields/ai_conv/revert-conversion — u_admin gets the whole options.ai; the Sales manager, locked out of it, 403', async () => {
    const path = `/fields/${conv.id}/revert-conversion`;
    const body = { mode: 'overwrite_later_edits', confirm: true };
    for (const actor of ['u_reader', 'u_editor', 'manager'] as const) {
      const response = await as(actor, 'POST', path, body);
      expectProblem(response, 403, 'PERMISSION_DENIED');
      expectNoConfig(response.body);
    }
    const token = await as('tk_sales_r', 'POST', path, body);
    expectProblem(token, 403, 'INSUFFICIENT_SCOPE');
    expectNoConfig(token.body);
    // u_admin reverts the conversion: the whole configuration, in names.
    const admin = fieldSchema.parse(ok(await as('u_admin', 'POST', path, body)).json());
    expect(admin.type).toBe('text');
    expectWhole(admin, { prompt: CONV_PROMPT });
    // The AI field back, the Sales manager reads it as `{ task }`.
    expectRedacted(fieldSchema.parse(ok(await as('manager', 'GET', `/fields/${conv.id}`)).json()));
  });

  it('P111 restore: revert-conversion as a new field — the old AI field for u_admin whole, { task } for every other reader; the Sales manager 403', async () => {
    const restore = (actor: Actor, fieldId: Id<'fld'>, name: string) =>
      as(actor, 'POST', `/fields/${fieldId}/revert-conversion`, { mode: 'new_field', name });
    await convertToSelect();
    for (const actor of ['u_reader', 'u_editor', 'manager'] as const) {
      const response = await restore(actor, conv.id, `ai_conv (${actor})`);
      expectProblem(response, 403, 'PERMISSION_DENIED');
      expectNoConfig(response.body);
    }
    const token = await restore('tk_sales_r', conv.id, 'ai_conv (token)');
    expectProblem(token, 403, 'INSUFFICIENT_SCOPE');
    const admin = fieldSchema.parse(
      ok(await restore('u_admin', conv.id, 'ai_conv (u_admin)')).json(),
    );
    expect(admin.id).not.toBe(conv.id);
    expect(admin.type).toBe('text');
    expectWhole(admin, { prompt: CONV_PROMPT });
    for (const actor of ['u_reader', 'u_editor', 'manager', 'tk_sales_r'] as const) {
      expectRedacted(fieldSchema.parse(ok(await as(actor, 'GET', `/fields/${admin.id}`)).json()));
    }
    ok(await as('u_admin', 'DELETE', `/fields/${admin.id}`), 204);
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

  // --- P113–P117: every output path of "always strict" (T1007) ------------------------------

  /** Orders r1 (u_sales1), r2 (u_sales2), r3, by title (created in `beforeAll`). */
  const rec = {} as Record<'r1' | 'r2' | 'r3', Id<'rec'>>;
  /** Fields of P113–P117, made once by `extras`. */
  const x = {} as Record<
    'customer' | 'related' | 'band' | 'titleCost' | 'overNote' | 'relatedNote',
    FieldDto
  >;
  /** The option "Cao" of `ai_band` (the fake provider answers the first option). */
  let cao = '';
  let salesRole: RoleDto;
  let extrasReady = false;

  const chats = () => fake.chatRequests();
  /** Everything sent, data-block ids made equal (they are random per request). */
  const sentText = () =>
    JSON.stringify(chats().map((request) => request.body)).replace(
      /<<(DATA \w+|END) [0-9a-f]{16}>>/gu,
      '<<$1 ID>>',
    );
  const firstPrompt = () => JSON.stringify(chats()[0]?.body?.['messages']);
  const problemOf = (response: Response) =>
    response.json<{ code: string; errors?: { path: string; code: string }[] }>();
  /** `code` + `errors` (path, code) of a problem: what a client can tell apart. */
  const shapeOf = (response: Response) => {
    const { code, errors } = problemOf(response);
    return { code, errors: (errors ?? []).map(({ path, code: item }) => ({ path, code: item })) };
  };

  async function addField(body: Record<string, unknown>, actor: Actor = 'u_admin') {
    return fieldSchema.parse(
      ok(await as(actor, 'POST', `/tables/${fx.orders.id}/fields`, body), 201).json(),
    );
  }

  async function queueOf(fieldId: Id<'fld'>): Promise<{ status: string; reason: string | null }[]> {
    const { rows } = await sql<{ status: string; reason: string | null }>`
      SELECT status, reason FROM meta.ai_generation_queue WHERE field_id = ${fieldId}`.execute(
      db.kysely,
    );
    return rows;
  }

  /** `POST /fields/:id/ai/generate` by u_admin, until its job ended. */
  async function generate(fieldId: Id<'fld'>, recordIds?: Id<'rec'>[]): Promise<void> {
    const started = ok(
      await as(
        'u_admin',
        'POST',
        `/fields/${fieldId}/ai/generate`,
        recordIds === undefined ? { scope: 'all' } : { scope: 'records', record_ids: recordIds },
      ),
      202,
    ).json<{ job_id: Id<'job'> }>();
    await jobDone(started.job_id);
    await eventually(async () =>
      (await queueOf(fieldId)).every((row) => row.status !== 'queued' && row.status !== 'running')
        ? true
        : undefined,
    );
  }

  async function cellOf(actor: Actor, recordId: Id<'rec'>) {
    const record = ok(
      await as(actor, 'POST', `/tables/${fx.orders.id}/records/query?field_key_type=id`, {
        ids: [recordId],
      }),
    ).json<{
      records: {
        fields: Record<string, unknown>;
        meta?: { ai?: Record<string, unknown>; color?: unknown };
      }[];
    }>().records[0];
    if (record === undefined) throw new Error(`${actor} does not read ${recordId}`);
    return record;
  }

  const lockedFor = async (actor: Actor, fieldId: Id<'fld'>) =>
    fieldSchema.parse(ok(await as(actor, 'GET', `/fields/${fieldId}`)).json()).locked;

  async function setSales(change: (config: RoleDto['config']) => RoleDto['config']) {
    ok(
      await fx.call('u_admin', 'PATCH', `/bases/${fx.baseId}/roles/${salesRole.id}`, {
        config: change(structuredClone(salesRole.config)),
      }),
    );
  }
  const restoreSales = () => setSales((config) => config);

  /** Anonymous request through a share link. */
  const viaLink = (method: 'GET' | 'POST', token: string, path: string, body?: unknown) =>
    t.app.inject({
      method,
      url: `/api/v1/shares/${token}${path}`,
      ...(body === undefined ? {} : { payload: body as object }),
    });

  async function setAi(body: Record<string, unknown>): Promise<void> {
    ok(await fx.call('owner', 'PUT', `/orgs/${fx.orgId}/ai-settings`, body));
  }

  /**
   * The fields of P113–P117 (u_admin, once): `customer` (link → Customers),
   * `related` (Orders → Orders, r1 → r2), `ai_band` (an AI select made from
   * `cost`, generated: every row "Cao"), `title_cost` (`[title] & " " &
   * [cost]`), `ai_cost_note` (`[ai_note] & ""`), `related_note` (lookup of
   * `ai_note` through `related`).
   */
  async function extras(): Promise<void> {
    if (extrasReady) return;
    const records = ok(
      await as('u_admin', 'POST', `/tables/${fx.orders.id}/records/query`, {}),
    ).json<{ records: { id: Id<'rec'>; fields: Record<string, unknown> }[] }>().records;
    const idOf = (title: string) => {
      const found = records.find((record) => record.fields['title'] === title)?.id;
      if (found === undefined) throw new Error(`no record ${title}`);
      return found;
    };
    rec.r1 = idOf('Máy POS lỗi in');
    rec.r2 = idOf('Wifi chập chờn');
    rec.r3 = idOf('Đổi máy in');
    x.customer = await addField({
      name: 'customer',
      type: 'link',
      options: { link_table: fx.customers.id },
    });
    x.related = await addField({
      name: 'related',
      type: 'link',
      options: { link_table: fx.orders.id },
    });
    x.band = await addField({
      name: 'ai_band',
      type: 'select',
      options: {
        options: [{ name: 'Cao' }, { name: 'Thấp' }],
        ai: { task: 'classify', prompt: 'Mức chi phí {{ [cost] }}', auto_update: false },
      },
    });
    cao =
      (x.band.options['options'] as { id: string; name: string }[]).find(
        (option) => option.name === 'Cao',
      )?.id ?? '';
    x.titleCost = await addField({
      name: 'title_cost',
      type: 'formula',
      options: { expression: '[title] & " " & [cost]' },
    });
    x.overNote = await addField({
      name: 'ai_cost_note',
      type: 'formula',
      options: { expression: '[ai_note] & ""' },
    });
    // r1 → r2 before the lookup exists: its first computation reads r2's ai_note.
    ok(
      await as('u_admin', 'PATCH', `/tables/${fx.orders.id}/records`, {
        records: [{ id: rec.r1, fields: { related: [{ id: rec.r2 }] } }],
      }),
    );
    x.relatedNote = await addField({
      name: 'related_note',
      type: 'lookup',
      options: {
        from: fx.orders.id,
        select: note.id,
        where: { field: '__id', operator: 'is_any_of', value: { field_ref: x.related.id } },
      },
    });
    await generate(x.band.id);
    salesRole = roleListSchema
      .parse(ok(await fx.call('u_admin', 'GET', `/bases/${fx.baseId}/roles`)).json())
      .items.find((role) => role.name === 'Sales') as RoleDto;
    extrasReady = true;
  }

  // P113 — link/parent sources (u_admin).

  it('P113 link source: a prompt naming the link customer is refused at its placeholder on save, PATCH, PUT and preview; nothing sent', async () => {
    await extras();
    fake.requests.length = 0;
    const prompt = 'Khách: {{ [customer] }}';
    const ai = { task: 'summarize', prompt };
    const at = { start: prompt.indexOf('{{'), length: '{{ [customer] }}'.length };
    const expectCross = (response: Response) => {
      expectProblem(response, 422, 'VALIDATION_FAILED');
      expect(
        response.json<{ errors: { path: string; code: string; params: unknown }[] }>().errors,
      ).toEqual([
        expect.objectContaining({
          path: 'options.ai.prompt',
          code: 'CROSS_TABLE_NOT_SUPPORTED',
          params: { position: at },
        }),
      ]);
    };
    const plain = await addField({ name: 'plain_customer', type: 'text' });
    expectCross(
      await as('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
        name: 'ai_customer',
        type: 'text',
        options: { ai },
      }),
    );
    expectCross(await as('u_admin', 'PATCH', `/fields/${note.id}`, { options: { ai } }));
    expectCross(await as('u_admin', 'PATCH', `/fields/${plain.id}`, { options: { ai } }));
    expectCross(
      await as('u_admin', 'PUT', `/fields/${plain.id}`, {
        type: 'text',
        options: { ai },
        confirm: true,
      }),
    );
    expectCross(
      await as('u_admin', 'POST', `/fields/${plain.id}/convert-preview`, {
        type: 'text',
        options: { ai },
      }),
    );
    const preview = await as('u_admin', 'POST', `/tables/${fx.orders.id}/ai/field-preview`, {
      ai,
    });
    expectProblem(preview, 422, 'VALIDATION_FAILED');
    expect(problemOf(preview).errors?.map((error) => error.code)).toEqual([
      'CROSS_TABLE_NOT_SUPPORTED',
    ]);
    expect(chats()).toEqual([]);
    expect(
      fieldSchema.parse(ok(await as('u_admin', 'GET', `/fields/${note.id}`)).json()).options['ai'],
    ).toMatchObject({ prompt: PROMPT });
    ok(await as('u_admin', 'DELETE', `/fields/${plain.id}`), 204);
  });

  it('P113 parent source: a prompt naming the tree parent is refused like a link; nothing sent', async () => {
    await extras();
    fake.requests.length = 0;
    const parent = await addField({ name: 'parent_order', type: 'parent' });
    const prompt = 'Đơn cha: {{ [parent_order] }}';
    const refused = await as('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
      name: 'ai_parent',
      type: 'text',
      options: { ai: { task: 'summarize', prompt } },
    });
    expectProblem(refused, 422, 'VALIDATION_FAILED');
    expect(
      refused.json<{ errors: { path: string; code: string; params: unknown }[] }>().errors,
    ).toEqual([
      expect.objectContaining({
        path: 'options.ai.prompt',
        code: 'CROSS_TABLE_NOT_SUPPORTED',
        params: {
          position: { start: prompt.indexOf('{{'), length: '{{ [parent_order] }}'.length },
        },
      }),
    ]);
    expect(chats()).toEqual([]);
    ok(await as('u_admin', 'DELETE', `/fields/${parent.id}`), 204);
  });

  it('P113 sources reading linked titles at any depth: a lookup, a formula over it, a formula over that one — refused; nothing sent', async () => {
    await extras();
    fake.requests.length = 0;
    await addField({
      name: 'customer_name',
      type: 'lookup',
      options: {
        from: fx.customers.id,
        select: F('customerName'),
        where: { field: '__id', operator: 'is_any_of', value: { field_ref: x.customer.id } },
      },
    });
    await addField({
      name: 'customer_text',
      type: 'formula',
      options: { expression: 'ARRAYJOIN([customer_name])' },
    });
    await addField({
      name: 'customer_upper',
      type: 'formula',
      options: { expression: 'UPPER([customer_text])' },
    });
    for (const source of ['customer_name', 'customer_text', 'customer_upper']) {
      const response = await as('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
        name: `ai_${source}`,
        type: 'text',
        options: { ai: { task: 'summarize', prompt: `{{ [${source}] }}` } },
      });
      expectProblem(response, 422, 'VALIDATION_FAILED');
      expect(shapeOf(response).errors, source).toEqual([
        { path: 'options.ai.prompt', code: 'CROSS_TABLE_NOT_SUPPORTED' },
      ]);
    }
    expect(chats()).toEqual([]);
  });

  it('P113 a source formula edited after the save to read linked titles: the row fails render_error, the provider gets nothing', async () => {
    await extras();
    const upper = await addField({
      name: 'title_upper',
      type: 'formula',
      options: { expression: 'UPPER([title])' },
    });
    const field = await addField({
      name: 'ai_upper',
      type: 'text',
      options: { ai: { task: 'summarize', prompt: '{{ [title_upper] }}', auto_update: false } },
    });
    ok(
      await as('u_admin', 'PATCH', `/fields/${upper.id}`, {
        options: { expression: 'UPPER([customer_text])' },
      }),
    );
    fake.requests.length = 0;
    await generate(field.id, [rec.r1]);
    expect(chats()).toEqual([]);
    expect(await queueOf(field.id)).toEqual([{ status: 'failed', reason: 'render_error' }]);
    expect((await cellOf('u_admin', rec.r1)).fields[field.id]).toBeNull();
    ok(await as('u_admin', 'DELETE', `/fields/${field.id}`), 204);
  });

  it('P113 revert and restore: an AI field whose formula source reads linked titles since its conversion does not come back (422); nothing sent', async () => {
    await extras();
    const source = await addField({
      name: 'title_lower',
      type: 'formula',
      options: { expression: 'LOWER([title])' },
    });
    const field = await addField({
      name: 'ai_lower',
      type: 'text',
      options: { ai: { task: 'summarize', prompt: '{{ [title_lower] }}', auto_update: false } },
    });
    await convertToSelect(field.id);
    ok(
      await as('u_admin', 'PATCH', `/fields/${source.id}`, {
        options: { expression: 'LOWER([customer_text])' },
      }),
    );
    fake.requests.length = 0;
    for (const body of [
      { mode: 'overwrite_later_edits', confirm: true },
      { mode: 'new_field', name: 'ai_lower (old)' },
    ]) {
      const response = await as('u_admin', 'POST', `/fields/${field.id}/revert-conversion`, body);
      expectProblem(response, 422, 'VALIDATION_FAILED');
      expect(shapeOf(response).errors, body.mode).toEqual([
        { path: 'options.ai.prompt', code: 'CROSS_TABLE_NOT_SUPPORTED' },
      ]);
    }
    const kept = fieldSchema.parse(ok(await as('u_admin', 'GET', `/fields/${field.id}`)).json());
    expect(kept.type).toBe('select');
    expect(kept.options).not.toHaveProperty('ai');
    expect(chats()).toEqual([]);
    ok(await as('u_admin', 'DELETE', `/fields/${field.id}`), 204);
  });

  it('P113 AI action: an ai_generate_text prompt naming the link is refused like an AI field; nothing sent', async () => {
    await extras();
    fake.requests.length = 0;
    const response = await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/automations`, {
      name: 'P113 link',
      definition: {
        trigger: { type: 'record.created', table_id: fx.orders.id },
        actions: [
          {
            id: 'act_1',
            type: 'ai_generate_text',
            config: { prompt: `Khách {{ [${x.customer.id}] }}`, target_field_id: null },
          },
        ],
      },
    });
    expectProblem(response, 422, 'AUTOMATION_INVALID');
    expect(shapeOf(response).errors.map((error) => error.code)).toContain(
      'CROSS_TABLE_NOT_SUPPORTED',
    );
    expect(chats()).toEqual([]);
  });

  // P114 — formulas and lookups reading an AI field (u_sales1, the Sales manager).

  it('P114 read: a formula and a lookup over ai_note are null and locked for u_sales1, base strict or not; u_reader reads them', async () => {
    await extras();
    // The lookup is stored: computed in the background after r1 → r2.
    await eventually(async () =>
      JSON.stringify((await cellOf('u_admin', rec.r1)).fields[x.relatedNote.id] ?? null).includes(
        'fake: ',
      )
        ? true
        : undefined,
    );
    const read = async (actor: Actor) => {
      const { fields } = await cellOf(actor, rec.r1);
      return [fields[x.overNote.id] ?? null, fields[x.relatedNote.id] ?? null];
    };
    for (const strict of [false, true]) {
      ok(
        await fx.call('u_admin', 'PATCH', `/bases/${fx.baseId}`, {
          settings: { strict_computed_permissions: strict },
        }),
      );
      expect(await read('u_sales1'), `strict ${String(strict)}`).toEqual([null, null]);
      expect(await lockedFor('u_sales1', x.overNote.id)).toBe(true);
      expect(await lockedFor('u_sales1', x.relatedNote.id)).toBe(true);
      const [over, related] = await read('u_reader');
      expect(over).toMatch(/^fake: /u);
      expect(JSON.stringify(related)).toContain('fake: ');
      expect(await lockedFor('u_reader', x.overNote.id)).toBe(false);
    }
    ok(
      await fx.call('u_admin', 'PATCH', `/bases/${fx.baseId}`, {
        settings: { strict_computed_permissions: false },
      }),
    );
  });

  it('P114 save: the Sales manager saving a formula or a lookup over ai_note gets UNKNOWN_FIELD, exactly like [cost] or a field that does not exist', async () => {
    await extras();
    const formula = (expression: string) =>
      as('manager', 'POST', `/tables/${fx.orders.id}/fields`, {
        name: 'f_manager',
        type: 'formula',
        options: { expression },
      });
    const onNote = await formula('[ai_note] & ""');
    const onOver = await formula('[ai_cost_note] & ""');
    const onCost = await formula('[cost] & ""');
    const onNothing = await formula('[ai_khác] & ""');
    expect(shapeOf(onNote).errors.map((error) => error.code)).toEqual(['UNKNOWN_FIELD']);
    for (const response of [onNote, onOver, onCost]) {
      expect(response.statusCode).toBe(onNothing.statusCode);
      expect(shapeOf(response)).toEqual(shapeOf(onNothing));
      expect(response.body).not.toContain(note.id);
    }
    const lookup = (select: Id<'fld'>) =>
      as('manager', 'POST', `/tables/${fx.orders.id}/fields`, {
        name: 'l_manager',
        type: 'lookup',
        options: {
          from: fx.orders.id,
          select,
          where: { field: '__id', operator: 'is_any_of', value: { field_ref: x.related.id } },
        },
      });
    const lookupNote = await lookup(note.id);
    const lookupNothing = await lookup(newId('fld'));
    expect(lookupNote.statusCode, lookupNote.body).toBe(422);
    expect(shapeOf(lookupNote)).toEqual(shapeOf(lookupNothing));
    expect(shapeOf(await lookup(F('cost')))).toEqual(shapeOf(lookupNothing));
  });

  it('P114 computed-preview: [ai_note] and a formula over it are UNKNOWN_FIELD for the Sales manager, like [cost]', async () => {
    await extras();
    const preview = (expression: string) =>
      as('manager', 'POST', `/tables/${fx.orders.id}/computed-preview`, {
        type: 'formula',
        options: { expression },
        record_ids: [rec.r2],
      });
    const expected = shapeOf(await preview('[cost]'));
    expect(expected).toEqual({
      code: 'FORMULA_SYNTAX_ERROR',
      errors: [expect.objectContaining({ code: 'UNKNOWN_FIELD' }) as unknown],
    });
    for (const expression of ['[ai_note]', '[ai_cost_note]']) {
      const response = await preview(expression);
      expect(response.statusCode, expression).toBe(422);
      expect(response.body).not.toContain('fake: ');
      expect(shapeOf(response).errors.map((error) => error.code)).toEqual(['UNKNOWN_FIELD']);
    }
    // u_admin previews it.
    const admin = ok(
      await as('u_admin', 'POST', `/tables/${fx.orders.id}/computed-preview`, {
        type: 'formula',
        options: { expression: '[ai_note]' },
        record_ids: [rec.r2],
      }),
    );
    expect(admin.body).toContain('fake: ');
  });

  it('P114 AI formula: ai_note is not in the Sales manager’s digest; a formula naming it is repaired, then refused, like a field that does not exist', async () => {
    await extras();
    const formula = (text: string) => ({
      content: JSON.stringify({ formula: text, explanation: 'Ghi chú.' }),
    });
    const url = `/tables/${fx.orders.id}/ai/formula`;
    const body = { description: 'lặp lại ghi chú do AI viết' };
    fake.requests.length = 0;
    fake.script(...Array.from({ length: 3 }, () => formula('[ai_note] & ""')));
    const hidden = await as('manager', 'POST', url, body);
    expectProblem(hidden, 422, 'AI_INVALID_OUTPUT');
    expect(chats()).toHaveLength(3);
    for (const name of ['ai_note', 'ai_cost_note', 'ai_band']) {
      expect(firstPrompt()).not.toContain(name);
    }
    // (`title_cost` is in it: a formula over `cost` shows to them, the base not being strict.)
    expect(firstPrompt()).not.toContain('\\"cost\\"');
    const hiddenSent = sentText();
    fake.requests.length = 0;
    fake.script(...Array.from({ length: 3 }, () => formula('[ai_khác] & ""')));
    const missing = await as('manager', 'POST', url, body);
    expect(shapeOf(missing)).toEqual(shapeOf(hidden));
    expect(sentText()).toBe(hiddenSent.replaceAll('ai_note', 'ai_khác'));
    // u_admin's digest names it.
    fake.requests.length = 0;
    fake.script(formula('[ai_note] & ""'));
    expect(ok(await as('u_admin', 'POST', url, body)).json()).toMatchObject({
      formula: '[ai_note] & ""',
    });
    expect(firstPrompt()).toContain('ai_note');
  });

  // P115 — editing or removing options.ai, type change, revert and restore.

  it('P115 PATCH options.ai: 403 for the Sales manager — a new prompt or none; the field stays as it was; nothing sent', async () => {
    await extras();
    fake.requests.length = 0;
    for (const ai of [{ task: 'custom', prompt: '{{ [title] }}' }, null]) {
      const response = await as('manager', 'PATCH', `/fields/${note.id}`, { options: { ai } });
      expectProblem(response, 403, 'PERMISSION_DENIED');
      expectNoConfig(response.body);
    }
    expectWhole(fieldSchema.parse(ok(await as('u_admin', 'GET', `/fields/${note.id}`)).json()), {
      prompt: PROMPT,
      instructions: INSTRUCTIONS,
    });
    expect(await lockedFor('manager', note.id)).toBe(true);
    expect(chats()).toEqual([]);
  });

  it('P115 PUT and convert-preview: 403 for the Sales manager on an AI field they are locked out of; the field stays an AI field', async () => {
    await extras();
    const body = { type: 'select', options: { multiple: false, options: [{ name: 'A' }] } };
    for (const [method, path, extra] of [
      ['PUT', `/fields/${note.id}`, { confirm: true }],
      ['POST', `/fields/${note.id}/convert-preview`, {}],
    ] as const) {
      const response = await as('manager', method, path, { ...body, ...extra });
      expectProblem(response, 403, 'PERMISSION_DENIED');
      expectNoConfig(response.body);
    }
    const kept = fieldSchema.parse(ok(await as('u_admin', 'GET', `/fields/${note.id}`)).json());
    expect(kept.type).toBe('text');
    expect(kept.conversion).toBeNull();
  });

  it('P115 revert-conversion and its preview: 403 for the Sales manager on an AI field they are locked out of; the field stays converted', async () => {
    await extras();
    const field = await addField({
      name: 'ai_rev',
      type: 'text',
      options: { ai: { task: 'summarize', prompt: CONV_PROMPT, auto_update: false } },
    });
    await convertToSelect(field.id);
    fake.requests.length = 0;
    for (const [path, body] of [
      [`/fields/${field.id}/revert-conversion/preview`, undefined],
      [`/fields/${field.id}/revert-conversion`, { mode: 'overwrite_later_edits', confirm: true }],
      [`/fields/${field.id}/revert-conversion`, { mode: 'keep_later_edits', confirm: true }],
    ] as const) {
      const response = await as('manager', 'POST', path, body);
      expectProblem(response, 403, 'PERMISSION_DENIED');
      expectNoConfig(response.body);
    }
    const kept = fieldSchema.parse(ok(await as('u_admin', 'GET', `/fields/${field.id}`)).json());
    expect(kept.type).toBe('select');
    expect(kept.options).not.toHaveProperty('ai');
    // Not locked out (every source readable): the Sales manager reverts one.
    const own = await addField({
      name: 'ai_rev_title',
      type: 'text',
      options: { ai: { task: 'summarize', prompt: 'Về {{ [title] }}', auto_update: false } },
    });
    await convertToSelect(own.id);
    const back = fieldSchema.parse(
      ok(
        await as('manager', 'POST', `/fields/${own.id}/revert-conversion`, {
          mode: 'overwrite_later_edits',
          confirm: true,
        }),
      ).json(),
    );
    expect(back.options['ai']).toMatchObject({ prompt: 'Về {{ [title] }}' });
    expect(chats()).toEqual([]);
    for (const id of [field.id, own.id]) ok(await as('u_admin', 'DELETE', `/fields/${id}`), 204);
  });

  it('P115 restore as a new field: 403 for the Sales manager on an AI field they are locked out of; no field added', async () => {
    await extras();
    const field = await addField({
      name: 'ai_restore',
      type: 'text',
      options: { ai: { task: 'summarize', prompt: CONV_PROMPT, auto_update: false } },
    });
    await convertToSelect(field.id);
    const count = async () =>
      ok(await as('u_admin', 'GET', `/tables/${fx.orders.id}/fields`)).json<{ items: unknown[] }>()
        .items.length;
    const before = await count();
    const response = await as('manager', 'POST', `/fields/${field.id}/revert-conversion`, {
      mode: 'new_field',
      name: 'ai_restore (manager)',
    });
    expectProblem(response, 403, 'PERMISSION_DENIED');
    expectNoConfig(response.body);
    expect(await count()).toBe(before);
    // The conversion is still revertible: u_admin restores it.
    const restored = fieldSchema.parse(
      ok(
        await as('u_admin', 'POST', `/fields/${field.id}/revert-conversion`, {
          mode: 'new_field',
          name: 'ai_restore (u_admin)',
        }),
      ).json(),
    );
    expectWhole(restored, { prompt: CONV_PROMPT });
    for (const id of [field.id, restored.id]) {
      ok(await as('u_admin', 'DELETE', `/fields/${id}`), 204);
    }
  });

  it('P115 AI off, record data off: u_admin’s revert, its preview and restore are 422 AI_NOT_CONFIGURED / AI_RECORD_DATA_DISABLED; options.ai does not come back; nothing sent', async () => {
    await extras();
    const field = await addField({
      name: 'ai_off',
      type: 'text',
      options: { ai: { task: 'summarize', prompt: CONV_PROMPT, auto_update: false } },
    });
    await convertToSelect(field.id);
    const plain = await addField({ name: 'plain_off', type: 'text' });
    const attempts = () => [
      as('u_admin', 'POST', `/fields/${field.id}/revert-conversion/preview`),
      as('u_admin', 'POST', `/fields/${field.id}/revert-conversion`, {
        mode: 'overwrite_later_edits',
        confirm: true,
      }),
      as('u_admin', 'POST', `/fields/${field.id}/revert-conversion`, {
        mode: 'new_field',
        name: 'ai_off (old)',
      }),
      // A type change to an AI field: the checks of a PATCH.
      as('u_admin', 'PUT', `/fields/${plain.id}`, {
        type: 'text',
        options: { ai: { task: 'summarize', prompt: '{{ [title] }}' } },
        confirm: true,
      }),
    ];
    fake.requests.length = 0;
    try {
      await setAi({ allow_record_data: false });
      for (const response of await Promise.all(attempts())) {
        expectProblem(response, 422, 'AI_RECORD_DATA_DISABLED');
      }
      await setAi({ enabled: false });
      for (const response of await Promise.all(attempts())) {
        expectProblem(response, 422, 'AI_NOT_CONFIGURED');
      }
    } finally {
      await setAi({ enabled: true });
      await setAi({ allow_record_data: true, confirm: true });
    }
    const kept = fieldSchema.parse(ok(await as('u_admin', 'GET', `/fields/${field.id}`)).json());
    expect(kept.type).toBe('select');
    expect(kept.options).not.toHaveProperty('ai');
    expect(
      fieldSchema.parse(ok(await as('u_admin', 'GET', `/fields/${plain.id}`)).json()).options,
    ).not.toHaveProperty('ai');
    expect(chats()).toEqual([]);
    // AI on again: the revert brings the whole configuration back.
    const back = fieldSchema.parse(
      ok(
        await as('u_admin', 'POST', `/fields/${field.id}/revert-conversion`, {
          mode: 'overwrite_later_edits',
          confirm: true,
        }),
      ).json(),
    );
    expectWhole(back, { prompt: CONV_PROMPT });
    for (const id of [field.id, plain.id]) ok(await as('u_admin', 'DELETE', `/fields/${id}`), 204);
  });

  it('P115 PUT to an AI field: the checks of a PATCH — the Sales manager naming cost gets the same 422 UNKNOWN_FIELD; a prompt they read is stored with ids', async () => {
    await extras();
    const plain = await addField({ name: 'plain_put', type: 'text' });
    const ai = { task: 'summarize', prompt: 'Chi phí {{ [cost] }}' };
    const patched = await as('manager', 'PATCH', `/fields/${plain.id}`, { options: { ai } });
    expectProblem(patched, 422, 'VALIDATION_FAILED');
    expect(shapeOf(patched).errors).toEqual([{ path: 'options.ai.prompt', code: 'UNKNOWN_FIELD' }]);
    for (const [method, path, extra] of [
      ['PUT', `/fields/${plain.id}`, { confirm: true }],
      ['POST', `/fields/${plain.id}/convert-preview`, {}],
    ] as const) {
      const response = await as('manager', method, path, {
        type: 'text',
        options: { ai },
        ...extra,
      });
      expect(response.statusCode, response.body).toBe(422);
      expect(shapeOf(response), response.body).toEqual(shapeOf(patched));
      expect(response.body).not.toContain(F('cost'));
    }
    const storedPrompt = async (fieldId: Id<'fld'>) =>
      (
        await sql<{ prompt: string | null }>`
          SELECT options->'ai'->>'prompt' AS prompt FROM meta.fields WHERE id = ${fieldId}`.execute(
          db.kysely,
        )
      ).rows[0]?.prompt ?? null;
    expect(await storedPrompt(plain.id)).toBeNull();
    // A prompt they read: like a PATCH (no value changes: at once).
    const own = ok(
      await as('manager', 'PUT', `/fields/${plain.id}`, {
        type: 'text',
        options: { ai: { task: 'summarize', prompt: 'Về {{ [title] }}' } },
        confirm: true,
      }),
      202,
    ).json<{ job_id: Id<'job'> | null; field: FieldDto }>();
    expect(own.job_id).toBeNull();
    expect(own.field.options['ai']).toMatchObject({ prompt: 'Về {{ [title] }}' });
    expect(await storedPrompt(plain.id)).toBe(`Về {{ [${F('title')}] }}`);
    // A conversion that changes values (number → AI text) stores the prompt with ids too.
    const number = await addField({ name: 'number_put', type: 'number' });
    const converted = ok(
      await as('u_admin', 'PUT', `/fields/${number.id}`, {
        type: 'text',
        options: { ai: { task: 'summarize', prompt: 'Số {{ [title] }}' } },
        confirm: true,
      }),
      202,
    ).json<{ job_id: Id<'job'> | null }>();
    if (converted.job_id !== null)
      expect((await jobDone(converted.job_id)).status).toBe('succeeded');
    expect(await storedPrompt(number.id)).toBe(`Số {{ [${F('title')}] }}`);
    expect(await lockedFor('u_sales1', number.id)).toBe(false);
    for (const id of [plain.id, number.id]) ok(await as('u_admin', 'DELETE', `/fields/${id}`), 204);
  });

  // P116 — automations: conditions, watch_fields, templates, recipients.

  /** A `record.updated` automation of Orders saved by `actor` (its problem or `201`). */
  const saveAutomation = (actor: Actor, name: string, definition: Record<string, unknown>) =>
    as(actor, 'POST', `/bases/${fx.baseId}/automations`, { name, definition });
  const updatedTrigger = (watch: string[]) => ({
    type: 'record.updated',
    table_id: fx.orders.id,
    watch_fields: watch,
    skip_bulk: false,
  });
  const writeTitle = (value: Record<string, unknown>) => [
    {
      id: 'act_1',
      type: 'update_record',
      config: { table_id: fx.orders.id, record_id: null, fields: { [F('title')]: value } },
    },
  ];

  /** The manager's problem on `ai_band`, then the same definition on a field that does not exist. */
  async function expectLikeUnknown(definition: (fieldId: string) => Record<string, unknown>) {
    const onBand = await saveAutomation('manager', 'band', definition(x.band.id));
    expectProblem(onBand, 422, 'AUTOMATION_INVALID');
    const onNothing = await saveAutomation('manager', 'band', definition(newId('fld')));
    expect(shapeOf(onBand)).toEqual(shapeOf(onNothing));
    expect(onBand.body).not.toContain('Cao');
    const admin = ok(await saveAutomation('u_admin', 'band', definition(x.band.id)), 201);
    ok(await as('u_admin', 'DELETE', `/automations/${admin.json<{ id: string }>().id}`), 204);
    return shapeOf(onBand).errors.filter((error) => error.code === 'UNKNOWN_FIELD');
  }

  it('P116 watch_fields: the Sales manager’s automation watching ai_band is UNKNOWN_FIELD, like a field that does not exist; u_admin saves it', async () => {
    await extras();
    const errors = await expectLikeUnknown((id) => ({
      trigger: updatedTrigger([id]),
      actions: writeTitle({ literal: 'HIGH' }),
    }));
    expect(errors.map((error) => error.path)).toEqual(['definition.trigger.watch_fields[0]']);
  });

  it('P116 condition: changed_to "Cao" on ai_band is UNKNOWN_FIELD for the Sales manager; u_admin saves it', async () => {
    await extras();
    const errors = await expectLikeUnknown((id) => ({
      trigger: updatedTrigger([F('title')]),
      condition: { field: id, operator: 'changed_to', value: cao },
      actions: writeTitle({ literal: 'HIGH' }),
    }));
    expect(errors.map((error) => error.path)).toEqual(['definition.condition.field']);
  });

  it('P116 template: {{ [ai_band] }} in a step is UNKNOWN_FIELD for the Sales manager; u_admin saves it', async () => {
    await extras();
    const errors = await expectLikeUnknown((id) => ({
      trigger: updatedTrigger([F('title')]),
      actions: writeTitle({ template: `Mức {{ [${id}] }}` }),
    }));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toMatch(/^definition\.actions\[0\]\.config\.fields\./u);
  });

  it('P116 recipients: a notification placing the [act_1] text of ai_generate_text over a formula reading cost skips u_sales1 like a hidden field; u_reader and u_admin get it', async () => {
    await extras();
    const saved = ok(
      await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/automations`, {
        name: 'P116 recipients',
        enabled: true,
        definition: {
          trigger: { type: 'record.created', table_id: fx.orders.id },
          actions: [
            {
              id: 'act_1',
              type: 'ai_generate_text',
              config: { prompt: `Tóm tắt {{ [${x.titleCost.id}] }}`, target_field_id: null },
            },
            {
              id: 'act_2',
              type: 'send_notification',
              config: {
                recipients: [
                  {
                    user_ids: [fx.users.u_sales1.id, fx.users.u_reader.id, fx.users.u_admin.id],
                  },
                ],
                title: { template: 'P116 AI' },
                body: { template: '{{ [act_1] }}' },
              },
            },
          ],
        },
      }),
      201,
    ).json<{ id: Id<'aut'> }>();
    fake.requests.length = 0;
    let created: Id<'rec'> | undefined;
    try {
      // A record u_sales1 reads (theirs): only the fields of the text keep them out.
      created = ok(
        await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/records`, {
          records: [{ fields: { title: 'P116', cost: 7, owner: [{ id: fx.users.u_sales1.id }] } }],
        }),
        201,
      ).json<{ records: { id: Id<'rec'> }[] }>().records[0]?.id;
      const step = await eventually(async () => {
        const { rows } = await sql<{ status: string; output: Record<string, unknown> | null }>`
          SELECT s.status, s.output FROM meta.automation_run_steps s
            JOIN meta.automation_runs r ON r.id = s.run_id
           WHERE r.automation_id = ${saved.id} AND s.action_id = 'act_2'`.execute(db.kysely);
        const found = rows[0];
        return found !== undefined && found.status !== 'running' && found.status !== 'pending'
          ? found
          : undefined;
      });
      expect(step).toMatchObject({
        status: 'succeeded',
        output: {
          delivered: 2,
          skipped: [{ user_id: fx.users.u_sales1.id, reason: 'cannot_read_field' }],
        },
      });
      const { rows } = await sql<{ user_id: string }>`
        SELECT user_id FROM meta.notifications
         WHERE organization_id = ${fx.orgId} AND type = 'automation.message'
           AND payload->>'title' = 'P116 AI'`.execute(db.kysely);
      expect(rows.map((row) => row.user_id).sort()).toEqual(
        [fx.users.u_reader.id, fx.users.u_admin.id].sort(),
      );
      // One call: the text, made with the access of u_admin (`run_as`).
      expect(chats()).toHaveLength(1);
    } finally {
      ok(await fx.call('u_admin', 'POST', `/automations/${saved.id}/disable`));
      if (created !== undefined) {
        ok(
          await fx.call('u_admin', 'DELETE', `/tables/${fx.orders.id}/records`, {
            ids: [created],
          }),
        );
      }
    }
  });

  // P117 — read surfaces beyond P86 (u_sales1, the viewer of u_sales1's link, the Sales manager).

  it('P117 dashboard widget: grouped by ai_band — no_permission for u_sales1 and through their link, without a number; u_admin gets the groups', async () => {
    await extras();
    const dashboard = ok(
      await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/dashboards`, { name: 'D AI' }),
      201,
    ).json<{ id: Id<'dsh'> }>().id;
    const widget = ok(
      await fx.call('u_admin', 'POST', `/dashboards/${dashboard}/widgets`, {
        type: 'bar',
        title: 'w_band',
        config: {
          table_id: fx.orders.id,
          dimension: { field: x.band.id },
          metrics: [{ id: 'm1', aggregation: 'count' }],
        },
      }),
      201,
    ).json<{ id: Id<'wgt'> }>().id;
    const data = (response: Response) => widgetDataSchema.parse(ok(response).json());
    const admin = data(await fx.call('u_admin', 'POST', `/widgets/${widget}/data`, {}));
    expect(admin).toMatchObject({ status: 'ok' });
    expect(JSON.stringify(admin.rows)).toContain('Cao');
    await setSales((config) => ({
      ...config,
      dashboards: { [dashboard]: 'read_only' },
      base_rule: { ...(config.base_rule as Record<string, boolean>), share_link: true },
    }));
    try {
      const own = data(await fx.call('u_sales1', 'POST', `/widgets/${widget}/data`, {}));
      expect(own).toMatchObject({ status: 'no_permission', columns: [], rows: [] });
      expect(JSON.stringify(own)).not.toContain('Cao');
      const link = createdShareLinkSchema.parse(
        ok(
          await fx.call('u_sales1', 'POST', `/dashboards/${dashboard}/share-links`, {
            audience: 'public',
          }),
          201,
        ).json(),
      );
      const shared = data(await viaLink('POST', link.token, `/widgets/${widget}/data`, {}));
      expect(shared).toMatchObject({ status: 'no_permission', columns: [], rows: [] });
      expect(JSON.stringify(shared)).not.toContain('Cao');
    } finally {
      await restoreSales();
    }
  });

  it('P117 Q&A "đếm theo AI band": ai_band is not in the digest of u_sales1 or the Sales manager; a plan naming it is refused like a field that does not exist', async () => {
    await extras();
    const plan = (dimension: string) => ({
      content: JSON.stringify({
        answerable: true,
        chart: 'bar',
        title: 'Số đơn theo nhóm',
        metric: { aggregation: 'count', field: null },
        dimension: { field: dimension, date_bucket: null },
        series: null,
        filter: null,
        sort: null,
        limit: null,
        compare: null,
      }),
    });
    const ask = (actor: Actor, question: string) =>
      as(actor, 'POST', `/tables/${fx.orders.id}/ai/ask`, { question, timezone: 'UTC' });
    for (const actor of ['u_sales1', 'manager'] as const) {
      fake.requests.length = 0;
      fake.script(...Array.from({ length: 3 }, () => plan('ai_band')));
      const hidden = await ask(actor, 'đếm theo AI band');
      expectProblem(hidden, 422, 'AI_INVALID_OUTPUT');
      expect(chats(), actor).toHaveLength(3);
      expect(firstPrompt().replace('đếm theo AI band', '')).not.toContain('ai_band');
      expect(JSON.stringify(chats()[0]?.body?.['response_format'])).not.toContain('ai_band');
      const hiddenSent = sentText();
      fake.requests.length = 0;
      fake.script(...Array.from({ length: 3 }, () => plan('ai_khác')));
      const missing = await ask(actor, 'đếm theo AI khác');
      expect(shapeOf(missing)).toEqual(shapeOf(hidden));
      expect(sentText()).toBe(
        hiddenSent.replaceAll('AI band', 'AI khác').replaceAll('ai_band', 'ai_khác'),
      );
      for (const response of [hidden, missing]) {
        expect(response.body).not.toContain('no_permission');
        expect(response.body).not.toContain('Cao');
      }
    }
    // u_admin's digest names it, and the plan answers.
    fake.requests.length = 0;
    fake.script(plan('ai_band'), { content: 'Ba đơn mức Cao.' });
    const admin = ok(await ask('u_admin', 'đếm theo AI band')).json<{ status: string }>();
    expect(admin.status).toBe('ok');
    expect(firstPrompt()).toContain('ai_band');
  });

  it('P117 MCP aggregate_records group_by ai_band: UNKNOWN_FIELD for tk_sales_r and the Sales manager’s token, byte for byte a field that does not exist', async () => {
    await extras();
    const byField = (field: string) => ({
      table_id: fx.orders.id,
      metrics: [{ aggregation: 'count' }],
      group_by: { field },
    });
    const managerToken = await createToken('u_sales2', ['records:read', 'schema:read']);
    for (const token of [tk.sales_r, managerToken]) {
      const hidden = await mcp(token, 'aggregate_records', byField('ai_band'));
      const missing = await mcp(token, 'aggregate_records', byField('ai_khác'));
      expect(hidden.result).toMatchObject({
        isError: true,
        structuredContent: {
          code: 'VALIDATION_FAILED',
          errors: [{ path: 'group_by.field', code: 'UNKNOWN_FIELD' }],
        },
      });
      expect(JSON.stringify(hidden.result.structuredContent).replaceAll('ai_band', 'ai_khác')).toBe(
        JSON.stringify(missing.result.structuredContent),
      );
      expect(hidden.text).not.toContain('Cao');
    }
    const admin = await mcp(
      await createToken('u_admin', ['records:read', 'schema:read']),
      'aggregate_records',
      byField('ai_band'),
    );
    expect(admin.result.isError ?? false).toBe(false);
    expect(admin.text).toContain('Cao');
  });

  it('P117 kanban: u_sales1 and the Sales manager cannot group a kanban by ai_band; u_admin’s kanban grouped by it gives them no column of it', async () => {
    await extras();
    const kanban = (actor: Actor, groupField: string, personal: boolean) =>
      as(actor, 'POST', `/tables/${fx.orders.id}/views`, {
        name: `kanban ${actor} ${String(personal)}`,
        type: 'kanban',
        ...(personal ? { is_personal: true } : {}),
        config: { kanban: { group_field: groupField } },
      });
    for (const [actor, personal] of [
      ['u_sales1', true],
      ['manager', true],
      ['manager', false],
    ] as const) {
      const hidden = await kanban(actor, x.band.id, personal);
      expectProblem(hidden, 422, 'VALIDATION_FAILED');
      expect(shapeOf(hidden).errors).toEqual([
        { path: 'config.kanban.group_field', code: 'UNKNOWN_FIELD' },
      ]);
      expect(shapeOf(await kanban(actor, newId('fld'), personal))).toEqual(shapeOf(hidden));
    }
    const adminView = ok(await kanban('u_admin', x.band.id, false), 201).json<{
      id: Id<'viw'>;
    }>().id;
    // The board's columns: counts by the group field, records by option — as on a hidden field.
    const counts = await as('u_sales1', 'POST', `/tables/${fx.orders.id}/records/group-counts`, {
      view_id: adminView,
      group: [{ field: 'ai_band' }],
    });
    expectProblem(counts, 422, 'INVALID_SORT');
    const column = await as(
      'u_sales1',
      'POST',
      `/tables/${fx.orders.id}/records/query?field_key_type=id`,
      {
        view_id: adminView,
        filter: { op: 'and', items: [{ field: x.band.id, operator: 'is', value: cao }] },
      },
    );
    expectProblem(column, 422, 'INVALID_FILTER');
    // Saved conditions on it from the locked Sales manager are refused too (no oracle by view).
    const filtered = await as('manager', 'POST', `/tables/${fx.orders.id}/views`, {
      name: 'grid band',
      type: 'grid',
      config: { filter: { op: 'and', items: [{ field: x.band.id, operator: 'is', value: cao }] } },
    });
    expectProblem(filtered, 422, 'INVALID_FILTER');
    const admin = ok(
      await as('u_admin', 'POST', `/tables/${fx.orders.id}/records/group-counts`, {
        view_id: adminView,
        group: [{ field: 'ai_band' }],
      }),
    ).json<{ groups: { values: unknown[]; count: number }[] }>();
    expect(admin.groups).toEqual([{ values: ['Cao'], count: 3 }]);
    ok(await as('u_admin', 'DELETE', `/views/${adminView}`), 204);
  });

  it('P117 color_rules on ai_band: never color the rows of u_sales1 nor of their link, and are not theirs to save; u_admin’s rows red', async () => {
    await extras();
    const RULE = 'clr_S9AiBandRedAAAAA';
    const view = ok(
      await as('u_admin', 'POST', `/tables/${fx.orders.id}/views`, {
        name: 'viw_band',
        type: 'grid',
        config: {
          color_rules: [
            {
              id: RULE,
              color: 'red',
              target: 'row',
              filter: { op: 'and', items: [{ field: x.band.id, operator: 'is', value: cao }] },
            },
          ],
        },
      }),
      201,
    ).json<{ id: Id<'viw'> }>().id;
    const colors = (response: Response) =>
      ok(response)
        .json<{ records: { id: string; meta?: { color?: unknown } }[] }>()
        .records.map((record) => record.meta?.color ?? null);
    const query = `/tables/${fx.orders.id}/records/query?field_key_type=id`;
    expect(colors(await as('u_admin', 'POST', query, { view_id: view }))).toEqual(
      [1, 2, 3].map(() => ({ row: RULE })),
    );
    const own = await as('u_sales1', 'POST', query, { view_id: view });
    expect(colors(own)).toEqual([null]);
    expect(own.body).not.toContain(RULE);
    await setSales((config) => ({
      ...config,
      base_rule: { ...(config.base_rule as Record<string, boolean>), share_link: true },
    }));
    try {
      const link = createdShareLinkSchema.parse(
        ok(
          await fx.call('u_sales1', 'POST', `/views/${view}/share-links`, { audience: 'public' }),
          201,
        ).json(),
      );
      const shared = await viaLink('POST', link.token, '/records/query?field_key_type=id', {});
      expect(colors(shared)).toEqual([null]);
      expect(shared.body).not.toContain(RULE);
    } finally {
      await restoreSales();
    }
    // The Sales manager's own rule on it: refused like a rule on a hidden field.
    const saved = await as('manager', 'PATCH', `/views/${view}`, {
      config: {
        color_rules: [
          {
            color: 'green',
            target: 'row',
            filter: { op: 'and', items: [{ field: x.band.id, operator: 'is', value: cao }] },
          },
        ],
      },
    });
    expect(saved.statusCode, saved.body).toBe(422);
    ok(await as('u_admin', 'DELETE', `/views/${view}`), 204);
  });

  /** `hidden` answers like `onCost` (the names swapped), a 422 `code` with one UNKNOWN_FIELD. */
  function expectLikeCost(
    hidden: Response,
    onCost: Response,
    code: string,
    names: [string, string],
  ): void {
    expectProblem(hidden, 422, code);
    expect(shapeOf(hidden).errors.map((error) => error.code)).toEqual(['UNKNOWN_FIELD']);
    expect(hidden.body.replace(/req_\w+/u, '').replaceAll(names[0], names[1])).toBe(
      onCost.body.replace(/req_\w+/u, ''),
    );
    expect(hidden.body).not.toContain('Cao');
  }

  /** A share link of u_sales1 on `viw_ai` (the Sales role may share while `run` runs). */
  async function withSalesLink(run: (token: string) => Promise<void>): Promise<void> {
    await setSales((config) => ({
      ...config,
      base_rule: { ...(config.base_rule as Record<string, boolean>), share_link: true },
    }));
    try {
      const link = createdShareLinkSchema.parse(
        ok(
          await fx.call('u_sales1', 'POST', `/views/${viwAi}/share-links`, { audience: 'public' }),
          201,
        ).json(),
      );
      await run(link.token);
    } finally {
      await restoreSales();
    }
  }

  it('P117 group-counts by ai_band: 422 INVALID_SORT like cost for u_sales1, the Sales manager and through the link of u_sales1; u_admin counts', async () => {
    await extras();
    const counts = (field: string) => ({ group: [{ field }] });
    const path = `/tables/${fx.orders.id}/records/group-counts`;
    for (const actor of ['u_sales1', 'manager'] as const) {
      expectLikeCost(
        await as(actor, 'POST', path, counts('ai_band')),
        await as(actor, 'POST', path, counts('cost')),
        'INVALID_SORT',
        ['ai_band', 'cost'],
      );
    }
    await withSalesLink(async (token) => {
      expectLikeCost(
        await viaLink('POST', token, '/records/group-counts', counts('ai_band')),
        await viaLink('POST', token, '/records/group-counts', counts('cost')),
        'INVALID_SORT',
        ['ai_band', 'cost'],
      );
    });
    const admin = ok(await as('u_admin', 'POST', path, counts('ai_band'))).json<{
      groups: { values: unknown[]; count: number }[];
    }>();
    expect(admin.groups).toEqual([{ values: ['Cao'], count: 3 }]);
  });

  it('P117 summaries on ai_band: 422 UNKNOWN_FIELD like cost for u_sales1, the Sales manager and through the link of u_sales1; u_admin summarizes', async () => {
    await extras();
    const summaries = (field: Id<'fld'>) => ({ summaries: { [field]: 'filled' } });
    const path = `/tables/${fx.orders.id}/records/summaries?field_key_type=id`;
    for (const actor of ['u_sales1', 'manager'] as const) {
      expectLikeCost(
        await as(actor, 'POST', path, summaries(x.band.id)),
        await as(actor, 'POST', path, summaries(F('cost'))),
        'VALIDATION_FAILED',
        [x.band.id, F('cost')],
      );
    }
    await withSalesLink(async (token) => {
      const linkPath = '/records/summaries?field_key_type=id';
      expectLikeCost(
        await viaLink('POST', token, linkPath, summaries(x.band.id)),
        await viaLink('POST', token, linkPath, summaries(F('cost'))),
        'VALIDATION_FAILED',
        [x.band.id, F('cost')],
      );
    });
    ok(await as('u_admin', 'POST', path, summaries(x.band.id)));
  });

  it('P117 record history of r1: no entry of ai_band for u_sales1; u_admin sees the AI write', async () => {
    await extras();
    const history = (actor: Actor) =>
      as(actor, 'GET', `/tables/${fx.orders.id}/records/${rec.r1}/history?field_key_type=id`);
    const own = ok(await history('u_sales1'));
    expect(own.body).not.toContain(x.band.id);
    expect(own.body).not.toContain('Cao');
    expect(ok(await history('u_admin')).body).toContain(x.band.id);
  });

  it('P117 record.meta.ai: no state of ai_band for u_sales1 nor through their link while u_admin sees it generating', async () => {
    await extras();
    await setSales((config) => ({
      ...config,
      base_rule: { ...(config.base_rule as Record<string, boolean>), share_link: true },
    }));
    fake.capabilities.delayMs = 5_000;
    try {
      const link = createdShareLinkSchema.parse(
        ok(
          await fx.call('u_sales1', 'POST', `/views/${viwAi}/share-links`, { audience: 'public' }),
          201,
        ).json(),
      );
      ok(
        await as('u_admin', 'POST', `/fields/${x.band.id}/ai/generate`, {
          scope: 'records',
          record_ids: [rec.r1],
        }),
        202,
      );
      const state = await eventually(async () => {
        const meta = (await cellOf('u_admin', rec.r1)).meta?.ai?.[x.band.id];
        return meta === undefined ? undefined : meta;
      });
      expect(state).toMatchObject({
        state: expect.stringMatching(/^(queued|running)$/u) as string,
      });
      const own = await cellOf('u_sales1', rec.r1);
      expect(own.meta?.ai?.[x.band.id]).toBeUndefined();
      expect(own.fields[x.band.id] ?? null).toBeNull();
      const shared = ok(
        await viaLink('POST', link.token, '/records/query?field_key_type=id', { ids: [rec.r1] }),
      );
      expect(shared.body).not.toContain(`"${x.band.id}":{"state"`);
      expect(shared.body).not.toContain('Cao');
    } finally {
      fake.capabilities.delayMs = 0;
      await restoreSales();
    }
    await eventually(async () =>
      (await queueOf(x.band.id)).every((row) => row.status !== 'queued' && row.status !== 'running')
        ? true
        : undefined,
    );
  });
});
