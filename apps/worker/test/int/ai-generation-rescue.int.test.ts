import {
  aiGenerateJobKey,
  enqueueAiGeneration,
  listAiGenerationRescueOrganizations,
  type Db,
} from '@cellhive/server-core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildTaskList, createAiGenerationRescueTask } from '../../src/tasks/index.js';

import {
  captureLogger,
  createMigratedDatabase,
  createTestDb,
  testConfig,
  type TestDatabase,
} from './support.js';

import type { Id } from '@cellhive/contracts';
import type { JobHelpers } from 'graphile-worker';

const ORGS = 250;
/** Organizations 1–210: AI off for good (off, never set up, or record data off). */
const AI_OFF = 210;
const USER: Id<'usr'> = 'usr_RescueL18Owner01';

const pad = (n: number) => String(n).padStart(12, '0');
const orgOf = (n: number): Id<'org'> => `org_Resc${pad(n)}`;
const fieldOf = (n: number): Id<'fld'> => `fld_Resc${pad(n)}`;

/**
 * BACKLOG T1003 (L18) with the worker's own task list: the per-minute cron
 * `ai.generation_rescue` lists only organizations whose queue can move now
 * and goes on after the last one it saw. 250 organizations, 210 of them
 * with AI off for good (paused rows, a lost job, an expired lease each);
 * 39 with AI on whose rows cannot run now (the provider rejected the key,
 * the quota of today is used up, a job is waiting); the 250th has a lease
 * past its end — rescued within two runs.
 */
