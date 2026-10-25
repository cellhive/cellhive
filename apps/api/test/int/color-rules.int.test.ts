import {
  createdShareLinkSchema,
  fieldSchema,
  recordListResponseSchema,
  recordsResponseSchema,
  shareMetaSchema,
  viewSchema,
  type ColorRuleInput,
  type Id,
  type RealtimeServerMessage,
  type RecordDto,
  type ViewDto,
} from '@cellhive/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ShareRateLimits } from '../../src/common/rate-limit/share-rate-limits.js';

import { Browser } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { closeSockets, listen, TestSocket } from './realtime-support.js';
import {
  buildRecordFixture,
  expectProblem,
  type FixtureUser,
  type RecordFixture,
} from './record-fixture.js';
import { startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

import type { Db } from '@cellhive/server-core';
import type { LightMyRequestResponse } from 'fastify';

/**
 * T816 (CONTRACTS §1.4, §7, §15, §16A; P76): color rules of a grid view are
 * evaluated by the server for each reader, in the same `records/query`
 * statement — a rule naming a field the reader cannot read never colors
 * anything for them (no "red row = cost > 100" oracle), through a share link
 * only rules within the link's scope apply, and realtime record messages
 * carry the colors of each subscriber.
 */
describe('color rules (T816, P76)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let url: string;
  let fx: RecordFixture;
  let anonymous: Browser;
  let orders: string;
  let view: ViewDto;
  let score: Id<'fld'>;
  const r = {} as Record<'r1' | 'r2', Id<'rec'>>;
  const sockets: TestSocket[] = [];

  const RULE = {
    cost: 'clr_CostRedAAAAAAAAA',
    done: 'clr_DoneGreenAAAAAAA',
    amount: 'clr_AmountBlueAAAAAA',
    score: 'clr_ScoreTealAAAAAAA',
  } as const;

  const F = (name: string): Id<'fld'> => {
    const field = fx.fld[name];
    if (field === undefined) throw new Error(`no field ${name}`);
    return field.id;
  };
  const option = (name: string): string => {
    const options = (fx.fld['status']?.options as { options: { id: string; name: string }[] })
      .options;
    const found = options.find((item) => item.name === name);
    if (found === undefined) throw new Error(`no option ${name}`);
    return found.id;
  };
  const owned = (user: FixtureUser) => ({ [F('owner')]: [{ id: fx.users[user].id }] });

  const rules = (): ColorRuleInput[] => [
    {
      id: RULE.cost,
      color: 'red',
      target: 'row',
      filter: { op: 'and', items: [{ field: F('cost'), operator: 'gt', value: 100 }] },
    },
    {
      id: RULE.done,
      color: 'green',
      target: 'row',
      filter: { op: 'and', items: [{ field: F('status'), operator: 'is', value: option('Xong') }] },
    },
    {
      id: RULE.amount,
      color: 'blue',
      target: 'cell',
      field_id: F('amount'),
      filter: { op: 'and', items: [{ field: F('amount'), operator: 'gte', value: 10 }] },
    },
    {
      id: RULE.score,
      color: 'teal',
      target: 'cell',
      field_id: F('title'),
      filter: { op: 'and', items: [{ field: score, operator: 'gt', value: 0 }] },
    },
  ];

  function records(response: LightMyRequestResponse): RecordDto[] {
    expect(response.statusCode, response.body).toBeLessThan(300);
    return recordsResponseSchema.parse(response.json()).records;
  }

  async function page(
    user: FixtureUser,
    body: Record<string, unknown> = { view_id: view.id },
  ): Promise<Map<string, RecordDto>> {
    const response = await fx.call(
      user,
      'POST',
      `/tables/${fx.orders.id}/records/query?field_key_type=id`,
      body,
    );
    expect(response.statusCode, response.body).toBe(200);
    const list = recordListResponseSchema.parse(response.json()).records;
    return new Map(list.map((record) => [record.id, record]));
  }

  async function viewAs(user: FixtureUser, viewId: string = view.id): Promise<ViewDto> {
    const response = await fx.call(user, 'GET', `/views/${viewId}`);
    expect(response.statusCode, response.body).toBe(200);
    return viewSchema.parse(response.json());
  }

  async function watch(user: FixtureUser): Promise<TestSocket> {
    const socket = await TestSocket.connect(url, {
      origin: TEST_PUBLIC_URL,
      cookie: await fx.cookie(user),
    });
    sockets.push(socket);
    expect(
      await socket.subscribe(`table:${fx.orders.id}`, 's1', { view: { id: view.id } }),
    ).toMatchObject({ type: 'subscribed' });
    return socket;
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    t.app.get(ShareRateLimits).read = { limit: 100_000, windowSeconds: 1 };
    url = await listen(t.app);
    fx = await buildRecordFixture(t, db);
    anonymous = new Browser(t.app);
    orders = `/tables/${fx.orders.id}/records?field_key_type=id`;
    const scoreField = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/fields`, {
      name: 'score',
      type: 'number',
    });
    expect(scoreField.statusCode, scoreField.body).toBe(201);
    score = fieldSchema.parse(scoreField.json()).id;
    const created = records(
      await fx.call('u_admin', 'POST', orders, {
        records: [
          {
            fields: {
              [F('title')]: 'r1',
              [F('cost')]: 200,
              [F('amount')]: 5,
              [F('status')]: option('Mới'),
              [score]: 1,
              ...owned('u_sales1'),
            },
          },
          {
            fields: {
              [F('title')]: 'r2',
              [F('cost')]: 50,
              [F('amount')]: 20,
              [F('status')]: option('Xong'),
              ...owned('u_sales1'),
            },
          },
        ],
      }),
    );
    r.r1 = created[0]?.id as Id<'rec'>;
    r.r2 = created[1]?.id as Id<'rec'>;
    const response = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/views`, {
      name: 'Colored',
      type: 'grid',
      config: { color_rules: rules() },
    });
    expect(response.statusCode, response.body).toBe(201);
    view = viewSchema.parse(response.json());
  });

  afterAll(async () => {
    await closeSockets(sockets);
    await t.close();
    await db.destroy();
    await database.drop();
  });

  it('stores the rules in order and returns them to someone who reads every field', () => {
    expect(view.config.color_rules?.map((rule) => rule.id)).toEqual([
      RULE.cost,
      RULE.done,
      RULE.amount,
      RULE.score,
    ]);
    expect(view.config.color_rules?.[1]).toEqual({
      id: RULE.done,
      enabled: true,
      filter: { op: 'and', items: [{ field: F('status'), operator: 'is', value: option('Xong') }] },
      color: 'green',
      target: 'row',
      field_id: null,
    });
  });

  it('leaves out of the config the rules on fields the reader cannot read', async () => {
    const sales = await viewAs('u_sales1');
    expect(sales.config.color_rules?.map((rule) => rule.id)).toEqual([
      RULE.done,
      RULE.amount,
      RULE.score,
    ]);
    expect(JSON.stringify(sales)).not.toContain(RULE.cost);
  });

  it('P76 (HTTP): colors per reader; the cost rule never reaches u_sales1', async () => {
    const admin = await page('u_admin');
    expect(admin.get(r.r1)?.meta).toEqual({
      color: { row: RULE.cost, cells: { [F('title')]: RULE.score } },
    });
    expect(admin.get(r.r2)?.meta).toEqual({
      color: { row: RULE.done, cells: { [F('amount')]: RULE.amount } },
    });
    const sales = await page('u_sales1');
    expect(sales.get(r.r1)?.meta).toEqual({ color: { cells: { [F('title')]: RULE.score } } });
    expect(sales.get(r.r2)?.meta).toEqual({
      color: { row: RULE.done, cells: { [F('amount')]: RULE.amount } },
    });
    // Without a view, or through a view without rules: no `meta`.
    const plain = await page('u_admin', {});
    expect(plain.get(r.r1)?.meta).toBeUndefined();
    // The list route and `ids` (realtime refetch) carry them as well.
    const listed = await fx.call(
      'u_sales1',
      'GET',
      `/tables/${fx.orders.id}/records?field_key_type=id&view_id=${view.id}`,
    );
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.body).not.toContain(RULE.cost);
    const byId = await page('u_admin', { view_id: view.id, ids: [r.r2] });
    expect([...byId.keys()]).toEqual([r.r2]);
    expect(byId.get(r.r2)?.meta?.color?.row).toBe(RULE.done);
  });

  it('saves a new order and enabled state; disabled rules color nothing', async () => {
    const sales = await viewAs('u_sales1');
    const sent = (sales.config.color_rules ?? []).map((rule) => ({
      ...rule,
      enabled: rule.id !== RULE.done,
    }));
    const saved = await fx.call('u_sales1', 'PATCH', `/views/${view.id}`, {
      config: { color_rules: sent },
    });
    // Sales may not edit a shared view: 403 (P17); the admin does it instead.
    expectProblem(saved, 403, 'PERMISSION_DENIED');
    const edited = await fx.call('u_admin', 'PATCH', `/views/${view.id}`, {
      config: { color_rules: sent.filter((rule) => rule.id !== RULE.score) },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(
      viewSchema.parse(edited.json()).config.color_rules?.map((rule) => [rule.id, rule.enabled]),
    ).toEqual([
      [RULE.done, false],
      [RULE.amount, true],
    ]);
    expect((await page('u_admin')).get(r.r2)?.meta).toEqual({
      color: { cells: { [F('amount')]: RULE.amount } },
    });
    // Restore the full list for the next tests.
    const restored = await fx.call('u_admin', 'PATCH', `/views/${view.id}`, {
      config: { color_rules: rules() },
    });
    expect(restored.statusCode, restored.body).toBe(200);
    expect((await page('u_admin')).get(r.r2)?.meta?.color?.row).toBe(RULE.done);
  });

  it('a personal copy holds only the rules its owner reads, in the order they save', async () => {
    const copy = await fx.call('u_sales1', 'POST', `/views/${view.id}/duplicate`, {
      is_personal: true,
    });
    expect(copy.statusCode, copy.body).toBe(201);
    const mine = viewSchema.parse(copy.json());
    expect(mine.config.color_rules?.map((rule) => rule.id)).toEqual([
      RULE.done,
      RULE.amount,
      RULE.score,
    ]);
    const reordered = await fx.call('u_sales1', 'PATCH', `/views/${mine.id}`, {
      config: { color_rules: [...(mine.config.color_rules ?? [])].reverse() },
    });
    expect(reordered.statusCode, reordered.body).toBe(200);
    const sales = await page('u_sales1', { view_id: mine.id });
    expect(sales.get(r.r2)?.meta).toEqual({
      color: { row: RULE.done, cells: { [F('amount')]: RULE.amount } },
    });
    // A rule on a field they cannot read is refused (no oracle by trial either).
    const refused = await fx.call('u_sales1', 'PATCH', `/views/${mine.id}`, {
      config: { color_rules: [rules()[0]] },
    });
    expectProblem(refused, 422, 'INVALID_FILTER');
  });

  it('P76 (share link): a link hiding cost never applies the cost rule', async () => {
    const hidden = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/views`, {
      name: 'Colored, cost hidden',
      type: 'grid',
      config: { color_rules: rules(), hidden_fields: [F('cost')] },
    });
    expect(hidden.statusCode, hidden.body).toBe(201);
    const hiddenView = viewSchema.parse(hidden.json());
    const created = await fx.call('u_editor', 'POST', `/views/${hiddenView.id}/share-links`, {
      audience: 'public',
    });
    expect(created.statusCode, created.body).toBe(201);
    const { token } = createdShareLinkSchema.parse(created.json());

    const meta = await anonymous.request({ method: 'GET', url: `/api/v1/shares/${token}/meta` });
    expect(meta.statusCode, meta.body).toBe(200);
    const shared = shareMetaSchema.parse(meta.json()).view.config.color_rules ?? [];
    expect(shared.map((rule) => rule.id)).toEqual([RULE.done, RULE.amount, RULE.score]);
    // No filter is ever returned through a link.
    expect(meta.body).not.toContain('"filter"');

    const query = await anonymous.request({
      method: 'POST',
      url: `/api/v1/shares/${token}/records/query?field_key_type=id`,
      payload: {},
    });
    expect(query.statusCode, query.body).toBe(200);
    const list = recordListResponseSchema.parse(query.json()).records;
    const byId = new Map(list.map((record) => [record.id, record]));
    expect(byId.get(r.r1)?.meta).toEqual({ color: { cells: { [F('title')]: RULE.score } } });
    expect(byId.get(r.r2)?.meta?.color?.row).toBe(RULE.done);
    expect(query.body).not.toContain(RULE.cost);
  });

  it('a rule naming a deleted field is broken: skipped, then mended by a restore', async () => {
    const removed = await fx.call('u_admin', 'DELETE', `/fields/${score}`);
    expect(removed.statusCode, removed.body).toBeLessThan(300);
    const broken = (await viewAs('u_admin')).config.color_rules?.find(
      (rule) => rule.id === RULE.score,
    );
    expect(broken).toMatchObject({ broken: true, filter: null, field_id: F('title') });
    expect((await page('u_admin')).get(r.r1)?.meta).toEqual({ color: { row: RULE.cost } });

    // Saving the list as read (reordering others) keeps the broken rule's stored filter.
    const current = (await viewAs('u_admin')).config.color_rules ?? [];
    const resaved = await fx.call('u_admin', 'PATCH', `/views/${view.id}`, {
      config: {
        color_rules: current.map((rule) => {
          const sent: Partial<typeof rule> = { ...rule };
          delete sent.broken;
          return sent;
        }),
      },
    });
    expect(resaved.statusCode, resaved.body).toBe(200);

    const restoredField = await fx.call('u_admin', 'POST', `/fields/${score}/restore`);
    expect(restoredField.statusCode, restoredField.body).toBeLessThan(300);
    const mended = (await viewAs('u_admin')).config.color_rules?.find(
      (rule) => rule.id === RULE.score,
    );
    expect(mended?.broken).toBeUndefined();
    expect((await page('u_admin')).get(r.r1)?.meta).toEqual({
      color: { row: RULE.cost, cells: { [F('title')]: RULE.score } },
    });
  });

  it('P76 (WS): a status change recolors each subscriber with their own rules', async () => {
    const admin = await watch('u_admin');
    const sales = await watch('u_sales1');
    records(
      await fx.call('u_editor', 'PATCH', orders, {
        records: [{ id: r.r1, fields: { [F('status')]: option('Xong') } }],
      }),
    );
    const updated = (message: RealtimeServerMessage) =>
      message.type === 'record.updated' && message.record_id === r.r1;
    const toAdmin = await admin.next(updated);
    const toSales = await sales.next(updated);
    expect('meta' in toAdmin ? toAdmin.meta : null).toEqual({
      color: { row: RULE.cost, cells: { [F('title')]: RULE.score } },
    });
    expect('meta' in toSales ? toSales.meta : null).toEqual({
      color: { row: RULE.done, cells: { [F('title')]: RULE.score } },
    });

    // A cost change: u_sales1 hears nothing (no oracle), the admin gets the new color.
    records(
      await fx.call('u_admin', 'PATCH', orders, {
        records: [{ id: r.r1, fields: { [F('cost')]: 10 } }],
      }),
    );
    const recolored = await admin.next(updated);
    expect('meta' in recolored ? recolored.meta : null).toEqual({
      color: { row: RULE.done, cells: { [F('title')]: RULE.score } },
    });
    await sales.expectNone((message) => 'record_id' in message && message.record_id === r.r1);
  });

  it('is a grid setting and the view stays 404 for those who cannot see it', async () => {
    const kanban = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/views`, {
      name: 'Board',
      type: 'kanban',
      config: { color_rules: [] },
    });
    expectProblem(kanban, 422, 'VALIDATION_FAILED');
    expectProblem(
      await fx.call('u_out', 'POST', `/tables/${fx.orders.id}/records/query`, {
        view_id: view.id,
      }),
      404,
      'NOT_FOUND',
    );
    expectProblem(
      await fx.call('stranger', 'POST', `/tables/${fx.orders.id}/records/query`, {
        view_id: view.id,
      }),
      404,
      'NOT_FOUND',
    );
  });
});
