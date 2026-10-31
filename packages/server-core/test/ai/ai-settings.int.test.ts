import { Buffer } from 'node:buffer';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  startFakeOpenAiServer,
  type FakeOpenAiServer,
} from '../../src/ai/testing/fake-openai-server.js';
import {
  AiSettingsRepository,
  AiUsageLedger,
  AiUsageRepository,
  AppError,
  createAiKeySource,
  createDeadline,
  deriveSecretKey,
  LlmClient,
  orgScope,
  purgeExpiredOperationalRows,
  sealSecret,
  SecretsRepository,
  type Db,
} from '../../src/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { seedTenant } from '../support/tenant.js';

import type { Id } from '@cellhive/contracts';

const ORG_A = 'org_AiSettingsOrgA01';
const ORG_B = 'org_AiSettingsOrgB01';
const MASTER = Buffer.alloc(32, 9);
const KEY = 'sk-test-not-a-real-key';
const SECRET_A: Id<'sec'> = 'sec_AiSettingsKeyA01';

/**
 * BACKLOG T906 (migration 0054, CONTRACTS §24, §29.1): tenant isolation of
 * the AI settings and usage repositories, the `ai_api_key` rules of
 * `meta.secrets`, the database key source (hosts before value), the usage
 * ledger and quota, the 400-day retention, and `GET /models`.
 */
