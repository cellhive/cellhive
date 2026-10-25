import {
  createdShareLinkSchema,
  newId,
  recordSummariesResponseSchema,
  recordsResponseSchema,
  viewSchema,
  type Id,
  type ViewDto,
} from '@cellhive/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Browser } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { buildRecordFixture, expectProblem, type RecordFixture } from './record-fixture.js';
import { startTestApp, type TestApp } from './support.js';

import type { Db } from '@cellhive/server-core';
import type { LightMyRequestResponse } from 'fastify';

/**
 * T472 over HTTP (CONTRACTS §1.4 `records/summaries`, §15 `config.summaries`,
 * §16A): the record rule of the reader (u_sales1 summarises their own
 * orders), `no_perm` fields (request → `422`, saved → left out), saving the
 * summaries into the view (view editors only; others see them), the share
 * route (fields of the link only, viewer summaries need
 * `allow_viewer_filter_sort`) and `404` for tables out of reach.
 */
describe('records/summaries over HTTP (T472)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let view: ViewDto;
  const fid = (name: string): string => fx.fld[name]?.id ?? '';

  const summaries = (
    user: Parameters<RecordFixture['call']>[0],
    body: object,
    tableId: string = fx.orders.id,
    query = '',
  ) => fx.call(user, 'POST', `/tables/${tableId}/records/summaries${query}`, body);
  const ok = (response: LightMyRequestResponse) => {
    expect(response.statusCode, response.body).toBe(200);
    return recordSummariesResponseSchema.parse(response.json());
  };
  const values = (response: LightMyRequestResponse) =>
    Object.fromEntries(
      Object.entries(ok(response).summaries).map(([key, item]) => [key, item.value]),
    );

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    fx = await buildRecordFixture(t, db);
    const created = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/records`, {
      records: [
        {
          fields: {
            title: 'o1',
            amount: 1000,
            cost: 10,
            status: 'Mới',
            owner: [{ id: fx.users.u_sales1.id }],
          },
        },
        {
          fields: {
            title: 'o2',
            amount: 500,
            cost: 20,
            status: 'Xong',
            owner: [{ id: fx.users.u_sales2.id }],
          },
        },
        { fields: { title: 'o3', amount: 250, cost: 30, owner: [{ id: fx.users.u_sales1.id }] } },
      ],
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(recordsResponseSchema.parse(created.json()).records).toHaveLength(3);
    const response = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/views`, {
      name: 'Summaries',
      type: 'grid',
    });
    expect(response.statusCode, response.body).toBe(201);
    view = viewSchema.parse(response.json());
  });

  afterAll(async () => {
    await t.close();
    await db.destroy();
    await database.drop();
  });

  it('summarises every order for an admin, only their own for u_sales1 (record rule)', async () => {
    expect(
      values(
        await summaries('u_admin', { summaries: { amount: 'sum', cost: 'sum', owner: 'unique' } }),
      ),
    ).toEqual({ amount: 1750, cost: 60, owner: 2 });
    const sales = await summaries('u_sales1', { summaries: { amount: 'sum', owner: 'unique' } });
    expect(ok(sales).count).toBe(2);
    expect(values(sales)).toEqual({ amount: 1250, owner: 1 });
    // `cost` is no_perm for Sales: named in a request it does not exist.
    expectProblem(
      await summaries('u_sales1', { summaries: { cost: 'sum' } }),
      422,
      'VALIDATION_FAILED',
    );
    // A function the type does not take.
    expectProblem(
      await summaries('u_admin', { summaries: { title: 'sum' } }),
      422,
      'VALIDATION_FAILED',
    );
    // Unknown function names fail the contract.
    expectProblem(
      await summaries('u_admin', { summaries: { amount: 'median' } }),
      422,
      'VALIDATION_FAILED',
    );
  });

  it('text cells and groups: values formatted, every group level summarised', async () => {
    const text = ok(
      await summaries(
        'u_admin',
        { summaries: { amount: 'avg' } },
        fx.orders.id,
        '?cell_format=text',
      ),
    );
    expect(typeof text.summaries['amount']?.value).toBe('string');
    const grouped = ok(
      await summaries('u_admin', {
        group: [{ field: 'status', direction: 'asc' }],
        summaries: { amount: 'sum' },
      }),
    );
    expect(
      grouped.groups.map((group) => [group.values, group.count, group.summaries['amount']?.value]),
    ).toEqual([
      [['Mới'], 1, 1000],
      [['Xong'], 1, 500],
      [[null], 1, 250],
    ]);
  });

  it('saved into the view by a view editor; others see and use them; no_perm entries left out', async () => {
    const saved = await fx.call('u_admin', 'PATCH', `/views/${view.id}`, {
      config: { summaries: { [fid('amount')]: 'sum', [fid('cost')]: 'sum' } },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(viewSchema.parse(saved.json()).config.summaries).toEqual({
      [fid('amount')]: 'sum',
      [fid('cost')]: 'sum',
    });
    const editorView = await fx.call('u_editor', 'GET', `/views/${view.id}`);
    expect(viewSchema.parse(editorView.json()).config.summaries).toEqual({
      [fid('amount')]: 'sum',
      [fid('cost')]: 'sum',
    });
    // u_sales1 does not read `cost`: left out of the config and of the summaries.
    const salesView = await fx.call('u_sales1', 'GET', `/views/${view.id}`);
    expect(viewSchema.parse(salesView.json()).config.summaries).toEqual({
      [fid('amount')]: 'sum',
    });
    expect(values(await summaries('u_sales1', { view_id: view.id }))).toEqual({ amount: 1250 });
    expect(
      values(await summaries('u_admin', { view_id: view.id }, fx.orders.id, '?field_key_type=id')),
    ).toEqual({ [fid('amount')]: 1750, [fid('cost')]: 60 });
    // Saving needs view editing rights (a temporary change does not).
    expectProblem(
      await fx.call('u_reader', 'PATCH', `/views/${view.id}`, {
        config: { summaries: { [fid('amount')]: 'avg' } },
      }),
      403,
      'PERMISSION_DENIED',
    );
    expect(
      values(await summaries('u_reader', { view_id: view.id, summaries: { amount: 'avg' } })),
    ).toEqual({ amount: 1750 / 3 });
    // A function the field type does not take is refused when saving.
    const invalid = await fx.call('u_admin', 'PATCH', `/views/${view.id}`, {
      config: { summaries: { [fid('title')]: 'sum' } },
    });
    expectProblem(invalid, 422, 'VALIDATION_FAILED');
    expect(invalid.json<{ errors: { path: string; code: string }[] }>().errors).toEqual([
      expect.objectContaining({
        path: `config.summaries.${fid('title')}`,
        code: 'INVALID_FIELD_TYPE',
      }),
    ]);
    // Kanban and form views have no summary bar.
    expectProblem(
      await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/views`, {
        name: 'Board',
        type: 'kanban',
        config: { summaries: {} },
      }),
      422,
      'VALIDATION_FAILED',
    );
  });

  it('share links: fields of the link only; viewer summaries need allow_viewer_filter_sort', async () => {
    const created = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/views`, {
      name: 'Shared',
      type: 'grid',
      config: {
        hidden_fields: [fid('cost')],
        summaries: {
          [fid('amount')]: 'sum',
          [fid('cost')]: 'sum',
          [fid('owner')]: 'unique',
        },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const shared = viewSchema.parse(created.json());
    const linkOf = async (allow: boolean) => {
      const response = await fx.call('u_admin', 'POST', `/views/${shared.id}/share-links`, {
        audience: 'public',
        settings: { allow_viewer_filter_sort: allow },
      });
      expect(response.statusCode, response.body).toBe(201);
      return createdShareLinkSchema.parse(response.json()).token;
    };
    const anonymous = new Browser(t.app);
    const share = (token: string, body: object) =>
      anonymous.request({
        method: 'POST',
        url: `/api/v1/shares/${token}/records/summaries`,
        payload: body,
      });
    const fixed = await linkOf(false);
    // `cost` is hidden in the view: outside the link.
    expect(values(await share(fixed, {}))).toEqual({ amount: 1750, owner: 2 });
    expectProblem(await share(fixed, { summaries: { amount: 'avg' } }), 403, 'PERMISSION_DENIED');
    const open = await linkOf(true);
    expect(values(await share(open, { summaries: { amount: 'avg' } }))).toEqual({
      amount: 1750 / 3,
    });
    expectProblem(await share(open, { summaries: { cost: 'sum' } }), 422, 'VALIDATION_FAILED');
    // No `view_id` through a link.
    expectProblem(await share(open, { view_id: view.id }), 422, 'VALIDATION_FAILED');
  });

  it('tables out of reach are 404 (another organization, no role, unknown id)', async () => {
    expectProblem(await summaries('stranger', {}), 404, 'NOT_FOUND');
    expectProblem(await summaries('u_out', {}), 404, 'NOT_FOUND');
    expectProblem(await summaries('u_admin', {}, newId('tbl')), 404, 'NOT_FOUND');
    // A view of another table is 404 too.
    expectProblem(
      await summaries('u_admin', { view_id: view.id }, fx.customers.id),
      404,
      'NOT_FOUND',
    );
  });

  it('ignores Idempotency-Key (a read)', async () => {
    const response = await fx.call(
      'u_admin',
      'POST',
      `/tables/${fx.orders.id}/records/summaries`,
      { summaries: { amount: 'max' } },
      { 'idempotency-key': 'summaries-1' },
    );
    expect(values(response)).toEqual({ amount: 1000 });
    expect(response.headers['idempotent-replayed']).toBeUndefined();
  });
});

export type { Id };
