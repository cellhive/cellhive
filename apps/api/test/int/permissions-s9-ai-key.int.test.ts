import {
  aiSettingsSchema,
  aiSettingsTestResultSchema,
  fieldSchema,
  secretSchema,
  type AiSettingsDto,
  type AiSettingsTestResult,
  type FieldDto,
  type Id,
} from '@cellhive/contracts';
import {
  AiFieldGenerator,
  createAiKeySource,
  httpAllowlistSource,
  LlmClient,
  NEVER_ALLOWED_RANGES,
  orgScope,
  recomputeJobBatchId,
  RecordMutationService,
  RecordQueryService,
  ssrfBlockedCounts,
  type Db,
  type HostLookup,
} from '@cellhive/server-core';
import { startFakeOpenAiServer, type FakeOpenAiServer } from '@cellhive/server-core/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ApiRateLimits } from '../../src/common/rate-limit/api-rate-limits.js';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import {
  buildRecordFixture,
  expectProblem,
  type FixtureUser,
  type RecordFixture,
} from './record-fixture.js';
import { problemOf, startTestApp, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

/** Obviously fake keys (push protection); grepped for in every output at the end. */
const KEY = 'sk-test-not-a-real-key-t1008-saved';
const NEW_KEY = 'sk-test-not-a-real-key-t1008-rebound';
const TRIED_KEY = 'sk-test-not-a-real-key-t1008-tried';
const HEADER_VALUE = 'Bearer not-a-real-token-t1008';
const KEYS = [KEY, NEW_KEY, TRIED_KEY, HEADER_VALUE];

/** A host name whose (made-up) answer is a public address: no call ever connects to it. */
const PUBLIC_HOST = 'llm.public.test';

type Answer = readonly string[] | (() => readonly string[]);

/**
 * BACKLOG T1008 (Quyết định S9 #15; CONTRACTS §5 P118, §24, §29.1): "a key
 * never reaches a host it is not bound to", on every path a key could
 * leave by, through HTTP with the fake provider and a trap provider (both
 * on loopback, both allowlisted, so only the key's own rules stand between
 * the key and the trap):
 *
 * - **URL** — a new provider URL (`PUT`, also with `secret_id`) does not
 *   take the key along: "Test connection" and the AI field worker refuse
 *   with `secret_host_not_allowed`;
 * - **PATCH allowed_hosts** of the key (and of an `http_header` secret)
 *   without a new `value` → `422 SECRET_VALUE_REQUIRED`, nothing changed;
 *   with one, only the new value goes to the new host;
 * - **http** — a key over plain `http` to a host that is not an allowlist
 *   entry resolving to internal addresses → `422 INSECURE_KEY_NOT_CONFIRMED`
 *   unless `confirm_insecure: true`;
 * - **test with `settings`** — a saved key never follows the URL tried; a
 *   typed key goes to the URL tried only;
 * - **redirect** — a `302`/`307` of the provider is never followed;
 * - **DNS rebinding** — one lookup per call, the connection pinned to it; a
 *   later answer at a metadata address is refused before anything is sent;
 * - **IPv6 with an embedded IPv4** — mapped, translated, NAT64 and 6to4
 *   forms of metadata addresses are refused, allowlist entry or not;
 * - **metadata** — every never-reachable address stays closed even when an
 *   allowlist entry names the host (`168.63.129.16` among them).
 *
 * "Key not sent" is counted at the trap: 0 requests with an
 * `Authorization` header.
 */
describe('permission matrix S9 — the AI key stays with its host (T1008, P118)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let fake: FakeOpenAiServer;
  let trap: FakeOpenAiServer;
  let keyId: Id<'sec'>;
  const answers = new Map<string, Answer>();
  const lookups: string[] = [];
  const seen: LightMyRequestResponse[] = [];

  /** The resolver of the API (and of the worker of this file): `answers`, `localhost` → loopback. */
  const lookup: HostLookup = (host) => {
    lookups.push(host);
    const answer = answers.get(host) ?? (host === 'localhost' ? ['127.0.0.1'] : undefined);
    if (answer === undefined) {
      return Promise.reject(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
    }
    return Promise.resolve(typeof answer === 'function' ? answer() : answer);
  };

  const call = async (
    user: FixtureUser,
    method: 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: unknown,
  ) => {
    const response = await fx.call(user, method, url, payload);
    seen.push(response);
    return response;
  };
  const settingsUrl = () => `/orgs/${fx.orgId}/ai-settings`;
  const put = async (body: unknown): Promise<AiSettingsDto> => {
    const response = await call('owner', 'PUT', settingsUrl(), body);
    expect(response.statusCode, response.body).toBe(200);
    return aiSettingsSchema.parse(response.json());
  };
  const getSettings = async () =>
    aiSettingsSchema.parse((await call('owner', 'GET', settingsUrl())).json());
  const tryTest = (body: unknown = {}) => call('owner', 'POST', `${settingsUrl()}/test`, body);
  const testConnection = async (body: unknown = {}): Promise<AiSettingsTestResult> => {
    const response = await tryTest(body);
    expect(response.statusCode, response.body).toBe(200);
    return aiSettingsTestResultSchema.parse(response.json());
  };
  const allow = async (pattern: string) => {
    const entry = await call('owner', 'POST', `/orgs/${fx.orgId}/http-allowlist`, { pattern });
    expect(entry.statusCode, entry.body).toBe(201);
  };
  const errorsOf = (response: LightMyRequestResponse) => problemOf(response.body)['errors'];
  /** Requests that carried a key (any `Authorization` header). */
  const withKey = (server: FakeOpenAiServer) =>
    server.requests.filter((request) => request.headers['authorization'] !== undefined);
  const secretRow = async (id: Id<'sec'>) =>
    (
      await sql<{ allowed_hosts: string[]; ciphertext: string; updated_at: Date }>`
        SELECT allowed_hosts, ciphertext, updated_at FROM meta.secrets WHERE id = ${id}`.execute(
        db.kysely,
      )
    ).rows[0];
  const audits = async (action: string) =>
    (
      await sql<{ entity_id: string; after: Record<string, unknown> }>`
        SELECT entity_id, after FROM meta.audit_logs
         WHERE organization_id = ${fx.orgId} AND action = ${action}
         ORDER BY created_at, id`.execute(db.kysely)
    ).rows;
  const blockedAddresses = () => ssrfBlockedCounts().get('blocked_address') ?? 0;
  const fakeHost = () => `localhost:${String(fake.port)}`;
  const trapHost = () => `localhost:${String(trap.port)}`;
  /** Back to the saved provider and key of `beforeAll`. */
  const restore = async () => {
    await put({ provider_base_url: fake.baseUrl, api_key: { value: KEY } });
  };

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url }, { outboundLookup: lookup });
    fx = await buildRecordFixture(t, db);
    t.app.get(ApiRateLimits).ai = { limit: 10_000, windowSeconds: 60 };
    fake = await startFakeOpenAiServer({ capabilities: { apiKey: KEY } });
    // Answers anyone: a key that reached it would be accepted and recorded.
    trap = await startFakeOpenAiServer();
    await allow(fakeHost());
    await allow(trapHost());
    const saved = await put({
      enabled: true,
      provider_base_url: fake.baseUrl,
      model: 'fake-model',
      api_key: { value: KEY },
      allow_record_data: true,
      confirm: true,
    });
    expect(saved.api_key?.allowed_hosts).toEqual([fakeHost()]);
    keyId = saved.api_key?.secret_id as Id<'sec'>;
  });

  afterAll(async () => {
    await fake.close();
    await trap.close();
    await t.close();
    await db.destroy();
    await database.drop();
  });

  beforeEach(() => {
    for (const server of [fake, trap]) {
      server.requests.length = 0;
      Object.assign(server.capabilities, { failWith: null, delayMs: 0, models: null });
    }
    fake.capabilities.apiKey = KEY;
  });

  it('the saved key works with its own provider (the control of every case below)', async () => {
    expect(await testConnection()).toMatchObject({ ok: true, models: ['fake-model'] });
    expect(withKey(fake).map((request) => request.headers['authorization'])).toEqual([
      `Bearer ${KEY}`,
      `Bearer ${KEY}`,
    ]);
    expect(trap.requests).toEqual([]);
  });

  it('P118 URL: a new provider URL does not take the key along — PUT, secret_id, test, AI field worker', async () => {
    // The trap is allowlisted and internal: nothing but the key's own host stops it.
    await put({ provider_base_url: trap.baseUrl });
    expect(await testConnection()).toMatchObject({
      ok: false,
      error: { code: 'AI_PROVIDER_ERROR', reason: 'secret_host_not_allowed' },
    });
    // Naming the key by its id is the same key, still bound to the first host.
    await put({ provider_base_url: trap.baseUrl, api_key: { secret_id: keyId } });
    expect(await testConnection()).toMatchObject({
      ok: false,
      error: { reason: 'secret_host_not_allowed' },
    });
    expect((await secretRow(keyId))?.allowed_hosts).toEqual([fakeHost()]);

    // The worker of AI fields: the same client, the same refusal, before any connection.
    const created = await call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
      name: 'ai_key_note',
      type: 'text',
      options: { ai: { task: 'summarize', prompt: 'Tóm tắt {{ [title] }}', auto_update: false } },
    });
    expect(created.statusCode, created.body).toBe(201);
    const note: FieldDto = fieldSchema.parse(created.json());
    const record = await call('u_admin', 'POST', `/tables/${fx.orders.id}/records`, {
      records: [{ fields: { title: 'Đơn P118' } }],
    });
    expect(record.statusCode, record.body).toBe(201);
    const recordId = record.json<{ records: { id: Id<'rec'> }[] }>().records[0]?.id as Id<'rec'>;
    const generate = await call('u_admin', 'POST', `/fields/${note.id}/ai/generate`, {
      scope: 'records',
      record_ids: [recordId],
    });
    expect(generate.statusCode, generate.body).toBe(202);
    const generator = new AiFieldGenerator(db, {
      llm: new LlmClient({
        allowlist: httpAllowlistSource(db),
        privateAllowlist: 'org',
        keys: createAiKeySource(db, t.config.security.appMasterKey),
        lookup,
      }),
      records: t.app.get(RecordQueryService),
      mutations: t.app.get(RecordMutationService),
      defaultTimeZone: 'UTC',
      defaultLocale: 'en',
    });
    expect(
      await generator.runBatch(orgScope(fx.orgId), note.id, recomputeJobBatchId(1)),
    ).toMatchObject({
      status: 'paused',
      pausedReason: 'provider_error',
      pausedDetail: 'secret_host_not_allowed',
    });
    expect(trap.requests).toEqual([]);
    expect(withKey(fake)).toEqual([]);

    await restore();
    await sql`DELETE FROM meta.ai_generation_queue WHERE organization_id = ${fx.orgId}`.execute(
      db.kysely,
    );
  });

  it('P118 PATCH allowed_hosts: a new host of the key needs a new value (422 SECRET_VALUE_REQUIRED); only the new value goes there', async () => {
    const before = await secretRow(keyId);
    const updates = (await audits('secret.updated')).length;
    for (const hosts of [[trapHost()], [fakeHost(), trapHost()], [`*.public.test`]]) {
      const refused = await call('owner', 'PATCH', `/secrets/${keyId}`, { allowed_hosts: hosts });
      expectProblem(refused, 422, 'VALIDATION_FAILED');
      expect(errorsOf(refused)).toEqual([
        expect.objectContaining({ path: 'value', code: 'SECRET_VALUE_REQUIRED' }),
      ]);
    }
    // A name, or the same list, needs no value; nothing moved.
    expect((await call('owner', 'PATCH', `/secrets/${keyId}`, { name: 'AI key' })).statusCode).toBe(
      200,
    );
    const same = await call('owner', 'PATCH', `/secrets/${keyId}`, {
      allowed_hosts: [fakeHost().toUpperCase()],
    });
    expect(same.statusCode, same.body).toBe(200);
    const after = await secretRow(keyId);
    expect(after?.allowed_hosts).toEqual([fakeHost()]);
    expect(after?.ciphertext).toBe(before?.ciphertext);
    expect(await audits('secret.updated')).toHaveLength(updates + 1);

    // With a new value: the new value goes to the new host, the old one never did.
    const rebound = await call('owner', 'PATCH', `/secrets/${keyId}`, {
      allowed_hosts: [trapHost()],
      value: NEW_KEY,
    });
    expect(rebound.statusCode, rebound.body).toBe(200);
    expect(secretSchema.parse(rebound.json()).allowed_hosts).toEqual([trapHost()]);
    expect((await audits('secret.updated')).at(-1)).toMatchObject({
      entity_id: keyId,
      after: { kind: 'ai_api_key', allowed_hosts: [trapHost()], value_replaced: true },
    });
    await put({ provider_base_url: trap.baseUrl });
    expect(await testConnection()).toMatchObject({ ok: true });
    expect(new Set(withKey(trap).map((request) => request.headers['authorization']))).toEqual(
      new Set([`Bearer ${NEW_KEY}`]),
    );
    expect(withKey(fake)).toEqual([]);
    trap.requests.length = 0;
    await restore();
    expect((await secretRow(keyId))?.allowed_hosts).toEqual([fakeHost()]);

    // An HTTP header value too; a signing secret only signs, its value never leaves.
    const header = await call('owner', 'POST', `/orgs/${fx.orgId}/secrets`, {
      kind: 'http_header',
      name: 'CRM P118',
      value: HEADER_VALUE,
      allowed_hosts: ['api.crm.test'],
    });
    expect(header.statusCode, header.body).toBe(201);
    const headerId = secretSchema.parse(header.json()).id;
    const moved = await call('owner', 'PATCH', `/secrets/${headerId}`, {
      allowed_hosts: ['api.evil.test'],
    });
    expectProblem(moved, 422, 'VALIDATION_FAILED');
    expect(errorsOf(moved)).toEqual([
      expect.objectContaining({ path: 'value', code: 'SECRET_VALUE_REQUIRED' }),
    ]);
    const narrowed = await call('owner', 'PATCH', `/secrets/${headerId}`, {
      allowed_hosts: ['api.crm.test'],
    });
    expect(narrowed.statusCode, narrowed.body).toBe(200);
    const signing = await call('owner', 'POST', `/orgs/${fx.orgId}/secrets`, {
      kind: 'webhook_signing',
      name: 'Signing P118',
      generate: true,
      allowed_hosts: ['hooks.crm.test'],
    });
    expect(signing.statusCode, signing.body).toBe(201);
    const signingId = secretSchema.parse(signing.json()).id;
    const signingMoved = await call('owner', 'PATCH', `/secrets/${signingId}`, {
      allowed_hosts: ['hooks.other.test'],
    });
    expect(signingMoved.statusCode, signingMoved.body).toBe(200);
    // A header value stored before lists existed was never bound to a host: its first list binds it,
    // even after its transition period; the next host added needs the value again.
    await sql`UPDATE meta.secrets SET allowed_hosts = '{}', legacy_hosts_until = now() - interval '1 day'
               WHERE id = ${headerId}`.execute(db.kysely);
    const first = await call('owner', 'PATCH', `/secrets/${headerId}`, {
      allowed_hosts: ['api.crm.test'],
    });
    expect(first.statusCode, first.body).toBe(200);
    expect(secretSchema.parse(first.json())).toMatchObject({
      allowed_hosts: ['api.crm.test'],
      legacy_hosts_until: null,
    });
    expect(
      errorsOf(
        await call('owner', 'PATCH', `/secrets/${headerId}`, {
          allowed_hosts: ['api.crm.test', 'api.evil.test'],
        }),
      ),
    ).toEqual([expect.objectContaining({ path: 'value', code: 'SECRET_VALUE_REQUIRED' })]);
    // 404 before anything for another organization, 403 for a member.
    expectProblem(
      await call('stranger', 'PATCH', `/secrets/${keyId}`, { allowed_hosts: [trapHost()] }),
      404,
      'NOT_FOUND',
    );
    expectProblem(
      await call('u_admin', 'PATCH', `/secrets/${keyId}`, { allowed_hosts: [trapHost()] }),
      403,
      'PERMISSION_DENIED',
    );
    expect(trap.requests).toEqual([]);
  });

  it('P118 http: a key over plain http to a host that is not allowlisted-internal is 422 unless confirm_insecure', async () => {
    answers.set(PUBLIC_HOST, ['93.184.216.34']);
    answers.set('internal.test', ['10.0.0.5']);
    answers.set('mixed.test', ['10.0.0.5', '93.184.216.34']);
    await allow('mixed.test');
    const secrets = (await audits('secret.updated')).length;
    for (const url of [
      `http://${PUBLIC_HOST}/v1`,
      `http://${PUBLIC_HOST}:8080/v1`,
      // Internal, but no allowlist entry opens it.
      'http://internal.test/v1',
      // Allowlisted, but one address is public.
      'http://mixed.test/v1',
    ]) {
      const refused = await call('owner', 'PUT', settingsUrl(), {
        provider_base_url: url,
        api_key: { value: KEY },
      });
      expectProblem(refused, 422, 'VALIDATION_FAILED');
      expect(errorsOf(refused)).toEqual([
        expect.objectContaining({
          path: 'confirm_insecure',
          code: 'INSECURE_KEY_NOT_CONFIRMED',
          params: { host: new URL(url).host },
        }),
      ]);
    }
    // Nothing saved, the key untouched.
    expect(await getSettings()).toMatchObject({
      provider_base_url: fake.baseUrl,
      api_key: { allowed_hosts: [fakeHost()] },
    });
    expect(await audits('secret.updated')).toHaveLength(secrets);

    // Without a key there is nothing to protect; with the saved key bound elsewhere, it never goes.
    await put({ provider_base_url: `http://${PUBLIC_HOST}/v1` });
    const keyGoes = await call('owner', 'PUT', settingsUrl(), { api_key: { value: KEY } });
    expect(errorsOf(keyGoes)).toEqual([
      expect.objectContaining({ code: 'INSECURE_KEY_NOT_CONFIRMED' }),
    ]);
    // Confirmed: stored for host:80, as the person asked.
    const confirmed = await put({ api_key: { value: KEY }, confirm_insecure: true });
    expect(confirmed.api_key?.allowed_hosts).toEqual([`${PUBLIC_HOST}:80`]);
    // An https URL never needs it; an allowlisted internal host neither.
    await restore();
    expect((await secretRow(keyId))?.allowed_hosts).toEqual([fakeHost()]);
    expect(lookups).toContain(PUBLIC_HOST);
    expect(fake.requests).toEqual([]);
    expect(trap.requests).toEqual([]);
  });

  it('P118 test with settings: the key goes only to the host of the URL tried', async () => {
    const before = await getSettings();
    // The saved key never follows a URL tried.
    expect(await testConnection({ settings: { provider_base_url: trap.baseUrl } })).toMatchObject({
      ok: false,
      error: { reason: 'secret_host_not_allowed' },
    });
    expect(
      await testConnection({
        settings: { provider_base_url: trap.baseUrl, api_key: { secret_id: keyId } },
      }),
    ).toMatchObject({ ok: false, error: { reason: 'secret_host_not_allowed' } });
    expect(trap.requests).toEqual([]);
    // A key typed for the URL tried goes there only, and is not stored.
    expect(
      await testConnection({
        settings: { provider_base_url: trap.baseUrl, api_key: { value: TRIED_KEY } },
      }),
    ).toMatchObject({ ok: true });
    expect(new Set(withKey(trap).map((request) => request.headers['authorization']))).toEqual(
      new Set([`Bearer ${TRIED_KEY}`]),
    );
    expect(fake.requests).toEqual([]);
    // Plain http to a public host: 422 unless confirmed — then refused by the port before any connection.
    answers.set(PUBLIC_HOST, ['93.184.216.34']);
    const insecure = {
      settings: {
        provider_base_url: `http://${PUBLIC_HOST}:8080/v1`,
        api_key: { value: TRIED_KEY },
      },
    };
    const refused = await tryTest(insecure);
    expectProblem(refused, 422, 'VALIDATION_FAILED');
    expect(errorsOf(refused)).toEqual([
      expect.objectContaining({
        path: 'confirm_insecure',
        code: 'INSECURE_KEY_NOT_CONFIRMED',
        params: { host: `${PUBLIC_HOST}:8080` },
      }),
    ]);
    expect(await testConnection({ ...insecure, confirm_insecure: true })).toMatchObject({
      ok: false,
      error: { reason: 'ssrf_blocked' },
    });
    // Nothing tried was saved.
    expect(await getSettings()).toEqual(before);
  });

  it('P118 redirect: a 302 or 307 of the provider is never followed', async () => {
    fake.capabilities.models = {
      status: 302,
      headers: { location: `${trap.baseUrl}/models` },
    };
    fake.script({ status: 307, headers: { location: `${trap.baseUrl}/chat/completions` } });
    const result = await testConnection();
    expect(result).toMatchObject({
      ok: false,
      models: null,
      error: { code: 'AI_PROVIDER_ERROR', reason: 'http_status', status: 307 },
    });
    expect(fake.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      'GET /v1/models',
      'POST /v1/chat/completions',
    ]);
    expect(trap.requests).toEqual([]);
  });

  it('P118 DNS rebinding: one lookup per call, the connection pinned; a later metadata answer is refused before anything is sent', async () => {
    answers.set('rebind.test', ['127.0.0.1']);
    await allow(`rebind.test:${String(fake.port)}`);
    const baseUrl = `http://rebind.test:${String(fake.port)}/v1`;
    // Allowlisted and internal: no confirmation needed.
    await put({ provider_base_url: baseUrl, api_key: { value: KEY } });
    let answered = 0;
    answers.set('rebind.test', () => {
      answered += 1;
      return answered === 1 ? ['127.0.0.1'] : ['169.254.169.254'];
    });
    lookups.length = 0;
    const blocked = blockedAddresses();
    expect(await testConnection()).toMatchObject({
      ok: false,
      models: ['fake-model'],
      error: { reason: 'ssrf_blocked' },
    });
    // `GET /models` reached the pinned address; the chat call resolved again and was refused.
    expect(fake.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      'GET /v1/models',
    ]);
    expect(lookups.filter((host) => host === 'rebind.test')).toEqual([
      'rebind.test',
      'rebind.test',
    ]);
    expect(blockedAddresses()).toBe(blocked + 1);

    // One answer with a metadata address next to the loopback one: the whole host is refused.
    fake.requests.length = 0;
    answers.set('rebind.test', ['127.0.0.1', '169.254.169.254']);
    expect(await testConnection()).toMatchObject({ ok: false, error: { reason: 'ssrf_blocked' } });
    expect(fake.requests).toEqual([]);
    expect(trap.requests).toEqual([]);
    await restore();
  });

  it('P118 IPv6 with an embedded IPv4: mapped, translated, NAT64 and 6to4 forms of metadata addresses are refused, entry or not', async () => {
    await allow('v6.test');
    const forms = [
      '::ffff:169.254.169.254',
      '::ffff:a9fe:a9fe',
      '::ffff:0:a9fe:a9fe',
      '64:ff9b::a9fe:a9fe',
      '64:ff9b:1::a9fe:a9fe',
      '2002:a9fe:a9fe::1',
      '::ffff:168.63.129.16',
      '64:ff9b::a83f:8110',
    ];
    const blocked = blockedAddresses();
    for (const address of forms) {
      answers.set('v6.test', [address]);
      expect(
        await testConnection({
          settings: { provider_base_url: 'https://v6.test/v1', api_key: { value: TRIED_KEY } },
        }),
        address,
      ).toMatchObject({ ok: false, error: { reason: 'ssrf_blocked' } });
    }
    expect(blockedAddresses()).toBe(blocked + forms.length);
    // As literals, a key cannot even be bound to them; without one, the call is refused.
    for (const literal of ['[::ffff:a9fe:a9fe]', '[64:ff9b::a9fe:a9fe]', '[::ffff:a83f:8110]']) {
      const url = `http://${literal}/v1`;
      const keyed = await call('owner', 'PUT', settingsUrl(), {
        provider_base_url: url,
        api_key: { value: KEY },
      });
      expect(errorsOf(keyed)).toEqual([
        expect.objectContaining({ path: 'api_key', code: 'SECRET_HOST_NOT_ALLOWED' }),
      ]);
      expect(
        await testConnection({ settings: { provider_base_url: url, api_key: null } }),
      ).toMatchObject({ ok: false, error: { reason: 'ssrf_blocked' } });
    }
    expect(fake.requests).toEqual([]);
    expect(trap.requests).toEqual([]);
  });

  it('P118 metadata: every never-reachable address stays closed with an allowlist entry, 168.63.129.16 included', async () => {
    await allow('meta.test');
    const addresses = [...NEVER_ALLOWED_RANGES.ipv4, ...NEVER_ALLOWED_RANGES.ipv6].map(
      (cidr) => cidr.split('/')[0] ?? '',
    );
    expect(addresses).toContain('168.63.129.16');
    // A saved key bound to the host, then each address in turn.
    await put({ provider_base_url: 'https://meta.test/v1', api_key: { value: KEY } });
    const blocked = blockedAddresses();
    for (const address of addresses) {
      answers.set('meta.test', [address]);
      expect(await testConnection(), address).toMatchObject({
        ok: false,
        error: { code: 'AI_PROVIDER_ERROR', reason: 'ssrf_blocked' },
      });
    }
    expect(blockedAddresses()).toBe(blocked + addresses.length);
    expect(fake.requests).toEqual([]);
    expect(trap.requests).toEqual([]);
    await restore();
  });

  it('a provider URL with a query or fragment is INVALID_URL (query_or_fragment), nothing sent', async () => {
    for (const url of [`${fake.baseUrl}?api-version=1`, `${fake.baseUrl}#models`]) {
      for (const response of [
        await call('owner', 'PUT', settingsUrl(), { provider_base_url: url }),
        await tryTest({ settings: { provider_base_url: url } }),
      ]) {
        expectProblem(response, 422, 'VALIDATION_FAILED');
        expect(errorsOf(response)).toEqual([
          expect.objectContaining({
            path: 'provider_base_url',
            code: 'INVALID_URL',
            params: { reason: 'query_or_fragment' },
          }),
        ]);
      }
    }
    expect(fake.requests).toEqual([]);
  });

  it('never shows a key or a header value: responses, audit rows, logs', async () => {
    expect(seen.length).toBeGreaterThan(40);
    const responses = seen
      .map((response) => `${JSON.stringify(response.headers)}\n${response.body}`)
      .join('\n');
    const audit =
      await sql`SELECT * FROM meta.audit_logs WHERE organization_id = ${fx.orgId}`.execute(
        db.kysely,
      );
    for (const value of KEYS) {
      expect(responses).not.toContain(value);
      expect(JSON.stringify(audit.rows)).not.toContain(value);
      expect(t.logs.raw()).not.toContain(value);
    }
  });
});
