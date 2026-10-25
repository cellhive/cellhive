/**
 * `RecordQueryService.systemScanAccess` + `scanDue` (ADR-34 §1, BACKLOG
 * T546) on PostgreSQL 18: the read context of a system time scan reads live
 * records only, only the fields it lists, with no read rule; no other read
 * takes it. Also the time scan core end to end with it (the S5b reminder
 * path) and the `fields` cells of `scanDue`.
 */
import { type Id } from '@cellhive/contracts';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemAuditContext } from '../../src/audit/index.js';
import { orgScope, type Db } from '../../src/db/index.js';
import { AppError } from '../../src/errors/index.js';
import { RecordQueryService, type DueScanRequest } from '../../src/records/index.js';
import { SchemaService } from '../../src/schema/index.js';
import { dueRuleOf, openWindow, TimeScanCore } from '../../src/time-scan/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { seedTenant } from '../support/tenant.js';
import { MemoryCursorStore } from '../time-scan/support.js';

import { accessOf, buildOrdersFixture, insertRows, NOW, type OrdersFixture } from './fixtures.js';

import type { FieldRow } from '../../src/db/schema.js';
import type { SystemScanAccess } from '../../src/records/due/system-scan.js';

const ORG_A: Id<'org'> = 'org_T546SysScanOrgAA';
const ORG_B: Id<'org'> = 'org_T546SysScanOrgBB';
const MINUTE = 60_000;
const T = Date.parse('2026-10-05T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

async function appError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected an AppError');
}

