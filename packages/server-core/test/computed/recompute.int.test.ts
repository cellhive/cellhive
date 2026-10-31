/**
 * T458 on PostgreSQL 18: the incremental recompute of stored formula/lookup
 * fields through `ComputedRecomputeService.enqueue`, called by the record
 * services in the transaction of each write — same row, through links
 * (both sides, chains), cross-table conditions (link keys, value keys with
 * old and new values, no key → job), trash/restore/create, the job queue
 * past the sync limit, concurrent writes across two tables (deadlock
 * retry), self-links, schema sources (option rename, zones, auto number,
 * table purge), no record events/audit, and tenant isolation of the queue.
 */
import { newId, type Id } from '@cellhive/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemAuditContext, type AuditContext } from '../../src/audit/index.js';
import {
  ComputedRecomputeQueueRepository,
  ComputedRecomputeService,
  EVERY_RECORD,
} from '../../src/computed/index.js';
import { orgScope, type Db } from '../../src/db/index.js';
import {
  RecordMutationService,
  RecordQueryService,
  type RecordAccessContext,
} from '../../src/records/index.js';
import { SchemaService } from '../../src/schema/index.js';
import { accessOf, buildOrdersFixture, NOW, type OrdersFixture } from '../records/fixtures.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { queuedJobs } from '../support/schema.js';
import { seedTenant } from '../support/tenant.js';

import type { FieldRow, TableRow } from '../../src/db/schema.js';

const ORG_A: Id<'org'> = 'org_T458RecomputeOrA';
const ORG_B: Id<'org'> = 'org_T458RecomputeOrB';

const num = (value: unknown): number | null => (value === null ? null : Number(value));

