import { Buffer } from 'node:buffer';
import { request as httpRequest } from 'node:http';

import { aiAskSchema, createdApiTokenSchema, fieldSchema, type Id } from '@cellhive/contracts';
import {
  AiFieldGenerator,
  aiUsageClampedCounts,
  createAiKeySource,
  httpAllowlistSource,
  LlmClient,
  orgScope,
  quotaDayOf,
  RecordMutationService,
  RecordQueryService,
  recomputeJobBatchId,
  type Db,
} from '@cellhive/server-core';
import {
  startFakeOpenAiServer,
  type FakeOpenAiReply,
  type FakeOpenAiServer,
} from '@cellhive/server-core/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiRateLimits } from '../../src/common/rate-limit/api-rate-limits.js';
import { CACHE_CLIENT } from '../../src/common/tokens.js';

import { Browser } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { listen } from './realtime-support.js';
import {
  buildRecordFixture,
  expectProblem,
  type FixtureUser,
  type RecordFixture,
} from './record-fixture.js';
import { problemOf, startTestApp, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';
import type { Redis } from 'ioredis';

const LOCALHOST = () => Promise.resolve(['127.0.0.1']);
const HCM = 'Asia/Ho_Chi_Minh';
const LIMIT = 10_000;
const DAY_MS = 86_400_000;
const QUESTION = 'Doanh thu theo tháng';

/** A plan of "revenue by month" over the `ngày` field. */
const plan = (): FakeOpenAiReply => ({
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
  }),
});
/** An answer that is not the asked JSON: the next step is a repair round (or the next rung). */
const notJson: FakeOpenAiReply = { content: 'not JSON at all' };
/** Cut off while the model reasoned: the client sends it once more with room to reason. */
const reasoningCutOff: FakeOpenAiReply = {
  raw: JSON.stringify({
    choices: [{ message: { content: '', reasoning_content: 'Hmm…' }, finish_reason: 'length' }],
    usage: { prompt_tokens: 50, completion_tokens: 300 },
  }),
};

/**
 * BACKLOG T1004 (CONTRACTS §29.1, §29.7, ADR-39 §6): the quota is checked
 * before **every** provider call. Each call site of the API — a formula's
 * repair round, a draft's, the Q&A narrative after its plan, the resend of
 * a reasoning model, "Test connection" after `GET /models`, the 5 records of
 * a preview — and the worker's repair round: the quota reached by the
 * first call, the next call never reaches the provider (counted on the
 * fake). Then: the concurrency slots shared by two API instances (2 per
 * person, 8 per organization), a provider `usage` cut to its bound and
 * read before `choices`, an audit entry that cannot be written never
 * replacing the request's error, and a client that closes its request
 * aborting the provider call and releasing its slots.
 */
