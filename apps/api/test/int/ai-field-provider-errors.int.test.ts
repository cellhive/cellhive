import {
  AI_FIELD_BACKOFF_MS,
  aiFieldGenerateSchema,
  fieldSchema,
  type FieldDto,
  type Id,
  type RealtimeServerMessage,
} from '@cellhive/contracts';
import {
  AiFieldGenerator,
  aiFieldStateSchemaChange,
  AiGenerationQueueRepository,
  createAiKeySource,
  httpAllowlistSource,
  LlmClient,
  orgScope,
  RealtimeSchemaChangePublisher,
  RecordMutationService,
  RecordQueryService,
  recomputeJobBatchId,
  type AiBatchOutcome,
  type Db,
  type RealtimePublisher,
} from '@cellhive/server-core';
import { startFakeOpenAiServer, type FakeOpenAiServer } from '@cellhive/server-core/testing';
import { buildTaskList, createWorker, type WorkerHandle } from '@cellhive/worker';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ApiRateLimits } from '../../src/common/rate-limit/api-rate-limits.js';
import { REALTIME_BUS } from '../../src/common/tokens.js';
import { AiAccess } from '../../src/modules/ai/ai-access.js';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { closeSockets, listen, TestSocket } from './realtime-support.js';
import { buildRecordFixture, expectProblem, type RecordFixture } from './record-fixture.js';
import { captureLogger, startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

const LOCALHOST = () => Promise.resolve(['127.0.0.1']);
const KEY = 'sk-test-not-a-real-key-t1002-a';
const NEW_KEY = 'sk-test-not-a-real-key-t1002-b';
const NEWER_KEY = 'sk-test-not-a-real-key-t1002-c';
/** Records of the bulk table: two AI fields over them queue 5,000 rows. */
const BULK_RECORDS = 2_500;

type CellMeta = { state: string; reason?: string };

/**
 * BACKLOG T1002 (CONTRACTS §29.5): AI field queues against provider
 * errors, with the fake provider. The provider rejecting the configuration
 * (`401`, an address outside the allowlist) pauses every queued row of the
 * organization as `provider_error` after at most `AI_CONCURRENCY` calls;
 * saving the AI settings with a new key, or a new value of the key, resumes
 * them in the same transaction (the rescue cron does not); a `429` backs
 * the organization off for its `Retry-After` without spending tries (an
 * injected clock); five `503`s in a row back it off too; `scope: paused`
 * queues the paused cells only; `refused` and `truncated` reach
 * `record.meta.ai`, never for a reader locked out of the field.
 */
describe('AI field queues and provider errors (T1002)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let fake: FakeOpenAiServer;
  let other: FakeOpenAiServer;
  let clock = new Date();
  let note: FieldDto;
  let summary: FieldDto;
  let headline: FieldDto;
  const records: Id<'rec'>[] = [];
  const sockets: TestSocket[] = [];

  const chats = (server: FakeOpenAiServer = fake) => server.chatRequests();
  const queue = () => new AiGenerationQueueRepository(db);
  const scope = () => orgScope(fx.orgId);
  const generator = (onState?: RealtimePublisher) => {
    const publisher =
      onState === undefined ? undefined : new RealtimeSchemaChangePublisher(onState);
    return new AiFieldGenerator(db, {
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
      ...(publisher === undefined
        ? {}
        : {
            onStateChange: async (changes) => {
              for (const change of changes) {
                await publisher.publish(aiFieldStateSchemaChange(change));
              }
            },
          }),
    });
  };
  /** Every batch of `fieldId` due now, like the `ai.generate` job. */
  const drain = async (fieldId: Id<'fld'> = note.id): Promise<AiBatchOutcome[]> => {
    const outcomes: AiBatchOutcome[] = [];
    for (let run = 1; run < 50; run += 1) {
      const outcome = await generator().runBatch(scope(), fieldId, recomputeJobBatchId(run));
      outcomes.push(outcome);
      if (outcome.status !== 'more') return outcomes;
    }
    throw new Error('the queue never drained');
  };
  const settings = async (body: Record<string, unknown>) => {
    const response = await fx.call('owner', 'PUT', `/orgs/${fx.orgId}/ai-settings`, body);
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ api_key: { secret_id: Id<'sec'> } | null }>();
  };
  const generate = async (fieldId: Id<'fld'>, body: Record<string, unknown>) => {
    const response = await fx.call('u_admin', 'POST', `/fields/${fieldId}/ai/generate`, body);
    expect(response.statusCode, response.body).toBe(202);
    return aiFieldGenerateSchema.parse(response.json());
  };
  const field = async (fieldId: Id<'fld'>) =>
    fieldSchema.parse((await fx.call('u_admin', 'GET', `/fields/${fieldId}`)).json());
  const cell = async (recordId: Id<'rec'>, user: 'u_admin' | 'u_sales1' = 'u_admin') => {
    const response = await fx.call(
      user,
      'POST',
      `/tables/${fx.orders.id}/records/query?field_key_type=id`,
      { ids: [recordId] },
    );
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{
      records: { fields: Record<string, unknown>; meta?: { ai?: Record<string, CellMeta> } }[];
    }>().records[0];
  };
  const rows = async (fieldId: Id<'fld'>) =>
    (
      await sql<{ record_id: Id<'rec'>; status: string; reason: string | null; attempts: number }>`
        SELECT record_id, status, reason, attempts FROM meta.ai_generation_queue
         WHERE field_id = ${fieldId} ORDER BY record_id COLLATE "C"`.execute(db.kysely)
    ).rows;
  const counts = async () =>
    (
      await sql<{ status: string; reason: string | null; n: number }>`
        SELECT status, reason, count(*)::int AS n FROM meta.ai_generation_queue
         WHERE organization_id = ${fx.orgId} GROUP BY status, reason ORDER BY status, reason`.execute(
        db.kysely,
      )
    ).rows;
  const aiJobs = async () =>
    (
      await sql<{ key: string }>`
        SELECT key FROM graphile_worker.jobs WHERE task_identifier = 'ai.generate'
         ORDER BY key`.execute(db.kysely)
    ).rows
      .map((row) => row.key)
      .sort();
  const clearQueue = async () => {
    await sql`DELETE FROM meta.ai_generation_queue WHERE organization_id = ${fx.orgId}`.execute(
      db.kysely,
    );
    await sql`DELETE FROM graphile_worker._private_jobs`.execute(db.kysely);
  };
  const waitFor = async (check: () => Promise<boolean>, what: string, ms = 120_000) => {
    const deadline = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  let url: string | undefined;
  const watch = async () => {
    url ??= await listen(t.app);
    const socket = await TestSocket.connect(url, {
      origin: TEST_PUBLIC_URL,
      cookie: await fx.cookie('u_admin'),
    });
    sockets.push(socket);
    expect(await socket.subscribe(`table:${fx.orders.id}`, 's1')).toMatchObject({
      type: 'subscribed',
    });
    return socket;
  };
  const aiStateOf = (fieldId: Id<'fld'>) => (message: RealtimeServerMessage) =>
    message.type === 'schema.changed' && message.entity_id === fieldId && 'ai_state' in message;
  const addAiField = async (name: string, prompt: string): Promise<FieldDto> => {
    const created = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
      name,
      type: 'text',
      options: { ai: { task: 'summarize', prompt, auto_update: false } },
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
    fake = await startFakeOpenAiServer({ capabilities: { apiKey: KEY } });
    // A second provider the organization never allowlists.
    other = await startFakeOpenAiServer();
    const entry = await fx.call('owner', 'POST', `/orgs/${fx.orgId}/http-allowlist`, {
      pattern: `localhost:${String(fake.port)}`,
    });
    expect(entry.statusCode, entry.body).toBe(201);
    await settings({
      enabled: true,
      provider_base_url: fake.baseUrl,
      model: 'fake-model',
      api_key: { value: KEY },
      allow_record_data: true,
      confirm: true,
    });
    for (let start = 0; start < BULK_RECORDS; start += 500) {
      const created = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/records`, {
        records: Array.from({ length: 500 }, (_, index) => ({
          fields: {
            title: `Đơn ${String(start + index)}`,
            cost: start + index,
            owner: [{ id: fx.users.u_sales1.id }],
          },
        })),
      });
      expect(created.statusCode, created.body).toBe(201);
      records.push(
        ...created.json<{ records: { id: Id<'rec'> }[] }>().records.map((record) => record.id),
      );
    }
    note = await addAiField('ai_note', 'Tóm tắt {{ [title] }} — chi phí {{ [cost] }}');
    summary = await addAiField('ai_summary', 'Một câu về {{ [title] }} và {{ [cost] }}');
    headline = await addAiField('ai_headline', 'Tiêu đề cho {{ [title] }}, {{ [cost] }}');
  }, 300_000);

  afterAll(async () => {
    await closeSockets(sockets);
    await fake.close();
    await other.close();
    await t.close();
    await db.destroy();
    await database.drop();
  });

  beforeEach(() => {
    fake.requests.length = 0;
    other.requests.length = 0;
  });

  it('a revoked key (401) with 5,000 queued rows: at most AI_CONCURRENCY calls, every row paused', async () => {
    expect((await generate(note.id, { scope: 'all' })).rows).toBe(BULK_RECORDS);
    expect((await generate(summary.id, { scope: 'all' })).rows).toBe(BULK_RECORDS);
    expect(await counts()).toEqual([{ status: 'queued', reason: null, n: 5_000 }]);
    // The key is revoked at the provider: every call now answers 401.
    fake.capabilities.apiKey = NEW_KEY;
    const socket = await watch();
    const { logger } = captureLogger();
    let worker: WorkerHandle | undefined;
    try {
      const taskList = buildTaskList({
        config: t.config,
        db,
        logger,
        realtime: t.app.get<RealtimePublisher>(REALTIME_BUS),
        ai: { lookup: LOCALHOST },
      });
      worker = await createWorker(t.config, {
        logger,
        pollIntervalMs: 50,
        taskList: Object.fromEntries(
          Object.entries(taskList).filter(([name]) => name === 'ai.generate'),
        ),
      });
      await waitFor(async () => {
        const left = await counts();
        return left.every((row) => row.status === 'paused');
      }, 'every row paused');
    } finally {
      await worker?.close();
    }
    expect(chats().length).toBeGreaterThan(0);
    expect(chats().length).toBeLessThanOrEqual(t.config.limits.aiConcurrency);
    expect(await counts()).toEqual([
      { status: 'paused', reason: 'provider_error:unauthorized', n: 5_000 },
    ]);
    for (const id of [note.id, summary.id]) {
      expect((await field(id)).ai_state).toEqual({
        queued: 0,
        failed: 0,
        paused: BULK_RECORDS,
        paused_reason: 'provider_error',
        paused_detail: 'unauthorized',
        retry_at: null,
      });
    }
    const message = await socket.next(aiStateOf(note.id));
    expect(message).toMatchObject({
      type: 'schema.changed',
      action: 'updated',
      ai_state: { paused_reason: 'provider_error', paused_detail: 'unauthorized' },
    });
    expect((await cell(records[0] ?? 'rec_x'))?.meta?.ai).toEqual({
      [note.id]: { state: 'paused', reason: 'provider_error' },
      [summary.id]: { state: 'paused', reason: 'provider_error' },
    });
    // The rescue cron never resumes them: nothing changed that could fix it.
    expect(await generator().rescue(scope())).toEqual([]);
    expect((await counts())[0]).toMatchObject({ status: 'paused', n: 5_000 });
    expect(chats().length).toBeLessThanOrEqual(t.config.limits.aiConcurrency);
  }, 300_000);

  it('PUT ai-settings with a new key resumes them in the same transaction; generating goes on', async () => {
    await sql`DELETE FROM graphile_worker._private_jobs`.execute(db.kysely);
    fake.capabilities.apiKey = NEW_KEY;
    const socket = await watch();
    await settings({ api_key: { value: NEW_KEY } });
    expect(await counts()).toEqual([{ status: 'queued', reason: null, n: 5_000 }]);
    expect(await aiJobs()).toEqual([`ai.generate:${note.id}`, `ai.generate:${summary.id}`].sort());
    expect(await socket.next(aiStateOf(summary.id))).toMatchObject({
      ai_state: { queued: BULK_RECORDS, paused: 0, paused_reason: null, paused_detail: null },
    });
    const outcome = await generator().runBatch(scope(), note.id, recomputeJobBatchId(1));
    expect(outcome).toMatchObject({ status: 'more', written: 20, calls: 20 });
    expect(chats()).toHaveLength(20);
    expect(chats().every((chat) => chat.headers.authorization === `Bearer ${NEW_KEY}`)).toBe(true);
    await clearQueue();
  }, 300_000);

  it('a new value of the key in use (PATCH /secrets/:id) resumes them too; another secret does not', async () => {
    const saved = await settings({});
    const secretId = saved.api_key?.secret_id;
    if (secretId === undefined) throw new Error('no key');
    fake.capabilities.apiKey = NEWER_KEY;
    await generate(note.id, { scope: 'records', record_ids: records.slice(0, 3) });
    await drain(note.id);
    expect(chats()).toHaveLength(1);
    expect((await rows(note.id)).map((row) => row.reason)).toEqual(
      Array.from({ length: 3 }, () => 'provider_error:unauthorized'),
    );
    const header = await fx.call('owner', 'POST', `/orgs/${fx.orgId}/secrets`, {
      kind: 'http_header',
      name: 'Other header',
      value: 'x',
      allowed_hosts: ['api.example.test'],
    });
    expect(header.statusCode, header.body).toBe(201);
    const otherId = header.json<{ id: Id<'sec'> }>().id;
    const unrelated = await fx.call('owner', 'PATCH', `/secrets/${otherId}`, { value: 'y' });
    expect(unrelated.statusCode, unrelated.body).toBe(200);
    expect((await rows(note.id)).every((row) => row.status === 'paused')).toBe(true);
    const replaced = await fx.call('owner', 'PATCH', `/secrets/${secretId}`, { value: NEWER_KEY });
    expect(replaced.statusCode, replaced.body).toBe(200);
    expect((await rows(note.id)).map((row) => row.status)).toEqual(['queued', 'queued', 'queued']);
    expect(await aiJobs()).toContain(`ai.generate:${note.id}`);
    await drain(note.id);
    expect(await rows(note.id)).toEqual([]);
    expect(chats()).toHaveLength(4);
    await clearQueue();
  });

  it('a provider URL outside the allowlist: ssrf_blocked, 0 calls; saving the URL back resumes', async () => {
    await settings({ provider_base_url: other.baseUrl, api_key: null });
    await generate(note.id, { scope: 'records', record_ids: records.slice(0, 5) });
    await generate(summary.id, { scope: 'records', record_ids: records.slice(0, 5) });
    const [outcome] = await drain(note.id);
    expect(outcome).toMatchObject({
      status: 'paused',
      pausedReason: 'provider_error',
      pausedDetail: 'ssrf_blocked',
    });
    expect(chats(other)).toEqual([]);
    expect(chats()).toEqual([]);
    // The whole organization: the other field's rows are paused too, before any batch of it.
    expect((await field(summary.id)).ai_state).toMatchObject({
      paused: 5,
      paused_reason: 'provider_error',
      paused_detail: 'ssrf_blocked',
    });
    expect(await drain(summary.id)).toMatchObject([{ status: 'done', calls: 0 }]);
    expect(chats(other)).toEqual([]);

    // A key bound to the first provider's host is not sent to another host.
    await settings({ provider_base_url: fake.baseUrl, api_key: { value: NEWER_KEY } });
    expect((await rows(note.id)).every((row) => row.status === 'queued')).toBe(true);
    await sql`UPDATE meta.secrets SET allowed_hosts = ARRAY['api.example.test']
               WHERE organization_id = ${fx.orgId} AND kind = 'ai_api_key'`.execute(db.kysely);
    expect(await drain(note.id)).toMatchObject([
      { status: 'paused', pausedReason: 'provider_error', pausedDetail: 'secret_host_not_allowed' },
    ]);
    expect(chats()).toEqual([]);
    expect((await field(note.id)).ai_state?.paused_detail).toBe('secret_host_not_allowed');
    await settings({ api_key: { value: NEWER_KEY } });
    await drain(note.id);
    await drain(summary.id);
    expect(chats()).toHaveLength(10);
    expect(await counts()).toEqual([]);
  });

  it('429 with Retry-After: 30 backs the organization off — tries unchanged, retry_at, goes on after 30 s', async () => {
    clock = new Date();
    const start = clock;
    await generate(note.id, { scope: 'records', record_ids: records.slice(10, 13) });
    await generate(summary.id, { scope: 'records', record_ids: records.slice(10, 12) });
    fake.script({ status: 429, headers: { 'retry-after': '30' } });
    const [outcome] = await drain(note.id);
    const until = new Date(start.getTime() + 30_000);
    expect(outcome).toMatchObject({ status: 'done', calls: 1, backOffUntil: until });
    expect(outcome?.nextRunAt?.getTime()).toBe(until.getTime());
    expect(chats()).toHaveLength(1);
    for (const id of [note.id, summary.id]) {
      const left = await rows(id);
      expect(left.every((row) => row.status === 'queued' && row.attempts === 0)).toBe(true);
      expect((await field(id)).ai_state).toMatchObject({
        queued: left.length,
        paused: 0,
        retry_at: until.toISOString(),
      });
    }
    expect((await cell(records[10] ?? 'rec_x'))?.meta?.ai?.[note.id]).toEqual({ state: 'queued' });

    // 10 s later: no row of the organization is taken, a row queued meanwhile neither.
    clock = new Date(start.getTime() + 10_000);
    await generate(headline.id, { scope: 'records', record_ids: records.slice(20, 21) });
    for (const id of [note.id, summary.id, headline.id]) {
      expect(await drain(id)).toMatchObject([{ status: 'done', calls: 0, rows: 0 }]);
    }
    const due = await queue().dueFields(scope(), clock);
    expect(due.map((item) => item.dueAt.getTime())).toEqual([until, until, until].map(Number));
    expect(chats()).toHaveLength(1);

    // After 30 s: the rows go on with their tries intact.
    clock = new Date(start.getTime() + 31_000);
    expect(await drain(note.id)).toMatchObject([{ written: 3, calls: 3 }]);
    await drain(summary.id);
    await drain(headline.id);
    expect(chats()).toHaveLength(7);
    expect(await counts()).toEqual([]);
    expect((await field(note.id)).ai_state?.retry_at).toBeNull();
  });

  it('a 429 without Retry-After waits 60 s; five 503s in a row back off; a success resets the count', async () => {
    clock = new Date();
    const start = clock;
    fake.script({ status: 429 });
    await generate(note.id, { scope: 'records', record_ids: records.slice(30, 31) });
    expect(await drain(note.id)).toMatchObject([
      { backOffUntil: new Date(start.getTime() + AI_FIELD_BACKOFF_MS) },
    ]);
    clock = new Date(start.getTime() + AI_FIELD_BACKOFF_MS + 1_000);
    await drain(note.id);
    expect(await counts()).toEqual([]);

    // 503, 503, ok, 503 × 5: the breaker opens after the fifth in a row, not after the sixth error.
    fake.requests.length = 0;
    const failure = { status: 503 };
    fake.script(failure, failure, {}, failure, failure, failure, failure, failure);
    await generate(note.id, { scope: 'records', record_ids: records.slice(40, 50) });
    const batchAt = clock;
    const [outcome] = await drain(note.id);
    expect(outcome).toMatchObject({
      status: 'done',
      calls: 8,
      written: 1,
      backOffUntil: new Date(batchAt.getTime() + AI_FIELD_BACKOFF_MS),
    });
    const left = await rows(note.id);
    expect(left).toHaveLength(9);
    // Seven rows were tried (one try each), the last two were not.
    expect(left.map((row) => row.attempts).sort()).toEqual([0, 0, 1, 1, 1, 1, 1, 1, 1]);
    expect(left.every((row) => row.status === 'queued')).toBe(true);
    expect((await field(note.id)).ai_state?.retry_at).toBe(
      new Date(batchAt.getTime() + AI_FIELD_BACKOFF_MS).toISOString(),
    );
    clock = new Date(batchAt.getTime() + 30_000);
    expect(await drain(note.id)).toMatchObject([{ calls: 0 }]);
    clock = new Date(batchAt.getTime() + AI_FIELD_BACKOFF_MS + 1_000);
    expect(await drain(note.id)).toMatchObject([{ written: 9, calls: 9 }]);
    expect(await counts()).toEqual([]);
  });

  it('scope: paused queues only the paused cells of the field, never empty cells that never ran', async () => {
    clock = new Date();
    fake.capabilities.apiKey = 'sk-test-not-a-real-key-revoked';
    await generate(note.id, { scope: 'records', record_ids: records.slice(60, 64) });
    await generate(summary.id, { scope: 'records', record_ids: records.slice(60, 62) });
    await drain(note.id);
    expect((await rows(note.id)).map((row) => row.status)).toEqual(Array(4).fill('paused'));
    // Hundreds of cells of the field are empty and never ran: "Resume" leaves them alone.
    fake.capabilities.apiKey = NEWER_KEY;
    const resumed = await generate(note.id, { scope: 'paused' });
    expect(resumed.rows).toBe(4);
    expect((await rows(note.id)).map((row) => [row.record_id, row.status])).toEqual(
      records
        .slice(60, 64)
        .sort()
        .map((id) => [id, 'queued']),
    );
    // Another field's paused rows stay paused.
    expect((await rows(summary.id)).map((row) => row.status)).toEqual(['paused', 'paused']);
    const job = await fx.call('u_admin', 'GET', `/jobs/${resumed.job_id}`);
    expect(job.json()).toMatchObject({ status: 'running', result: { rows: 4 } });
    await drain(note.id);
    expect(await rows(note.id)).toEqual([]);
    expect((await fx.call('u_admin', 'GET', `/jobs/${resumed.job_id}`)).json()).toMatchObject({
      status: 'succeeded',
    });
    // Nothing paused: nothing to queue.
    expect((await generate(note.id, { scope: 'paused' })).rows).toBe(0);
    expectProblem(
      await fx.call('u_admin', 'POST', `/fields/${note.id}/ai/generate`, {
        scope: 'paused',
        record_ids: [records[0]],
      }),
      422,
      'VALIDATION_FAILED',
    );
    await clearQueue();
  });

  it('refused and truncated answers fail with their own reason in record.meta.ai; a locked reader sees none', async () => {
    const [first, second] = records.slice(70, 72).sort() as [Id<'rec'>, Id<'rec'>];
    fake.script({ content: null, refusal: 'I cannot help with that.' }, { finishReason: 'length' });
    await generate(note.id, { scope: 'records', record_ids: [first, second] });
    expect(await drain(note.id)).toMatchObject([{ failed: 2, calls: 2 }]);
    expect((await cell(first))?.meta?.ai?.[note.id]).toEqual({
      state: 'failed',
      reason: 'refused',
    });
    expect((await cell(second))?.meta?.ai?.[note.id]).toEqual({
      state: 'failed',
      reason: 'truncated',
    });
    expect((await rows(note.id)).map((row) => row.reason)).toEqual(['refused', 'truncated']);
    // u_sales1 reads these records (their owner) but not `cost`: the AI field is locked for them.
    const locked = await cell(first, 'u_sales1');
    expect(locked?.fields).toHaveProperty(note.id, null);
    expect(locked?.meta?.ai).toBeUndefined();
    await clearQueue();
  });
});
