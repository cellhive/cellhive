/**
 * Link fields in filters and cross-table realtime (BACKLOG T402, SPEC §6.2,
 * §15; CONTRACTS §3, §7) on PostgreSQL 18:
 *
 * - `has_any_of` / `has_all_of` / `has_none_of` / `is_exactly` /
 *   `is_empty` / `is_not_empty` on both sides of a two-way link: the SQL of
 *   `records/query` ≡ the evaluator on the storage-form cells (ids of the
 *   live linked records), linked records in the trash included;
 * - saved view filters on links, and realtime images carrying the link
 *   cells the view filters name;
 * - renaming / trashing / restoring linked records publishes the linking
 *   records' cells (`LinkFanout`), with values up to the batch threshold;
 * - `FieldsRepository.listLinksTo` stays inside its organization.
 */
import { newId, REALTIME_RECORD_BATCH_THRESHOLD, type Id } from '@cellhive/contracts';
import {
  createEvaluator,
  resolveVariables,
  validateFilter,
  type FilterNode,
  type FilterTableMeta,
} from '@cellhive/filter-dsl';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemAuditContext, type AuditContext } from '../../src/audit/index.js';
import { orgScope, type Db } from '../../src/db/index.js';
import { AppError } from '../../src/errors/index.js';
import {
  RecordMutationService,
  RecordQueryService,
  type RecordAccessContext,
  type RecordChange,
  type RecordChangeFanout,
  type RecordChangeField,
  type RecordChangeLink,
} from '../../src/records/index.js';
import { FieldsRepository, SchemaService } from '../../src/schema/index.js';
import { defaultViewConfig, ViewsRepository } from '../../src/views/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';

import { accessOf, buildOrdersFixture, NOW, type OrdersFixture } from './fixtures.js';

import type { FieldRow, JsonObject } from '../../src/db/schema.js';

const ORG_A: Id<'org'> = 'org_T402FilterOrgAAA';
const ORG_B: Id<'org'> = 'org_T402FilterOrgBBB';

