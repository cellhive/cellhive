/**
 * SchemaService operations added for the table/field API (T103): table
 * update/reorder/restore, combined field update and reorder, the
 * `schema.remove_select_options` job and its record write through
 * `RecordMutationService`, `permission_version` and the schema change
 * publisher.
 */
import { newId, type Id } from '@cellhive/contracts';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemAuditContext } from '../../src/audit/index.js';
import { orgScope, type Db, type OrgScope } from '../../src/db/index.js';
import { AppError } from '../../src/errors/index.js';
import {
  RecordMutationService,
  type RecordAccessContext,
  type RecordChange,
} from '../../src/records/index.js';
import { SchemaService, type SchemaChange, type CreatedTable } from '../../src/schema/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { queuedJobs, userContext } from '../support/schema.js';
import { seedTenant, type SeededTenant } from '../support/tenant.js';

import type { FieldRow, TableRow } from '../../src/db/schema.js';

const ORG_A: Id<'org'> = 'org_SchemaMgmtOrgA01';
const ORG_B: Id<'org'> = 'org_SchemaMgmtOrgB01';

async function appError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected an AppError');
}

describe('SchemaService management operations (T103)', () => {
  let database: TestDatabase;
  let db: Db;
  let admin: pg.Pool;
  let schema: SchemaService;
  let tenant: SeededTenant;
  let scope: OrgScope;
  const published: SchemaChange[] = [];
  const recordChanges: RecordChange[][] = [];

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    admin = new pg.Pool({ connectionString: database.adminUrl, max: 2 });
    tenant = await seedTenant(db, ORG_A);
    await seedTenant(db, ORG_B);
    scope = orgScope(ORG_A);
    schema = new SchemaService(db, {
      maxFieldsPerTable: 500,
      publisher: { publish: (change) => void published.push(change) },
    });
  });

  afterAll(async () => {
    await admin.end();
    await db.destroy();
    await database.drop();
  });

  const ctx = () => userContext(tenant.userId);

  async function permissionVersion(): Promise<bigint> {
    const row = await db.kysely
      .selectFrom('meta.bases')
      .select('permission_version')
      .where('id', '=', tenant.baseId)
      .executeTakeFirstOrThrow();
    return row.permission_version;
  }

  async function events(entityId: string, type: string) {
    return db.kysely
      .selectFrom('meta.events')
      .selectAll()
      .where('entity_id', '=', entityId)
      .where('type', '=', type)
      .execute();
  }

  async function audits(entityId: string, action: string) {
    return db.kysely
      .selectFrom('meta.audit_logs')
      .selectAll()
      .where('entity_id', '=', entityId)
      .where('action', '=', action)
      .orderBy('created_at')
      .execute();
  }

  async function newTable(name: string): Promise<CreatedTable> {
    return schema.createTable(
      scope,
      { baseId: tenant.baseId, name, primaryFieldName: 'Name' },
      ctx(),
    );
  }

  async function tableOrder(): Promise<string[]> {
    const rows = await db.kysely
      .selectFrom('meta.tables')
      .select(['name'])
      .where('base_id', '=', tenant.baseId)
      .where('deleted_at', 'is', null)
      .orderBy('position')
      .orderBy('id')
      .execute();
    return rows.map((row) => row.name);
  }

  describe('tables', () => {
    it('bumps permission_version and publishes on create, delete and restore, not on rename', async () => {
      const v0 = await permissionVersion();
      published.length = 0;
      const { table } = await newTable('Versioned');
      expect(await permissionVersion()).toBe(v0 + 1n);
      await schema.updateTable(scope, table.id, { name: 'Versioned 2' }, ctx());
      expect(await permissionVersion()).toBe(v0 + 1n);
      await schema.deleteTable(scope, table.id, ctx());
      expect(await permissionVersion()).toBe(v0 + 2n);
      const restored = await schema.restoreTable(scope, table.id, ctx());
      expect(restored.deleted_at).toBeNull();
      expect(await permissionVersion()).toBe(v0 + 3n);
      expect(published.map((change) => change.action)).toEqual([
        'created',
        'updated',
        'deleted',
        'restored',
      ]);
      expect(published[0]).toEqual({
        organization_id: ORG_A,
        base_id: tenant.baseId,
        table_id: table.id,
        entity: 'table',
        entity_id: table.id,
        action: 'created',
      });
      expect(await events(table.id, 'table.restored')).toHaveLength(1);
      expect(await audits(table.id, 'table.restored')).toHaveLength(1);
    });

    it('updates the description and moves a table in the display order with one event', async () => {
      const a = await newTable('Order A');
      const b = await newTable('Order B');
      const c = await newTable('Order C');
      const before = await tableOrder();
      expect(before.slice(-3)).toEqual(['Order A', 'Order B', 'Order C']);
      const moved = await schema.updateTable(
        scope,
        c.table.id,
        { description: 'Third', position: before.indexOf('Order A') },
        ctx(),
      );
      expect(moved.description).toBe('Third');
      const after = await tableOrder();
      expect(after.slice(-3)).toEqual(['Order C', 'Order A', 'Order B']);
      const [entry] = await audits(c.table.id, 'table.updated');
      expect(entry?.before).toEqual({ description: null, position: before.indexOf('Order C') });
      expect(entry?.after).toEqual({ description: 'Third', position: before.indexOf('Order A') });
      // Beyond the end is clamped; nothing changes → no event.
      await schema.updateTable(scope, b.table.id, { position: 10_000 }, ctx());
      expect((await tableOrder()).at(-1)).toBe('Order B');
      const count = (await events(a.table.id, 'table.updated')).length;
      await schema.updateTable(scope, a.table.id, { name: 'Order A' }, ctx());
      expect(await events(a.table.id, 'table.updated')).toHaveLength(count);
    });

    it('restores a table at the end, refusing a name taken meanwhile', async () => {
      const { table } = await newTable('Trash me');
      await schema.deleteTable(scope, table.id, ctx());
      const clash = await newTable('Trash me');
      expect((await appError(schema.restoreTable(scope, table.id, ctx()))).code).toBe(
        'NAME_CONFLICT',
      );
      await schema.updateTable(scope, clash.table.id, { name: 'Taken' }, ctx());
      await schema.restoreTable(scope, table.id, ctx());
      expect((await tableOrder()).at(-1)).toBe('Trash me');
      // Another organization cannot restore it.
      expect(
        (await appError(schema.restoreTable(orgScope(ORG_B), table.id, systemAuditContext()))).code,
      ).toBe('NOT_FOUND');
    });
  });

  describe('fields', () => {
    let table: TableRow;
    let primary: FieldRow;

    beforeAll(async () => {
      const created = await newTable('Fields');
      table = created.table;
      primary = created.primaryField;
    });

    it('bumps permission_version on field create/delete/restore and publishes each change', async () => {
      const v0 = await permissionVersion();
      published.length = 0;
      const field = await schema.addField(scope, table.id, { name: 'Qty', type: 'number' }, ctx());
      await schema.updateField(scope, field.id, { description: 'How many' }, ctx());
      await schema.deleteField(scope, field.id, ctx());
      await schema.restoreField(scope, field.id, ctx());
      expect(await permissionVersion()).toBe(v0 + 3n);
      expect(published.map((change) => [change.entity, change.entity_id, change.action])).toEqual([
        ['field', field.id, 'created'],
        ['field', field.id, 'updated'],
        ['field', field.id, 'deleted'],
        ['field', field.id, 'restored'],
      ]);
    });

    it('renames, restyles and moves a field in one transaction with the changed keys only', async () => {
      const first = await schema.addField(
        scope,
        table.id,
        { name: 'Price', type: 'number' },
        ctx(),
      );
      await schema.addField(scope, table.id, { name: 'Other', type: 'text' }, ctx());
      const updated = await schema.updateField(
        scope,
        first.id,
        {
          name: 'Unit price',
          options: { style: { type: 'currency', precision: 0, currency_code: 'VND' } },
          position: 0,
        },
        ctx(),
      );
      expect(updated).toMatchObject({ name: 'Unit price', position: 0 });
      const fields = await db.kysely
        .selectFrom('meta.fields')
        .select(['id', 'position'])
        .where('table_id', '=', table.id)
        .where('deleted_at', 'is', null)
        .orderBy('position')
        .execute();
      expect(fields[0]?.id).toBe(first.id);
      expect(fields[1]?.id).toBe(primary.id);
      const entries = await audits(first.id, 'field.updated');
      expect(entries).toHaveLength(1);
      expect(Object.keys(entries[0]?.after as object).sort()).toEqual([
        'name',
        'options',
        'position',
      ]);
      expect(entries[0]?.before).toMatchObject({ name: 'Price' });
      // Nothing changes → no event.
      await schema.updateField(scope, first.id, { name: 'Unit price' }, ctx());
      expect(await audits(first.id, 'field.updated')).toHaveLength(1);
    });

    it('queues schema.remove_select_options when options disappear, not on rename or recolour', async () => {
      const keep = newId('opt');
      const drop = newId('opt');
      const field = await schema.addField(
        scope,
        table.id,
        {
          name: 'Status',
          type: 'select',
          options: {
            options: [
              { id: keep, name: 'Open' },
              { id: drop, name: 'Closed' },
            ],
          },
        },
        ctx(),
      );
      const jobsOf = async () =>
        (await queuedJobs(db, 'schema.remove_select_options')).filter(
          (job) => job.payload.field_id === field.id,
        );
      await schema.updateField(
        scope,
        field.id,
        {
          options: {
            options: [
              { id: drop, name: 'Done', color: 3 },
              { id: keep, name: 'Open' },
            ],
          },
        },
        ctx(),
      );
      expect(await jobsOf()).toEqual([]);
      await schema.updateField(
        scope,
        field.id,
        { options: { options: [{ id: keep, name: 'Open' }] } },
        ctx(),
      );
      const jobs = await jobsOf();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({
        queue_name: `schema:${table.id}`,
        payload: {
          organization_id: ORG_A,
          table_id: table.id,
          field_id: field.id,
          option_ids: [drop],
        },
      });
      const jobId = String(jobs[0]?.payload.batch_id);
      expect(jobId).toMatch(/^job_[0-9A-Za-z]{16}$/);
      // Trackable with GET /jobs/:id: a meta.jobs row created by the caller.
      const row = await db.kysely
        .selectFrom('meta.jobs')
        .selectAll()
        .where('id', '=', jobId as Id<'job'>)
        .executeTakeFirstOrThrow();
      expect(row).toMatchObject({
        organization_id: ORG_A,
        type: 'schema.remove_select_options',
        status: 'queued',
        created_by: tenant.userId,
      });
      // The field.updated event names the job.
      const events = await db.kysely
        .selectFrom('meta.events')
        .select('payload')
        .where('entity_id', '=', field.id)
        .where('type', '=', 'field.updated')
        .execute();
      expect(
        events.map((event) => (event.payload as { data?: { job_id?: string } }).data?.job_id),
      ).toContain(jobId);
    });

    it('keeps DDL-free changes working when the publisher fails', async () => {
      const failures: unknown[] = [];
      const flaky = new SchemaService(db, {
        maxFieldsPerTable: 500,
        publisher: { publish: () => Promise.reject(new Error('ws down')) },
        onPublishError: (error) => failures.push(error),
      });
      const renamed = await flaky.updateField(scope, primary.id, { name: 'Title' }, ctx());
      expect(renamed.name).toBe('Title');
      expect(failures).toHaveLength(1);
    });
  });

  describe('RecordMutationService.removeSelectOptionValues', () => {
    it('removes deleted option ids from live and trashed records in batches, with events and audit', async () => {
      const { table, primaryField } = await newTable('Tagged');
      const [a, b, c] = [newId('opt'), newId('opt'), newId('opt')];
      const tags = await schema.addField(
        scope,
        table.id,
        {
          name: 'Tags',
          type: 'select',
          options: {
            multiple: true,
            options: [
              { id: a, name: 'A' },
              { id: b, name: 'B' },
              { id: c, name: 'C' },
            ],
          },
        },
        ctx(),
      );
      const records = new RecordMutationService(db, {
        schema,
        publisher: { publish: (changes) => void recordChanges.push([...changes]) },
      });
      const access: RecordAccessContext = {
        baseId: tenant.baseId,
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
                fields: { [primaryField.id]: 'edit', [tags.id]: 'edit' },
                option_edit_fields: [tags.id],
                file_download_fields: [],
              },
            },
            dashboards: {},
          },
          internal: { editFilters: { [table.id]: null }, readFilters: { [table.id]: null } },
        },
        userId: tenant.userId,
        groupMemberUserIds: [],
        timeZone: 'UTC',
        locale: 'en',
      };
      const requestId = newId('req');
      const created = await records.create(
        scope,
        table.id,
        access,
        {
          field_key_type: 'id',
          records: [
            { fields: { [primaryField.id]: 'r1', [tags.id]: ['A', 'B'] } },
            { fields: { [primaryField.id]: 'r2', [tags.id]: ['B'] } },
            { fields: { [primaryField.id]: 'r3', [tags.id]: ['C'] } },
            { fields: { [primaryField.id]: 'r4', [tags.id]: ['B', 'C'] } },
          ],
        },
        { ...ctx(), batch_id: requestId, request_id: requestId },
      );
      const [r1, r2, r3, r4] = created.records.map((record) => record.id);
      await records.delete(
        scope,
        table.id,
        access,
        { ids: [r4 as string] },
        { ...ctx(), batch_id: requestId, request_id: requestId },
      );
      await schema.updateField(
        scope,
        tags.id,
        {
          options: {
            multiple: true,
            options: [
              { id: a, name: 'A' },
              { id: c, name: 'C' },
            ],
          },
        },
        ctx(),
      );
      const [job] = (await queuedJobs(db, 'schema.remove_select_options')).filter(
        (queued) => queued.payload.field_id === tags.id,
      );
      const batchId = job?.payload.batch_id as Id<'job'>;
      recordChanges.length = 0;

      // Another organization cannot touch the table.
      expect(
        (
          await appError(
            records.removeSelectOptionValues(
              orgScope(ORG_B),
              table.id,
              tags.id,
              [b],
              systemAuditContext(batchId),
            ),
          )
        ).code,
      ).toBe('NOT_FOUND');

      const result = await records.removeSelectOptionValues(
        scope,
        table.id,
        tags.id,
        [b, c],
        systemAuditContext(batchId),
        { batchSize: 1 },
      );
      // `c` still exists in the field: only `b` is removed.
      expect(result).toEqual({ updated: 3, fieldFound: true });
      const column = tags.db_column_name as string;
      const { rows } = await admin.query<{ __id: string; value: string[] | null; v: number }>(
        `SELECT __id, ${pg.escapeIdentifier(column)} AS value, __version AS v, __updated_by
           FROM data.${pg.escapeIdentifier(table.db_table_name)} ORDER BY __auto`,
      );
      expect(rows.map((row) => [row.__id, row.value])).toEqual([
        [r1, [a]],
        [r2, null],
        [r3, [c]],
        [r4, [c]],
      ]);
      expect(rows.map((row) => row.v)).toEqual([2, 2, 1, 3]);

      const entries = await db.kysely
        .selectFrom('meta.audit_logs')
        .selectAll()
        .where('batch_id', '=', batchId)
        .orderBy('entity_id')
        .execute();
      expect(entries.map((entry) => entry.entity_id).sort()).toEqual([r1, r2, r4].sort());
      expect(entries[0]).toMatchObject({
        action: 'record.updated',
        actor_type: 'system',
        actor_id: null,
        table_id: table.id,
      });
      const r2Entry = entries.find((entry) => entry.entity_id === r2);
      expect(r2Entry?.before).toEqual({ [tags.id]: [b] });
      expect(r2Entry?.after).toEqual({ [tags.id]: null });
      const updatedEvents = await events(r1 as string, 'record.updated');
      expect(updatedEvents.at(-1)?.payload).toMatchObject({
        changes: { [tags.id]: { from: [a, b], to: [a] } },
      });
      // One publish per batch of one live record (the trashed r4 is in nobody's view).
      expect(recordChanges.map((batch) => batch.length)).toEqual([1, 1]);
      expect(
        recordChanges
          .flat()
          .map((change) => change.recordId as string)
          .sort(),
      ).toEqual([r1, r2].sort());
      // Realtime (T210): images before/after and the new value in json form (option names).
      expect(recordChanges.flat().find((change) => change.recordId === r2)).toMatchObject({
        type: 'record.updated',
        eventId: expect.stringMatching(/^evt_/) as unknown,
        actorUserId: null,
        changedFieldIds: [tags.id],
        before: { [tags.id]: [b] },
        after: { [tags.id]: null },
        values: { [tags.id]: null },
      });
      expect(recordChanges.flat().find((change) => change.recordId === r1)?.values).toEqual({
        [tags.id]: ['A'],
      });

      // Idempotent: a second run finds nothing.
      expect(
        await records.removeSelectOptionValues(
          scope,
          table.id,
          tags.id,
          [b],
          systemAuditContext(batchId),
        ),
      ).toEqual({ updated: 0, fieldFound: true });
      // A field that is gone ends the work.
      await schema.deleteField(scope, tags.id, ctx());
      expect(
        await records.removeSelectOptionValues(
          scope,
          table.id,
          tags.id,
          [b],
          systemAuditContext(batchId),
        ),
      ).toEqual({ updated: 0, fieldFound: false });
    });
  });
});
