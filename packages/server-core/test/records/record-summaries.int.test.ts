/**
 * The summary bar (BACKLOG T472, CONTRACTS §1.4 `records/summaries`, §15)
 * on PostgreSQL 18: every function × every field type against values
 * computed by hand, `unique` over flattened lists, group summaries of every
 * level (ROLLUP) in row order, the view's saved summaries (entries no longer
 * valid skipped), request summaries (unknown field / wrong function → 422),
 * filters and search, and tenant isolation.
 */
import { newId, type Id, type SummaryFunction } from '@cellhive/contracts';
import { numberFieldType } from '@cellhive/field-types';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemAuditContext, type AuditContext } from '../../src/audit/index.js';
import { orgScope, type Db } from '../../src/db/index.js';
import { AppError } from '../../src/errors/index.js';
import {
  RecordMutationService,
  RecordQueryService,
  type RecordAccessContext,
  type RecordSummariesRequest,
} from '../../src/records/index.js';
import { SchemaService } from '../../src/schema/index.js';
import { configJson, defaultViewConfig, ViewsRepository } from '../../src/views/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';

import { accessOf, buildOrdersFixture, NOW, TIME_ZONE, type OrdersFixture } from './fixtures.js';

import type { FieldRow, TableRow } from '../../src/db/schema.js';

const ORG_A: Id<'org'> = 'org_T472SummariesAAA';
const ORG_B: Id<'org'> = 'org_T472SummariesBBB';

async function appError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected an AppError');
}

const days = (from: string, to: string) =>
  Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

