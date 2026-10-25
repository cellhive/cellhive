import {
  fieldSchema,
  recordAncestorsResponseSchema,
  recordListResponseSchema,
  recordsResponseSchema,
  recordTrashResponseSchema,
  recordTreeResponseSchema,
  type FieldDto,
  type Id,
  type RealtimeServerMessage,
  type RecordDto,
} from '@cellhive/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { closeSockets, listen, TestSocket } from './realtime-support.js';
import { buildRecordFixture, expectProblem, type RecordFixture } from './record-fixture.js';
import { startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

import type { Db } from '@cellhive/server-core';
import type { LightMyRequestResponse } from 'fastify';

/**
 * T405: sub-records over HTTP — turning them on (schema rights), writes
 * with `parent_id` and the parent field (cycle, depth, 403 vs 404), the
 * tree, children and ancestors (read rules, placeholders), deleting a
 * branch and restoring it, the view rule "tree or group", and realtime.
 */
describe('sub-records (T405)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let url: string;
  let fx: RecordFixture;
  let parent: FieldDto;
  // A (sales1) ─ B (sales2) ─ C (sales1)
  let a: Id<'rec'>, b: Id<'rec'>, c: Id<'rec'>;
  const sockets: TestSocket[] = [];

  function records(response: LightMyRequestResponse): RecordDto[] {
    expect(response.statusCode, response.body).toBeLessThan(300);
    return recordsResponseSchema.parse(response.json()).records;
  }

  async function create(
    title: string,
    owner: 'u_sales1' | 'u_sales2',
    parentId?: Id<'rec'>,
  ): Promise<Id<'rec'>> {
    const [record] = records(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/records`, {
        records: [
          {
            fields: { title, owner: [{ id: fx.users[owner].id }] },
            ...(parentId === undefined ? {} : { parent_id: parentId }),
          },
        ],
      }),
    );
    return record?.id as Id<'rec'>;
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    url = await listen(t.app);
    fx = await buildRecordFixture(t, db);
    const response = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
      name: 'Parent',
      type: 'parent',
    });
    expect(response.statusCode, response.body).toBe(201);
    parent = fieldSchema.parse(response.json());
    a = await create('A', 'u_sales1');
    b = await create('B', 'u_sales2', a);
    c = await create('C', 'u_sales1', b);
  });

  afterAll(async () => {
    await closeSockets(sockets);
    await t.close();
    await db.destroy();
    await database.drop();
  });

  it('turns sub-records on once, with schema rights', async () => {
    expect(parent).toMatchObject({ type: 'parent', options: {} });
    expectProblem(
      await fx.call('u_reader', 'POST', `/tables/${fx.orders.id}/fields`, {
        name: 'P',
        type: 'parent',
      }),
      403,
      'PERMISSION_DENIED',
    );
    const twice = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
      name: 'P',
      type: 'parent',
    });
    expectProblem(twice, 422, 'VALIDATION_FAILED');
    expect(twice.json()).toMatchObject({ errors: [{ code: 'SUBRECORDS_ALREADY_ENABLED' }] });
  });

  it('reads and writes the parent; 422 for a cycle, 403 for a reader, 404 for a hidden record', async () => {
    const got = await fx.call('u_admin', 'GET', `/tables/${fx.orders.id}/records/${c}`);
    expect(got.json()).toMatchObject({ fields: { Parent: { id: b, title: 'B' } } });
    const p20 = await fx.call('u_sales1', 'GET', `/tables/${fx.orders.id}/records/${c}`);
    expect(p20.json()).toMatchObject({ fields: { Parent: { id: b, title: null } } });

    expectProblem(
      await fx.call('u_admin', 'PATCH', `/tables/${fx.orders.id}/records/${a}`, {
        fields: { Parent: c },
      }),
      422,
      'SUBRECORD_CYCLE',
    );
    expectProblem(
      await fx.call('u_admin', 'PATCH', `/tables/${fx.orders.id}/records/${a}`, {
        fields: {},
        parent_id: a,
      }),
      422,
      'SUBRECORD_CYCLE',
    );
    expectProblem(
      await fx.call('u_reader', 'PATCH', `/tables/${fx.orders.id}/records/${c}`, {
        fields: {},
        parent_id: null,
      }),
      403,
      'PERMISSION_DENIED',
    );
    expectProblem(
      await fx.call('u_sales1', 'PATCH', `/tables/${fx.orders.id}/records/${b}`, {
        fields: {},
        parent_id: null,
      }),
      404,
      'NOT_FOUND',
    );
    // Resending the current (unreadable) parent keeps it (P20)…
    records(
      await fx.call('u_sales1', 'PATCH', `/tables/${fx.orders.id}/records`, {
        records: [{ id: c, fields: {}, parent_id: b }],
      }),
    );
    // …but u_sales1 cannot move C under a record it cannot read: same as a missing one.
    const hidden = await create('H', 'u_sales2');
    for (const target of [hidden, 'rec_0000000000000000']) {
      expectProblem(
        await fx.call('u_sales1', 'PATCH', `/tables/${fx.orders.id}/records/${c}`, {
          fields: {},
          parent_id: target,
        }),
        422,
        'LINK_TARGET_NOT_FOUND',
      );
    }
    await fx.call('u_admin', 'DELETE', `/tables/${fx.orders.id}/records/${hidden}`);
  });

  it('tree, children and ancestors follow the read rules', async () => {
    const adminRoots = recordTreeResponseSchema.parse(
      (
        await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/records/tree`, {
          fields: ['title'],
        })
      ).json(),
    );
    expect(adminRoots.records.map((record) => [record.fields.title, record.tree])).toEqual([
      ['A', { parent_id: null, depth: 0, children_count: 1, ancestor_only: false }],
    ]);
    // u_sales1 does not read B: C shows as a root, A has no visible child.
    const salesRoots = recordTreeResponseSchema.parse(
      (
        await fx.call('u_sales1', 'POST', `/tables/${fx.orders.id}/records/tree`, {
          fields: ['title'],
        })
      ).json(),
    );
    expect(
      salesRoots.records.map((record) => [record.fields.title, record.tree.children_count]),
    ).toEqual([
      ['A', 0],
      ['C', 0],
    ]);
    expectProblem(
      await fx.call('u_sales1', 'GET', `/tables/${fx.orders.id}/records/${b}/children`),
      404,
      'NOT_FOUND',
    );
    const children = recordListResponseSchema.parse(
      (await fx.call('u_admin', 'GET', `/tables/${fx.orders.id}/records/${b}/children`)).json(),
    );
    expect(children.records.map((record) => record.id)).toEqual([c]);
    const ancestors = recordAncestorsResponseSchema.parse(
      (await fx.call('u_sales1', 'GET', `/tables/${fx.orders.id}/records/${c}/ancestors`)).json(),
    );
    expect(ancestors.items).toEqual([
      { id: a, title: 'A', locked: false },
      { id: null, title: null, locked: true },
    ]);
    const disabled = await fx.call(
      'u_admin',
      'POST',
      `/tables/${fx.customers.id}/records/tree`,
      {},
    );
    expectProblem(disabled, 422, 'VALIDATION_FAILED');
    expect(disabled.json()).toMatchObject({ errors: [{ code: 'SUBRECORDS_NOT_ENABLED' }] });
  });

  it('a view cannot be both a tree and grouped', async () => {
    const response = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/views`, {
      name: 'Tree',
      type: 'grid',
      config: {
        tree: { enabled: true, show_ancestors: true },
        group: [{ field: fx.fld.title?.id as string, direction: 'asc' }],
      },
    });
    expectProblem(response, 422, 'VALIDATION_FAILED');
    expect(response.json()).toMatchObject({ errors: [{ code: 'TREE_WITH_GROUP' }] });
  });

  it('realtime: a reparent reaches subscribers, the title only for those who read it all', async () => {
    const connect = async (user: 'u_admin' | 'u_sales1') => {
      const socket = await TestSocket.connect(url, {
        origin: TEST_PUBLIC_URL,
        cookie: await fx.cookie(user),
      });
      sockets.push(socket);
      expect(await socket.subscribe(`table:${fx.orders.id}`)).toMatchObject({
        type: 'subscribed',
      });
      return socket;
    };
    const adminSocket = await connect('u_admin');
    const salesSocket = await connect('u_sales1');
    records(
      await fx.call('u_admin', 'PATCH', `/tables/${fx.orders.id}/records`, {
        records: [{ id: c, fields: {}, parent_id: a }],
      }),
    );
    const isUpdate = (message: RealtimeServerMessage) =>
      message.type === 'record.updated' && message.record_id === c;
    expect(await adminSocket.next(isUpdate)).toMatchObject({
      fields: { [parent.id]: { id: a, title: 'A' } },
    });
    expect(await salesSocket.next(isUpdate)).toMatchObject({
      fields: { [parent.id]: { id: a, title: null } },
    });
  });

  it('deletes a whole branch and restores it together', async () => {
    const x = await create('X', 'u_sales1');
    const y = await create('Y', 'u_sales1', x);
    const deleted = await fx.call('u_admin', 'DELETE', `/tables/${fx.orders.id}/records`, {
      ids: [x],
      children: 'delete',
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(deleted.json()).toEqual({ ids: [x, y] });
    const trash = await fx.call('u_admin', 'GET', `/tables/${fx.orders.id}/records/trash`);
    const trashed = recordTrashResponseSchema.parse(trash.json()).records;
    expect(trashed.find((record) => record.id === x)?.branch_size).toBe(1);
    const restored = records(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/records/restore`, {
        ids: [x],
        branch: true,
      }),
    );
    expect(restored.map((record) => record.id)).toEqual([x, y]);

    // Default: the child becomes a root.
    const single = await fx.call('u_admin', 'DELETE', `/tables/${fx.orders.id}/records/${x}`);
    expect(single.statusCode).toBe(204);
    const child = await fx.call('u_admin', 'GET', `/tables/${fx.orders.id}/records/${y}`);
    expect(child.json()).toMatchObject({ fields: { Parent: null } });
  });
});
