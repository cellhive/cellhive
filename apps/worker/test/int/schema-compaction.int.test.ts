import {
  BasesRepository,
  orgScope,
  SchemaService,
  systemAuditContext,
  usedColumnSlots,
  type Db,
} from '@cellhive/server-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createWorker, type WorkerHandle } from '../../src/index.js';

import {
  captureLogger,
  createMigratedDatabase,
  createTestDb,
  queuedJobs,
  testConfig,
  waitFor,
  type CapturedLogger,
  type TestDatabase,
} from './support.js';

const ORG = 'org_WorkerCompact001';
const USER = 'usr_WorkerCompact001';
const WSP = 'wsp_WorkerCompact001';

describe('worker: schema.compact_table', () => {
  let database: TestDatabase;
  let db: Db;
  let worker: WorkerHandle;
  let captured: CapturedLogger;

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    await db.withTx(async (tx) => {
      await tx.insertInto('meta.organizations').values({ id: ORG, name: 'C', slug: 'c' }).execute();
      await tx
        .insertInto('meta.users')
        .values({ id: USER, email: 'c@example.test', display_name: 'C' })
        .execute();
      await tx
        .insertInto('meta.workspaces')
        .values({ id: WSP, organization_id: ORG, name: 'C', slug: 'main' })
        .execute();
    });
    captured = captureLogger();
    worker = await createWorker(testConfig(database.url), {
      logger: captured.logger,
      pollIntervalMs: 200,
    });
  });

  afterAll(async () => {
    await worker.close();
    await db.destroy();
    await database.drop();
  });

  it('runs the compaction queued by SchemaService on the schema:<tableId> queue', async () => {
    const scope = orgScope(ORG);
    const context = systemAuditContext();
    const base = await new BasesRepository(db).create(scope, {
      workspaceId: WSP,
      ownerId: USER,
      name: 'Base',
    });
    // Low threshold so a few add/delete pairs queue the job (10 slots after create).
    const schema = new SchemaService(db, {
      maxFieldsPerTable: 500,
      slotThresholds: { compact: 14, lock: 20 },
    });
    const { table } = await schema.createTable(
      scope,
      { baseId: base.id, name: 'T', primaryFieldName: 'Name' },
      context,
    );
    for (let index = 0; index < 3; index += 1) {
      const field = await schema.addField(scope, table.id, { name: 'Tmp', type: 'text' }, context);
      await schema.deleteField(scope, field.id, context);
    }
    // Past the 30-day restore window, so compaction may drop their columns.
    await db.kysely
      .updateTable('meta.fields')
      .set({ deleted_at: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) })
      .where('table_id', '=', table.id)
      .where('deleted_at', 'is not', null)
      .execute();
    // The 14th slot queues the job; the worker may start right away, so this
    // is the last schema change of the test (DDL during compaction is a 409).
    await schema.addField(scope, table.id, { name: 'Kept', type: 'text' }, context);

    const compactedAt = await waitFor(
      async () =>
        (
          await db.kysely
            .selectFrom('meta.tables')
            .select('compacted_at')
            .where('id', '=', table.id)
            .executeTakeFirstOrThrow()
        ).compacted_at ?? undefined,
      { what: 'compacted_at' },
    );
    expect(compactedAt).toBeInstanceOf(Date);
    await waitFor(async () => (await queuedJobs(db, 'schema.compact_table')).length === 0, {
      what: 'the compaction job to complete',
    });
    expect(await usedColumnSlots(db.kysely, table.db_table_name)).toBe(11);
    expect(await schema.checkConsistency(scope, table.id)).toEqual([]);
    expect(captured.lines).toContainEqual(
      expect.objectContaining({ msg: 'table compacted', table_id: table.id, slots_after: 11 }),
    );
  });
});