describe('incremental recompute of computed fields (T458)', () => {
  let database: TestDatabase;
  let db: Db;
  let schema: SchemaService;
  let mutation: RecordMutationService;
  let fx: OrdersFixture;
  const scope = orgScope(ORG_A);
  const context = systemAuditContext();
  const f = {} as Record<
    | 'customer'
    | 'orders'
    | 'ocode'
    | 'nref'
    | 'code'
    | 'ncode'
    | 'total'
    | 'total2'
    | 'codeTotal'
    | 'nTotal'
    | 'bigCount'
    | 'commission'
    | 'custTotal',
    FieldRow
  >;
  const rec = {} as Record<'c1' | 'c2' | 'o1' | 'o2' | 'o3' | 'o4', Id<'rec'>>;

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

  /** Registers the current fields of every table in the fixture's permission schema. */
  async function refreshSchema(tables: readonly TableRow[] = []): Promise<void> {
    for (const table of tables) {
      if (!fx.schema.tables.some((item) => item.id === table.id)) {
        fx.schema.tables.push({ id: table.id, fields: [] });
      }
    }
    for (const table of fx.schema.tables) {
      const rows = await db.kysely
        .selectFrom('meta.fields')
        .select(['id', 'type'])
        .where('table_id', '=', table.id)
        .where('deleted_at', 'is', null)
        .execute();
      table.fields = rows;
    }
  }

  async function field(fieldId: Id<'fld'>): Promise<FieldRow> {
    return db.kysely
      .selectFrom('meta.fields')
      .selectAll()
      .where('id', '=', fieldId)
      .executeTakeFirstOrThrow();
  }

  /** Stored values of a computed field, by record (TEST ONLY: reads the column). */
  async function values(table: TableRow, computed: FieldRow): Promise<Record<string, unknown>> {
    const current = await field(computed.id);
    const column = current.db_column_name;
    if (column === null) throw new Error('no column');
    const { rows } = await sql<{ id: string; v: unknown }>`
      SELECT __id AS id, ${sql.id(column)} AS v FROM ${sql.id('data', table.db_table_name)}
    `.execute(db.kysely);
    return Object.fromEntries(rows.map((row) => [row.id, row.v]));
  }

  async function value(table: TableRow, computed: FieldRow, id: Id<'rec'>): Promise<number | null> {
    return num((await values(table, computed))[id] ?? null);
  }

  /** Runs every batch of the backfill of `computed` (what the job does), then `ready`. */
  async function backfill(computed: FieldRow): Promise<void> {
    let cursor = 0n;
    for (;;) {
      const result = await mutation.backfillComputedBatch(scope, {
        fieldId: computed.id,
        afterAuto: cursor,
        limit: 1000,
        statementTimeoutMs: 30_000,
      });
      if (result.status !== 'more' && result.status !== 'done') break;
      cursor = result.cursor;
      if (result.status === 'done') break;
    }
    await schema.finishComputedBackfill(scope, computed.id, { status: 'ready' });
  }

  /** Runs `computed.recompute` batches of `fieldId` until its queue is empty. */
  async function drain(fieldId: Id<'fld'>, service = mutation): Promise<number> {
    let rows = 0;
    for (let guard = 0; guard < 1000; guard += 1) {
      const batch = await service.recomputeComputedBatch(scope, fieldId, {
        statementTimeoutMs: 30_000,
      });
      if (batch.status !== 'more') return rows;
      rows += batch.rows;
    }
    throw new Error('the queue never drained');
  }

  async function drainAll(service = mutation): Promise<void> {
    for (let guard = 0; guard < 20; guard += 1) {
      const queued = await db.kysely
        .selectFrom('meta.computed_recompute_queue')
        .select('field_id')
        .distinct()
        .where('organization_id', '=', ORG_A)
        .execute();
      if (queued.length === 0) return;
      for (const row of queued) await drain(row.field_id, service);
    }
  }

  async function formula(table: TableRow, name: string, expression: string): Promise<FieldRow> {
    const created = await schema.addField(
      scope,
      table.id,
      { name, type: 'formula', options: { expression }, computed: { timeZone: 'UTC' } },
      context,
    );
    await backfill(created);
    return field(created.id);
  }

  async function lookup(
    table: TableRow,
    name: string,
    options: Record<string, unknown>,
  ): Promise<FieldRow> {
    const created = await schema.addField(
      scope,
      table.id,
      { name, type: 'lookup', options, computed: { timeZone: 'UTC' } },
      context,
    );
    await backfill(created);
    return field(created.id);
  }

  const update = (
    table: TableRow,
    id: Id<'rec'>,
    fields: Record<string, unknown>,
    user: keyof OrdersFixture['users'] = 'u_admin',
    service = mutation,
  ) =>
    service.update(
      scope,
      table.id,
      as(user),
      { field_key_type: 'id', records: [{ id, fields }] },
      auditOf(user),
    );

  const create = async (
    table: TableRow,
    records: readonly Record<string, unknown>[],
  ): Promise<Id<'rec'>[]> => {
    const out = await mutation.create(
      scope,
      table.id,
      as('u_admin'),
      { field_key_type: 'id', records: records.map((fields) => ({ fields })) },
      auditOf('u_admin'),
    );
    return out.records.map((record) => record.id);
  };

  async function state(fieldId: Id<'fld'>): Promise<string | null> {
    return (await field(fieldId)).compute_state;
  }

  async function queued(fieldId: Id<'fld'>): Promise<string[]> {
    const rows = await db.kysely
      .selectFrom('meta.computed_recompute_queue')
      .select('record_id')
      .where('field_id', '=', fieldId)
      .execute();
    // Code-point order, like `[…].sort()` (the database collation orders case differently).
    return rows.map((row) => row.record_id).sort();
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    const query = new RecordQueryService(db, { now: () => NOW });
    mutation = new RecordMutationService(db, { schema, query, now: () => NOW });
    fx = await buildOrdersFixture(db, schema, ORG_A);
    await seedTenant(db, ORG_B);
    const add = (table: TableRow, name: string, type: string, options: unknown = {}) =>
      schema.addField(scope, table.id, { name, type, options }, context);
    f.customer = await add(fx.orders, 'customer', 'link', {
      link_table: fx.customers.id,
      bidirectional: true,
    });
    const partner = await db.kysely
      .selectFrom('meta.fields')
      .selectAll()
      .where('table_id', '=', fx.customers.id)
      .where('type', '=', 'link')
      .executeTakeFirstOrThrow();
    f.orders = await schema.renameField(scope, partner.id, 'orders', context);
    f.ocode = await add(fx.orders, 'ocode', 'text');
    f.nref = await add(fx.orders, 'nref', 'number');
    f.code = await add(fx.customers, 'code', 'text');
    f.ncode = await add(fx.customers, 'ncode', 'number');
    await refreshSchema();

    [rec.c1, rec.c2] = (await create(fx.customers, [
      { [fx.fld.name.id]: 'An', [f.code.id]: 'K1', [f.ncode.id]: 1 },
      { [fx.fld.name.id]: 'Bình', [f.code.id]: 'K2', [f.ncode.id]: 2 },
    ])) as [Id<'rec'>, Id<'rec'>];
    [rec.o1, rec.o2, rec.o3] = (await create(fx.orders, [
      {
        [fx.fld.title.id]: 'o1',
        [fx.fld.amount.id]: 100,
        [f.ocode.id]: 'K1',
        [f.nref.id]: 1,
        [f.customer.id]: [rec.c1],
      },
      {
        [fx.fld.title.id]: 'o2',
        [fx.fld.amount.id]: 200,
        [f.ocode.id]: 'K1',
        [f.nref.id]: 1,
        [f.customer.id]: [rec.c1],
      },
      {
        [fx.fld.title.id]: 'o3',
        [fx.fld.amount.id]: 50,
        [f.ocode.id]: 'K2',
        [f.nref.id]: 2,
        [f.customer.id]: [rec.c2],
      },
    ])) as [Id<'rec'>, Id<'rec'>, Id<'rec'>];

    // Customers: lookup through the link (cross_table keyed on `__id`), the
    // same through the reverse link (via_link), a FILTER keyed on a text
    // value, a lookup keyed on a number, and a count without key.
    f.total = await lookup(fx.customers, 'total', {
      from: fx.orders.id,
      select: fx.fld.amount.id,
      where: { field: f.customer.id, operator: 'intersects', value: { field_ref: '__id' } },
      aggregate: 'sum',
    });
    f.total2 = await formula(fx.customers, 'total2', '[orders].[amount].SUM()');
    f.codeTotal = await formula(
      fx.customers,
      'codeTotal',
      '[Orders].FILTER(CurrentValue.[ocode] = [code]).[amount].SUM()',
    );
    f.nTotal = await lookup(fx.customers, 'nTotal', {
      from: fx.orders.id,
      select: fx.fld.amount.id,
      where: { field: f.nref.id, operator: 'eq', value: { field_ref: f.ncode.id } },
      aggregate: 'sum',
    });
    f.bigCount = await formula(
      fx.customers,
      'bigCount',
      'COUNTIF([Orders], CurrentValue.[amount] > 100)',
    );
    // Orders: same row, and a chain through the link to a stored lookup.
    f.commission = await formula(fx.orders, 'commission', '[amount] * 0.1');
    f.custTotal = await formula(fx.orders, 'custTotal', '[customer].[total].SUM()');
    await refreshSchema();
  }, 120_000);

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('backfilled values are the starting point', async () => {
    expect(await value(fx.customers, f.total, rec.c1)).toBe(300);
    expect(await value(fx.customers, f.total2, rec.c1)).toBe(300);
    expect(await value(fx.customers, f.codeTotal, rec.c1)).toBe(300);
    expect(await value(fx.customers, f.nTotal, rec.c2)).toBe(50);
    expect(await value(fx.customers, f.bigCount, rec.c1)).toBe(1);
    expect(await value(fx.orders, f.custTotal, rec.o2)).toBe(300);
  });

  it('a cell write recomputes same row, links, keyed conditions and chains in its transaction', async () => {
    const versions = async () =>
      (
        await sql<{ id: string; v: number }>`
          SELECT __id AS id, __version AS v FROM ${sql.id('data', fx.customers.db_table_name)}
           ORDER BY __id
        `.execute(db.kysely)
      ).rows;
    const customerVersions = await versions();
    const events = await db.kysely
      .selectFrom('meta.events')
      .select((eb) => eb.fn.countAll<bigint>().as('n'))
      .executeTakeFirstOrThrow();
    const audits = await db.kysely
      .selectFrom('meta.audit_logs')
      .select((eb) => eb.fn.countAll<bigint>().as('n'))
      .executeTakeFirstOrThrow();

    await update(fx.orders, rec.o1, { [fx.fld.amount.id]: 150 });

    expect(await value(fx.orders, f.commission, rec.o1)).toBe(15);
    expect(await value(fx.customers, f.total, rec.c1)).toBe(350);
    expect(await value(fx.customers, f.total2, rec.c1)).toBe(350);
    expect(await value(fx.customers, f.codeTotal, rec.c1)).toBe(350);
    expect(await value(fx.customers, f.nTotal, rec.c1)).toBe(350);
    expect(await value(fx.customers, f.total, rec.c2)).toBe(50);
    // Chain: Orders.custTotal reads Customers.total, recomputed after it (o2 too).
    expect(await value(fx.orders, f.custTotal, rec.o1)).toBe(350);
    expect(await value(fx.orders, f.custTotal, rec.o2)).toBe(350);
    // No key (`COUNTIF` with a constant condition): every row, by the job.
    expect(await state(f.bigCount.id)).toBe('recomputing');
    expect(await queued(f.bigCount.id)).toEqual([EVERY_RECORD]);
    expect((await queuedJobs(db, 'computed.recompute')).map((job) => job.key)).toContain(
      `computed.recompute:${f.bigCount.id}`,
    );
    await drainAll();
    expect(await value(fx.customers, f.bigCount, rec.c1)).toBe(2);
    expect(await state(f.bigCount.id)).toBe('ready');

    // Recomputed values: no event, audit entry or version change (ADR-23 §2).
    expect(await versions()).toEqual(customerVersions);
    const eventsAfter = await db.kysely
      .selectFrom('meta.events')
      .select((eb) => eb.fn.countAll<bigint>().as('n'))
      .executeTakeFirstOrThrow();
    const auditsAfter = await db.kysely
      .selectFrom('meta.audit_logs')
      .select((eb) => eb.fn.countAll<bigint>().as('n'))
      .executeTakeFirstOrThrow();
    expect(Number(eventsAfter.n) - Number(events.n)).toBe(1);
    expect(Number(auditsAfter.n) - Number(audits.n)).toBe(1);
  });

  it('moving an order to another customer updates both (old and new link)', async () => {
    await update(fx.orders, rec.o2, { [f.customer.id]: [rec.c2] });
    expect(await value(fx.customers, f.total, rec.c1)).toBe(150);
    expect(await value(fx.customers, f.total, rec.c2)).toBe(250);
    expect(await value(fx.customers, f.total2, rec.c1)).toBe(150);
    expect(await value(fx.customers, f.total2, rec.c2)).toBe(250);
    expect(await value(fx.orders, f.custTotal, rec.o1)).toBe(150);
    expect(await value(fx.orders, f.custTotal, rec.o2)).toBe(250);
    // Written from the other side (the reverse field): o2 leaves c2, then joins c1.
    await update(fx.customers, rec.c2, { [f.orders.id]: [rec.o3] });
    expect(await value(fx.customers, f.total, rec.c2)).toBe(50);
    expect(await value(fx.customers, f.total2, rec.c2)).toBe(50);
    expect(await value(fx.orders, f.custTotal, rec.o2)).toBe(0);
    await update(fx.customers, rec.c1, { [f.orders.id]: [rec.o1, rec.o2] });
    expect(await value(fx.customers, f.total, rec.c1)).toBe(350);
    expect(await value(fx.customers, f.total, rec.c2)).toBe(50);
    expect(await value(fx.orders, f.custTotal, rec.o2)).toBe(350);
  });

  it('a keyed condition recomputes rows matching the old and the new value', async () => {
    // o3 moves from K2/2 to K1/1: c2 loses it, c1 gains it.
    await update(fx.orders, rec.o3, { [f.ocode.id]: 'K1', [f.nref.id]: 1 });
    expect(await value(fx.customers, f.codeTotal, rec.c1)).toBe(400);
    expect(await value(fx.customers, f.codeTotal, rec.c2)).toBe(0);
    expect(await value(fx.customers, f.nTotal, rec.c1)).toBe(400);
    expect(await value(fx.customers, f.nTotal, rec.c2)).toBe(0);
    // A formula-table key changes: its own row (same_row).
    await update(fx.customers, rec.c2, { [f.code.id]: 'K1' });
    expect(await value(fx.customers, f.codeTotal, rec.c2)).toBe(400);
    await update(fx.customers, rec.c2, { [f.code.id]: 'K2' });
    expect(await value(fx.customers, f.codeTotal, rec.c2)).toBe(0);
  });

  it('trash, restore and create of a source record', async () => {
    const before = await value(fx.customers, f.total, rec.c1);
    await mutation.delete(
      scope,
      fx.orders.id,
      as('u_admin'),
      { ids: [rec.o1] },
      auditOf('u_admin'),
    );
    expect(await value(fx.customers, f.total, rec.c1)).toBe((before ?? 0) - 150);
    expect(await value(fx.customers, f.total2, rec.c1)).toBe((before ?? 0) - 150);
    expect(await value(fx.customers, f.codeTotal, rec.c1)).toBe(250);
    await mutation.restore(
      scope,
      fx.orders.id,
      as('u_admin'),
      { ids: [rec.o1] },
      auditOf('u_admin'),
    );
    expect(await value(fx.customers, f.total, rec.c1)).toBe(before);
    expect(await value(fx.customers, f.codeTotal, rec.c1)).toBe(400);

    const [o4] = await create(fx.orders, [
      { [fx.fld.title.id]: 'o4', [fx.fld.amount.id]: 10, [f.customer.id]: [rec.c1] },
    ]);
    rec.o4 = o4 as Id<'rec'>;
    expect(await value(fx.orders, f.commission, rec.o4)).toBe(1);
    expect(await value(fx.customers, f.total, rec.c1)).toBe((before ?? 0) + 10);
    expect(await value(fx.orders, f.custTotal, rec.o4)).toBe((before ?? 0) + 10);

    // A trashed target: link cells stop showing it (lookup through the reverse link).
    await mutation.delete(
      scope,
      fx.customers.id,
      as('u_admin'),
      { ids: [rec.c1] },
      auditOf('u_admin'),
    );
    expect(await value(fx.orders, f.custTotal, rec.o4)).toBe(0);
    await mutation.restore(
      scope,
      fx.customers.id,
      as('u_admin'),
      { ids: [rec.c1] },
      auditOf('u_admin'),
    );
    expect(await value(fx.orders, f.custTotal, rec.o4)).toBe((before ?? 0) + 10);

    // Purge of a trashed record: nothing left to recompute, the write goes through.
    await mutation.delete(
      scope,
      fx.orders.id,
      as('u_admin'),
      { ids: [rec.o4] },
      auditOf('u_admin'),
    );
    await mutation.purge(scope, fx.orders.id, as('u_admin'), { ids: [rec.o4] }, auditOf('u_admin'));
    expect(await value(fx.customers, f.total, rec.c1)).toBe(before);
    await drainAll();
  });

  it("stored values never follow the writer's read scope (u_sales1 reads only its orders)", async () => {
    const [mine] = await create(fx.orders, [
      {
        [fx.fld.title.id]: 'sales',
        [fx.fld.amount.id]: 1,
        [fx.fld.owner.id]: [{ id: fx.users.u_sales1.id }],
        [f.customer.id]: [rec.c1],
      },
    ]);
    const expected = async () => {
      const { rows } = await sql<{ s: string }>`
        SELECT sum(o.${sql.id(fx.fld.amount.db_column_name ?? '')}) AS s
          FROM ${sql.id('data', fx.orders.db_table_name)} AS o
          JOIN ${sql.id('data', f.customer.link_junction ?? '')} AS j ON j.a_id = o.__id
         WHERE j.b_id = ${rec.c1} AND o.__deleted_at IS NULL
      `.execute(db.kysely);
      return Number(rows[0]?.s);
    };
    await update(fx.orders, mine as Id<'rec'>, { [fx.fld.amount.id]: 7 }, 'u_sales1');
    expect(await value(fx.customers, f.total, rec.c1)).toBe(await expected());
    expect(await expected()).toBeGreaterThan(7);
    await mutation.delete(
      scope,
      fx.orders.id,
      as('u_admin'),
      { ids: [mine as Id<'rec'>] },
      auditOf('u_admin'),
    );
    await drainAll();
  });

  it('past the sync limit: queued, recomputing, one debounced job per field, then ready', async () => {
    const limited = new RecordMutationService(db, {
      schema,
      now: () => NOW,
      recompute: new ComputedRecomputeService(db, { syncRowLimit: 0 }),
    });
    const before = await value(fx.customers, f.total, rec.c1);
    await update(fx.orders, rec.o1, { [fx.fld.amount.id]: 160 }, 'u_admin', limited);
    await update(fx.orders, rec.o3, { [fx.fld.amount.id]: 60 }, 'u_admin', limited);
    // Nothing fits the budget: every field goes to the job, values unchanged meanwhile.
    expect(await value(fx.orders, f.commission, rec.o1)).toBe(15);
    expect(await value(fx.customers, f.total, rec.c1)).toBe(before);
    expect(await state(f.total.id)).toBe('recomputing');
    expect(await state(f.commission.id)).toBe('recomputing');
    expect(await queued(f.commission.id)).toEqual([rec.o1, rec.o3].sort());
    expect(await queued(f.total.id)).toEqual([rec.c1, rec.c2].sort());
    // One debounced job per field (ADR-18 §5): due about 2 s after the writes.
    const { rows: jobs } = await sql<{ run_at: Date }>`
      SELECT run_at FROM graphile_worker.jobs
       WHERE key = ${`computed.recompute:${f.total.id}`}
    `.execute(db.kysely);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.run_at.getTime()).toBeGreaterThan(Date.now());
    await drainAll(limited);
    expect(await value(fx.orders, f.commission, rec.o1)).toBe(16);
    expect(await value(fx.customers, f.total, rec.c1)).toBe((before ?? 0) + 10);
    expect(await value(fx.orders, f.custTotal, rec.o1)).toBe((before ?? 0) + 10);
    expect(await state(f.total.id)).toBe('ready');
    expect(await queued(f.total.id)).toEqual([]);
  });

  it('two writers across two tables at once never hang (deadlock → retry)', async () => {
    const custName = await formula(fx.orders, 'custName', '[customer].[name].FIRST()');
    await refreshSchema();
    const rounds = 6;
    for (let round = 0; round < rounds; round += 1) {
      // Orders row, then Customers rows (lookup) ↔ Customers row, then Orders rows (custName).
      const results = await Promise.allSettled([
        update(fx.orders, round % 2 === 0 ? rec.o1 : rec.o2, { [fx.fld.amount.id]: 200 + round }),
        update(fx.customers, rec.c1, { [fx.fld.name.id]: `An ${String(round)}` }),
      ]);
      expect(results.filter((result) => result.status === 'rejected')).toEqual([]);
    }
    const last = rounds - 1;
    expect((await values(fx.orders, custName))[rec.o1]).toBe(`An ${String(last)}`);
    const expected = await sql<{ s: string }>`
      SELECT sum(o.${sql.id(fx.fld.amount.db_column_name ?? '')}) AS s
        FROM ${sql.id('data', fx.orders.db_table_name)} AS o
        JOIN ${sql.id('data', f.customer.link_junction ?? '')} AS j ON j.a_id = o.__id
       WHERE j.b_id = ${rec.c1} AND o.__deleted_at IS NULL
    `.execute(db.kysely);
    expect(await value(fx.customers, f.total, rec.c1)).toBe(Number(expected.rows[0]?.s));
    await drainAll();
  }, 60_000);

  it('self-link both ways with lookups on both sides: 500 links, finite, right values', async () => {
    const { table: nodes, primaryField: nodeName } = await schema.createTable(
      scope,
      { baseId: fx.baseId, name: 'Nodes', primaryFieldName: 'name' },
      context,
    );
    const val = await schema.addField(scope, nodes.id, { name: 'val', type: 'number' }, context);
    const peers = await schema.addField(
      scope,
      nodes.id,
      { name: 'peers', type: 'link', options: { link_table: nodes.id, bidirectional: true } },
      context,
    );
    const back = await db.kysely
      .selectFrom('meta.fields')
      .selectAll()
      .where('table_id', '=', nodes.id)
      .where('type', '=', 'link')
      .where('id', '!=', peers.id)
      .executeTakeFirstOrThrow();
    await refreshSchema([nodes]);
    const ids = await create(
      nodes,
      Array.from({ length: 501 }, (_, i) => ({ [nodeName.id]: `n${String(i)}`, [val.id]: 1 })),
    );
    const sumPeers = await formula(nodes, 'sumPeers', '[peers].[val].SUM()');
    const sumBack = await formula(nodes, 'sumBack', `[${back.name}].[val].SUM()`);
    const linked = await lookup(nodes, 'linkedMe', {
      from: nodes.id,
      select: val.id,
      where: { field: peers.id, operator: 'intersects', value: { field_ref: '__id' } },
      aggregate: 'sum',
    });
    await refreshSchema([nodes]);
    const [first, ...others] = ids as [Id<'rec'>, ...Id<'rec'>[]];
    const started = performance.now();
    await update(nodes, first, { [peers.id]: others });
    const elapsed = performance.now() - started;
    // Order is deterministic (table, field position, id): sumPeers (1 row),
    // sumBack (500 rows) fit the 1 000-row budget and are written by the
    // PATCH; linkedMe (500 more) is past it and goes to the job.
    expect(await value(nodes, sumPeers, first)).toBe(500);
    const synced = await values(nodes, sumBack);
    for (const id of others) expect(num(synced[id] ?? null)).toBe(1);
    expect((await queued(linked.id)).length).toBeGreaterThan(0);
    expect(await queued(sumBack.id)).toEqual([]);
    expect(
      (
        await db.kysely
          .selectFrom('meta.fields')
          .select('compute_state')
          .where('id', '=', linked.id)
          .executeTakeFirstOrThrow()
      ).compute_state,
    ).toBe('recomputing');
    await drainAll();
    expect(await queued(linked.id)).toEqual([]);
    const backValues = await values(nodes, sumBack);
    const linkedValues = await values(nodes, linked);
    for (const id of others) {
      expect(num(backValues[id] ?? null)).toBe(1);
      expect(num(linkedValues[id] ?? null)).toBe(1);
    }
    // A value change fans out through both sides, once.
    await update(nodes, first, { [val.id]: 5 });
    expect(num((await values(nodes, sumBack))[others[0] as Id<'rec'>] ?? null)).toBe(5);
    expect(await queued(sumBack.id)).toEqual([]);
    expect(elapsed).toBeLessThan(10_000);
    process.stdout.write(`  T458 PATCH 500 self-links with 3 lookups: ${elapsed.toFixed(0)} ms\n`);
  }, 60_000);

  it('schema sources: renamed select option, zone of a date field, auto number', async () => {
    const statusFlag = await formula(fx.orders, 'statusFlag', 'IF([status] = "Xong", 1, 0)');
    await update(fx.orders, rec.o1, { [fx.fld.status.id]: 'Xong' });
    expect(await value(fx.orders, statusFlag, rec.o1)).toBe(1);
    const statusOptions = fx.fld.status.options as {
      options: { id: string; name: string }[];
      multiple: boolean;
    };
    await schema.updateField(
      scope,
      fx.fld.status.id,
      {
        options: {
          ...statusOptions,
          options: statusOptions.options.map((option) =>
            option.id === fx.opt.done ? { ...option, name: 'Done' } : option,
          ),
        },
      },
      context,
    );
    expect(await state(statusFlag.id)).toBe('recomputing');
    expect(await queued(statusFlag.id)).toEqual([EVERY_RECORD]);
    await drainAll();
    expect(await value(fx.orders, statusFlag, rec.o1)).toBe(0);
    expect(await state(statusFlag.id)).toBe('ready');

    const due = await schema.addField(
      scope,
      fx.orders.id,
      { name: 'due', type: 'datetime', options: { style: { format: 'yyyy-MM-dd HH:mm' } } },
      context,
    );
    await refreshSchema();
    const dueDay = await formula(fx.orders, 'dueDay', 'DAY([due])');
    await update(fx.orders, rec.o1, { [due.id]: '2026-09-23T20:00:00.000Z' });
    expect(await value(fx.orders, dueDay, rec.o1)).toBe(23);
    await schema.updateField(
      scope,
      due.id,
      { options: { style: { format: 'yyyy-MM-dd HH:mm' }, timezone: 'Asia/Ho_Chi_Minh' } },
      context,
    );
    expect(await queued(dueDay.id)).toEqual([EVERY_RECORD]);
    await drainAll();
    // 20:00 UTC is the 24th in Ho Chi Minh City.
    expect(await value(fx.orders, dueDay, rec.o1)).toBe(24);

    // Zone of the organization (ADR-21): date formulas only.
    await db.withTx(async (tx) => {
      const result = await new ComputedRecomputeService(db).enqueueTimeZoneChange(tx, ORG_A);
      expect(result.deferred.map((item) => item.fieldId)).toContain(dueDay.id);
      expect(result.deferred.map((item) => item.fieldId)).not.toContain(f.commission.id);
    });
    await drainAll();

    const autoNumber = await schema.addField(
      scope,
      fx.orders.id,
      { name: 'no', type: 'auto_number', options: {} },
      context,
    );
    await refreshSchema();
    const label = await formula(fx.orders, 'label', '"#" & [no]');
    const before = (await values(fx.orders, label))[rec.o1];
    await schema.updateField(
      scope,
      autoNumber.id,
      {
        options: {
          style: {
            rules: [
              { type: 'text', text: 'ĐH-' },
              { type: 'incremental_number', length: 4 },
            ],
          },
        },
      },
      context,
    );
    await mutation.recomputeAutoNumber(scope, fx.orders.id, autoNumber.id);
    await drainAll();
    const after = (await values(fx.orders, label))[rec.o1];
    expect(after).not.toBe(before);
    expect(String(after)).toMatch(/^#ĐH-\d{4}$/);
  }, 60_000);

  it('a purged table queues the readers of its link fields in other tables', async () => {
    const { table: extra, primaryField: extraName } = await schema.createTable(
      scope,
      { baseId: fx.baseId, name: 'Extra', primaryFieldName: 'name' },
      context,
    );
    const x = await schema.addField(scope, extra.id, { name: 'x', type: 'number' }, context);
    const toExtra = await schema.addField(
      scope,
      fx.customers.id,
      { name: 'extra', type: 'link', options: { link_table: extra.id } },
      context,
    );
    await refreshSchema([extra]);
    const [e1] = await create(extra, [{ [extraName.id]: 'e1', [x.id]: 4 }]);
    await update(fx.customers, rec.c2, { [toExtra.id]: [e1] });
    const extraSum = await formula(fx.customers, 'extraSum', '[extra].[x].SUM()');
    expect(await value(fx.customers, extraSum, rec.c2)).toBe(4);
    await schema.deleteTable(scope, extra.id, context);
    await schema.purgeTable(scope, extra.id, { reason: 'manual', confirmName: 'Extra' }, context);
    // T460: the reader is `REF` (its link went to the trash for good): it reads
    // empty and is not recomputed, so nothing is queued for it.
    const after = await db.kysely
      .selectFrom('meta.fields')
      .select(['compute_state', 'compute_error'])
      .where('id', '=', extraSum.id)
      .executeTakeFirstOrThrow();
    expect(after).toMatchObject({ compute_state: 'error', compute_error: { code: 'REF' } });
    expect(await queued(extraSum.id)).toEqual([]);
    await drainAll();
    expect(await queued(extraSum.id)).toEqual([]);
  }, 60_000);

  it('the queue is isolated by organization', async () => {
    const queue = new ComputedRecomputeQueueRepository(db);
    const a = orgScope(ORG_A);
    const b = orgScope(ORG_B);
    await queue.add(a, f.total.id, [rec.c1]);
    expect(await queue.count(b, f.total.id)).toBe(0);
    expect(await db.withTx(async (tx) => queue.take(orgScope(ORG_B, tx), f.total.id, 10))).toEqual({
      kind: 'empty',
    });
    await queue.clear(b, f.total.id);
    expect(await queue.setComputeState(b, [f.total.id], 'ready', 'recomputing')).toEqual([]);
    expect(await queue.count(a, f.total.id)).toBe(1);
    await queue.clear(a, f.total.id);
    expect(await queue.count(a, f.total.id)).toBe(0);

    // T471: another organization naming this field queues nothing, so it
    // can neither block a record of it nor restart its every-record row.
    const rows = () =>
      db.kysely
        .selectFrom('meta.computed_recompute_queue')
        .select(['organization_id', 'record_id', 'after_auto'])
        .where('field_id', '=', f.total.id)
        .orderBy('record_id')
        .execute();
    await queue.add(b, f.total.id, [rec.c2]);
    await queue.add(b, f.total.id, 'all');
    expect(await rows()).toEqual([]);
    await queue.add(a, f.total.id, [rec.c2]);
    await queue.add(a, f.total.id, 'all');
    await queue.advance(a, f.total.id, 7n, false);
    await queue.add(b, f.total.id, 'all');
    await queue.advance(b, f.total.id, 9n, false);
    await queue.advance(b, f.total.id, 9n, true);
    expect(await rows()).toEqual([
      { organization_id: ORG_A, record_id: '*', after_auto: 7n },
      { organization_id: ORG_A, record_id: rec.c2, after_auto: 0n },
    ]);
    await queue.clear(a, f.total.id);
    expect(await queue.count(a, f.total.id)).toBe(0);
  });

  it('queue rows merge the causation of their writes and the created flag (T509)', async () => {
    const queue = new ComputedRecomputeQueueRepository(db);
    const a = orgScope(ORG_A);
    const A = 'aut_QueueAutA0000001' as Id<'aut'>;
    const B = 'aut_QueueAutB0000001' as Id<'aut'>;
    const root1 = 'evt_QueueRoot0000001' as Id<'evt'>;
    const root2 = 'evt_QueueRoot0000002' as Id<'evt'>;
    const take = () => db.withTx((tx) => queue.take(orgScope(ORG_A, tx), f.total.id, 10));
    // A user's write creating c1 and touching c2, then an automation run touching c2 again.
    await queue.add(a, f.total.id, [rec.c2, rec.c1], {
      causation: { root_event_id: root1, depth: 0, automation_chain: [] },
      created: new Set([rec.c1, rec.c2]),
    });
    await queue.add(a, f.total.id, [rec.c2], {
      causation: { root_event_id: root2, depth: 2, automation_chain: [A, B] },
      created: new Set(),
    });
    // Org B's writes never reach org A's rows.
    await queue.add(orgScope(ORG_B), f.total.id, [rec.c1], {
      causation: { root_event_id: root2, depth: 4, automation_chain: [B] },
    });
    expect(await take()).toEqual({
      kind: 'records',
      recordIds: [rec.c1, rec.c2].sort(),
      // Root of the first row (c2's merge keeps its first write's); depth max, chains united.
      causation: {
        root_event_id: root1,
        depth: 2,
        automation_chain: [A, B],
      },
      created: new Set([rec.c1]),
    });
    // The every-record row merges too, and unknown causations leave known ones.
    await queue.add(a, f.total.id, 'all', {
      causation: { root_event_id: root1, depth: 1, automation_chain: [B] },
    });
    await queue.add(a, f.total.id, 'all');
    await queue.add(a, f.total.id, 'all', {
      causation: { root_event_id: root2, depth: 0, automation_chain: [A] },
    });
    expect(await take()).toEqual({
      kind: 'every',
      afterAuto: 0n,
      causation: { root_event_id: root1, depth: 1, automation_chain: [B, A] },
    });
    await queue.clear(a, f.total.id);
  });

  it('takes one batch of a long queue whose statistics say it is empty', async () => {
    const queue = new ComputedRecomputeQueueRepository(db);
    const a = orgScope(ORG_A);
    // A queue is usually drained: analysed nearly empty, the planner expects
    // ~1 row of a field. An import then queues 10 000 records (CI: the job
    // marked the field TIMEOUT after taking its batch twice past 30 s).
    await sql`ANALYZE meta.computed_recompute_queue`.execute(db.kysely);
    // Digits only: the same order in JS and in the database's collation.
    const ids = Array.from({ length: 10_000 }, (_, i) => `rec_Queue${String(i).padStart(11, '0')}`);
    await queue.add(a, f.total.id, ids);
    const batch = await db.withTx((tx) => queue.take(orgScope(ORG_A, tx), f.total.id, 5000));
    expect(batch.kind === 'records' ? batch.recordIds : batch).toEqual(ids.slice(0, 5000));
    expect(await queue.count(a, f.total.id)).toBe(5000);
    await queue.clear(a, f.total.id);
  }, 60_000);
});
