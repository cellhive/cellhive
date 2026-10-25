/**
 * Reading formula/lookup fields (BACKLOG T457, SPEC §5.8, §5.9, §9.5,
 * CONTRACTS §2, §5 P34–P36) on PostgreSQL 18: stored and virtual values,
 * `cell_format=text` by style, filter/sort/group by the result type, locked
 * fields, the reader's own read scope on source tables and the base setting
 * `strict_computed_permissions`.
 */
import { newId, type Id } from '@cellhive/contracts';
import {
  resolveBaseAccess,
  roleConfigSchema,
  type BaseRoleDef,
  type RoleConfigInput,
} from '@cellhive/permissions';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemAuditContext, type AuditContext } from '../../src/audit/index.js';
import { orgScope, type Db } from '../../src/db/index.js';
import { AppError } from '../../src/errors/index.js';
import {
  RecordMutationService,
  RecordQueryService,
  type RecordAccessContext,
} from '../../src/records/index.js';
import { FieldsRepository, SchemaService } from '../../src/schema/index.js';
import { configJson, defaultViewConfig, ViewsRepository } from '../../src/views/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';

import {
  accessOf,
  buildOrdersFixture,
  LOCALE,
  NOW,
  TIME_ZONE,
  type OrdersFixture,
  type UserKey,
} from './fixtures.js';

import type { FieldRow, JsonObject } from '../../src/db/schema.js';

const ORG_A: Id<'org'> = 'org_T457ComputedRdAA';
const ORG_B: Id<'org'> = 'org_T457ComputedRdBB';

async function appError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected an AppError');
}