describe('records/summaries (T472)', () => {
  let database: TestDatabase;
  let db: Db;
  let pool: pg.Pool;
  let schema: SchemaService;
  let query: RecordQueryService;
  let fx: OrdersFixture;
  let fxB: OrdersFixture;
  let items: TableRow;
  const fld: Record<string, FieldRow> = {};
  const opt = {
    a: newId('opt'),
    b: newId('opt'),
    x: newId('opt'),
    y: newId('opt'),
    z: newId('opt'),
  };
  let c1: Id<'rec'>, c2: Id<'rec'>;
  const scope = orgScope(ORG_A);
  const context = systemAuditContext();

  const admin = (): RecordAccessContext => accessOf(fx, 'u_admin');
  const audit = (): AuditContext => {
    const requestId = newId('req');
    return {
      actor: { type: 'user', id: fx.users.u_admin.id },
      via: null,
      batch_id: requestId,
      request_id: requestId,
      ip: null,
      user_agent: 'vitest',
    };
  };
  const summaries = (request: RecordSummariesRequest, access = admin()) =>
    query.summaries(scope, items.id, access, { field_key_type: 'name', ...request });
  /** Every field → the same function. */
  const all = (fn: SummaryFunction, names: readonly string[]) =>
    Object.fromEntries(names.map((name) => [name, fn]));

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    pool = new pg.Pool({ connectionString: database.url, max: 2 });
    schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    query = new RecordQueryService(db, { now: () => NOW, defaultTimeZone: TIME_ZONE });
    const mutation = new RecordMutationService(db, {
      schema,
      query,
      now: () => NOW,
      defaultTimeZone: TIME_ZONE,
    });
    fx = await buildOrdersFixture(db, schema, ORG_A);
    fxB = await buildOrdersFixture(db, schema, ORG_B);

    const created = await schema.createTable(
      scope,
      { baseId: fx.baseId, name: 'Items', primaryFieldName: 'title' },
      context,
    );
    items = created.table;
    fld['title'] = created.primaryField;
    const add = async (name: string, type: string, options: unknown = {}) => {
      fld[name] = await schema.addField(scope, items.id, { name, type, options }, context);
    };
    await add('amount', 'number', { style: { type: 'currency', currency_code: 'VND' } });
    await add('rating', 'number', { style: { type: 'rating', max: 5 } });
    await add('due', 'datetime', { style: { format: 'dd/MM/yyyy' } });
    await add('at', 'datetime', { style: { format: 'yyyy-MM-dd HH:mm' } });
    await add('done', 'checkbox');
    await add('status', 'select', {
      options: [
        { id: opt.a, name: 'A' },
        { id: opt.b, name: 'B' },
      ],
    });
    await add('tags', 'select', {
      multiple: true,
      options: [
        { id: opt.x, name: 'X' },
        { id: opt.y, name: 'Y' },
        { id: opt.z, name: 'Z' },
      ],
    });
    await add('people', 'user');
    await add('files', 'attachment');
    await add('code', 'auto_number');
    await add('created', 'created_at');
    await add('customer', 'link', { link_table: fx.customers.id });
    fx.schema.tables.push({
      id: items.id,
      fields: Object.values(fld).map((field) => ({ id: field.id, type: field.type })),
    });

    const customers = await mutation.create(
      scope,
      fx.customers.id,
      admin(),
      { records: [{ fields: { name: 'An Phát' } }, { fields: { name: 'Bình Minh' } }] },
      audit(),
    );
    [c1, c2] = customers.records.map((record) => record.id) as [Id<'rec'>, Id<'rec'>];
    const u = fx.users;
    const created2 = await mutation.create(
      scope,
      items.id,
      admin(),
      {
        typecast: true,
        records: [
          {
            fields: {
              title: 'a',
              amount: 100,
              rating: 3,
              due: '2026-01-10',
              at: '2026-01-01T10:00:00.000Z',
              done: true,
              status: 'A',
              tags: ['X', 'Y'],
              people: [{ id: u.u_admin.id }, { id: u.u_editor.id }],
              customer: [c1],
            },
          },
          {
            fields: {
              title: 'b',
              amount: 250.5,
              rating: 5,
              due: '2026-03-01',
              done: false,
              status: 'B',
              tags: ['Y'],
              people: [{ id: u.u_admin.id }],
              customer: [c1, c2],
            },
          },
          { fields: { at: '2025-12-31T23:00:00.000Z', done: true } },
          {
            fields: {
              title: 'a',
              amount: -50,
              rating: 1,
              due: '2026-01-10',
              at: '2026-02-01T00:00:00.000Z',
              status: 'A',
              tags: ['Z'],
              people: [{ id: u.u_reader.id }],
              customer: [c2],
            },
          },
          { fields: { title: 'c', amount: 0, due: '2025-06-30', tags: ['X'] } },
        ],
      },
      audit(),
    );
    const ids = created2.records.map((record) => record.id);
    // TEST FIXTURE: attachment cells written straight into the data table (uploads are T406).
    const files = pg.escapeIdentifier(fld['files']?.db_column_name as string);
    const table = `data.${pg.escapeIdentifier(items.db_table_name)}`;
    const file = (id: string) => ({ id, name: `${id}.txt`, size: 1, mime: 'text/plain' });
    await pool.query(`UPDATE ${table} SET ${files} = $1::jsonb WHERE __id = $2`, [
      JSON.stringify([file('att_one'), file('att_two')]),
      ids[0],
    ]);
    await pool.query(`UPDATE ${table} SET ${files} = $1::jsonb WHERE __id = $2`, [
      JSON.stringify([file('att_two')]),
      ids[1],
    ]);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await db.destroy();
    await database.drop();
  });

  it('counts, percentages and unique for every type (lists flattened, empty cells ignored)', async () => {
    const names = [
      'title',
      'amount',
      'status',
      'tags',
      'people',
      'files',
      'code',
      'customer',
      'due',
    ];
    const count = (fn: SummaryFunction) =>
      summaries({ summaries: all(fn, names) }).then((result) =>
        Object.fromEntries(
          Object.entries(result.summaries).map(([key, item]) => [key, item.value]),
        ),
      );
    expect(await count('count_all')).toEqual(Object.fromEntries(names.map((name) => [name, 5])));
    expect(await count('filled')).toEqual({
      title: 4,
      amount: 4,
      status: 3,
      tags: 4,
      people: 3,
      files: 2,
      code: 5,
      customer: 3,
      due: 4,
    });
    expect(await count('empty')).toEqual({
      title: 1,
      amount: 1,
      status: 2,
      tags: 1,
      people: 2,
      files: 3,
      code: 0,
      customer: 2,
      due: 1,
    });
    // `unique` of a list = distinct elements after flattening (S4b decision 8).
    expect(await count('unique')).toEqual({
      title: 3,
      amount: 4,
      status: 2,
      tags: 3,
      people: 3,
      files: 2,
      code: 5,
      customer: 2,
      due: 3,
    });
    const percent = await summaries({
      summaries: { title: 'percent_filled', tags: 'percent_empty' },
    });
    expect(percent.count).toBe(5);
    expect(percent.summaries).toEqual({
      title: { fn: 'percent_filled', value: 0.8, count: 4 },
      tags: { fn: 'percent_empty', value: 0.2, count: 1 },
    });
  });

  it('numbers: sum, avg, min, max, range (json and text by the field style)', async () => {
    const result = await summaries({
      summaries: { amount: 'sum', rating: 'avg' },
    });
    expect(result.summaries['amount']).toEqual({ fn: 'sum', value: 300.5 });
    expect(result.summaries['rating']).toEqual({ fn: 'avg', value: 3 });
    const bounds = await summaries({ summaries: { amount: 'min', rating: 'max' } });
    expect(bounds.summaries).toEqual({
      amount: { fn: 'min', value: -50 },
      rating: { fn: 'max', value: 5 },
    });
    const range = await summaries({ summaries: { amount: 'range', rating: 'sum' } });
    expect(range.summaries['amount']).toEqual({ fn: 'range', value: { min: -50, max: 250.5 } });
    expect(range.summaries['rating']).toEqual({ fn: 'sum', value: 9 });

    const text = await query.summaries(scope, items.id, admin(), {
      cell_format: 'text',
      summaries: { amount: 'sum', rating: 'sum' },
    });
    const locale = { locale: admin().locale, timeZone: TIME_ZONE };
    expect(text.summaries['amount']?.value).toBe(
      numberFieldType.formatText(
        300.5,
        { style: { type: 'currency', currency_code: 'VND' } },
        locale,
      ),
    );
    // A sum of ratings is a number, not stars.
    expect(text.summaries['rating']?.value).toBe('9');
  });

  it('dates: earliest, latest, date_range (days) for dates, date-times and created_at', async () => {
    const result = await summaries({
      summaries: { due: 'date_range', at: 'earliest', created: 'date_range' },
    });
    expect(result.summaries['due']).toEqual({
      fn: 'date_range',
      value: { min: '2025-06-30', max: '2026-03-01', days: days('2025-06-30', '2026-03-01') },
    });
    expect(result.summaries['at']).toEqual({ fn: 'earliest', value: '2025-12-31T23:00:00.000Z' });
    // Every record was created in one transaction: one instant, 0 days.
    const created = result.summaries['created']?.value as {
      min: string;
      max: string;
      days: number;
    };
    expect(created.min).toBe(created.max);
    expect(created.days).toBe(0);
    const latest = await summaries({ summaries: { at: 'latest', due: 'earliest' } });
    expect(latest.summaries).toEqual({
      at: { fn: 'latest', value: '2026-02-01T00:00:00.000Z' },
      due: { fn: 'earliest', value: '2025-06-30' },
    });
    const text = await query.summaries(scope, items.id, admin(), {
      cell_format: 'text',
      summaries: { due: 'date_range' },
    });
    expect(text.summaries['due']?.value).toEqual({
      min: '30/06/2025',
      max: '01/03/2026',
      days: days('2025-06-30', '2026-03-01'),
    });
  });

  it('check boxes: count_all, checked, unchecked, percent_checked', async () => {
    const checked = await summaries({ summaries: { done: 'checked' } });
    expect(checked.summaries['done']).toEqual({ fn: 'checked', value: 2 });
    const unchecked = await summaries({ summaries: { done: 'unchecked' } });
    expect(unchecked.summaries['done']).toEqual({ fn: 'unchecked', value: 3 });
    const share = await summaries({ summaries: { done: 'percent_checked' } });
    expect(share.summaries['done']).toEqual({ fn: 'percent_checked', value: 0.4, count: 2 });
  });

  it('a request summary on an unknown field or with a function the type refuses is 422', async () => {
    const unknown = await appError(summaries({ summaries: { "x'; DROP TABLE t; --": 'sum' } }));
    expect(unknown.code).toBe('VALIDATION_FAILED');
    expect(unknown.errors).toEqual([
      expect.objectContaining({ code: 'UNKNOWN_FIELD', path: "summaries.x'; DROP TABLE t; --" }),
    ]);
    const wrong = await appError(summaries({ summaries: { title: 'sum', done: 'filled' } }));
    expect(wrong.errors?.map((item) => [item.path, item.code])).toEqual([
      ['summaries.title', 'INVALID_FIELD_TYPE'],
      ['summaries.done', 'INVALID_FIELD_TYPE'],
    ]);
  });

  it('the view: saved summaries (invalid entries skipped), its filter, the request filter and search', async () => {
    const view = await new ViewsRepository(db).insert(scope, {
      id: newId('viw'),
      tableId: items.id,
      type: 'grid',
      name: 'Positive',
      config: configJson({
        ...defaultViewConfig('grid'),
        filter: { op: 'and', items: [{ field: fld['amount']?.id, operator: 'gte', value: 0 }] },
        summaries: {
          [fld['amount']?.id as string]: 'sum',
          [fld['tags']?.id as string]: 'unique',
          // A text field no longer takes `sum` (a type change): skipped, not an error.
          [fld['title']?.id as string]: 'sum',
          [newId('fld')]: 'sum',
        },
      }),
      position: 1,
      ownerId: null,
    });
    const saved = await summaries({ view_id: view.id });
    expect(saved.count).toBe(3);
    expect(saved.summaries).toEqual({
      amount: { fn: 'sum', value: 350.5 },
      tags: { fn: 'unique', value: 2 },
    });
    // The request's summaries replace the saved ones (a temporary change).
    const temporary = await summaries({ view_id: view.id, summaries: { title: 'unique' } });
    expect(temporary.summaries).toEqual({ title: { fn: 'unique', value: 3 } });
    const narrowed = await summaries({
      view_id: view.id,
      filter: { logic: 'and', conditions: [['amount', '>', 100]] },
    });
    expect(narrowed.count).toBe(1);
    expect(narrowed.summaries['amount']).toEqual({ fn: 'sum', value: 250.5 });
    const replaced = await summaries({
      view_id: view.id,
      filter_mode: 'replace',
      filter: null,
      summaries: { amount: 'sum' },
    });
    expect(replaced.summaries['amount']).toEqual({ fn: 'sum', value: 300.5 });
    const searched = await summaries({ search: 'a', summaries: { amount: 'sum' } });
    expect(searched.count).toBe(2);
    expect(searched.summaries['amount']).toEqual({ fn: 'sum', value: 50 });
  });

  it('groups: every level (ROLLUP) in row order with its own summaries', async () => {
    const result = await summaries({
      group: [
        { field: 'status', direction: 'asc' },
        { field: 'done', direction: 'desc' },
      ],
      summaries: { amount: 'sum', tags: 'unique', title: 'filled' },
    });
    expect(result.count).toBe(5);
    expect(result.summaries['amount']).toEqual({ fn: 'sum', value: 300.5 });
    expect(result.group).toEqual([
      { field: 'status', direction: 'asc' },
      { field: 'done', direction: 'desc' },
    ]);
    expect(result.truncated).toBe(false);
    expect(
      result.groups.map((group) => [
        group.values,
        group.count,
        group.summaries['amount']?.value,
        group.summaries['tags']?.value,
        group.summaries['title']?.value,
      ]),
    ).toEqual([
      [['A'], 2, 50, 3, 2],
      [['A', true], 1, 100, 2, 1],
      [['A', false], 1, -50, 1, 1],
      [['B'], 1, 250.5, 1, 1],
      [['B', false], 1, 250.5, 1, 1],
      [[null], 2, 0, 1, 1],
      [[null, true], 1, null, 0, 0],
      [[null, false], 1, 0, 1, 1],
    ]);
    // The counts are those of `records/group-counts` (same WHERE, same order).
    const counts = await query.groupCounts(scope, items.id, admin(), {
      field_key_type: 'name',
      group: [
        { field: 'status', direction: 'asc' },
        { field: 'done', direction: 'desc' },
      ],
    });
    expect(counts.groups).toEqual(
      result.groups
        .filter((group) => group.values.length === 2)
        .map((group) => ({ values: group.values, count: group.count })),
    );
  });

  it('without summaries: the count only; no group: no groups', async () => {
    const result = await summaries({});
    expect(result).toEqual({ count: 5, summaries: {}, group: [], groups: [], truncated: false });
  });

  it('tenant isolation and unreadable tables are 404', async () => {
    const other = await appError(
      query.summaries(orgScope(ORG_B), items.id, accessOf(fxB, 'u_admin'), {}),
    );
    expect(other.code).toBe('NOT_FOUND');
    // The Sales role reads Orders only: Items is not readable.
    const outsider = await appError(
      query.summaries(scope, items.id, accessOf(fx, 'u_sales1'), { summaries: { amount: 'sum' } }),
    );
    expect(outsider.code).toBe('NOT_FOUND');
  });

  it('a linked record in the trash leaves the link cells', async () => {
    await pool.query(
      `UPDATE data.${pg.escapeIdentifier(fx.customers.db_table_name)} SET __deleted_at = now() WHERE __id = $1`,
      [c2],
    );
    const result = await summaries({ summaries: { customer: 'unique' } });
    expect(result.summaries['customer']).toEqual({ fn: 'unique', value: 1 });
    const filled = await summaries({ summaries: { customer: 'filled' } });
    expect(filled.summaries['customer']).toEqual({ fn: 'filled', value: 2 });
  });
});
