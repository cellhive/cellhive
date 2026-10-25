import { newId, type Id } from '@cellhive/contracts';
import { auditExportKey, JobsRepository, type Db } from '@cellhive/server-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createExportsCleanupTask } from '../../src/tasks/exports-cleanup.js';

import {
  captureLogger,
  createMigratedDatabase,
  createTestDb,
  type TestDatabase,
} from './support.js';

import type { JobHelpers } from 'graphile-worker';

const ORG_A: Id<'org'> = 'org_ExportCleanOrgA1';
const ORG_B: Id<'org'> = 'org_ExportCleanOrgB1';
const NOW = new Date('2026-09-23T12:00:00.000Z');

/** `exports.cleanup`: expired export files are deleted in every organization. */
describe('exports.cleanup', () => {
  let database: TestDatabase;
  let db: Db;

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    await db.kysely
      .insertInto('meta.organizations')
      .values([
        { id: ORG_A, name: 'A', slug: 'export-clean-a' },
        { id: ORG_B, name: 'B', slug: 'export-clean-b' },
      ])
      .execute();
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  async function exportJob(
    org: Id<'org'>,
    expiresAt: Date,
    options: { type?: string; status?: 'succeeded' | 'failed' } = {},
  ): Promise<Id<'job'>> {
    const id = newId('job');
    await db.kysely
      .insertInto('meta.jobs')
      .values({
        id,
        organization_id: org,
        type: options.type ?? 'audit.export',
        status: options.status ?? 'succeeded',
        progress: 1,
        finished_at: new Date(expiresAt.getTime() - 3_600_000),
        result: {
          download_url: `/api/v1/files/exports/${id}`,
          expires_at: expiresAt.toISOString(),
          size: 10,
        },
      })
      .execute();
    return id;
  }

  it('deletes expired files of every organization and clears their download link', async () => {
    const expiredA = await exportJob(ORG_A, new Date(NOW.getTime() - 60_000));
    const expiredB = await exportJob(ORG_B, new Date(NOW.getTime() - 1));
    const live = await exportJob(ORG_A, new Date(NOW.getTime() + 60_000));
    const otherType = await exportJob(ORG_A, new Date(NOW.getTime() - 60_000), {
      type: 'base.export',
    });
    const deleted: string[] = [];
    const { logger } = captureLogger();
    const task = createExportsCleanupTask({
      db,
      jobs: new JobsRepository(db),
      storage: {
        delete: (key) => {
          deleted.push(key);
          return Promise.resolve();
        },
      },
      logger,
      now: () => NOW,
      batchSize: 1,
    });
    await task({}, {} as JobHelpers);

    expect(deleted.sort()).toEqual(
      [auditExportKey(ORG_A, expiredA), auditExportKey(ORG_B, expiredB)].sort(),
    );
    const rows = await db.kysely.selectFrom('meta.jobs').select(['id', 'result']).execute();
    const resultOf = (id: Id<'job'>) => rows.find((row) => row.id === id)?.result;
    expect(resultOf(expiredA)).not.toHaveProperty('download_url');
    expect(resultOf(expiredA)).toMatchObject({ file_deleted: true, size: 10 });
    expect(resultOf(expiredB)).toMatchObject({ file_deleted: true });
    expect(resultOf(live)).toHaveProperty('download_url');
    expect(resultOf(otherType)).toHaveProperty('download_url');

    // A second run finds nothing left to delete.
    deleted.length = 0;
    await task({}, {} as JobHelpers);
    expect(deleted).toEqual([]);
  });

  it('keeps the link when the file cannot be deleted (retried next run)', async () => {
    const job = await exportJob(ORG_A, new Date(NOW.getTime() - 60_000));
    const { logger } = captureLogger();
    const task = createExportsCleanupTask({
      db,
      jobs: new JobsRepository(db),
      storage: { delete: () => Promise.reject(new Error('storage down')) },
      logger,
      now: () => NOW,
    });
    await expect(task({}, {} as JobHelpers)).rejects.toThrow('storage down');
    const row = await db.kysely
      .selectFrom('meta.jobs')
      .select('result')
      .where('id', '=', job)
      .executeTakeFirstOrThrow();
    expect(row.result).toHaveProperty('download_url');
  });
});
