/**
 * Table purge (BACKLOG T461, CONTRACTS §13, ADR-23 §3) on PostgreSQL 18:
 * `SchemaService.purgeTable` drops the data table and every junction
 * touching it, puts the link fields of other tables in the trash for good
 * (`LINK_TABLE_PURGED`), deletes views, revokes share links, hands files to
 * the cleanup (shared objects kept), writes `table.purged`; the new
 * repository methods and the cross-tenant lookup are scoped. The HTTP API
 * and the worker are tested in their own packages.
 */
import { randomBytes } from 'node:crypto';

import { newId, type Id } from '@cellhive/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemAuditContext, type AuditContext } from '../../src/audit/index.js';
import { listExpiredTrashedTables, orgScope, type Db } from '../../src/db/index.js';
import { AppError } from '../../src/errors/index.js';
import { AttachmentsRepository } from '../../src/records/attachments/index.js';
import { RecordMutationService, type RecordAccessContext } from '../../src/records/index.js';
import {
  FieldConversionsRepository,
  FieldsRepository,
  SchemaService,
  TablesRepository,
  type SchemaChange,
  type TablePurgeHookInput,
} from '../../src/schema/index.js';
import { ShareLinksRepository } from '../../src/share-links/index.js';
import { ViewsRepository } from '../../src/views/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { expectConsistent, userContext } from '../support/schema.js';
import { seedTenant, type SeededTenant } from '../support/tenant.js';

import type { FieldRow, TableRow } from '../../src/db/schema.js';

const ORG_A: Id<'org'> = 'org_T461TablePurgeOA';
const ORG_B: Id<'org'> = 'org_T461TablePurgeOB';
const DAY = 24 * 60 * 60 * 1000;

async function appError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected an AppError');
}

