import {
  aiAutomationDraftSchema,
  automationSchema,
  createdApiTokenSchema,
  newId,
  roleListSchema,
  type ApiTokenScope,
  type Id,
} from '@cellhive/contracts';
import { type Db } from '@cellhive/server-core';
import {
  startFakeOpenAiServer,
  type FakeOpenAiReply,
  type FakeOpenAiServer,
} from '@cellhive/server-core/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ApiRateLimits } from '../../src/common/rate-limit/api-rate-limits.js';
import { AiAccess } from '../../src/modules/ai/ai-access.js';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import {
  buildRecordFixture,
  expectProblem,
  type FixtureUser,
  type RecordFixture,
} from './record-fixture.js';
import { problemOf, startTestApp, type TestApp } from './support.js';

const DAY_MS = 86_400_000;
/** The milestone sentence of S8 (Quyết định S8 #6). */
const MILESTONE = 'Khi ticket chuyển DONE thì gửi Telegram cho người phụ trách';
const EXPLANATION = 'Gửi qua kênh thông báo của người nhận (Telegram nếu đã liên kết).';

const TRIGGER = {
  type: 'record.updated',
  table: 'Tickets',
  watch_fields: ['Trạng thái'],
  changed_to: 'Đã xong',
  form: null,
  cron: null,
  date_field: null,
  offset_minutes: null,
};
const ACTION = {
  table: null,
  fields: null,
  recipients: null,
  title: null,
  text: null,
  bot: null,
  chat_id: null,
  chat_field: null,
  minutes: null,
};
const NOTIFY = {
  ...ACTION,
  type: 'send_notification',
  recipients: ['Phụ trách'],
  title: 'Ticket {{ [Tiêu đề] }} đã xong',
  text: 'Số tiền: {{ [Số tiền] }}',
};
const DRAFT = {
  name: 'Báo người phụ trách khi ticket xong',
  trigger: TRIGGER,
  condition: null,
  actions: [NOTIFY],
  explanation: EXPLANATION,
  warnings: [],
};

/** A scripted answer of the model: the draft with `changes`. */
const answer = (changes: Record<string, unknown> = {}): FakeOpenAiReply => ({
  content: JSON.stringify({ ...DRAFT, ...changes }),
});

/**
 * BACKLOG T908 (CONTRACTS §29.3, ADR-39): `POST /bases/:baseId/ai/automation-draft`
 * against the fake provider — the milestone sentence compiled to a
 * definition `POST /automations` accepts (and stores turned off), repair
 * rounds for an action drafts do not have, a field of another table and a
 * save-check error, `AI_INVALID_OUTPUT` after two; the digest of what the
 * caller manages (P91: another table is a table that does not exist);
 * `404`/`403` before anything about AI (P80, P81, P84); token scopes; the
 * time budget. Every case also checks what the provider received.
 */
