import {
  aiAskSchema,
  createdApiTokenSchema,
  newId,
  roleListSchema,
  type AiAsk,
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
import { WidgetQueryLimiter } from '../../src/modules/dashboard/widget-query-limiter.js';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import {
  buildRecordFixture,
  expectProblem,
  type FixtureUser,
  type RecordFixture,
} from './record-fixture.js';
import { problemOf, startTestApp, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

const DAY_MS = 86_400_000;
const QUESTION = 'Doanh thu theo tháng';
const HCM = 'Asia/Ho_Chi_Minh';

/** A scripted plan of the model (every key, as the strict schema asks). */
const plan = (extra: Record<string, unknown> = {}): FakeOpenAiReply => ({
  content: JSON.stringify({
    answerable: true,
    chart: 'line',
    title: 'Doanh thu theo tháng',
    metric: { aggregation: 'sum', field: 'amount' },
    dimension: { field: 'ngày', date_bucket: 'month' },
    series: null,
    filter: null,
    sort: null,
    limit: null,
    compare: null,
    ...extra,
  }),
});
const unanswerable: FakeOpenAiReply = plan({ answerable: false });

/**
 * BACKLOG T909 (CONTRACTS §29.4, ADR-39): `POST /tables/:tableId/ai/ask`
 * against the fake provider — "revenue by month" with the asker's
 * permissions (P79: u_sales1 only the group of r1), month buckets in the
 * asker's zone, a narrative only with `allow_record_data` (a second request
 * with aggregated rows only), P78 (a hidden field asks like a missing one),
 * `404` before anything about AI (P80, P84), token scopes (P89), repair
 * rounds and the widget line shared with dashboards. Every case also checks
 * what the provider received.
 */
describe('AI Q&A on a table (T909)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let fake: FakeOpenAiServer;
  let base2: Id<'bse'>;
  let dateField: Id<'fld'>;

  const ask = (
    user: FixtureUser,
    body: Record<string, unknown> = { question: QUESTION, timezone: HCM },
    tableId: Id<'tbl'> = fx.orders.id,
    headers?: Record<string, string>,
  ) => fx.call(user, 'POST', `/tables/${tableId}/ai/ask`, body, headers);
  const answerOf = (response: LightMyRequestResponse): AiAsk => {
    expect(response.statusCode, response.body).toBe(200);
    return aiAskSchema.parse(response.json());
  };
  const ok = (response: LightMyRequestResponse) => {
    const answer = answerOf(response);
    if (answer.status !== 'ok') throw new Error(`expected an answer, got ${answer.status}`);
    return answer;
  };
  /** `[month, sum]` of a monthly answer. */
  const months = (answer: Extract<AiAsk, { status: 'ok' }>) =>
    answer.data.rows.map(([group, sum]) => [(group as { value: unknown }).value, sum]);
  const chats = () => fake.chatRequests();
  const textOf = (index: number) => JSON.stringify(chats()[index]?.body?.['messages']);
  const lastUserMessage = (index: number) => {
    const messages = chats()[index]?.body?.['messages'] as { content: string }[] | undefined;
    return messages?.at(-1)?.content ?? '';
  };
  const createToken = async (
    user: FixtureUser,
    scopes: ApiTokenScope[],
    extra: Record<string, unknown> = {},
  ) => {
    const response = await fx.call(user, 'POST', `/orgs/${fx.orgId}/me/api-tokens`, {
      name: `${user} ${scopes.join(' ')}`,
      scopes,
      expires_at: new Date(Date.now() + 30 * DAY_MS).toISOString(),
      ...extra,
    });
    expect(response.statusCode, response.body).toBe(201);
    return { authorization: `Bearer ${createdApiTokenSchema.parse(response.json()).token}` };
  };
  const setRecordData = async (on: boolean) => {
    const response = await fx.call('owner', 'PUT', `/orgs/${fx.orgId}/ai-settings`, {
      allow_record_data: on,
      ...(on ? { confirm: true } : {}),
    });
    expect(response.statusCode, response.body).toBe(200);
  };
  const lastAudit = async () =>
    (
      await sql<{ entity_type: string; entity_id: string; table_id: string; after: object }>`
        SELECT entity_type, entity_id, table_id, after FROM meta.audit_logs
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

    const created = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
      name: 'ngày',
      type: 'datetime',
      options: { style: { format: 'yyyy-MM-dd HH:mm' } },
    });
    expect(created.statusCode, created.body).toBe(201);
    dateField = created.json<{ id: Id<'fld'> }>().id;
    // r1 at 23:30 UTC on the last day of September: October in Ho Chi Minh City.
    const records = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/records`, {
      records: [
        {
          fields: {
            title: 'r1',
            amount: 100,
            cost: 10,
            owner: [{ id: fx.users.u_sales1.id }],
            ngày: '2026-09-30T23:30:00.000Z',
          },
        },
        {
          fields: {
            title: 'r2',
            amount: 200,
            cost: 20,
            owner: [{ id: fx.users.u_sales2.id }],
            ngày: '2026-08-15T10:00:00.000Z',
          },
        },
        { fields: { title: 'r3', amount: 300, cost: 30, ngày: '2026-10-10T10:00:00.000Z' } },
      ],
    });
    expect(records.statusCode, records.body).toBe(201);

    // B2: u_admin is its admin, for a token of B2 only.
    const workspaces = (await fx.call('owner', 'GET', `/orgs/${fx.orgId}/workspaces`)).json<{
      items: { id: Id<'wsp'> }[];
    }>();
    const b2 = await fx.call(
      'owner',
      'POST',
      `/workspaces/${String(workspaces.items[0]?.id)}/bases`,
      { name: 'B2' },
    );
    expect(b2.statusCode, b2.body).toBe(201);
    base2 = b2.json<{ id: Id<'bse'> }>().id;
    const roles2 = roleListSchema.parse(
      (await fx.call('owner', 'GET', `/bases/${base2}/roles`)).json(),
    ).items;
    const assigned = await fx.call('owner', 'PUT', `/bases/${base2}/role-assignments`, {
      principal_type: 'user',
      principal_id: fx.users.u_admin.id,
      role_id: roles2.find((role) => role.kind === 'system_admin')?.id,
    });
    expect(assigned.statusCode, assigned.body).toBe(200);
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

  it('P84: AI off — 404 first, then 422 AI_NOT_CONFIGURED for any reader; nothing sent', async () => {
    expectProblem(await ask('u_out'), 404, 'NOT_FOUND');
    expectProblem(await ask('u_reader'), 422, 'AI_NOT_CONFIGURED');
    expectProblem(await ask('u_sales1'), 422, 'AI_NOT_CONFIGURED');
    expect(fake.requests).toEqual([]);

    const configured = await fx.call('owner', 'PUT', `/orgs/${fx.orgId}/ai-settings`, {
      enabled: true,
      provider_base_url: fake.baseUrl,
      model: 'fake-model',
    });
    expect(configured.statusCode, configured.body).toBe(200);
  });

  it('P79: "revenue by month" with the asker’s permissions, one request without record data', async () => {
    fake.script(plan());
    const admin = ok(await ask('u_admin'));
    // r1 (23:30 UTC on 30 September) is in October in Ho Chi Minh City.
    expect(months(admin)).toEqual([
      ['2026-08-01', 200],
      ['2026-10-01', 400],
    ]);
    expect(admin.narrative).toBeNull();
    expect(admin.widget).toMatchObject({
      type: 'line',
      title: 'Doanh thu theo tháng',
      config: {
        table_id: fx.orders.id,
        metrics: [{ id: 'm1', aggregation: 'sum', field: fx.fld.amount?.id }],
        dimension: { field: dateField, date_bucket: 'month' },
        sort: 'dimension_asc',
      },
    });
    expect(admin.interpretation).toEqual({
      metric: 'sum',
      field: { id: fx.fld.amount?.id, name: 'amount' },
      dimension: { id: dateField, name: 'ngày' },
      bucket: 'month',
      series: null,
      series_bucket: null,
      filter_logic: 'and',
      filters: [],
      compare: null,
    });
    expect(admin.data).toMatchObject({ status: 'ok', cache: 'miss', ignored_filters: [] });

    // Exactly one request: the plan, by name, never an id or a value.
    expect(chats()).toHaveLength(1);
    const body = chats()[0]?.body ?? {};
    expect(body).toMatchObject({
      model: 'fake-model',
      stream: false,
      max_tokens: 600,
      response_format: { type: 'json_schema', json_schema: { name: 'ask_plan', strict: true } },
    });
    const sent = JSON.stringify(body);
    for (const name of ['Orders', 'amount', 'cost', 'status', 'Xong', 'Today is ']) {
      expect(sent).toContain(name);
    }
    for (const id of ['fld_', 'tbl_', 'bse_', 'opt_', 'rec_', 'usr_']) {
      expect(sent).not.toContain(id);
    }
    expect(sent).not.toContain('"r1"');
    expect(lastUserMessage(0).endsWith(`Question:\n${QUESTION}`)).toBe(true);

    expect(await lastAudit()).toMatchObject({
      entity_type: 'table',
      entity_id: fx.orders.id,
      table_id: fx.orders.id,
      after: { feature: 'ask', status: 'ok', attempts: 1, output_mode: 'json_schema' },
    });
    const usage = await sql<{ requests: number }>`
      SELECT requests FROM meta.ai_usage_daily
       WHERE organization_id = ${fx.orgId} AND feature = 'ask'`.execute(db.kysely);
    expect(usage.rows).toEqual([{ requests: 1 }]);
    expect(t.logs.raw()).toContain('ai request');
    expect(t.logs.raw()).not.toContain(QUESTION);
    expect(t.logs.raw()).not.toContain('<<DATA');

    // u_sales1 reads r1 only, and never `cost`.
    fake.requests.length = 0;
    fake.script(plan());
    expect(months(ok(await ask('u_sales1')))).toEqual([['2026-10-01', 100]]);
    expect(textOf(0)).not.toContain('cost');
    expect(JSON.stringify(chats()[0]?.body?.['response_format'])).not.toContain('cost');
  });

  it('buckets months in the zone of the request', async () => {
    fake.script(plan());
    expect(months(ok(await ask('u_admin', { question: QUESTION, timezone: 'UTC' })))).toEqual([
      ['2026-08-01', 200],
      ['2026-09-01', 100],
      ['2026-10-01', 300],
    ]);
  });

  it('P79: with allow_record_data a second request gets the aggregated rows only', async () => {
    await setRecordData(true);
    try {
      fake.script(plan(), { content: 'Tháng 10 cao nhất với 400.' });
      const answer = ok(await ask('u_admin'));
      expect(answer.narrative).toBe('Tháng 10 cao nhất với 400.');
      expect(chats()).toHaveLength(2);
      const narrative = chats()[1]?.body ?? {};
      expect(narrative).toMatchObject({ max_tokens: 400 });
      expect(narrative['response_format']).toBeUndefined();
      const text = JSON.stringify(narrative);
      expect(lastUserMessage(1)).toMatch(/<<DATA result [0-9a-f]{16}>>/u);
      expect(text).toContain('2026-10-01');
      expect(text).toContain('400');
      for (const id of ['fld_', 'tbl_', 'opt_', 'rec_', 'usr_']) expect(text).not.toContain(id);
      for (const title of ['r1', 'r2', 'r3']) expect(text).not.toContain(`"${title}"`);
      expect(lastUserMessage(1).endsWith(`Question:\n${QUESTION}`)).toBe(true);

      // A failed narrative leaves the numbers.
      fake.requests.length = 0;
      fake.script(plan(), { status: 500 });
      const without = ok(await ask('u_admin'));
      expect(without.narrative).toBeNull();
      expect(months(without)).toHaveLength(2);

      // Nothing matched: no narrative call.
      fake.requests.length = 0;
      fake.script(plan({ filter: { logic: 'and', conditions: [['amount', '>', 1_000_000]] } }));
      const empty = ok(await ask('u_admin'));
      expect(empty.data.status).toBe('empty');
      expect(empty.narrative).toBeNull();
      expect(chats()).toHaveLength(1);
    } finally {
      await setRecordData(false);
    }
  });

  it('answers unanswerable when the model says so (the deterministic answer too)', async () => {
    expect(answerOf(await ask('u_admin'))).toEqual({ status: 'unanswerable' });
    expect(chats()).toHaveLength(1);
    expect(await lastAudit()).toMatchObject({ after: { feature: 'ask', status: 'ok' } });
  });

  it('P78: for u_sales1, asking about `cost` is asking about a field that does not exist', async () => {
    const sentText = () =>
      JSON.stringify(chats().map((request) => request.body)).replace(
        /<<(DATA \w+|END) [0-9a-f]{16}>>/gu,
        '<<$1 ID>>',
      );
    const question = (name: string) => ({ question: `tổng ${name} theo tháng`, timezone: HCM });
    const naming = (name: string) => plan({ metric: { aggregation: 'sum', field: name } });

    fake.script(unanswerable);
    const hiddenOut = answerOf(await ask('u_sales1', question('cost')));
    fake.script(unanswerable);
    const missingOut = answerOf(await ask('u_sales1', question('lãi')));
    expect(hiddenOut).toEqual({ status: 'unanswerable' });
    expect(missingOut).toEqual(hiddenOut);

    fake.requests.length = 0;
    fake.script(naming('cost'), naming('cost'), naming('cost'));
    const hidden = await ask('u_sales1', question('cost'));
    expectProblem(hidden, 422, 'AI_INVALID_OUTPUT');
    expect(chats()).toHaveLength(3);
    const hiddenSent = sentText();
    // The digest and the answer format never name `cost`: only the question does.
    expect(textOf(0).replace(question('cost').question, '')).not.toContain('cost');

    fake.requests.length = 0;
    fake.script(naming('lãi'), naming('lãi'), naming('lãi'));
    const missing = await ask('u_sales1', question('lãi'));
    expectProblem(missing, 422, 'AI_INVALID_OUTPUT');
    expect(problemOf(missing.body)['errors']).toEqual(problemOf(hidden.body)['errors']);
    expect(sentText()).toBe(hiddenSent.replaceAll('cost', 'lãi'));
    expect(hidden.body).not.toContain('no_permission');
  });

  it('repairs a plan the widget check rejects: the problems go back, 2 calls', async () => {
    fake.script(plan({ dimension: { field: 'ngày', date_bucket: null } }), plan());
    const answer = ok(await ask('u_admin'));
    expect(months(answer)).toHaveLength(2);
    expect(chats()).toHaveLength(2);
    expect(lastUserMessage(1)).toContain(
      '"path":"dimension.date_bucket","code":"DATE_BUCKET_REQUIRED"',
    );
    expect(await lastAudit()).toMatchObject({ after: { status: 'ok', attempts: 2 } });
  });

  it('gives up after 2 repair rounds: 422 AI_INVALID_OUTPUT with attempts 3', async () => {
    const wrong = plan({ chart: 'kpi' });
    fake.script(wrong, wrong, wrong);
    const response = await ask('u_admin');
    expectProblem(response, 422, 'AI_INVALID_OUTPUT');
    expect(problemOf(response.body)['errors']).toEqual([
      expect.objectContaining({ params: { attempts: 3 } }),
    ]);
    expect(lastUserMessage(1)).toContain('"path":"dimension","code":"UNRECOGNIZED_KEY"');
    expect(await lastAudit()).toMatchObject({
      after: { feature: 'ask', status: 'AI_INVALID_OUTPUT', attempts: 3 },
    });
  });

  it('P80: another member, another org, a token of base B2, an unknown table → 404, nothing sent', async () => {
    const b2 = await createToken('u_admin', ['records:read'], { base_ids: [base2] });
    for (const response of [
      await ask('u_out'),
      await ask('stranger'),
      await ask('u_admin', undefined, fx.orders.id, b2),
      await ask('u_admin', undefined, newId('tbl')),
    ]) {
      expectProblem(response, 404, 'NOT_FOUND');
    }
    expect(fake.requests).toEqual([]);
  });

  it('P89: a records:read token asks like its user; without it 403 INSUFFICIENT_SCOPE', async () => {
    const salesToken = await createToken('u_sales1', ['records:read']);
    fake.script(plan());
    expect(months(ok(await ask('u_sales1', undefined, fx.orders.id, salesToken)))).toEqual([
      ['2026-10-01', 100],
    ]);

    fake.requests.length = 0;
    const schemaToken = await createToken('u_admin', ['schema:read']);
    const denied = await ask('u_admin', undefined, fx.orders.id, schemaToken);
    expectProblem(denied, 403, 'INSUFFICIENT_SCOPE');
    expect(problemOf(denied.body)['errors']).toEqual([
      expect.objectContaining({ params: { required: ['records:read'] } }),
    ]);
    expect(fake.requests).toEqual([]);
  });

  it('runs in the widget query line of dashboards: 504 QUERY_TIMEOUT with Retry-After', async () => {
    const limiter = t.app.get(WidgetQueryLimiter);
    const { total, waitMs } = limiter;
    limiter.total = 0;
    limiter.waitMs = 50;
    try {
      fake.script(plan());
      const response = await ask('u_admin');
      expectProblem(response, 504, 'QUERY_TIMEOUT');
      expect(response.headers['retry-after']).toBe('5');
    } finally {
      limiter.total = total;
      limiter.waitMs = waitMs;
    }
  });

  it('validates the body before calling the provider', async () => {
    for (const body of [
      {},
      { question: '   ' },
      { question: 'x'.repeat(501) },
      { question: QUESTION, timezone: 'Mars/Olympus' },
      { question: QUESTION, extra: true },
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
      fake.script(plan({ chart: 'kpi' }), plan({ chart: 'kpi' }));
      expectProblem(await ask('u_admin'), 504, 'AI_TIMEOUT');
      expect(chats().length).toBeLessThanOrEqual(2);
    } finally {
      access.budgetMs = 90_000;
      fake.capabilities.delayMs = 0;
    }
  });
});
