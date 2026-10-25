/**
 * Link fields in role record rules (BACKLOG T710, S6 decision #13, CONTRACTS
 * §5 P62, §14) at the service level on PostgreSQL 18:
 *
 * - `read_filter = customer has_any_of [c1]`: `RecordQueryService` reads
 *   only orders linked to c1, over the **live** linked records (c1 in the
 *   trash → nothing, restored → back);
 * - `edit_filter` on the link: `RecordMutationService` checks it on the rows
 *   as written, link cells included — a change that moves the record out is
 *   `403 RECORD_RULE_VIOLATION` and nothing is written (rollback);
 * - realtime images carry the link cells the rules name, and trashing a
 *   linked record fans the cell change out (`LinkFanout`);
 * - a deleted link field makes the rule fail closed.
 */
import { newId, type Id } from '@cellhive/contracts';
import { roleConfigSchema, type RoleConfigInput } from '@cellhive/permissions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemAuditContext, type AuditContext } from '../../src/audit/index.js';
import { BaseRolesRepository, orgScope, type Db } from '../../src/db/index.js';
import { AppError } from '../../src/errors/index.js';
import {
  RecordMutationService,
  RecordQueryService,
  type RecordAccessContext,
  type RecordChange,
  type RecordChangeFanout,
} from '../../src/records/index.js';
import { SchemaService } from '../../src/schema/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';

import { accessOf, buildOrdersFixture, NOW, type OrdersFixture } from './fixtures.js';

import type { FieldRow, JsonObject } from '../../src/db/schema.js';

const ORG: Id<'org'> = 'org_T710LinkRuleOrgA';

interface Published {
  readonly changes: RecordChange[];
  readonly fanout: RecordChangeFanout | undefined;
}

