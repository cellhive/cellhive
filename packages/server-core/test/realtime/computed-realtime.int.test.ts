/**
 * T459 on PostgreSQL 18: realtime of recomputed formula/lookup values.
 * `ComputedRecomputeService` publishes, through its default hook, one
 * `record.changes` per recomputed table after commit (nothing on rollback),
 * after the write that caused it, with `event_id: null`, the version
 * unchanged, images carrying computed fields named by view filters (old →
 * new) and field meta saying what each computed field reads. Ordinary
 * writes carry those computed fields in their images too, with the value
 * before the recompute. Also: link titles refreshed when a primary field
 * changes (S4-review §4 #11), `schema.changed` when the base setting
 * `strict_computed_permissions` moves, progress of the recompute job, and
 * tenant isolation.
 */
import { newId, type Id } from '@cellhive/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { systemAuditContext, type AuditContext } from '../../src/audit/index.js';
import { ComputedRecomputeService } from '../../src/computed/index.js';
import { orgScope, type Db } from '../../src/db/index.js';
import {
  attachRealtimePublisher,
  parseRealtimeEnvelope,
  publishComputedLocksChanged,
  publishComputedRecomputing,
  publishLinkTitlesChanged,
  RealtimeSchemaChangePublisher,
  type RealtimeEnvelope,
  type RecordChangesEnvelope,
} from '../../src/realtime/index.js';
import {
  RecordMutationService,
  RecordQueryService,
  type RecordAccessContext,
} from '../../src/records/index.js';
import { SchemaService } from '../../src/schema/index.js';
import { ViewsRepository } from '../../src/views/index.js';
import { accessOf, buildOrdersFixture, NOW, type OrdersFixture } from '../records/fixtures.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';
import { seedTenant } from '../support/tenant.js';

import type { FieldRow, TableRow } from '../../src/db/schema.js';

const ORG_A: Id<'org'> = 'org_T459RealtimeOrgA';
const ORG_B: Id<'org'> = 'org_T459RealtimeOrgB';

