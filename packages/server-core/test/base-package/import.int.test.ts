import { newId, type Id } from '@cellhive/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AttachmentsRepository,
  BasesRepository,
  createBaseRecord,
  EmailAssetsRepository,
  FormCoversRepository,
  migrateToLatest,
  OrgMembersRepository,
  orgScope,
  RecordMutationService,
  SchemaService,
  systemAuditContext,
  TablesRepository,
  type Db,
  type ImportFieldInput,
  type ImportingBase,
} from '../../src/index.js';
import { migrateJobQueue } from '../../src/jobs/index.js';
import { createTestDatabase, createTestDb, type TestDatabase } from '../support/postgres.js';
import { seedTenant, type SeededTenant } from '../support/tenant.js';

const ORG_A: Id<'org'> = 'org_T1018ImportOrgA1';
const ORG_B: Id<'org'> = 'org_T1018ImportOrgB1';

function plain(id: Id<'fld'>, name: string, type: string, position: number, options = {}) {
  return {
    id,
    name,
    type,
    options,
    description: null,
    required: false,
    uniqueValues: false,
    position,
  } satisfies ImportFieldInput;
}

/**
 * BACKLOG T1018: the writes of a `.chbase` import — `SchemaService.importTable`,
 * `importLinkField` and `purgeBase`, `RecordMutationService.loadPackageBatch`
 * — reach only the hidden base of their `base.import` job (never a visible
 * base, another job's or another organization's), write no event or audit
 * entry, and the purge leaves nothing; every repository query they added is
 * bound to its organization.
 */
