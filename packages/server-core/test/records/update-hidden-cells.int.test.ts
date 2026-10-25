/**
 * Updates of records outside the caller's read scope (AGENTS.md rule 4): the
 * link/parent value checks must not consult the hidden record's current
 * cells, or the error code (404 vs 422) reveals its parent and links.
 */
import { newId, type Id } from '@cellhive/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemAuditContext, type AuditContext } from '../../src/audit/index.js';
import { orgScope, type Db } from '../../src/db/index.js';
import { AppError } from '../../src/errors/index.js';
import { RecordMutationService, RecordQueryService } from '../../src/records/index.js';
import { SchemaService } from '../../src/schema/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';

import { accessOf, buildOrdersFixture, NOW, type OrdersFixture } from './fixtures.js';

const ORG: Id<'org'> = 'org_HiddenCellsAAAAA';

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'OK';
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return [error.code, ...(error.errors ?? []).map((item) => item.code)].join(':');
  }
}

describe('update of records the caller cannot read', () => {
  let database: TestDatabase;
  let db: Db;
  let schema: SchemaService;
  let service: RecordMutationService;
  let fx: OrdersFixture;
  const scope = orgScope(ORG);
  const context = systemAuditContext();
  const auditOf = (user: keyof OrdersFixture['users']): AuditContext => {
    const request = newId('req');
    return {
      actor: { type: 'user', id: fx.users[user].id },
      via: null,
      batch_id: request,
      request_id: request,
      ip: null,
      user_agent: 'vitest',
    };
  };

  let parentKey: string;
  let relKey: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    const query = new RecordQueryService(db, { now: () => NOW });
    service = new RecordMutationService(db, { schema, query, now: () => NOW });
    fx = await buildOrdersFixture(db, schema, ORG);
    const parent = await schema.addField(
      scope,
      fx.orders.id,
      { name: 'parent', type: 'parent' },
      context,
    );
    const rel = await schema.addField(
      scope,
      fx.orders.id,
      { name: 'rel', type: 'link', options: { link_table: fx.orders.id } },
      context,
    );
    const table = fx.schema.tables.find((item) => item.id === fx.orders.id);
    if (table === undefined) throw new Error('orders table missing');
    table.fields = [
      ...table.fields,
      { id: parent.id, type: parent.type },
      { id: rel.id, type: rel.type },
    ];
    parentKey = 'parent';
    relKey = 'rel';
  });

  afterAll(async () => {
    await db.destroy();
    await database.drop();
  });

  const owner = (user: 'u_sales1' | 'u_sales2') => [{ id: fx.users[user].id }];
  const make = async (fields: Record<string, unknown>, parentId?: string): Promise<Id<'rec'>> => {
    const result = await service.create(
      scope,
      fx.orders.id,
      accessOf(fx, 'u_admin'),
      { records: [{ fields, ...(parentId === undefined ? {} : { parent_id: parentId }) }] },
      auditOf('u_admin'),
    );
    return result.records[0]?.id as Id<'rec'>;
  };
  const update = (records: { id: string; fields: Record<string, unknown> }[]) =>
    codeOf(
      service.update(
        scope,
        fx.orders.id,
        accessOf(fx, 'u_sales1'),
        { records },
        auditOf('u_sales1'),
      ),
    );

  it('answers the same whether or not the hidden record holds the target', async () => {
    // E, A, G: sales2's (hidden from sales1); G's parent is E and links to E.
    const e = await make({ title: 'E', owner: owner('u_sales2') });
    const a = await make({ title: 'A', owner: owner('u_sales2') });
    const g = await make({ title: 'G', owner: owner('u_sales2'), [relKey]: [e] }, e);

    const parentIsE = await update([{ id: g, fields: { [parentKey]: e } }]);
    const parentIsA = await update([{ id: g, fields: { [parentKey]: a } }]);
    const relHasE = await update([{ id: g, fields: { [relKey]: [e] } }]);
    const relHasA = await update([{ id: g, fields: { [relKey]: [a] } }]);
    expect(parentIsE).toBe(parentIsA);
    expect(relHasE).toBe(relHasA);
    expect(parentIsE).toBe('LINK_TARGET_NOT_FOUND:LINK_TARGET_NOT_FOUND');
    expect(relHasE).toBe('LINK_TARGET_NOT_FOUND:LINK_TARGET_NOT_FOUND');

    // A readable target passes the value checks; the hidden record is a 404.
    const mine = await make({ title: 'M', owner: owner('u_sales1') });
    expect(await update([{ id: g, fields: { [parentKey]: mine } }])).toBe('NOT_FOUND:NOT_FOUND');
    expect(await update([{ id: g, fields: { [relKey]: [mine] } }])).toBe('NOT_FOUND:NOT_FOUND');
  });

  it('still lets an editable record keep an unreadable parent and link (P20)', async () => {
    const hidden = await make({ title: 'H', owner: owner('u_sales2') });
    const own = await make({ title: 'O', owner: owner('u_sales1'), [relKey]: [hidden] }, hidden);
    expect(await update([{ id: own, fields: { [parentKey]: hidden, [relKey]: [hidden] } }])).toBe(
      'OK',
    );
    // Mixed with a hidden record holding the same cells: that record is a 404.
    const other = await make({ title: 'X', owner: owner('u_sales2'), [relKey]: [hidden] }, hidden);
    expect(
      await update([
        { id: own, fields: { [parentKey]: hidden } },
        { id: other, fields: { [parentKey]: hidden } },
      ]),
    ).toBe('LINK_TARGET_NOT_FOUND:LINK_TARGET_NOT_FOUND');
  });
});
