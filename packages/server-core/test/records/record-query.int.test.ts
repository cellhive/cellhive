/**
 * RecordQueryService (BACKLOG T106) on PostgreSQL 18: tables created by
 * `SchemaService`, records inserted by test fixtures, access resolved by
 * `@cellhive/permissions` exactly as the api access service does.
 */
import { newId, type Id } from '@cellhive/contracts';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemAuditContext } from '../../src/audit/index.js';
import { orgScope, type Db } from '../../src/db/index.js';
import { AppError } from '../../src/errors/index.js';
import {
  MemberDirectoryRepository,
  RecordQueryService,
  type RecordAccessContext,
  type RecordListOutput,
} from '../../src/records/index.js';
import { SchemaService } from '../../src/schema/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { seedTenant } from '../support/tenant.js';

import {
  accessOf,
  buildOrdersFixture,
  capturingDb,
  insertBulk,
  insertRows,
  NOW,
  type OrdersFixture,
} from './fixtures.js';

import type { FieldRow, TableRow } from '../../src/db/schema.js';

const ORG_A: Id<'org'> = 'org_T106RecQueryOrgA';
const ORG_B: Id<'org'> = 'org_T106RecQueryOrgB';

async function appError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected an AppError');
}

const ids = (list: RecordListOutput) => list.records.map((record) => record.id);

