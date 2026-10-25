import { newId, type Id } from '@cellhive/contracts';
import {
  BasesRepository,
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

const ORG: Id<'org'> = 'org_WorkerAutoNum001';
const USER: Id<'usr'> = 'usr_WorkerAutoNum001';
const WSP: Id<'wsp'> = 'wsp_WorkerAutoNum001';

describe('worker: schema.recompute_auto_number', () => {
  let database: TestDatabase;
  let db: Db;
  let worker: WorkerHandle;
  let captured: CapturedLogger;

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

  it('numbers existing records when an auto_number field is added', async () => {
    const scope = orgScope(ORG);
    const context = systemAuditContext();
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
              fields: { [primaryField.id]: 'edit' },
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
      locale: 'en',
    };
    await records.create(
      scope,
      table.id,
      access,
      { records: [{ fields: { Name: 'a' } }, { fields: { Name: 'b' } }] },
      { ...context, batch_id: newId('req') },
    );
    const field = await schema.addField(
      scope,
      table.id,
      { name: 'No', type: 'auto_number' },
      context,
    );
    const column = field.db_column_name as string;
    await waitFor(async () => (await queuedJobs(db, 'schema.recompute_auto_number')).length === 0, {
      what: 'the recompute job to complete',
    });
    const { rows } = await sql<{ value: string | null; auto: bigint }>`
      SELECT ${sql.ref(column)} AS value, __auto AS auto
        FROM ${sql.table(`data.${table.db_table_name}`)} ORDER BY __auto
    `.execute(db.kysely);
    expect(rows.map((row) => row.value)).toEqual(
      rows.map((row) => `NO.${String(row.auto).padStart(3, '0')}`),
    );
    expect(captured.lines).toContainEqual(
      expect.objectContaining({ msg: 'auto numbers recomputed', field_id: field.id, updated: 2 }),
    );
  });
});