/** Deterministic PRNG (mulberry32). */
function prngOf(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

interface Published {
  readonly changes: RecordChange[];
  readonly fields: readonly RecordChangeField[];
  readonly links: readonly RecordChangeLink[];
  readonly fanout: RecordChangeFanout | undefined;
}

describe('link fields in filters and cross-table realtime (PostgreSQL 18)', () => {
  let database: TestDatabase;
  let db: Db;
  let schema: SchemaService;
  let service: RecordMutationService;
  let query: RecordQueryService;
  let fx: OrdersFixture;
  const published: Published[] = [];
  const scope = orgScope(ORG_A);
  const context = systemAuditContext();
  /** Orders → Customers, one-way (side `a`). */
  let customer: FieldRow;
  /** Customers.orders ↔ Orders.buyer, two-way; `buyer` reads the `b` side. */
  let ordersOfCustomer: FieldRow;
  let buyer: FieldRow;
  let customers: Id<'rec'>[] = [];
  let orders: Id<'rec'>[] = [];

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

  /** Ids of `records/query` with `filter`, in creation order. */
  async function sqlIds(filter: FilterNode): Promise<string[]> {
    const out = await query.query(scope, fx.orders.id, as('u_admin'), {
      field_key_type: 'id',
      fields: [fx.fld.title.id],
      filter,
      limit: 1000,
      include_total: false,
    });
    return out.records.map((record) => record.id);
  }

  /** Ids the evaluator accepts, on the cells an admin reads (live linked records only). */
  async function evaluatedIds(filter: FilterNode): Promise<string[]> {
    const out = await query.query(scope, fx.orders.id, as('u_admin'), {
      field_key_type: 'id',
      fields: [customer.id, buyer.id],
      limit: 1000,
      include_total: false,
    });
    const meta: FilterTableMeta = {
      fields: [customer, buyer].map((field) => ({
        id: field.id,
        name: field.name,
        type: 'link',
        options: field.options,
      })),
    };
    const validated = validateFilter(filter, meta, [customer.id, buyer.id]);
    if (!validated.ok) throw new Error(JSON.stringify(validated.errors));
    const matches = createEvaluator(
      resolveVariables(validated.ast, {
        userId: null,
        groupMemberUserIds: [],
        timeZone: 'UTC',
        now: NOW,
      }),
      { table: meta },
    );
    return out.records
      .filter((record) =>
        matches(
          Object.fromEntries(
            [customer.id, buyer.id].map((id) => {
              const cell = record.fields[id] as { id: string }[] | null;
              return [id, cell === null ? null : cell.map((ref) => ref.id)];
            }),
          ),
        ),
      )
      .map((record) => record.id);
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    query = new RecordQueryService(db, { now: () => NOW });
    service = new RecordMutationService(db, {
      schema,
      query,
      now: () => NOW,
      publisher: {
        publish: (changes, fields, links, fanout) => {
          published.push({ changes: [...changes], fields, links: links ?? [], fanout });
        },
      },
    });
    fx = await buildOrdersFixture(db, schema, ORG_A);
    await buildOrdersFixture(db, schema, ORG_B);
    customer = await schema.addField(
      scope,
      fx.orders.id,
      { name: 'customer', type: 'link', options: { link_table: fx.customers.id } },
      context,
    );
    register(customer);
    ordersOfCustomer = await schema.addField(
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
    register(ordersOfCustomer);
    const reverse = await new FieldsRepository(db).getById(
      scope,
      (ordersOfCustomer.options as { symmetric_field_id: Id<'fld'> }).symmetric_field_id,
    );
    if (reverse === undefined) throw new Error('no reverse field');
    buyer = reverse;
    register(buyer);

    const random = prngOf(402);
    customers = (
      await service.create(
        scope,
        fx.customers.id,
        as('u_admin'),
        { records: Array.from({ length: 12 }, (_, i) => ({ fields: { name: `C${String(i)}` } })) },
        audit(),
      )
    ).records.map((record) => record.id);
    const pickSome = (max: number) =>
      customers.filter(() => random() < max / customers.length).slice(0, 4);
    orders = (
      await service.create(
        scope,
        fx.orders.id,
        as('u_admin'),
        {
          records: Array.from({ length: 90 }, (_, i) => ({
            fields: { title: `O${String(i)}`, customer: random() < 0.15 ? [] : pickSome(2) },
          })),
        },
        audit(),
      )
    ).records.map((record) => record.id);
    // The two-way side: customers link orders; `buyer` (Orders) reads it back.
    await service.update(
      scope,
      fx.customers.id,
      as('u_admin'),
      {
        field_key_type: 'id',
        records: customers.map((id) => ({
          id,
          fields: { [ordersOfCustomer.id]: orders.filter(() => random() < 0.06) },
        })),
      },
      audit(),
    );
    // Linked records in the trash are not part of any cell.
    await service.delete(
      scope,
      fx.customers.id,
      as('u_admin'),
      { ids: [customers[0] as Id<'rec'>] },
      audit(),
    );
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  describe('SQL ≡ evaluator on both sides of a link', () => {
    const lists = (): string[][] => {
      const [c0, c1, c2, c3] = customers as [string, string, string, string];
      return [[c1], [c2], [c1, c2], [c1, c2, c3], [c0], [c0, c1], ['rec_0000000000000000']];
    };
    const orderLists = (): string[][] => {
      const [o0, o1, o2] = orders as [string, string, string];
      return [[o0], [o1, o2], [o0, o1, o2]];
    };

    it('covers every operator with discriminating operands', async () => {
      let partial = 0;
      let total = 0;
      for (const [field, operandsOf] of [
        [customer, lists],
        [buyer, orderLists],
      ] as const) {
        const cases: FilterNode[] = [
          { field: field.id, operator: 'is_empty' },
          { field: field.id, operator: 'is_not_empty' },
        ];
        const values = operandsOf();
        for (const operator of ['has_any_of', 'has_all_of', 'has_none_of', 'is_exactly'] as const) {
          for (const value of values) cases.push({ field: field.id, operator, value });
        }
        cases.push({
          op: 'or',
          items: [
            { op: 'not', item: { field: field.id, operator: 'has_any_of', value: values[0] } },
            { field: field.id, operator: 'is_empty' },
          ],
        });
        for (const filter of cases) {
          const [fromSql, evaluated] = [await sqlIds(filter), await evaluatedIds(filter)];
          expect(fromSql, JSON.stringify(filter)).toEqual(evaluated);
          total += 1;
          if (fromSql.length > 0 && fromSql.length < orders.length) partial += 1;
        }
      }
      expect(partial / total).toBeGreaterThan(0.35);
    });

    it('exact cells match is_exactly (two ids in either order)', async () => {
      const out = await query.query(scope, fx.orders.id, as('u_admin'), {
        field_key_type: 'id',
        fields: [customer.id],
        limit: 1000,
      });
      const two = out.records.find(
        (record) => ((record.fields[customer.id] as unknown[] | null) ?? []).length === 2,
      );
      expect(two).toBeDefined();
      const ids = (two?.fields[customer.id] as { id: string }[]).map((ref) => ref.id);
      const matched = await sqlIds({
        field: customer.id,
        operator: 'is_exactly',
        value: [...ids].reverse(),
      });
      expect(matched).toContain(two?.id);
    });

    it('accepts the tuple form with record ids (CONTRACTS §3)', async () => {
      const c1 = customers[1] as string;
      const out = await query.query(scope, fx.orders.id, as('u_admin'), {
        filter: { logic: 'and', conditions: [['customer', 'intersects', [{ id: c1 }]]] },
        limit: 1000,
        include_total: false,
      });
      expect(out.records.map((record) => record.id)).toEqual(
        await sqlIds({ field: customer.id, operator: 'has_any_of', value: [c1] }),
      );
    });

    it('a link field the caller cannot read is an unknown field (P08)', async () => {
      const hidden = await schema.addField(
        scope,
        fx.orders.id,
        { name: 'hidden link', type: 'link', options: { link_table: fx.customers.id } },
        context,
      );
      // Not registered in the fixture schema: nobody has a perm on it.
      const error = await query
        .query(scope, fx.orders.id, as('u_admin'), {
          field_key_type: 'id',
          filter: { field: hidden.id, operator: 'is_empty' },
        })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('INVALID_FILTER');
      await schema.deleteField(scope, hidden.id, context);
    });

    it('a linked table in the trash reads empty in filters too', async () => {
      const trash = await schema.createTable(
        scope,
        { baseId: fx.baseId, name: 'Soon gone', primaryFieldName: 'name' },
        context,
      );
      fx.schema.tables.push({
        id: trash.table.id,
        fields: [{ id: trash.primaryField.id, type: 'text' }],
      });
      const gone = await schema.addField(
        scope,
        fx.orders.id,
        { name: 'gone link', type: 'link', options: { link_table: trash.table.id } },
        context,
      );
      register(gone);
      const [target] = (
        await service.create(
          scope,
          trash.table.id,
          as('u_admin'),
          { records: [{ fields: { name: 'x' } }] },
          audit(),
        )
      ).records.map((record) => record.id);
      await service.update(
        scope,
        fx.orders.id,
        as('u_admin'),
        {
          field_key_type: 'id',
          records: [{ id: orders[1] as Id<'rec'>, fields: { [gone.id]: [target] } }],
        },
        audit(),
      );
      const linked = { field: gone.id, operator: 'has_any_of', value: [target] } as FilterNode;
      expect(await sqlIds(linked)).toEqual([orders[1]]);
      await schema.deleteTable(scope, trash.table.id, context);
      expect(await sqlIds(linked)).toEqual([]);
      expect(await sqlIds({ field: gone.id, operator: 'is_empty' })).toHaveLength(orders.length);
      await schema.deleteField(scope, gone.id, context);
    });
  });

  describe('views', () => {
    it('applies a saved view filter on a link and puts the cell in realtime images', async () => {
      const c2 = customers[2] as Id<'rec'>;
      const view = await new ViewsRepository(db).insert(scope, {
        id: newId('viw'),
        tableId: fx.orders.id,
        type: 'grid',
        name: 'Of C2',
        config: {
          ...defaultViewConfig('grid'),
          filter: {
            op: 'and',
            items: [{ field: customer.id, operator: 'has_any_of', value: [c2] }],
          },
        } as unknown as JsonObject,
        position: 5,
        ownerId: null,
      });
      const viewed = await query.query(scope, fx.orders.id, as('u_admin'), {
        view_id: view.id,
        limit: 1000,
        include_total: false,
      });
      expect(viewed.records.map((record) => record.id)).toEqual(
        await sqlIds({ field: customer.id, operator: 'has_any_of', value: [c2] }),
      );

      // A write of another field carries the link cell before and after (T402).
      const target = orders[5] as Id<'rec'>;
      published.length = 0;
      await service.update(
        scope,
        fx.orders.id,
        as('u_admin'),
        { field_key_type: 'id', records: [{ id: target, fields: { [fx.fld.amount.id]: 7 } }] },
        audit(),
      );
      const change = published[0]?.changes[0];
      expect(Object.hasOwn(change?.before ?? {}, customer.id)).toBe(true);
      expect(change?.after?.[customer.id]).toEqual(change?.before?.[customer.id]);
      expect(published[0]?.fields).toContainEqual(
        expect.objectContaining({ id: customer.id, type: 'link' }),
      );

      // Linking C2 moves the record into the view: the after image says so.
      published.length = 0;
      await service.update(
        scope,
        fx.orders.id,
        as('u_admin'),
        { field_key_type: 'id', records: [{ id: target, fields: { [customer.id]: [c2] } }] },
        audit(),
      );
      const linked = published[0]?.changes.find((item) => item.recordId === target);
      expect(linked?.after?.[customer.id]).toEqual([c2]);
      await new ViewsRepository(db).delete(scope, view.id);
    });
  });

  describe('cross-table realtime (LinkFanout)', () => {
    it('a rename publishes the linking records with the new title, no event, same version', async () => {
      const c3 = customers[3] as Id<'rec'>;
      await service.update(
        scope,
        fx.orders.id,
        as('u_admin'),
        {
          field_key_type: 'id',
          records: orders.slice(10, 13).map((id) => ({ id, fields: { [customer.id]: [c3] } })),
        },
        audit(),
      );
      const before = await query.getRecord(
        scope,
        fx.orders.id,
        orders[10] as Id<'rec'>,
        as('u_admin'),
      );
      published.length = 0;
      await service.update(
        scope,
        fx.customers.id,
        as('u_admin'),
        { records: [{ id: c3, fields: { name: 'C3 renamed' } }] },
        audit(),
      );
      const fanout = published.filter((entry) => entry.fanout?.fieldId === customer.id);
      expect(fanout).toHaveLength(1);
      expect(fanout[0]?.fanout).toEqual({ fieldId: customer.id, titlesOnly: true, values: true });
      expect(fanout[0]?.links).toEqual([
        { id: customer.id, tableId: fx.customers.id, titleFieldId: fx.fld.name.id },
      ]);
      const changes = fanout[0]?.changes ?? [];
      expect(changes.map((change) => change.recordId).sort()).toEqual(
        [
          ...orders.slice(10, 13),
          ...(await sqlIds({ field: customer.id, operator: 'has_any_of', value: [c3] })),
        ]
          .filter((id, index, all) => all.indexOf(id) === index)
          .sort(),
      );
      const first = changes.find((change) => change.recordId === orders[10]);
      expect(first).toMatchObject({
        type: 'record.updated',
        eventId: null,
        version: before.version,
        changedFieldIds: [customer.id],
      });
      expect(first?.values[customer.id]).toContainEqual({ id: c3, title: 'C3 renamed' });
      // The reverse side (Customers.orders) shows orders, not customers: nothing there.
      expect(published.some((entry) => entry.fanout?.fieldId === ordersOfCustomer.id)).toBe(false);
    });

    it('trash and restore publish the cells without and with the record', async () => {
      const c3 = customers[3] as Id<'rec'>;
      published.length = 0;
      await service.delete(scope, fx.customers.id, as('u_admin'), { ids: [c3] }, audit());
      const removed = published.find((entry) => entry.fanout?.fieldId === customer.id);
      expect(removed?.fanout).toEqual({ fieldId: customer.id, titlesOnly: false, values: true });
      const change = removed?.changes.find((item) => item.recordId === orders[10]);
      expect(change?.values[customer.id]).toBeNull();

      published.length = 0;
      await service.restore(scope, fx.customers.id, as('u_admin'), { ids: [c3] }, audit());
      const restored = published.find((entry) => entry.fanout?.fieldId === customer.id);
      const back = restored?.changes.find((item) => item.recordId === orders[10]);
      expect(back?.values[customer.id]).toEqual([{ id: c3, title: 'C3 renamed' }]);
      // Trashing an order changes the reverse cells (Customers.orders) of its customers.
      const linkedOrder = (
        await query.query(scope, fx.customers.id, as('u_admin'), {
          field_key_type: 'id',
          fields: [ordersOfCustomer.id],
          limit: 100,
        })
      ).records
        .flatMap((record) => (record.fields[ordersOfCustomer.id] as { id: string }[] | null) ?? [])
        .at(0)?.id as Id<'rec'>;
      published.length = 0;
      await service.delete(scope, fx.orders.id, as('u_admin'), { ids: [linkedOrder] }, audit());
      expect(published.some((entry) => entry.fanout?.fieldId === ordersOfCustomer.id)).toBe(true);
      await service.restore(scope, fx.orders.id, as('u_admin'), { ids: [linkedOrder] }, audit());
    });

    it(`more than ${String(REALTIME_RECORD_BATCH_THRESHOLD)} linking records: no values`, async () => {
      const c4 = customers[4] as Id<'rec'>;
      const many = (
        await service.create(
          scope,
          fx.orders.id,
          as('u_admin'),
          {
            records: Array.from({ length: REALTIME_RECORD_BATCH_THRESHOLD + 1 }, (_, i) => ({
              fields: { title: `M${String(i)}`, customer: [c4] },
            })),
          },
          audit(),
        )
      ).records.map((record) => record.id);
      published.length = 0;
      await service.update(
        scope,
        fx.customers.id,
        as('u_admin'),
        { records: [{ id: c4, fields: { name: 'C4 renamed' } }] },
        audit(),
      );
      const fanout = published.find((entry) => entry.fanout?.fieldId === customer.id);
      expect(fanout?.fanout?.values).toBe(false);
      expect(fanout?.changes.length).toBeGreaterThanOrEqual(many.length);
      expect(fanout?.changes.every((change) => Object.keys(change.values).length === 0)).toBe(true);
      await service.delete(scope, fx.orders.id, as('u_admin'), { ids: many }, audit());
    });

    it('a rollback publishes nothing', async () => {
      const c5 = customers[5] as Id<'rec'>;
      published.length = 0;
      await expect(
        service.update(
          scope,
          fx.customers.id,
          as('u_admin'),
          {
            records: [
              { id: c5, fields: { name: 'never' } },
              { id: 'rec_0000000000000000', fields: { name: 'missing' } },
            ],
          },
          audit(),
        ),
      ).rejects.toBeInstanceOf(AppError);
      expect(published).toEqual([]);
    });
  });

  describe('FieldsRepository.listLinksTo', () => {
    it('lists both sides pointing at a table, only in its organization', async () => {
      const repo = new FieldsRepository(db);
      const toCustomers = await repo.listLinksTo(scope, fx.customers.id);
      // `customer` and the reverse side `buyer` both show Customers records.
      expect(toCustomers.map((field) => field.id).sort()).toEqual([customer.id, buyer.id].sort());
      const toOrders = await repo.listLinksTo(scope, fx.orders.id);
      expect(toOrders.map((field) => field.id)).toEqual([ordersOfCustomer.id]);
      expect(await repo.listLinksTo(orgScope(ORG_B), fx.customers.id)).toEqual([]);
    });
  });
});
