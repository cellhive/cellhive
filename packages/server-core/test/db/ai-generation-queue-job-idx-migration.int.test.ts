import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AiGenerationQueueRepository } from '../../src/ai/index.js';
import { createMigrator, migrateToLatest, type Db } from '../../src/db/index.js';
import { orgScope, SchemaService, systemAuditContext } from '../../src/index.js';
import { migrateJobQueue } from '../../src/jobs/index.js';
import { createTestDatabase, createTestDb, type TestDatabase } from '../support/postgres.js';
import { seedTenant } from '../support/tenant.js';

import type { Id } from '@cellhive/contracts';

const ORG: Id<'org'> = 'org_T1003JobIdxOrgA1';
const ROWS = 60_000;

/**
 * BACKLOG T1003: migration 0057 on a database whose queue (0056) already
 * holds rows of every kind — queued by record writes (no job) and by
 * generate requests, running, failed, paused for each reason, backing off.
 * It adds the three indexes, valid, and every row stays as it was.
 */
describe('migration 0057_ai_generation_queue_job_idx (T1003)', () => {
  let database: TestDatabase;
  let db: Db;
  let fieldId: Id<'fld'>;

  const snapshot = async () =>
    (
      await sql<{ status: string; reason: string | null; jobs: number; n: number }>`
        SELECT status, reason, count(DISTINCT job_id)::int AS jobs, count(*)::int AS n
          FROM meta.ai_generation_queue GROUP BY status, reason ORDER BY status, reason`.execute(
        db.kysely,
      )
    ).rows;

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateJobQueue({ connectionString: database.url });
    const { error } = await createMigrator(db.kysely).migrateTo('0056_ai_generation_queue');
    expect(error).toBeUndefined();
    const tenant = await seedTenant(db, ORG);
    const schema = new SchemaService(db, { maxFieldsPerTable: 50 });
    const { table } = await schema.createTable(
      orgScope(ORG),
      { baseId: tenant.baseId, name: 'Tickets', primaryFieldName: 'Title' },
      systemAuditContext(),
    );
    fieldId = (
      await schema.addField(
        orgScope(ORG),
        table.id,
        { name: 'Summary', type: 'text' },
        systemAuditContext(),
      )
    ).id;
    await sql`
      INSERT INTO meta.ai_generation_queue
             (organization_id, field_id, record_id, status, reason, attempts, lease_until, job_id)
      SELECT ${ORG}, ${fieldId}, 'rec_T1003Mig' || lpad(i::text, 8, '0'),
             (ARRAY['queued', 'queued', 'running', 'failed', 'paused', 'paused', 'paused', 'queued'])[i % 8 + 1],
             (ARRAY[NULL, NULL, NULL, 'invalid_output', 'quota', 'ai_disabled',
                    'provider_error:unauthorized', 'backoff'])[i % 8 + 1],
             i % 3,
             CASE WHEN i % 8 IN (2, 7) THEN now() + interval '1 minute' END,
             CASE WHEN i % 5 = 0 THEN NULL ELSE 'job_T1003Mig' || lpad((i % 40)::text, 8, '0') END
        FROM generate_series(1, ${ROWS}) AS i`.execute(db.kysely);
  }, 120_000);

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('adds the job, back-off and paused indexes; every row is kept', async () => {
    const before = await snapshot();
    expect(before.reduce((sum, row) => sum + row.n, 0)).toBe(ROWS);
    expect(await migrateToLatest(db.kysely)).toEqual(['0057_ai_generation_queue_job_idx']);
    expect(await snapshot()).toEqual(before);

    const { rows } = await sql<{ name: string; definition: string; valid: boolean }>`
      SELECT c.relname AS name, pg_get_indexdef(i.indexrelid) AS definition, i.indisvalid AS valid
        FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE i.indrelid = 'meta.ai_generation_queue'::regclass
         AND c.relname IN ('ai_generation_queue_job_idx', 'ai_generation_queue_backoff_idx',
                           'ai_generation_queue_paused_idx')
       ORDER BY c.relname`.execute(db.kysely);
    expect(rows).toEqual([
      {
        name: 'ai_generation_queue_backoff_idx',
        definition: expect.stringMatching(
          /\(organization_id, lease_until\) WHERE \(\(status = 'queued'::text\) AND \(reason = 'backoff'::text\)\)$/u,
        ) as unknown,
        valid: true,
      },
      {
        name: 'ai_generation_queue_job_idx',
        definition: expect.stringMatching(
          /\(organization_id, job_id\) WHERE \(job_id IS NOT NULL\)$/u,
        ) as unknown,
        valid: true,
      },
      {
        name: 'ai_generation_queue_paused_idx',
        definition: expect.stringMatching(
          /\(organization_id, reason\) WHERE \(status = 'paused'::text\)$/u,
        ) as unknown,
        valid: true,
      },
    ]);

    // The queries read the migrated rows as before.
    const queue = new AiGenerationQueueRepository(db);
    const job: Id<'job'> = 'job_T1003Mig00000001';
    const expected = await sql<{ pending: number; failed: number }>`
      SELECT count(*) FILTER (WHERE status IN ('queued', 'running', 'paused'))::int AS pending,
             count(*) FILTER (WHERE status = 'failed')::int AS failed
        FROM meta.ai_generation_queue WHERE job_id = ${job}`.execute(db.kysely);
    expect(await queue.pendingOfJob(orgScope(ORG), job)).toBe(expected.rows[0]?.pending);
    expect(await queue.failedOfJob(orgScope(ORG), job)).toBe(expected.rows[0]?.failed);
    expect(await queue.backOffUntil(orgScope(ORG))).not.toBeNull();
  });
});
