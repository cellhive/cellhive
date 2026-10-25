import {
  createdShareLinkSchema,
  recordListResponseSchema,
  recordsResponseSchema,
  roleWithAdjustmentsSchema,
  type Id,
  type RealtimeServerMessage,
  type RecordDto,
} from '@cellhive/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Browser } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { closeSockets, listen, TestSocket } from './realtime-support.js';
import {
  buildRecordFixture,
  expectProblem,
  type FixtureUser,
  type RecordFixture,
} from './record-fixture.js';
import { problemOf, startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

import type { Db } from '@cellhive/server-core';
import type { LightMyRequestResponse } from 'fastify';

type Message = RealtimeServerMessage;

/**
 * T710 (S6 decision #13, CONTRACTS §5 P62, §14): link fields in role record
 * rules over HTTP and WebSockets, with a dedicated variant of the Sales role
 * assigned straight to u_sales1 — Orders `manage`, Customers read only,
 * `read_filter` = `edit_filter` = `customer has_any_of [c1]`, share links
 * allowed. Writes go through instance A, clients listen on instance B.
 */
describe('link fields in role record rules (T710, P62)', () => {
  let database: TestDatabase;
  let db: Db;
  let a: TestApp;
  let b: TestApp;
  let urlB: string;
  let fx: RecordFixture;
  let customer: Id<'fld'>;
  let c1: Id<'rec'>, c2: Id<'rec'>;
  let r1: Id<'rec'>, r2: Id<'rec'>;
  let roleId: Id<'rol'>;
  const sockets: TestSocket[] = [];

  const F = (name: string): Id<'fld'> => {
    const field = fx.fld[name];
    if (field === undefined) throw new Error(`no field ${name}`);
    return field.id;
  };
  const ordersUrl = () => `/tables/${fx.orders.id}/records?field_key_type=id`;
  const c1Rule = () => ({ field: customer, operator: 'has_any_of', value: [c1] });

  function records(response: LightMyRequestResponse): RecordDto[] {
    expect(response.statusCode, response.body).toBeLessThan(300);
    return recordsResponseSchema.parse(response.json()).records;
  }

  /** Order ids `user` reads (`GET …/records`). */
  async function readable(user: FixtureUser): Promise<string[]> {
    const response = await fx.call(user, 'GET', ordersUrl());
    expect(response.statusCode, response.body).toBe(200);
    return recordListResponseSchema.parse(response.json()).records.map((record) => record.id);
  }

  /** The order as an admin reads it: version and link cell ids. */
  async function adminView(id: Id<'rec'>): Promise<{ version: number; customer: string[] }> {
    const response = await fx.call(
      'u_admin',
      'GET',
      `/tables/${fx.orders.id}/records/${id}?field_key_type=id`,
    );
    expect(response.statusCode, response.body).toBe(200);
    const record = response.json<RecordDto>();
    const cell = (record.fields[customer] ?? []) as { id: string }[];
    return { version: record.version, customer: cell.map((ref) => ref.id) };
  }

  const patchCustomer = (user: FixtureUser, id: Id<'rec'>, cell: Id<'rec'>[]) =>
    fx.call(user, 'PATCH', ordersUrl(), { records: [{ id, fields: { [customer]: cell } }] });

  const variantConfig = (overrides: Record<string, unknown> = {}) => ({
    base_rule: { copy: false, download: false, share_link: true },
    tables: {
      [fx.orders.id]: {
        perm: 'manage',
        record_rule: {
          operations: ['add', 'delete'],
          edit_filter: c1Rule(),
          read_scope: 'filter',
          read_filter: c1Rule(),
        },
        ...overrides,
      },
      [fx.customers.id]: { perm: 'read_only' },
    },
  });

  async function watch(user: FixtureUser): Promise<TestSocket> {
    const socket = await TestSocket.connect(urlB, {
      origin: TEST_PUBLIC_URL,
      cookie: await fx.cookie(user),
    });
    sockets.push(socket);
    expect(await socket.subscribe(`table:${fx.orders.id}`, 's1')).toMatchObject({
      type: 'subscribed',
    });
    return socket;
  }

  const about =
    (type: Message['type'], recordId: string) =>
    (message: Message): boolean =>
      message.type === type && 'record_id' in message && message.record_id === recordId;

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    a = await startTestApp({ DATABASE_URL: database.url });
    b = await startTestApp({ DATABASE_URL: database.url });
    await listen(a.app);
    urlB = await listen(b.app);
    fx = await buildRecordFixture(a, db);
    const field = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
      name: 'customer',
      type: 'link',
      options: { link_table: fx.customers.id },
    });
    expect(field.statusCode, field.body).toBe(201);
    customer = field.json<{ id: Id<'fld'> }>().id;
    [c1, c2] = records(
      await fx.call('u_admin', 'POST', `/tables/${fx.customers.id}/records`, {
        records: [{ fields: { Tên: 'An Phát' } }, { fields: { Tên: 'Bình Minh' } }],
      }),
    ).map((record) => record.id) as [Id<'rec'>, Id<'rec'>];
    [r1, r2] = records(
      await fx.call('u_admin', 'POST', ordersUrl(), {
        records: [
          { fields: { [F('title')]: 'r1', [customer]: [c1] } },
          { fields: { [F('title')]: 'r2', [customer]: [c2] } },
        ],
      }),
    ).map((record) => record.id) as [Id<'rec'>, Id<'rec'>];

    const created = await fx.call('owner', 'POST', `/bases/${fx.baseId}/roles`, {
      name: 'Sales (link rule)',
      config: variantConfig(),
    });
    expect(created.statusCode, created.body).toBe(201);
    roleId = roleWithAdjustmentsSchema.parse(created.json()).id;
    const assigned = await fx.call('owner', 'PUT', `/bases/${fx.baseId}/role-assignments`, {
      principal_type: 'user',
      principal_id: fx.users.u_sales1.id,
      role_id: roleId,
    });
    expect(assigned.statusCode, assigned.body).toBe(200);
  });

  afterAll(async () => {
    await closeSockets(sockets);
    await Promise.all([a.close(), b.close()]);
    await db.destroy();
    await database.drop();
  });

  describe('saving the role', () => {
    it('raises the link field to create (with add) and stores the rule by record id', async () => {
      const response = await fx.call('owner', 'POST', `/bases/${fx.baseId}/roles`, {
        name: 'Link floor',
        config: variantConfig({
          field_rule: { mode: 'specify', fields: { [customer]: 'no_perm' } },
        }),
      });
      expect(response.statusCode, response.body).toBe(201);
      const role = roleWithAdjustmentsSchema.parse(response.json());
      expect(role.adjustments).toContainEqual({
        table_id: fx.orders.id,
        field_id: customer,
        from: 'no_perm',
        to: 'create',
        reason: 'filter_field_min_create',
      });
      expect(role.config).toMatchObject({
        tables: { [fx.orders.id]: { record_rule: { read_filter: c1Rule() } } },
      });
      const deleted = await fx.call('owner', 'DELETE', `/bases/${fx.baseId}/roles/${role.id}`);
      expect(deleted.statusCode, deleted.body).toBe(204);
    });

    it.each([
      { name: 'contains "abc"', operator: 'contains', value: 'abc', code: 'OPERATOR_NOT_ALLOWED' },
      {
        name: '$var current_user',
        operator: 'has_any_of',
        value: [{ $var: 'current_user' }],
        code: 'INVALID_VALUE',
      },
      { name: 'a title', operator: 'has_any_of', value: ['An Phát'], code: 'INVALID_VALUE' },
    ])(
      'refuses $name on the link: 422 INVALID_FILTER / $code',
      async ({ operator, value, code }) => {
        const response = await fx.call('owner', 'PATCH', `/bases/${fx.baseId}/roles/${roleId}`, {
          config: {
            tables: {
              [fx.orders.id]: {
                perm: 'manage',
                record_rule: {
                  read_scope: 'filter',
                  read_filter: { field: customer, operator, value },
                },
              },
            },
          },
        });
        expectProblem(response, 422, 'INVALID_FILTER');
        const errors = problemOf(response.body)['errors'] as { path: string; code: string }[];
        expect(errors.map((error) => error.code)).toEqual([code]);
        const prefix = `config.tables.${fx.orders.id}.record_rule.read_filter`;
        expect(errors.every((error) => error.path.startsWith(prefix))).toBe(true);
      },
    );
  });

  it('P62: u_sales1 reads only the order linked to c1', async () => {
    expect(await readable('u_sales1')).toEqual([r1]);
    expect(await readable('u_editor')).toEqual([r1, r2]);
    expectProblem(
      await fx.call('u_sales1', 'GET', `/tables/${fx.orders.id}/records/${r2}`),
      404,
      'NOT_FOUND',
    );
  });

  it('P62 (WS): u_editor moves r1 to c2 → u_sales1 gets record.removed_from_view, back → added', async () => {
    const sales = await watch('u_sales1');
    records(await patchCustomer('u_editor', r1, [c2]));
    await sales.next(about('record.removed_from_view', r1));
    expect(await readable('u_sales1')).toEqual([]);
    records(await patchCustomer('u_editor', r1, [c1]));
    await sales.next(about('record.added', r1));
    expect(await readable('u_sales1')).toEqual([r1]);
  });

  it('c1 in the trash → r1 no longer readable (live linked records only), restored → back', async () => {
    const sales = await watch('u_sales1');
    const deleted = await fx.call('u_admin', 'DELETE', `/tables/${fx.customers.id}/records/${c1}`);
    expect(deleted.statusCode, deleted.body).toBe(204);
    try {
      await sales.next(about('record.removed_from_view', r1));
      expect(await readable('u_sales1')).toEqual([]);
    } finally {
      const restored = await fx.call(
        'u_admin',
        'POST',
        `/tables/${fx.customers.id}/records/restore`,
        { ids: [c1] },
      );
      expect(restored.statusCode, restored.body).toBe(200);
    }
    await sales.next(about('record.added', r1));
    expect(await readable('u_sales1')).toEqual([r1]);
  });

  it('P62: edit_filter on the link — PATCH r1.customer = [c2] is 403 RECORD_RULE_VIOLATION, rolled back', async () => {
    const before = await adminView(r1);
    expectProblem(await patchCustomer('u_sales1', r1, [c2]), 403, 'RECORD_RULE_VIOLATION');
    expectProblem(
      await fx.call('u_sales1', 'PATCH', ordersUrl(), {
        records: [{ id: r1, fields: { [F('title')]: 'moved', [customer]: [c2] } }],
      }),
      403,
      'RECORD_RULE_VIOLATION',
    );
    expect(await adminView(r1)).toEqual(before);
    // A change that keeps r1 in the rule goes through.
    records(
      await fx.call('u_sales1', 'PATCH', ordersUrl(), {
        records: [{ id: r1, fields: { [F('title')]: 'r1 by sales' } }],
      }),
    );
    // New records: checked with their link cells.
    expectProblem(
      await fx.call('u_sales1', 'POST', ordersUrl(), {
        records: [{ fields: { [F('title')]: 'mine', [customer]: [c2] } }],
      }),
      403,
      'RECORD_RULE_VIOLATION',
    );
    const [mine] = records(
      await fx.call('u_sales1', 'POST', ordersUrl(), {
        records: [{ fields: { [F('title')]: 'mine', [customer]: [c1] } }],
      }),
    ).map((record) => record.id);
    expect(await readable('u_sales1')).toEqual([r1, mine]);
    const removed = await fx.call(
      'u_sales1',
      'DELETE',
      `/tables/${fx.orders.id}/records/${String(mine)}`,
    );
    expect(removed.statusCode, removed.body).toBe(204);
  });

  it('a share link made by u_sales1 shows only the orders of its rule', async () => {
    const view = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/views`, {
      name: 'All orders',
      type: 'grid',
    });
    expect(view.statusCode, view.body).toBe(201);
    const viewId = view.json<{ id: Id<'viw'> }>().id;
    const created = await fx.call('u_sales1', 'POST', `/views/${viewId}/share-links`, {
      audience: 'public',
    });
    expect(created.statusCode, created.body).toBe(201);
    const { token } = createdShareLinkSchema.parse(created.json());
    const anonymous = new Browser(a.app);
    const page = await anonymous.request({
      method: 'POST',
      url: `/api/v1/shares/${token}/records/query`,
      payload: {},
    });
    expect(page.statusCode, page.body).toBe(200);
    expect(recordListResponseSchema.parse(page.json()).records.map((record) => record.id)).toEqual([
      r1,
    ]);
    const other = await anonymous.request({
      method: 'GET',
      url: `/api/v1/shares/${token}/records/${r2}`,
    });
    expectProblem(other, 404, 'NOT_FOUND');
  });

  it('reverse side of a two-way link: rules naming it check the linked orders (S4 #6 exception)', async () => {
    const created = await fx.call('u_admin', 'POST', `/tables/${fx.customers.id}/fields`, {
      name: 'orders',
      type: 'link',
      options: {
        link_table: fx.orders.id,
        bidirectional: true,
        bidirectional_link_field_name: 'buyer',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const ordersOf = created.json<{ id: Id<'fld'>; options: { symmetric_field_id: Id<'fld'> } }>();
    const buyer = ordersOf.options.symmetric_field_id;
    const customersUrl = `/tables/${fx.customers.id}/records?field_key_type=id`;
    records(
      await fx.call('u_admin', 'PATCH', ordersUrl(), {
        records: [{ id: r1, fields: { [buyer]: [c1] } }],
      }),
    );
    const config = (editFilter: unknown, readScope = 'all') => ({
      tables: {
        [fx.orders.id]: {
          perm: 'edit',
          record_rule: { edit_filter: editFilter, read_scope: readScope },
        },
        [fx.customers.id]: { perm: 'edit' },
      },
    });
    const role = await fx.call('owner', 'POST', `/bases/${fx.baseId}/roles`, {
      name: 'Sales reverse',
      config: config({ field: buyer, operator: 'has_any_of', value: [c1] }),
    });
    expect(role.statusCode, role.body).toBe(201);
    const reverseRole = role.json<{ id: Id<'rol'> }>().id;
    const assigned = await fx.call('owner', 'PUT', `/bases/${fx.baseId}/role-assignments`, {
      principal_type: 'user',
      principal_id: fx.users.u_sales2.id,
      role_id: reverseRole,
    });
    expect(assigned.statusCode, assigned.body).toBe(200);
    const setRule = async (editFilter: unknown, readScope = 'all') => {
      const response = await fx.call('owner', 'PATCH', `/bases/${fx.baseId}/roles/${reverseRole}`, {
        config: config(editFilter, readScope),
      });
      expect(response.statusCode, response.body).toBe(200);
    };
    const linkFromC1 = (ids: Id<'rec'>[]) =>
      fx.call('u_sales2', 'PATCH', customersUrl, {
        records: [{ id: c1, fields: { [ordersOf.id]: ids } }],
      });
    const buyerOf = async (id: Id<'rec'>) => {
      const response = await fx.call(
        'u_admin',
        'GET',
        `/tables/${fx.orders.id}/records/${id}?field_key_type=id`,
      );
      return ((response.json<RecordDto>().fields[buyer] ?? []) as { id: string }[]).map(
        (ref) => ref.id,
      );
    };

    // has_any_of [c1]: linking r2 from c1 would put r2 in the edit rule → 403, r2 unchanged.
    expectProblem(await linkFromC1([r1, r2]), 403, 'PERMISSION_DENIED');
    expect(await buyerOf(r2)).toEqual([]);
    // has_none_of [c1] (r1 hidden): unlinking r1 from c1 → 403, r1 keeps c1.
    await setRule({ field: buyer, operator: 'has_none_of', value: [c1] }, 'editable');
    expectProblem(await linkFromC1([]), 403, 'PERMISSION_DENIED');
    expect(await buyerOf(r1)).toEqual([c1]);
    // A rule that does not name the field: S4 #6, the reverse write goes through.
    await setRule({ field: F('amount'), operator: 'gt', value: 0 });
    records(await linkFromC1([r1, r2]));
    expect(await buyerOf(r2)).toEqual([c1]);
    records(await linkFromC1([r1]));
    const unassigned = await fx.call('owner', 'DELETE', `/bases/${fx.baseId}/role-assignments`, {
      principal_type: 'user',
      principal_id: fx.users.u_sales2.id,
    });
    expect(unassigned.statusCode, unassigned.body).toBe(204);
  });

  it('QA S6 (WS): a read rule on a two-way link follows writes made from the other table', async () => {
    const created = await fx.call('u_admin', 'POST', `/tables/${fx.customers.id}/fields`, {
      name: 'accounts',
      type: 'link',
      options: {
        link_table: fx.orders.id,
        bidirectional: true,
        bidirectional_link_field_name: 'account',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const pair = created.json<{ id: Id<'fld'>; options: { symmetric_field_id: Id<'fld'> } }>();
    const account = pair.options.symmetric_field_id;
    const role = await fx.call('owner', 'POST', `/bases/${fx.baseId}/roles`, {
      name: 'Account readers',
      config: {
        tables: {
          [fx.orders.id]: {
            perm: 'read_only',
            record_rule: {
              read_scope: 'filter',
              read_filter: { field: account, operator: 'has_any_of', value: [c1] },
            },
          },
          [fx.customers.id]: { perm: 'read_only' },
        },
      },
    });
    expect(role.statusCode, role.body).toBe(201);
    const assigned = await fx.call('owner', 'PUT', `/bases/${fx.baseId}/role-assignments`, {
      principal_type: 'user',
      principal_id: fx.users.u_out.id,
      role_id: role.json<{ id: Id<'rol'> }>().id,
    });
    expect(assigned.statusCode, assigned.body).toBe(200);
    const fromC1 = (ids: Id<'rec'>[]) =>
      fx.call('u_admin', 'PATCH', `/tables/${fx.customers.id}/records?field_key_type=id`, {
        records: [{ id: c1, fields: { [pair.id]: ids } }],
      });
    records(await fromC1([r2]));
    expect(await readable('u_out')).toEqual([r2]);
    const out = await watch('u_out');
    // Written on Customers only: r2 leaves the rule, r1 enters it.
    records(await fromC1([r1]));
    await out.next(about('record.removed_from_view', r2));
    await out.next(about('record.added', r1));
    expect(await readable('u_out')).toEqual([r1]);
    const unassigned = await fx.call('owner', 'DELETE', `/bases/${fx.baseId}/role-assignments`, {
      principal_type: 'user',
      principal_id: fx.users.u_out.id,
    });
    expect(unassigned.statusCode, unassigned.body).toBe(204);
  });

  it('fails closed once the link field is deleted: u_sales1 reads and edits nothing', async () => {
    const deleted = await fx.call('u_admin', 'DELETE', `/fields/${customer}`);
    expect(deleted.statusCode, deleted.body).toBe(204);
    expect(await readable('u_sales1')).toEqual([]);
    expectProblem(
      await fx.call('u_sales1', 'PATCH', ordersUrl(), {
        records: [{ id: r1, fields: { [F('title')]: 'x' } }],
      }),
      404,
      'NOT_FOUND',
    );
    expect(await readable('u_editor')).toEqual([r1, r2]);
  });
});