describe('table purge (T461, PostgreSQL 18)', () => {
  let database: TestDatabase;
  let db: Db;
  let schema: SchemaService;
  let records: RecordMutationService;
  let fields: FieldsRepository;
  let tables: TablesRepository;
  let attachments: AttachmentsRepository;
  let a: SeededTenant;
  let b: SeededTenant;
  const published: SchemaChange[] = [];
  const hooked: TablePurgeHookInput[] = [];
  const scopeA = orgScope(ORG_A);
  const scopeB = orgScope(ORG_B);

  // Organization A: Customers (purged), Orders, Lines, Notes.
  let customers: TableRow;
  let orders: TableRow;
  let lines: TableRow;
  let notes: TableRow;
  /** Orders → Customers, one-way. */
  let orderCustomer: FieldRow;
  /** Customers ↔ Lines, two-way (created from Customers). */
  let customerLines: FieldRow;
  /** The reverse field of `customerLines`, in Lines. */
  let lineCustomers: FieldRow;
  /** Customers ↔ Customers, self-link. */
  let selfLink: FieldRow;
  /** Notes → Customers, one-way, already in the trash before the purge. */
  let noteCustomer: FieldRow;
  let customerFiles: FieldRow;
  let orderFiles: FieldRow;
  let shareLinkId: Id<'shl'>;
  let sharedFileKey: string;
  const rec: Record<string, Id<'rec'>> = {};
  // Organization B: an identical Customers table, never touched.
  let customersB: TableRow;

  const ctx = (): AuditContext => userContext(a.userId);

  async function adminAccess(t: SeededTenant, list: readonly TableRow[]) {
    const entries = await Promise.all(
      list.map(async (table) => {
        const tableFields = await fields.listByTable(orgScope(t.orgId), table.id);
        return [
          table.id,
          {
            perm: 'manage' as const,
            operations: ['add' as const, 'delete' as const],
            view_rule: { allow_edit: true, visible_views: null },
            read_scope: 'all' as const,
            fields: Object.fromEntries(tableFields.map((field) => [field.id, 'edit' as const])),
            option_edit_fields: [],
            file_download_fields: [],
          },
        ] as const;
      }),
    );
    return {
      baseId: t.baseId,
      resolved: {
        access: {
          role: null,
          is_admin: true,
          base_rule: { copy: true, download: true, share_link: true },
          tables: Object.fromEntries(entries),
          dashboards: {},
        },
        internal: {
          editFilters: Object.fromEntries(list.map((table) => [table.id, null])),
          readFilters: Object.fromEntries(list.map((table) => [table.id, null])),
        },
      },
      userId: t.userId,
      groupMemberUserIds: [],
      timeZone: 'UTC',
      locale: 'en',
    } as unknown as RecordAccessContext;
  }

  async function create(
    t: SeededTenant,
    table: TableRow,
    access: RecordAccessContext,
    name: string,
    cells: Record<string, unknown> = {},
  ): Promise<Id<'rec'>> {
    const primary = (await fields.listByTable(orgScope(t.orgId), table.id)).find(
      (field) => field.is_primary,
    ) as FieldRow;
    const result = await records.create(
      orgScope(t.orgId),
      table.id,
      access,
      { field_key_type: 'id', records: [{ fields: { [primary.id]: name, ...cells } }] },
      userContext(t.userId),
    );
    const id = result.records[0]?.id as Id<'rec'>;
    rec[name] = id;
    return id;
  }

  async function regclass(name: string): Promise<string | null> {
    const { rows } = await sql<{ oid: string | null }>`
      SELECT to_regclass(${`data.${name}`})::text AS oid
    `.execute(db.kysely);
    return rows[0]?.oid ?? null;
  }

  async function field(id: Id<'fld'>): Promise<FieldRow> {
    const row = await fields.getById(scopeA, id, { includeDeleted: true });
    if (row === undefined) throw new Error('no field');
    return row;
  }

  async function audits(action: string, org: Id<'org'> = ORG_A) {
    return db.kysely
      .selectFrom('meta.audit_logs')
      .select(['entity_id', 'table_id', 'actor_type', 'actor_id', 'before', 'after', 'batch_id'])
      .where('organization_id', '=', org)
      .where('action', '=', action)
      .orderBy('created_at')
      .orderBy('id')
      .execute();
  }

  async function events(type: string) {
    const rows = await db.kysely
      .selectFrom('meta.events')
      .select(['entity_id', 'payload'])
      .where('organization_id', '=', ORG_A)
      .where('type', '=', type)
      .orderBy('created_at')
      .execute();
    return rows.map((row) => ({
      entity_id: row.entity_id,
      data: (row.payload as { data?: unknown }).data,
    }));
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    schema = new SchemaService(db, {
      maxFieldsPerTable: 500,
      publisher: { publish: (change) => void published.push(change) },
      tablePurgeHooks: {
        onTablePurged: (_tx, input) => {
          hooked.push(input);
          return Promise.resolve();
        },
      },
    });
    records = new RecordMutationService(db, { schema });
    fields = new FieldsRepository(db);
    tables = new TablesRepository(db);
    attachments = new AttachmentsRepository(db);
    a = await seedTenant(db, ORG_A);
    b = await seedTenant(db, ORG_B);

    const setup = systemAuditContext();
    const table = async (t: SeededTenant, name: string) =>
      (
        await schema.createTable(
          orgScope(t.orgId),
          { baseId: t.baseId, name, primaryFieldName: 'Name' },
          setup,
        )
      ).table;
    customers = await table(a, 'Customers');
    orders = await table(a, 'Orders');
    lines = await table(a, 'Chi tiết đơn hàng');
    notes = await table(a, 'Notes');
    customersB = await table(b, 'Customers');

    orderCustomer = await schema.addField(
      scopeA,
      orders.id,
      { name: 'customer', type: 'link', options: { link_table: customers.id } },
      setup,
    );
    customerLines = await schema.addField(
      scopeA,
      customers.id,
      {
        name: 'lines',
        type: 'link',
        options: { link_table: lines.id, bidirectional: true },
      },
      setup,
    );
    lineCustomers = (await fields.listByJunction(scopeA, customerLines.link_junction ?? '')).find(
      (row) => row.link_side === 'b',
    ) as FieldRow;
    selfLink = await schema.addField(
      scopeA,
      customers.id,
      {
        name: 'referrer',
        type: 'link',
        options: { link_table: customers.id, bidirectional: true },
      },
      setup,
    );
    noteCustomer = await schema.addField(
      scopeA,
      notes.id,
      { name: 'about', type: 'link', options: { link_table: customers.id } },
      setup,
    );
    customerFiles = await schema.addField(
      scopeA,
      customers.id,
      { name: 'files', type: 'attachment', options: {} },
      setup,
    );
    orderFiles = await schema.addField(
      scopeA,
      orders.id,
      { name: 'files', type: 'attachment', options: {} },
      setup,
    );

    const access = await adminAccess(a, [customers, orders, lines, notes]);
    const c1 = await create(a, customers, access, 'c1');
    await create(a, customers, access, 'c2', { [selfLink.id]: [c1] });
    await create(a, orders, access, 'o1', { [orderCustomer.id]: [c1] });
    await create(a, lines, access, 'l1', { [lineCustomers.id]: [c1] });
    await create(a, notes, access, 'n1', { [noteCustomer.id]: [c1] });
    const accessB = await adminAccess(b, [customersB]);
    await create(b, customersB, accessB, 'b1');

    // A file of c1 whose object an Orders record shares (S4 #12 copies).
    const file = await attachments.create(scopeA, {
      baseId: a.baseId,
      tableId: customers.id,
      fieldId: customerFiles.id,
      createdBy: a.userId,
      filename: 'contract.pdf',
      mime: 'application/pdf',
      size: 10,
    });
    await attachments.markReady(scopeA, file.id, { size: 10, sha256: 'a'.repeat(64) });
    await attachments.attach(scopeA, [file.id], c1);
    sharedFileKey = file.object_key;
    await db.kysely
      .insertInto('meta.attachments')
      .values({
        id: newId('att'),
        organization_id: ORG_A,
        base_id: a.baseId,
        table_id: orders.id,
        field_id: orderFiles.id,
        record_id: rec.o1 ?? null,
        object_key: sharedFileKey,
        filename: 'contract.pdf',
        mime: 'application/pdf',
        size: 10,
        sha256: 'a'.repeat(64),
        status: 'ready',
        created_by: a.userId,
      })
      .execute();

    // A share link of the default view of Customers.
    const [view] = await new ViewsRepository(db).listByTable(scopeA, customers.id, null);
    shareLinkId = newId('shl');
    await new ShareLinksRepository(db).insert(scopeA, {
      id: shareLinkId,
      baseId: a.baseId,
      tableId: customers.id,
      targetType: 'view',
      targetId: view?.id ?? '',
      audience: 'public',
      tokenPrefix: 'abcdef',
      tokenHash: randomBytes(32).toString('hex'),
      passwordHash: null,
      expiresAt: null,
      settings: {},
      enabled: true,
      createdBy: a.userId,
    });

    // Notes.about is in the trash before the purge (still restorable then).
    await schema.deleteField(scopeA, noteCustomer.id, setup);
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('refuses a table outside the trash and a wrong confirmation', async () => {
    const live = await appError(
      schema.purgeTable(
        scopeA,
        customers.id,
        { reason: 'manual', confirmName: 'Customers' },
        ctx(),
      ),
    );
    expect(live.status).toBe(422);
    expect(live.errors).toEqual([expect.objectContaining({ code: 'TABLE_NOT_IN_TRASH' })]);
    // The retention job simply skips it.
    expect(
      await schema.purgeTable(scopeA, customers.id, { reason: 'retention' }, systemAuditContext()),
    ).toBeNull();

    await schema.deleteTable(scopeA, customers.id, ctx());
    for (const confirmName of ['customers', 'Orders', '', undefined]) {
      const wrong = await appError(
        schema.purgeTable(
          scopeA,
          customers.id,
          { reason: 'manual', ...(confirmName === undefined ? {} : { confirmName }) },
          ctx(),
        ),
      );
      expect(wrong.errors).toEqual([
        expect.objectContaining({ path: 'confirm_name', code: 'CONFIRM_NAME_MISMATCH' }),
      ]);
    }
    // Deleted after the retention cutoff: not yet.
    expect(
      await schema.purgeTable(
        scopeA,
        customers.id,
        { reason: 'retention', deletedBefore: new Date(Date.now() - 30 * DAY) },
        systemAuditContext(),
      ),
    ).toBeNull();
    // Another organization cannot see it.
    expect(
      (
        await appError(
          schema.purgeTable(
            scopeB,
            customers.id,
            { reason: 'manual', confirmName: 'Customers' },
            userContext(b.userId),
          ),
        )
      ).code,
    ).toBe('NOT_FOUND');
    expect(await regclass(customers.db_table_name)).not.toBeNull();
    expect(await audits('table.purged')).toEqual([]);
  });

  it('drops the table and its junctions and trashes the link fields pointing at it', async () => {
    const versionBefore = await permissionVersion(a.baseId);
    published.length = 0;
    const result = await schema.purgeTable(
      scopeA,
      customers.id,
      { reason: 'manual', confirmName: ' Customers ' },
      ctx(),
    );
    expect(result?.recordCount).toBe(2);
    const partners = [orderCustomer.id, lineCustomers.id, noteCustomer.id].sort();
    expect([...(result?.partnerFieldIds ?? [])].sort()).toEqual(partners);

    // Physical objects are gone (the other tables stay).
    expect(await regclass(customers.db_table_name)).toBeNull();
    for (const link of [orderCustomer, customerLines, selfLink, noteCustomer]) {
      expect(await regclass(link.link_junction ?? '')).toBeNull();
    }
    expect(await regclass(orders.db_table_name)).not.toBeNull();
    expect(await regclass(lines.db_table_name)).not.toBeNull();

    // The table is gone for every lookup; a restore is `404`.
    expect(await tables.getById(scopeA, customers.id, { includeDeleted: true })).toBeUndefined();
    expect(await tables.listIds(scopeA)).not.toContain(customers.id);
    expect((await appError(schema.restoreTable(scopeA, customers.id, ctx()))).code).toBe(
      'NOT_FOUND',
    );
    const row = await db.kysely
      .selectFrom('meta.tables')
      .select(['purged_at', 'deleted_at'])
      .where('id', '=', customers.id)
      .executeTakeFirstOrThrow();
    expect(row.purged_at).not.toBeNull();

    // Link fields of other tables: in the trash, not restorable.
    for (const id of [orderCustomer.id, lineCustomers.id, noteCustomer.id]) {
      const partner = await field(id);
      expect(partner.deleted_at).not.toBeNull();
      expect(partner.link_table_purged_at).not.toBeNull();
      expect(partner.purged_at).toBeNull();
      const restore = await appError(schema.restoreField(scopeA, id, ctx()));
      expect({ status: restore.status, code: restore.code }).toEqual({
        status: 422,
        code: 'VALIDATION_FAILED',
      });
      expect(restore.errors).toEqual([expect.objectContaining({ code: 'LINK_TABLE_PURGED' })]);
    }
    // Fields of the purged table: purged (the primary field stays as it is).
    const own = await fields.listByTable(scopeA, customers.id, { includeDeleted: true });
    expect(own.filter((f) => !f.is_primary).every((f) => f.purged_at !== null)).toBe(true);

    // The other tables keep their records and a consistent schema.
    await expectConsistent(schema, scopeA, orders.id);
    await expectConsistent(schema, scopeA, lines.id);
    const { rows: orderRows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM ${sql.table(`data.${orders.db_table_name}`)}
    `.execute(db.kysely);
    expect(orderRows[0]?.n).toBe(1);

    // One `field.deleted` for each partner that was active, published after commit.
    const deleted = await audits('field.deleted');
    const byPurge = deleted.filter((entry) =>
      [orderCustomer.id, lineCustomers.id].includes(entry.entity_id as Id<'fld'>),
    );
    expect(byPurge.map((entry) => entry.entity_id).sort()).toEqual(
      [orderCustomer.id, lineCustomers.id].sort(),
    );
    expect(deleted.filter((entry) => entry.entity_id === noteCustomer.id)).toHaveLength(1);
    const deletedEvents = (await events('field.deleted')).filter(
      (event) => event.entity_id === orderCustomer.id,
    );
    expect(deletedEvents[0]?.data).toMatchObject({
      reason: 'table_purged',
      purged_table_id: customers.id,
    });
    expect(
      published
        .filter((change) => change.entity === 'field')
        .map((change) => [change.table_id, change.entity_id, change.action])
        .sort(),
    ).toEqual(
      [
        [orders.id, orderCustomer.id, 'deleted'],
        [lines.id, lineCustomers.id, 'deleted'],
      ].sort(),
    );

    // Views deleted, share link revoked by the purging user.
    expect(await new ViewsRepository(db).listByTable(scopeA, customers.id, null)).toEqual([]);
    const link = await new ShareLinksRepository(db).getById(scopeA, shareLinkId);
    expect(link?.revoked_at).not.toBeNull();
    expect(link?.revoked_by).toBe(a.userId);
    const revoked = await events('share_link.revoked');
    expect(
      revoked.map((event) => [event.entity_id, (event.data as { reason: string }).reason]),
    ).toEqual([[shareLinkId, 'table_purged']]);
    expect((await audits('share_link.revoked'))[0]?.before).toMatchObject({ id: shareLinkId });

    // Files: the table's go to the cleanup, the copy in Orders keeps the object.
    const files = await db.kysely
      .selectFrom('meta.attachments')
      .select(['table_id', 'record_purged_at'])
      .where('organization_id', '=', ORG_A)
      .where('object_key', '=', sharedFileKey)
      .execute();
    expect(files.map((file) => [file.table_id, file.record_purged_at !== null]).sort()).toEqual(
      [
        [customers.id, true],
        [orders.id, false],
      ].sort(),
    );

    // One `table.purged` event and audit entry; permission version bumped; hook ran.
    const summary = await audits('table.purged');
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({
      entity_id: customers.id,
      table_id: customers.id,
      actor_type: 'user',
      actor_id: a.userId,
      before: null,
    });
    const after = summary[0]?.after as {
      name: string;
      record_count: number;
      partner_field_ids: string[];
    };
    expect({ ...after, partner_field_ids: [...after.partner_field_ids].sort() }).toEqual({
      name: 'Customers',
      record_count: 2,
      partner_field_ids: partners,
    });
    expect((await events('table.purged'))[0]?.data).toMatchObject({ reason: 'manual' });
    expect(await permissionVersion(a.baseId)).toBeGreaterThan(versionBefore);
    expect(hooked).toHaveLength(1);
    expect(hooked[0]?.table.id).toBe(customers.id);
    expect(hooked[0]?.partnerFields.map((f) => f.id).sort()).toEqual(partners);

    // Organization B is untouched.
    expect(await regclass(customersB.db_table_name)).not.toBeNull();
    expect(await tables.getById(scopeB, customersB.id)).toBeDefined();
  });

  it('is idempotent: a purged table is missing', async () => {
    expect(
      (
        await appError(
          schema.purgeTable(
            scopeA,
            customers.id,
            { reason: 'manual', confirmName: 'Customers' },
            ctx(),
          ),
        )
      ).code,
    ).toBe('NOT_FOUND');
    expect(await audits('table.purged')).toHaveLength(1);
  });

  it('keeps every new repository method inside its organization', async () => {
    // Org B cannot reach org A's rows through any method added for the purge.
    const now = new Date();
    expect(await tables.listExpiredTrash(scopeB, { before: now, limit: 10 })).toEqual([]);
    expect(await tables.markPurged(scopeB, orders.id, now)).toBeUndefined();
    expect(await fields.listLinksTouching(scopeB, customers.id)).toEqual([]);
    expect(await fields.markTablePurged(scopeB, orders.id, now)).toEqual([]);
    expect(await fields.markLinkTablePurged(scopeB, [orderCustomer.id], now)).toEqual([]);
    expect(await new ViewsRepository(db).deleteByTable(scopeB, orders.id)).toEqual([]);
    expect(await new ShareLinksRepository(db).revokeByTable(scopeB, customers.id, null)).toEqual(
      [],
    );
    const conversions = new FieldConversionsRepository(db);
    expect(await conversions.listTouching(scopeB, orders.id, [orderCustomer.id])).toEqual([]);
    expect(await conversions.markManyCleaned(scopeB, [newId('job')])).toEqual([]);
    expect(await attachments.markTablePurged(scopeB, orders.id, now)).toBe(0);
    // Nothing of org A changed.
    expect(await new ViewsRepository(db).listByTable(scopeA, orders.id, null)).not.toEqual([]);
    expect(await tables.getById(scopeA, orders.id)).toBeDefined();
    expect((await fields.listByTable(scopeA, orders.id)).length).toBeGreaterThan(1);
  });

  it('lists expired trashed tables of every organization (cross-tenant lookup)', async () => {
    const setup = systemAuditContext();
    await schema.deleteTable(scopeA, notes.id, setup);
    await schema.deleteTable(scopeB, customersB.id, setup);
    const all = await listExpiredTrashedTables(db.kysely, {
      before: new Date(Date.now() + DAY),
      after: null,
      limit: 10,
    });
    // Purged tables are not listed; ids only.
    expect(all).toEqual(
      [
        { organizationId: ORG_A, tableId: notes.id },
        { organizationId: ORG_B, tableId: customersB.id },
      ].sort((x, y) => (x.organizationId < y.organizationId ? -1 : 1)),
    );
    const next = await listExpiredTrashedTables(db.kysely, {
      before: new Date(Date.now() + DAY),
      after: all[0] ?? null,
      limit: 10,
    });
    expect(next).toEqual(all.slice(1));
    expect(
      await listExpiredTrashedTables(db.kysely, {
        before: new Date(Date.now() - DAY),
        after: null,
        limit: 10,
      }),
    ).toEqual([]);
    const [expired] = await tables.listExpiredTrash(scopeA, {
      before: new Date(Date.now() + DAY),
      limit: 10,
    });
    expect(expired?.id).toBe(notes.id);
  });

  async function permissionVersion(baseId: Id<'bse'>): Promise<bigint> {
    const row = await db.kysely
      .selectFrom('meta.bases')
      .select('permission_version')
      .where('id', '=', baseId)
      .executeTakeFirstOrThrow();
    return row.permission_version;
  }
});