describe('worker: ai.generation_rescue (T1003)', () => {
  let database: TestDatabase;
  let db: Db;
  const captured = captureLogger();
  const now = new Date();
  let run: () => Promise<void>;

  const statusOf = async (n: number) =>
    (
      await sql<{ status: string; reason: string | null }>`
        SELECT status, reason FROM meta.ai_generation_queue
         WHERE field_id = ${fieldOf(n)} ORDER BY record_id`.execute(db.kysely)
    ).rows;
  const jobKeys = async () =>
    (
      await sql<{ key: string }>`
        SELECT key FROM graphile_worker.jobs WHERE task_identifier = 'ai.generate' ORDER BY key`.execute(
        db.kysely,
      )
    ).rows.map((row) => row.key);
  const runs = () =>
    captured.lines.filter((line) => line['msg'] === 'ai.generation_rescue') as {
      organizations: number;
    }[];

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    const day = now.toISOString().slice(0, 10);
    await db.withTx(async (tx) => {
      await sql`INSERT INTO meta.users (id, email, display_name)
                VALUES (${USER}, 'rescue-l18@example.test', 'Owner')`.execute(tx);
      // One organization, workspace, base, table and AI field each.
      await sql`
        INSERT INTO meta.organizations (id, name, slug)
        SELECT 'org_Resc' || lpad(i::text, 12, '0'), 'Org ' || i, 'resc-' || i
          FROM generate_series(1, ${ORGS}) AS i`.execute(tx);
      await sql`
        INSERT INTO meta.workspaces (id, organization_id, name, slug)
        SELECT 'wsp_Resc' || lpad(i::text, 12, '0'), 'org_Resc' || lpad(i::text, 12, '0'), 'Main', 'main'
          FROM generate_series(1, ${ORGS}) AS i`.execute(tx);
      await sql`
        INSERT INTO meta.bases (id, organization_id, workspace_id, owner_id, name)
        SELECT 'bse_Resc' || lpad(i::text, 12, '0'), 'org_Resc' || lpad(i::text, 12, '0'),
               'wsp_Resc' || lpad(i::text, 12, '0'), ${USER}, 'Base'
          FROM generate_series(1, ${ORGS}) AS i`.execute(tx);
      await sql`
        INSERT INTO meta.tables (id, organization_id, base_id, name, db_table_name, "collation")
        SELECT 'tbl_Resc' || lpad(i::text, 12, '0'), 'org_Resc' || lpad(i::text, 12, '0'),
               'bse_Resc' || lpad(i::text, 12, '0'), 'Tickets', 't_resc' || lpad(i::text, 8, '0'),
               'und-x-icu'
          FROM generate_series(1, ${ORGS}) AS i`.execute(tx);
      await sql`
        INSERT INTO meta.fields (id, organization_id, table_id, name, type, options)
        SELECT 'fld_Resc' || lpad(i::text, 12, '0'), 'org_Resc' || lpad(i::text, 12, '0'),
               'tbl_Resc' || lpad(i::text, 12, '0'), 'Summary', 'text',
               '{"ai": {"task": "summarize", "prompt": "{{ [Title] }}"}}'::jsonb
          FROM generate_series(1, ${ORGS}) AS i`.execute(tx);
      // AI off for good: turned off (1–70), never set up (71–140), record data off (141–210).
      await sql`
        INSERT INTO meta.ai_settings (organization_id, enabled, provider_base_url, model, allow_record_data)
        SELECT 'org_Resc' || lpad(i::text, 12, '0'), i > 140, 'https://ai.example.test/v1', 'm', false
          FROM generate_series(1, 210) AS i WHERE i <= 70 OR i > 140`.execute(tx);
      // Each: a paused row, a queued row without a job, a lease past its end.
      await sql`
        INSERT INTO meta.ai_generation_queue (organization_id, field_id, record_id, status, reason, lease_until)
        SELECT 'org_Resc' || lpad(i::text, 12, '0'), 'fld_Resc' || lpad(i::text, 12, '0'),
               'rec_Resc' || lpad(i::text, 10, '0') || r.suffix, r.status, r.reason,
               CASE WHEN r.status = 'running' THEN now() - interval '1 minute' END
          FROM generate_series(1, 210) AS i,
               (VALUES ('01', 'paused', 'ai_disabled'), ('02', 'queued', NULL),
                       ('03', 'running', NULL)) AS r(suffix, status, reason)`.execute(tx);
      // AI on, nothing to do now: the key rejected (211–223), today's quota used up (224–236),
      // a job waiting for its rows (237–249).
      await sql`
        INSERT INTO meta.ai_settings (organization_id, enabled, provider_base_url, model,
                                      allow_record_data, daily_token_limit)
        SELECT 'org_Resc' || lpad(i::text, 12, '0'), true, 'https://ai.example.test/v1', 'm', true,
               10000
          FROM generate_series(211, ${ORGS}) AS i`.execute(tx);
      await sql`
        INSERT INTO meta.ai_usage_daily (organization_id, day, feature, requests, prompt_tokens)
        SELECT 'org_Resc' || lpad(i::text, 12, '0'), ${day}::date, 'field', 1, 20000
          FROM generate_series(224, 236) AS i`.execute(tx);
      await sql`
        INSERT INTO meta.ai_generation_queue (organization_id, field_id, record_id, status, reason, lease_until)
        SELECT 'org_Resc' || lpad(i::text, 12, '0'), 'fld_Resc' || lpad(i::text, 12, '0'),
               'rec_Resc' || lpad(i::text, 10, '0') || '01',
               CASE WHEN i <= 236 THEN 'paused' ELSE 'queued' END,
               CASE WHEN i <= 223 THEN 'provider_error:unauthorized'
                    WHEN i <= 236 THEN 'quota' END,
               NULL
          FROM generate_series(211, 249) AS i`.execute(tx);
      for (let n = 237; n <= 249; n += 1) {
        await enqueueAiGeneration(tx, orgOf(n), fieldOf(n), new Date(now.getTime() + 3_600_000));
      }
      // The 250th: AI on, a worker died with its row leased.
      await sql`
        INSERT INTO meta.ai_generation_queue (organization_id, field_id, record_id, status, lease_until)
        VALUES (${orgOf(ORGS)}, ${fieldOf(ORGS)}, 'rec_RescLastLease001', 'running',
                now() - interval '1 minute')`.execute(tx);
    });
    const tasks = buildTaskList({
      config: testConfig(database.url),
      db,
      logger: captured.logger,
      ai: { now: () => now },
    });
    const task = tasks['ai.generation_rescue'];
    if (task === undefined) throw new Error('no ai.generation_rescue task');
    run = async () => {
      await task({ _cron: { ts: now.toISOString(), backfilled: false } }, {} as JobHelpers);
    };
  }, 120_000);

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('lists only organizations whose work can run now, then rescues the 250th within two runs', async () => {
    // Every organization with AI off has an expired lease: listed until it is given back.
    const first = await listAiGenerationRescueOrganizations(db.kysely, {
      now,
      limit: 1_000,
      defaultTimeZone: 'UTC',
    });
    expect(first).toEqual([...Array.from({ length: AI_OFF }, (_, i) => orgOf(i + 1)), orgOf(ORGS)]);

    await run();
    await run();
    expect(runs().map((line) => line.organizations)).toEqual([200, 11]);
    expect(await statusOf(ORGS)).toEqual([{ status: 'queued', reason: null }]);

    // AI off: the lease given back, nothing resumed, no job; AI on but stuck: left alone.
    expect(await statusOf(1)).toEqual([
      { status: 'paused', reason: 'ai_disabled' },
      { status: 'queued', reason: null },
      { status: 'queued', reason: null },
    ]);
    expect(await statusOf(211)).toEqual([
      { status: 'paused', reason: 'provider_error:unauthorized' },
    ]);
    expect(await statusOf(224)).toEqual([{ status: 'paused', reason: 'quota' }]);
    // Jobs: the 13 that were waiting, and the 250th's.
    expect(await jobKeys()).toEqual(
      [...Array.from({ length: 13 }, (_, i) => 237 + i), ORGS]
        .map((n) => aiGenerateJobKey(fieldOf(n)))
        .sort(),
    );

    // Nothing left that can run: the next run visits nobody.
    expect(
      await listAiGenerationRescueOrganizations(db.kysely, {
        now,
        limit: 1_000,
        defaultTimeZone: 'UTC',
      }),
    ).toEqual([]);
    await run();
    expect(runs()).toHaveLength(2);
  });

  it('goes on after the last organization of the previous run, so one it cannot fix never keeps the others out', async () => {
    // Three organizations whose rescue always fails: listed every run.
    for (const n of [5, 6, 7]) {
      await sql`UPDATE meta.ai_generation_queue SET status = 'running',
                       lease_until = now() - interval '1 minute'
                 WHERE field_id = ${fieldOf(n)} AND status = 'queued'`.execute(db.kysely);
    }
    const seen: Id<'org'>[][] = [];
    let batch: Id<'org'>[] = [];
    const rescue = {
      rescue: (scope: { readonly organizationId: Id<'org'> }): Promise<Id<'fld'>[]> => {
        batch.push(scope.organizationId);
        return Promise.reject(new Error('cannot fix'));
      },
    };
    const task = createAiGenerationRescueTask({
      db,
      generator: rescue,
      logger: captured.logger,
      defaultTimeZone: 'UTC',
      limit: 2,
      now: () => now,
    });
    for (let index = 0; index < 4; index += 1) {
      batch = [];
      await task({ _cron: { ts: now.toISOString(), backfilled: false } }, {} as JobHelpers);
      seen.push(batch);
    }
    expect(seen).toEqual([
      [orgOf(5), orgOf(6)],
      [orgOf(7), orgOf(5)],
      [orgOf(6), orgOf(7)],
      [orgOf(5), orgOf(6)],
    ]);
  });
});
