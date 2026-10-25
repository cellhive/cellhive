import {
  purgedRecordsResponseSchema,
  recordsResponseSchema,
  recordTrashResponseSchema,
  type Id,
  type RealtimeServerMessage,
  type RecordDto,
} from '@cellhive/contracts';
import {
  AttachmentsRepository,
  listExpiredAttachments,
  orgScope,
  SchemaService,
  systemAuditContext,
  type Db,
  type FieldRow,
} from '@cellhive/server-core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { closeSockets, listen, TestSocket } from './realtime-support.js';
import { buildRecordFixture, expectProblem, type RecordFixture } from './record-fixture.js';
import { startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';

import type { LightMyRequestResponse } from 'fastify';

/**
 * T408: permanent delete from the trash over HTTP — schema right (403) vs
 * not in the caller's trash (404), links cleaned on both sides, children
 * become roots or go with the branch, files handed to the cleanup (shared
 * objects kept), history `404` while the audit log keeps every entry, one
 * `record.purged` event/audit entry, realtime to trash viewers, tenants.
 */
describe('permanent delete from the trash (T408)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let url: string;
  let fx: RecordFixture;
  let customer: FieldRow;
  let parent: FieldRow;
  let files: FieldRow;
  let orders: string;
  const sockets: TestSocket[] = [];

  function records(response: LightMyRequestResponse): RecordDto[] {
    expect(response.statusCode, response.body).toBeLessThan(300);
    return recordsResponseSchema.parse(response.json()).records;
  }

  async function create(
    title: string,
    fields: Record<string, unknown> = {},
    parentId?: Id<'rec'>,
  ): Promise<Id<'rec'>> {
    const [record] = records(
      await fx.call('u_admin', 'POST', `${orders}?field_key_type=id`, {
        records: [
          {
            fields: { [fx.fld.title?.id ?? '']: title, ...fields },
            ...(parentId === undefined ? {} : { parent_id: parentId }),
          },
        ],
      }),
    );
    return record?.id as Id<'rec'>;
  }

  async function trash(ids: readonly Id<'rec'>[], children?: 'delete'): Promise<void> {
    const response = await fx.call('u_admin', 'DELETE', orders, {
      ids,
      ...(children === undefined ? {} : { children }),
    });
    expect(response.statusCode, response.body).toBe(200);
  }

  const purge = (user: Parameters<RecordFixture['call']>[0], body: unknown) =>
    fx.call(user, 'POST', `${orders}/trash/purge`, body);

  async function rowExists(id: Id<'rec'>): Promise<boolean> {
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM ${sql.table(`data.${fx.orders.db_table_name}`)}
       WHERE __id = ${id}
    `.execute(db.kysely);
    return rows[0]?.n === 1;
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    url = await listen(t.app);
    fx = await buildRecordFixture(t, db);
    orders = `/tables/${fx.orders.id}/records`;
    const schema = t.app.get(SchemaService);
    const scope = orgScope(fx.orgId);
    const context = systemAuditContext();
    customer = await schema.addField(
      scope,
      fx.orders.id,
      {
        name: 'customer',
        type: 'link',
        options: { link_table: fx.customers.id, bidirectional: true },
      },
      context,
    );
    parent = await schema.addField(
      scope,
      fx.orders.id,
      { name: 'Parent', type: 'parent', options: {} },
      context,
    );
    files = await schema.addField(
      scope,
      fx.orders.id,
      { name: 'files', type: 'attachment', options: {} },
      context,
    );
  });

  afterAll(async () => {
    await closeSockets(sockets);
    await t.close();
    await db.destroy();
    await database.drop();
  });

  it('403 without the schema right, 404 for what is not in the caller’s trash', async () => {
    const live = await create('live');
    const trashed = await create('trashed');
    await trash([trashed]);
    const body = { ids: [trashed] };
    // Not visible at all: another organization, no access to the base.
    expectProblem(await purge('stranger', body), 404, 'NOT_FOUND');
    expectProblem(await purge('u_out', body), 404, 'NOT_FOUND');
    // Visible without the schema right: reader, editor (who sees the trash), sales.
    expectProblem(await purge('u_reader', body), 403, 'PERMISSION_DENIED');
    expectProblem(await purge('u_editor', body), 403, 'PERMISSION_DENIED');
    expectProblem(await purge('u_sales1', body), 403, 'PERMISSION_DENIED');
    // Base admin: a live record or an unknown id is 404, like a missing one.
    const notTrashed = await purge('u_admin', { ids: [trashed, live] });
    expectProblem(notTrashed, 404, 'NOT_FOUND');
    expect(notTrashed.json()).toMatchObject({ errors: [{ path: 'ids[1]', code: 'NOT_FOUND' }] });
    expectProblem(await purge('u_admin', { ids: ['rec_0000000000000000'] }), 404, 'NOT_FOUND');
    expectProblem(await purge('u_admin', { ids: [] }), 422, 'VALIDATION_FAILED');
    // Nothing was deleted by the refused calls.
    expect(await rowExists(trashed)).toBe(true);
  });

  it('purges records: gone for good, history 404, audit log kept, one record.purged', async () => {
    const r1 = await create('p1');
    const r2 = await create('p2');
    await trash([r1, r2]);
    const response = await purge('u_admin', { ids: [r1, r2, r1] });
    expect(response.statusCode, response.body).toBe(200);
    expect(purgedRecordsResponseSchema.parse(response.json())).toEqual({ ids: [r1, r2] });
    expect(await rowExists(r1)).toBe(false);

    expectProblem(await fx.call('u_admin', 'GET', `${orders}/${r1}`), 404, 'NOT_FOUND');
    expectProblem(await fx.call('u_admin', 'GET', `${orders}/${r1}/history`), 404, 'NOT_FOUND');
    expectProblem(
      await fx.call('u_admin', 'POST', `${orders}/restore`, { ids: [r1] }),
      404,
      'NOT_FOUND',
    );
    // Purging again: no longer in the trash.
    expectProblem(await purge('u_admin', { ids: [r1] }), 404, 'NOT_FOUND');
    const listed = recordTrashResponseSchema.parse(
      (await fx.call('u_admin', 'GET', `${orders}/trash`)).json(),
    ).records;
    expect(listed.map((record) => record.id)).not.toContain(r1);

    // The audit log keeps the record's entries and gets one summary entry.
    const audit = await fx.call('owner', 'GET', `/bases/${fx.baseId}/audit-logs?entity_id=${r1}`);
    expect(audit.statusCode, audit.body).toBe(200);
    expect(
      audit
        .json<{ items: { action: string }[] }>()
        .items.map((item) => item.action)
        .sort(),
    ).toEqual(['record.created', 'record.deleted']);
    const purged = await fx.call(
      'owner',
      'GET',
      `/bases/${fx.baseId}/audit-logs?action=record.purged`,
    );
    const items = purged.json<{ items: Record<string, unknown>[] }>().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      entity_type: 'table',
      entity_id: fx.orders.id,
      table_id: fx.orders.id,
      actor: { type: 'user', id: fx.users.u_admin.id },
      before: null,
      after: { count: 2, record_ids: [r1, r2] },
    });
    const events = await db.kysely
      .selectFrom('meta.events')
      .select(['entity_type', 'entity_id', 'payload'])
      .where('organization_id', '=', fx.orgId)
      .where('type', '=', 'record.purged')
      .execute();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ entity_type: 'table', entity_id: fx.orders.id });
    expect(events[0]?.payload).toMatchObject({
      data: { count: 2, record_ids: [r1, r2], reason: 'manual' },
    });
  });

  it('replays the response for the same Idempotency-Key', async () => {
    const r = await create('idem');
    await trash([r]);
    const headers = { 'idempotency-key': 'purge-once-0001' };
    const first = await fx.call('u_admin', 'POST', `${orders}/trash/purge`, { ids: [r] }, headers);
    expect(first.statusCode, first.body).toBe(200);
    const again = await fx.call('u_admin', 'POST', `${orders}/trash/purge`, { ids: [r] }, headers);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());
  });

  it('removes links on both sides', async () => {
    const [c1] = records(
      await fx.call('u_admin', 'POST', `/tables/${fx.customers.id}/records`, {
        records: [{ fields: { Tên: 'Khách 1' } }],
      }),
    );
    const linked = await create('linked', { [customer.id]: [c1?.id] });
    const kept = await create('kept', { [customer.id]: [c1?.id] });
    await trash([linked]);
    expect((await purge('u_admin', { ids: [linked] })).statusCode).toBe(200);
    const { rows } = await sql<{ a_id: string; b_id: string }>`
      SELECT a_id, b_id FROM ${sql.table(`data.${customer.link_junction ?? ''}`)} ORDER BY a_id
    `.execute(db.kysely);
    expect(rows).toEqual([{ a_id: kept, b_id: c1?.id }]);
    // The customer's reverse cell lists only the live order.
    const reverse = await fx.call(
      'u_admin',
      'GET',
      `/tables/${fx.customers.id}/records/${c1?.id ?? ''}`,
    );
    const cells = Object.values(reverse.json<RecordDto>().fields).filter(Array.isArray);
    expect(cells).toContainEqual([{ id: kept, title: 'kept' }]);
  });

  it('purges a whole branch, or leaves the children as roots', async () => {
    const root = await create('root');
    const child = await create('child', {}, root);
    const grandchild = await create('grandchild', {}, child);
    await trash([root], 'delete');
    const branch = await purge('u_admin', { ids: [root], branch: true });
    expect(branch.json()).toEqual({ ids: [root, child, grandchild] });
    expect(await rowExists(grandchild)).toBe(false);

    const top = await create('top');
    const leaf = await create('leaf', {}, top);
    await trash([top], 'delete');
    expect((await purge('u_admin', { ids: [top] })).json()).toEqual({ ids: [top] });
    // The child stays in the trash, now a root; restored, it has no parent.
    records(await fx.call('u_admin', 'POST', `${orders}/restore`, { ids: [leaf] }));
    const got = await fx.call('u_admin', 'GET', `${orders}/${leaf}?field_key_type=id`);
    expect(got.json<RecordDto>().fields[parent.id] ?? null).toBeNull();
  });

  it('hands files to the cleanup; a copy on another record keeps the object', async () => {
    const scope = orgScope(fx.orgId);
    const repo = new AttachmentsRepository(db);
    const owner = await create('with file');
    const other = await create('with copy');
    const file = await repo.create(scope, {
      baseId: fx.baseId,
      tableId: fx.orders.id,
      fieldId: files.id,
      createdBy: fx.users.u_admin.id,
      filename: 'a.pdf',
      mime: 'application/pdf',
      size: 1,
    });
    await repo.markReady(scope, file.id, { size: 1, sha256: 'd'.repeat(64) });
    await repo.attach(scope, [file.id], owner);
    const ready = await repo.getById(scope, file.id);
    const copy = await repo.copyTo(scope, ready as NonNullable<typeof ready>, {
      recordId: other,
      createdBy: null,
    });
    await trash([owner]);
    expect((await purge('u_admin', { ids: [owner] })).statusCode).toBe(200);
    expect(await repo.getById(scope, file.id)).toMatchObject({ record_id: owner });
    expect((await repo.getById(scope, file.id))?.record_purged_at).not.toBeNull();
    expect((await repo.getById(scope, copy.id))?.record_purged_at).toBeNull();
    const early = new Date('2000-01-01T00:00:00.000Z');
    const expired = await listExpiredAttachments(db.kysely, {
      unattachedBefore: early,
      detachedBefore: early,
      limit: 100,
    });
    expect(expired.map((item) => item.id)).toEqual([file.id]);
    // A purged record's file is never attached again.
    await repo.attach(scope, [file.id], other);
    expect((await repo.getById(scope, file.id))?.record_id).toBe(owner);
  });

  it('realtime: trash viewers who read the record get record.purged', async () => {
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
    const admin = await connect('u_admin');
    const sales = await connect('u_sales1');
    const [hidden] = records(
      await fx.call('u_admin', 'POST', orders, {
        records: [{ fields: { title: 'rt', owner: [{ id: fx.users.u_sales2.id }] } }],
      }),
    );
    await trash([hidden?.id as Id<'rec'>]);
    expect((await purge('u_admin', { ids: [hidden?.id] })).statusCode).toBe(200);
    const isPurged = (message: RealtimeServerMessage) => message.type === 'record.purged';
    expect(await admin.next(isPurged)).toEqual({
      type: 'record.purged',
      channel: `table:${fx.orders.id}`,
      record_ids: [hidden?.id],
    });
    // u_sales1 never read this record (owner is u_sales2): nothing.
    await sales.expectNone(isPurged);
  });
});
