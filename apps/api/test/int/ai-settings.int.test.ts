import {
  aiSettingsSchema,
  aiSettingsTestResultSchema,
  aiUsageSchema,
  createdApiTokenSchema,
  organizationDetailSchema,
  type AiSettingsDto,
} from '@cellhive/contracts';
import { type Db } from '@cellhive/server-core';
import { startFakeOpenAiServer, type FakeOpenAiServer } from '@cellhive/server-core/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ApiRateLimits } from '../../src/common/rate-limit/api-rate-limits.js';
import { AiAccess } from '../../src/modules/ai/ai-access.js';
import { MetricsService } from '../../src/modules/metrics/metrics.service.js';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import {
  buildRecordFixture,
  expectProblem,
  type FixtureUser,
  type RecordFixture,
} from './record-fixture.js';
import { problemOf, startTestApp, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

/** An obviously fake key (push protection); grepped for in every output at the end. */
const KEY = 'sk-test-not-a-real-key-t906';
const DAY_MS = 86_400_000;

/**
 * BACKLOG T906 (CONTRACTS §24, §29.1, ADR-39): AI settings, the `ai_api_key`
 * secret bound to the provider host, "Test connection" against the fake
 * provider (three capability sets), the daily quota in the organization's
 * time zone (injected clock), the usage ledger, rate limits, audit, the
 * `ai` availability of `GET /orgs/:id`, P83/P84 and the scope rows of P89 —
 * and the key string never appearing in a response, an audit row or a log.
 */
describe('AI settings API (T906)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let fake: FakeOpenAiServer;
  let other: FakeOpenAiServer;
  /** Every response of the test, for the final key grep. */
  const seen: LightMyRequestResponse[] = [];

  const call = async (
    user: FixtureUser,
    method: 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
    headers?: Record<string, string>,
  ) => {
    const response = await fx.call(user, method, url, payload, headers);
    seen.push(response);
    return response;
  };
  const settingsUrl = () => `/orgs/${fx.orgId}/ai-settings`;
  const put = async (body: unknown, user: FixtureUser = 'owner'): Promise<AiSettingsDto> => {
    const response = await call(user, 'PUT', settingsUrl(), body);
    expect(response.statusCode, response.body).toBe(200);
    return aiSettingsSchema.parse(response.json());
  };
  const testConnection = async (body: unknown = {}) => {
    const response = await call('owner', 'POST', `${settingsUrl()}/test`, body);
    expect(response.statusCode, response.body).toBe(200);
    return aiSettingsTestResultSchema.parse(response.json());
  };
  const chats = (server: FakeOpenAiServer) => server.chatRequests().length;
  const access = () => t.app.get(AiAccess);
  const auditRows = async (action: string) =>
    (
      await sql<{ after: Record<string, unknown>; before: unknown; entity_type: string }>`
        SELECT after, before, entity_type FROM meta.audit_logs
         WHERE organization_id = ${fx.orgId} AND action = ${action}
         ORDER BY created_at, id
      `.execute(db.kysely)
    ).rows;

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
    other = await startFakeOpenAiServer();
    // u_sales2: organization admin; u_editor: workspace admin (not an organization admin).
    await sql`UPDATE meta.org_members SET role = 'admin'
               WHERE organization_id = ${fx.orgId} AND user_id = ${fx.users.u_sales2.id}`.execute(
      db.kysely,
    );
    await sql`INSERT INTO meta.workspace_members
                (organization_id, workspace_id, principal_type, principal_id, role)
              SELECT organization_id, workspace_id, 'user', ${fx.users.u_editor.id}, 'admin'
                FROM meta.bases WHERE id = ${fx.baseId}`.execute(db.kysely);
    for (const server of [fake, other]) {
      const entry = await call('owner', 'POST', `/orgs/${fx.orgId}/http-allowlist`, {
        pattern: `localhost:${String(server.port)}`,
      });
      expect(entry.statusCode, entry.body).toBe(201);
    }
    await sql`UPDATE meta.organizations
                 SET settings = settings || '{"timezone": "Asia/Ho_Chi_Minh"}'::jsonb
               WHERE id = ${fx.orgId}`.execute(db.kysely);
  });

  afterAll(async () => {
    await fake.close();
    await other.close();
    await t.close();
    await db.destroy();
    await database.drop();
  });

  beforeEach(() => {
    access().now = () => new Date();
    for (const server of [fake, other]) {
      server.requests.length = 0;
      Object.assign(server.capabilities, {
        jsonSchema: true,
        jsonObject: true,
        usage: true,
        failWith: null,
        delayMs: 0,
        apiKey: null,
      });
    }
  });

  it('P84: no AI until configured — test is 422 AI_NOT_CONFIGURED, members see ai.available false', async () => {
    const defaults = aiSettingsSchema.parse((await call('owner', 'GET', settingsUrl())).json());
    expect(defaults).toEqual({
      enabled: false,
      provider_base_url: null,
      model: null,
      api_key: null,
      allow_record_data: false,
      log_prompts: false,
      daily_token_limit: 1_000_000,
      structured_output: 'auto',
      detected_output: null,
      token_param: 'max_tokens',
      request_timeout_seconds: 60,
      available: false,
      updated_at: null,
    });
    expectProblem(await call('owner', 'POST', `${settingsUrl()}/test`), 422, 'AI_NOT_CONFIGURED');
    expect(chats(fake)).toBe(0);
    for (const user of ['owner', 'u_reader', 'u_out'] as const) {
      const org = organizationDetailSchema.parse(
        (await call(user, 'GET', `/orgs/${fx.orgId}`)).json(),
      );
      expect(org.ai).toEqual({ available: false, record_data: false });
    }
  });

  it('stores the key as an ai_api_key secret bound to the provider host, never returning it', async () => {
    const saved = await put({
      enabled: true,
      provider_base_url: fake.baseUrl,
      model: 'fake-model',
      api_key: { value: KEY },
    });
    expect(saved).toMatchObject({
      enabled: true,
      provider_base_url: fake.baseUrl,
      model: 'fake-model',
      api_key: { name: 'AI provider key', allowed_hosts: [`localhost:${String(fake.port)}`] },
      available: true,
      token_param: 'max_tokens',
    });
    const secretId = saved.api_key?.secret_id;
    const secret = (
      await sql<{ kind: string; base_scope: string; ciphertext: string }>`
        SELECT kind, base_scope, ciphertext FROM meta.secrets WHERE id = ${secretId}`.execute(
        db.kysely,
      )
    ).rows[0];
    expect(secret).toMatchObject({ kind: 'ai_api_key', base_scope: 'all' });
    expect(secret?.ciphertext).not.toContain(KEY);

    // Members only learn that AI is on.
    const org = organizationDetailSchema.parse(
      (await call('u_reader', 'GET', `/orgs/${fx.orgId}`)).json(),
    );
    expect(org.ai).toEqual({ available: true, record_data: false });
    expect(JSON.stringify(org)).not.toContain(fake.baseUrl);

    // Replacing the value keeps the one secret; the audit names the change, never the key.
    const replaced = await put({ api_key: { value: `${KEY}-2` } });
    expect(replaced.api_key?.secret_id).toBe(secretId);
    const audits = await auditRows('ai_settings.updated');
    expect(audits.at(0)?.before).toBeNull();
    expect(audits.at(0)?.after).toMatchObject({
      enabled: true,
      provider_base_url: fake.baseUrl,
      api_key_secret_id: secretId,
      key_replaced: true,
    });
    expect(audits.at(-1)?.after).toMatchObject({ changed: [], key_replaced: true });
    expect((await auditRows('secret.updated')).at(-1)?.after).toMatchObject({
      kind: 'ai_api_key',
      value_replaced: true,
      allowed_hosts: [`localhost:${String(fake.port)}`],
    });
    await put({ api_key: { value: KEY } });

    // The secret API knows the kind: never offered to automations, cannot be deleted while used.
    const baseSecrets = await call('owner', 'GET', `/bases/${fx.baseId}/secrets`);
    expect(baseSecrets.json<{ items: unknown[] }>().items).toEqual([]);
    const removed = await call('owner', 'DELETE', `/secrets/${String(secretId)}`);
    expectProblem(removed, 409, 'SECRET_IN_USE');
    expect(problemOf(removed.body)['errors']).toEqual([
      expect.objectContaining({ params: { usages: [{ kind: 'ai_settings' }], total: 1 } }),
    ]);
    const usages = await call('owner', 'GET', `/secrets/${String(secretId)}/usages`);
    expect(usages.json()).toEqual({ items: [{ kind: 'ai_settings' }], total: 1 });
  });

  it('creates ai_api_key secrets through the secret API with hosts and every base only', async () => {
    const missingHosts = await call('owner', 'POST', `/orgs/${fx.orgId}/secrets`, {
      kind: 'ai_api_key',
      name: 'Spare AI key',
      value: KEY,
    });
    expectProblem(missingHosts, 422, 'VALIDATION_FAILED');
    expect(problemOf(missingHosts.body)['errors']).toEqual([
      expect.objectContaining({ code: 'SECRET_HOSTS_REQUIRED' }),
    ]);
    const selected = await call('owner', 'POST', `/orgs/${fx.orgId}/secrets`, {
      kind: 'ai_api_key',
      name: 'Spare AI key',
      value: KEY,
      allowed_hosts: ['api.openai.com'],
      base_scope: 'selected',
      base_ids: [fx.baseId],
    });
    expectProblem(selected, 422, 'VALIDATION_FAILED');
    const created = await call('owner', 'POST', `/orgs/${fx.orgId}/secrets`, {
      kind: 'ai_api_key',
      name: 'Spare AI key',
      value: KEY,
      allowed_hosts: ['api.openai.com'],
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({ kind: 'ai_api_key', allowed_hosts: ['api.openai.com'] });
    // `secret_id` must name an ai_api_key of the organization.
    const notAKey = await call('owner', 'PUT', settingsUrl(), {
      api_key: { secret_id: 'sec_NotAnAiKey000001' },
    });
    expectProblem(notAKey, 422, 'VALIDATION_FAILED');
    expect(problemOf(notAKey.body)['errors']).toEqual([
      expect.objectContaining({ path: 'api_key.secret_id', code: 'UNKNOWN_SECRET' }),
    ]);
  });

  it('refuses a bad URL, a key for an IP address and record data without confirm', async () => {
    for (const [body, path, code] of [
      [{ provider_base_url: 'ftp://llm.example/v1' }, 'provider_base_url', 'INVALID_URL'],
      [{ provider_base_url: 'https://user:pw@llm.example/v1' }, 'provider_base_url', 'INVALID_URL'],
      [{ provider_base_url: 'https://llm.example/v1?key=1' }, 'provider_base_url', 'INVALID_URL'],
      [
        { provider_base_url: 'http://10.0.0.5:11434/v1', api_key: { value: KEY } },
        'api_key',
        'SECRET_HOST_NOT_ALLOWED',
      ],
      [{ api_key: { value: `${KEY}\nX-Injected: 1` } }, 'api_key.value', 'INVALID_SECRET_VALUE'],
      [{ allow_record_data: true }, 'confirm', 'RECORD_DATA_NOT_CONFIRMED'],
    ] as const) {
      const response = await call('owner', 'PUT', settingsUrl(), body);
      expectProblem(response, 422, 'VALIDATION_FAILED');
      expect(problemOf(response.body)['errors']).toEqual([expect.objectContaining({ path, code })]);
    }
    const on = await put({ allow_record_data: true, confirm: true });
    expect(on.allow_record_data).toBe(true);
    expect((await auditRows('ai_settings.updated')).at(-1)?.after).toMatchObject({
      allow_record_data: true,
      changed: ['allow_record_data'],
    });
    const org = organizationDetailSchema.parse(
      (await call('u_reader', 'GET', `/orgs/${fx.orgId}`)).json(),
    );
    expect(org.ai).toEqual({ available: true, record_data: true });
    await put({ allow_record_data: false });
  });

  it('detects the structured-output rung of three providers and saves it for auto', async () => {
    fake.capabilities.apiKey = KEY;
    const best = await testConnection();
    expect(best).toMatchObject({
      ok: true,
      structured_output: 'json_schema',
      token_param: 'max_tokens',
      error: null,
    });
    expect(best.models).not.toBeNull();
    expect(fake.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      'GET /v1/models',
      'POST /v1/chat/completions',
    ]);
    // The key went to its host only, in the header; the body names no temperature & co.
    expect(
      fake.requests.every((request) => request.headers['authorization'] === `Bearer ${KEY}`),
    ).toBe(true);
    const body = fake.chatRequests()[0]?.body ?? {};
    expect(body).toMatchObject({ model: 'fake-model', stream: false, max_tokens: 50 });
    expect(body).not.toHaveProperty('temperature');
    expect(
      aiSettingsSchema.parse((await call('owner', 'GET', settingsUrl())).json()).detected_output,
    ).toBe('json_schema');

    fake.capabilities.jsonSchema = false;
    expect(await testConnection()).toMatchObject({ ok: true, structured_output: 'json_object' });
    fake.capabilities.jsonObject = false;
    expect(await testConnection()).toMatchObject({ ok: true, structured_output: 'prompt' });
    expect(
      aiSettingsSchema.parse((await call('owner', 'GET', settingsUrl())).json()).detected_output,
    ).toBe('prompt');

    // A provider ignoring response_format answers off-schema: one rung down.
    Object.assign(fake.capabilities, { jsonSchema: true, jsonObject: true });
    fake.script({ content: 'The sky is blue.' });
    expect(await testConnection()).toMatchObject({ ok: true, structured_output: 'json_object' });

    const tests = await auditRows('ai.requested');
    expect(tests.at(-1)).toMatchObject({
      entity_type: 'ai_settings',
      after: {
        feature: 'test',
        model: 'fake-model',
        status: 'ok',
        attempts: 2,
        output_mode: 'json_object',
      },
    });
  });

  it('never sends the key to another host: a new provider URL needs the key again', async () => {
    other.capabilities.apiKey = KEY;
    const result = await testConnection({ settings: { provider_base_url: other.baseUrl } });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'AI_PROVIDER_ERROR', reason: 'secret_host_not_allowed' },
    });
    expect(other.requests).toEqual([]);
    // Saving the URL without the key does not move the key either.
    await put({ provider_base_url: other.baseUrl });
    expect(await testConnection()).toMatchObject({
      ok: false,
      error: { reason: 'secret_host_not_allowed' },
    });
    expect(other.requests).toEqual([]);
    // A key typed for the new URL, not saved, is tried there only.
    expect(await testConnection({ settings: { api_key: { value: KEY } } })).toMatchObject({
      ok: true,
    });
    expect(other.requests.at(-1)?.headers['authorization']).toBe(`Bearer ${KEY}`);
    await put({ provider_base_url: fake.baseUrl });
  });

  it('reports provider failures as results, counting the tokens of failed calls', async () => {
    fake.capabilities.apiKey = 'sk-test-not-a-real-key-other';
    expect(await testConnection()).toMatchObject({
      ok: false,
      structured_output: null,
      error: { code: 'AI_PROVIDER_ERROR', reason: 'http_status', status: 401 },
    });
    fake.capabilities.apiKey = null;
    const before = aiUsageSchema.parse(
      (await call('owner', 'GET', `/orgs/${fx.orgId}/ai-usage`)).json(),
    );
    fake.script({ finishReason: 'length' });
    expect(await testConnection()).toMatchObject({ ok: false, error: { reason: 'truncated' } });
    const after = aiUsageSchema.parse(
      (await call('owner', 'GET', `/orgs/${fx.orgId}/ai-usage`)).json(),
    );
    const requestsOf = (usage: typeof after) =>
      usage.items
        .filter((item) => item.feature === 'test')
        .reduce((sum, item) => sum + item.requests, 0);
    expect(requestsOf(after)).toBe(requestsOf(before) + 1);
    expect(after.quota.used_today).toBeGreaterThan(before.quota.used_today);
    expect((await auditRows('ai.requested')).at(-1)?.after).toMatchObject({
      status: 'AI_PROVIDER_ERROR',
    });
  });

  it('blocks a call once the daily quota is used, with the day of the organization zone', async () => {
    await put({ daily_token_limit: 10_000 });
    // 23:30 in Ho Chi Minh City: the day is 2027-03-14 there.
    access().now = () => new Date('2027-03-14T16:30:00Z');
    await sql`INSERT INTO meta.ai_usage_daily (organization_id, day, feature, requests, prompt_tokens, completion_tokens)
              VALUES (${fx.orgId}, '2027-03-14', 'ask', 3, 6000, 4000)`.execute(db.kysely);
    const refused = await call('owner', 'POST', `${settingsUrl()}/test`);
    expectProblem(refused, 429, 'AI_QUOTA_EXCEEDED');
    expect(refused.headers['retry-after']).toBe('1800');
    expect(problemOf(refused.body)['errors']).toEqual([
      expect.objectContaining({
        code: 'AI_QUOTA_EXCEEDED',
        params: { reset_at: '2027-03-14T17:00:00.000Z', daily_token_limit: 10_000 },
      }),
    ]);
    expect(fake.requests).toEqual([]);

    const usage = aiUsageSchema.parse(
      (
        await call('owner', 'GET', `/orgs/${fx.orgId}/ai-usage?from=2027-03-13&to=2027-03-14`)
      ).json(),
    );
    expect(usage).toMatchObject({
      from: '2027-03-13',
      to: '2027-03-14',
      time_zone: 'Asia/Ho_Chi_Minh',
      items: [
        {
          day: '2027-03-14',
          feature: 'ask',
          requests: 3,
          prompt_tokens: 6000,
          completion_tokens: 4000,
        },
      ],
      quota: {
        daily_token_limit: 10_000,
        used_today: 10_000,
        reset_at: '2027-03-14T17:00:00.000Z',
      },
    });

    // Midnight in Ho Chi Minh City (still 14 March in UTC): a new day, calls go through.
    access().now = () => new Date('2027-03-14T17:00:01Z');
    expect(await testConnection()).toMatchObject({ ok: true });
    await put({ daily_token_limit: null });
  });

  it('limits the usage range to 90 days', async () => {
    const response = await call(
      'owner',
      'GET',
      `/orgs/${fx.orgId}/ai-usage?from=2026-01-01&to=2026-10-31`,
    );
    expectProblem(response, 422, 'VALIDATION_FAILED');
    expect(problemOf(response.body)['errors']).toEqual([
      expect.objectContaining({ path: 'from', code: 'OUT_OF_RANGE' }),
    ]);
    const reversed = await call(
      'owner',
      'GET',
      `/orgs/${fx.orgId}/ai-usage?from=2026-10-31&to=2026-10-01`,
    );
    expectProblem(reversed, 422, 'VALIDATION_FAILED');
    const days = aiUsageSchema.parse(
      (await call('owner', 'GET', `/orgs/${fx.orgId}/ai-usage`)).json(),
    );
    expect(Date.parse(days.to) - Date.parse(days.from)).toBe(29 * DAY_MS);
  });

  it('rate limits AI requests per person: 10 a minute, 2 at once', async () => {
    const limits = t.app.get(ApiRateLimits);
    // Another window length is another counter: earlier tests do not count.
    limits.ai = { limit: 2, windowSeconds: 59 };
    try {
      await testConnection();
      await testConnection();
      const third = await call('owner', 'POST', `${settingsUrl()}/test`);
      expectProblem(third, 429, 'RATE_LIMITED');
      expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
      // Another admin has their own allowance.
      expect((await call('u_sales2', 'POST', `${settingsUrl()}/test`)).statusCode).toBe(200);
    } finally {
      limits.ai = { limit: 10_000, windowSeconds: 61 };
    }
    fake.capabilities.delayMs = 300;
    const statuses = await Promise.all(
      [1, 2, 3].map(
        async () => (await call('u_sales2', 'POST', `${settingsUrl()}/test`)).statusCode,
      ),
    );
    expect(statuses.sort()).toEqual([200, 200, 429]);
  });

  it('P83: organization owners/admins only; other members 403, other organizations 404', async () => {
    const routes = [
      ['GET', settingsUrl()],
      ['PUT', settingsUrl()],
      ['POST', `${settingsUrl()}/test`],
      ['GET', `/orgs/${fx.orgId}/ai-usage`],
    ] as const;
    for (const [method, url] of routes) {
      for (const user of ['u_editor', 'u_admin', 'u_reader'] as const) {
        expectProblem(
          await call(user, method, url, method === 'PUT' ? { enabled: false } : undefined),
          403,
          'PERMISSION_DENIED',
        );
      }
      expectProblem(
        await call('stranger', method, url, method === 'PUT' ? { enabled: false } : undefined),
        404,
        'NOT_FOUND',
      );
    }
    expect((await call('u_sales2', 'GET', settingsUrl())).statusCode).toBe(200);
    expect(fake.requests).toEqual([]);
  });

  it('P89: settings and usage are session only', async () => {
    const created = await call('owner', 'POST', `/orgs/${fx.orgId}/me/api-tokens`, {
      name: 'every scope',
      scopes: [
        'records:read',
        'records:write',
        'schema:read',
        'schema:write',
        'automations:read',
        'automations:write',
      ],
      expires_at: new Date(Date.now() + 30 * DAY_MS).toISOString(),
    });
    expect(created.statusCode, created.body).toBe(201);
    const token = createdApiTokenSchema.parse(created.json()).token;
    const bearer = { authorization: `Bearer ${token}` };
    for (const [method, url] of [
      ['GET', settingsUrl()],
      ['PUT', settingsUrl()],
      ['POST', `${settingsUrl()}/test`],
      ['GET', `/orgs/${fx.orgId}/ai-usage`],
    ] as const) {
      const response = await call('owner', method, url, method === 'GET' ? undefined : {}, bearer);
      expectProblem(response, 403, 'INSUFFICIENT_SCOPE');
      expect(problemOf(response.body)['errors']).toEqual([
        expect.objectContaining({ params: { required: ['session'] } }),
      ]);
    }
    // `GET /orgs/:id` keeps `schema:read` and carries `ai`.
    const org = await call('owner', 'GET', `/orgs/${fx.orgId}`, undefined, bearer);
    expect(organizationDetailSchema.parse(org.json()).ai.available).toBe(true);
  });

  it('turning AI off hides it from members; the test still works for admins', async () => {
    await put({ enabled: false });
    const org = organizationDetailSchema.parse(
      (await call('u_reader', 'GET', `/orgs/${fx.orgId}`)).json(),
    );
    expect(org.ai).toEqual({ available: false, record_data: false });
    expect(await testConnection()).toMatchObject({ ok: true });
    await put({ enabled: true });
  });

  it('exposes the AI metrics without organization labels', async () => {
    const { body } = await t.app.get(MetricsService).render();
    expect(body).toMatch(/ai_requests_total\{feature="test",status="ok"\} \d+/u);
    expect(body).toMatch(/ai_tokens_total\{feature="test",kind="prompt"\} \d+/u);
    expect(body).toMatch(/ai_quota_exhausted_total [1-9]/u);
    expect(body).toMatch(/ai_request_seconds_count\{feature="test"\} \d+/u);
    expect(body).not.toContain(fx.orgId);
  });

  it('never shows the key: responses, errors, audit rows, events, logs', async () => {
    const responses = seen
      .map((response) => `${JSON.stringify(response.headers)}\n${response.body}`)
      .join('\n');
    expect(seen.length).toBeGreaterThan(40);
    expect(responses).not.toContain(KEY);
    const audit =
      await sql`SELECT * FROM meta.audit_logs WHERE organization_id = ${fx.orgId}`.execute(
        db.kysely,
      );
    expect(JSON.stringify(audit.rows)).not.toContain(KEY);
    const events = await sql`SELECT * FROM meta.events WHERE organization_id = ${fx.orgId}`.execute(
      db.kysely,
    );
    expect(JSON.stringify(events.rows)).not.toContain(KEY);
    const stored = await sql`SELECT * FROM meta.ai_settings`.execute(db.kysely);
    expect(JSON.stringify(stored.rows)).not.toContain(KEY);
    expect(t.logs.raw()).toContain('ai request');
    expect(t.logs.raw()).not.toContain(KEY);
    // Logs name the provider host, never its URL.
    expect(t.logs.raw()).not.toContain(fake.baseUrl);
  });
});
