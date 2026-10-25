import { type Id } from '@cellhive/contracts';
import {
  AUDIT_BASE_EXPORT_JOB_TYPE,
  AUDIT_EXPORT_JOB_TYPE,
  AuditWriter,
  JobsRepository,
  orgScope,
  type Db,
} from '@cellhive/server-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAuditExportTask } from '../../src/tasks/audit-export.js';

import {
  captureLogger,
  createMigratedDatabase,
  createTestDb,
  queuedJobs,
  type TestDatabase,
} from './support.js';

import type { JobHelpers } from 'graphile-worker';

const ORG: Id<'org'> = 'org_AuditExportTask1';
const BASE_A: Id<'bse'> = 'bse_AuditExportBaseA';
const BASE_B: Id<'bse'> = 'bse_AuditExportBaseB';

/**
 * `audit.export` (T709): a base export writes only its base's entries, and
 * one audit export — organization or base — runs per organization at a
 * time (the other is deferred).
 */
describe('audit.export task (organization and base exports)', () => {
  let database: TestDatabase;
  let db: Db;
  let jobs: JobsRepository;
  const stored = new Map<string, string>();
  const scope = orgScope(ORG);

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    jobs = new JobsRepository(db);
    await db.kysely
      .insertInto('meta.organizations')
      .values({ id: ORG, name: 'Audit export', slug: 'audit-export-task' })
      .execute();
    const writer = new AuditWriter();
    await db.withTx(async (tx) => {
      for (const [baseId, entityId] of [
        [BASE_A, 'rec_AuditExportRecA1'],
        [BASE_B, 'rec_AuditExportRecB1'],
      ] as const) {
        await writer.write(tx, {
          action: 'record.created',
          organizationId: ORG,
          baseId,
          entityType: 'record',
          entityId,
          after: { fld_AuditExportField1: 1 },
          context: {
            actor: { type: 'system', id: null },
            via: null,
            batch_id: null,
            request_id: null,
            ip: null,
            user_agent: null,
          },
        });
      }
    });
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  const task = () =>
    createAuditExportTask({
      db,
      jobs,
      storage: {
        put: (key: string, body: Buffer) => {
          stored.set(key, body.toString('utf8'));
          return Promise.resolve({ key, size: body.length });
        },
      },
      logger: captureLogger().logger,
    } as unknown as Parameters<typeof createAuditExportTask>[0]);

  function helpersOf(payload: unknown): JobHelpers {
    return {
      job: {
        id: '1',
        task_identifier: 'audit.export',
        payload,
        priority: 0,
        attempts: 1,
        max_attempts: 1,
        key: null,
        flags: null,
        job_queue_id: null,
      },
      getQueueName: () => Promise.resolve(null),
    } as unknown as JobHelpers;
  }

  async function run(jobId: Id<'job'>, filters: Record<string, unknown>): Promise<void> {
    const payload = { organization_id: ORG, job_id: jobId, filters };
    await task()(payload as never, helpersOf(payload));
  }

  it('waits while another audit export of the organization runs, then exports its base only', async () => {
    const orgJob = await jobs.create(scope, { type: AUDIT_EXPORT_JOB_TYPE, createdBy: null });
    await jobs.markRunning(scope, orgJob.id);
    const baseJob = await jobs.create(scope, { type: AUDIT_BASE_EXPORT_JOB_TYPE, createdBy: null });

    await run(baseJob.id, { base_id: BASE_A });
    expect((await jobs.getById(scope, baseJob.id))?.status).toBe('queued');
    expect((await queuedJobs(db, 'audit.export')).length).toBe(1);

    await jobs.markSucceeded(scope, orgJob.id);
    await run(baseJob.id, { base_id: BASE_A });
    const done = await jobs.getById(scope, baseJob.id);
    expect(done).toMatchObject({ status: 'succeeded', result: { rows: 1, truncated: false } });
    const csv = [...stored.values()].at(-1) ?? '';
    expect(csv).toContain('rec_AuditExportRecA1');
    expect(csv).not.toContain('rec_AuditExportRecB1');
  });

  it('never runs a base export without its base', async () => {
    const baseJob = await jobs.create(scope, { type: AUDIT_BASE_EXPORT_JOB_TYPE, createdBy: null });
    await run(baseJob.id, {});
    expect((await jobs.getById(scope, baseJob.id))?.status).toBe('queued');
  });
});