describe('RecordQueryService (PostgreSQL 18)', () => {
  let database: TestDatabase;
  let db: Db;
  let pool: pg.Pool;
  let schema: SchemaService;
  let service: RecordQueryService;
  let fx: OrdersFixture;
  const scope = orgScope(ORG_A);
  let r1: Id<'rec'>,
    r2: Id<'rec'>,
    r3: Id<'rec'>,
    r4: Id<'rec'>,
    r5: Id<'rec'>,
    rDeleted: Id<'rec'>;
  let outsider: Id<'usr'>;

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    pool = new pg.Pool({ connectionString: database.url, max: 4 });
    schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    service = new RecordQueryService(db, { now: () => NOW });
    fx = await buildOrdersFixture(db, schema, ORG_A);
    outsider = newId('usr');

    const { title, amount, cost, status, owner } = fx.fld;
    const col = (field: FieldRow) => field.db_column_name as string;
    [r1, r2, r3, r4, r5, rDeleted] = (await insertRows(pool, fx.orders, [
      {
        [col(title)]: 'Đơn Cửa hàng An Phát',
        [col(amount)]: '1500000',
        [col(cost)]: '1000000',
        [col(status)]: [fx.opt.new],
        [col(owner)]: [fx.users.u_sales1.id],
        __created_by: fx.users.u_sales1.id,
      },
      {
        [col(title)]: 'Đơn Bình Minh',
        [col(amount)]: '200',
        [col(cost)]: '100',
        [col(status)]: [fx.opt.done],
        [col(owner)]: [fx.users.u_sales2.id],
        __created_by: outsider,
      },
      { [col(title)]: 'Đơn trống', [col(amount)]: '1500000', [col(cost)]: '5' },
      { [col(title)]: 'Đơn Zeta', [col(amount)]: '200', [col(status)]: [fx.opt.new] },
      { [col(title)]: null, [col(amount)]: null, [col(status)]: [fx.opt.done] },
      {
        [col(title)]: 'Đơn đã xoá',
        [col(owner)]: [fx.users.u_sales1.id],
        __deleted_at: new Date(),
        __deleted_by: fx.users.u_admin.id,
      },
    ])) as [Id<'rec'>, Id<'rec'>, Id<'rec'>, Id<'rec'>, Id<'rec'>, Id<'rec'>];
    await insertRows(pool, fx.customers, [{ [col(fx.fld.name)]: 'An Phát' }]);
  });

  afterAll(async () => {
    await pool.end();
    await db.destroy();
    await database.drop();
  });

  describe('permissions (CONTRACTS §5)', () => {
    it('P02: u_reader sees every live record and every field', async () => {
      const list = await service.query(scope, fx.orders.id, accessOf(fx, 'u_reader'));
      expect(ids(list)).toEqual([r1, r2, r3, r4, r5]);
      expect('total' in list && list.total).toBe(5);
      expect(Object.keys(list.records[0]?.fields ?? {})).toEqual([
        'title',
        'amount',
        'cost',
        'status',
        'owner',
        'created by',
      ]);
    });

    it('P07: u_sales1 sees only r1 and no `cost` key', async () => {
      const list = await service.query(scope, fx.orders.id, accessOf(fx, 'u_sales1'));
      expect(ids(list)).toEqual([r1]);
      expect(list).toMatchObject({ total: 1, offset: 0, limit: 200 });
      const record = list.records[0];
      expect(record?.fields).not.toHaveProperty('cost');
      expect(record?.fields).toEqual({
        title: 'Đơn Cửa hàng An Phát',
        amount: 1500000,
        status: 'Mới',
        owner: [{ id: fx.users.u_sales1.id, name: 'User sales1', email: fx.users.u_sales1.email }],
        'created by': {
          id: fx.users.u_sales1.id,
          name: 'User sales1',
          email: fx.users.u_sales1.email,
        },
      });
      expect(record).toMatchObject({ id: r1, version: 1 });
      expect(record?.created_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    });

    it('P07: getRecord of r2 for u_sales1 is NOT_FOUND, r1 is returned', async () => {
      const access = accessOf(fx, 'u_sales1');
      expect((await appError(service.getRecord(scope, fx.orders.id, r2, access))).code).toBe(
        'NOT_FOUND',
      );
      const record = await service.getRecord(scope, fx.orders.id, r1, access);
      expect(record.id).toBe(r1);
      expect(record.fields).not.toHaveProperty('cost');
    });

    it('P08: filtering on the hidden `cost` fails exactly like a missing field', async () => {
      const access = accessOf(fx, 'u_sales1');
      const hidden = await appError(
        service.query(scope, fx.orders.id, access, {
          filter: { op: 'and', items: [{ field: fx.fld.cost.id, operator: 'gt', value: 1 }] },
        }),
      );
      const missing = await appError(
        service.query(scope, fx.orders.id, access, {
          filter: { op: 'and', items: [{ field: newId('fld'), operator: 'gt', value: 1 }] },
        }),
      );
      expect(hidden.status).toBe(422);
      expect(hidden.code).toBe('INVALID_FILTER');
      expect(hidden.errors).toEqual([
        expect.objectContaining({ path: 'filter.items[0].field', code: 'UNKNOWN_FIELD' }),
      ]);
      expect(missing.errors?.map(({ path, code, message }) => ({ path, code, message }))).toEqual(
        hidden.errors?.map(({ path, code, message }) => ({ path, code, message })),
      );

      // Tuple form by name: the same, with a tuple path.
      const tuple = await appError(
        service.query(scope, fx.orders.id, access, {
          filter: { logic: 'and', conditions: [['cost', '>', 1]] },
        }),
      );
      expect(tuple.code).toBe('INVALID_FILTER');
      expect(tuple.errors?.[0]).toMatchObject({ path: 'filter.conditions[0][0]' });
    });

    it('P08: sorting on or requesting a hidden field fails like a missing one', async () => {
      const access = accessOf(fx, 'u_sales1');
      const sortHidden = await appError(
        service.query(scope, fx.orders.id, access, { sort: [{ field: 'cost' }] }),
      );
      const sortMissing = await appError(
        service.query(scope, fx.orders.id, access, { sort: [{ field: 'nope' }] }),
      );
      expect(sortHidden.code).toBe('INVALID_SORT');
      expect(sortHidden.errors).toEqual(sortMissing.errors);
      expect(sortHidden.errors).toEqual([
        { path: 'sort[0].field', code: 'UNKNOWN_FIELD', message: 'Field does not exist' },
      ]);

      const fieldsHidden = await appError(
        service.query(scope, fx.orders.id, access, { fields: ['title', 'cost'] }),
      );
      const fieldsMissing = await appError(
        service.query(scope, fx.orders.id, access, { fields: ['title', 'nope'] }),
      );
      expect(fieldsHidden.code).toBe('VALIDATION_FAILED');
      expect(fieldsHidden.errors).toEqual([
        { path: 'fields[1]', code: 'UNKNOWN_FIELD', message: 'Field does not exist' },
      ]);
      expect(fieldsMissing.errors).toEqual(fieldsHidden.errors);
    });

    it('P19: a table the role does not list is NOT_FOUND', async () => {
      const access = accessOf(fx, 'u_sales1');
      const error = await appError(service.query(scope, fx.customers.id, access));
      expect(error.code).toBe('NOT_FOUND');
      expect(error.status).toBe(404);
      const one = await appError(service.getRecord(scope, fx.customers.id, r1, access));
      expect(one.code).toBe('NOT_FOUND');
      // The reader does see Customers.
      const list = await service.query(scope, fx.customers.id, accessOf(fx, 'u_reader'));
      expect(list.records.map((record) => record.fields)).toEqual([
        { name: 'An Phát', phone: null },
      ]);
    });

    it('never selects, filters or sorts on columns of hidden fields', async () => {
      const captured = capturingDb(database.url);
      try {
        const spy = new RecordQueryService(captured.db, { now: () => NOW });
        await spy.query(scope, fx.orders.id, accessOf(fx, 'u_sales1'), {
          filter: { logic: 'and', conditions: [['amount', '>', 1]] },
          sort: [{ field: 'amount', direction: 'desc' }],
          search: 'phat',
        });
        await spy.getRecord(scope, fx.orders.id, r1, accessOf(fx, 'u_sales1'));
        const dataStatements = captured.queries.filter((query) =>
          query.sql.includes(fx.orders.db_table_name),
        );
        expect(dataStatements.length).toBeGreaterThanOrEqual(2);
        for (const statement of dataStatements) {
          expect(statement.sql).not.toContain(fx.fld.cost.db_column_name as string);
        }
      } finally {
        await captured.db.destroy();
      }
    });

    it('the record rule has no user without a principal: anonymous sales access reads nothing', async () => {
      const access: RecordAccessContext = { ...accessOf(fx, 'u_sales1'), userId: null };
      const list = await service.query(scope, fx.orders.id, access);
      expect(list.records).toEqual([]);
      expect(list).toMatchObject({ total: 0 });
    });

    it('a read rule that no longer validates fails closed', async () => {
      const access = accessOf(fx, 'u_reader');
      const broken: RecordAccessContext = {
        ...access,
        resolved: {
          ...access.resolved,
          internal: {
            ...access.resolved.internal,
            readFilters: {
              ...access.resolved.internal.readFilters,
              [fx.orders.id]: {
                op: 'and',
                items: [{ field: newId('fld'), operator: 'is_not_empty' }],
              },
            },
          },
        },
      };
      expect((await service.query(scope, fx.orders.id, broken)).records).toEqual([]);
    });

    it('access resolved for another base is NOT_FOUND', async () => {
      const access = { ...accessOf(fx, 'u_reader'), baseId: newId('bse') };
      expect((await appError(service.query(scope, fx.orders.id, access))).code).toBe('NOT_FOUND');
    });
  });

  describe('trash and single records', () => {
    it('soft-deleted records are neither listed nor found', async () => {
      const access = accessOf(fx, 'u_admin');
      const list = await service.query(scope, fx.orders.id, access);
      expect(ids(list)).not.toContain(rDeleted);
      expect((await appError(service.getRecord(scope, fx.orders.id, rDeleted, access))).code).toBe(
        'NOT_FOUND',
      );
    });

    it('malformed and unknown record ids are NOT_FOUND', async () => {
      const access = accessOf(fx, 'u_admin');
      for (const id of ['nope', newId('rec'), `${r1}' OR 1=1 --`]) {
        expect((await appError(service.getRecord(scope, fx.orders.id, id, access))).code).toBe(
          'NOT_FOUND',
        );
      }
    });
  });

  describe('serialization (CONTRACTS §1.3, §2)', () => {
    it('field_key_type=id keys fields by id and accepts ids in fields/sort/tuple', async () => {
      const { title, amount, status } = fx.fld;
      const list = await service.query(scope, fx.orders.id, accessOf(fx, 'u_reader'), {
        field_key_type: 'id',
        fields: [amount.id, title.id],
        filter: { logic: 'and', conditions: [[status.id, '==', 'Mới']] },
        sort: [{ field: amount.id, direction: 'desc' }],
      });
      expect(list.records.map((record) => record.fields)).toEqual([
        { [amount.id]: 1500000, [title.id]: 'Đơn Cửa hàng An Phát' },
        { [amount.id]: 200, [title.id]: 'Đơn Zeta' },
      ]);
      // Names are not keys with field_key_type=id.
      const error = await appError(
        service.query(scope, fx.orders.id, accessOf(fx, 'u_reader'), {
          field_key_type: 'id',
          fields: ['title'],
        }),
      );
      expect(error.code).toBe('VALIDATION_FAILED');
    });

    it('cell_format=text formats per field type in the caller locale', async () => {
      const record = await service.getRecord(scope, fx.orders.id, r1, accessOf(fx, 'u_reader'), {
        cell_format: 'text',
      });
      expect(record.fields).toEqual({
        title: 'Đơn Cửa hàng An Phát',
        amount: '1.500.000 ₫',
        cost: '1000000',
        status: 'Mới',
        owner: 'User sales1',
        'created by': 'User sales1',
      });
    });

    it('user cells resolve org members only; other ids stay bare', async () => {
      const record = await service.getRecord(scope, fx.orders.id, r2, accessOf(fx, 'u_reader'), {
        fields: ['created by', 'owner'],
      });
      expect(record.fields).toEqual({
        'created by': { id: outsider },
        owner: [{ id: fx.users.u_sales2.id, name: 'User sales2', email: fx.users.u_sales2.email }],
      });
    });

    it('empty cells are null (json) and empty strings (text)', async () => {
      const json = await service.getRecord(scope, fx.orders.id, r5, accessOf(fx, 'u_reader'));
      expect(json.fields).toMatchObject({ title: null, amount: null, cost: null, owner: null });
      const text = await service.getRecord(scope, fx.orders.id, r5, accessOf(fx, 'u_reader'), {
        cell_format: 'text',
      });
      expect(text.fields).toMatchObject({ amount: '', owner: '', status: 'Xong' });
    });
  });

  describe('sort', () => {
    it('sorts with __auto as the tie-breaker, empty values last', async () => {
      const access = accessOf(fx, 'u_reader');
      const desc = await service.query(scope, fx.orders.id, access, {
        sort: [{ field: 'amount', direction: 'desc' }],
      });
      expect(ids(desc)).toEqual([r1, r3, r2, r4, r5]);
      const asc = await service.query(scope, fx.orders.id, access, {
        sort: [{ field: 'amount' }],
      });
      expect(ids(asc)).toEqual([r2, r4, r1, r3, r5]);
      // Stable pages: the concatenation of pages equals the full order.
      const pages: Id<'rec'>[] = [];
      for (let offset = 0; offset < 5; offset += 2) {
        pages.push(
          ...ids(
            await service.query(scope, fx.orders.id, access, {
              sort: [{ field: 'amount', direction: 'desc' }],
              offset,
              limit: 2,
            }),
          ),
        );
      }
      expect(pages).toEqual(ids(desc));
    });

    it('select sorts by option order, user fields by member name', async () => {
      const access = accessOf(fx, 'u_reader');
      const byStatus = await service.query(scope, fx.orders.id, access, {
        sort: [{ field: 'status', direction: 'desc' }, { field: 'title' }],
      });
      // Xong (r2, r5) before Mới (r1, r4), empty (r3) last; ties by title (null last).
      expect(ids(byStatus)).toEqual([r2, r5, r1, r4, r3]);
      const byOwner = await service.query(scope, fx.orders.id, access, {
        sort: [{ field: 'owner', direction: 'desc' }],
      });
      expect(ids(byOwner)).toEqual([r2, r1, r3, r4, r5]);
    });

    it('rejects a malformed sort with VALIDATION_FAILED', async () => {
      const error = await appError(
        service.query(scope, fx.orders.id, accessOf(fx, 'u_reader'), {
          sort: [{ field: 'amount', direction: 'up' as 'asc' }],
        }),
      );
      expect(error.code).toBe('VALIDATION_FAILED');
      expect(error.errors?.[0]?.path).toBe('sort[0].direction');
    });
  });

  describe('ids and include_total (grid blocks, realtime bursts)', () => {
    it('include_total: false answers the page without counting', async () => {
      const list = await service.query(scope, fx.orders.id, accessOf(fx, 'u_reader'), {
        include_total: false,
        limit: 2,
      });
      expect(ids(list)).toEqual([r1, r2]);
      expect(list).not.toHaveProperty('total');
      expect(list).not.toHaveProperty('total_estimate');
      expect(list).toMatchObject({ offset: 0, limit: 2 });
    });

    it('ids fetch specific records under the read rule, trash excluded', async () => {
      const reader = await service.query(scope, fx.orders.id, accessOf(fx, 'u_reader'), {
        ids: [r4, r2, rDeleted, newId('rec')],
      });
      expect(ids(reader)).toEqual([r2, r4]);
      expect('total' in reader && reader.total).toBe(2);
      // u_sales1 reads only r1 (CONTRACTS §5): other ids are simply absent.
      const sales = await service.query(scope, fx.orders.id, accessOf(fx, 'u_sales1'), {
        ids: [r1, r2, r3],
      });
      expect(ids(sales)).toEqual([r1]);
      expect(Object.keys(sales.records[0]?.fields ?? {})).not.toContain('cost');
    });

    it('rejects more than 1 000 ids and malformed ids', async () => {
      const tooMany = await appError(
        service.query(scope, fx.orders.id, accessOf(fx, 'u_reader'), {
          ids: Array.from({ length: 1001 }, () => newId('rec')),
        }),
      );
      expect(tooMany.code).toBe('VALIDATION_FAILED');
      const malformed = await appError(
        service.query(scope, fx.orders.id, accessOf(fx, 'u_reader'), { ids: ['nope'] }),
      );
      expect(malformed.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('paging and totals', () => {
    it('validates offset and limit (default 200, max 1000)', async () => {
      const access = accessOf(fx, 'u_reader');
      const tooBig = await appError(service.query(scope, fx.orders.id, access, { limit: 1001 }));
      expect(tooBig.code).toBe('VALIDATION_FAILED');
      expect(tooBig.errors?.[0]).toMatchObject({ path: 'limit', code: 'TOO_BIG' });
      const negative = await appError(service.query(scope, fx.orders.id, access, { offset: -1 }));
      expect(negative.errors?.[0]).toMatchObject({ path: 'offset', code: 'TOO_SMALL' });
      const page = await service.query(scope, fx.orders.id, access, { offset: 1, limit: 2 });
      expect(page).toMatchObject({ offset: 1, limit: 2, total: 5 });
      expect(page.records).toHaveLength(2);
      const beyond = await service.query(scope, fx.orders.id, access, { offset: 10, limit: 2 });
      expect(beyond).toMatchObject({ records: [], total: 5 });
    });

    it('switches from total to total_estimate above the threshold', async () => {
      const small = new RecordQueryService(db, { now: () => NOW, exactTotalThreshold: 3 });
      const access = accessOf(fx, 'u_reader');
      // Full page: capped count (4 > 3) → estimate, never below what is known.
      const capped = await small.query(scope, fx.orders.id, access, { limit: 2 });
      expect(capped).not.toHaveProperty('total');
      expect('total_estimate' in capped && capped.total_estimate).toBeGreaterThanOrEqual(4);
      // Short page: exact count known (5 > 3) → still reported as an estimate.
      const short = await small.query(scope, fx.orders.id, access);
      expect(short).toMatchObject({ total_estimate: 5 });
      // At or below the threshold: exact.
      const filtered = await small.query(scope, fx.orders.id, access, {
        filter: { logic: 'and', conditions: [['status', '==', 'Mới']] },
        limit: 1,
      });
      expect(filtered).toMatchObject({ total: 2 });
      expect(filtered).not.toHaveProperty('total_estimate');
    });
  });

  describe('filters and search', () => {
    let tickets: TableRow;
    let ticketIds: Id<'rec'>[];

    beforeAll(async () => {
      const context = systemAuditContext();
      const created = await schema.createTable(
        scope,
        { baseId: fx.baseId, name: 'Tickets', primaryFieldName: 'Tiêu đề' },
        context,
      );
      tickets = created.table;
      const status = await schema.addField(
        scope,
        tickets.id,
        {
          name: 'Trạng thái',
          type: 'select',
          options: {
            options: [
              { id: newId('opt'), name: 'Mới' },
              { id: newId('opt'), name: 'Đang xử lý' },
              { id: newId('opt'), name: 'Xong' },
            ],
          },
        },
        context,
      );
      const due = await schema.addField(
        scope,
        tickets.id,
        { name: 'Hạn', type: 'datetime', options: { style: { format: 'dd/MM/yyyy' } } },
        context,
      );
      const optionId = (name: string) =>
        (status.options as { options: { id: string; name: string }[] }).options.find(
          (option) => option.name === name,
        )?.id;
      const c = (field: FieldRow) => field.db_column_name as string;
      ticketIds = await insertRows(pool, tickets, [
        // Overdue and open: matches the C§1.4 example.
        {
          [c(created.primaryField)]: 'Cửa hàng An Phát: máy POS lỗi in',
          [c(status)]: [optionId('Mới')],
          [c(due)]: '2026-09-20',
        },
        {
          [c(created.primaryField)]: 'AN PHAT kho 2',
          [c(status)]: [optionId('Đang xử lý')],
          [c(due)]: '2026-09-22',
        },
        // Due today: not before Today.
        {
          [c(created.primaryField)]: 'An Phát hôm nay',
          [c(status)]: [optionId('Mới')],
          [c(due)]: '2026-09-23',
        },
        // Done.
        {
          [c(created.primaryField)]: 'An Phát xong',
          [c(status)]: [optionId('Xong')],
          [c(due)]: '2026-09-01',
        },
        { [c(created.primaryField)]: 'Bình Minh', [c(status)]: [optionId('Mới')] },
        { [c(created.primaryField)]: '100%_an phat\\x' },
      ]);
      // Tickets was created after the fixture schema: admins see it through full access.
      fx.schema.tables.push({
        id: tickets.id,
        fields: [created.primaryField, status, due].map((field) => ({
          id: field.id,
          type: field.type,
        })),
      });
    });

    it('runs the CONTRACTS §1.4 query example (tuple filter by name, sort, search)', async () => {
      const list = await service.query(scope, tickets.id, accessOf(fx, 'u_admin'), {
        fields: ['Tiêu đề', 'Trạng thái'],
        filter: {
          logic: 'and',
          conditions: [
            ['Trạng thái', 'intersects', ['Mới', 'Đang xử lý']],
            ['Hạn', '<', 'Today'],
          ],
        },
        sort: [{ field: 'Hạn', direction: 'asc' }],
        search: 'an phat',
        offset: 0,
        limit: 200,
      });
      expect(list.records.map((record) => record.fields)).toEqual([
        { 'Tiêu đề': 'Cửa hàng An Phát: máy POS lỗi in', 'Trạng thái': 'Mới' },
        { 'Tiêu đề': 'AN PHAT kho 2', 'Trạng thái': 'Đang xử lý' },
      ]);
      expect(list).toMatchObject({ total: 2 });
    });

    it('search is unaccented, case-insensitive and treats LIKE characters literally', async () => {
      const access = accessOf(fx, 'u_admin');
      const found = await service.query(scope, tickets.id, access, { search: '  an phat ' });
      expect(ids(found)).toEqual(ticketIds.filter((_, index) => index !== 4));
      const literal = await service.query(scope, tickets.id, access, { search: '0%_' });
      expect(ids(literal)).toEqual([ticketIds[5]]);
      const percent = await service.query(scope, tickets.id, access, { search: '%' });
      expect(ids(percent)).toEqual([ticketIds[5]]);
      const backslash = await service.query(scope, tickets.id, access, { search: '\\x' });
      expect(ids(backslash)).toEqual([ticketIds[5]]);
      const blank = await service.query(scope, tickets.id, access, { search: '   ' });
      expect(blank.records).toHaveLength(6);
    });

    it('search on a table whose primary field is hidden is rejected', async () => {
      const access = accessOf(fx, 'u_reader');
      const hidden: RecordAccessContext = {
        ...access,
        resolved: {
          ...access.resolved,
          access: {
            ...access.resolved.access,
            tables: {
              ...access.resolved.access.tables,
              [fx.orders.id]: {
                ...(access.resolved.access.tables[fx.orders.id] as NonNullable<
                  (typeof access.resolved.access.tables)[Id<'tbl'>]
                >),
                fields: { [fx.fld.amount.id]: 'read' },
              },
            },
          },
        },
      };
      const error = await appError(service.query(scope, fx.orders.id, hidden, { search: 'an' }));
      expect(error.code).toBe('VALIDATION_FAILED');
      expect(error.errors?.[0]).toMatchObject({ path: 'search', code: 'UNKNOWN_FIELD' });
      const list = await service.query(scope, fx.orders.id, hidden);
      expect(list.records[0]?.fields).toEqual({ amount: 1500000 });
    });

    it('user input never reaches the SQL text', async () => {
      const captured = capturingDb(database.url);
      try {
        const spy = new RecordQueryService(captured.db, { now: () => NOW });
        const marker = "zz'); DROP TABLE meta.users; --";
        await spy.query(scope, tickets.id, accessOf(fx, 'u_admin'), {
          search: marker,
          filter: { logic: 'or', conditions: [['Tiêu đề', 'intersects', marker]] },
        });
        const texts = captured.queries.map((query) => query.sql);
        expect(texts.length).toBeGreaterThan(0);
        for (const text of texts) expect(text).not.toContain('DROP TABLE');
        expect(captured.queries.some((query) => query.parameters.includes(marker))).toBe(true);
      } finally {
        await captured.db.destroy();
      }
    });

    it('search uses the trigram index of the primary field (EXPLAIN)', async () => {
      const context = systemAuditContext();
      const { table, primaryField } = await schema.createTable(
        scope,
        { baseId: fx.baseId, name: 'Search', primaryFieldName: 'Tên' },
        context,
      );
      const words = ['Nguyễn Văn An', 'Trần Thị Bình', 'Lê Hoàng Cường', 'Phạm Minh Dũng'];
      await insertBulk(pool, table, [
        {
          name: primaryField.db_column_name as string,
          pgType: 'text',
          values: Array.from(
            { length: 20_000 },
            (_, index) => `${words[index % 4] ?? ''} ${String(index)}`,
          ),
        },
      ]);
      await pool.query(`ANALYZE data.${pg.escapeIdentifier(table.db_table_name)}`);
      fx.schema.tables.push({ id: table.id, fields: [{ id: primaryField.id, type: 'text' }] });

      const captured = capturingDb(database.url);
      try {
        const spy = new RecordQueryService(captured.db, { now: () => NOW });
        const list = await spy.query(scope, table.id, accessOf(fx, 'u_admin'), {
          search: 'cuong 1234',
          limit: 50,
        });
        expect(list.records.map((record) => record.fields['Tên'])).toEqual([
          'Lê Hoàng Cường 1234',
          'Lê Hoàng Cường 12342',
          'Lê Hoàng Cường 12346',
        ]);
        const page = captured.queries.find(
          (query) => query.sql.includes('ORDER BY') && query.sql.includes(table.db_table_name),
        );
        expect(page).toBeDefined();
        const client = await pool.connect();
        try {
          const { rows } = await client.query<{ 'QUERY PLAN': unknown }>(
            `EXPLAIN (FORMAT JSON) ${page?.sql ?? ''}`,
            page?.parameters as unknown[],
          );
          const plan = JSON.stringify(rows[0]?.['QUERY PLAN']);
          expect(plan).toContain(`${primaryField.db_column_name ?? ''}_trgm`);
          expect(plan).toContain('Bitmap Index Scan');
        } finally {
          client.release();
        }
      } finally {
        await captured.db.destroy();
      }
    });
  });

  describe('timeouts', () => {
    it('a statement cancelled by statement_timeout is 504 QUERY_TIMEOUT', async () => {
      const locker = await pool.connect();
      try {
        await locker.query('BEGIN');
        await locker.query(
          `LOCK TABLE data.${pg.escapeIdentifier(fx.orders.db_table_name)} IN ACCESS EXCLUSIVE MODE`,
        );
        const impatient = new RecordQueryService(db, { now: () => NOW, statementTimeoutMs: 200 });
        const error = await appError(
          impatient.query(scope, fx.orders.id, accessOf(fx, 'u_reader')),
        );
        expect(error.code).toBe('QUERY_TIMEOUT');
        expect(error.status).toBe(504);
      } finally {
        await locker.query('ROLLBACK');
        locker.release();
      }
    });

    it('reads run in a read-only transaction', async () => {
      const captured = capturingDb(database.url);
      try {
        const spy = new RecordQueryService(captured.db, { now: () => NOW });
        await spy.query(scope, fx.orders.id, accessOf(fx, 'u_reader'), { limit: 1 });
        expect(captured.queries.some((query) => query.sql === 'SET TRANSACTION READ ONLY')).toBe(
          true,
        );
      } finally {
        await captured.db.destroy();
      }
    });

    it('runs inside a caller transaction when the scope carries one', async () => {
      const list = await db.withTx(async (tx) => {
        const txScope = orgScope(ORG_A, tx);
        await sql`SELECT 1`.execute(tx);
        return service.query(txScope, fx.orders.id, accessOf(fx, 'u_sales1'));
      });
      expect(ids(list)).toEqual([r1]);
    });
  });

  describe('tenant isolation', () => {
    let tenantB: Awaited<ReturnType<typeof seedTenant>>;

    beforeAll(async () => {
      tenantB = await seedTenant(db, ORG_B);
    });

    it("org B's scope cannot read org A's table, even with A's access context", async () => {
      const scopeB = orgScope(ORG_B);
      const access = accessOf(fx, 'u_admin');
      expect((await appError(service.query(scopeB, fx.orders.id, access))).code).toBe('NOT_FOUND');
      expect((await appError(service.getRecord(scopeB, fx.orders.id, r1, access))).code).toBe(
        'NOT_FOUND',
      );
      // Same with an access context naming B's base.
      const asB = { ...access, baseId: tenantB.baseId };
      expect((await appError(service.query(scopeB, fx.orders.id, asB))).code).toBe('NOT_FOUND');
    });

    it('MemberDirectoryRepository resolves members of the scoped organization only', async () => {
      const directory = new MemberDirectoryRepository(db);
      const idsA = [fx.users.u_sales1.id, fx.users.u_sales2.id, tenantB.userId];
      const inA = await directory.findMembers(orgScope(ORG_A), idsA);
      expect(inA.map((member) => member.id).sort()).toEqual(
        [fx.users.u_sales1.id, fx.users.u_sales2.id].sort(),
      );
      const inB = await directory.findMembers(orgScope(ORG_B), idsA);
      expect(inB).toEqual([]);
      expect(await directory.findMembers(orgScope(ORG_A), [])).toEqual([]);
    });

    it("sorting by a user field never reads names of another organization's members", async () => {
      // B's user ("T106RecQueryOrgB") sorts before "User sales2" if its name leaked.
      await db.kysely
        .insertInto('meta.org_members')
        .values({ organization_id: ORG_B, user_id: tenantB.userId, role: 'member' })
        .execute();
      const { table } = await schema.createTable(
        scope,
        { baseId: fx.baseId, name: 'Sort by owner', primaryFieldName: 'title' },
        systemAuditContext(),
      );
      const owner = await schema.addField(
        scope,
        table.id,
        { name: 'owner', type: 'user', options: { multiple: false } },
        systemAuditContext(),
      );
      const primary = await db.kysely
        .selectFrom('meta.fields')
        .selectAll()
        .where('id', '=', table.primary_field_id as Id<'fld'>)
        .executeTakeFirstOrThrow();
      fx.schema.tables.push({
        id: table.id,
        fields: [primary, owner].map((field) => ({ id: field.id, type: field.type })),
      });
      const column = owner.db_column_name as string;
      const [ofB, ofA] = await insertRows(pool, table, [
        { [primary.db_column_name as string]: 'foreign owner', [column]: [tenantB.userId] },
        { [primary.db_column_name as string]: 'member owner', [column]: [fx.users.u_sales2.id] },
      ]);
      const sorted = await service.query(scope, table.id, accessOf(fx, 'u_reader'), {
        sort: [{ field: 'owner' }],
      });
      // The foreign user has no name in A: it sorts like an empty value (last).
      expect(ids(sorted)).toEqual([ofA, ofB]);
    });
  });
});