describe('link fields in role record rules (T710, P62)', () => {
  let database: TestDatabase;
  let db: Db;
  let schema: SchemaService;
  let service: RecordMutationService;
  let query: RecordQueryService;
  let fx: OrdersFixture;
  let customer: FieldRow;
  let c1: Id<'rec'>, c2: Id<'rec'>;
  let r1: Id<'rec'>, r2: Id<'rec'>, r3: Id<'rec'>;
  const published: Published[] = [];
  const scope = orgScope(ORG);
  const context = systemAuditContext();

  const as = (user: keyof OrdersFixture['users']): RecordAccessContext => accessOf(fx, user);
  const audit = (user: keyof OrdersFixture['users'] = 'u_admin'): AuditContext => {
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

  /** Order ids `user` reads, in creation order. */
  async function readable(user: keyof OrdersFixture['users']): Promise<string[]> {
    const out = await query.query(scope, fx.orders.id, as(user), {
      field_key_type: 'id',
      fields: [fx.fld.title.id],
      limit: 100,
      include_total: false,
    });
    return out.records.map((record) => record.id);
  }

  async function adminCell(id: Id<'rec'>): Promise<{ version: number; customer: unknown }> {
    const out = await query.query(scope, fx.orders.id, as('u_admin'), {
      field_key_type: 'id',
      fields: [customer.id],
      ids: [id],
      limit: 1,
      include_total: false,
    });
    const record = out.records[0];
    const cell = record?.fields[customer.id] as { id: string }[] | null | undefined;
    return { version: record?.version ?? -1, customer: cell?.map((ref) => ref.id) ?? null };
  }

  async function expectViolation(write: Promise<unknown>): Promise<void> {
    const error: unknown = await write.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('RECORD_RULE_VIOLATION');
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
        publish: (changes, _fields, _links, fanout) => {
          published.push({ changes: [...changes], fanout });
        },
      },
    });
    fx = await buildOrdersFixture(db, schema, ORG);
    customer = await schema.addField(
      scope,
      fx.orders.id,
      { name: 'customer', type: 'link', options: { link_table: fx.customers.id } },
      context,
    );
    const orders = fx.schema.tables.find((table) => table.id === fx.orders.id);
    if (orders === undefined) throw new Error('no Orders in the fixture schema');
    orders.fields = [...orders.fields, { id: customer.id, type: customer.type }];

    [c1, c2] = (
      await service.create(
        scope,
        fx.customers.id,
        as('u_admin'),
        { records: [{ fields: { name: 'C1' } }, { fields: { name: 'C2' } }] },
        audit(),
      )
    ).records.map((record) => record.id) as [Id<'rec'>, Id<'rec'>];
    const c1Rule = { field: customer.id, operator: 'has_any_of', value: [c1] };
    // Sales variant of P62 (dedicated fixture): Orders manage, Customers read only,
    // read and edit rules on the link field.
    const variant: RoleConfigInput = {
      tables: {
        [fx.orders.id]: {
          perm: 'manage',
          record_rule: {
            operations: ['add', 'delete'],
            edit_filter: c1Rule,
            read_scope: 'filter',
            read_filter: c1Rule,
          },
        },
        [fx.customers.id]: { perm: 'read_only' },
      },
    };
    fx.roles.sales = { ...fx.roles.sales, config: roleConfigSchema.parse(variant) };
    // Stored too: realtime images follow the rules of the base's stored roles
    // (`RecordRuleFields`, read on the first write below).
    await new BaseRolesRepository(db).create(scope, {
      id: fx.roles.sales.id,
      baseId: fx.baseId,
      name: 'Sales (link rule)',
      kind: 'custom',
      config: fx.roles.sales.config as unknown as JsonObject,
    });
    // A fresh service: the first one cached the base's rule fields without the role.
    service = new RecordMutationService(db, {
      schema,
      query,
      now: () => NOW,
      publisher: {
        publish: (changes, _fields, _links, fanout) => {
          published.push({ changes: [...changes], fanout });
        },
      },
    });

    [r1, r2, r3] = (
      await service.create(
        scope,
        fx.orders.id,
        as('u_admin'),
        {
          records: [
            { fields: { title: 'r1', customer: [c1] } },
            { fields: { title: 'r2', customer: [c2] } },
            { fields: { title: 'r3' } },
          ],
        },
        audit(),
      )
    ).records.map((record) => record.id) as [Id<'rec'>, Id<'rec'>, Id<'rec'>];
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  it('reads only the orders linked to c1 (read_filter on the link)', async () => {
    expect(await readable('u_sales1')).toEqual([r1]);
    expect(await readable('u_admin')).toEqual([r1, r2, r3]);
  });

  it('counts live linked records only: c1 in the trash → nothing, restored → back', async () => {
    /** The fan-out of the order's link cell published since `from` (T402). */
    const fannedOut = (from: number) =>
      published
        .slice(from)
        .find((entry) => entry.fanout?.fieldId === customer.id)
        ?.changes.find((item) => item.recordId === r1);
    let from = published.length;
    await service.delete(scope, fx.customers.id, as('u_admin'), { ids: [c1] }, audit());
    try {
      expect(await readable('u_sales1')).toEqual([]);
      const change = fannedOut(from);
      expect(change?.before?.[customer.id]).toEqual([c1]);
      expect(change?.after?.[customer.id]).toBeNull();
    } finally {
      from = published.length;
      await service.restore(scope, fx.customers.id, as('u_admin'), { ids: [c1] }, audit());
    }
    expect(await readable('u_sales1')).toEqual([r1]);
    const change = fannedOut(from);
    expect(change?.before?.[customer.id]).toBeNull();
    expect(change?.after?.[customer.id]).toEqual([c1]);
  });

  it('edit_filter on the link: moving r1 to c2 is RECORD_RULE_VIOLATION, nothing written', async () => {
    const before = await adminCell(r1);
    const count = published.length;
    await expectViolation(
      service.update(
        scope,
        fx.orders.id,
        as('u_sales1'),
        { field_key_type: 'id', records: [{ id: r1, fields: { [customer.id]: [c2] } }] },
        audit('u_sales1'),
      ),
    );
    // With another field in the same write too: the whole write is rolled back.
    await expectViolation(
      service.update(
        scope,
        fx.orders.id,
        as('u_sales1'),
        {
          field_key_type: 'id',
          records: [{ id: r1, fields: { [fx.fld.title.id]: 'moved', [customer.id]: [c2] } }],
        },
        audit('u_sales1'),
      ),
    );
    expect(await adminCell(r1)).toEqual(before);
    expect(published.length).toBe(count);
  });

  it('keeps writes that stay in the rule, and checks new records after their links', async () => {
    const updated = await service.update(
      scope,
      fx.orders.id,
      as('u_sales1'),
      { field_key_type: 'id', records: [{ id: r1, fields: { [fx.fld.title.id]: 'r1 edited' } }] },
      audit('u_sales1'),
    );
    expect(updated.records.map((record) => record.id)).toEqual([r1]);
    // The image of a column-only change carries the rule's link cell (T710).
    const image = published.at(-1)?.changes.find((item) => item.recordId === r1);
    expect(image?.before?.[customer.id]).toEqual([c1]);
    expect(image?.after?.[customer.id]).toEqual([c1]);

    const create = (cell: Id<'rec'>[]) =>
      service.create(
        scope,
        fx.orders.id,
        as('u_sales1'),
        {
          field_key_type: 'id',
          records: [{ fields: { [fx.fld.title.id]: 'new', [customer.id]: cell } }],
        },
        audit('u_sales1'),
      );
    await expectViolation(create([c2]));
    await expectViolation(create([]));
    const created = (await create([c1])).records.map((record) => record.id);
    expect(await readable('u_sales1')).toEqual([r1, ...created]);
    await service.delete(scope, fx.orders.id, as('u_admin'), { ids: created }, audit());
  });

  it('r2 (linked to c2) is out of reach: not found to read, update or delete', async () => {
    const error: unknown = await service
      .update(
        scope,
        fx.orders.id,
        as('u_sales1'),
        { field_key_type: 'id', records: [{ id: r2, fields: { [customer.id]: [c1] } }] },
        audit('u_sales1'),
      )
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect((error as AppError).code).toBe('NOT_FOUND');
  });

  it('fails closed once the link field is deleted', async () => {
    await schema.deleteField(scope, customer.id, context);
    expect(await readable('u_sales1')).toEqual([]);
    expect(await readable('u_admin')).toEqual([r1, r2, r3]);
  });
});
