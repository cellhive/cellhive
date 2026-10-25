import {
  AttachmentsRepository,
  BasesRepository,
  orgScope,
  SchemaService,
  systemAuditContext,
  type Db,
  type FieldRow,
} from '@cellhive/server-core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAttachmentsCleanupTask } from '../../src/tasks/attachments-cleanup.js';

import {
  captureLogger,
  createMigratedDatabase,
  createTestDb,
  type TestDatabase,
} from './support.js';

import type { Id } from '@cellhive/contracts';
import type { JobHelpers } from 'graphile-worker';

const ORG_A: Id<'org'> = 'org_AttachCleanOrgA1';
const ORG_B: Id<'org'> = 'org_AttachCleanOrgB1';
const NOW = new Date('2026-09-25T12:00:00.000Z');
const HOUR = 3_600_000;
const SHA = 'b'.repeat(64);

/**
 * `attachments.cleanup` (T406): unattached uploads after 24 h, detached files
 * after 30 days and files of purged fields go, in every organization; an
 * object shared by a copy (S4 #12) stays while a row references it.
 */
describe('attachments.cleanup', () => {
  let database: TestDatabase;
  let db: Db;
  let repo: AttachmentsRepository;
  const fields = new Map<Id<'org'>, FieldRow>();
  const bases = new Map<Id<'org'>, Id<'bse'>>();

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    repo = new AttachmentsRepository(db);
    const schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    for (const org of [ORG_A, ORG_B]) {
      const user: Id<'usr'> = `usr_${org.slice(4)}`;
      const workspace: Id<'wsp'> = `wsp_${org.slice(4)}`;
      await db.withTx(async (tx) => {
        await tx
          .insertInto('meta.organizations')
          .values({ id: org, name: org, slug: org.toLowerCase() })
          .execute();
        await tx
          .insertInto('meta.users')
          .values({ id: user, email: `${org.toLowerCase()}@example.test`, display_name: 'U' })
          .execute();
        await tx
          .insertInto('meta.workspaces')
          .values({ id: workspace, organization_id: org, name: 'W', slug: 'main' })
          .execute();
      });
      const base = await new BasesRepository(db).create(orgScope(org), {
        workspaceId: workspace,
        ownerId: user,
        name: 'B',
      });
      const { table } = await schema.createTable(
        orgScope(org),
        { baseId: base.id, name: 'T', primaryFieldName: 'Name' },
        systemAuditContext(),
      );
      fields.set(
        org,
        await schema.addField(
          orgScope(org),
          table.id,
          { name: 'files', type: 'attachment', options: {} },
          systemAuditContext(),
        ),
      );
      bases.set(org, base.id);
    }
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  async function file(
    org: Id<'org'>,
    state: { createdAgoH: number; record?: Id<'rec'>; detachedAgoH?: number },
  ) {
    const field = fields.get(org) as FieldRow;
    const row = await repo.create(orgScope(org), {
      baseId: bases.get(org) as Id<'bse'>,
      tableId: field.table_id,
      fieldId: field.id,
      createdBy: `usr_${org.slice(4)}`,
      filename: 'a.pdf',
      mime: 'application/pdf',
      size: 1,
    });
    await repo.markReady(orgScope(org), row.id, { size: 1, sha256: SHA });
    await sql`
      UPDATE meta.attachments
         SET created_at = ${new Date(NOW.getTime() - state.createdAgoH * HOUR)},
             record_id = ${state.record ?? null},
             detached_at = ${
               state.detachedAgoH === undefined
                 ? null
                 : new Date(NOW.getTime() - state.detachedAgoH * HOUR)
             }
       WHERE id = ${row.id}
    `.execute(db.kysely);
    return (await repo.getById(orgScope(org), row.id)) as NonNullable<
      Awaited<ReturnType<AttachmentsRepository['getById']>>
    >;
  }

  function run(deleted: string[], fail = false) {
    const captured = captureLogger();
    const task = createAttachmentsCleanupTask({
      db,
      storage: {
        delete: (key) => {
          if (fail) return Promise.reject(new Error('storage down'));
          deleted.push(key);
          return Promise.resolve();
        },
      },
      logger: captured.logger,
      now: () => NOW,
      batchSize: 2,
    });
    return { run: () => task({}, {} as JobHelpers), captured };
  }

  it('deletes expired rows of every organization and objects no longer referenced', async () => {
    const staleA = await file(ORG_A, { createdAgoH: 25 });
    const staleB = await file(ORG_B, { createdAgoH: 30 });
    const fresh = await file(ORG_A, { createdAgoH: 23 });
    const attached = await file(ORG_A, { createdAgoH: 100, record: 'rec_AttachClean00001' });
    const oldDetached = await file(ORG_B, {
      createdAgoH: 2000,
      record: 'rec_AttachClean00002',
      detachedAgoH: 31 * 24,
    });
    const recentDetached = await file(ORG_A, {
      createdAgoH: 2000,
      record: 'rec_AttachClean00003',
      detachedAgoH: 29 * 24,
    });
    // A copy (another record) shares the object of a detached, expired file.
    const shared = await file(ORG_A, {
      createdAgoH: 2000,
      record: 'rec_AttachClean00004',
      detachedAgoH: 40 * 24,
    });
    const copy = await repo.copyTo(orgScope(ORG_A), shared, {
      recordId: 'rec_AttachClean00005',
      createdBy: null,
    });

    const deleted: string[] = [];
    const { run: go, captured } = run(deleted);
    await go();

    // Each object goes with its thumbnails (T407), whether rendered or not.
    expect(deleted.sort()).toEqual(
      [staleA.object_key, staleB.object_key, oldDetached.object_key]
        .flatMap((key) => [key, `${key}.upload`, `${key}_t256`, `${key}_t1280`])
        .sort(),
    );
    const left = await db.kysely.selectFrom('meta.attachments').select('id').execute();
    expect(left.map((row) => row.id).sort()).toEqual(
      [fresh.id, attached.id, recentDetached.id, copy.id].sort(),
    );
    expect(captured.lines.at(-1)).toMatchObject({ rows: 4, objects: 3 });
    // Only counts: no file name, key or id in the log.
    expect(captured.raw()).not.toContain('a.pdf');
    expect(captured.raw()).not.toContain(staleA.object_key);

    // Nothing left: a second run deletes nothing.
    deleted.length = 0;
    await run(deleted).run();
    expect(deleted).toEqual([]);
  });

  it('deletes the files of a purged field', async () => {
    const onPurged = await file(ORG_B, { createdAgoH: 1, record: 'rec_AttachClean00006' });
    await sql`UPDATE meta.fields SET deleted_at = now(), purged_at = now() WHERE id = ${
      fields.get(ORG_B)?.id ?? ''
    }`.execute(db.kysely);
    const deleted: string[] = [];
    await run(deleted).run();
    expect(deleted).toContain(onPurged.object_key);
    expect(deleted).toContain(`${onPurged.object_key}_t256`);
    expect(await repo.getById(orgScope(ORG_B), onPurged.id)).toBeUndefined();
  });

  it('deletes files of purged records, the shared object only with its last row (T408)', async () => {
    const field = fields.get(ORG_A) as FieldRow;
    const original = await file(ORG_A, { createdAgoH: 1, record: 'rec_AttachClean00007' });
    const copy = await repo.copyTo(orgScope(ORG_A), original, {
      recordId: 'rec_AttachClean00008',
      createdBy: null,
    });
    // The first record is purged: its row goes, the object stays for the copy.
    expect(
      await repo.markRecordsPurged(orgScope(ORG_A), field.table_id, ['rec_AttachClean00007'], NOW),
    ).toBe(1);
    // Another organization cannot mark it.
    expect(
      await repo.markRecordsPurged(orgScope(ORG_B), field.table_id, ['rec_AttachClean00008'], NOW),
    ).toBe(0);
    const deleted: string[] = [];
    await run(deleted).run();
    expect(deleted).toEqual([]);
    expect(await repo.getById(orgScope(ORG_A), original.id)).toBeUndefined();
    expect(await repo.getById(orgScope(ORG_A), copy.id)).toMatchObject({ record_purged_at: null });

    // The copy's record is purged too: the object and its thumbnails go.
    await repo.markRecordsPurged(orgScope(ORG_A), field.table_id, ['rec_AttachClean00008'], NOW);
    await run(deleted).run();
    expect(deleted).toEqual([
      original.object_key,
      `${original.object_key}.upload`,
      `${original.object_key}_t256`,
      `${original.object_key}_t1280`,
    ]);
    expect(await repo.getById(orgScope(ORG_A), copy.id)).toBeUndefined();
  });

  it('keeps the rows when storage fails (retried on the next run)', async () => {
    const stale = await file(ORG_A, { createdAgoH: 48 });
    await expect(run([], true).run()).rejects.toThrow('storage down');
    expect(await repo.getById(orgScope(ORG_A), stale.id)).toBeDefined();
    const deleted: string[] = [];
    await run(deleted).run();
    expect(deleted).toEqual([
      stale.object_key,
      `${stale.object_key}.upload`,
      `${stale.object_key}_t256`,
      `${stale.object_key}_t1280`,
    ]);
  });
});