describe('computed fields in record reads (T457)', () => {
  let database: TestDatabase;
  let db: Db;
  let schema: SchemaService;
  let mutation: RecordMutationService;
  let query: RecordQueryService;
  let fx: OrdersFixture;
  const scope = orgScope(ORG_A);
  const context = systemAuditContext();
  const fld: Record<string, FieldRow> = {};
  let r1: Id<'rec'>, r2: Id<'rec'>, r3: Id<'rec'>;
  let c1: Id<'rec'>, c2: Id<'rec'>;

  const as = (user: UserKey): RecordAccessContext => accessOf(fx, user);
  const auditOf = (user: UserKey): AuditContext => {
    const requestId = newId('req');
    return {
      actor: { type: 'user', id: fx.users[user].id },
      via: null,
      batch_id: requestId,
      request_id: requestId,
      ip: null,
      user_agent: 'vitest',
    };
  };

  /** Registers a field in the fixture's permission schema (roles see it). */
  function register(field: FieldRow): void {
    const table = fx.schema.tables.find((candidate) => candidate.id === field.table_id);
    if (table === undefined) throw new Error('unknown table');
    table.fields = [...table.fields, { id: field.id, type: field.type }];
  }

  /** Access of `user` through one custom role (built on the fixture's current schema). */
  function customAccess(user: UserKey, config: RoleConfigInput): RecordAccessContext {
    const role: BaseRoleDef = {
      id: newId('rol'),
      kind: 'custom',
      name: 'Custom',
      config: roleConfigSchema.parse(config),
    };
    const resolved = resolveBaseAccess({
      principal: {
        userId: fx.users[user].id,
        groupIds: [],
        orgRole: 'member',
        workspaceRole: 'member',
        isBaseOwner: false,
      },
      roles: [role],
      assignments: [{ roleId: role.id, principalType: 'user', principalId: fx.users[user].id }],
      schema: fx.schema,
    });
    if (resolved === null) throw new Error('no access');
    return {
      baseId: fx.baseId,
      resolved,
      userId: fx.users[user].id,
      groupMemberUserIds: [],
      timeZone: TIME_ZONE,
      locale: LOCALE,
    };
  }

  async function addComputed(
    tableId: Id<'tbl'>,
    name: string,
    type: 'formula' | 'lookup',
    options: Record<string, unknown>,
  ): Promise<FieldRow> {
    const field = await schema.addField(
      scope,
      tableId,
      { name, type, options, computed: { timeZone: TIME_ZONE } },
      context,
    );
    register(field);
    if (field.compute_mode === 'stored') {
      let cursor = 0n;
      for (;;) {
        const result = await mutation.backfillComputedBatch(scope, {
          fieldId: field.id,
          afterAuto: cursor,
          limit: 1000,
          statementTimeoutMs: 30_000,
          timeZone: TIME_ZONE,
        });
        if (result.status !== 'more') break;
        cursor = result.cursor;
      }
      await schema.finishComputedBackfill(scope, field.id, { status: 'ready' });
    }
    return field;
  }

  const setStrict = (value: boolean) =>
    sql`UPDATE meta.bases SET settings = settings || ${JSON.stringify({
      strict_computed_permissions: value,
    })}::jsonb WHERE id = ${fx.baseId}`.execute(db.kysely);

  const byId = (records: readonly { id: string; fields: Record<string, unknown> }[]) =>
    Object.fromEntries(records.map((record) => [record.id, record.fields]));

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    query = new RecordQueryService(db, { now: () => NOW, defaultTimeZone: TIME_ZONE });
    mutation = new RecordMutationService(db, {
      schema,
      query,
      now: () => NOW,
      defaultTimeZone: TIME_ZONE,
    });
    fx = await buildOrdersFixture(db, schema, ORG_A);
    await buildOrdersFixture(db, schema, ORG_B);
    // CONTRACTS §5: `customer` link Orders → Customers (two-way here: lookups
    // from Orders select by the reverse field `orders`).
    fld.customer = await schema.addField(
      scope,
      fx.orders.id,
      {
        name: 'customer',
        type: 'link',
        options: {
          link_table: fx.customers.id,
          bidirectional: true,
          bidirectional_link_field_name: 'orders',
        },
      },
      context,
    );
    register(fld.customer);
    fld.orders = (await new FieldsRepository(db).getById(
      scope,
      (fld.customer.options as JsonObject).symmetric_field_id as Id<'fld'>,
    )) as FieldRow;
    register(fld.orders);

    const customers = await mutation.create(
      scope,
      fx.customers.id,
      as('u_admin'),
      {
        records: [
          { fields: { name: 'An Phát', phone: '0901' } },
          { fields: { name: 'Bình Minh', phone: '0902' } },
        ],
      },
      auditOf('u_admin'),
    );
    [c1, c2] = customers.records.map((record) => record.id) as [Id<'rec'>, Id<'rec'>];
    const orders = await mutation.create(
      scope,
      fx.orders.id,
      as('u_admin'),
      {
        records: [
          {
            fields: {
              title: 'r1',
              amount: 1_000_000,
              cost: 200,
              owner: [{ id: fx.users.u_sales1.id }],
              customer: [c1],
            },
          },
          {
            fields: {
              title: 'r2',
              amount: 500_000,
              cost: 100,
              owner: [{ id: fx.users.u_sales2.id }],
              customer: [c1],
            },
          },
          { fields: { title: 'r3', amount: 300_000, cost: 50, customer: [c2] } },
        ],
      },
      auditOf('u_admin'),
    );
    [r1, r2, r3] = orders.records.map((record) => record.id) as [Id<'rec'>, Id<'rec'>, Id<'rec'>];

    // CONTRACTS §5 fixture: `total_formula` uses `cost` (no_perm for Sales).
    fld.total = await addComputed(fx.orders.id, 'total_formula', 'formula', {
      expression: '[amount] + [cost]',
    });
    fld.phone = await addComputed(fx.orders.id, 'customer_phone', 'lookup', {
      from: fx.customers.id,
      select: fx.fld.phone.id,
      where: { field: fld.orders.id, operator: 'intersects', value: { field_ref: '__id' } },
    });
    fld.double = await addComputed(fx.orders.id, 'double_virtual', 'formula', {
      expression: 'IF(TODAY() > DATE(2000, 1, 1), [amount] * 2, 0)',
    });
    fld.records = await addComputed(fx.orders.id, 'customer_records', 'formula', {
      expression: '[customer]',
    });
    fld.sum = await addComputed(fx.customers.id, 'orders_total', 'lookup', {
      from: fx.orders.id,
      select: fx.fld.amount.id,
      where: { field: fld.customer.id, operator: 'intersects', value: { field_ref: '__id' } },
      aggregate: 'sum',
    });
    fld.owners = await addComputed(fx.customers.id, 'order_owners', 'lookup', {
      from: fx.orders.id,
      select: fx.fld.owner.id,
      where: { field: fld.customer.id, operator: 'intersects', value: { field_ref: '__id' } },
      aggregate: 'unique',
    });
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('modes: stored formula and lookups have columns, TODAY() is virtual', () => {
    expect(fld.total?.compute_mode).toBe('stored');
    expect(fld.phone?.compute_mode).toBe('stored');
    expect(fld.sum?.compute_mode).toBe('stored');
    expect(fld.double?.compute_mode).toBe('virtual');
    expect(fld.double?.db_column_name).toBeNull();
  });

  it('reads stored and virtual values in their result type (admin)', async () => {
    const list = await query.query(scope, fx.orders.id, as('u_admin'), { limit: 10 });
    const rows = byId(list.records);
    expect(rows[r1]).toMatchObject({
      total_formula: 1_000_200,
      customer_phone: ['0901'],
      double_virtual: 2_000_000,
      customer_records: [{ id: c1, title: 'An Phát' }],
    });
    expect(rows[r3]).toMatchObject({
      total_formula: 300_050,
      customer_phone: ['0902'],
      customer_records: [{ id: c2, title: 'Bình Minh' }],
    });
    const customers = await query.query(scope, fx.customers.id, as('u_admin'), {});
    const owners = byId(customers.records)[c1]?.['order_owners'] as { id: string }[];
    expect(owners.map((owner) => owner.id).sort()).toEqual(
      [fx.users.u_sales1.id, fx.users.u_sales2.id].sort(),
    );
    expect(owners[0]).toHaveProperty('name');
    expect(byId(customers.records)[c1]?.['orders_total']).toBe(1_500_000);
  });

  it('cell_format=text formats by style: a sum lookup with a VND style reads 1.500.000 ₫', async () => {
    const record = await query.getRecord(scope, fx.customers.id, c1, as('u_admin'), {
      cell_format: 'text',
    });
    expect(record.fields['orders_total']).toMatch(/^1\.500\.000\s₫$/u);
    const order = await query.getRecord(scope, fx.orders.id, r1, as('u_admin'), {
      cell_format: 'text',
      fields: ['customer_records', 'customer_phone'],
    });
    expect(order.fields).toEqual({ customer_records: 'An Phát', customer_phone: '0901' });
  });

  it('filters, sorts and groups by stored and virtual computed fields', async () => {
    const filtered = await query.query(scope, fx.orders.id, as('u_admin'), {
      filter: { field: fld.total?.id ?? '', operator: 'gt', value: 400_000 },
      sort: [{ field: 'double_virtual', direction: 'desc' }],
      fields: ['title'],
    });
    expect(filtered.records.map((record) => record.id)).toEqual([r1, r2]);
    const virtual = await query.query(scope, fx.orders.id, as('u_admin'), {
      filter: { field: fld.double?.id ?? '', operator: 'lt', value: 1_500_000 },
      sort: [{ field: 'total_formula', direction: 'asc' }],
      fields: ['title'],
    });
    expect(virtual.records.map((record) => record.id)).toEqual([r3, r2]);
    const list = await query.query(scope, fx.orders.id, as('u_admin'), {
      filter: { field: fld.phone?.id ?? '', operator: 'has_any_of', value: ['0901'] },
      fields: ['title'],
    });
    expect(list.records.map((record) => record.id).sort()).toEqual([r1, r2].sort());
    const groups = await query.groupCounts(scope, fx.orders.id, as('u_admin'), {
      group: [{ field: 'customer_phone', direction: 'asc' }],
    });
    expect(groups.groups).toEqual([
      { values: [['0901']], count: 2 },
      { values: [['0902']], count: 1 },
    ]);
    const grouped = await query.query(scope, fx.orders.id, as('u_admin'), {
      group: [{ field: 'double_virtual', direction: 'desc' }],
      fields: ['double_virtual'],
    });
    expect(grouped.records.map((record) => record.id)).toEqual([r1, r2, r3]);
  });

  it('records and attachments of computed fields are not sortable', async () => {
    const error = await appError(
      query.query(scope, fx.orders.id, as('u_admin'), {
        sort: [{ field: 'customer_records', direction: 'asc' }],
      }),
    );
    expect(error.code).toBe('INVALID_SORT');
    expect(error.errors?.[0]).toMatchObject({ code: 'FIELD_NOT_SORTABLE' });
  });

  it('P34: a lookup from a table the reader cannot read is null + locked, not filterable', async () => {
    const record = await query.getRecord(scope, fx.orders.id, r1, as('u_sales1'));
    expect(record.fields).toMatchObject({ customer_phone: null, customer_records: null });
    expect(record.fields).not.toHaveProperty('cost');
    const filter = await appError(
      query.query(scope, fx.orders.id, as('u_sales1'), {
        filter: { field: fld.phone?.id ?? '', operator: 'is_not_empty' },
      }),
    );
    expect(filter.code).toBe('INVALID_FILTER');
    expect(filter.errors?.[0]).toMatchObject({ code: 'UNKNOWN_FIELD' });
    const sort = await appError(
      query.query(scope, fx.orders.id, as('u_sales1'), {
        sort: [{ field: 'customer_phone', direction: 'asc' }],
      }),
    );
    expect(sort.code).toBe('INVALID_SORT');
    expect(sort.errors?.[0]).toMatchObject({ code: 'UNKNOWN_FIELD' });
  });

  it('P36: strict_computed_permissions hides a same-table formula over a no_perm field', async () => {
    const before = await query.getRecord(scope, fx.orders.id, r1, as('u_sales1'));
    expect(before.fields['total_formula']).toBe(1_000_200);
    await setStrict(true);
    try {
      const strict = await query.getRecord(scope, fx.orders.id, r1, as('u_sales1'));
      expect(strict.fields['total_formula']).toBeNull();
      const error = await appError(
        query.query(scope, fx.orders.id, as('u_sales1'), {
          filter: { field: fld.total?.id ?? '', operator: 'gt', value: 0 },
        }),
      );
      expect(error.code).toBe('INVALID_FILTER');
      // Readers of `cost` are not affected.
      const admin = await query.getRecord(scope, fx.orders.id, r1, as('u_admin'));
      expect(admin.fields['total_formula']).toBe(1_000_200);
    } finally {
      await setStrict(false);
    }
    const after = await query.getRecord(scope, fx.orders.id, r1, as('u_sales1'));
    expect(after.fields['total_formula']).toBe(1_000_200);
  });

  it('P35: a reader with a read_filter on the source table gets values over their records only', async () => {
    const scoped = customAccess('u_reader', {
      tables: {
        [fx.orders.id]: {
          perm: 'read_only',
          record_rule: {
            read_scope: 'filter',
            read_filter: { field: fx.fld.amount.id, operator: 'gte', value: 600_000 },
          },
          field_rule: { mode: 'all_read' },
        },
        [fx.customers.id]: { perm: 'read_only', field_rule: { mode: 'all_read' } },
      },
    });
    const admin = byId((await query.query(scope, fx.customers.id, as('u_admin'), {})).records);
    const mine = byId((await query.query(scope, fx.customers.id, scoped, {})).records);
    expect(admin[c1]?.['orders_total']).toBe(1_500_000);
    expect(mine[c1]?.['orders_total']).toBe(1_000_000);
    expect(mine[c2]?.['orders_total']).toBe(0);
    expect((mine[c1]?.['order_owners'] as { id: string }[]).map((user) => user.id)).toEqual([
      fx.users.u_sales1.id,
    ]);
    // Filters and sorts use the reader's own values, never the stored ones.
    const filtered = await query.query(scope, fx.customers.id, scoped, {
      filter: { field: fld.sum?.id ?? '', operator: 'gte', value: 1_200_000 },
    });
    expect(filtered.records).toEqual([]);
    const adminFiltered = await query.query(scope, fx.customers.id, as('u_admin'), {
      filter: { field: fld.sum?.id ?? '', operator: 'gte', value: 1_200_000 },
    });
    expect(adminFiltered.records.map((record) => record.id)).toEqual([c1]);
  });

  it('T472 summaries: values of the reader (P35), virtual fields, locked and no_perm fields', async () => {
    const scoped = customAccess('u_reader', {
      tables: {
        [fx.orders.id]: {
          perm: 'read_only',
          record_rule: {
            read_scope: 'filter',
            read_filter: { field: fx.fld.amount.id, operator: 'gte', value: 600_000 },
          },
          field_rule: { mode: 'all_read' },
        },
        [fx.customers.id]: { perm: 'read_only', field_rule: { mode: 'all_read' } },
      },
    });
    const sumOf = (records: readonly { fields: Record<string, unknown> }[], name: string) =>
      records.reduce((total, record) => total + Number(record.fields[name] ?? 0), 0);
    // Expected sums from the records each reader reads (their own computed values).
    const adminCustomers = (await query.query(scope, fx.customers.id, as('u_admin'), {})).records;
    const mineCustomers = (await query.query(scope, fx.customers.id, scoped, {})).records;
    const adminTotal = await query.summaries(scope, fx.customers.id, as('u_admin'), {
      summaries: { orders_total: 'sum', order_owners: 'unique' },
    });
    const mineTotal = await query.summaries(scope, fx.customers.id, scoped, {
      summaries: { orders_total: 'sum', order_owners: 'unique' },
    });
    expect(adminTotal.summaries['orders_total']?.value).toBe(sumOf(adminCustomers, 'orders_total'));
    expect(mineTotal.summaries['orders_total']?.value).toBe(sumOf(mineCustomers, 'orders_total'));
    expect(mineTotal.summaries['orders_total']?.value).not.toBe(
      adminTotal.summaries['orders_total']?.value,
    );
    // `unique` of a user list: distinct users over the reader's own values.
    expect(mineTotal.summaries['order_owners']).toEqual({ fn: 'unique', value: 1 });

    // A virtual formula (TODAY()) is computed in the aggregate like in reads.
    const orders = (await query.query(scope, fx.orders.id, as('u_admin'), {})).records;
    const virtual = await query.summaries(scope, fx.orders.id, as('u_admin'), {
      summaries: { double_virtual: 'sum', total_formula: 'max' },
    });
    expect(virtual.summaries['double_virtual']?.value).toBe(sumOf(orders, 'double_virtual'));
    expect(virtual.summaries['total_formula']?.value).toBe(
      Math.max(...orders.map((record) => Number(record.fields['total_formula']))),
    );

    // u_sales1: their own orders only. In the request, `customer_phone` is
    // locked (Customers unreadable) and `cost` is no_perm: both are unknown
    // fields, like in filter/sort/group (T501, P34/P36).
    const sales = await query.summaries(scope, fx.orders.id, as('u_sales1'), {
      summaries: { total_formula: 'sum' },
    });
    const salesOrders = (await query.query(scope, fx.orders.id, as('u_sales1'), {})).records;
    expect(sales.count).toBe(salesOrders.length);
    expect(sales.summaries).toEqual({
      total_formula: { fn: 'sum', value: sumOf(salesOrders, 'total_formula') },
    });
    for (const name of ['customer_phone', 'cost']) {
      const unknown = await appError(
        query.summaries(scope, fx.orders.id, as('u_sales1'), {
          summaries: { [name]: name === 'cost' ? 'sum' : 'filled', total_formula: 'sum' },
        }),
      );
      expect(unknown.code).toBe('VALIDATION_FAILED');
      expect(unknown.errors).toEqual([
        expect.objectContaining({ path: `summaries.${name}`, code: 'UNKNOWN_FIELD' }),
      ]);
    }

    // The view's saved entries on a locked or no_perm field are skipped.
    const view = await new ViewsRepository(db).insert(scope, {
      id: newId('viw'),
      tableId: fx.orders.id,
      type: 'grid',
      name: 'T501 saved summaries',
      config: configJson({
        ...defaultViewConfig('grid'),
        summaries: {
          [fld.phone?.id as string]: 'filled',
          [fx.fld.cost.id]: 'sum',
          [fld.total?.id as string]: 'sum',
        },
      }),
      position: 99,
      ownerId: null,
    });
    const saved = await query.summaries(scope, fx.orders.id, as('u_sales1'), { view_id: view.id });
    expect(saved.summaries).toEqual({
      total_formula: { fn: 'sum', value: sumOf(salesOrders, 'total_formula') },
    });
  });

  it('P20 for record results: the title is null without the primary field', async () => {
    const reader = customAccess('u_reader', {
      tables: {
        [fx.orders.id]: { perm: 'read_only', field_rule: { mode: 'all_read' } },
        [fx.customers.id]: {
          perm: 'read_only',
          field_rule: { mode: 'specify', fields: { [fx.fld.name.id]: 'no_perm' } },
        },
      },
    });
    const record = await query.getRecord(scope, fx.orders.id, r1, reader, {
      fields: ['customer_records'],
    });
    expect(record.fields).toEqual({ customer_records: [{ id: c1, title: null }] });
  });

  it('selects computed fields by id and leaves no_perm ones out', async () => {
    const record = await query.getRecord(scope, fx.orders.id, r2, as('u_admin'), {
      field_key_type: 'id',
      fields: [fld.total?.id ?? '', fld.double?.id ?? ''],
    });
    expect(record.fields).toEqual({
      [fld.total?.id ?? '']: 500_100,
      [fld.double?.id ?? '']: 1_000_000,
    });
    const hidden = customAccess('u_reader', {
      tables: {
        [fx.orders.id]: {
          perm: 'read_only',
          field_rule: { mode: 'specify', fields: { [fld.total?.id ?? '']: 'no_perm' } },
        },
      },
    });
    const read = await query.getRecord(scope, fx.orders.id, r2, hidden);
    expect(read.fields).not.toHaveProperty('total_formula');
    const error = await appError(
      query.getRecord(scope, fx.orders.id, r2, hidden, { fields: ['total_formula'] }),
    );
    expect(error.code).toBe('VALIDATION_FAILED');
  });

  it('T470: writing a formula or lookup cell is 403 FIELD_READ_ONLY, a hidden one UNKNOWN_FIELD', async () => {
    const update = await appError(
      mutation.update(
        scope,
        fx.orders.id,
        as('u_admin'),
        { records: [{ id: r1, fields: { total_formula: 1, title: 'r1' } }] },
        auditOf('u_admin'),
      ),
    );
    expect(update.code).toBe('FIELD_READ_ONLY');
    expect(update.errors).toEqual([
      expect.objectContaining({
        path: 'records[0].fields.total_formula',
        code: 'FIELD_READ_ONLY',
        params: { type: 'formula' },
      }),
    ]);
    const create = await appError(
      mutation.create(
        scope,
        fx.orders.id,
        as('u_admin'),
        { field_key_type: 'id', records: [{ fields: { [fld.phone?.id ?? '']: ['x'] } }] },
        auditOf('u_admin'),
      ),
    );
    expect(create.code).toBe('FIELD_READ_ONLY');
    expect(create.errors?.[0]).toMatchObject({ params: { type: 'lookup' } });
    // A missing field next to a computed one is still unknown.
    const missing = await appError(
      mutation.update(
        scope,
        fx.orders.id,
        as('u_admin'),
        { records: [{ id: r1, fields: { total_formula: 1, nope: 1 } }] },
        auditOf('u_admin'),
      ),
    );
    expect(missing.code).toBe('VALIDATION_FAILED');
    expect(missing.errors?.map((issue) => issue.code)).toEqual(['UNKNOWN_FIELD']);
    // A formula the writer cannot read is not revealed (P08).
    const hidden = customAccess('u_editor', {
      tables: {
        [fx.orders.id]: {
          perm: 'edit',
          field_rule: { mode: 'specify', fields: { [fld.total?.id ?? '']: 'no_perm' } },
        },
      },
    });
    const unknown = await appError(
      mutation.update(
        scope,
        fx.orders.id,
        hidden,
        { records: [{ id: r1, fields: { total_formula: 1 } }] },
        auditOf('u_editor'),
      ),
    );
    expect(unknown.code).toBe('VALIDATION_FAILED');
    expect(unknown.errors?.[0]).toMatchObject({ code: 'UNKNOWN_FIELD' });
  });

  it('tenant isolation: another organization cannot read the table', async () => {
    const error = await appError(
      query.query(orgScope(ORG_B), fx.orders.id, as('u_admin'), { fields: ['total_formula'] }),
    );
    expect(error.code).toBe('NOT_FOUND');
  });
});
