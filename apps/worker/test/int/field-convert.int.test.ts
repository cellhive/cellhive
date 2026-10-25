import { newId, type Id } from '@cellhive/contracts';
import {
  BasesRepository,
  FieldConversionsRepository,
  JobsRepository,
  orgScope,
  RecordMutationService,
  SchemaService,
  systemAuditContext,
  type Db,
  type RecordAccessContext,
} from '@cellhive/server-core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createWorker, type WorkerHandle } from '../../src/index.js';
import { createFieldConversionCleanupTask } from '../../src/tasks/field-conversion-cleanup.js';

import {
  captureLogger,
  createMigratedDatabase,
  createTestDb,
  testConfig,
  waitFor,
  type CapturedLogger,
  type TestDatabase,
} from './support.js';

import type { JobHelpers } from 'graphile-worker';

const ORG: Id<'org'> = 'org_WorkerConvert001';
const USER: Id<'usr'> = 'usr_WorkerConvert001';
const WSP: Id<'wsp'> = 'wsp_WorkerConvert001';

describe('worker: field.convert and field.conversion_cleanup (T403)', () => {
  let database: TestDatabase;
  let db: Db;
  let worker: WorkerHandle;
  let captured: CapturedLogger;
  const scope = orgScope(ORG);

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    await db.withTx(async (tx) => {
      await tx.insertInto('meta.organizations').values({ id: ORG, name: 'A', slug: 'a' }).execute();
      await tx
        .insertInto('meta.users')
        .values({ id: USER, email: 'a@example.test', display_name: 'A' })
        .execute();
      await tx
        .insertInto('meta.org_members')
        .values({ organization_id: ORG, user_id: USER, role: 'owner' })
        .execute();
      await tx
        .insertInto('meta.workspaces')
        .values({ id: WSP, organization_id: ORG, name: 'A', slug: 'main' })
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

  it('converts the values in batches, swaps the columns and cleans the old one after 7 days', async () => {
    const context = { ...systemAuditContext(), actor: { type: 'user' as const, id: USER } };
    const base = await new BasesRepository(db).create(scope, {
      workspaceId: WSP,
      ownerId: USER,
      name: 'Base',
    });
    const schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    const { table, primaryField } = await schema.createTable(
      scope,
      { baseId: base.id, name: 'T', primaryFieldName: 'Name' },
      context,
    );
    const field = await schema.addField(scope, table.id, { name: 'Amount', type: 'text' }, context);
    const records = new RecordMutationService(db, { schema });
    const access: RecordAccessContext = {
      baseId: base.id,
      resolved: {
        access: {
          role: null,
          is_admin: true,
          base_rule: { copy: true, download: true, share_link: true },
          tables: {
            [table.id]: {
              perm: 'manage',
              operations: ['add', 'delete'],
              view_rule: { allow_edit: true, visible_views: null },
              read_scope: 'all',
              fields: { [primaryField.id]: 'edit', [field.id]: 'edit' },
              option_edit_fields: [],
              file_download_fields: [],
            },
          },
          dashboards: {},
        },
        internal: { editFilters: { [table.id]: null }, readFilters: { [table.id]: null } },
      },
      userId: USER,
      groupMemberUserIds: [],
      timeZone: 'UTC',
      locale: 'vi',
    };
    await records.create(
      scope,
      table.id,
      access,
      {
        field_key_type: 'id',
        records: ['1.500.000', 'abc', '12'].map((value) => ({ fields: { [field.id]: value } })),
      },
      { ...context, batch_id: newId('req') },
    );

    const started = await schema.startConversion(
      scope,
      field.id,
      {
        expectedFrom: { type: field.type, options: field.options },
        toType: 'number',
        toOptions: {},
        settings: {},
        locale: 'vi',
        timeZone: 'UTC',
      },
      context,
    );
    const jobs = new JobsRepository(db);
    const job = await waitFor(
      async () => {
        const row = await jobs.getById(scope, started.jobId);
        return row?.status === 'succeeded' ? row : undefined;
      },
      { what: 'the conversion job to succeed' },
    );
    expect(job.result).toMatchObject({ affected: 3, lost: 1, truncated: 0 });
    const column = field.db_column_name as string;
    const { rows } = await sql<{ value: string | null }>`
      SELECT ${sql.ref(column)}::text AS value
        FROM ${sql.table(`data.${table.db_table_name}`)} ORDER BY __auto
    `.execute(db.kysely);
    expect(rows.map((row) => row.value)).toEqual(['1500000', null, '12']);
    // The task logs right after the job row is final.
    await waitFor(async () =>
      Promise.resolve(captured.lines.some((line) => line.msg === 'field.convert finished')),
    );
    expect(captured.lines).toContainEqual(
      expect.objectContaining({
        msg: 'field.convert finished',
        job_id: started.jobId,
        affected: 3,
        lost: 1,
      }),
    );
    expect(captured.raw()).not.toContain('1.500.000');

    // 7 days later the cron drops the old column.
    await db.kysely
      .updateTable('meta.field_conversions')
      .set({ expires_at: new Date(Date.now() - 1000) } as never)
      .where('job_id', '=', started.jobId)
      .execute();
    const cleanup = createFieldConversionCleanupTask({ db, schema, logger: captured.logger });
    await cleanup({}, {} as JobHelpers);
    expect((await new FieldConversionsRepository(db).getByJob(scope, started.jobId))?.status).toBe(
      'cleaned',
    );
    expect(captured.lines).toContainEqual(
      expect.objectContaining({ msg: 'expired field conversion columns dropped', columns: 1 }),
    );
    expect(await schema.checkConsistency(scope, table.id)).toEqual([]);
  });
});
