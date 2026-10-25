/**
 * RecordQueryService through saved views (BACKLOG T302; SPEC §7.1–7.2,
 * CONTRACTS §1.4, §15): who may read through which view, view filter AND
 * request filter, ORDER BY group → view sort → request sort, conditions on
 * unreadable and deleted fields, the share-link scope, and group counts.
 */
import { newId, type Id, type StoredViewConfig, type ViewType } from '@cellhive/contracts';
import { resolveShareLinkAccess, type FilterNode } from '@cellhive/permissions';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { orgScope, type Db } from '../../src/db/index.js';
import { AppError } from '../../src/errors/index.js';
import {
  RecordQueryService,
  type RecordAccessContext,
  type RecordListOutput,
} from '../../src/records/index.js';
import { SchemaService } from '../../src/schema/index.js';
import { configJson, defaultViewConfig, ViewsRepository } from '../../src/views/index.js';
import {
  createTestDatabase,
  createTestDb,
  migrateAll,
  type TestDatabase,
} from '../support/postgres.js';

import { accessOf, buildOrdersFixture, insertRows, NOW, type OrdersFixture } from './fixtures.js';

import type { FieldRow } from '../../src/db/schema.js';

const ORG: Id<'org'> = 'org_T302ViewQueryOrg';

async function appError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected an AppError');
}

const ids = (list: RecordListOutput) => list.records.map((record) => record.id);