describe('base import writes (T1018)', () => {
  let database: TestDatabase;
  let db: Db;
  let schema: SchemaService;
  let records: RecordMutationService;
  let a: SeededTenant;
  let b: SeededTenant;
  const scopeA = orgScope(ORG_A);
  const scopeB = orgScope(ORG_B);
  const jobA: Id<'job'> = 'job_T1018ImportJobA1';
  const jobB: Id<'job'> = 'job_T1018ImportJobB1';
  let hiddenA: ImportingBase;
  let hiddenB: ImportingBase;
  const ids = {
    orders: newId('tbl'),
    title: newId('fld'),
    amount: newId('fld'),
    files: newId('fld'),
    parent: newId('fld'),
    customers: newId('tbl'),
    name: newId('fld'),
    link: newId('fld'),
    reverse: newId('fld'),
  };

  const count = async (table: string) =>
    Number(
      (
        await sql<{ n: string }>`SELECT count(*)::text AS n FROM ${sql.table(table)}`.execute(
          db.kysely,
        )
      ).rows[0]?.n,
    );

  async function hiddenBase(tenant: SeededTenant, jobId: Id<'job'>): Promise<ImportingBase> {
    const scope = orgScope(tenant.orgId);
    const base = await db.withTx((tx) =>
      createBaseRecord(
        db,
        tx,
        scope,
        {
          workspaceId: tenant.workspaceId,
          ownerId: tenant.userId,
          name: 'Imported',
          importJobId: jobId,
        },
        systemAuditContext(),
      ),
    );
    return { baseId: base.id, importJobId: jobId };
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateToLatest(db.kysely);
    await migrateJobQueue({ connectionString: database.url });
    a = await seedTenant(db, ORG_A);
    b = await seedTenant(db, ORG_B);
    await new OrgMembersRepository(db).add(scopeA, a.userId, 'owner');
    await new OrgMembersRepository(db).add(scopeB, b.userId, 'owner');
    for (const [org, job] of [
      [ORG_A, jobA],
      [ORG_B, jobB],
    ] as const) {
      await db.kysely
        .insertInto('meta.jobs')
        .values({ id: job, organization_id: org, type: 'base.import', status: 'running' })
        .execute();
    }
    schema = new SchemaService(db, { maxFieldsPerTable: 50 });
    records = new RecordMutationService(db, { schema });
    hiddenA = await hiddenBase(a, jobA);
    hiddenB = await hiddenBase(b, jobB);
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  describe('the hidden base', () => {
    it('is created in the trash with its job and system roles, and nothing is recorded', async () => {
      const base = await db.kysely
        .selectFrom('meta.bases')
        .selectAll()
        .where('id', '=', hiddenA.baseId)
        .executeTakeFirstOrThrow();
      expect(base.import_job_id).toBe(jobA);
      expect(base.deleted_at).not.toBeNull();
      const roles = await db.kysely
        .selectFrom('meta.base_roles')
        .select('kind')
        .where('base_id', '=', hiddenA.baseId)
        .execute();
      expect(roles).toHaveLength(3);
      expect(await count('meta.audit_logs')).toBe(0);
      expect(await count('meta.events')).toBe(0);
    });

    it('is found by its job in its organization only', async () => {
      const repo = new BasesRepository(db);
      expect((await repo.findImporting(scopeA, jobA))?.id).toBe(hiddenA.baseId);
      expect(await repo.findImporting(scopeB, jobA)).toBeUndefined();
      expect(await repo.findImporting(scopeA, jobB)).toBeUndefined();
      expect(await repo.findImporting(scopeA, jobA, hiddenB.baseId)).toBeUndefined();
      // Never a base of the trash, nor one to restore.
      expect(await repo.getById(scopeA, hiddenA.baseId, { includeDeleted: true })).toBeUndefined();
      expect(await repo.restore(scopeA, hiddenA.baseId)).toBeUndefined();
      const page = await repo.listPage(scopeA, a.workspaceId, { offset: 0, limit: 50 }, undefined, {
        includeDeleted: true,
      });
      expect(page.items.map((item) => item.id)).not.toContain(hiddenA.baseId);
    });

    it('cannot be made visible by a write that forgets its job (check constraint)', async () => {
      await expect(
        db.kysely
          .updateTable('meta.bases')
          .set({ deleted_at: null })
          .where('id', '=', hiddenA.baseId)
          .execute(),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('SchemaService.importTable / importLinkField', () => {
    it('creates a table of the hidden base with the given ids, positions and default view', async () => {
      const created = await schema.importTable(scopeA, hiddenA, {
        id: ids.orders,
        name: 'Orders',
        description: 'From a package',
        position: 0,
        primary: plain(ids.title, 'Title', 'text', 0),
        fields: [
          plain(ids.amount, 'Amount', 'number', 2),
          plain(ids.files, 'Files', 'attachment', 3),
          plain(ids.parent, 'Parent', 'parent', 4),
        ],
      });
      expect(created.table).toMatchObject({ id: ids.orders, primary_field_id: ids.title });
      expect(created.fields.map((field) => [field.id, field.position])).toEqual([
        [ids.title, 0],
        [ids.amount, 2],
        [ids.files, 3],
        [ids.parent, 4],
      ]);
      expect(created.defaultView.type).toBe('grid');
      await schema.importTable(scopeA, hiddenA, {
        id: ids.customers,
        name: 'Customers',
        description: null,
        position: 1,
        primary: plain(ids.name, 'Name', 'text', 0),
        fields: [],
      });
      expect(await count('meta.audit_logs')).toBe(0);
      expect(await count('meta.events')).toBe(0);
    });

    it('creates a link pair with both final options in one go', async () => {
      const linked = await schema.importLinkField(scopeA, hiddenA, {
        tableId: ids.orders,
        field: plain(ids.link, 'Customer', 'link', 5, {
          link_table: ids.customers,
          bidirectional: true,
          bidirectional_link_field_name: 'Orders',
          allow_multiple: false,
          record_filter: null,
          symmetric_field_id: ids.reverse,
        }),
        reverse: plain(ids.reverse, 'Orders', 'link', 1, {
          link_table: ids.orders,
          bidirectional: true,
          bidirectional_link_field_name: 'Customer',
          allow_multiple: true,
          record_filter: null,
          symmetric_field_id: ids.link,
        }),
      });
      expect(linked.field).toMatchObject({ id: ids.link, link_side: 'a' });
      expect(linked.reverse).toMatchObject({
        id: ids.reverse,
        link_side: 'b',
        table_id: ids.customers,
      });
      expect(linked.field.link_junction).toBe(linked.reverse?.link_junction);
    });

    it('refuses a pair whose sides do not point at each other', async () => {
      await expect(
        schema.importLinkField(scopeA, hiddenA, {
          tableId: ids.orders,
          field: plain(newId('fld'), 'Other', 'link', 6, {
            link_table: ids.customers,
            bidirectional: true,
            bidirectional_link_field_name: 'x',
            allow_multiple: true,
            record_filter: null,
            symmetric_field_id: newId('fld'),
          }),
          reverse: null,
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('never reaches a visible base, another job’s base or another organization', async () => {
      const input = {
        id: newId('tbl'),
        name: 'Nope',
        description: null,
        position: 9,
        primary: plain(newId('fld'), 'Name', 'text', 0),
        fields: [],
      };
      await expect(
        schema.importTable(scopeA, { baseId: a.baseId, importJobId: jobA }, input),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        schema.importTable(scopeA, { baseId: hiddenA.baseId, importJobId: jobB }, input),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(schema.importTable(scopeB, hiddenA, input)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });

  describe('RecordMutationService.loadPackageBatch', () => {
    const rec = { r1: newId('rec'), r2: newId('rec'), r3: newId('rec'), c1: newId('rec') };

    it('loads records with their times, creators and __auto, then junction rows and parents', async () => {
      const at = '2025-05-06T07:08:09.000Z';
      const load = (records_: { id: Id<'rec'>; auto: number; fields: Record<string, unknown> }[]) =>
        records_.map((item) => ({
          ...item,
          createdAt: at,
          updatedAt: at,
          createdBy: a.userId,
          updatedBy: null,
        }));
      expect(
        await records.loadPackageBatch(scopeA, hiddenA, {
          kind: 'records',
          tableId: ids.orders,
          records: load([
            { id: rec.r1, auto: 3, fields: { [ids.title]: 'one', [ids.amount]: 1.5 } },
            { id: rec.r2, auto: 7, fields: { [ids.title]: 'two' } },
            { id: rec.r3, auto: 9, fields: {} },
          ]),
        }),
      ).toBe(3);
      await records.loadPackageBatch(scopeA, hiddenA, {
        kind: 'records',
        tableId: ids.customers,
        records: load([{ id: rec.c1, auto: 1, fields: { [ids.name]: 'An' } }]),
      });
      await records.loadPackageBatch(scopeA, hiddenA, {
        kind: 'links',
        fieldId: ids.link,
        rows: [{ a: rec.r1, b: rec.c1, position: 0 }],
      });
      await records.loadPackageBatch(scopeA, hiddenA, {
        kind: 'parents',
        tableId: ids.orders,
        rows: [{ id: rec.r2, parentId: rec.r1 }],
      });
      const table = await new TablesRepository(db).getById(scopeA, ids.orders);
      const { rows } = await sql<Record<string, unknown>>`
        SELECT __id, __auto::int AS auto, __created_at, __created_by, __version, __parent_id
          FROM ${sql.table(`data.${table?.db_table_name ?? ''}`)} ORDER BY __auto
      `.execute(db.kysely);
      expect(rows).toEqual([
        {
          __id: rec.r1,
          auto: 3,
          __created_at: new Date(at),
          __created_by: a.userId,
          __version: 1,
          __parent_id: null,
        },
        {
          __id: rec.r2,
          auto: 7,
          __created_at: new Date(at),
          __created_by: a.userId,
          __version: 1,
          __parent_id: rec.r1,
        },
        {
          __id: rec.r3,
          auto: 9,
          __created_at: new Date(at),
          __created_by: a.userId,
          __version: 1,
          __parent_id: null,
        },
      ]);
      expect(await count('meta.audit_logs')).toBe(0);
      expect(await count('meta.events')).toBe(0);
    });

    it('refuses a value that does not fit, a non-member, a duplicate single link and a cycle', async () => {
      const one = (fields: Record<string, unknown>, createdBy: Id<'usr'> | null = null) => ({
        kind: 'records' as const,
        tableId: ids.orders,
        records: [
          {
            id: newId('rec'),
            auto: 20,
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
            createdBy,
            updatedBy: null,
            fields,
          },
        ],
      });
      await expect(
        records.loadPackageBatch(scopeA, hiddenA, one({ [ids.amount]: 'many' })),
      ).rejects.toMatchObject({ code: 'INVALID_CELL_VALUE' });
      await expect(
        records.loadPackageBatch(scopeA, hiddenA, one({}, b.userId)),
      ).rejects.toMatchObject({ code: 'INVALID_CELL_VALUE' });
      await expect(
        records.loadPackageBatch(scopeA, hiddenA, {
          kind: 'links',
          fieldId: ids.link,
          rows: [{ a: rec.r1, b: rec.c1, position: 1 }],
        }),
      ).rejects.toMatchObject({ code: 'UNIQUE_VIOLATION' });
      await expect(
        records.loadPackageBatch(scopeA, hiddenA, {
          kind: 'parents',
          tableId: ids.orders,
          rows: [{ id: rec.r1, parentId: rec.r2 }],
        }),
      ).rejects.toMatchObject({ code: 'SUBRECORD_CYCLE' });
    });

    it('never writes into a visible base, another job’s base or another organization', async () => {
      const live = await schema.createTable(
        scopeA,
        { baseId: a.baseId, name: 'Live', primaryFieldName: 'Name' },
        systemAuditContext(),
      );
      const batch = {
        kind: 'records' as const,
        tableId: live.table.id,
        records: [
          {
            id: newId('rec'),
            auto: 1,
            createdAt: '2020-01-01T00:00:00.000Z',
            updatedAt: '2020-01-01T00:00:00.000Z',
            createdBy: null,
            updatedBy: null,
            fields: {},
          },
        ],
      };
      await expect(
        records.loadPackageBatch(scopeA, { baseId: a.baseId, importJobId: jobA }, batch),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(records.loadPackageBatch(scopeA, hiddenA, batch)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(
        records.loadPackageBatch(scopeB, hiddenA, { ...batch, tableId: ids.orders }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        records.loadPackageBatch(
          scopeA,
          { ...hiddenA, importJobId: jobB },
          {
            ...batch,
            tableId: ids.orders,
          },
        ),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('repository queries of a purge, by organization', () => {
    it('lists and deletes nothing of another organization or another job', async () => {
      const tables = new TablesRepository(db);
      const files = new AttachmentsRepository(db);
      const file = await files.create(scopeA, {
        baseId: hiddenA.baseId,
        tableId: ids.orders,
        fieldId: ids.files,
        createdBy: a.userId,
        filename: 'a.txt',
        mime: 'text/plain',
        size: 1,
      });
      expect(
        (await tables.listOfImportingBase(scopeA, hiddenA.baseId, jobA)).map((t) => t.id).sort(),
      ).toEqual([ids.orders, ids.customers].sort());
      expect(await tables.listOfImportingBase(scopeB, hiddenA.baseId, jobA)).toEqual([]);
      expect(await tables.listOfImportingBase(scopeA, hiddenA.baseId, jobB)).toEqual([]);
      expect(await tables.listOfImportingBase(scopeA, a.baseId, jobA)).toEqual([]);
      expect(await files.objectKeysOfImportingBase(scopeA, hiddenA.baseId, jobA)).toEqual([
        file.object_key,
      ]);
      expect(await files.objectKeysOfImportingBase(scopeB, hiddenA.baseId, jobA)).toEqual([]);
      expect(await files.deleteOfImportingBase(scopeB, hiddenA.baseId, jobA)).toBe(0);
      expect(await tables.deleteOfImportingBase(scopeB, hiddenA.baseId, jobA)).toBe(0);
      const covers = new FormCoversRepository(db);
      const assets = new EmailAssetsRepository(db);
      expect(await covers.objectKeysOfImportingBase(scopeB, hiddenA.baseId, jobA)).toEqual([]);
      expect(await covers.deleteOfImportingBase(scopeB, hiddenA.baseId, jobA)).toBe(0);
      expect(await assets.objectKeysOfImportingBase(scopeB, hiddenA.baseId, jobA)).toEqual([]);
      expect(await assets.deleteOfImportingBase(scopeB, hiddenA.baseId, jobA)).toBe(0);
      const bases = new BasesRepository(db);
      expect(await bases.deleteImporting(scopeB, hiddenA.baseId, jobA)).toBe(false);
      expect(await bases.finishImport(scopeB, hiddenA.baseId, jobA)).toBeUndefined();
      expect(await bases.finishImport(scopeA, hiddenA.baseId, jobB)).toBeUndefined();
      expect(await files.getById(scopeA, file.id)).toBeDefined();
    });
  });

  describe('SchemaService.purgeBase', () => {
    it('does nothing to a visible base, another job’s base or another organization', async () => {
      expect(await schema.purgeBase(scopeA, { baseId: a.baseId, importJobId: jobA })).toBeNull();
      expect(await schema.purgeBase(scopeA, { ...hiddenA, importJobId: jobB })).toBeNull();
      expect(await schema.purgeBase(scopeB, hiddenA)).toBeNull();
      expect(await new BasesRepository(db).getById(scopeA, a.baseId)).toBeDefined();
    });

    it('drops every data table and junction of the hidden base and deletes its meta rows', async () => {
      const dataTables = async () =>
        Number(
          (
            await sql<{
              n: string;
            }>`SELECT count(*)::text AS n FROM pg_tables WHERE schemaname = 'data'`.execute(
              db.kysely,
            )
          ).rows[0]?.n,
        );
      const before = await dataTables();
      const audit = await count('meta.audit_logs');
      expect(await schema.purgeBase(scopeA, hiddenA)).toEqual({ tables: 2, junctions: 1 });
      // Orders, Customers and their junction are gone; the live table stays.
      expect(await dataTables()).toBe(before - 3);
      for (const table of ['meta.tables', 'meta.fields', 'meta.attachments', 'meta.base_roles']) {
        const { rows } = await sql<{ n: string }>`
          SELECT count(*)::text AS n FROM ${sql.table(table)}
           WHERE ${sql.ref(table === 'meta.fields' ? 'table_id' : 'base_id')} IN (${sql.join(
             table === 'meta.fields' ? [ids.orders, ids.customers] : [hiddenA.baseId],
           )})
        `.execute(db.kysely);
        expect(Number(rows[0]?.n), table).toBe(0);
      }
      expect(await new BasesRepository(db).findImporting(scopeA, jobA)).toBeUndefined();
      // The other organization's hidden base is untouched.
      expect(await new BasesRepository(db).findImporting(scopeB, jobB)).toBeDefined();
      expect(await count('meta.audit_logs')).toBe(audit);
    });
  });
});
