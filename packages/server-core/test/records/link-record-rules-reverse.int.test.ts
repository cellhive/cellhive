/**
 * Link rules and the reverse side of two-way links (BACKLOG T710, review
 * blocker; exception to S4 decision #6): when the writer's read or edit
 * rule on a table names a link field, changing that field's cells from the
 * other side of the link (writing the reverse cell, or the other side of a
 * self-link) is checked like a write on that table — every record whose
 * cell changes must be editable before (`403 PERMISSION_DENIED`) and stay
 * in the edit rule after (`403 RECORD_RULE_VIOLATION`). A rule that does not
 * name the field keeps S4 #6 (only the written side is checked).
 */
import { newId, type Id } from '@cellhive/contracts';
import {
  resolveBaseAccess,
  roleConfigSchema,
  type BaseRoleDef,
  type RoleConfigInput,
} from '@cellhive/permissions';
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
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';

import { buildOrdersFixture, LOCALE, NOW, TIME_ZONE, type OrdersFixture } from './fixtures.js';

import type { FieldRow } from '../../src/db/schema.js';

const ORG: Id<'org'> = 'org_T710ReverseOrgAA';

describe('link rules and reverse cells of two-way links (T710)', () => {
  let database: TestDatabase;
  let db: Db;
  let schema: SchemaService;
  let service: RecordMutationService;
  let query: RecordQueryService;
  let fx: OrdersFixture;
  /** Customers.orders ↔ Orders.buyer (the `b` side, on Orders). */
  let ordersOf: FieldRow;
  let buyer: FieldRow;
  /** Orders.related ↔ Orders.related_by (a two-way self-link). */
  let related: FieldRow;
  let relatedBy: FieldRow;
  let c1: Id<'rec'>, c2: Id<'rec'>, cX: Id<'rec'>;
  let r1: Id<'rec'>, r5: Id<'rec'>, r6: Id<'rec'>;
  const scope = orgScope(ORG);
  const context = systemAuditContext();

  const audit = (): AuditContext => {
    const requestId = newId('req');
    return {
      actor: { type: 'user', id: fx.users.u_sales1.id },
      via: null,
      batch_id: requestId,
      request_id: requestId,
      ip: null,
      user_agent: 'vitest',
    };
  };

  /** u_sales1 with one custom role assigned directly. */
  function withRole(config: RoleConfigInput): RecordAccessContext {
    const role: BaseRoleDef = {
      id: newId('rol'),
      kind: 'custom',
      name: 'Variant',
      config: roleConfigSchema.parse(config),
    };
    const resolved = resolveBaseAccess({
      principal: {
        userId: fx.users.u_sales1.id,
        groupIds: [],
        orgRole: 'member',
        workspaceRole: 'member',
        isBaseOwner: false,
      },
      roles: [role],
      assignments: [{ roleId: role.id, principalType: 'user', principalId: fx.users.u_sales1.id }],
      schema: fx.schema,
    });
    if (resolved === null) throw new Error('no access');
    return {
      baseId: fx.baseId,
      resolved,
      userId: fx.users.u_sales1.id,
      groupMemberUserIds: [],
      timeZone: TIME_ZONE,
      locale: LOCALE,
    };
  }

  const admin = (): RecordAccessContext =>
    withRole({
      tables: {
        [fx.orders.id]: { perm: 'manage', record_rule: { operations: ['add', 'delete'] } },
        [fx.customers.id]: { perm: 'manage', record_rule: { operations: ['add', 'delete'] } },
      },
    });

  /** Orders editable under `editFilter`, read scope `readScope`; Customers editable. */
  const ordersRule = (editFilter: unknown, readScope: 'all' | 'editable' = 'all') =>
    withRole({
      tables: {
        [fx.orders.id]: {
          perm: 'edit',
          record_rule: { edit_filter: editFilter as never, read_scope: readScope },
        },
        [fx.customers.id]: { perm: 'edit' },
      },
    });

  async function cell(field: FieldRow, id: Id<'rec'>): Promise<{ version: number; ids: string[] }> {
    const out = await query.query(scope, field.table_id, admin(), {
      field_key_type: 'id',
      fields: [field.id],
      ids: [id],
      limit: 1,
      include_total: false,
    });
    const record = out.records[0];
    const value = (record?.fields[field.id] ?? []) as { id: string }[];
    return { version: record?.version ?? -1, ids: value.map((ref) => ref.id) };
  }

  async function failsWith(code: string, write: Promise<unknown>): Promise<void> {
    const error: unknown = await write.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
  }

  const setCell = (
    access: RecordAccessContext,
    field: FieldRow,
    records: { id: Id<'rec'>; ids: Id<'rec'>[] }[],
  ) =>
    service.update(
      scope,
      field.table_id,
      access,
      {
        field_key_type: 'id',
        records: records.map((record) => ({ id: record.id, fields: { [field.id]: record.ids } })),
      },
      audit(),
    );

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    query = new RecordQueryService(db, { now: () => NOW });
    service = new RecordMutationService(db, { schema, query, now: () => NOW });
    fx = await buildOrdersFixture(db, schema, ORG);
    const fields = new FieldsRepository(db);
    const twoWay = async (tableId: Id<'tbl'>, name: string, target: Id<'tbl'>, back: string) => {
      const field = await schema.addField(
        scope,
        tableId,
        {
          name,
          type: 'link',
          options: { link_table: target, bidirectional: true, bidirectional_link_field_name: back },
        },
        context,
      );
      const reverse = await fields.getById(
        scope,
        (field.options as { symmetric_field_id: Id<'fld'> }).symmetric_field_id,
      );
      if (reverse === undefined) throw new Error('no reverse field');
      return [field, reverse] as const;
    };
    [ordersOf, buyer] = await twoWay(fx.customers.id, 'orders', fx.orders.id, 'buyer');
    [related, relatedBy] = await twoWay(fx.orders.id, 'related', fx.orders.id, 'related_by');
    for (const field of [ordersOf, buyer, related, relatedBy]) {
      const table = fx.schema.tables.find((item) => item.id === field.table_id);
      if (table === undefined) throw new Error('unknown table');
      table.fields = [...table.fields, { id: field.id, type: field.type }];
    }
    [c1, c2, cX] = (
      await service.create(
        scope,
        fx.customers.id,
        admin(),
        { records: ['C1', 'C2', 'CX'].map((name) => ({ fields: { name } })) },
        audit(),
      )
    ).records.map((record) => record.id) as [Id<'rec'>, Id<'rec'>, Id<'rec'>];
    [r1, r5, r6] = (
      await service.create(
        scope,
        fx.orders.id,
        admin(),
        {
          field_key_type: 'id',
          records: [
            { fields: { [fx.fld.title.id]: 'r1', [buyer.id]: [c1] } },
            { fields: { [fx.fld.title.id]: 'r5', [buyer.id]: [c2] } },
            { fields: { [fx.fld.title.id]: 'r6', [buyer.id]: [cX] } },
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

  it('has_any_of [c1]: adding r5 from c1.orders is 403 PERMISSION_DENIED, r5 unchanged', async () => {
    const access = ordersRule({ field: buyer.id, operator: 'has_any_of', value: [c1] });
    const before = await cell(buyer, r5);
    await failsWith('PERMISSION_DENIED', setCell(access, ordersOf, [{ id: c1, ids: [r1, r5] }]));
    expect(await cell(buyer, r5)).toEqual(before);
    expect((await cell(ordersOf, c1)).ids).toEqual([r1]);
    // Bulk (one of several records) and upsert take the same path.
    await failsWith(
      'PERMISSION_DENIED',
      setCell(access, ordersOf, [
        { id: c2, ids: [r5] },
        { id: c1, ids: [r1, r5] },
      ]),
    );
    await failsWith(
      'PERMISSION_DENIED',
      service.upsert(
        scope,
        fx.customers.id,
        access,
        {
          field_key_type: 'id',
          merge_on: [fx.fld.name.id],
          records: [{ fields: { [fx.fld.name.id]: 'C1', [ordersOf.id]: [r1, r5] } }],
        },
        audit(),
      ),
    );
    expect(await cell(buyer, r5)).toEqual(before);
  });

  it('has_none_of [cX]: unlinking the hidden r6 from cX.orders is 403, r6 stays hidden', async () => {
    const access = ordersRule(
      { field: buyer.id, operator: 'has_none_of', value: [cX] },
      'editable',
    );
    const before = await cell(buyer, r6);
    await failsWith('PERMISSION_DENIED', setCell(access, ordersOf, [{ id: cX, ids: [] }]));
    expect(await cell(buyer, r6)).toEqual(before);
    // is_empty: the same through emptying a cell.
    const empty = ordersRule({ field: buyer.id, operator: 'is_empty' }, 'editable');
    await failsWith('PERMISSION_DENIED', setCell(empty, ordersOf, [{ id: c1, ids: [] }]));
    expect((await cell(buyer, r1)).ids).toEqual([c1]);
  });

  it('self-link: writing r1.related = [r5] moves r5 out of `related_by is_empty` → RECORD_RULE_VIOLATION', async () => {
    const access = ordersRule({ field: relatedBy.id, operator: 'is_empty' });
    const before = await cell(relatedBy, r5);
    await failsWith('RECORD_RULE_VIOLATION', setCell(access, related, [{ id: r1, ids: [r5] }]));
    expect(await cell(relatedBy, r5)).toEqual(before);
    expect((await cell(related, r1)).ids).toEqual([]);
  });

  it('a rule that does not name the reverse field keeps S4 #6: the reverse write goes through', async () => {
    // r5 is outside the edit rule (amount is empty), yet c1.orders may link it.
    const access = ordersRule({ field: fx.fld.amount.id, operator: 'gt', value: 0 });
    await setCell(access, ordersOf, [{ id: c1, ids: [r1, r5] }]);
    expect((await cell(buyer, r5)).ids.sort()).toEqual([c1, c2].sort());
    await setCell(admin(), ordersOf, [{ id: c1, ids: [r1] }]);
  });

  it('a reverse write that stays in the rule goes through', async () => {
    const access = ordersRule({ field: buyer.id, operator: 'is_not_empty' });
    await setCell(access, ordersOf, [{ id: c2, ids: [r5, r1] }]);
    expect((await cell(buyer, r1)).ids.sort()).toEqual([c1, c2].sort());
    await setCell(access, ordersOf, [{ id: c2, ids: [r5] }]);
  });
});