describe('realtime of recomputed values (T459)', () => {
  let database: TestDatabase;
  let db: Db;
  let schema: SchemaService;
  let mutation: RecordMutationService;
  let fx: OrdersFixture;
  const scope = orgScope(ORG_A);
  const context = systemAuditContext();
  const published: RealtimeEnvelope[] = [];
  const f = {} as Record<
    'customer' | 'orders' | 'total' | 'nameLen' | 'commission' | 'who',
    FieldRow
  >;
  const rec = {} as Record<'c1' | 'c2' | 'o1' | 'o2' | 'o3', Id<'rec'>>;

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

  async function field(fieldId: Id<'fld'>): Promise<FieldRow> {
    return db.kysely
      .selectFrom('meta.fields')
      .selectAll()
      .where('id', '=', fieldId)
      .executeTakeFirstOrThrow();
  }

  async function refreshSchema(): Promise<void> {
    for (const table of fx.schema.tables) {
      table.fields = await db.kysely
        .selectFrom('meta.fields')
        .select(['id', 'type'])
        .where('table_id', '=', table.id)
        .where('deleted_at', 'is', null)
        .execute();
    }
  }

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

  async function computed(
    table: TableRow,
    name: string,
    type: 'formula' | 'lookup',
    options: Record<string, unknown>,
  ): Promise<FieldRow> {
    const created = await schema.addField(
      scope,
      table.id,
      { name, type, options, computed: { timeZone: 'UTC' } },
      context,
    );
    await backfill(created);
    return field(created.id);
  }

  const update = (table: TableRow, id: Id<'rec'>, fields: Record<string, unknown>) =>
    mutation.update(
      scope,
      table.id,
      as('u_admin'),
      { field_key_type: 'id', records: [{ id, fields }] },
      auditOf('u_admin'),
    );

  const create = async (
    table: TableRow,
    records: readonly Record<string, unknown>[],
  ): Promise<Id<'rec'>[]> =>
    (
      await mutation.create(
        scope,
        table.id,
        as('u_admin'),
        { field_key_type: 'id', records: records.map((fields) => ({ fields })) },
        auditOf('u_admin'),
      )
    ).records.map((record) => record.id);

  const recordChanges = () =>
    published.filter(
      (envelope): envelope is RecordChangesEnvelope => envelope.type === 'record.changes',
    );
  const recomputes = (tableId: Id<'tbl'>) =>
    recordChanges().filter(
      (envelope) =>
        envelope.table_id === tableId &&
        envelope.link_fanout === undefined &&
        envelope.changes.every((change) => change.event_id === null),
    );

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    attachRealtimePublisher(db, {
      publish: (envelope) => {
        published.push(envelope);
        return Promise.resolve();
      },
    });
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
    f.orders = await db.kysely
      .selectFrom('meta.fields')
      .selectAll()
      .where('table_id', '=', fx.customers.id)
      .where('type', '=', 'link')
      .executeTakeFirstOrThrow();
    await refreshSchema();
    [rec.c1, rec.c2] = (await create(fx.customers, [
      { [fx.fld.name.id]: 'An' },
      { [fx.fld.name.id]: 'Bình' },
    ])) as [Id<'rec'>, Id<'rec'>];
    [rec.o1, rec.o2, rec.o3] = (await create(fx.orders, [
      { [fx.fld.title.id]: 'o1', [fx.fld.amount.id]: 100, [f.customer.id]: [rec.c1] },
      { [fx.fld.title.id]: 'o2', [fx.fld.amount.id]: 200, [f.customer.id]: [rec.c1] },
      { [fx.fld.title.id]: 'o3', [fx.fld.amount.id]: 50, [f.customer.id]: [rec.c2] },
    ])) as [Id<'rec'>, Id<'rec'>, Id<'rec'>];
    f.total = await computed(fx.customers, 'total', 'lookup', {
      from: fx.orders.id,
      select: fx.fld.amount.id,
      where: { field: f.customer.id, operator: 'intersects', value: { field_ref: '__id' } },
      aggregate: 'sum',
    });
    f.nameLen = await computed(fx.customers, 'nameLen', 'formula', { expression: 'LEN([name])' });
    f.commission = await computed(fx.orders, 'commission', 'formula', {
      expression: '[amount] * 0.1',
    });
    // Records as values: the customer of each order (titles under the link title rule).
    f.who = await computed(fx.orders, 'who', 'formula', { expression: '[customer]' });
    await refreshSchema();
    // A saved view of Customers filters on the computed fields: they travel in images.
    await new ViewsRepository(db).insert(scope, {
      id: newId('viw'),
      tableId: fx.customers.id,
      type: 'grid',
      name: 'Big',
      config: {
        filter: {
          op: 'and',
          items: [
            { field: f.total.id, operator: 'gt', value: 250 },
            { field: f.nameLen.id, operator: 'gt', value: 0 },
          ],
        },
      },
      position: 1,
      ownerId: null,
    });
  }, 120_000);

  beforeEach(() => {
    published.length = 0;
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('a write publishes the recomputed values after its own changes (event_id null, same version)', async () => {
    await update(fx.orders, rec.o1, { [fx.fld.amount.id]: 300 });
    const envelopes = recordChanges();
    const own = envelopes.findIndex((envelope) =>
      envelope.changes.some((change) => change.event_id !== null),
    );
    expect(own).toBeGreaterThanOrEqual(0);
    const customers = recomputes(fx.customers.id);
    expect(customers).toHaveLength(1);
    expect(envelopes.indexOf(customers[0] as RecordChangesEnvelope)).toBeGreaterThan(own);
    const envelope = customers[0] as RecordChangesEnvelope;
    expect(envelope.actor_id).toBeNull();
    const [change] = envelope.changes;
    const { rows } = await sql<{ v: number }>`
      SELECT __version AS v FROM ${sql.id('data', fx.customers.db_table_name)}
       WHERE __id = ${rec.c1}
    `.execute(db.kysely);
    expect(change).toMatchObject({
      op: 'updated',
      record_id: rec.c1,
      version: rows[0]?.v,
      event_id: null,
      changed: [f.total.id],
      values: { [f.total.id]: 500 },
    });
    // The view filter's computed fields, old → new.
    expect(change?.before).toMatchObject({ [f.total.id]: 300, [f.nameLen.id]: 2 });
    expect(change?.after).toMatchObject({ [f.total.id]: 500, [f.nameLen.id]: 2 });
    const meta = envelope.fields.find((item) => item.id === f.total.id);
    expect(meta?.computed).toMatchObject({ result_type: 'number', strict: false });
    expect(meta?.computed?.tables).toContain(fx.orders.id);
    expect(meta?.computed?.cross_fields).toEqual(
      expect.arrayContaining([
        { table_id: fx.orders.id, field_id: fx.fld.amount.id },
        { table_id: fx.orders.id, field_id: f.customer.id },
      ]),
    );
    // Same-row formula of the written record: its own recompute envelope.
    const orders = recomputes(fx.orders.id);
    expect(orders.flatMap((item) => item.changes)).toContainEqual(
      expect.objectContaining({
        record_id: rec.o1,
        changed: [f.commission.id],
        values: { [f.commission.id]: 30 },
      }),
    );
  });

  it("an ordinary write carries view-filter computed fields as they were before this transaction's recompute", async () => {
    await update(fx.customers, rec.c1, { [fx.fld.name.id]: 'Anh' });
    const own = recordChanges().find(
      (envelope) =>
        envelope.table_id === fx.customers.id &&
        envelope.changes.some((change) => change.event_id !== null),
    );
    const [change] = own?.changes ?? [];
    expect(change?.before).toMatchObject({ [f.nameLen.id]: 2, [f.total.id]: 500 });
    expect(change?.after).toMatchObject({ [f.nameLen.id]: 2, [f.total.id]: 500 });
    expect(own?.fields.find((item) => item.id === f.nameLen.id)?.computed?.result_type).toBe(
      'number',
    );
    const [recomputed] = recomputes(fx.customers.id);
    expect(recomputed?.changes[0]).toMatchObject({
      record_id: rec.c1,
      changed: [f.nameLen.id],
      before: { [f.nameLen.id]: 2 },
      after: { [f.nameLen.id]: 3 },
      values: { [f.nameLen.id]: 3 },
    });
  });

  it('record values carry every title and the link meta that hides them per subscriber', async () => {
    await update(fx.orders, rec.o3, { [f.customer.id]: [rec.c1] });
    const envelope = recomputes(fx.orders.id).find((item) =>
      item.changes.some((change) => change.changed.includes(f.who.id)),
    );
    expect(envelope?.links).toContainEqual({
      field_id: f.who.id,
      table_id: fx.customers.id,
      title_field_id: fx.fld.name.id,
    });
    expect(envelope?.changes.find((change) => change.record_id === rec.o3)?.values).toEqual({
      [f.who.id]: [{ id: rec.c1, title: 'Anh' }],
    });
  });

  it('a rolled back write publishes nothing', async () => {
    const service = new ComputedRecomputeService(db);
    await expect(
      db.withTx(async (tx) => {
        const result = await service.enqueue(tx, {
          organizationId: ORG_A,
          changes: [
            {
              kind: 'records',
              baseId: fx.baseId,
              tableId: fx.orders.id,
              recordIds: [rec.o2],
              event: 'updated',
              fieldIds: [fx.fld.amount.id],
            },
          ],
        });
        expect(result.deferred).toEqual([]);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(published).toEqual([]);
  });

  it('the recompute job publishes each batch as one write, with its remaining rows', async () => {
    const jobless = new RecordMutationService(db, {
      schema,
      now: () => NOW,
      recompute: new ComputedRecomputeService(db, { syncRowLimit: 0 }),
    });
    await jobless.update(
      scope,
      fx.orders.id,
      as('u_admin'),
      { field_key_type: 'id', records: [{ id: rec.o2, fields: { [fx.fld.amount.id]: 250 } }] },
      auditOf('u_admin'),
    );
    expect(recomputes(fx.customers.id)).toEqual([]);
    published.length = 0;
    const batch = await jobless.recomputeComputedBatch(scope, f.total.id, {
      statementTimeoutMs: 30_000,
    });
    expect(batch).toMatchObject({
      status: 'more',
      rows: 1,
      remaining: 0,
      tableId: fx.customers.id,
    });
    expect(recomputes(fx.customers.id).flatMap((item) => item.changes)).toEqual([
      // o1 300 + o2 250 + o3 50 (moved to c1 above).
      expect.objectContaining({ record_id: rec.c1, values: { [f.total.id]: 600 } }),
    ]);
    for (let guard = 0; guard < 10; guard += 1) {
      const queued = await db.kysely
        .selectFrom('meta.computed_recompute_queue')
        .select('field_id')
        .distinct()
        .where('organization_id', '=', ORG_A)
        .execute();
      if (queued.length === 0) break;
      for (const row of queued) {
        while (
          (
            await jobless.recomputeComputedBatch(scope, row.field_id, {
              statementTimeoutMs: 30_000,
            })
          ).status === 'more'
        );
      }
    }
  });

  it('a primary field change refreshes link cells of other tables: titles only, no values', async () => {
    await publishLinkTitlesChanged(db, ORG_A, fx.customers.id, fx.fld.name.id);
    const envelopes = recordChanges();
    expect(envelopes.map((item) => item.table_id)).toEqual([fx.orders.id]);
    const [envelope] = envelopes;
    expect(envelope?.link_fanout).toEqual({
      field_id: f.customer.id,
      titles_only: true,
      values: false,
    });
    expect(envelope?.changes.map((change) => change.record_id).sort()).toEqual(
      [rec.o1, rec.o2, rec.o3].sort(),
    );
    expect(envelope?.changes.every((change) => change.event_id === null)).toBe(true);
    expect(envelope?.changes.every((change) => Object.keys(change.values).length === 0)).toBe(true);

    // Not the primary field: nothing.
    published.length = 0;
    await publishLinkTitlesChanged(db, ORG_A, fx.customers.id, fx.fld.phone.id);
    expect(published).toEqual([]);

    // Through the schema change publisher (field `updated`).
    const bus: RealtimeEnvelope[] = [];
    const publisher = new RealtimeSchemaChangePublisher(
      {
        publish: (item) => {
          bus.push(item);
          return Promise.resolve();
        },
      },
      { db },
    );
    await publisher.publish({
      organization_id: ORG_A,
      base_id: fx.baseId,
      table_id: fx.customers.id,
      entity: 'field',
      entity_id: fx.fld.name.id,
      action: 'updated',
    });
    expect(bus.map((item) => item.type)).toEqual(['schema.changed']);
    expect(recordChanges().map((item) => item.link_fanout?.field_id)).toEqual([f.customer.id]);
  });

  it('strict_computed_permissions changes: schema.changed for every computed field of the base, after commit', async () => {
    await db.withTx(async (tx) => {
      await publishComputedLocksChanged(db, tx, scope, fx.baseId);
      expect(published).toEqual([]);
    });
    const ids = published.flatMap((item) =>
      item.type === 'schema.changed' ? [item.entity_id] : [],
    );
    expect(ids.sort()).toEqual([f.total.id, f.nameLen.id, f.commission.id, f.who.id].sort());
  });

  it('a system job (auto numbers) images the link cells a view filter names', async () => {
    const numbers = await schema.addField(
      scope,
      fx.orders.id,
      {
        name: 'no',
        type: 'auto_number',
        options: { style: { rules: [{ type: 'incremental_number', length: 3 }] } },
      },
      context,
    );
    await new ViewsRepository(db).insert(scope, {
      id: newId('viw'),
      tableId: fx.orders.id,
      type: 'grid',
      name: 'With customer',
      config: {
        filter: { op: 'and', items: [{ field: f.customer.id, operator: 'is_not_empty' }] },
      },
      position: 2,
      ownerId: null,
    });
    await schema.updateFieldOptions(
      scope,
      numbers.id,
      {
        options: {
          style: {
            rules: [
              { type: 'text', text: 'N-' },
              { type: 'incremental_number', length: 3 },
            ],
          },
        },
      },
      context,
    );
    published.length = 0;
    await mutation.recomputeAutoNumber(scope, fx.orders.id, numbers.id);
    const changes = recordChanges()
      .filter((envelope) => envelope.table_id === fx.orders.id)
      .flatMap((envelope) => envelope.changes);
    const o1 = changes.find((change) => change.record_id === rec.o1);
    expect(o1?.changed).toEqual([numbers.id]);
    expect(o1?.before?.[f.customer.id]).toEqual([rec.c1]);
    expect(o1?.after?.[f.customer.id]).toEqual([rec.c1]);
    expect(
      recordChanges()
        .flatMap((envelope) => envelope.fields)
        .some((item) => item.id === f.customer.id && item.type === 'link'),
    ).toBe(true);
  });

  it('computed.recomputing: clamped progress with its status, a valid bus envelope', async () => {
    await publishComputedRecomputing(db, undefined, {
      organizationId: ORG_A,
      tableId: fx.customers.id,
      fieldId: f.total.id,
      progress: 1.7,
      status: 'succeeded',
    });
    const [envelope] = published;
    expect(envelope).toEqual({
      v: 1,
      type: 'computed.recomputing',
      organization_id: ORG_A,
      table_id: fx.customers.id,
      field_id: f.total.id,
      progress: 1,
      status: 'succeeded',
    });
    expect(parseRealtimeEnvelope(JSON.stringify(envelope), ORG_A)).toEqual(envelope);
    expect(parseRealtimeEnvelope(JSON.stringify(envelope), ORG_B)).toBeUndefined();
  });

  it('publishes on the organization of the write only (tenant isolation)', async () => {
    await update(fx.orders, rec.o1, { [fx.fld.amount.id]: 310 });
    expect(published.length).toBeGreaterThan(0);
    expect(new Set(published.map((item) => item.organization_id))).toEqual(new Set([ORG_A]));
    // Another organization cannot recompute (or publish) the records of this one.
    published.length = 0;
    await db.withTx(async (tx) => {
      await new ComputedRecomputeService(db).enqueue(tx, {
        organizationId: ORG_B,
        changes: [
          {
            kind: 'records',
            baseId: fx.baseId,
            tableId: fx.orders.id,
            recordIds: [rec.o1],
            event: 'updated',
            fieldIds: [fx.fld.amount.id],
          },
        ],
      });
    });
    expect(published).toEqual([]);
  });
});