describe('RecordQueryService through views (T302)', () => {
  let database: TestDatabase;
  let db: Db;
  let pool: pg.Pool;
  let service: RecordQueryService;
  let views: ViewsRepository;
  let fx: OrdersFixture;
  const scope = orgScope(ORG);
  let r1: Id<'rec'>, r2: Id<'rec'>, r3: Id<'rec'>, r4: Id<'rec'>, r5: Id<'rec'>;
  let customersView: Id<'viw'>;

  beforeAll(async () => {
    database = await createTestDatabase();
    db = createTestDb(database.url);
    await migrateAll(database.url, db);
    pool = new pg.Pool({ connectionString: database.url, max: 4 });
    const schema = new SchemaService(db, { maxFieldsPerTable: 500 });
    service = new RecordQueryService(db, { now: () => NOW });
    views = new ViewsRepository(db);
    fx = await buildOrdersFixture(db, schema, ORG);

    const { title, amount, cost, status, owner } = fx.fld;
    const col = (field: FieldRow) => field.db_column_name as string;
    [r1, r2, r3, r4, r5] = (await insertRows(pool, fx.orders, [
      {
        [col(title)]: 'r1',
        [col(amount)]: '1500000',
        [col(cost)]: '1000000',
        [col(status)]: [fx.opt.new],
        [col(owner)]: [fx.users.u_sales1.id],
      },
      {
        [col(title)]: 'r2',
        [col(amount)]: '200',
        [col(cost)]: '100',
        [col(status)]: [fx.opt.done],
        [col(owner)]: [fx.users.u_sales2.id],
      },
      { [col(title)]: 'r3', [col(amount)]: '1500000', [col(cost)]: '5' },
      { [col(title)]: 'r4', [col(amount)]: '200', [col(status)]: [fx.opt.new] },
      { [col(title)]: 'r5', [col(amount)]: null, [col(status)]: [fx.opt.done] },
    ])) as [Id<'rec'>, Id<'rec'>, Id<'rec'>, Id<'rec'>, Id<'rec'>];
    customersView = (await views.listByTable(scope, fx.customers.id, null))[0]?.id as Id<'viw'>;
  });

  afterAll(async () => {
    await pool.end();
    await db.destroy();
    await database.drop();
  });

  /** TEST FIXTURE: a view row written straight through the repository (config not validated). */
  async function view(
    config: Partial<StoredViewConfig> = {},
    options: { type?: ViewType; ownerId?: Id<'usr'> | null } = {},
  ): Promise<Id<'viw'>> {
    const type = options.type ?? 'grid';
    const row = await views.insert(scope, {
      id: newId('viw'),
      tableId: fx.orders.id,
      type,
      name: `v ${newId('viw')}`,
      config: configJson({ ...defaultViewConfig(type), ...config }),
      position: 9,
      ownerId: options.ownerId ?? null,
    });
    return row.id;
  }

  const statusIs = (option: Id<'opt'>) => ({
    field: fx.fld.status.id,
    operator: 'is',
    value: option,
  });

  /** u_reader without read access to `cost` (field perm `no_perm`). */
  function readerWithoutCost(): RecordAccessContext {
    const access = accessOf(fx, 'u_reader');
    const orders = access.resolved.access.tables[fx.orders.id];
    if (orders === undefined) throw new Error('u_reader cannot read Orders');
    const fields = Object.fromEntries(
      Object.entries(orders.fields).filter(([id]) => id !== fx.fld.cost.id),
    );
    return {
      ...access,
      resolved: {
        ...access.resolved,
        access: {
          ...access.resolved.access,
          tables: { ...access.resolved.access.tables, [fx.orders.id]: { ...orders, fields } },
        },
      },
    };
  }

  function withVisibleViews(
    access: RecordAccessContext,
    visible: Id<'viw'>[] | null,
  ): RecordAccessContext {
    const orders = access.resolved.access.tables[fx.orders.id];
    if (orders === undefined) throw new Error('no access to Orders');
    return {
      ...access,
      resolved: {
        ...access.resolved,
        access: {
          ...access.resolved.access,
          tables: {
            ...access.resolved.access.tables,
            [fx.orders.id]: { ...orders, view_rule: { allow_edit: false, visible_views: visible } },
          },
        },
      },
    };
  }

  describe('which views a caller reads through (P16)', () => {
    it('hidden, missing, malformed, other-table and others’ personal views are all NOT_FOUND alike', async () => {
      const shown = await view();
      const hidden = await view();
      const personal = await view({}, { ownerId: fx.users.u_editor.id });
      const reader = withVisibleViews(accessOf(fx, 'u_reader'), [shown]);
      const requestId = newId('req');
      const problems = [];
      for (const viewId of [hidden, newId('viw'), 'nope', customersView, personal]) {
        const error = await appError(
          service.query(scope, fx.orders.id, reader, { view_id: viewId }),
        );
        expect(error.code).toBe('NOT_FOUND');
        problems.push({ ...error.toProblem(requestId), detail: error.detail });
      }
      expect(new Set(problems.map((problem) => JSON.stringify(problem))).size).toBe(1);
      // The view is checked before the request: an invalid filter still answers 404.
      const first = await appError(
        service.query(scope, fx.orders.id, reader, { view_id: hidden, filter: { nope: 1 } }),
      );
      expect(first.code).toBe('NOT_FOUND');

      expect(ids(await service.query(scope, fx.orders.id, reader, { view_id: shown }))).toEqual([
        r1,
        r2,
        r3,
        r4,
        r5,
      ]);
      // The owner reads through their personal view, which `visible_views` never hides.
      const editor = withVisibleViews(accessOf(fx, 'u_editor'), []);
      expect(
        ids(await service.query(scope, fx.orders.id, editor, { view_id: personal })),
      ).toHaveLength(5);
      // Anonymous readers own no personal view.
      const anonymous = { ...accessOf(fx, 'u_editor'), userId: null };
      expect(
        (await appError(service.query(scope, fx.orders.id, anonymous, { view_id: personal }))).code,
      ).toBe('NOT_FOUND');
    });

    it('P16: u_sales1 reads through the Sales view only its r1', async () => {
      const sales = await view({ sort: [{ field: fx.fld.amount.id, direction: 'desc' }] });
      const all = await view();
      const access = withVisibleViews(accessOf(fx, 'u_sales1'), [sales]);
      expect(ids(await service.query(scope, fx.orders.id, access, { view_id: sales }))).toEqual([
        r1,
      ]);
      expect(
        (await appError(service.query(scope, fx.orders.id, access, { view_id: all }))).code,
      ).toBe('NOT_FOUND');
    });
  });

  describe('WHERE and ORDER BY', () => {
    it('ANDs the view filter with the request filter: a request cannot widen the view', async () => {
      const onlyNew = await view({ filter: { op: 'and', items: [statusIs(fx.opt.new)] } });
      const access = accessOf(fx, 'u_reader');
      expect(ids(await service.query(scope, fx.orders.id, access, { view_id: onlyNew }))).toEqual([
        r1,
        r4,
      ]);
      // The opposite condition: nothing, not the records the view leaves out.
      const opposite = await service.query(scope, fx.orders.id, access, {
        view_id: onlyNew,
        filter: {
          op: 'or',
          items: [statusIs(fx.opt.done), { field: fx.fld.status.id, operator: 'is_empty' }],
        },
      });
      expect(ids(opposite)).toEqual([]);
      expect(opposite).toMatchObject({ total: 0 });
      const narrower = await service.query(scope, fx.orders.id, access, {
        view_id: onlyNew,
        filter: { logic: 'and', conditions: [['amount', '==', 200]] },
      });
      expect(ids(narrower)).toEqual([r4]);
      // The same filter via GET-style parameters goes the same way (search too).
      const searched = await service.query(scope, fx.orders.id, access, {
        view_id: onlyNew,
        search: 'r4',
      });
      expect(ids(searched)).toEqual([r4]);
    });

    it('resolves current_user of the view filter for the caller', async () => {
      const mine = await view({
        filter: {
          op: 'and',
          items: [
            { field: fx.fld.owner.id, operator: 'has_any_of', value: [{ $var: 'current_user' }] },
          ],
        },
      });
      const as = (userId: Id<'usr'>) => ({ ...accessOf(fx, 'u_admin'), userId });
      expect(
        ids(await service.query(scope, fx.orders.id, as(fx.users.u_sales1.id), { view_id: mine })),
      ).toEqual([r1]);
      expect(
        ids(await service.query(scope, fx.orders.id, as(fx.users.u_sales2.id), { view_id: mine })),
      ).toEqual([r2]);
    });

    it('orders by view group → view sort → request sort → creation, empty cells last', async () => {
      const grouped = await view({
        group: [{ field: fx.fld.status.id, direction: 'desc' }],
        sort: [{ field: fx.fld.amount.id, direction: 'asc' }],
      });
      const access = accessOf(fx, 'u_reader');
      // status desc by option order: Xong (r2 200, r5 empty), Mới (r4 200, r1 1.5M), empty (r3).
      expect(ids(await service.query(scope, fx.orders.id, access, { view_id: grouped }))).toEqual([
        r2,
        r5,
        r4,
        r1,
        r3,
      ]);
      // The request sort only breaks ties left by the view.
      const tieBreak = await service.query(scope, fx.orders.id, access, {
        view_id: grouped,
        sort: [{ field: 'title', direction: 'desc' }],
      });
      expect(ids(tieBreak)).toEqual([r2, r5, r4, r1, r3]);
      // A request group replaces the view's; [] removes grouping.
      const byAmount = await service.query(scope, fx.orders.id, access, {
        view_id: grouped,
        group: [{ field: 'amount', direction: 'desc' }],
      });
      expect(ids(byAmount)).toEqual([r1, r3, r2, r4, r5]);
      const ungrouped = await service.query(scope, fx.orders.id, access, {
        view_id: grouped,
        group: [],
      });
      expect(ids(ungrouped)).toEqual([r2, r4, r1, r3, r5]);
    });

    it('reads through a form view like any view', async () => {
      const form = await view({}, { type: 'form' });
      const list = await service.query(scope, fx.orders.id, accessOf(fx, 'u_reader'), {
        view_id: form,
      });
      expect(ids(list)).toEqual([r1, r2, r3, r4, r5]);
    });

    it('does not narrow the fields of a member read to the visible columns', async () => {
      const hiding = await view({ hidden_fields: [fx.fld.amount.id] });
      const list = await service.query(scope, fx.orders.id, accessOf(fx, 'u_reader'), {
        view_id: hiding,
      });
      expect(list.records[0]?.fields).toHaveProperty('amount');
    });
  });

  describe('fields the caller cannot read (BACKLOG S3 decision 3)', () => {
    it('saved filter and sort on them still apply; request filter/sort/group on them are 422', async () => {
      const costly = await view({
        filter: { op: 'and', items: [{ field: fx.fld.cost.id, operator: 'gt', value: 50 }] },
        sort: [{ field: fx.fld.cost.id, direction: 'asc' }],
      });
      const access = readerWithoutCost();
      const list = await service.query(scope, fx.orders.id, access, { view_id: costly });
      expect(ids(list)).toEqual([r2, r1]);
      expect(list.records[0]?.fields).not.toHaveProperty('cost');

      const filter = await appError(
        service.query(scope, fx.orders.id, access, {
          view_id: costly,
          filter: { logic: 'and', conditions: [['cost', '>', 1]] },
        }),
      );
      expect(filter.code).toBe('INVALID_FILTER');
      expect(filter.errors?.[0]).toMatchObject({ code: 'UNKNOWN_FIELD' });
      const sort = await appError(
        service.query(scope, fx.orders.id, access, { view_id: costly, sort: [{ field: 'cost' }] }),
      );
      expect(sort.code).toBe('INVALID_SORT');
      const group = await appError(
        service.query(scope, fx.orders.id, access, { view_id: costly, group: [{ field: 'cost' }] }),
      );
      expect(group.code).toBe('INVALID_SORT');
      expect(group.errors).toEqual([
        { path: 'group[0].field', code: 'UNKNOWN_FIELD', message: 'Field does not exist' },
      ]);
    });
  });

  describe('temporary filter and sort: filter_mode / sort_mode replace (T311)', () => {
    it('sort_mode replace sets the view sort aside, the group still comes first', async () => {
      const grouped = await view({
        group: [{ field: fx.fld.status.id, direction: 'desc' }],
        sort: [{ field: fx.fld.amount.id, direction: 'asc' }],
      });
      const access = accessOf(fx, 'u_reader');
      const read = async (request: Record<string, unknown>) =>
        ids(await service.query(scope, fx.orders.id, access, { view_id: grouped, ...request }));
      // Default (append): the view's amount sort, then the request's title for ties.
      expect(await read({ group: [], sort: [{ field: 'title', direction: 'desc' }] })).toEqual([
        r4,
        r2,
        r3,
        r1,
        r5,
      ]);
      expect(
        await read({
          group: [],
          sort: [{ field: 'title', direction: 'desc' }],
          sort_mode: 'replace',
        }),
      ).toEqual([r5, r4, r3, r2, r1]);
      // No sort at all: creation order.
      expect(await read({ group: [], sort_mode: 'replace' })).toEqual([r1, r2, r3, r4, r5]);
      // The view's group stays: Xong (r5, r2), Mới (r4, r1), empty (r3).
      expect(
        await read({ sort: [{ field: 'title', direction: 'desc' }], sort_mode: 'replace' }),
      ).toEqual([r5, r2, r4, r1, r3]);
    });

    it('filter_mode replace takes the place of the view filter, in queries and group counts', async () => {
      const onlyNew = await view({ filter: { op: 'and', items: [statusIs(fx.opt.new)] } });
      const access = accessOf(fx, 'u_reader');
      const done = { op: 'and', items: [statusIs(fx.opt.done)] };
      expect(
        ids(
          await service.query(scope, fx.orders.id, access, {
            view_id: onlyNew,
            filter: done,
            filter_mode: 'replace',
          }),
        ),
      ).toEqual([r2, r5]);
      expect(
        ids(
          await service.query(scope, fx.orders.id, access, {
            view_id: onlyNew,
            filter_mode: 'replace',
          }),
        ),
      ).toEqual([r1, r2, r3, r4, r5]);
      const counts = await service.groupCounts(scope, fx.orders.id, access, {
        view_id: onlyNew,
        filter: done,
        filter_mode: 'replace',
      });
      expect(counts.groups).toEqual([{ values: [], count: 2 }]);
      // Without a view both modes read the same.
      expect(
        ids(
          await service.query(scope, fx.orders.id, access, {
            filter: done,
            filter_mode: 'replace',
          }),
        ),
      ).toEqual([r2, r5]);
    });

    it('saved conditions on fields the caller cannot read still apply after replace', async () => {
      const costOver = { field: fx.fld.cost.id, operator: 'gt', value: 50 };
      const costly = await view({ filter: { op: 'and', items: [costOver, statusIs(fx.opt.new)] } });
      const access = readerWithoutCost();
      const read = async (viewId: Id<'viw'>, request: Record<string, unknown>) =>
        ids(await service.query(scope, fx.orders.id, access, { view_id: viewId, ...request }));
      expect(await read(costly, {})).toEqual([r1]);
      // The caller replaced "status is new" (what they see) by "status is done".
      expect(
        await read(costly, {
          filter: { op: 'and', items: [statusIs(fx.opt.done)] },
          filter_mode: 'replace',
        }),
      ).toEqual([r2]);
      // Clearing what they see leaves the hidden condition: cost > 50.
      expect(await read(costly, { filter_mode: 'replace' })).toEqual([r1, r2]);
      // An `or` holding a hidden condition stays whole: cost > 500 OR done.
      const either = await view({
        filter: {
          op: 'or',
          items: [{ ...costOver, value: 500 }, statusIs(fx.opt.done)],
        },
      });
      expect(await read(either, { filter_mode: 'replace' })).toEqual([r1, r2, r5]);
      // Someone reading every field replaces everything.
      expect(
        ids(
          await service.query(scope, fx.orders.id, accessOf(fx, 'u_reader'), {
            view_id: costly,
            filter_mode: 'replace',
          }),
        ),
      ).toEqual([r1, r2, r3, r4, r5]);
    });

    it('share links cannot set the view filter aside', async () => {
      const onlyNew = await view({ filter: { op: 'and', items: [statusIs(fx.opt.new)] } });
      const error = await appError(
        service.query(
          scope,
          fx.orders.id,
          accessOf(fx, 'u_reader'),
          { view_id: onlyNew, filter_mode: 'replace' },
          { viewScope: 'share_link' },
        ),
      );
      expect(error.code).toBe('PERMISSION_DENIED');
      expect(error.errors).toEqual([
        { path: 'filter_mode', code: 'NOT_ALLOWED', message: 'Not allowed.' },
      ]);
    });
  });

  describe('conditions on deleted fields', () => {
    const deletedField = newId('fld');
    const filterWithDeleted = () => ({
      op: 'and',
      items: [{ field: deletedField, operator: 'is_not_empty' }, statusIs(fx.opt.new)],
    });

    it('members: the condition is ignored, the rest of the view applies', async () => {
      const stale = await view({
        filter: filterWithDeleted(),
        sort: [{ field: deletedField, direction: 'asc' }],
        group: [{ field: deletedField, direction: 'asc' }],
      });
      const list = await service.query(scope, fx.orders.id, accessOf(fx, 'u_reader'), {
        view_id: stale,
      });
      expect(ids(list)).toEqual([r1, r4]);
    });

    it('members: a condition that no longer validates (e.g. a removed option) is ignored too', async () => {
      const stale = await view({
        filter: { op: 'and', items: [statusIs(newId('opt')), statusIs(fx.opt.new)] },
      });
      const list = await service.query(scope, fx.orders.id, accessOf(fx, 'u_reader'), {
        view_id: stale,
      });
      expect(ids(list)).toEqual([r1, r4]);
    });

    it('share links fail closed: the view matches no record', async () => {
      const stale = await view({ filter: filterWithDeleted() });
      const access = accessOf(fx, 'u_reader');
      const list = await service.query(
        scope,
        fx.orders.id,
        access,
        { view_id: stale },
        { viewScope: 'share_link' },
      );
      expect(list.records).toEqual([]);
      expect(list).toMatchObject({ total: 0 });
      const counts = await service.groupCounts(
        scope,
        fx.orders.id,
        access,
        { view_id: stale },
        { viewScope: 'share_link' },
      );
      expect(counts.groups).toEqual([{ values: [], count: 0 }]);
      // A condition wrapped in `not` must not turn into "everything".
      const negated = await view({
        filter: { op: 'not', item: { field: deletedField, operator: 'is_not_empty' } },
      });
      const none = await service.query(
        scope,
        fx.orders.id,
        access,
        { view_id: negated },
        { viewScope: 'share_link' },
      );
      expect(none.records).toEqual([]);
      // A valid view works under a share link.
      const valid = await view({ filter: { op: 'and', items: [statusIs(fx.opt.new)] } });
      expect(
        ids(
          await service.query(
            scope,
            fx.orders.id,
            access,
            { view_id: valid },
            { viewScope: 'share_link' },
          ),
        ),
      ).toEqual([r1, r4]);
    });

    it('fits the share-link access of T304 (view filter in the read rule, hidden fields gone)', async () => {
      const creator = accessOf(fx, 'u_admin');
      const through = async (config: Partial<StoredViewConfig>) => {
        const viewId = await view(config);
        const resolved = resolveShareLinkAccess(creator.resolved, {
          kind: 'view',
          tableId: fx.orders.id,
          viewId,
          filter: (config.filter ?? null) as FilterNode | null,
          hiddenFields: (config.hidden_fields ?? []) as Id<'fld'>[],
        });
        if (resolved === null) throw new Error('the creator cannot share');
        return service.query(
          scope,
          fx.orders.id,
          { ...creator, resolved },
          { view_id: viewId },
          { viewScope: 'share_link' },
        );
      };
      const valid = await through({
        filter: { op: 'and', items: [statusIs(fx.opt.new)] },
        hidden_fields: [fx.fld.cost.id],
      });
      expect(ids(valid)).toEqual([r1, r4]);
      expect(valid.records[0]?.fields).not.toHaveProperty('cost');
      const stale = await through({ filter: filterWithDeleted() });
      expect(stale.records).toEqual([]);
    });

    it('share links: fields hidden in the view are outside the scope', async () => {
      const hiding = await view({ hidden_fields: [fx.fld.amount.id] });
      const access = accessOf(fx, 'u_reader');
      const list = await service.query(
        scope,
        fx.orders.id,
        access,
        { view_id: hiding },
        { viewScope: 'share_link' },
      );
      expect(list.records[0]?.fields).not.toHaveProperty('amount');
      const requested = await appError(
        service.query(
          scope,
          fx.orders.id,
          access,
          { view_id: hiding, fields: ['amount'] },
          { viewScope: 'share_link' },
        ),
      );
      expect(requested.code).toBe('VALIDATION_FAILED');
      const filtered = await appError(
        service.query(
          scope,
          fx.orders.id,
          access,
          { view_id: hiding, filter: { logic: 'and', conditions: [['amount', '>', 1]] } },
          { viewScope: 'share_link' },
        ),
      );
      expect(filtered.code).toBe('INVALID_FILTER');
    });
  });

  describe('group counts', () => {
    it('counts rows per group value in row order, under the view filter and the read rule', async () => {
      const grouped = await view({ group: [{ field: fx.fld.status.id, direction: 'asc' }] });
      const reader = accessOf(fx, 'u_reader');
      const counts = await service.groupCounts(scope, fx.orders.id, reader, { view_id: grouped });
      expect(counts).toEqual({
        group: [{ field: 'status', direction: 'asc' }],
        groups: [
          { values: ['Mới'], count: 2 },
          { values: ['Xong'], count: 2 },
          { values: [null], count: 1 },
        ],
        truncated: false,
      });
      // Two levels, by id, text values; the request filter narrows.
      const two = await service.groupCounts(scope, fx.orders.id, reader, {
        view_id: grouped,
        field_key_type: 'id',
        cell_format: 'text',
        group: [
          { field: fx.fld.status.id, direction: 'desc' },
          { field: fx.fld.amount.id, direction: 'asc' },
        ],
        filter: { op: 'and', items: [{ field: fx.fld.title.id, operator: 'neq', value: 'r3' }] },
      });
      expect(two.group).toEqual([
        { field: fx.fld.status.id, direction: 'desc' },
        { field: fx.fld.amount.id, direction: 'asc' },
      ]);
      expect(two.groups).toEqual([
        { values: ['Xong', '200 ₫'], count: 1 },
        { values: ['Xong', ''], count: 1 },
        { values: ['Mới', '200 ₫'], count: 1 },
        { values: ['Mới', '1.500.000 ₫'], count: 1 },
      ]);
      // The read rule applies: u_sales1 counts only r1.
      const sales = await service.groupCounts(scope, fx.orders.id, accessOf(fx, 'u_sales1'), {
        group: [{ field: 'status' }],
      });
      expect(sales.groups).toEqual([{ values: ['Mới'], count: 1 }]);
      // Without group levels: one group with every matching row.
      const flat = await service.groupCounts(scope, fx.orders.id, reader, {});
      expect(flat).toEqual({ group: [], groups: [{ values: [], count: 5 }], truncated: false });
    });

    it('never groups by a field the caller cannot read', async () => {
      const access = readerWithoutCost();
      const error = await appError(
        service.groupCounts(scope, fx.orders.id, access, { group: [{ field: 'cost' }] }),
      );
      expect(error.code).toBe('INVALID_SORT');
      expect(error.errors).toEqual([
        { path: 'group[0].field', code: 'UNKNOWN_FIELD', message: 'Field does not exist' },
      ]);
      // The view's group level on `cost` is left out of the counts (no value leaks).
      const byCost = await view({
        group: [
          { field: fx.fld.cost.id, direction: 'asc' },
          { field: fx.fld.status.id, direction: 'asc' },
        ],
      });
      const counts = await service.groupCounts(scope, fx.orders.id, access, { view_id: byCost });
      expect(counts.group).toEqual([{ field: 'status', direction: 'asc' }]);
      expect(counts.groups.map((group) => group.count)).toEqual([2, 2, 1]);
    });

    it('checks the view like a query', async () => {
      const hidden = await view();
      const access = withVisibleViews(accessOf(fx, 'u_reader'), []);
      expect(
        (await appError(service.groupCounts(scope, fx.orders.id, access, { view_id: hidden })))
          .code,
      ).toBe('NOT_FOUND');
    });
  });
});