describe('AI quota before every call, slots across instances (T1004)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let other: TestApp;
  let fx: RecordFixture;
  let fake: FakeOpenAiServer;
  const records: Id<'rec'>[] = [];

  const chats = () => fake.chatRequests();
  const today = () => quotaDayOf(new Date(), HCM).day;
  /** Today's tokens of the organization, every feature. */
  const usedToday = async () =>
    Number(
      (
        await sql<{ tokens: string }>`
          SELECT coalesce(sum(prompt_tokens + completion_tokens), 0) AS tokens
            FROM meta.ai_usage_daily
           WHERE organization_id = ${fx.orgId} AND day = ${today()}`.execute(db.kysely)
      ).rows[0]?.tokens ?? 0,
    );
  /** Today's ledger set to `LIMIT - left` tokens: the first call passes, its usage reaches the limit. */
  const leaveTokens = async (left: number) => {
    await sql`DELETE FROM meta.ai_usage_daily WHERE organization_id = ${fx.orgId}`.execute(
      db.kysely,
    );
    await sql`
      INSERT INTO meta.ai_usage_daily (organization_id, day, feature, requests, prompt_tokens, completion_tokens)
      VALUES (${fx.orgId}, ${today()}, 'test', 1, ${LIMIT - left}, 0)`.execute(db.kysely);
  };
  const settings = async (body: Record<string, unknown>) => {
    const response = await fx.call('owner', 'PUT', `/orgs/${fx.orgId}/ai-settings`, body);
    expect(response.statusCode, response.body).toBe(200);
  };
  const ask = (user: FixtureUser = 'u_admin') =>
    fx.call(user, 'POST', `/tables/${fx.orders.id}/ai/ask`, { question: QUESTION, timezone: HCM });
  const lastAudit = async () =>
    (
      await sql<{ after: Record<string, unknown> }>`
        SELECT after FROM meta.audit_logs
         WHERE organization_id = ${fx.orgId} AND action = 'ai.requested'
         ORDER BY created_at DESC, id DESC LIMIT 1`.execute(db.kysely)
    ).rows[0]?.after;

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url }, { outboundLookup: LOCALHOST });
    other = await startTestApp({ DATABASE_URL: database.url }, { outboundLookup: LOCALHOST });
    fx = await buildRecordFixture(t, db);
    for (const app of [t, other]) {
      app.app.get(ApiRateLimits).ai = { limit: 10_000, windowSeconds: 60 };
      app.app.get(ApiRateLimits).perPrincipal = { limit: 100_000, windowSeconds: 1 };
      app.app.get(ApiRateLimits).perBase = { limit: 100_000, windowSeconds: 1 };
    }
    fake = await startFakeOpenAiServer();
    const entry = await fx.call('owner', 'POST', `/orgs/${fx.orgId}/http-allowlist`, {
      pattern: `localhost:${String(fake.port)}`,
    });
    expect(entry.statusCode, entry.body).toBe(201);
    await settings({
      enabled: true,
      provider_base_url: fake.baseUrl,
      model: 'fake-model',
      daily_token_limit: LIMIT,
    });
    await settings({ allow_record_data: true, confirm: true });

    const created = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
      name: 'ngày',
      type: 'datetime',
    });
    expect(created.statusCode, created.body).toBe(201);
    const inserted = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/records`, {
      records: [
        ['r1', 100, '2026-08-15'],
        ['r2', 200, '2026-09-10'],
        ['r3', 300, '2026-10-10'],
        ['r4', 400, '2026-10-12'],
        ['r5', 500, '2026-10-14'],
        ['r6', 600, '2026-10-16'],
      ].map(([title, amount, day]) => ({ fields: { title, amount, ngày: day } })),
    });
    expect(inserted.statusCode, inserted.body).toBe(201);
    records.push(...inserted.json<{ records: { id: Id<'rec'> }[] }>().records.map((r) => r.id));
  }, 120_000);

  afterAll(async () => {
    await fake.close();
    await other.close();
    await t.close();
    await db.destroy();
    await database.drop();
  });

  beforeEach(() => {
    fake.requests.length = 0;
    fake.capabilities.delayMs = 0;
  });

  describe('every call site: the quota reached between two calls stops the next one', () => {
    const cases: {
      readonly site: string;
      readonly script: readonly FakeOpenAiReply[];
      readonly send: () => Promise<LightMyRequestResponse>;
      /** `GET /models` requests besides the chat calls. */
      readonly models?: number;
      readonly answered?: (response: LightMyRequestResponse) => void;
    }[] = [
      {
        site: 'formula: its repair round',
        script: [notJson],
        send: () =>
          fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/ai/formula`, {
            description: 'Lãi = tiền trừ chi phí',
          }),
      },
      {
        site: 'automation draft: its repair round',
        script: [notJson],
        send: () =>
          fx.call('u_admin', 'POST', `/bases/${fx.baseId}/ai/automation-draft`, {
            prompt: 'Khi ticket xong thì báo người phụ trách',
          }),
      },
      {
        site: 'ask: the narrative after the plan (the numbers stand, no narrative)',
        script: [plan()],
        send: () => ask(),
        answered: (response) => {
          expect(response.statusCode, response.body).toBe(200);
          const answer = aiAskSchema.parse(response.json());
          expect(answer).toMatchObject({ status: 'ok', narrative: null });
        },
      },
      {
        site: 'test connection: the probe on the next rung after GET /models',
        script: [notJson],
        send: () => fx.call('owner', 'POST', `/orgs/${fx.orgId}/ai-settings/test`, {}),
        models: 1,
      },
      {
        site: 'preview: the second of 5 records',
        script: [],
        send: () =>
          fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/ai/field-preview`, {
            field_id: null,
            type: 'text',
            choices: [],
            ai: { task: 'summarize', prompt: 'Tóm tắt {{ [title] }}' },
          }),
      },
      // Last: the client remembers the model as reasoning from here on.
      {
        site: 'the resend of a model cut off while reasoning',
        script: [reasoningCutOff],
        send: () =>
          fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/ai/formula`, {
            description: 'Tổng tiền',
          }),
      },
    ];

    it.each(cases)('$site', async ({ script, send, models = 0, answered }) => {
      await leaveTokens(1);
      fake.script(...script);
      const response = await send();
      if (answered === undefined) {
        expectProblem(response, 429, 'AI_QUOTA_EXCEEDED');
        expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
      } else {
        answered(response);
      }
      expect(chats()).toHaveLength(1);
      expect(fake.requests).toHaveLength(1 + models);
      // The call that was sent is in the ledger: today is at (or past) the limit.
      expect(await usedToday()).toBeGreaterThanOrEqual(LIMIT);
    });

    it('the worker: a select answer outside the options, its repair round never sent; rows paused quota', async () => {
      await sql`DELETE FROM meta.ai_usage_daily WHERE organization_id = ${fx.orgId}`.execute(
        db.kysely,
      );
      const created = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
        name: 'Mức độ',
        type: 'select',
        options: {
          options: [{ name: 'Thấp' }, { name: 'Cao' }],
          ai: { task: 'classify', prompt: '{{ [title] }}', auto_update: false },
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      const level = fieldSchema.parse(created.json());
      const generated = await fx.call('u_admin', 'POST', `/fields/${level.id}/ai/generate`, {
        scope: 'records',
        record_ids: records.slice(0, 2),
      });
      expect(generated.statusCode, generated.body).toBe(202);
      await leaveTokens(1);
      fake.script({ content: JSON.stringify({ option: 'Khẩn' }) });
      const generator = new AiFieldGenerator(db, {
        llm: new LlmClient({
          allowlist: httpAllowlistSource(db),
          privateAllowlist: 'org',
          keys: createAiKeySource(db, t.config.security.appMasterKey),
          lookup: LOCALHOST,
        }),
        records: t.app.get(RecordQueryService),
        mutations: t.app.get(RecordMutationService),
        defaultTimeZone: HCM,
        defaultLocale: 'vi',
      });
      const outcome = await generator.runBatch(
        orgScope(fx.orgId),
        level.id,
        recomputeJobBatchId(1),
      );
      expect(outcome).toMatchObject({ status: 'paused', pausedReason: 'quota', calls: 1 });
      expect(chats()).toHaveLength(1);
      const rows = await sql<{ status: string; reason: string | null; attempts: number }>`
        SELECT status, reason, attempts FROM meta.ai_generation_queue
         WHERE organization_id = ${fx.orgId} AND field_id = ${level.id}`.execute(db.kysely);
      expect(rows.rows).toEqual([
        { status: 'paused', reason: 'quota', attempts: 0 },
        { status: 'paused', reason: 'quota', attempts: 0 },
      ]);
      await sql`DELETE FROM meta.ai_generation_queue WHERE field_id = ${level.id}`.execute(
        db.kysely,
      );
    });
  });

  describe('usage of an answer', () => {
    beforeEach(async () => {
      await sql`DELETE FROM meta.ai_usage_daily WHERE organization_id = ${fx.orgId}`.execute(
        db.kysely,
      );
    });

    it('prompt_tokens = 9e15: the ledger records the bytes sent, not the claim', async () => {
      const clamped = aiUsageClampedCounts().get('prompt') ?? 0;
      fake.script({
        raw: JSON.stringify({
          choices: [{ message: { content: '{"formula":"[amount]","explanation":"x"}' } }],
          usage: { prompt_tokens: 9e15, completion_tokens: 12 },
        }),
      });
      const response = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/ai/formula`, {
        description: 'Tiền',
      });
      expect(response.statusCode, response.body).toBe(200);
      const sent = Buffer.byteLength(JSON.stringify(chats()[0]?.body));
      const row = (
        await sql<{ prompt_tokens: bigint; completion_tokens: bigint }>`
          SELECT prompt_tokens, completion_tokens FROM meta.ai_usage_daily
           WHERE organization_id = ${fx.orgId} AND feature = 'formula'`.execute(db.kysely)
      ).rows[0];
      expect(row).toEqual({ prompt_tokens: BigInt(sent), completion_tokens: 12n });
      expect(aiUsageClampedCounts().get('prompt')).toBe(clamped + 1);
      const warned = t.logs.lines.filter(
        (line) => line['msg'] === 'ai usage out of bounds: counted at its bound',
      );
      expect(warned.at(-1)).toMatchObject({ level: 'warn', kind: 'prompt' });
      expect(JSON.stringify(warned)).not.toMatch(/9e\+?15|9000000000000000/u);
    });

    it('choices: [] with usage: counted in the ledger, then 502 invalid_response', async () => {
      fake.script({
        raw: JSON.stringify({ choices: [], usage: { prompt_tokens: 70, completion_tokens: 5 } }),
      });
      const response = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/ai/formula`, {
        description: 'Tiền',
      });
      expectProblem(response, 502, 'AI_PROVIDER_ERROR');
      expect(problemOf(response.body)['errors']).toEqual([
        expect.objectContaining({ params: { reason: 'invalid_response' } }),
      ]);
      expect(await usedToday()).toBe(75);
    });
  });

  it('an audit entry that cannot be written never replaces the error of the request (L19)', async () => {
    await sql`
      CREATE FUNCTION meta.t1004_refuse_ai_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'ai.requested' THEN RAISE EXCEPTION 't1004 audit refused'; END IF;
        RETURN NEW;
      END $$`.execute(db.kysely);
    await sql`
      CREATE TRIGGER t1004_refuse_ai_audit BEFORE INSERT ON meta.audit_logs
        FOR EACH ROW EXECUTE FUNCTION meta.t1004_refuse_ai_audit()`.execute(db.kysely);
    try {
      await leaveTokens(1);
      fake.script(notJson);
      expectProblem(
        await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/ai/formula`, {
          description: 'Tiền',
        }),
        429,
        'AI_QUOTA_EXCEEDED',
      );
      await leaveTokens(LIMIT);
      fake.script({ content: '{"formula":"[amount]","explanation":"x"}' });
      const answered = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/ai/formula`, {
        description: 'Tiền',
      });
      expect(answered.statusCode, answered.body).toBe(200);
      const lines = t.logs.lines.filter(
        (line) => line['msg'] === 'ai request audit entry not written',
      );
      expect(lines.length).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(lines)).not.toContain('Tiền');
    } finally {
      await sql`DROP TRIGGER t1004_refuse_ai_audit ON meta.audit_logs`.execute(db.kysely);
      await sql`DROP FUNCTION meta.t1004_refuse_ai_audit()`.execute(db.kysely);
    }
  });

  describe('slots shared by two API instances', () => {
    const browsers = new Map<FixtureUser, Browser>();
    /** `POST …/ai/ask` of `user` on the second instance (its own sign-in). */
    const askOther = async (user: FixtureUser) => {
      let browser = browsers.get(user);
      if (browser === undefined) {
        browser = new Browser(other.app);
        expect((await browser.login(fx.users[user].email)).statusCode).toBe(204);
        browsers.set(user, browser);
      }
      return browser.request({
        method: 'POST',
        url: `/api/v1/tables/${fx.orders.id}/ai/ask`,
        payload: { question: QUESTION, timezone: HCM },
      });
    };
    const inFlight = async (count: number) => {
      await vi.waitFor(
        () => {
          expect(chats()).toHaveLength(count);
        },
        { timeout: 10_000, interval: 20 },
      );
    };

    beforeAll(async () => {
      await settings({ daily_token_limit: null });
    });

    afterAll(async () => {
      await settings({ daily_token_limit: LIMIT });
    });

    it("a person's third request at once is 429, whichever instance it reaches", async () => {
      fake.capabilities.delayMs = 1_500;
      const two = [ask('u_sales2'), askOther('u_sales2')];
      await inFlight(2);
      const third = await askOther('u_sales2');
      expectProblem(third, 429, 'RATE_LIMITED');
      expect(third.headers['retry-after']).toBe('5');
      const again = await ask('u_sales2');
      expectProblem(again, 429, 'RATE_LIMITED');
      // Someone else still goes through meanwhile.
      fake.capabilities.delayMs = 0;
      expect((await ask('u_reader')).statusCode).toBe(200);
      expect((await Promise.all(two)).map((response) => response.statusCode)).toEqual([200, 200]);
      // Released: two at once again.
      const later = await Promise.all([ask('u_sales2'), askOther('u_sales2')]);
      expect(later.map((response) => response.statusCode)).toEqual([200, 200]);
      expect(chats()).toHaveLength(5);
    });

    it("an organization's ninth request at once is 429 across both instances", async () => {
      fake.capabilities.delayMs = 1_500;
      const users = ['owner', 'u_admin', 'u_editor', 'u_reader'] as const;
      // Four on each instance: under the 8 of either process, the 8 of the organization.
      const eight = users.flatMap((user) => [ask(user), askOther(user)]);
      await inFlight(8);
      const ninth = await ask('u_sales1');
      expectProblem(ninth, 429, 'RATE_LIMITED');
      expectProblem(await askOther('u_sales1'), 429, 'RATE_LIMITED');
      const statuses = (await Promise.all(eight)).map((response) => response.statusCode);
      expect(statuses).toEqual(Array.from({ length: 8 }, () => 200));
      fake.capabilities.delayMs = 0;
      expect((await ask('u_sales1')).statusCode).toBe(200);
      expect(chats()).toHaveLength(9);
    });

    it('a client that closes its request aborts the provider call within 1 s and frees its slots (L21)', async () => {
      const token = await fx.call('u_sales2', 'POST', `/orgs/${fx.orgId}/me/api-tokens`, {
        name: 'ask',
        scopes: ['records:read'],
        expires_at: new Date(Date.now() + 30 * DAY_MS).toISOString(),
      });
      expect(token.statusCode, token.body).toBe(201);
      const bearer = `Bearer ${createdApiTokenSchema.parse(token.json()).token}`;
      const port = new URL((await listen(t.app)).replace('ws:', 'http:')).port;
      fake.capabilities.delayMs = 20_000;
      const socket = httpRequest({
        host: '127.0.0.1',
        port: Number(port),
        method: 'POST',
        path: `/api/v1/tables/${fx.orders.id}/ai/ask`,
        headers: { authorization: bearer, 'content-type': 'application/json' },
      });
      socket.on('error', () => undefined);
      socket.end(JSON.stringify({ question: QUESTION, timezone: HCM }));
      await inFlight(1);
      const open = fake.openConnections();
      expect(open).toBeGreaterThanOrEqual(1);
      const started = performance.now();
      socket.destroy();
      await vi.waitFor(
        () => {
          expect(fake.openConnections()).toBeLessThan(open);
        },
        { timeout: 1_000, interval: 10 },
      );
      expect(performance.now() - started).toBeLessThan(1_000);
      const cache = t.app.get<Redis>(CACHE_CLIENT);
      await vi.waitFor(
        async () => {
          expect(await cache.zcard(`ob:ai:inflight:user:${fx.users.u_sales2.id}`)).toBe(0);
          expect(await cache.zcard(`ob:ai:inflight:org:${fx.orgId}`)).toBe(0);
        },
        { timeout: 1_000, interval: 10 },
      );
      await vi.waitFor(async () => {
        expect(await lastAudit()).toMatchObject({ feature: 'ask', status: 'aborted' });
      });
    });
  });
});