describe('AI automation draft API (T908)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let fake: FakeOpenAiServer;
  let base2: Id<'bse'>;
  let assignee: Id<'fld'>;

  const url = (baseId: Id<'bse'> = fx.baseId) => `/bases/${baseId}/ai/automation-draft`;
  const ask = (
    user: FixtureUser,
    body: Record<string, unknown> = { prompt: MILESTONE },
    baseId?: Id<'bse'>,
    headers?: Record<string, string>,
  ) => fx.call(user, 'POST', url(baseId), body, headers);
  const chats = () => fake.chatRequests();
  const messagesOf = (index: number) =>
    (chats()[index]?.body?.['messages'] ?? []) as { role: string; content: string }[];
  const lastUserMessage = (index: number) => messagesOf(index).at(-1)?.content ?? '';
  /** Every request sent, data block ids made stable. */
  const sentText = () =>
    JSON.stringify(chats().map((request) => request.body)).replace(
      /<<(DATA \w+|END) [0-9a-f]{16}>>/gu,
      '<<$1 ID>>',
    );
  const automationCount = async () =>
    (await fx.call('owner', 'GET', `/bases/${fx.baseId}/automations`)).json<{ total: number }>()
      .total;
  const createToken = async (user: FixtureUser, scopes: ApiTokenScope[], extra = {}) => {
    const response = await fx.call(user, 'POST', `/orgs/${fx.orgId}/me/api-tokens`, {
      name: `${user} ${scopes.join(' ')}`,
      scopes,
      expires_at: new Date(Date.now() + 30 * DAY_MS).toISOString(),
      ...extra,
    });
    expect(response.statusCode, response.body).toBe(201);
    return { authorization: `Bearer ${createdApiTokenSchema.parse(response.json()).token}` };
  };
  const lastAudit = async () =>
    (
      await sql<{ entity_type: string; entity_id: string; base_id: string; after: object }>`
        SELECT entity_type, entity_id, base_id, after FROM meta.audit_logs
         WHERE organization_id = ${fx.orgId} AND action = 'ai.requested'
         ORDER BY created_at DESC, id DESC LIMIT 1`.execute(db.kysely)
    ).rows[0];

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp(
      { DATABASE_URL: database.url },
      { outboundLookup: () => Promise.resolve(['127.0.0.1']) },
    );
    fx = await buildRecordFixture(t, db);
    t.app.get(ApiRateLimits).ai = { limit: 10_000, windowSeconds: 60 };
    fake = await startFakeOpenAiServer();
    const entry = await fx.call('owner', 'POST', `/orgs/${fx.orgId}/http-allowlist`, {
      pattern: `localhost:${String(fake.port)}`,
    });
    expect(entry.statusCode, entry.body).toBe(201);

    // The person in charge of a ticket (CONTRACTS §1.4 + the milestone sentence).
    const field = await fx.call('owner', 'POST', `/tables/${fx.tickets.id}/fields`, {
      name: 'Phụ trách',
      type: 'user',
      options: { multiple: false },
    });
    expect(field.statusCode, field.body).toBe(201);
    assignee = field.json<{ id: Id<'fld'> }>().id;

    // "Chỉ Tickets" (C§5 S8 fixture) for u_sales2, out of g_sales: `manage` Tickets,
    // Customers read only, no Orders.
    const groups = (await fx.call('owner', 'GET', `/orgs/${fx.orgId}/groups`)).json<{
      items: { id: Id<'grp'>; name: string }[];
    }>();
    const group = groups.items.find((item) => item.name === 'g_sales');
    const left = await fx.call(
      'owner',
      'DELETE',
      `/groups/${String(group?.id)}/members/${fx.users.u_sales2.id}`,
    );
    expect(left.statusCode, left.body).toBe(204);
    const role = await fx.call('owner', 'POST', `/bases/${fx.baseId}/roles`, {
      name: 'Chỉ Tickets',
      config: {
        tables: {
          [fx.tickets.id]: { perm: 'manage', record_rule: { operations: ['add', 'delete'] } },
          [fx.customers.id]: { perm: 'read_only' },
        },
      },
    });
    expect(role.statusCode, role.body).toBe(201);
    const assigned = await fx.call('owner', 'PUT', `/bases/${fx.baseId}/role-assignments`, {
      principal_type: 'user',
      principal_id: fx.users.u_sales2.id,
      role_id: role.json<{ id: Id<'rol'> }>().id,
    });
    expect(assigned.statusCode, assigned.body).toBe(200);

    // B2: u_admin is its admin, for `tk_admin_b2`.
    const workspaces = (await fx.call('owner', 'GET', `/orgs/${fx.orgId}/workspaces`)).json<{
      items: { id: Id<'wsp'> }[];
    }>();
    const created = await fx.call(
      'owner',
      'POST',
      `/workspaces/${String(workspaces.items[0]?.id)}/bases`,
      { name: 'B2' },
    );
    expect(created.statusCode, created.body).toBe(201);
    base2 = created.json<{ id: Id<'bse'> }>().id;
    const roles2 = roleListSchema.parse(
      (await fx.call('owner', 'GET', `/bases/${base2}/roles`)).json(),
    ).items;
    const admin2 = await fx.call('owner', 'PUT', `/bases/${base2}/role-assignments`, {
      principal_type: 'user',
      principal_id: fx.users.u_admin.id,
      role_id: roles2.find((item) => item.kind === 'system_admin')?.id,
    });
    expect(admin2.statusCode, admin2.body).toBe(200);
  });

  afterAll(async () => {
    await fake.close();
    await t.close();
    await db.destroy();
    await database.drop();
  });

  beforeEach(() => {
    fake.requests.length = 0;
  });

  it('P84: AI off — 404/403 first, then 422 AI_NOT_CONFIGURED; the provider gets nothing', async () => {
    expectProblem(await ask('u_admin'), 422, 'AI_NOT_CONFIGURED');
    expectProblem(await ask('u_reader'), 403, 'PERMISSION_DENIED');
    expectProblem(await ask('u_out'), 404, 'NOT_FOUND');
    expect(fake.requests).toEqual([]);

    const configured = await fx.call('owner', 'PUT', `/orgs/${fx.orgId}/ai-settings`, {
      enabled: true,
      provider_base_url: fake.baseUrl,
      model: 'fake-model',
    });
    expect(configured.statusCode, configured.body).toBe(200);
  });

  it('drafts the milestone sentence; POST /automations accepts it turned off; nothing stored before', async () => {
    fake.script(answer());
    const response = await ask('u_admin', { prompt: MILESTONE, table_id: fx.tickets.id });
    expect(response.statusCode, response.body).toBe(200);
    const draft = aiAutomationDraftSchema.parse(response.json());
    const options = (fx.fld.ticketStatus?.options as { options: { id: string; name: string }[] })
      .options;
    const done = options.find((option) => option.name === 'Đã xong')?.id;
    const title = fx.fld.ticketTitle?.id;
    const amount = fx.fld.ticketAmount?.id;
    expect(draft).toEqual({
      name: DRAFT.name,
      description: MILESTONE,
      definition: {
        trigger: {
          type: 'record.updated',
          table_id: fx.tickets.id,
          watch_fields: [fx.fld.ticketStatus?.id],
          skip_bulk: false,
        },
        condition: { field: fx.fld.ticketStatus?.id, operator: 'changed_to', value: done },
        actions: [
          {
            id: 'act_1',
            type: 'send_notification',
            config: {
              recipients: [{ field: assignee }],
              title: { template: `Ticket {{ [${String(title)}] }} đã xong` },
              body: { template: `Số tiền: {{ [${String(amount)}] }}` },
              link_record: 'trigger',
              skip_actor: false,
            },
          },
        ],
      },
      explanation: EXPLANATION,
      warnings: [],
    });

    expect(chats()).toHaveLength(1);
    const body = chats()[0]?.body ?? {};
    expect(body).toMatchObject({
      model: 'fake-model',
      stream: false,
      max_tokens: 2000,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'automation_draft', strict: true },
      },
    });
    const sent = JSON.stringify(body);
    // Names of what the caller manages and reads; never an id or a record value.
    for (const name of [
      'Tickets',
      'Orders',
      'Trạngˆthái',
      'Phụˆtrách',
      'Đã xong',
      'send_notification',
    ]) {
      expect(sent).toContain(name);
    }
    // No bot in the base yet: no `send_telegram` to offer.
    for (const absent of [
      'fld_',
      'tbl_',
      'bse_',
      'opt_',
      'rec_',
      'usr_',
      'http_request',
      'delete_record',
      'send_telegram',
    ]) {
      expect(sent).not.toContain(absent);
    }
    expect(lastUserMessage(0)).toContain('"current_table":"Tickets"');
    expect(lastUserMessage(0).endsWith(MILESTONE)).toBe(true);

    // Never saved, never on: the caller creates it through the usual route.
    expect(await automationCount()).toBe(0);
    const saved = await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/automations`, {
      name: draft.name,
      description: draft.description,
      definition: draft.definition,
    });
    expect(saved.statusCode, saved.body).toBe(201);
    expect(automationSchema.parse(saved.json())).toMatchObject({
      enabled: false,
      definition: draft.definition,
    });

    expect(await lastAudit()).toMatchObject({
      entity_type: 'base',
      entity_id: fx.baseId,
      base_id: fx.baseId,
      after: {
        feature: 'automation_draft',
        status: 'ok',
        attempts: 1,
        output_mode: 'json_schema',
      },
    });
    const usage = await sql<{ requests: number }>`
      SELECT requests FROM meta.ai_usage_daily
       WHERE organization_id = ${fx.orgId} AND feature = 'automation_draft'`.execute(db.kysely);
    expect(usage.rows).toEqual([{ requests: 1 }]);
    expect(t.logs.raw()).not.toContain('người phụ trách');
    expect(t.logs.raw()).not.toContain('<<DATA');
  });

  it('repairs an action drafts do not have (http_request): zod refuses it, then a warning', async () => {
    const warning = { code: 'unsupported_action', message: 'Không gọi được API ngoài.' };
    fake.script(
      answer({ actions: [NOTIFY, { ...ACTION, type: 'http_request' }] }),
      answer({ warnings: [warning] }),
    );
    const response = await ask('u_admin', { prompt: `${MILESTONE} rồi gọi API ngoài` });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ warnings: [warning] });
    expect(response.json<{ definition: { actions: unknown[] } }>().definition.actions).toHaveLength(
      1,
    );
    expect(chats()).toHaveLength(2);
    expect(lastUserMessage(1)).toContain('Your previous answer cannot be used');
    expect(lastUserMessage(1)).toContain('"path":"actions[1].type"');
    expect(await lastAudit()).toMatchObject({ after: { status: 'ok', attempts: 2 } });
  });

  it('repairs a field of another table and a save-check error, never naming an id', async () => {
    fake.script(
      answer({ trigger: { ...TRIGGER, watch_fields: ['amount'] } }),
      answer({
        actions: [
          { ...ACTION, type: 'update_record', fields: [{ field: 'Mã ticket', value: 'x' }] },
        ],
      }),
      answer(),
    );
    const response = await ask('u_admin');
    expect(response.statusCode, response.body).toBe(200);
    expect(chats()).toHaveLength(3);
    expect(lastUserMessage(1)).toContain(
      '{"path":"trigger.watch_fields[0]","code":"UNKNOWN_FIELD","message":"Not a field of this table"}',
    );
    // `validateAutomationDefinition` (the save check): a computed field, by name.
    expect(lastUserMessage(2)).toContain(
      '"path":"actions[0].config.fields.Mã ticket","code":"FIELD_READ_ONLY"',
    );
    for (const index of [1, 2]) expect(lastUserMessage(index)).not.toMatch(/(fld|tbl|opt)_/u);
  });

  it('offers the bots usable in the base; the draft names one, saved by its id', async () => {
    const secret = await fx.call('owner', 'POST', `/orgs/${fx.orgId}/secrets`, {
      kind: 'telegram_bot',
      name: 'Bot nhóm',
      value: '000000000:FAKE_TEST_TOKEN_not_a_real_bot_000000',
      base_scope: 'all',
    });
    expect(secret.statusCode, secret.body).toBe(201);
    const botId = secret.json<{ id: Id<'sec'> }>().id;
    fake.script(
      answer({
        actions: [
          {
            ...ACTION,
            type: 'send_telegram',
            bot: 'Bot nhóm',
            chat_id: '-1001234567890',
            text: '{{ [Tiêu đề] }} xong',
          },
        ],
      }),
    );
    const response = await ask('u_admin');
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      definition: {
        actions: [
          {
            type: 'send_telegram',
            config: { secret_id: botId, chat_id: { literal: '-1001234567890' } },
          },
        ],
      },
    });
    const format = JSON.stringify(chats()[0]?.body?.['response_format']);
    expect(format).toContain('"Bot nhóm"');
    expect(format).toContain('send_telegram');
    expect(JSON.stringify(chats()[0]?.body)).not.toContain(botId);
  });

  it('offers the AI actions only with record data on (T911); the draft is saved checked', async () => {
    expect(JSON.stringify(chats())).toBe('[]');
    fake.script(answer());
    expect((await ask('u_admin')).statusCode).toBe(200);
    expect(JSON.stringify(chats()[0]?.body?.['response_format'])).not.toContain('ai_classify');
    const on = await fx.call('owner', 'PUT', `/orgs/${fx.orgId}/ai-settings`, {
      allow_record_data: true,
      confirm: true,
    });
    expect(on.statusCode, on.body).toBe(200);
    try {
      fake.requests.length = 0;
      fake.script(
        answer({
          actions: [
            {
              ...ACTION,
              type: 'ai_classify',
              prompt: 'Phân loại {{ [Tiêu đề] }}',
              target_field: 'Trạng thái',
            },
          ],
        }),
      );
      const response = await ask('u_admin');
      expect(response.statusCode, response.body).toBe(200);
      expect(JSON.stringify(chats()[0]?.body?.['response_format'])).toContain('ai_classify');
      expect(response.json()).toMatchObject({
        definition: {
          actions: [
            {
              type: 'ai_classify',
              config: {
                input: `Phân loại {{ [${fx.fld['ticketTitle']?.id ?? ''}] }}`,
                target_field_id: fx.fld['ticketStatus']?.id,
              },
            },
          ],
        },
      });
    } finally {
      const off = await fx.call('owner', 'PUT', `/orgs/${fx.orgId}/ai-settings`, {
        allow_record_data: false,
      });
      expect(off.statusCode, off.body).toBe(200);
    }
  });

  it('gives up after 2 repair rounds: 422 AI_INVALID_OUTPUT with attempts 3', async () => {
    const wrong = answer({ actions: [{ ...NOTIFY, title: null }] });
    fake.script(wrong, wrong, wrong);
    const response = await ask('u_admin');
    expectProblem(response, 422, 'AI_INVALID_OUTPUT');
    expect(problemOf(response.body)['errors']).toEqual([
      expect.objectContaining({ code: 'AI_INVALID_OUTPUT', params: { attempts: 3 } }),
    ]);
    expect(chats()).toHaveLength(3);
    expect(await lastAudit()).toMatchObject({
      after: { feature: 'automation_draft', status: 'AI_INVALID_OUTPUT', attempts: 3 },
    });
  });

  it('P91: for "Chỉ Tickets" another table is a table that does not exist; never saved', async () => {
    const before = await automationCount();
    const named = (table: string) => answer({ trigger: { ...TRIGGER, table } });
    fake.script(named('Orders'), named('Orders'), named('Orders'));
    const hidden = await ask('u_sales2', { prompt: 'Khi đơn hàng Orders xong thì báo owner' });
    expectProblem(hidden, 422, 'AI_INVALID_OUTPUT');
    expect(chats()).toHaveLength(3);
    const hiddenSent = sentText();
    const [system, first] = messagesOf(0).map((message) => message.content);
    // The digest and the answer format: Tickets only.
    for (const absent of ['Orders', 'Customers', 'cost', 'amount', 'schedule']) {
      expect(system).not.toContain(absent);
      expect(first?.replace('Khi đơn hàng Orders xong thì báo owner', '')).not.toContain(absent);
      expect(JSON.stringify(chats()[0]?.body?.['response_format'])).not.toContain(absent);
    }

    fake.requests.length = 0;
    fake.script(named('Giao hàng'), named('Giao hàng'), named('Giao hàng'));
    const missing = await ask('u_sales2', { prompt: 'Khi đơn hàng Giao hàng xong thì báo owner' });
    expectProblem(missing, 422, 'AI_INVALID_OUTPUT');
    // The same prompts and repair problems, the name aside.
    expect(problemOf(missing.body)['errors']).toEqual(problemOf(hidden.body)['errors']);
    expect(sentText()).toBe(hiddenSent.replaceAll('Orders', 'Giao hàng'));

    // A model that leaves the impossible part out: a Tickets draft with a warning.
    fake.requests.length = 0;
    const warning = { code: 'unsupported_trigger', message: 'Không có bảng Orders.' };
    fake.script(answer({ warnings: [warning] }));
    const drafted = await ask('u_sales2', { prompt: 'Khi đơn hàng Orders xong thì báo owner' });
    expect(drafted.statusCode, drafted.body).toBe(200);
    expect(drafted.json()).toMatchObject({
      definition: { trigger: { table_id: fx.tickets.id } },
      warnings: [warning],
    });
    expect(drafted.body).not.toContain(fx.orders.id);
    expect(await automationCount()).toBe(before);
  });

  it('P81: reader and editor (no automation rights) get 403, the provider gets nothing', async () => {
    expectProblem(await ask('u_reader'), 403, 'PERMISSION_DENIED');
    expectProblem(await ask('u_editor'), 403, 'PERMISSION_DENIED');
    // Sales: `edit` on Orders, manages nothing.
    expectProblem(await ask('u_sales1'), 403, 'PERMISSION_DENIED');
    // "Chỉ Tickets" reads Customers without managing it.
    expectProblem(
      await ask('u_sales2', { prompt: MILESTONE, table_id: fx.customers.id }),
      403,
      'PERMISSION_DENIED',
    );
    expect(fake.requests).toEqual([]);
  });

  it('P80: another member, another org, a token of base B2, unknown ids → 404, nothing sent', async () => {
    const b2 = await createToken('u_admin', ['automations:read'], { base_ids: [base2] });
    for (const response of [
      await ask('u_out'),
      await ask('stranger'),
      await ask('u_admin', { prompt: MILESTONE }, undefined, b2),
      await ask('u_admin', { prompt: MILESTONE }, newId('bse')),
      await ask('u_admin', { prompt: MILESTONE, table_id: newId('tbl') }),
      // A table of base B2, and Orders for "Chỉ Tickets".
      await ask('u_admin', { prompt: MILESTONE, table_id: fx.tickets.id }, base2),
      await ask('u_sales2', { prompt: MILESTONE, table_id: fx.orders.id }),
    ]) {
      expectProblem(response, 404, 'NOT_FOUND');
    }
    expect(fake.requests).toEqual([]);
  });

  it('P89: an automations:read token drafts; a token without it gets 403 INSUFFICIENT_SCOPE', async () => {
    const readOnly = await createToken('u_admin', ['automations:read']);
    fake.script(answer());
    const ok = await ask('u_admin', { prompt: MILESTONE }, undefined, readOnly);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(chats()).toHaveLength(1);

    fake.requests.length = 0;
    const other = await createToken('u_admin', ['schema:read', 'automations:write']);
    const denied = await ask('u_admin', { prompt: MILESTONE }, undefined, other);
    expectProblem(denied, 403, 'INSUFFICIENT_SCOPE');
    expect(problemOf(denied.body)['errors']).toEqual([
      expect.objectContaining({ params: { required: ['automations:read'] } }),
    ]);
    expect(fake.requests).toEqual([]);
  });

  it('validates the body before calling the provider; nothing turns a draft on', async () => {
    for (const body of [
      {},
      { prompt: '   ' },
      { prompt: 'x'.repeat(1001) },
      { prompt: MILESTONE, table_id: 'nope' },
      { prompt: MILESTONE, enabled: true },
    ]) {
      expectProblem(await ask('u_admin', body), 422, 'VALIDATION_FAILED');
    }
    expect(fake.requests).toEqual([]);
  });

  it('stops at the time budget of the request: 504 AI_TIMEOUT', async () => {
    const access = t.app.get(AiAccess);
    access.budgetMs = 400;
    fake.capabilities.delayMs = 250;
    try {
      // Deterministic answers (the minimal instance) never compile: the repair runs out of time.
      const response = await ask('u_admin');
      expectProblem(response, 504, 'AI_TIMEOUT');
      expect(chats().length).toBeLessThanOrEqual(2);
      expect(await lastAudit()).toMatchObject({ after: { status: 'AI_TIMEOUT' } });
    } finally {
      access.budgetMs = 90_000;
      fake.capabilities.delayMs = 0;
    }
  });
});