describe('AI settings and usage repositories (T906)', () => {
  let database: TestDatabase;
  let db: Db;
  let fake: FakeOpenAiServer;
  const settings = () => new AiSettingsRepository(db);
  const usage = () => new AiUsageRepository(db);

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    await seedTenant(db, ORG_A);
    await seedTenant(db, ORG_B);
    await new SecretsRepository(db).create(orgScope(ORG_A), {
      id: SECRET_A,
      kind: 'ai_api_key',
      name: 'AI key',
      ciphertext: sealSecret(deriveSecretKey(MASTER, 'org-secret'), KEY),
      allowed_hosts: ['api.openai.com'],
    });
    fake = await startFakeOpenAiServer();
  });

  afterAll(async () => {
    await fake.close();
    await db.destroy();
    await database.drop();
  });

  it('keeps the settings inside their organization (tenant isolation)', async () => {
    const scopeA = orgScope(ORG_A);
    const scopeB = orgScope(ORG_B);
    const saved = await settings().save(scopeA, {
      enabled: true,
      provider_base_url: 'https://api.openai.com/v1',
      model: 'gpt-test',
      api_key_secret_id: SECRET_A,
    });
    expect(saved).toMatchObject({ organization_id: ORG_A, daily_token_limit: 1_000_000n });
    expect(await settings().find(scopeB)).toBeUndefined();
    expect(await settings().usesKey(scopeA, SECRET_A)).toBe(true);
    expect(await settings().usesKey(scopeB, SECRET_A)).toBe(false);
    // The key of another organization cannot be referenced (composite FK).
    await expect(settings().save(scopeB, { api_key_secret_id: SECRET_A })).rejects.toMatchObject({
      code: '23503',
    });

    // Saving again updates the one row.
    await settings().save(scopeA, { model: 'gpt-other' });
    expect((await settings().find(scopeA))?.model).toBe('gpt-other');
    await settings().saveDetectedOutput(
      scopeA,
      { baseUrl: 'https://api.openai.com/v1', model: 'gpt-test' },
      'prompt',
    );
    expect((await settings().find(scopeA))?.detected_output).toBeNull();
    await settings().saveDetectedOutput(
      scopeA,
      { baseUrl: 'https://api.openai.com/v1', model: 'gpt-other' },
      'prompt',
    );
    expect((await settings().find(scopeA))?.detected_output).toBe('prompt');
  });

  it('binds an ai_api_key secret to 1–20 hosts and every base', async () => {
    const scopeB = orgScope(ORG_B);
    const insert = (id: Id<'sec'>, patch: object) =>
      new SecretsRepository(db).create(scopeB, {
        id,
        kind: 'ai_api_key',
        name: id,
        ciphertext: 'x',
        ...patch,
      });
    await expect(insert('sec_AiSettingsBad001', {})).rejects.toMatchObject({ code: '23514' });
    await expect(
      insert('sec_AiSettingsBad002', { allowed_hosts: ['a.example'], base_scope: 'selected' }),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      insert('sec_AiSettingsBad003', {
        allowed_hosts: ['a.example'],
        legacy_hosts_until: new Date(),
      }),
    ).rejects.toMatchObject({ code: '23514' });
    await insert('sec_AiSettingsGood01', { allowed_hosts: ['a.example'] });
    // Never offered to automations.
    expect(
      await new SecretsRepository(db).listUsableInBase(scopeB, 'bse_AiSettingsOrgB01'),
    ).toEqual([]);
  });

  it('reads the hosts first and unseals only an ai_api_key of the organization', async () => {
    const keys = createAiKeySource(db, MASTER);
    expect(await keys.hosts(ORG_A, SECRET_A)).toEqual({
      allowedHosts: ['api.openai.com'],
      legacyHostsUntil: null,
    });
    expect(await keys.value(ORG_A, SECRET_A)).toBe(KEY);
    expect(await keys.hosts(ORG_B, SECRET_A)).toBeNull();
    expect(await keys.value(ORG_B, SECRET_A)).toBeNull();
    expect(await keys.value(ORG_B, 'sec_AiSettingsGood01')).toBe(null);
  });

  it('adds usage per day and feature, checks the quota and keeps organizations apart', async () => {
    const ledger = new AiUsageLedger(db);
    const now = new Date('2026-10-31T16:59:00Z');
    const a = { organizationId: ORG_A, timeZone: 'Asia/Ho_Chi_Minh', now } as const;
    await Promise.all(
      Array.from({ length: 5 }, () =>
        ledger.record(a, 'test', {
          promptTokens: 1_000,
          completionTokens: 1_000,
          estimated: false,
        }),
      ),
    );
    await ledger.record(a, 'ask', { promptTokens: 300, completionTokens: 0, estimated: true });
    expect(await usage().list(orgScope(ORG_A), '2026-10-31', '2026-10-31')).toEqual([
      {
        day: '2026-10-31',
        feature: 'ask',
        requests: 1,
        promptTokens: 300,
        completionTokens: 0,
        estimatedRequests: 1,
      },
      {
        day: '2026-10-31',
        feature: 'test',
        requests: 5,
        promptTokens: 5_000,
        completionTokens: 5_000,
        estimatedRequests: 0,
      },
    ]);
    expect(await ledger.usedToday(a)).toBe(10_300);
    expect(await usage().list(orgScope(ORG_B), '2026-10-01', '2026-10-31')).toEqual([]);
    expect(await ledger.usedToday({ ...a, organizationId: ORG_B })).toBe(0);

    await ledger.check(a, 10_301);
    await ledger.check(a, null);
    const refused = await ledger.check(a, 10_300).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(AppError);
    expect(refused).toMatchObject({
      code: 'AI_QUOTA_EXCEEDED',
      retryAfterSeconds: 60,
      errors: [
        {
          code: 'AI_QUOTA_EXCEEDED',
          params: { reset_at: '2026-10-31T17:00:00.000Z', daily_token_limit: 10_300 },
        },
      ],
    });
    // A minute later it is another day in Ho Chi Minh City.
    await ledger.check({ ...a, now: new Date('2026-10-31T17:00:00Z') }, 10_300);
  });

  it('deletes usage days older than 400 days', async () => {
    const scope = orgScope(ORG_B);
    const one = { promptTokens: 1, completionTokens: 1, estimated: false };
    await usage().add(scope, '2025-09-25', 'ask', one);
    await usage().add(scope, '2025-09-26', 'ask', one);
    const result = await purgeExpiredOperationalRows(db, { now: new Date('2026-10-31T00:00:00Z') });
    expect(result.aiUsageDays).toBe(1);
    expect((await usage().list(scope, '2025-01-01', '2026-12-31')).map((row) => row.day)).toEqual([
      '2025-09-26',
    ]);
  });

  it('lists the models of the provider through the same door as chat calls', async () => {
    const client = new LlmClient({
      allowlist: [{ host: 'localhost', wildcard: false, port: fake.port }],
      privateAllowlist: 'org',
      keys: createAiKeySource(db, MASTER),
      lookup: () => Promise.resolve(['127.0.0.1']),
    });
    const provider = {
      baseUrl: fake.baseUrl,
      model: 'fake-model',
      apiKeySecretId: null,
      tokenParam: 'max_tokens' as const,
      requestTimeoutSeconds: 10,
      outputMode: 'json_schema' as const,
    };
    const models = await client.listModels({
      organizationId: ORG_A,
      settings: provider,
      deadline: createDeadline(),
      max: 200,
    });
    expect(models.length).toBeGreaterThan(0);
    expect(fake.requests.at(-1)).toMatchObject({ method: 'GET', path: '/v1/models' });
    // The key of api.openai.com is never sent to localhost.
    const before = fake.requests.length;
    await expect(
      client.listModels({
        organizationId: ORG_A,
        settings: { ...provider, apiKeySecretId: SECRET_A },
        deadline: createDeadline(),
        max: 200,
      }),
    ).rejects.toMatchObject({
      code: 'AI_PROVIDER_ERROR',
      params: { reason: 'secret_host_not_allowed' },
    });
    expect(fake.requests.length).toBe(before);
  });
});
