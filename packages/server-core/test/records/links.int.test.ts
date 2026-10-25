/**
 * Link fields (BACKLOG T401, SPEC §5.6, ADR-28 §4) on PostgreSQL 18: the
 * junction created by `SchemaService`, reads and writes through the record
 * services, P20, limits, trash, audit/events/realtime and compaction.
 */
import { newId, type Id } from '@cellhive/contracts';
import { LINK_MAX_PER_CELL } from '@cellhive/field-types';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemAuditContext, type AuditContext } from '../../src/audit/index.js';
import { orgScope, type Db } from '../../src/db/index.js';
import { AppError } from '../../src/errors/index.js';
import {
  RecordMutationService,
  RecordQueryService,
  type RecordAccessContext,
  type RecordChange,
  type RecordChangeLink,
} from '../../src/records/index.js';
import { FieldsRepository, SchemaService } from '../../src/schema/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';

import { accessOf, buildOrdersFixture, NOW, type OrdersFixture } from './fixtures.js';

import type { FieldRow, JsonObject } from '../../src/db/schema.js';

const ORG_A: Id<'org'> = 'org_T401LinksOrgAAAA';
const ORG_B: Id<'org'> = 'org_T401LinksOrgBBBB';

async function appError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected an AppError');
}

describe('link fields (PostgreSQL 18)', () => {
  let database: TestDatabase;
  let db: Db;
  let admin: pg.Pool;
  let schema: SchemaService;
  let service: RecordMutationService;
  let query: RecordQueryService;
  let fx: OrdersFixture;
  const published: { changes: RecordChange[]; links: readonly RecordChangeLink[] }[] = [];
  const scope = orgScope(ORG_A);
  const context = systemAuditContext();
  let customer: FieldRow;
  let r1: Id<'rec'>, r2: Id<'rec'>, r3: Id<'rec'>;
  let c1: Id<'rec'>, c2: Id<'rec'>, c3: Id<'rec'>;

  const as = (user: keyof OrdersFixture['users']): RecordAccessContext => accessOf(fx, user);
  const auditOf = (user: keyof OrdersFixture['users']): AuditContext => {
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

  /** Registers a new field in the fixture's permission schema (roles see it). */
  function register(field: FieldRow): void {
    const table = fx.schema.tables.find((candidate) => candidate.id === field.table_id);
    if (table === undefined) throw new Error('unknown table');
    table.fields = [...table.fields, { id: field.id, type: field.type }];
  }

  async function junctionRows(
    field: FieldRow,
  ): Promise<{ a_id: string; b_id: string; position: number }[]> {
    const result = await admin.query<{ a_id: string; b_id: string; position: number }>(
      `SELECT a_id, b_id, position FROM data.${pg.escapeIdentifier(field.link_junction as string)} ORDER BY a_id, position, b_id`,
    );
    return result.rows;
  }

  async function read(
    tableId: Id<'tbl'>,
    id: Id<'rec'>,
    user: keyof OrdersFixture['users'] = 'u_admin',
    format: 'json' | 'text' = 'json',
  ) {
    return query.getRecord(scope, tableId, id, as(user), { cell_format: format });
  }

  async function createCustomers(names: readonly string[]): Promise<Id<'rec'>[]> {
    const out = await service.create(
      scope,
      fx.customers.id,
      as('u_admin'),
      { records: names.map((name) => ({ fields: { name } })) },
      auditOf('u_admin'),
    );
    return out.records.map((record) => record.id);
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    admin = new pg.Pool({ connectionString: database.adminUrl, max: 4 });
    schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    query = new RecordQueryService(db, { now: () => NOW });
    service = new RecordMutationService(db, {
      schema,
      query,
      now: () => NOW,
      publisher: {
        publish: (changes, _fields, links) => {
          published.push({ changes: [...changes], links: links ?? [] });
        },
      },
    });
    fx = await buildOrdersFixture(db, schema, ORG_A);
    // CONTRACTS §5: `customer` link Orders → Customers (one-way).
    customer = await schema.addField(
      scope,
      fx.orders.id,
      { name: 'customer', type: 'link', options: { link_table: fx.customers.id } },
      context,
    );
    register(customer);
    [c1, c2, c3] = (await createCustomers(['An Phát', 'Bình Minh', 'Cát Tường'])) as [
      Id<'rec'>,
      Id<'rec'>,
      Id<'rec'>,
    ];
    const seeded = await service.create(
      scope,
      fx.orders.id,
      as('u_admin'),
      {
        records: [
          { fields: { title: 'r1', owner: [{ id: fx.users.u_sales1.id }], customer: [c1] } },
          { fields: { title: 'r2', owner: [{ id: fx.users.u_sales2.id }], customer: [c2, c1] } },
          { fields: { title: 'r3' } },
        ],
      },
      auditOf('u_admin'),
    );
    [r1, r2, r3] = seeded.records.map((record) => record.id) as [Id<'rec'>, Id<'rec'>, Id<'rec'>];
  });

  afterAll(async () => {
    await admin.end();
    await db.destroy();
    await database.drop();
  });

  describe('schema', () => {
    it('creates the junction with its keys and indexes, no column', async () => {
      expect(customer.type).toBe('link');
      expect(customer.db_column_name).toBeNull();
      expect(customer.link_side).toBe('a');
      expect(customer.link_junction).toMatch(/^l_[0-9a-z]{12}$/);
      expect(customer.options).toEqual({
        link_table: fx.customers.id,
        bidirectional: false,
        bidirectional_link_field_name: null,
        allow_multiple: true,
        record_filter: null,
        symmetric_field_id: null,
      });
      const junction = customer.link_junction as string;
      const constraints = await admin.query<{ conname: string; contype: string; def: string }>(
        `SELECT conname, contype, pg_get_constraintdef(c.oid) AS def
           FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
          WHERE t.relname = $1 AND contype IN ('f', 'p') ORDER BY conname`,
        [junction],
      );
      expect(constraints.rows.map((row) => [row.conname, row.contype])).toEqual([
        [`${junction}_a_fkey`, 'f'],
        [`${junction}_b_fkey`, 'f'],
        [`${junction}_pkey`, 'p'],
      ]);
      expect(constraints.rows.filter((row) => row.contype === 'f').map((row) => row.def)).toEqual([
        `FOREIGN KEY (a_id) REFERENCES data.${fx.orders.db_table_name}(__id) ON DELETE CASCADE`,
        `FOREIGN KEY (b_id) REFERENCES data.${fx.customers.db_table_name}(__id) ON DELETE CASCADE`,
      ]);
      const indexes = await admin.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'data' AND tablename = $1 ORDER BY 1`,
        [junction],
      );
      expect(indexes.rows.map((row) => row.indexname)).toEqual([
        `${junction}_b_idx`,
        `${junction}_pkey`,
      ]);
      expect(await schema.checkConsistency(scope, fx.orders.id)).toEqual([]);
    });

    it('counts towards MAX_FIELDS_PER_TABLE without using a column slot', async () => {
      const limited = new SchemaService(db, { maxFieldsPerTable: 7 });
      const before = await schema.usedSlots(scope, fx.orders.id);
      // Orders has 7 active fields (title…created by, customer).
      const error = await appError(
        limited.addField(
          scope,
          fx.orders.id,
          { name: 'more', type: 'link', options: { link_table: fx.customers.id } },
          context,
        ),
      );
      expect(error.code).toBe('FIELD_LIMIT_EXCEEDED');
      expect(await schema.usedSlots(scope, fx.orders.id)).toBe(before);
    });

    it('refuses a linked table of another base or organization (404) and unique values', async () => {
      const other = await appError(
        schema.addField(
          scope,
          fx.orders.id,
          { name: 'x', type: 'link', options: { link_table: 'tbl_0000000000000000' } },
          context,
        ),
      );
      expect(other.code).toBe('NOT_FOUND');
      const unique = await appError(
        schema.addField(
          scope,
          fx.orders.id,
          {
            name: 'x',
            type: 'link',
            options: { link_table: fx.customers.id },
            uniqueValues: true,
          },
          context,
        ),
      );
      expect(unique.errors?.[0]?.code).toBe('UNIQUE_NOT_SUPPORTED');
    });

    it('validates record_filter against the linked table as the saver reads it', async () => {
      const unknown = await appError(
        schema.addField(
          scope,
          fx.orders.id,
          {
            name: 'filtered',
            type: 'link',
            options: {
              link_table: fx.customers.id,
              record_filter: {
                op: 'and',
                items: [{ field: fx.fld.phone.id, operator: 'is_not_empty' }],
              },
            },
            link: { readableTargetFieldIds: new Set([fx.fld.name.id]) },
          },
          context,
        ),
      );
      expect(unknown.code).toBe('INVALID_FILTER');
      expect(unknown.errors?.[0]).toMatchObject({
        code: 'UNKNOWN_FIELD',
        path: 'options.record_filter.items[0].field',
      });
    });

    it('refuses to change the linked table, the direction or allow_multiple true → false in a PATCH', async () => {
      for (const [options, path] of [
        [{ link_table: fx.orders.id }, 'options.link_table'],
        [{ bidirectional: true }, 'options.bidirectional'],
        [{ allow_multiple: false }, 'options.allow_multiple'],
      ] as const) {
        const error = await appError(
          schema.updateField(scope, customer.id, { optionsPatch: options }, context),
        );
        expect(error.code).toBe('CONVERSION_NOT_ALLOWED');
        expect(error.errors?.[0]?.path).toBe(path);
      }
    });
  });

  describe('reads', () => {
    it('returns [{ id, title }] in link order; text joins the titles', async () => {
      expect((await read(fx.orders.id, r2)).fields.customer).toEqual([
        { id: c2, title: 'Bình Minh' },
        { id: c1, title: 'An Phát' },
      ]);
      expect((await read(fx.orders.id, r3)).fields.customer).toBeNull();
      expect((await read(fx.orders.id, r2, 'u_admin', 'text')).fields.customer).toBe(
        'Bình Minh, An Phát',
      );
      const page = await query.query(scope, fx.orders.id, as('u_admin'), {
        fields: ['title', 'customer'],
      });
      expect(page.records.map((record) => record.fields)).toEqual([
        { title: 'r1', customer: [{ id: c1, title: 'An Phát' }] },
        {
          title: 'r2',
          customer: [
            { id: c2, title: 'Bình Minh' },
            { id: c1, title: 'An Phát' },
          ],
        },
        { title: 'r3', customer: null },
      ]);
    });

    it('reads cells through the junction indexes: primary key (a side), b_id index (b side)', async () => {
      const junction = pg.escapeIdentifier(customer.link_junction as string);
      const client = await admin.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL enable_seqscan = off');
        const plan = async (column: 'a_id' | 'b_id') =>
          (
            await client.query<{ 'QUERY PLAN': string }>(
              `EXPLAIN SELECT a_id, b_id, position FROM data.${junction} WHERE ${column} = ANY($1::text[])`,
              [[r1, r2]],
            )
          ).rows
            .map((row) => row['QUERY PLAN'])
            .join('\n');
        expect(await plan('a_id')).toContain(`${customer.link_junction as string}_pkey`);
        expect(await plan('b_id')).toContain(`${customer.link_junction as string}_b_idx`);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });

    it('P20: u_sales1 reads the id of r1.customer with title null', async () => {
      const record = await read(fx.orders.id, r1, 'u_sales1');
      expect(record.fields.customer).toEqual([{ id: c1, title: null }]);
      expect((await read(fx.orders.id, r1, 'u_sales1', 'text')).fields.customer).toBe('');
    });

    it('a link field cannot be sorted or grouped (INVALID_SORT); hidden ones are unknown', async () => {
      const sort = await appError(
        query.query(scope, fx.orders.id, as('u_admin'), { sort: [{ field: 'customer' }] }),
      );
      expect(sort.code).toBe('INVALID_SORT');
      expect(sort.errors?.[0]).toMatchObject({ path: 'sort[0].field', code: 'FIELD_NOT_SORTABLE' });
      const group = await appError(
        query.query(scope, fx.orders.id, as('u_admin'), { group: [{ field: 'customer' }] }),
      );
      expect(group.errors?.[0]?.code).toBe('FIELD_NOT_SORTABLE');
    });
  });

  describe('writes', () => {
    it('writes ids ([id] or [{ id }]) and typecasts titles', async () => {
      const out = await service.update(
        scope,
        fx.orders.id,
        as('u_admin'),
        { records: [{ id: r3, fields: { customer: [{ id: c3 }, c2] } }] },
        auditOf('u_admin'),
      );
      expect(out.records[0]?.fields.customer).toEqual([
        { id: c3, title: 'Cát Tường' },
        { id: c2, title: 'Bình Minh' },
      ]);
      expect(out.records[0]?.version).toBe(2);
      const cast = await service.update(
        scope,
        fx.orders.id,
        as('u_admin'),
        { typecast: true, records: [{ id: r3, fields: { customer: ['An Phát', c2] } }] },
        auditOf('u_admin'),
      );
      expect(cast.records[0]?.fields.customer).toEqual([
        { id: c1, title: 'An Phát' },
        { id: c2, title: 'Bình Minh' },
      ]);
      // The same cell again: nothing changes, no new version.
      const same = await service.update(
        scope,
        fx.orders.id,
        as('u_admin'),
        { records: [{ id: r3, fields: { customer: [c1, c2] } }] },
        auditOf('u_admin'),
      );
      expect(same.records[0]?.version).toBe(3);
      const unknownTitle = await appError(
        service.update(
          scope,
          fx.orders.id,
          as('u_admin'),
          { typecast: true, records: [{ id: r3, fields: { customer: ['Không có'] } }] },
          auditOf('u_admin'),
        ),
      );
      expect(unknownTitle.code).toBe('LINK_TARGET_NOT_FOUND');
      expect(unknownTitle.status).toBe(422);
    });

    it('a title shared by two records is not found, detailed as ambiguous (T421a)', async () => {
      const [dup1, dup2] = await createCustomers(['Trùng', 'Trùng']);
      const error = await appError(
        service.update(
          scope,
          fx.orders.id,
          as('u_admin'),
          { typecast: true, records: [{ id: r3, fields: { customer: 'Trùng' } }] },
          auditOf('u_admin'),
        ),
      );
      expect(error.code).toBe('LINK_TARGET_NOT_FOUND');
      // The detail tells the UI why ("same title"): only records the caller reads count.
      expect(error.errors?.map((item) => item.code)).toEqual(['LINK_TARGET_AMBIGUOUS']);
      await service.delete(
        scope,
        fx.customers.id,
        as('u_admin'),
        { ids: [dup1 as string, dup2 as string] },
        auditOf('u_admin'),
      );
    });

    it('u_sales1 linking a Customers record → 422 LINK_TARGET_NOT_FOUND, like a missing id', async () => {
      const unreadable = await appError(
        service.update(
          scope,
          fx.orders.id,
          as('u_sales1'),
          { records: [{ id: r1, fields: { customer: [c1, c2] } }] },
          auditOf('u_sales1'),
        ),
      );
      const missing = await appError(
        service.update(
          scope,
          fx.orders.id,
          as('u_sales1'),
          { records: [{ id: r1, fields: { customer: [c1, 'rec_0000000000000000'] } }] },
          auditOf('u_sales1'),
        ),
      );
      for (const error of [unreadable, missing]) {
        expect(error.code).toBe('LINK_TARGET_NOT_FOUND');
        expect(error.status).toBe(422);
        expect(error.errors?.[0]?.path).toBe('records[0].fields.customer');
        expect(error.errors?.[0]?.message).toBe('The linked record does not exist');
      }
    });

    it('resending the cell keeps links to records the writer cannot read', async () => {
      const out = await service.update(
        scope,
        fx.orders.id,
        as('u_sales1'),
        { records: [{ id: r1, fields: { customer: [c1], amount: 5 } }] },
        auditOf('u_sales1'),
      );
      expect(out.records[0]?.fields.customer).toEqual([{ id: c1, title: null }]);
      expect(await junctionRows(customer)).toContainEqual({ a_id: r1, b_id: c1, position: 0 });
      // Removing is allowed (the id was visible), adding it back is not.
      await service.update(
        scope,
        fx.orders.id,
        as('u_sales1'),
        { records: [{ id: r1, fields: { customer: [] } }] },
        auditOf('u_sales1'),
      );
      const readd = await appError(
        service.update(
          scope,
          fx.orders.id,
          as('u_sales1'),
          { records: [{ id: r1, fields: { customer: [c1] } }] },
          auditOf('u_sales1'),
        ),
      );
      expect(readd.code).toBe('LINK_TARGET_NOT_FOUND');
      await service.update(
        scope,
        fx.orders.id,
        as('u_admin'),
        { records: [{ id: r1, fields: { customer: [c1] } }] },
        auditOf('u_admin'),
      );
    });

    it('record_filter is checked for new links', async () => {
      const vip = await schema.addField(
        scope,
        fx.orders.id,
        {
          name: 'vip',
          type: 'link',
          options: {
            link_table: fx.customers.id,
            record_filter: {
              op: 'and',
              items: [{ field: fx.fld.name.id, operator: 'starts_with', value: 'An' }],
            },
          },
        },
        context,
      );
      register(vip);
      const ok = await service.update(
        scope,
        fx.orders.id,
        as('u_admin'),
        { records: [{ id: r3, fields: { vip: [c1] } }] },
        auditOf('u_admin'),
      );
      expect(ok.records[0]?.fields.vip).toEqual([{ id: c1, title: 'An Phát' }]);
      const error = await appError(
        service.update(
          scope,
          fx.orders.id,
          as('u_admin'),
          { records: [{ id: r3, fields: { vip: [c1, c2] } }] },
          auditOf('u_admin'),
        ),
      );
      expect(error.code).toBe('LINK_TARGET_NOT_FOUND');
      expect(error.errors?.[0]?.params).toEqual({ id: c2 });
      await schema.deleteField(scope, vip.id, context);
    });

    it('allow_multiple = false keeps one link per cell (junction unique index)', async () => {
      const single = await schema.addField(
        scope,
        fx.orders.id,
        {
          name: 'main customer',
          type: 'link',
          options: { link_table: fx.customers.id, allow_multiple: false },
        },
        context,
      );
      register(single);
      const indexes = await admin.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE tablename = $1 ORDER BY 1`,
        [single.link_junction],
      );
      expect(indexes.rows.map((row) => row.indexname)).toContain(
        `${single.link_junction as string}_a_uniq`,
      );
      const error = await appError(
        service.update(
          scope,
          fx.orders.id,
          as('u_admin'),
          { records: [{ id: r3, fields: { 'main customer': [c1, c2] } }] },
          auditOf('u_admin'),
        ),
      );
      expect(error.code).toBe('INVALID_CELL_VALUE');
      expect(error.errors?.[0]).toMatchObject({ code: 'TOO_MANY_VALUES', params: { limit: 1 } });
      const moved = await service.update(
        scope,
        fx.orders.id,
        as('u_admin'),
        { records: [{ id: r3, fields: { 'main customer': [c1] } }] },
        auditOf('u_admin'),
      );
      expect(moved.records[0]?.fields['main customer']).toEqual([{ id: c1, title: 'An Phát' }]);
      await service.update(
        scope,
        fx.orders.id,
        as('u_admin'),
        { records: [{ id: r3, fields: { 'main customer': [c2] } }] },
        auditOf('u_admin'),
      );
      expect(await junctionRows(single)).toEqual([{ a_id: r3, b_id: c2, position: 0 }]);
      // false → true drops the unique index (no conversion needed).
      await schema.updateField(
        scope,
        single.id,
        { optionsPatch: { allow_multiple: true } },
        context,
      );
      const after = await admin.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE tablename = $1`,
        [single.link_junction],
      );
      expect(after.rows.map((row) => row.indexname)).not.toContain(
        `${single.link_junction as string}_a_uniq`,
      );
      await schema.deleteField(scope, single.id, context);
    });

    it('the 501st link of a cell → 422 TOO_MANY_VALUES', async () => {
      const many = await createCustomers(
        Array.from({ length: LINK_MAX_PER_CELL + 1 }, (_, i) => `k${String(i)}`),
      );
      const full = await service.update(
        scope,
        fx.orders.id,
        as('u_admin'),
        { records: [{ id: r3, fields: { customer: many.slice(0, LINK_MAX_PER_CELL) } }] },
        auditOf('u_admin'),
      );
      expect(full.records[0]?.fields.customer).toHaveLength(LINK_MAX_PER_CELL);
      const error = await appError(
        service.update(
          scope,
          fx.orders.id,
          as('u_admin'),
          { records: [{ id: r3, fields: { customer: many } }] },
          auditOf('u_admin'),
        ),
      );
      expect(error.code).toBe('INVALID_CELL_VALUE');
      expect(error.errors?.[0]).toMatchObject({
        path: 'records[0].fields.customer',
        code: 'TOO_MANY_VALUES',
        params: { limit: LINK_MAX_PER_CELL },
      });
      await service.delete(
        scope,
        fx.customers.id,
        as('u_admin'),
        { ids: many },
        auditOf('u_admin'),
      );
      await service.update(
        scope,
        fx.orders.id,
        as('u_admin'),
        { records: [{ id: r3, fields: { customer: [c1, c2] } }] },
        auditOf('u_admin'),
      );
    });

    it('a linked record in the trash leaves the cell (and does not count), restore brings it back', async () => {
      await service.delete(
        scope,
        fx.customers.id,
        as('u_admin'),
        { ids: [c2] },
        auditOf('u_admin'),
      );
      expect((await read(fx.orders.id, r2)).fields.customer).toEqual([
        { id: c1, title: 'An Phát' },
      ]);
      // Writing the cell keeps the hidden link.
      await service.update(
        scope,
        fx.orders.id,
        as('u_admin'),
        { records: [{ id: r2, fields: { customer: [c1] } }] },
        auditOf('u_admin'),
      );
      const trashed = await appError(
        service.update(
          scope,
          fx.orders.id,
          as('u_admin'),
          { records: [{ id: r1, fields: { customer: [c1, c2] } }] },
          auditOf('u_admin'),
        ),
      );
      expect(trashed.code).toBe('LINK_TARGET_NOT_FOUND');
      await service.restore(
        scope,
        fx.customers.id,
        as('u_admin'),
        { ids: [c2] },
        auditOf('u_admin'),
      );
      expect((await read(fx.orders.id, r2)).fields.customer).toEqual([
        { id: c2, title: 'Bình Minh' },
        { id: c1, title: 'An Phát' },
      ]);
    });

    it('a linked table in the trash: the field stays, its cells read empty', async () => {
      await schema.deleteTable(scope, fx.customers.id, context);
      try {
        expect((await read(fx.orders.id, r2)).fields.customer).toBeNull();
        const error = await appError(
          service.update(
            scope,
            fx.orders.id,
            as('u_admin'),
            { records: [{ id: r3, fields: { customer: [c3] } }] },
            auditOf('u_admin'),
          ),
        );
        expect(error.code).toBe('LINK_TARGET_NOT_FOUND');
      } finally {
        await schema.restoreTable(scope, fx.customers.id, context);
      }
      expect((await read(fx.orders.id, r2)).fields.customer).toHaveLength(2);
    });

    it('a required link field needs a linked record', async () => {
      const required = await schema.addField(
        scope,
        fx.customers.id,
        {
          name: 'referrer',
          type: 'link',
          options: { link_table: fx.customers.id },
          required: true,
        },
        context,
      );
      register(required);
      const error = await appError(
        service.create(
          scope,
          fx.customers.id,
          as('u_admin'),
          { records: [{ fields: { name: 'no referrer' } }] },
          auditOf('u_admin'),
        ),
      );
      expect(error.code).toBe('REQUIRED_FIELD_MISSING');
      expect(error.errors?.[0]?.path).toBe('records[0].fields.referrer');
      await schema.deleteField(scope, required.id, context);
    });
  });

  describe('two-way links', () => {
    let orders: FieldRow;
    let reverse: FieldRow;

    beforeAll(async () => {
      orders = await schema.addField(
        scope,
        fx.customers.id,
        {
          name: 'orders',
          type: 'link',
          options: {
            link_table: fx.orders.id,
            bidirectional: true,
            bidirectional_link_field_name: 'buyer',
          },
        },
        context,
      );
      const fields = new FieldsRepository(db);
      reverse = (await fields.getById(
        scope,
        (orders.options as JsonObject).symmetric_field_id as Id<'fld'>,
      )) as FieldRow;
      register(orders);
      register(reverse);
    });

    it('creates the reverse field on the same junction', () => {
      expect(reverse).toMatchObject({
        table_id: fx.orders.id,
        name: 'buyer',
        type: 'link',
        link_junction: orders.link_junction,
        link_side: 'b',
        options: {
          link_table: fx.customers.id,
          bidirectional: true,
          symmetric_field_id: orders.id,
          allow_multiple: true,
        },
      });
      expect(orders.options).toMatchObject({ bidirectional: true, symmetric_field_id: reverse.id });
    });

    it('a write on either side shows on the other; one audit row per record per side, one batch', async () => {
      published.length = 0;
      const audit = auditOf('u_admin');
      const out = await service.update(
        scope,
        fx.customers.id,
        as('u_admin'),
        { records: [{ id: c1, fields: { orders: [r2, r1] } }] },
        audit,
      );
      expect(out.records[0]?.fields.orders).toEqual([
        { id: r2, title: 'r2' },
        { id: r1, title: 'r1' },
      ]);
      expect((await read(fx.orders.id, r1)).fields.buyer).toEqual([{ id: c1, title: 'An Phát' }]);
      expect((await read(fx.orders.id, r2)).fields.buyer).toEqual([{ id: c1, title: 'An Phát' }]);

      const audits = await admin.query<{
        entity_id: string;
        table_id: string;
        batch_id: string;
        after: JsonObject;
      }>(
        `SELECT entity_id, table_id, batch_id, after FROM meta.audit_logs
          WHERE batch_id = $1 ORDER BY table_id, entity_id`,
        [audit.batch_id],
      );
      expect(audits.rows).toHaveLength(3);
      expect(audits.rows.map((row) => row.entity_id).sort()).toEqual([c1, r1, r2].sort());
      expect(audits.rows.find((row) => row.entity_id === c1)?.after).toEqual({
        [orders.id]: [r2, r1],
      });
      expect(audits.rows.find((row) => row.entity_id === r1)?.after).toEqual({
        [reverse.id]: [c1],
      });
      const events = await admin.query<{ entity_id: string; type: string }>(
        `SELECT entity_id, type FROM meta.events WHERE entity_id = ANY($1) AND type = 'record.updated'`,
        [[c1, r1, r2]],
      );
      expect(new Set(events.rows.map((row) => row.entity_id))).toEqual(new Set([c1, r1, r2]));

      // Realtime for both tables, link titles and link meta for the gateway.
      const byTable = new Map(published.map((entry) => [entry.changes[0]?.tableId, entry]));
      expect(byTable.get(fx.customers.id)?.changes[0]?.values[orders.id]).toEqual([
        { id: r2, title: 'r2' },
        { id: r1, title: 'r1' },
      ]);
      expect(byTable.get(fx.customers.id)?.links).toEqual([
        { id: orders.id, tableId: fx.orders.id, titleFieldId: fx.fld.title.id },
      ]);
      const ordersChanges = byTable.get(fx.orders.id)?.changes ?? [];
      expect(ordersChanges.map((change) => change.recordId).sort()).toEqual([r1, r2].sort());
      expect(ordersChanges[0]?.values[reverse.id]).toEqual([{ id: c1, title: 'An Phát' }]);
      expect(byTable.get(fx.orders.id)?.links).toEqual([
        { id: reverse.id, tableId: fx.customers.id, titleFieldId: fx.fld.name.id },
      ]);

      // From the reverse side: r1 now links c2 too.
      await service.update(
        scope,
        fx.orders.id,
        as('u_admin'),
        { records: [{ id: r1, fields: { buyer: [c1, c2] } }] },
        auditOf('u_admin'),
      );
      expect((await read(fx.customers.id, c2)).fields.orders).toEqual([{ id: r1, title: 'r1' }]);
      expect((await read(fx.customers.id, c1)).fields.orders).toEqual([
        { id: r2, title: 'r2' },
        { id: r1, title: 'r1' },
      ]);
    });

    it('limits the reverse cell too: path names the record causing it', async () => {
      const many = await service.create(
        scope,
        fx.orders.id,
        as('u_admin'),
        {
          records: Array.from({ length: LINK_MAX_PER_CELL }, (_, i) => ({
            fields: { title: `o${String(i)}` },
          })),
        },
        auditOf('u_admin'),
      );
      const ids = many.records.map((record) => record.id);
      // c3 gets 500 orders from the Customers side (its own cell: 500).
      await service.update(
        scope,
        fx.customers.id,
        as('u_admin'),
        { records: [{ id: c3, fields: { orders: ids } }] },
        auditOf('u_admin'),
      );
      // r3 adding c3 from the Orders side would make c3's cell hold 501.
      const error = await appError(
        service.update(
          scope,
          fx.orders.id,
          as('u_admin'),
          {
            records: [
              { id: r2, fields: { title: 'r2' } },
              { id: r3, fields: { buyer: [c3] } },
            ],
          },
          auditOf('u_admin'),
        ),
      );
      expect(error.code).toBe('INVALID_CELL_VALUE');
      expect(error.errors?.[0]).toMatchObject({
        path: 'records[1].fields.buyer',
        code: 'TOO_MANY_VALUES',
        params: { limit: LINK_MAX_PER_CELL, record_id: c3 },
      });
      await service.delete(scope, fx.orders.id, as('u_admin'), { ids }, auditOf('u_admin'));
    });

    it('deleting one side makes the other one-way; restoring joins them again', async () => {
      await schema.deleteField(scope, reverse.id, context);
      const fields = new FieldsRepository(db);
      expect((await fields.getById(scope, orders.id))?.options).toMatchObject({
        bidirectional: false,
        symmetric_field_id: null,
      });
      // The remaining side still reads (and writes) the junction.
      expect((await read(fx.customers.id, c1)).fields.orders).toHaveLength(2);
      await schema.restoreField(scope, reverse.id, context);
      expect((await fields.getById(scope, orders.id))?.options).toMatchObject({
        bidirectional: true,
        symmetric_field_id: reverse.id,
      });
      expect((await read(fx.orders.id, r1)).fields.buyer).toEqual([
        { id: c1, title: 'An Phát' },
        { id: c2, title: 'Bình Minh' },
      ]);
    });

    it('compaction keeps the links (junction foreign keys rebuilt)', async () => {
      const before = await junctionRows(orders);
      const result = await schema.compactTable(scope, fx.orders.id);
      expect(result.junctionForeignKeys).toEqual(
        expect.arrayContaining([
          `${customer.link_junction as string}_a_fkey`,
          `${orders.link_junction as string}_b_fkey`,
        ]),
      );
      await schema.compactTable(scope, fx.customers.id);
      expect(await junctionRows(orders)).toEqual(before);
      expect((await read(fx.orders.id, r1)).fields.buyer).toHaveLength(2);
      expect(await schema.checkConsistency(scope, fx.orders.id)).toEqual([]);
      // Deleting a record for good still cascades to its links.
      const fk = await admin.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_constraint WHERE conname = $1 AND confdeltype = 'c'`,
        [`${orders.link_junction as string}_b_fkey`],
      );
      expect(fk.rows[0]?.n).toBe('1');
    });
  });

  describe('self-links', () => {
    it('a two-way self-link reads the junction from both sides of one table', async () => {
      const parentOf = await schema.addField(
        scope,
        fx.customers.id,
        {
          name: 'refers',
          type: 'link',
          options: {
            link_table: fx.customers.id,
            bidirectional: true,
            bidirectional_link_field_name: 'referred by',
          },
        },
        context,
      );
      register(parentOf);
      const reverse = (await new FieldsRepository(db).getById(
        scope,
        (parentOf.options as JsonObject).symmetric_field_id as Id<'fld'>,
      )) as FieldRow;
      register(reverse);
      expect(reverse.table_id).toBe(fx.customers.id);
      await service.update(
        scope,
        fx.customers.id,
        as('u_admin'),
        { records: [{ id: c1, fields: { refers: [c2, c3] } }] },
        auditOf('u_admin'),
      );
      expect((await read(fx.customers.id, c2)).fields['referred by']).toEqual([
        { id: c1, title: 'An Phát' },
      ]);
      expect((await read(fx.customers.id, c1)).fields.refers).toEqual([
        { id: c2, title: 'Bình Minh' },
        { id: c3, title: 'Cát Tường' },
      ]);
    });
  });

  describe('tenant isolation', () => {
    it('FieldsRepository.listByJunction is scoped by organization', async () => {
      const fields = new FieldsRepository(db);
      const junction = customer.link_junction as string;
      expect((await fields.listByJunction(scope, junction)).map((row) => row.id)).toEqual([
        customer.id,
      ]);
      expect(await fields.listByJunction(orgScope(ORG_B), junction)).toEqual([]);
    });

    it('a table of another organization cannot be linked', async () => {
      const other = await buildOrdersFixture(db, schema, ORG_B);
      const error = await appError(
        schema.addField(
          scope,
          fx.orders.id,
          { name: 'foreign', type: 'link', options: { link_table: other.customers.id } },
          context,
        ),
      );
      expect(error.code).toBe('NOT_FOUND');
    });
  });
});
