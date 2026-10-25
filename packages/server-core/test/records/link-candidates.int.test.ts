/**
 * Link picker candidates (BACKLOG T402, CONTRACTS §2) on PostgreSQL 18:
 * read rule and `record_filter` of the linked table, unaccented search,
 * `ids` mode, `linked` / `full` flags, paging, and the 404/403/422 answers
 * (another organization included).
 */
import { newId, type Id } from '@cellhive/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemAuditContext, type AuditContext } from '../../src/audit/index.js';
import { orgScope, type Db } from '../../src/db/index.js';
import { AppError } from '../../src/errors/index.js';
import {
  RecordMutationService,
  RecordQueryService,
  type RecordAccessContext,
} from '../../src/records/index.js';
import { SchemaService } from '../../src/schema/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';

import { accessOf, buildOrdersFixture, NOW, type OrdersFixture } from './fixtures.js';

import type { FieldRow } from '../../src/db/schema.js';

const ORG_A: Id<'org'> = 'org_T402CandOrgAAAAA';
const ORG_B: Id<'org'> = 'org_T402CandOrgBBBBB';

async function appError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected an AppError');
}

describe('link picker candidates (PostgreSQL 18)', () => {
  let database: TestDatabase;
  let db: Db;
  let schema: SchemaService;
  let service: RecordMutationService;
  let query: RecordQueryService;
  let fx: OrdersFixture;
  const scope = orgScope(ORG_A);
  const context = systemAuditContext();
  let customer: FieldRow;
  let gold: FieldRow;
  let tier: FieldRow;
  let single: FieldRow;
  const opt = { gold: newId('opt'), silver: newId('opt') };
  let c: Id<'rec'>[] = [];
  let r1: Id<'rec'>;

  const as = (user: keyof OrdersFixture['users']): RecordAccessContext => accessOf(fx, user);
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
  function register(field: FieldRow): void {
    const table = fx.schema.tables.find((candidate) => candidate.id === field.table_id);
    if (table === undefined) throw new Error('unknown table');
    table.fields = [...table.fields, { id: field.id, type: field.type }];
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    query = new RecordQueryService(db, { now: () => NOW });
    service = new RecordMutationService(db, { schema, query, now: () => NOW });
    fx = await buildOrdersFixture(db, schema, ORG_A);
    await buildOrdersFixture(db, schema, ORG_B);
    tier = await schema.addField(
      scope,
      fx.customers.id,
      {
        name: 'Hạng',
        type: 'select',
        options: {
          options: [
            { id: opt.gold, name: 'Vàng' },
            { id: opt.silver, name: 'Bạc' },
          ],
        },
      },
      context,
    );
    register(tier);
    customer = await schema.addField(
      scope,
      fx.orders.id,
      { name: 'customer', type: 'link', options: { link_table: fx.customers.id } },
      context,
    );
    register(customer);
    gold = await schema.addField(
      scope,
      fx.orders.id,
      {
        name: 'gold customer',
        type: 'link',
        options: {
          link_table: fx.customers.id,
          record_filter: {
            op: 'and',
            items: [{ field: tier.id, operator: 'is', value: opt.gold }],
          },
        },
      },
      context,
    );
    register(gold);
    // Customers.primary ↔ Orders: a two-way link with a single-record reverse side.
    single = await schema.addField(
      scope,
      fx.customers.id,
      {
        name: 'main order',
        type: 'link',
        options: {
          link_table: fx.orders.id,
          bidirectional: true,
          bidirectional_link_field_name: 'main of',
          allow_multiple: false,
        },
      },
      context,
    );
    register(single);
    c = (
      await service.create(
        scope,
        fx.customers.id,
        as('u_admin'),
        {
          field_key_type: 'id',
          records: [
            ['An Phát', opt.gold],
            ['Bình Minh', opt.silver],
            ['Cát Tường', opt.gold],
            ['Ân Phúc', opt.silver],
            ['Đông Á', opt.gold],
          ].map(([name, level]) => ({
            fields: { [fx.fld.name.id]: name, [tier.id]: level },
          })),
        },
        audit(),
      )
    ).records.map((record) => record.id);
    [r1] = (
      await service.create(
        scope,
        fx.orders.id,
        as('u_admin'),
        {
          records: [
            { fields: { title: 'r1', owner: [{ id: fx.users.u_sales1.id }], customer: [c[0]] } },
          ],
        },
        audit(),
      )
    ).records.map((record) => record.id) as [Id<'rec'>];
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('offers live readable records in creation order, with title and display fields', async () => {
    const out = await query.linkCandidates(scope, customer.id, as('u_admin'), {});
    expect(out.items.map((item) => item.id)).toEqual(c);
    expect(out.items[0]).toMatchObject({
      title: 'An Phát',
      linked: false,
      full: false,
      selectable: true,
    });
    expect(out.fields.map((field) => field.id)).toEqual([fx.fld.phone.id, tier.id]);
    expect(out.items[0]?.fields[tier.id]).toBe('Vàng');
    expect(out).toMatchObject({ offset: 0, limit: 50, has_more: false, cell: null });
  });

  it('searches the primary field without accents', async () => {
    const out = await query.linkCandidates(scope, customer.id, as('u_admin'), { search: 'an ph' });
    expect(out.items.map((item) => item.title)).toEqual(['An Phát', 'Ân Phúc']);
  });

  it('applies record_filter (Hạng = Vàng); ids report it as selectable', async () => {
    const out = await query.linkCandidates(scope, gold.id, as('u_admin'), {});
    expect(out.items.map((item) => item.id)).toEqual([c[0], c[2], c[4]]);
    const picked = await query.linkCandidates(scope, gold.id, as('u_admin'), {
      ids: [c[1] as Id<'rec'>, c[0] as Id<'rec'>, 'rec_0000000000000000'],
    });
    expect(picked.items.map((item) => [item.id, item.selectable])).toEqual([
      [c[1], false],
      [c[0], true],
    ]);
  });

  it('pages with has_more and marks the linked records of record_id', async () => {
    const first = await query.linkCandidates(scope, customer.id, as('u_admin'), {
      limit: 2,
      record_id: r1,
    });
    expect(first.items.map((item) => [item.id, item.linked])).toEqual([
      [c[0], true],
      [c[1], false],
    ]);
    expect(first).toMatchObject({ has_more: true, cell: { count: 1, limit: 500 } });
    const last = await query.linkCandidates(scope, customer.id, as('u_admin'), {
      offset: 4,
      limit: 2,
    });
    expect(last.items.map((item) => item.id)).toEqual([c[4]]);
    expect(last.has_more).toBe(false);
  });

  it('marks records whose single-record reverse cell is taken as full', async () => {
    const reverse = (single.options as { symmetric_field_id: Id<'fld'> }).symmetric_field_id;
    register({ id: reverse, table_id: fx.orders.id, type: 'link' } as FieldRow);
    await service.update(
      scope,
      fx.customers.id,
      as('u_admin'),
      { field_key_type: 'id', records: [{ id: c[1] as Id<'rec'>, fields: { [single.id]: [r1] } }] },
      audit(),
    );
    // Customers.`main order` offers orders; their reverse cells (`main of`) are unlimited.
    const out = await query.linkCandidates(scope, single.id, as('u_admin'), {
      record_id: c[2] as Id<'rec'>,
    });
    expect(out.items.find((item) => item.id === r1)).toMatchObject({ full: false });
    expect(out.cell).toEqual({ count: 0, limit: 1 });
    // Orders.`main of` offers customers, whose `main order` cell holds one order at most.
    const back = await query.linkCandidates(scope, reverse, as('u_admin'), { record_id: r1 });
    expect(back.items.map((item) => [item.id, item.linked, item.full])).toEqual([
      [c[0], false, false],
      [c[1], true, false],
      [c[2], false, false],
      [c[3], false, false],
      [c[4], false, false],
    ]);
    // A second order: c1 already has its main order, so it is full.
    const [r2] = (
      await service.create(
        scope,
        fx.orders.id,
        as('u_admin'),
        { records: [{ fields: { title: 'r2' } }] },
        audit(),
      )
    ).records.map((record) => record.id) as [Id<'rec'>];
    const other = await query.linkCandidates(scope, reverse, as('u_admin'), { record_id: r2 });
    expect(other.items.find((item) => item.id === c[1])).toMatchObject({
      full: true,
      linked: false,
    });
  });

  it('404 without read access to the linked table (u_sales1), the field, or in another org', async () => {
    expect((await appError(query.linkCandidates(scope, customer.id, as('u_sales1')))).code).toBe(
      'NOT_FOUND',
    );
    expect(
      (await appError(query.linkCandidates(orgScope(ORG_B), customer.id, as('u_admin')))).code,
    ).toBe('NOT_FOUND');
    expect((await appError(query.linkCandidates(scope, fx.fld.title.id, as('u_admin')))).code).toBe(
      'NOT_FOUND',
    );
    expect(
      (
        await appError(
          query.linkCandidates(scope, customer.id, as('u_admin'), {
            record_id: 'rec_0000000000000000',
          }),
        )
      ).code,
    ).toBe('NOT_FOUND');
  });

  it('403 for a reader who cannot write the link field', async () => {
    expect((await appError(query.linkCandidates(scope, customer.id, as('u_reader')))).code).toBe(
      'PERMISSION_DENIED',
    );
  });

  it('422 for a malformed request', async () => {
    const error = await appError(
      query.linkCandidates(scope, customer.id, as('u_admin'), { limit: 1000 }),
    );
    expect(error.code).toBe('VALIDATION_FAILED');
  });
});