describe('system scan access (ADR-34 §1, T546)', () => {
  let database: TestDatabase;
  let db: Db;
  let pool: pg.Pool;
  let schema: SchemaService;
  let service: RecordQueryService;
  let fx: OrdersFixture;
  const scope = orgScope(ORG_A);
  let due: FieldRow;
  let day: FieldRow;
  let rMine: Id<'rec'>, rOther: Id<'rec'>, rNobody: Id<'rec'>, rTrashed: Id<'rec'>;
  let rLater: Id<'rec'>, rDay: Id<'rec'>;

  const window = (from: number, to: number): DueScanRequest => ({
    fieldId: due.id,
    lower: { value: iso(from), inclusive: false },
    upper: iso(to),
    after: null,
    limit: 100,
  });

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    pool = new pg.Pool({ connectionString: database.url, max: 4 });
    schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    service = new RecordQueryService(db, { now: () => NOW, defaultTimeZone: 'UTC' });
    fx = await buildOrdersFixture(db, schema, ORG_A);
    await seedTenant(db, ORG_B);
    const context = systemAuditContext();
    due = await schema.addField(
      scope,
      fx.orders.id,
      { name: 'due', type: 'datetime', options: { style: { format: 'yyyy-MM-dd HH:mm' } } },
      context,
    );
    day = await schema.addField(
      scope,
      fx.orders.id,
      {
        name: 'day',
        type: 'datetime',
        options: { style: { format: 'yyyy-MM-dd' }, timezone: 'Asia/Ho_Chi_Minh' },
      },
      context,
    );
    // Members read the new fields too (admin: all; sales: by its field rule).
    const orders = fx.schema.tables[0] as unknown as { fields: { id: Id<'fld'>; type: string }[] };
    orders.fields.push({ id: due.id, type: due.type }, { id: day.id, type: day.type });
    const col = (field: FieldRow) => field.db_column_name as string;
    const { title, owner, amount } = fx.fld;
    [rMine, rOther, rNobody, rTrashed, rLater, rDay] = (await insertRows(pool, fx.orders, [
      {
        [col(title)]: 'mine',
        [col(amount)]: '10',
        [col(owner)]: [fx.users.u_sales1.id],
        [col(due)]: new Date(T + MINUTE),
      },
      {
        [col(title)]: 'other',
        [col(amount)]: '20',
        [col(owner)]: [fx.users.u_sales2.id],
        [col(due)]: new Date(T + 2 * MINUTE),
      },
      { [col(title)]: 'nobody', [col(due)]: new Date(T + 2 * MINUTE) },
      {
        [col(title)]: 'trashed',
        [col(owner)]: [fx.users.u_sales1.id],
        [col(due)]: new Date(T + MINUTE),
        __deleted_at: new Date(),
        __deleted_by: fx.users.u_admin.id,
      },
      { [col(title)]: 'later', [col(due)]: new Date(T + 60 * MINUTE) },
      {
        [col(title)]: 'by day',
        [col(owner)]: [fx.users.u_sales2.id],
        [col(day)]: '2026-10-06',
      },
    ])) as [Id<'rec'>, Id<'rec'>, Id<'rec'>, Id<'rec'>, Id<'rec'>, Id<'rec'>];
  });

  afterAll(async () => {
    await pool.end();
    await db.destroy();
    await database.drop();
  });

  it('reads every live record in the range, without any read rule, never the trash', async () => {
    const access = await service.systemScanAccess(scope, fx.orders.id, [due.id]);
    const page = await service.scanDue(scope, fx.orders.id, access, window(T, T + 10 * MINUTE));
    expect(page.kind).toBe('instant');
    // Ties on the value are ordered by id in the database's collation, like the keyset of
    // `scanDue` (QA S5c: JS `<` is byte order, and random base62 ids of mixed case made the
    // two orders differ — a flaky test, not a scan bug).
    const { rows: tie } = await sql<{ id: string }>`
      SELECT id FROM unnest(ARRAY[${rOther}, ${rNobody}]::text[]) AS t(id) ORDER BY id
    `.execute(db.kysely);
    const expected = [
      { id: rMine, value: iso(T + MINUTE) },
      ...tie.map((row) => ({ id: row.id, value: iso(T + 2 * MINUTE) })),
    ];
    expect(page.rows).toEqual(expected);
    expect(page.rows.map((row) => row.id)).not.toContain(rTrashed);
    expect(page.rows.map((row) => row.id)).not.toContain(rLater);

    // A member reads through its read rule: Sales sees only its own orders.
    const sales = await service.scanDue(
      scope,
      fx.orders.id,
      accessOf(fx, 'u_sales1'),
      window(T, T + 10 * MINUTE),
    );
    expect(sales.rows.map((row) => row.id)).toEqual([rMine]);
  });

  it('returns the cells of listed fields only', async () => {
    const access = await service.systemScanAccess(scope, fx.orders.id, [due.id, fx.fld.owner.id]);
    const page = await service.scanDue(scope, fx.orders.id, access, {
      ...window(T, T + MINUTE),
      fields: [fx.fld.owner.id],
    });
    expect(page.rows).toHaveLength(1);
    const [row] = page.rows;
    expect(row?.id).toBe(rMine);
    expect(Object.keys(row?.fields ?? {})).toEqual([fx.fld.owner.id]);
    expect(row?.fields?.[fx.fld.owner.id]).toEqual([
      expect.objectContaining({ id: fx.users.u_sales1.id }),
    ]);
    // Without `fields`, no cells at all.
    const bare = await service.scanDue(scope, fx.orders.id, access, window(T, T + MINUTE));
    expect(bare.rows).toEqual([{ id: rMine, value: iso(T + MINUTE) }]);

    // A field outside the list is unknown to it: as a cell, a filter or the scanned field.
    const asCell = await appError(
      service.scanDue(scope, fx.orders.id, access, {
        ...window(T, T + MINUTE),
        fields: [fx.fld.title.id],
      }),
    );
    expect(asCell.code).toBe('VALIDATION_FAILED');
    const asFilter = await appError(
      service.scanDue(scope, fx.orders.id, access, {
        ...window(T, T + 10 * MINUTE),
        filter: { op: 'and', items: [{ field: fx.fld.amount.id, operator: 'gt', value: 15 }] },
      }),
    );
    expect(asFilter.code).toBe('INVALID_FILTER');
    const asDate = await appError(
      service.scanDue(scope, fx.orders.id, access, { ...window(T, T + MINUTE), fieldId: day.id }),
    );
    expect(asDate.code).toBe('INVALID_FILTER');

    // A filter on a listed field applies.
    const filtered = await service.scanDue(scope, fx.orders.id, access, {
      ...window(T, T + 10 * MINUTE),
      filter: {
        op: 'and',
        items: [{ field: fx.fld.owner.id, operator: 'has_any_of', value: [fx.users.u_sales2.id] }],
      },
    });
    expect(filtered.rows.map((item) => item.id)).toEqual([rOther]);
  });

  it('member readers get cells too (`fields`), within their own field access', async () => {
    const page = await service.scanDue(scope, fx.orders.id, accessOf(fx, 'u_admin'), {
      ...window(T, T + MINUTE),
      fields: [fx.fld.title.id, fx.fld.owner.id],
    });
    expect(page.rows).toEqual([
      {
        id: rMine,
        value: iso(T + MINUTE),
        fields: {
          [fx.fld.title.id]: 'mine',
          [fx.fld.owner.id]: [expect.objectContaining({ id: fx.users.u_sales1.id })],
        },
      },
    ]);
    // Sales cannot read `cost` (field rule): asking for it is a 422.
    const hidden = await appError(
      service.scanDue(scope, fx.orders.id, accessOf(fx, 'u_sales1'), {
        ...window(T, T + MINUTE),
        fields: [fx.fld.cost.id],
      }),
    );
    expect(hidden.code).toBe('VALIDATION_FAILED');
  });

  it('is bound to its organization and table', async () => {
    const access = await service.systemScanAccess(scope, fx.orders.id, [due.id]);
    expect(
      (
        await appError(
          service.scanDue(orgScope(ORG_B), fx.orders.id, access, window(T, T + MINUTE)),
        )
      ).code,
    ).toBe('NOT_FOUND');
    expect(
      (await appError(service.scanDue(scope, fx.customers.id, access, window(T, T + MINUTE)))).code,
    ).toBe('NOT_FOUND');
    // Created for a table of another organization, an unknown table: 404.
    expect(
      (await appError(service.systemScanAccess(orgScope(ORG_B), fx.orders.id, [due.id]))).code,
    ).toBe('NOT_FOUND');
    expect(
      (await appError(service.systemScanAccess(scope, 'tbl_T546NoSuchTable0', [due.id]))).code,
    ).toBe('NOT_FOUND');
  });

  it('lists 1 to 10 field ids', async () => {
    await expect(service.systemScanAccess(scope, fx.orders.id, [])).rejects.toThrow(RangeError);
    await expect(
      service.systemScanAccess(
        scope,
        fx.orders.id,
        Array.from(
          { length: 11 },
          (_, n) => `fld_T546Field${String(n).padStart(6, '0')}` as Id<'fld'>,
        ),
      ),
    ).rejects.toThrow(RangeError);
    await expect(
      service.systemScanAccess(scope, fx.orders.id, ['title' as Id<'fld'>]),
    ).rejects.toThrow(TypeError);
  });

  it('no other read takes it', async () => {
    const access = (await service.systemScanAccess(scope, fx.orders.id, [
      due.id,
    ])) as unknown as Parameters<RecordQueryService['query']>[2];
    await expect(service.query(scope, fx.orders.id, access)).rejects.toThrow(TypeError);
    await expect(service.getRecord(scope, fx.orders.id, rMine, access)).rejects.toThrow(TypeError);
    await expect(service.getRecords(scope, fx.orders.id, [rMine], access)).rejects.toThrow(
      TypeError,
    );
    await expect(service.matchRecord(scope, fx.orders.id, rMine, access, null)).rejects.toThrow(
      TypeError,
    );
  });

  it('drives the time scan core over a date-only field in the field’s zone (reminder path)', async () => {
    const access: SystemScanAccess = await service.systemScanAccess(scope, fx.orders.id, [
      day.id,
      fx.fld.owner.id,
    ]);
    const core = new TimeScanCore(service, { schema });
    await core.ensureIndex(scope, day.id);
    const rule = dueRuleOf(
      day,
      { offsetMinutes: 0, timeOfDay: '08:00' },
      { organization: 'UTC', fallback: 'UTC' },
    );
    if (rule === null) throw new Error('day is a date field');
    expect(rule).toMatchObject({ kind: 'date', timeZone: 'Asia/Ho_Chi_Minh' });
    // 08:00 in UTC+7 on 2026-10-06 = 01:00 UTC.
    const dueAt = Date.parse('2026-10-06T01:00:00.000Z');
    const store = new MemoryCursorStore();
    store.arm('day', new Date(dueAt - 10 * MINUTE));
    const seen: { id: string; due: string; owner: unknown }[] = [];
    const tick = async (now: number) =>
      db.withTx(async (tx) => {
        const window = await openWindow(store, scope, 'day', new Date(now));
        if (window === null) return null;
        const result = await core.scan(scope, {
          tx,
          tableId: fx.orders.id,
          fieldId: day.id,
          rule,
          window,
          access,
          fields: [fx.fld.owner.id],
          pageSize: 2,
          maxHits: 1_000,
          onDue: (_tx, record, at) => {
            seen.push({ id: record.id, due: iso(at), owner: record.fields?.[fx.fld.owner.id] });
            return Promise.resolve(true);
          },
        });
        await store.advance(scope, 'day', result.until);
        return result;
      });
    expect(await tick(dueAt - MINUTE)).toMatchObject({ outcome: 'done', hits: 0 });
    expect(await tick(dueAt)).toMatchObject({ outcome: 'done', hits: 1 });
    expect(await tick(dueAt + MINUTE)).toMatchObject({ outcome: 'done', hits: 0 });
    expect(seen).toEqual([
      {
        id: rDay,
        due: iso(dueAt),
        owner: [expect.objectContaining({ id: fx.users.u_sales2.id })],
      },
    ]);
  });

  it('a field deleted after the context was made is unavailable to the core', async () => {
    const extra = await schema.addField(
      scope,
      fx.orders.id,
      { name: 'extra due', type: 'datetime', options: { style: { format: 'yyyy-MM-dd HH:mm' } } },
      systemAuditContext(),
    );
    const access = await service.systemScanAccess(scope, fx.orders.id, [extra.id]);
    await schema.deleteField(scope, extra.id, systemAuditContext());
    const core = new TimeScanCore(service);
    const result = await db.withTx(async (tx) =>
      core.scan(scope, {
        tx,
        tableId: fx.orders.id,
        fieldId: extra.id,
        rule: { kind: 'instant', offsetMinutes: 0, timeOfDay: null, timeZone: 'UTC' },
        window: { from: T, to: T + MINUTE },
        access,
        pageSize: 10,
        maxHits: 10,
        onDue: () => Promise.resolve(true),
      }),
    );
    expect(result).toEqual({ outcome: 'unavailable', hits: 0, until: new Date(T + MINUTE) });
  });

  it('a trashed table is not found', async () => {
    const { table } = await schema.createTable(
      scope,
      { baseId: fx.baseId, name: 'Scratch', primaryFieldName: 'name' },
      systemAuditContext(),
    );
    const field = await schema.addField(
      scope,
      table.id,
      { name: 'when', type: 'datetime', options: {} },
      systemAuditContext(),
    );
    const access = await service.systemScanAccess(scope, table.id, [field.id]);
    await schema.deleteTable(scope, table.id, systemAuditContext());
    expect(
      (
        await appError(
          service.scanDue(scope, table.id, access, {
            ...window(T, T + MINUTE),
            fieldId: field.id,
          }),
        )
      ).code,
    ).toBe('NOT_FOUND');
    expect((await appError(service.systemScanAccess(scope, table.id, [field.id]))).code).toBe(
      'NOT_FOUND',
    );
  });
});
