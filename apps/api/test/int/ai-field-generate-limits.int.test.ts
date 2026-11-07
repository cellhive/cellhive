import {
  AI_FIELD_GENERATE_MAX_ROWS,
  aiFieldGenerateSchema,
  fieldSchema,
  type FieldDto,
  type Id,
} from '@cellhive/contracts';
import {
  AiFieldGenerator,
  AiGenerationQueueRepository,
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
import { startFakeOpenAiServer, type FakeOpenAiServer } from '@cellhive/server-core/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ApiRateLimits } from '../../src/common/rate-limit/api-rate-limits.js';
import { AiAccess } from '../../src/modules/ai/ai-access.js';
import { AiFieldService } from '../../src/modules/ai/ai-field.service.js';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { buildRecordFixture, expectProblem, type RecordFixture } from './record-fixture.js';
import { startTestApp, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

const RECORDS = 12;
const LOCALHOST = () => Promise.resolve(['127.0.0.1']);

interface Problem {
  readonly code: string;
  readonly errors?: { path: string; code: string; params?: Record<string, unknown> }[];
}

/**
 * BACKLOG T1003 (CONTRACTS §29.5, §29.8): `POST /fields/:id/ai/generate`
 * goes through the AI rate limit (10 a minute per person) and today's
 * quota before anything is queued; one generate request of a field at a
 * time (`409 AI_GENERATION_RUNNING` with its job); at most
 * `AI_FIELD_GENERATE_MAX_ROWS` rows in any scope (`422 TOO_MANY_ROWS`,
 * never cut short; a small cap injected here), ids read in batches; a
 * repeat request leaves `invalid_output` rows failed unless its scope is
 * `failed` or `all`. Every case checks what was queued.
 */
describe('AI field generate limits (T1003)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let fake: FakeOpenAiServer;
  let service: AiFieldService;
  let note: FieldDto;
  let tag: FieldDto;
  const clock = new Date();
  const records: Id<'rec'>[] = [];

  const queue = () => new AiGenerationQueueRepository(db);
  const scope = () => orgScope(fx.orgId);
  const generate = (
    fieldId: Id<'fld'>,
    body: Record<string, unknown>,
    user: 'u_admin' | 'owner' = 'u_admin',
  ) => fx.call(user, 'POST', `/fields/${fieldId}/ai/generate`, body);
  const accepted = (response: LightMyRequestResponse) => {
    expect(response.statusCode, response.body).toBe(202);
    return aiFieldGenerateSchema.parse(response.json());
  };
  const problem = (response: LightMyRequestResponse) => response.json<Problem>();
  const rows = async (fieldId: Id<'fld'>) =>
    (
      await sql<{
        record_id: Id<'rec'>;
        status: string;
        reason: string | null;
        attempts: number;
        job_id: Id<'job'> | null;
      }>`
        SELECT record_id, status, reason, attempts, job_id FROM meta.ai_generation_queue
         WHERE field_id = ${fieldId} ORDER BY record_id COLLATE "C"`.execute(db.kysely)
    ).rows;
  const generateJobs = async () =>
    (
      await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM meta.jobs
         WHERE organization_id = ${fx.orgId} AND type = 'ai.generate'`.execute(db.kysely)
    ).rows[0]?.n;
  const clearQueue = () =>
    sql`DELETE FROM meta.ai_generation_queue WHERE organization_id = ${fx.orgId}`.execute(
      db.kysely,
    );
  /** Rows of `fieldId` as `failed` with `reason` (as a batch would leave them). */
  const failed = (fieldId: Id<'fld'>, ids: readonly Id<'rec'>[], reason: string, attempts = 1) =>
    sql`
      INSERT INTO meta.ai_generation_queue (organization_id, field_id, record_id, status, reason, attempts)
      SELECT ${fx.orgId}, ${fieldId}, r.id, 'failed', ${reason}, ${attempts}
        FROM unnest(${sql.val([...ids])}::text[]) AS r(id)
      ON CONFLICT (field_id, record_id) DO UPDATE
         SET status = 'failed', reason = EXCLUDED.reason, attempts = EXCLUDED.attempts`.execute(
      db.kysely,
    );
  const generator = () =>
    new AiFieldGenerator(db, {
      llm: new LlmClient({
        allowlist: httpAllowlistSource(db),
        privateAllowlist: 'org',
        keys: createAiKeySource(db, t.config.security.appMasterKey),
        lookup: LOCALHOST,
        now: () => clock,
      }),
      records: t.app.get(RecordQueryService),
      mutations: t.app.get(RecordMutationService),
      defaultTimeZone: 'UTC',
      defaultLocale: 'en',
      now: () => clock,
    });
  /** Every batch of `fieldId` due now, like the `ai.generate` job. */
  const drain = async (fieldId: Id<'fld'>) => {
    for (let run = 1; run < 50; run += 1) {
      const outcome = await generator().runBatch(scope(), fieldId, recomputeJobBatchId(run));
      if (outcome.status !== 'more') return;
    }
    throw new Error('the queue never drained');
  };
  const addAiField = async (name: string): Promise<FieldDto> => {
    const created = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
      name,
      type: 'text',
      options: { ai: { task: 'summarize', prompt: 'Tóm tắt {{ [title] }}', auto_update: false } },
    });
    expect(created.statusCode, created.body).toBe(201);
    return fieldSchema.parse(created.json());
  };

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url }, { outboundLookup: LOCALHOST });
    fx = await buildRecordFixture(t, db);
    t.app.get(ApiRateLimits).ai = { limit: 10_000, windowSeconds: 60 };
    t.app.get(AiAccess).now = () => clock;
    service = t.app.get(AiFieldService);
    fake = await startFakeOpenAiServer();
    const entry = await fx.call('owner', 'POST', `/orgs/${fx.orgId}/http-allowlist`, {
      pattern: `localhost:${String(fake.port)}`,
    });
    expect(entry.statusCode, entry.body).toBe(201);
    const saved = await fx.call('owner', 'PUT', `/orgs/${fx.orgId}/ai-settings`, {
      enabled: true,
      provider_base_url: fake.baseUrl,
      model: 'fake-model',
      allow_record_data: true,
      confirm: true,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const created = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/records`, {
      records: Array.from({ length: RECORDS }, (_, index) => ({
        fields: { title: `Đơn ${String(index)}`, cost: index },
      })),
    });
    expect(created.statusCode, created.body).toBe(201);
    records.push(
      ...created
        .json<{ records: { id: Id<'rec'> }[] }>()
        .records.map((record) => record.id)
        .sort(),
    );
    note = await addAiField('ai_note');
    tag = await addAiField('ai_tag');
  }, 120_000);

  afterAll(async () => {
    await fake.close();
    await t.close();
    await db.destroy();
    await database.drop();
  });

  beforeEach(async () => {
    fake.requests.length = 0;
    await clearQueue();
  });

  it('the cap is 200,000 rows per request', () => {
    expect(AI_FIELD_GENERATE_MAX_ROWS).toBe(200_000);
    expect(service.maxRows).toBe(AI_FIELD_GENERATE_MAX_ROWS);
  });

  it('the 11th request of a person within a minute is 429 RATE_LIMITED; another person has their own', async () => {
    const limits = t.app.get(ApiRateLimits);
    // Another window length is another counter: other tests do not count.
    limits.ai = { limit: 10, windowSeconds: 47 };
    try {
      for (let index = 0; index < 10; index += 1) {
        expect(accepted(await generate(note.id, { scope: 'failed' })).rows).toBe(0);
      }
      const eleventh = await generate(note.id, { scope: 'all' });
      expectProblem(eleventh, 429, 'RATE_LIMITED');
      expect(Number(eleventh.headers['retry-after'])).toBeGreaterThan(0);
      expect(await rows(note.id)).toEqual([]);
      expect(accepted(await generate(note.id, { scope: 'failed' }, 'owner')).rows).toBe(0);
    } finally {
      limits.ai = { limit: 10_000, windowSeconds: 60 };
    }
  });

  it('today’s quota used up: 429 AI_QUOTA_EXCEEDED with the reset time; nothing queued, no job', async () => {
    const zone = await sql<{ zone: string | null }>`
      SELECT settings ->> 'timezone' AS zone FROM meta.organizations WHERE id = ${fx.orgId}`.execute(
      db.kysely,
    );
    const today = quotaDayOf(clock, zone.rows[0]?.zone ?? t.config.defaults.timezone);
    await sql`INSERT INTO meta.ai_usage_daily (organization_id, day, feature, requests, prompt_tokens)
              VALUES (${fx.orgId}, ${today.day}, 'field', 1, 1000000)`.execute(db.kysely);
    try {
      const jobs = await generateJobs();
      for (const body of [
        { scope: 'all' },
        { scope: 'records', record_ids: records.slice(0, 2) },
      ]) {
        const response = await generate(note.id, body);
        expectProblem(response, 429, 'AI_QUOTA_EXCEEDED');
        expect(problem(response).errors?.[0]?.params).toMatchObject({
          reset_at: today.resetAt.toISOString(),
        });
      }
      expect(await rows(note.id)).toEqual([]);
      expect(await generateJobs()).toBe(jobs);
      expect(fake.requests).toEqual([]);
    } finally {
      await sql`DELETE FROM meta.ai_usage_daily WHERE organization_id = ${fx.orgId}`.execute(
        db.kysely,
      );
    }
  });

  it('one generate request of a field at a time: 409 AI_GENERATION_RUNNING with its job until its rows are done', async () => {
    const first = accepted(await generate(note.id, { scope: 'all' }));
    expect(first.rows).toBe(RECORDS);
    for (const body of [
      { scope: 'empty' },
      { scope: 'all' },
      { scope: 'records', record_ids: records.slice(0, 1) },
    ]) {
      const second = await generate(note.id, body);
      expectProblem(second, 409, 'AI_GENERATION_RUNNING');
      expect(problem(second).errors).toEqual([
        {
          path: '',
          code: 'AI_GENERATION_RUNNING',
          message: expect.any(String) as unknown,
          params: { job_id: first.job_id },
        },
      ]);
    }
    // The first request's rows are untouched; another field is not blocked.
    expect((await rows(note.id)).every((row) => row.job_id === first.job_id)).toBe(true);
    expect(accepted(await generate(tag.id, { scope: 'records', record_ids: records })).rows).toBe(
      RECORDS,
    );
    await drain(note.id);
    expect((await fx.call('u_admin', 'GET', `/jobs/${first.job_id}`)).json()).toMatchObject({
      status: 'succeeded',
    });
    // Done: the next request is accepted (nothing empty left).
    expect(accepted(await generate(note.id, { scope: 'empty' })).rows).toBe(0);
  });

  it('two requests at once: one queues, the other is 409', async () => {
    const both = await Promise.all([
      generate(note.id, { scope: 'all' }),
      generate(note.id, { scope: 'all' }),
    ]);
    expect(both.map((response) => response.statusCode).sort()).toEqual([202, 409]);
    const job = both.find((response) => response.statusCode === 202)?.json<{ job_id: string }>();
    expect((await rows(note.id)).map((row) => row.job_id)).toEqual(
      Array.from({ length: RECORDS }, () => job?.job_id),
    );
    await drain(note.id);
  });

  it('a request whose rows are all paused is not running: "Resume" queues them', async () => {
    const first = accepted(
      await generate(note.id, { scope: 'records', record_ids: records.slice(0, 3) }),
    );
    await queue().pause(scope(), 'quota');
    const resumed = accepted(await generate(note.id, { scope: 'paused' }));
    expect(resumed.rows).toBe(3);
    expect(resumed.job_id).not.toBe(first.job_id);
    expect((await rows(note.id)).map((row) => [row.status, row.job_id])).toEqual(
      Array.from({ length: 3 }, () => ['queued', resumed.job_id]),
    );
    await drain(note.id);
  });

  it('more rows than the cap: 422 TOO_MANY_ROWS with rows and limit in every scope; nothing queued, no job', async () => {
    service.maxRows = 3;
    try {
      await failed(tag.id, records.slice(0, 4), 'timeout');
      const jobs = await generateJobs();
      const before = await rows(tag.id);
      for (const [body, count] of [
        [{ scope: 'all' }, RECORDS],
        [{ scope: 'empty' }, RECORDS],
        [{ scope: 'failed' }, 4],
        [{ scope: 'records', record_ids: records.slice(0, 4) }, 4],
      ] as const) {
        const response = await generate(tag.id, body);
        expectProblem(response, 422, 'VALIDATION_FAILED');
        expect(problem(response).errors).toEqual([
          {
            path: 'scope',
            code: 'TOO_MANY_ROWS',
            message: expect.any(String) as unknown,
            params: { rows: count, limit: 3 },
          },
        ]);
      }
      expect(await rows(tag.id)).toEqual(before);
      expect(await generateJobs()).toBe(jobs);
      // At the cap: accepted.
      service.maxRows = RECORDS;
      expect(accepted(await generate(tag.id, { scope: 'all' })).rows).toBe(RECORDS);
    } finally {
      service.maxRows = AI_FIELD_GENERATE_MAX_ROWS;
    }
  });

  it('reads the ids a few at a time: every record of the scope is queued', async () => {
    service.idBatch = 5;
    try {
      const all = accepted(await generate(tag.id, { scope: 'all' }));
      expect(all.rows).toBe(RECORDS);
      expect((await rows(tag.id)).map((row) => row.record_id)).toEqual(records);
      await clearQueue();
      service.idBatch = 2;
      await failed(tag.id, records.slice(0, 7), 'timeout');
      expect(accepted(await generate(tag.id, { scope: 'failed' })).rows).toBe(7);
      expect((await rows(tag.id)).map((row) => [row.record_id, row.status])).toEqual(
        records.slice(0, 7).map((id) => [id, 'queued']),
      );
    } finally {
      service.idBatch = 5_000;
    }
  });

  it('a repeat request leaves invalid_output rows failed unless its scope is failed or all', async () => {
    const [r1, r2] = records as [Id<'rec'>, Id<'rec'>];
    await failed(tag.id, [r1], 'invalid_output');
    await failed(tag.id, [r2], 'timeout', 4);
    const settle = () =>
      sql`DELETE FROM meta.ai_generation_queue WHERE field_id = ${tag.id} AND status <> 'failed'`.execute(
        db.kysely,
      );

    expect(accepted(await generate(tag.id, { scope: 'records', record_ids: [r1, r2] })).rows).toBe(
      1,
    );
    expect(await rows(tag.id)).toMatchObject([
      { record_id: r1, status: 'failed', reason: 'invalid_output', attempts: 1 },
      { record_id: r2, status: 'queued', reason: null, attempts: 0 },
    ]);
    await settle();
    // Every cell of the field is empty: all but r1.
    expect(accepted(await generate(tag.id, { scope: 'empty' })).rows).toBe(RECORDS - 1);
    expect((await rows(tag.id))[0]).toMatchObject({ record_id: r1, status: 'failed' });
    await settle();
    expect(accepted(await generate(tag.id, { scope: 'failed' })).rows).toBe(1);
    expect((await rows(tag.id))[0]).toMatchObject({ record_id: r1, status: 'queued', attempts: 0 });
    await failed(tag.id, [r1], 'invalid_output');
    expect(accepted(await generate(tag.id, { scope: 'all' })).rows).toBe(RECORDS);
    expect((await rows(tag.id))[0]).toMatchObject({ record_id: r1, status: 'queued', attempts: 0 });
  });
});
