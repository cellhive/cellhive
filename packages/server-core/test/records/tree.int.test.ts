/**
 * Sub-records (BACKLOG T405, SPEC §5.7) on PostgreSQL 18: the `parent`
 * field and its `__parent_id` column, writes with cycle and depth checks,
 * the tree query, children/ancestors, deleting a parent (promote / whole
 * branch), trash and restore, P20, compaction and tenant isolation.
 */
import { performance } from 'node:perf_hooks';

import { newId, type Id } from '@cellhive/contracts';
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
import { assertTreeInvariants } from '../../src/records/tree/parent-writer.js';
import { SchemaService } from '../../src/schema/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';

import { accessOf, buildOrdersFixture, NOW, type OrdersFixture } from './fixtures.js';

import type { FieldRow } from '../../src/db/schema.js';

const ORG_A: Id<'org'> = 'org_T405TreeOrgAAAAA';
const ORG_B: Id<'org'> = 'org_T405TreeOrgBBBBB';

async function appError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected an AppError');
}

describe('sub-records (PostgreSQL 18)', () => {
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
  let parent: FieldRow;
  // A ─ B ─ C (sales2) ─ D ; E (sales2) ─ F. sales1 owns A, B, D, F.
  let a: Id<'rec'>, b: Id<'rec'>, c: Id<'rec'>, d: Id<'rec'>, e: Id<'rec'>;

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
  const owner = (user: 'u_sales1' | 'u_sales2') => [{ id: fx.users[user].id }];

  async function create(
    records: {
      title: string;
      owner?: 'u_sales1' | 'u_sales2';
      parent?: Id<'rec'> | null | undefined;
    }[],
    user: keyof OrdersFixture['users'] = 'u_admin',
  ): Promise<Id<'rec'>[]> {
    const out = await service.create(
      scope,
      fx.orders.id,
      as(user),
      {
        records: records.map((record) => ({
          fields: {
            title: record.title,
            ...(record.owner === undefined ? {} : { owner: owner(record.owner) }),
          },
          ...(record.parent === undefined ? {} : { parent_id: record.parent }),
        })),
      },
      auditOf(user),
    );
    return out.records.map((record) => record.id);
  }

  async function setParent(
    id: Id<'rec'>,
    to: Id<'rec'> | null,
    user: keyof OrdersFixture['users'] = 'u_admin',
  ) {
    return service.update(
      scope,
      fx.orders.id,
      as(user),
      { records: [{ id, fields: { parent: to } }] },
      auditOf(user),
    );
  }

  async function parentOf(id: Id<'rec'>): Promise<string | null> {
    const result = await admin.query<{ p: string | null }>(
      `SELECT __parent_id AS p FROM data.${pg.escapeIdentifier(fx.orders.db_table_name)} WHERE __id = $1`,
      [id],
    );
    return result.rows[0]?.p ?? null;
  }

  const titles = (records: readonly { fields: Record<string, unknown> }[]) =>
    records.map((record) => record.fields.title);

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
    parent = await schema.addField(
      scope,
      fx.orders.id,
      { name: 'parent', type: 'parent' },
      context,
    );
    const table = fx.schema.tables.find((candidate) => candidate.id === fx.orders.id);
    if (table === undefined) throw new Error('no orders');
    table.fields = [...table.fields, { id: parent.id, type: parent.type }];

    [a, e] = (await create([
      { title: 'A', owner: 'u_sales1' },
      { title: 'E', owner: 'u_sales2' },
    ])) as [Id<'rec'>, Id<'rec'>];
    [b] = (await create([{ title: 'B', owner: 'u_sales1', parent: a }])) as [Id<'rec'>];
    [c] = (await create([{ title: 'C', owner: 'u_sales2', parent: b }])) as [Id<'rec'>];
    [d] = (await create([{ title: 'D', owner: 'u_sales1', parent: c }])) as [Id<'rec'>];
    await create([{ title: 'F', owner: 'u_sales1', parent: e }]);
  });

  afterAll(async () => {
    await admin.end();
    await db.destroy();
    await database.drop();
  });

  describe('schema', () => {
    it('adds __parent_id with a self-reference ON DELETE SET NULL and an index', async () => {
      expect(parent).toMatchObject({ type: 'parent', db_column_name: null, options: {} });
      const table = fx.orders.db_table_name;
      const fk = await admin.query<{ conname: string; def: string }>(
        `SELECT conname, pg_get_constraintdef(c.oid) AS def
           FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
          WHERE t.relname = $1 AND contype = 'f'`,
        [table],
      );
      expect(fk.rows).toEqual([
        {
          conname: `${table}_parent_fkey`,
          def: `FOREIGN KEY (__parent_id) REFERENCES data.${table}(__id) ON DELETE SET NULL`,
        },
      ]);
      const indexes = await admin.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE tablename = $1 AND indexname LIKE '%parent%'`,
        [table],
      );
      expect(indexes.rows.map((row) => row.indexname)).toEqual([`${table}_parent_idx`]);
      expect(await schema.checkConsistency(scope, fx.orders.id)).toEqual([]);
    });

    it('allows one parent field per table, never unique nor required', async () => {
      const twice = await appError(
        schema.addField(scope, fx.orders.id, { name: 'again', type: 'parent' }, context),
      );
      expect(twice.code).toBe('VALIDATION_FAILED');
      expect(twice.errors?.[0]).toMatchObject({
        code: 'SUBRECORDS_ALREADY_ENABLED',
        params: { field_id: parent.id, deleted: false },
      });
      const required = await appError(
        schema.addField(
          scope,
          fx.customers.id,
          { name: 'p', type: 'parent', required: true, uniqueValues: true },
          context,
        ),
      );
      expect(required.errors?.map((item) => item.code)).toEqual([
        'UNIQUE_NOT_SUPPORTED',
        'REQUIRED_NOT_SUPPORTED',
      ]);
      const options = await appError(
        schema.addField(
          scope,
          fx.customers.id,
          { name: 'p', type: 'parent', options: { link_table: fx.orders.id } },
          context,
        ),
      );
      expect(options.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('reads', () => {
    it('reads the parent as { id, title }, text as the title', async () => {
      const record = await query.getRecord(scope, fx.orders.id, b, as('u_admin'));
      expect(record.fields.parent).toEqual({ id: a, title: 'A' });
      expect(
        (await query.getRecord(scope, fx.orders.id, a, as('u_admin'))).fields.parent,
      ).toBeNull();
      const text = await query.getRecord(scope, fx.orders.id, b, as('u_admin'), {
        cell_format: 'text',
        fields: ['parent'],
      });
      expect(text.fields).toEqual({ parent: 'A' });
    });

    it('P20: an unreadable parent keeps its id without title', async () => {
      const record = await query.getRecord(scope, fx.orders.id, d, as('u_sales1'));
      expect(record.fields.parent).toEqual({ id: c, title: null });
    });

    it('cannot be sorted on', async () => {
      const error = await appError(
        query.query(scope, fx.orders.id, as('u_admin'), { sort: [{ field: 'parent' }] }),
      );
      expect(error.code).toBe('INVALID_SORT');
      expect(error.errors?.[0]?.code).toBe('FIELD_NOT_SORTABLE');
    });
  });

  describe('writes', () => {
    it('accepts a title with typecast and refuses an unknown or unreadable parent alike', async () => {
      const [x] = await create([{ title: 'X' }]);
      const cast = await service.update(
        scope,
        fx.orders.id,
        as('u_admin'),
        { typecast: true, records: [{ id: x as string, fields: { parent: 'E' } }] },
        auditOf('u_admin'),
      );
      expect(cast.records[0]?.fields.parent).toEqual({ id: e, title: 'E' });
      // sales1 cannot read C: same answer as a missing record.
      for (const target of [c, 'rec_0000000000000000']) {
        const error = await appError(
          service.create(
            scope,
            fx.orders.id,
            as('u_sales1'),
            { records: [{ fields: { title: 'Y', owner: owner('u_sales1') }, parent_id: target }] },
            auditOf('u_sales1'),
          ),
        );
        expect(error.code).toBe('LINK_TARGET_NOT_FOUND');
        expect(error.errors?.[0]?.path).toBe('records[0].parent_id');
      }
      await service.delete(
        scope,
        fx.orders.id,
        as('u_admin'),
        { ids: [x as string] },
        auditOf('u_admin'),
      );
    });

    it('refuses parent_id together with the parent field, and on a table without sub-records', async () => {
      const both = await appError(
        service.create(
          scope,
          fx.orders.id,
          as('u_admin'),
          { records: [{ fields: { title: 'Z', parent: a }, parent_id: a }] },
          auditOf('u_admin'),
        ),
      );
      expect(both.errors?.[0]).toMatchObject({ code: 'NOT_ALLOWED', path: 'records[0].parent_id' });
      const none = await appError(
        service.create(
          scope,
          fx.customers.id,
          as('u_admin'),
          { records: [{ fields: { name: 'Z' }, parent_id: a }] },
          auditOf('u_admin'),
        ),
      );
      expect(none.errors?.[0]?.code).toBe('SUBRECORDS_NOT_ENABLED');
    });

    it('refuses a cycle', async () => {
      for (const target of [a, d]) {
        const error = await appError(setParent(a, target));
        expect(error.code).toBe('SUBRECORD_CYCLE');
        expect(error.errors?.[0]).toMatchObject({
          code: 'SUBRECORD_CYCLE',
          path: 'records[0].fields.parent',
        });
      }
      // Two moves of one request that close a loop together.
      const [p, q] = await create([{ title: 'P' }, { title: 'Q' }]);
      const loop = await appError(
        service.update(
          scope,
          fx.orders.id,
          as('u_admin'),
          {
            records: [
              { id: p as string, fields: { parent: q } },
              { id: q as string, fields: { parent: p } },
            ],
          },
          auditOf('u_admin'),
        ),
      );
      expect(loop.code).toBe('SUBRECORD_CYCLE');
      expect(await parentOf(a)).toBeNull();
      await service.delete(
        scope,
        fx.orders.id,
        as('u_admin'),
        { ids: [p as string, q as string] },
        auditOf('u_admin'),
      );
    });

    it('allows 10 levels, refuses level 11 (new record or moved branch), checks fast', async () => {
      const chain: Id<'rec'>[] = [];
      let up: Id<'rec'> | null = null;
      for (let level = 1; level <= 10; level += 1) {
        const [id]: Id<'rec'>[] = await create([{ title: `L${String(level)}`, parent: up }]);
        chain.push(id as Id<'rec'>);
        up = id as Id<'rec'>;
      }
      const deep = await appError(create([{ title: 'L11', parent: up }]));
      expect(deep.code).toBe('SUBRECORD_TOO_DEEP');
      expect(deep.errors?.[0]).toMatchObject({
        params: { limit: 10 },
        path: 'records[0].parent_id',
      });
      // A branch of 2 levels fits under level 8, not under level 9.
      const [top] = await create([{ title: 'T1' }]);
      await create([{ title: 'T2', parent: top }]);
      await setParent(top as Id<'rec'>, chain[7] as Id<'rec'>);
      const moved = await appError(setParent(top as Id<'rec'>, chain[8] as Id<'rec'>));
      expect(moved.code).toBe('SUBRECORD_TOO_DEEP');

      // The checks on a 10-level tree take well under 50 ms.
      const leaf = chain[9] as Id<'rec'>;
      const root = chain[0] as Id<'rec'>;
      const timings: number[] = [];
      for (let run = 0; run < 20; run += 1) {
        await db.withTx(async (tx) => {
          const started = performance.now();
          await assertTreeInvariants(tx, fx.orders, [leaf, root], () => 'x');
          timings.push(performance.now() - started);
        });
      }
      timings.sort((x, y) => x - y);
      // Clean up before asserting the timing: a slow run on a loaded machine
      // must not leave L1…L10 behind for the tests that follow.
      await service.delete(
        scope,
        fx.orders.id,
        as('u_admin'),
        { ids: [root, top as string], children: 'delete' },
        auditOf('u_admin'),
      );
      // Generous bound so a loaded CI machine does not fail the suite; on an
      // idle machine the p95 is well under 50 ms (T405 report).
      expect(timings[Math.floor(timings.length * 0.95)]).toBeLessThan(250);
    });

    it('audits a reparent as an update of the parent field, published with { id, title }', async () => {
      const [x] = await create([{ title: 'X2' }]);
      published.length = 0;
      await setParent(x as Id<'rec'>, a);
      const result = await admin.query<{ after: unknown; before: unknown }>(
        `SELECT before, after FROM meta.audit_logs WHERE entity_id = $1 AND action = 'record.updated'`,
        [x],
      );
      expect(result.rows).toEqual([{ before: { [parent.id]: null }, after: { [parent.id]: a } }]);
      const change = published.at(-1)?.changes[0];
      expect(change?.changedFieldIds).toContain(parent.id);
      expect(change?.values[parent.id]).toEqual({ id: a, title: 'A' });
      expect(published.at(-1)?.links).toContainEqual({
        id: parent.id,
        tableId: fx.orders.id,
        titleFieldId: fx.fld.title.id,
      });
      await service.delete(
        scope,
        fx.orders.id,
        as('u_admin'),
        { ids: [x as string] },
        auditOf('u_admin'),
      );
    });
  });

  describe('tree query', () => {
    it('pages roots and expands a branch, counting children the reader sees', async () => {
      const roots = await query.tree(scope, fx.orders.id, as('u_admin'), { fields: ['title'] });
      expect(titles(roots.records)).toEqual(['A', 'E']);
      expect(roots.records.map((record) => record.tree)).toEqual([
        { parent_id: null, depth: 0, children_count: 1, ancestor_only: false },
        { parent_id: null, depth: 0, children_count: 1, ancestor_only: false },
      ]);
      expect('total' in roots && roots.total).toBe(2);
      const branch = await query.tree(scope, fx.orders.id, as('u_admin'), {
        parent_id: c,
        fields: ['title'],
      });
      expect(titles(branch.records)).toEqual(['D']);
      expect(branch.records[0]?.tree).toEqual({
        parent_id: c,
        depth: 3,
        children_count: 0,
        ancestor_only: false,
      });
    });

    it('u_sales1: unreadable records never appear; their readable children show as roots', async () => {
      const roots = await query.tree(scope, fx.orders.id, as('u_sales1'), { fields: ['title'] });
      expect(titles(roots.records)).toEqual(['A', 'D', 'F']);
      const underB = await query.tree(scope, fx.orders.id, as('u_sales1'), { parent_id: a });
      expect(titles(underB.records)).toEqual(['B']);
      expect(underB.records[0]?.tree.children_count).toBe(0);
      const hidden = await appError(
        query.tree(scope, fx.orders.id, as('u_sales1'), { parent_id: c }),
      );
      expect(hidden.code).toBe('NOT_FOUND');
    });

    it('with a filter, shows matches with their ancestors flagged ancestor_only', async () => {
      const filter = { op: 'and', items: [{ field: fx.fld.title.id, operator: 'eq', value: 'C' }] };
      const roots = await query.tree(scope, fx.orders.id, as('u_admin'), { filter });
      expect(titles(roots.records)).toEqual(['A']);
      expect(roots.records[0]?.tree).toMatchObject({ ancestor_only: true, children_count: 1 });
      const level2 = await query.tree(scope, fx.orders.id, as('u_admin'), { filter, parent_id: a });
      expect(titles(level2.records)).toEqual(['B']);
      expect(level2.records[0]?.tree).toMatchObject({ ancestor_only: true, depth: 1 });
      const level3 = await query.tree(scope, fx.orders.id, as('u_admin'), { filter, parent_id: b });
      expect(titles(level3.records)).toEqual(['C']);
      expect(level3.records[0]?.tree).toEqual({
        parent_id: b,
        depth: 2,
        ancestor_only: false,
        children_count: 0,
      });
      const flat = await query.tree(scope, fx.orders.id, as('u_admin'), {
        filter,
        show_ancestors: false,
      });
      expect(titles(flat.records)).toEqual(['C']);
      expect(flat.records[0]?.tree.ancestor_only).toBe(false);
    });

    it('children and ancestors respect read rules', async () => {
      const children = await query.children(scope, fx.orders.id, b, as('u_admin'), {
        fields: ['title'],
      });
      expect(titles(children.records)).toEqual(['C']);
      expect((await query.children(scope, fx.orders.id, b, as('u_sales1'))).records).toEqual([]);
      expect((await appError(query.children(scope, fx.orders.id, c, as('u_sales1')))).code).toBe(
        'NOT_FOUND',
      );
      expect((await query.ancestors(scope, fx.orders.id, d, as('u_sales1'))).items).toEqual([
        { id: a, title: 'A', locked: false },
        { id: b, title: 'B', locked: false },
        { id: null, title: null, locked: true },
      ]);
      expect((await query.ancestors(scope, fx.orders.id, a, as('u_admin'))).items).toEqual([]);
    });

    it('refuses tree reads on a table without sub-records (422) and other tenants (404)', async () => {
      const none = await appError(query.tree(scope, fx.customers.id, as('u_admin')));
      expect(none.errors?.[0]?.code).toBe('SUBRECORDS_NOT_ENABLED');
      const fxB = await buildOrdersFixture(db, schema, ORG_B);
      const other = await appError(
        query.tree(orgScope(ORG_B), fx.orders.id, accessOf(fxB, 'u_admin')),
      );
      expect(other.code).toBe('NOT_FOUND');
      const cross = await appError(
        query.children(orgScope(ORG_B), fx.orders.id, b, accessOf(fxB, 'u_admin')),
      );
      expect(cross.code).toBe('NOT_FOUND');
    });
  });

  describe('deleting a parent', () => {
    it('promotes the children to roots by default; restoring the parent does not re-attach them', async () => {
      const [p] = await create([{ title: 'PP' }]);
      const [k1, k2] = await create([
        { title: 'K1', parent: p },
        { title: 'K2', parent: p },
      ]);
      const audit = auditOf('u_admin');
      await service.delete(scope, fx.orders.id, as('u_admin'), { ids: [p as string] }, audit);
      expect(await parentOf(k1 as Id<'rec'>)).toBeNull();
      expect(await parentOf(k2 as Id<'rec'>)).toBeNull();
      const rows = await admin.query<{ action: string; entity_id: string; batch_id: string }>(
        `SELECT action, entity_id, batch_id FROM meta.audit_logs WHERE batch_id = $1 ORDER BY action, entity_id`,
        [audit.batch_id],
      );
      expect(rows.rows.map((row) => row.action).sort()).toEqual([
        'record.deleted',
        'record.updated',
        'record.updated',
      ]);
      await service.restore(
        scope,
        fx.orders.id,
        as('u_admin'),
        { ids: [p as string] },
        auditOf('u_admin'),
      );
      expect(await parentOf(k1 as Id<'rec'>)).toBeNull();
      await service.delete(
        scope,
        fx.orders.id,
        as('u_admin'),
        { ids: [p as string, k1 as string, k2 as string] },
        auditOf('u_admin'),
      );
    });

    it('"delete whole branch" trashes it with one batch_id; the trash offers it back together', async () => {
      const [x] = await create([{ title: 'BX', owner: 'u_sales1' }]);
      const [y] = await create([{ title: 'BY', owner: 'u_sales1', parent: x }]);
      const [z] = await create([{ title: 'BZ', owner: 'u_sales1', parent: y }]);
      const audit = auditOf('u_admin');
      const deleted = await service.delete(
        scope,
        fx.orders.id,
        as('u_admin'),
        { ids: [x as string], children: 'delete' },
        audit,
      );
      expect(deleted.ids).toEqual([x, y, z]);
      const rows = await admin.query<{ entity_id: string }>(
        `SELECT entity_id FROM meta.audit_logs WHERE batch_id = $1 AND action = 'record.deleted' ORDER BY entity_id`,
        [audit.batch_id],
      );
      expect(rows.rows.map((row) => row.entity_id).sort()).toEqual([x, y, z].sort());
      const trash = await query.listTrash(scope, fx.orders.id, as('u_admin'));
      const inTrash = trash.records.find((record) => record.id === x);
      expect(inTrash?.branch_size).toBe(2);
      expect(trash.records.find((record) => record.id === y)?.branch_size).toBe(1);

      const restored = await service.restore(
        scope,
        fx.orders.id,
        as('u_admin'),
        { ids: [x as string], branch: true },
        auditOf('u_admin'),
      );
      expect(titles(restored.records)).toEqual(['BX', 'BY', 'BZ']);
      expect(await parentOf(z as Id<'rec'>)).toBe(y);
      await service.delete(
        scope,
        fx.orders.id,
        as('u_admin'),
        { ids: [x as string], children: 'delete' },
        auditOf('u_admin'),
      );
    });

    it('a branch stops at a descendant the caller cannot delete: it becomes a root', async () => {
      // sales1 owns A and B but not C: deleting A's branch keeps C (promoted) and D below it.
      const [x] = await create([{ title: 'SX', owner: 'u_sales1' }]);
      const [y] = await create([{ title: 'SY', owner: 'u_sales2', parent: x }]);
      const [z] = await create([{ title: 'SZ', owner: 'u_sales1', parent: y }]);
      const sales = new RecordMutationService(db, { schema, query, now: () => NOW });
      await sales.delete(
        scope,
        fx.orders.id,
        { ...as('u_sales1'), resolved: withDelete(as('u_sales1').resolved, fx.orders.id) },
        { ids: [x as string], children: 'delete' },
        auditOf('u_sales1'),
      );
      expect(await parentOf(y as Id<'rec'>)).toBeNull();
      expect(await parentOf(z as Id<'rec'>)).toBe(y);
      const live = await query.getRecords(
        scope,
        fx.orders.id,
        [x as string, y as string, z as string],
        as('u_admin'),
      );
      expect(titles(live)).toEqual(['SY', 'SZ']);
      await service.delete(
        scope,
        fx.orders.id,
        as('u_admin'),
        { ids: [y as string], children: 'delete' },
        auditOf('u_admin'),
      );
    });
  });

  describe('compaction and turning sub-records off', () => {
    it('keeps __parent_id, its index and self-reference through compaction', async () => {
      await schema.compactTable(scope, fx.orders.id);
      expect(await schema.checkConsistency(scope, fx.orders.id)).toEqual([]);
      expect(await parentOf(d)).toBe(c);
      expect((await query.getRecord(scope, fx.orders.id, b, as('u_admin'))).fields.parent).toEqual({
        id: a,
        title: 'A',
      });
    });

    it('deleting the parent field hides the tree; restoring it brings it back', async () => {
      await schema.deleteField(scope, parent.id, context);
      expect(await schema.checkConsistency(scope, fx.orders.id)).toEqual([]);
      const off = await appError(query.tree(scope, fx.orders.id, as('u_admin')));
      expect(off.errors?.[0]?.code).toBe('SUBRECORDS_NOT_ENABLED');
      const again = await appError(
        schema.addField(scope, fx.orders.id, { name: 'p2', type: 'parent' }, context),
      );
      expect(again.errors?.[0]?.params).toMatchObject({ field_id: parent.id, deleted: true });
      await schema.restoreField(scope, parent.id, context);
      expect(await parentOf(d)).toBe(c);
      const roots = await query.tree(scope, fx.orders.id, as('u_admin'));
      expect(titles(roots.records)).toEqual(['A', 'E']);
    });
  });
});

/** The access with the `delete` operation added on `tableId` (sales may only add in the fixture). */
function withDelete(
  resolved: RecordAccessContext['resolved'],
  tableId: Id<'tbl'>,
): RecordAccessContext['resolved'] {
  const table = resolved.access.tables[tableId];
  if (table === undefined) throw new Error('no table access');
  return {
    ...resolved,
    access: {
      ...resolved.access,
      tables: {
        ...resolved.access.tables,
        [tableId]: { ...table, operations: [...table.operations, 'delete'] },
      },
    },
  };
}
