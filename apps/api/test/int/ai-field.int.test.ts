import {
  aiFieldGenerateSchema,
  aiFieldPreviewSchema,
  fieldSchema,
  type FieldDto,
  type Id,
  type RealtimeServerMessage,
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
  type AiBatchOutcome,
  type Db,
} from '@cellhive/server-core';
import { startFakeOpenAiServer, type FakeOpenAiServer } from '@cellhive/server-core/testing';
import { buildTaskList, createWorker, type WorkerHandle } from '@cellhive/worker';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ApiRateLimits } from '../../src/common/rate-limit/api-rate-limits.js';
import { AiAccess } from '../../src/modules/ai/ai-access.js';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { closeSockets, listen, TestSocket } from './realtime-support.js';
import { expectProblem, buildRecordFixture, type RecordFixture } from './record-fixture.js';
import { captureLogger, startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

const DAY_MS = 86_400_000;
const PROMPT = 'Tóm tắt {{ [title] }} — chi phí {{ [cost] }}';
const LOCALHOST = () => Promise.resolve(['127.0.0.1']);

/**
 * BACKLOG T910 (CONTRACTS §29.5, ADR-39 §7): AI fields against the fake
 * provider — `options.ai` saved only with AI and record data on (P85),
 * prompts stored with ids, read-only cells (P87), the 5-record preview that
 * writes nothing, generation in the background (one audit per batch,
 * `via.ai_field_id`, history), `auto_update` through the one door of
 * computed changes (five edits → one call), always-strict values (P86),
 * pauses on quota and record data with their rescue (P88, P85), a dead
 * worker's lease, a select answer outside the options, removing
 * `options.ai`, `404`/`403` before anything about AI (P80, P81), and the AI
 * runner of the worker. Every case checks what the provider received.
 */
describe('AI fields (T910)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let fake: FakeOpenAiServer;
  let note: FieldDto;
  let clock = new Date();
  const records = {} as Record<'r1' | 'r2' | 'r3', Id<'rec'>>;
  /** The id of a fixture field. */
  const fld = (name: string): Id<'fld'> => {
    const field = fx.fld[name];
    if (field === undefined) throw new Error(`no fixture field ${name}`);
    return field.id;
  };
  /** The id of the `index`-th record of a create response. */
  const createdId = (response: LightMyRequestResponse, index = 0): Id<'rec'> => {
    const id = response.json<{ records: { id: Id<'rec'> }[] }>().records[index]?.id;
    if (id === undefined) throw new Error('no record created');
    return id;
  };

  const chats = () => fake.chatRequests();
  const sockets: TestSocket[] = [];
  const waitFor = async (check: () => Promise<boolean>, what: string, ms = 60_000) => {
    const deadline = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const queue = () => new AiGenerationQueueRepository(db);
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
  const drain = async (fieldId: Id<'fld'> = note.id): Promise<AiBatchOutcome[]> => {
    const outcomes: AiBatchOutcome[] = [];
    for (let run = 1; run < 50; run += 1) {
      const outcome = await generator().runBatch(
        orgScope(fx.orgId),
        fieldId,
        recomputeJobBatchId(run),
      );
      outcomes.push(outcome);
      if (outcome.status !== 'more') return outcomes;
    }
    throw new Error('the queue never drained');
  };
  const settings = (body: Record<string, unknown>) =>
    fx.call('owner', 'PUT', `/orgs/${fx.orgId}/ai-settings`, body);
  const recordData = async (on: boolean) => {
    const response = await settings(
      on ? { allow_record_data: true, confirm: true } : { allow_record_data: false },
    );
    expect(response.statusCode, response.body).toBe(200);
  };
  const cell = async (
    recordId: Id<'rec'>,
    user: Parameters<RecordFixture['call']>[0] = 'u_admin',
  ) => {
    const response = await fx.call(
      user,
      'POST',
      `/tables/${fx.orders.id}/records/query?field_key_type=id`,
      { ids: [recordId] },
    );
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{
      records: { fields: Record<string, unknown>; meta?: { ai?: Record<string, string> } }[];
    }>().records[0];
  };
  const patchRecord = (
    recordId: Id<'rec'>,
    fields: Record<string, unknown>,
    user: Parameters<RecordFixture['call']>[0] = 'u_admin',
  ) =>
    fx.call(user, 'PATCH', `/tables/${fx.orders.id}/records`, {
      records: [{ id: recordId, fields }],
    });
  const queued = () => queue().recordIdsOf(orgScope(fx.orgId), note.id, 'queued');
  const running = async () =>
    (await queue().recordIdsOf(orgScope(fx.orgId), note.id, 'running')).length;

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url }, { outboundLookup: LOCALHOST });
    fx = await buildRecordFixture(t, db);
    t.app.get(ApiRateLimits).ai = { limit: 10_000, windowSeconds: 60 };
    t.app.get(AiAccess).now = () => clock;
    fake = await startFakeOpenAiServer();
    const entry = await fx.call('owner', 'POST', `/orgs/${fx.orgId}/http-allowlist`, {
      pattern: `localhost:${String(fake.port)}`,
    });
    expect(entry.statusCode, entry.body).toBe(201);
    for (const [key, title, cost, owner] of [
      ['r1', 'Máy POS lỗi in', 100, fx.users.u_sales1.id],
      ['r2', 'Wifi chập chờn', 200, fx.users.u_sales2.id],
      ['r3', 'Đổi máy in', 300, null],
    ] as const) {
      const created = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/records`, {
        records: [
          {
            fields: { title, cost, amount: cost * 2, owner: owner === null ? [] : [{ id: owner }] },
          },
        ],
      });
      expect(created.statusCode, created.body).toBe(201);
      records[key] = createdId(created);
    }
  }, 120_000);

  afterAll(async () => {
    await closeSockets(sockets);
    await fake.close();
    await t.close();
    await db.destroy();
    await database.drop();
  });

  beforeEach(() => {
    fake.requests.length = 0;
  });

  const createNote = () =>
    fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
      name: 'ai_note',
      type: 'text',
      options: { ai: { task: 'summarize', prompt: PROMPT } },
    });

  it('P84, P85: AI off, then record data off — 422 before any provider call', async () => {
    expectProblem(await createNote(), 422, 'AI_NOT_CONFIGURED');
    const configured = await settings({
      enabled: true,
      provider_base_url: fake.baseUrl,
      model: 'fake-model',
    });
    expect(configured.statusCode, configured.body).toBe(200);
    expectProblem(await createNote(), 422, 'AI_RECORD_DATA_DISABLED');
    expectProblem(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/ai/field-preview`, {
        ai: { task: 'summarize', prompt: PROMPT },
      }),
      422,
      'AI_RECORD_DATA_DISABLED',
    );
    expect(fake.requests).toEqual([]);
  });

  it('saves an AI field: prompt stored with ids, shown with names; no value generated yet', async () => {
    await recordData(true);
    const created = await createNote();
    expect(created.statusCode, created.body).toBe(201);
    note = fieldSchema.parse(created.json());
    expect(note.options['ai']).toEqual({
      task: 'summarize',
      prompt: PROMPT,
      instructions: null,
      auto_update: true,
      max_output_tokens: 300,
    });
    expect(note).toMatchObject({ locked: false, ai_state: { queued: 0, failed: 0, paused: 0 } });
    const stored = await sql<{ prompt: string }>`
      SELECT options -> 'ai' ->> 'prompt' AS prompt FROM meta.fields WHERE id = ${note.id}`.execute(
      db.kysely,
    );
    expect(stored.rows[0]?.prompt).toBe(
      `Tóm tắt {{ [${fld('title')}] }} — chi phí {{ [${fld('cost')}] }}`,
    );
    const edges = await sql<{ depends_on_field_id: string; kind: string }>`
      SELECT depends_on_field_id, kind FROM meta.field_dependencies
       WHERE field_id = ${note.id} ORDER BY depends_on_field_id COLLATE "C"`.execute(db.kysely);
    expect(edges.rows).toEqual(
      [fld('title'), fld('cost')]
        .sort()
        .map((id) => ({ depends_on_field_id: id, kind: 'same_row' })),
    );
    // Creating the field generates nothing for existing records (Quyết định S8 #18).
    expect(await queued()).toEqual([]);

    // Prompt checks: an unknown field, a select with several values, the primary field.
    const unknown = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
      name: 'bad',
      type: 'text',
      options: { ai: { task: 'custom', prompt: '{{ [nope] }}' } },
    });
    expectProblem(unknown, 422, 'VALIDATION_FAILED');
    expect(unknown.json<{ errors: { path: string; code: string }[] }>().errors[0]).toMatchObject({
      path: 'options.ai.prompt',
      code: 'UNKNOWN_FIELD',
    });
    const multi = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
      name: 'tags',
      type: 'select',
      options: { multiple: true, ai: { task: 'classify', prompt: '{{ [title] }}' } },
    });
    expectProblem(multi, 422, 'VALIDATION_FAILED');
    const primary = await fx.call('u_admin', 'PATCH', `/fields/${fld('title')}`, {
      options: { ai: { task: 'custom', prompt: '{{ [cost] }}' } },
    });
    expectProblem(primary, 422, 'VALIDATION_FAILED');
    // A cycle through a formula: formula reads ai_note, ai_note would read the formula.
    const formula = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
      name: 'note_length',
      type: 'formula',
      options: { expression: 'LEN([ai_note])' },
    });
    expect(formula.statusCode, formula.body).toBe(201);
    const cycle = await fx.call('u_admin', 'PATCH', `/fields/${note.id}`, {
      options: { ai: { task: 'summarize', prompt: '{{ [note_length] }}' } },
    });
    expectProblem(cycle, 422, 'FORMULA_CYCLE');
    expect(fake.requests).toEqual([]);
  });

  it('P87: AI cells are read-only for everyone', async () => {
    for (const user of ['u_admin', 'u_editor'] as const) {
      expectProblem(
        await patchRecord(records.r1, { ai_note: 'hand' }, user),
        403,
        'FIELD_READ_ONLY',
      );
    }
    expectProblem(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/records`, {
        records: [{ fields: { title: 'x', ai_note: 'hand' } }],
      }),
      403,
      'FIELD_READ_ONLY',
    );
    // An automation writing the cell is refused when saved.
    expectProblem(
      await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/automations`, {
        name: 'Overwrite the summary',
        definition: {
          trigger: { type: 'record.created', table_id: fx.orders.id },
          actions: [
            {
              id: 'act_1',
              type: 'update_record',
              config: { table_id: fx.orders.id, fields: { [note.id]: { literal: 'x' } } },
            },
          ],
        },
      }),
      422,
      'AUTOMATION_INVALID',
    );
  });

  it('P80, P81: 404 / 403 before anything about AI; the provider gets nothing', async () => {
    const preview = { ai: { task: 'summarize', prompt: PROMPT } };
    expectProblem(
      await fx.call('u_out', 'POST', `/tables/${fx.orders.id}/ai/field-preview`, preview),
      404,
      'NOT_FOUND',
    );
    expectProblem(
      await fx.call('u_reader', 'POST', `/tables/${fx.orders.id}/ai/field-preview`, preview),
      403,
      'PERMISSION_DENIED',
    );
    for (const user of ['u_reader', 'u_editor', 'u_sales1'] as const) {
      expectProblem(
        await fx.call(user, 'POST', `/fields/${note.id}/ai/generate`, { scope: 'all' }),
        403,
        'PERMISSION_DENIED',
      );
    }
    expectProblem(
      await fx.call('u_out', 'POST', `/fields/${note.id}/ai/generate`, { scope: 'all' }),
      404,
      'NOT_FOUND',
    );
    expect(fake.requests).toEqual([]);
  });

  it('previews 5 records: one call each, record values in data blocks, nothing written', async () => {
    const before = await cell(records.r1);
    const response = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/ai/field-preview`, {
      field_id: note.id,
      ai: { task: 'summarize', prompt: PROMPT },
    });
    expect(response.statusCode, response.body).toBe(200);
    const preview = aiFieldPreviewSchema.parse(response.json());
    expect(preview.items).toHaveLength(3);
    expect(preview.items[0]).toMatchObject({
      record_id: records.r1,
      input_preview: 'Tóm tắt Máy POS lỗi in — chi phí 100',
      error: null,
    });
    expect(preview.items[0]?.output).toMatch(/^fake: [0-9a-f]{12}$/u);
    expect(preview.estimate.rows).toBe(3);
    expect(preview.estimate.tokens).toBeGreaterThan(0);
    expect(chats()).toHaveLength(3);
    const user = (chats()[0]?.body?.['messages'] as { content: string }[]).at(-1)?.content ?? '';
    expect(user).toContain('<<DATA value');
    expect(user).toContain('MáyˆPOSˆlỗiˆin');
    expect(JSON.stringify(chats()[0]?.body)).not.toMatch(/rec_|fld_|tbl_/u);
    expect(await cell(records.r1)).toEqual(before);
    expect(await queued()).toEqual([]);
  });

  it('generates the empty cells in the background: values, one audit per batch, history', async () => {
    const response = await fx.call('u_admin', 'POST', `/fields/${note.id}/ai/generate`, {
      scope: 'empty',
    });
    expect(response.statusCode, response.body).toBe(202);
    const started = aiFieldGenerateSchema.parse(response.json());
    expect(started.rows).toBe(3);
    expect((await cell(records.r1))?.meta?.ai).toEqual({ [note.id]: 'queued' });

    const outcomes = await drain();
    expect(outcomes[0]).toMatchObject({ rows: 3, written: 3, failed: 0, calls: 3 });
    expect(chats()).toHaveLength(3);
    const r1 = await cell(records.r1);
    expect(r1?.fields[note.id]).toMatch(/^fake: /u);
    expect(r1?.meta?.ai).toEqual({});
    const job = await fx.call('u_admin', 'GET', `/jobs/${started.job_id}`);
    expect(job.json()).toMatchObject({ status: 'succeeded', result: { rows: 3, failed: 0 } });

    const audits = await sql<{
      entity_type: string;
      entity_id: string;
      after: Record<string, unknown>;
    }>`
      SELECT entity_type, entity_id, after FROM meta.audit_logs
       WHERE organization_id = ${fx.orgId} AND action = 'ai.requested'
         AND after ->> 'feature' = 'field' AND entity_type = 'field'`.execute(db.kysely);
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0]?.after).toMatchObject({ records: 3, attempts: 3, status: 'ok' });
    expect(audits.rows[0]?.after).not.toHaveProperty('input');
    const history = await sql<{ via: Record<string, unknown> }>`
      SELECT via FROM meta.audit_logs
       WHERE organization_id = ${fx.orgId} AND action = 'record.updated'
         AND entity_id = ${records.r1} ORDER BY created_at DESC LIMIT 1`.execute(db.kysely);
    expect(history.rows[0]?.via).toEqual({ ai_field_id: note.id });
    // Nothing left: a second generate of empty cells queues nothing.
    const again = await fx.call('u_admin', 'POST', `/fields/${note.id}/ai/generate`, {
      scope: 'empty',
    });
    expect(again.json()).toMatchObject({ rows: 0 });
  });

  it('auto_update: five edits of a source before the worker cost one call; other fields none', async () => {
    for (let index = 1; index <= 5; index += 1) {
      const edited = await patchRecord(records.r1, { title: `Máy POS lỗi in (${String(index)})` });
      expect(edited.statusCode, edited.body).toBe(200);
    }
    expect(await patchRecord(records.r2, { amount: 999 })).toMatchObject({ statusCode: 200 });
    expect(await queued()).toEqual([records.r1]);
    await drain();
    expect(chats()).toHaveLength(1);
    expect(JSON.stringify(chats()[0]?.body)).toContain('(5)');

    // A new record is queued too (auto_update).
    const created = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/records`, {
      records: [{ fields: { title: 'Mới', cost: 1 } }],
    });
    const id = createdId(created);
    expect(await queued()).toEqual([id]);
    await drain();
    expect((await cell(id))?.fields[note.id]).toMatch(/^fake: /u);
  });

  it('P86: always strict — a reader who cannot read every source gets null and locked', async () => {
    // u_sales1 reads r1 but not `cost` (Sales role); the base is not strict.
    const own = await cell(records.r1, 'u_sales1');
    expect(own?.fields).toHaveProperty(note.id, null);
    expect(own?.meta?.ai).toBeUndefined();
    const listed = await fx.call('u_sales1', 'GET', `/tables/${fx.orders.id}/fields`);
    const field = listed.json<{ items: FieldDto[] }>().items.find((item) => item.id === note.id);
    expect(field).toMatchObject({ locked: true });
    expect((field?.options['ai'] as { prompt: string }).prompt).toContain('#REF[');
    expectProblem(
      await fx.call('u_sales1', 'POST', `/tables/${fx.orders.id}/records/query`, {
        filter: { op: 'and', items: [{ field: 'ai_note', operator: 'is_not_empty' }] },
      }),
      422,
      'INVALID_FILTER',
    );
    // u_reader reads every source.
    expect((await cell(records.r1, 'u_reader'))?.fields[note.id]).toMatch(/^fake: /u);
    const forReader = await fx.call('u_reader', 'GET', `/fields/${note.id}`);
    expect(forReader.json()).toMatchObject({ locked: false });
  });

  it('P88: quota used up — rows paused, the provider gets nothing; the next day resumes', async () => {
    const zone = await sql<{ zone: string | null }>`
      SELECT settings ->> 'timezone' AS zone FROM meta.organizations WHERE id = ${fx.orgId}`.execute(
      db.kysely,
    );
    const today = quotaDayOf(clock, zone.rows[0]?.zone ?? t.config.defaults.timezone).day;
    await sql`INSERT INTO meta.ai_usage_daily (organization_id, day, feature, requests, prompt_tokens, completion_tokens)
              VALUES (${fx.orgId}, ${today}, 'test', 1, 1000000, 0)`.execute(db.kysely);
    await patchRecord(records.r2, { title: 'Wifi chập chờn (2)' });
    const [outcome] = await drain();
    expect(outcome).toMatchObject({ status: 'paused', pausedReason: 'quota', calls: 0 });
    expect(chats()).toEqual([]);
    expect((await cell(records.r2))?.meta?.ai).toEqual({ [note.id]: 'paused' });
    const field = await fx.call('u_admin', 'GET', `/fields/${note.id}`);
    expect(field.json()).toMatchObject({ ai_state: { paused: 1, paused_reason: 'quota' } });
    // Interactive requests answer 429 with the reset time.
    expectProblem(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/ai/field-preview`, {
        ai: { task: 'summarize', prompt: PROMPT },
      }),
      429,
      'AI_QUOTA_EXCEEDED',
    );

    clock = new Date(clock.getTime() + DAY_MS);
    expect(await generator().rescue(orgScope(fx.orgId))).toEqual([note.id]);
    await drain();
    expect(chats()).toHaveLength(1);
    expect((await cell(records.r2))?.meta?.ai).toEqual({});
  });

  it('P85: record data turned off — rows paused, no call; turned on — resumed', async () => {
    await recordData(false);
    await patchRecord(records.r3, { title: 'Đổi máy in (2)' });
    const [outcome] = await drain();
    expect(outcome).toMatchObject({ status: 'paused', pausedReason: 'record_data_disabled' });
    expect(chats()).toEqual([]);
    expect(await generator().rescue(orgScope(fx.orgId))).toEqual([]);
    await recordData(true);
    expect(await generator().rescue(orgScope(fx.orgId))).toEqual([note.id]);
    await drain();
    expect(chats()).toHaveLength(1);

    // Turned off during a batch: the call in flight ends, no call after it.
    fake.requests.length = 0;
    for (const id of [records.r1, records.r2, records.r3]) {
      await patchRecord(id, { cost: 7 });
    }
    expect(await queued()).toHaveLength(3);
    fake.capabilities.delayMs = 500;
    try {
      const batch = drain();
      await waitFor(() => Promise.resolve(chats().length === 1), 'the first call');
      await recordData(false);
      const outcomes = await batch;
      expect(chats()).toHaveLength(1);
      expect(outcomes.at(-1)).toMatchObject({
        status: 'paused',
        pausedReason: 'record_data_disabled',
      });
    } finally {
      fake.capabilities.delayMs = 0;
    }
    await recordData(true);
    await generator().rescue(orgScope(fx.orgId));
    await drain();
    expect(await queued()).toEqual([]);
  });

  it('gives the rows of a dead worker back (lease past its end) and requeues their job', async () => {
    await patchRecord(records.r3, { title: 'Đổi máy in (3)' });
    await sql`UPDATE meta.ai_generation_queue SET status = 'running', lease_until = now() - interval '1 minute'
               WHERE field_id = ${note.id}`.execute(db.kysely);
    await sql`DELETE FROM graphile_worker._private_jobs`.execute(db.kysely);
    await generator().rescue(orgScope(fx.orgId));
    expect(await queued()).toEqual([records.r3]);
    const jobs = await sql<{ key: string }>`
      SELECT key FROM graphile_worker.jobs WHERE task_identifier = 'ai.generate'`.execute(
      db.kysely,
    );
    expect(jobs.rows).toEqual([{ key: `ai.generate:${note.id}` }]);
    await drain();
  });

  it('a select answer outside the options fails (invalid_output) and writes nothing', async () => {
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
    const generate = async (recordId: Id<'rec'>) => {
      const generated = await fx.call('u_admin', 'POST', `/fields/${level.id}/ai/generate`, {
        scope: 'records',
        record_ids: [recordId],
      });
      expect(generated.statusCode, generated.body).toBe(202);
      await drain(level.id);
    };
    // The answer and both repair rounds name an option that does not exist.
    const outside = { content: JSON.stringify({ option: 'Khẩn' }) };
    fake.script(outside, outside, outside);
    await generate(records.r1);
    fake.script({ content: JSON.stringify({ option: 'Cao' }) });
    await generate(records.r2);
    expect(chats()).toHaveLength(4);
    expect(chats()[0]?.body?.['response_format']).toMatchObject({
      type: 'json_schema',
      json_schema: { schema: { properties: { option: { enum: ['Thấp', 'Cao'] } } } },
    });
    expect((await cell(records.r1))?.fields[level.id]).toBeNull();
    expect((await cell(records.r1))?.meta?.ai).toMatchObject({ [level.id]: 'failed' });
    expect((await cell(records.r2))?.fields[level.id]).toBe('Cao');
    expect(await queue().recordIdsOf(orgScope(fx.orgId), level.id, 'failed')).toEqual([records.r1]);
    // Text is stored as text: markup is never interpreted here.
    fake.script({ content: '<img src="https://example.test/x.png"> xong' });
    await fx.call('u_admin', 'POST', `/fields/${note.id}/ai/generate`, {
      scope: 'records',
      record_ids: [records.r1],
    });
    await drain();
    expect((await cell(records.r1))?.fields[note.id]).toBe(
      '<img src="https://example.test/x.png"> xong',
    );
  });

  it('removing options.ai leaves a plain field: values kept, queue cleared, writable', async () => {
    await patchRecord(records.r2, { title: 'Wifi chập chờn (3)' });
    expect(await queued()).toEqual([records.r2]);
    const value = (await cell(records.r1))?.fields[note.id];
    const patched = await fx.call('u_admin', 'PATCH', `/fields/${note.id}`, {
      options: { ai: null },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json<FieldDto>().options['ai']).toBeNull();
    expect(await queued()).toEqual([]);
    expect((await cell(records.r1))?.fields[note.id]).toBe(value);
    expect((await patchRecord(records.r1, { ai_note: 'by hand' })).statusCode).toBe(200);
    // Back to an AI field (the value stays until generated again).
    const back = await fx.call('u_admin', 'PATCH', `/fields/${note.id}`, {
      options: { ai: { task: 'summarize', prompt: PROMPT } },
    });
    expect(back.statusCode, back.body).toBe(200);
    expectProblem(await patchRecord(records.r1, { ai_note: 'again' }), 403, 'FIELD_READ_ONLY');
  });

  const addField = async (body: Record<string, unknown>): Promise<FieldDto> => {
    const created = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, body);
    expect(created.statusCode, created.body).toBe(201);
    return fieldSchema.parse(created.json());
  };

  it('a formula of the prompt reading a field hidden from the reader locks the AI field (base not strict)', async () => {
    // `title_cost` reads `cost`, hidden from u_sales1; the base is not strict, so the
    // formula itself shows to them — its summary must not.
    const formula = await addField({
      name: 'title_cost',
      type: 'formula',
      options: { expression: '[title] & " " & [cost]' },
    });
    const summary = await addField({
      name: 'ai_title_cost',
      type: 'text',
      options: { ai: { task: 'summarize', prompt: '{{ [title_cost] }}', auto_update: false } },
    });
    // Realtime: the value reaches u_admin, never u_sales1.
    const url = await listen(t.app);
    const watch = async (user: 'u_admin' | 'u_sales1') => {
      const socket = await TestSocket.connect(url, {
        origin: TEST_PUBLIC_URL,
        cookie: await fx.cookie(user),
      });
      sockets.push(socket);
      expect(await socket.subscribe(`table:${fx.orders.id}`, 's1')).toMatchObject({
        type: 'subscribed',
      });
      return socket;
    };
    const adminSocket = await watch('u_admin');
    const salesSocket = await watch('u_sales1');
    const carriesSummary = (message: RealtimeServerMessage) =>
      message.type === 'record.updated' &&
      message.record_id === records.r1 &&
      Object.hasOwn(message.fields, summary.id);

    const generated = await fx.call('u_admin', 'POST', `/fields/${summary.id}/ai/generate`, {
      scope: 'records',
      record_ids: [records.r1],
    });
    expect(generated.statusCode, generated.body).toBe(202);
    await drain(summary.id);
    expect((await cell(records.r1))?.fields[summary.id]).toMatch(/^fake: /u);
    await adminSocket.next(carriesSummary);
    await salesSocket.expectNone(carriesSummary);

    const own = await cell(records.r1, 'u_sales1');
    // The formula is visible to u_sales1 (only `cost` is hidden): the lock comes from `cost`.
    expect(own?.fields).toHaveProperty(formula.id);
    expect(own?.fields).toHaveProperty(summary.id, null);
    const field = await fx.call('u_sales1', 'GET', `/fields/${summary.id}`);
    expect(field.json()).toMatchObject({ locked: true });
    const history = await fx.call(
      'u_sales1',
      'GET',
      `/tables/${fx.orders.id}/records/${records.r1}/history?field_key_type=id`,
    );
    expect(history.statusCode, history.body).toBe(200);
    expect(history.body).not.toContain(summary.id);
    const forAdmin = await fx.call(
      'u_admin',
      'GET',
      `/tables/${fx.orders.id}/records/${records.r1}/history?field_key_type=id`,
    );
    expect(forAdmin.body).toContain(summary.id);
  });

  it('refuses a prompt reading a formula over a lookup; a source edited later fails the row', async () => {
    const link = await addField({
      name: 'customer',
      type: 'link',
      options: { link_table: fx.customers.id },
    });
    await addField({
      name: 'customer_name',
      type: 'lookup',
      options: {
        from: fx.customers.id,
        select: fld('customerName'),
        where: { field: '__id', operator: 'is_any_of', value: { field_ref: link.id } },
      },
    });
    await addField({
      name: 'customer_upper',
      type: 'formula',
      options: { expression: 'UPPER(ARRAYJOIN([customer_name]))' },
    });
    const refused = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
      name: 'ai_customer',
      type: 'text',
      options: { ai: { task: 'summarize', prompt: 'About {{ [customer_upper] }}' } },
    });
    expectProblem(refused, 422, 'VALIDATION_FAILED');
    const errors = refused.json<{ errors: { path: string; code: string; params: object }[] }>()
      .errors;
    expect(errors.map(({ path, code }) => ({ path, code }))).toEqual([
      { path: 'options.ai.prompt', code: 'CROSS_TABLE_NOT_SUPPORTED' },
    ]);
    expect(errors[0]?.params).toEqual({ position: { start: 6, length: 22 } });

    // A same-record formula, edited after the AI field was saved to read another table.
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
    const edited = await fx.call('u_admin', 'PATCH', `/fields/${upper.id}`, {
      options: { expression: 'UPPER([customer_upper])' },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    await fx.call('u_admin', 'POST', `/fields/${field.id}/ai/generate`, {
      scope: 'records',
      record_ids: [records.r1],
    });
    await drain(field.id);
    expect(chats()).toEqual([]);
    expect(await queue().recordIdsOf(orgScope(fx.orgId), field.id, 'failed')).toEqual([records.r1]);
    const reason = await sql<{ reason: string }>`
      SELECT reason FROM meta.ai_generation_queue WHERE field_id = ${field.id}`.execute(db.kysely);
    expect(reason.rows).toEqual([{ reason: 'render_error' }]);
    expect((await cell(records.r1))?.fields[field.id]).toBeNull();
  });

  it('the worker runs ai.* on its own runner: 500 queued rows never delay events.dispatch', async () => {
    const { logger } = captureLogger();
    let worker: WorkerHandle | undefined;
    try {
      const taskList = buildTaskList({
        config: t.config,
        db,
        logger,
        ai: { lookup: LOCALHOST, now: () => clock },
      });
      worker = await createWorker(t.config, {
        logger,
        pollIntervalMs: 50,
        taskList: Object.fromEntries(
          Object.entries(taskList).filter(
            ([name]) => name.startsWith('ai.') || name === 'events.dispatch',
          ),
        ),
      });
      // Every call takes 5 s: the AI runner (AI_CONCURRENCY 2) is busy for minutes.
      fake.capabilities.delayMs = 5_000;
      const since = (await sql<{ now: Date }>`SELECT now() AS now`.execute(db.kysely)).rows[0]?.now;
      const created = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/records`, {
        records: Array.from({ length: 500 }, (_, index) => ({
          fields: { title: `Import ${String(index)}`, cost: index },
        })),
      });
      expect(created.statusCode, created.body).toBe(201);
      expect((await queued()).length + (await running())).toBe(500);
      await waitFor(() => Promise.resolve(chats().length > 0), 'the first AI call');
      // The 500 record.created events are dispatched while the AI runner is busy …
      await waitFor(async () => {
        const { rows } = await sql<{ n: number }>`
          SELECT count(*)::int AS n FROM meta.events
           WHERE organization_id = ${fx.orgId} AND dispatched_at IS NULL
             AND created_at >= ${since}`.execute(db.kysely);
        return rows[0]?.n === 0;
      }, 'the dispatch of the import');
      expect(chats().length).toBeLessThan(500);
      // … and a record of another table: its event is dispatched at once by the main runner.
      const customer = await fx.call('u_admin', 'POST', `/tables/${fx.customers.id}/records`, {
        records: [{ fields: { Tên: 'An Phát' } }],
      });
      expect(customer.statusCode, customer.body).toBe(201);
      const customerId = createdId(customer);
      let latency = Number.POSITIVE_INFINITY;
      await waitFor(async () => {
        const { rows } = await sql<{ ms: number | null }>`
          SELECT (extract(epoch FROM dispatched_at - created_at) * 1000)::float8 AS ms FROM meta.events
           WHERE organization_id = ${fx.orgId} AND entity_id = ${customerId}`.execute(db.kysely);
        if (rows[0]?.ms == null) return false;
        latency = rows[0].ms;
        return true;
      }, 'events.dispatch');
      // About the poll interval when the machine is idle (< 1 s); a full parallel test run adds
      // its own load. Waiting for an AI slot would take a whole call (5 s).
      expect(latency).toBeLessThan(2_500);
      // Faster answers: the AI runner drains the queue on its own.
      fake.capabilities.delayMs = 0;
      await waitFor(
        async () => (await queued()).length + (await running()) === 0,
        'the AI queue',
        120_000,
      );
      expect((await cell(createdId(created, 499)))?.fields[note.id]).toMatch(/^fake: /u);
    } finally {
      fake.capabilities.delayMs = 0;
      await worker?.close();
    }
  }, 180_000);
});
