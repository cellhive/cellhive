import {
  importUploadSchema,
  jobSchema,
  MAX_RECORD_FOLLOWS_PER_USER,
  newId,
  notificationSettingsSchema,
  recordFollowSchema,
  recordsResponseSchema,
  TOO_MANY_FOLLOWS,
  viewSchema,
  type Id,
  type JobDto,
  type RecordFollowDto,
} from '@cellhive/contracts';
import { orgScope, RecordFollowHooks, type Db } from '@cellhive/server-core';
import { createWorker, type WorkerHandle } from '@cellhive/worker';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Browser } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import {
  buildRecordFixture,
  expectProblem,
  type FixtureUser,
  type RecordFixture,
} from './record-fixture.js';
import { captureLogger, problemOf, startTestApp, type TestApp } from './support.js';

const BOUNDARY = 'cellhive-follow-boundary';

async function eventually<T>(
  probe: () => Promise<T | undefined>,
  label: string,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * BACKLOG T543 through the real API (CONTRACTS §22.3, §22.5; P39 API part):
 * `GET|PUT|DELETE /tables/:tableId/records/:recordId/follow` with read access
 * now or `404` (record, table, base, organization), CSRF, the cap
 * (`422 TOO_MANY_FOLLOWS`), "unfollowing by hand wins"; the creator of one
 * record created through the record API follows it unless
 * `auto_follow_created` is off — never for pastes, imports, form submissions
 * or automations (worker running); purges; the auto-follow switches of
 * `…/me/notification-settings`.
 */
describe('record follows (T543)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let worker: WorkerHandle;
  let r1: Id<'rec'>;
  let r2: Id<'rec'>;

  const F = (name: string) => fx.fld[name]?.id as Id<'fld'>;
  const followUrl = (recordId: string, tableId: string = fx.orders.id) =>
    `/tables/${tableId}/records/${recordId}/follow`;
  const me = (path: string) => `/orgs/${fx.orgId}/me${path}`;

  async function status(user: FixtureUser, recordId: Id<'rec'>): Promise<RecordFollowDto> {
    const response = await fx.call(user, 'GET', followUrl(recordId));
    expect(response.statusCode, response.body).toBe(200);
    return recordFollowSchema.parse(response.json());
  }

  async function createOrders(
    user: FixtureUser,
    records: { title: string; owner?: FixtureUser }[],
  ): Promise<Id<'rec'>[]> {
    const response = await fx.call(
      user,
      'POST',
      `/tables/${fx.orders.id}/records?field_key_type=id`,
      {
        records: records.map((record) => ({
          fields: {
            [F('title')]: record.title,
            ...(record.owner === undefined
              ? {}
              : { [F('owner')]: [{ id: fx.users[record.owner].id }] }),
          },
        })),
      },
    );
    expect(response.statusCode, response.body).toBe(201);
    return recordsResponseSchema.parse(response.json()).records.map((record) => record.id);
  }

  /** `{ fields }` alone: one record, `201` with the record itself. */
  async function createOne(
    user: FixtureUser,
    title: string,
    owner?: FixtureUser,
  ): Promise<Id<'rec'>> {
    const response = await fx.call(
      user,
      'POST',
      `/tables/${fx.orders.id}/records?field_key_type=id`,
      {
        fields: {
          [F('title')]: title,
          ...(owner === undefined ? {} : { [F('owner')]: [{ id: fx.users[owner].id }] }),
        },
      },
    );
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ id: Id<'rec'> }>().id;
  }

  async function followRows(where: {
    user?: FixtureUser;
    tableId?: Id<'tbl'>;
    recordIds?: Id<'rec'>[];
  }) {
    let query = db.kysely
      .selectFrom('meta.record_follows')
      .select(['record_id', 'user_id', 'source', 'muted'])
      .where('organization_id', '=', fx.orgId);
    if (where.user !== undefined) query = query.where('user_id', '=', fx.users[where.user].id);
    if (where.tableId !== undefined) query = query.where('table_id', '=', where.tableId);
    if (where.recordIds !== undefined) {
      if (where.recordIds.length === 0) return [];
      query = query.where('record_id', 'in', where.recordIds);
    }
    return query.orderBy('record_id').orderBy('user_id').execute();
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    fx = await buildRecordFixture(t, db);
    worker = await createWorker(t.config, { logger: captureLogger().logger, pollIntervalMs: 100 });
    r1 = await createOne('u_admin', 'Đơn R1', 'u_sales1');
    r2 = await createOne('u_admin', 'Đơn R2', 'u_sales2');
  });

  afterAll(async () => {
    await worker.close();
    await t.close();
    await db.destroy();
    await database.drop();
  });

  it('P39 (API part): u_sales1 → r2 404, r1 204; u_out and another organization → 404', async () => {
    for (const method of ['GET', 'PUT', 'DELETE'] as const) {
      expectProblem(await fx.call('u_sales1', method, followUrl(r2)), 404, 'NOT_FOUND');
      // u_out is a member without access to the base; stranger is in another organization.
      expectProblem(await fx.call('u_out', method, followUrl(r1)), 404, 'NOT_FOUND');
      expectProblem(await fx.call('stranger', method, followUrl(r1)), 404, 'NOT_FOUND');
      // A record id under another table, an unknown record.
      expectProblem(
        await fx.call('u_admin', method, followUrl(r1, fx.customers.id)),
        404,
        'NOT_FOUND',
      );
      expectProblem(await fx.call('u_admin', method, followUrl(newId('rec'))), 404, 'NOT_FOUND');
      expectProblem(
        await fx.call('u_admin', method, followUrl(r1, newId('tbl'))),
        404,
        'NOT_FOUND',
      );
    }
    expect(await followRows({ recordIds: [r2], user: 'u_sales1' })).toEqual([]);

    expect(await status('u_sales1', r1)).toEqual({ following: false, source: null });
    const put = await fx.call('u_sales1', 'PUT', followUrl(r1));
    expect(put.statusCode, put.body).toBe(204);
    expect(put.body).toBe('');
    expect(await status('u_sales1', r1)).toEqual({ following: true, source: 'manual' });
    // Idempotent.
    expect((await fx.call('u_sales1', 'PUT', followUrl(r1))).statusCode).toBe(204);
    expect(await followRows({ recordIds: [r1], user: 'u_sales1' })).toEqual([
      { record_id: r1, user_id: fx.users.u_sales1.id, source: 'manual', muted: false },
    ]);
    // A reader follows any record they read.
    expect((await fx.call('u_reader', 'PUT', followUrl(r2))).statusCode).toBe(204);
    expect(await status('u_reader', r2)).toEqual({ following: true, source: 'manual' });
  });

  it('validates the path (422) and needs the CSRF token (403)', async () => {
    for (const method of ['GET', 'PUT', 'DELETE'] as const) {
      expectProblem(
        await fx.call('u_admin', method, `/tables/${fx.orders.id}/records/not-a-record/follow`),
        422,
        'VALIDATION_FAILED',
      );
      expectProblem(
        await fx.call('u_admin', method, `/tables/nope/records/${r1}/follow`),
        422,
        'VALIDATION_FAILED',
      );
    }
    const browser = new Browser(t.app);
    expect((await browser.login(fx.users.u_reader.email)).statusCode).toBe(204);
    for (const method of ['PUT', 'DELETE'] as const) {
      const response = await browser.request({
        method,
        url: `/api/v1${followUrl(r1)}`,
        csrf: false,
      });
      expectProblem(response, 403, 'CSRF_INVALID');
    }
    expect(await followRows({ recordIds: [r1], user: 'u_reader' })).toEqual([]);
    // Signed out: 401.
    const anonymous = await t.app.inject({ method: 'GET', url: `/api/v1${followUrl(r1)}` });
    expect(anonymous.statusCode).toBe(401);
  });

  it('creating one record through the API: the creator follows it (created), others do not', async () => {
    expect(await status('u_admin', r1)).toEqual({ following: true, source: 'created' });
    const mine = await createOne('u_editor', 'By hand');
    expect(await status('u_editor', mine)).toEqual({ following: true, source: 'created' });
    expect(await status('u_admin', mine)).toEqual({ following: false, source: null });
    // `{ records: [one] }` is one record too.
    const [listed] = await createOrders('u_editor', [{ title: 'One of one' }]);
    expect(await status('u_editor', listed as Id<'rec'>)).toEqual({
      following: true,
      source: 'created',
    });
    // PUT keeps the source.
    expect((await fx.call('u_editor', 'PUT', followUrl(mine))).statusCode).toBe(204);
    expect(await status('u_editor', mine)).toEqual({ following: true, source: 'created' });
  });

  it('pasting two records (one call): nobody follows them', async () => {
    const ids = await createOrders('u_editor', [{ title: 'Paste 1' }, { title: 'Paste 2' }]);
    expect(ids).toHaveLength(2);
    expect(await followRows({ recordIds: ids })).toEqual([]);
  });

  it('auto_follow_created off: no follow; the settings API reads and writes the switches', async () => {
    const initial = notificationSettingsSchema.parse(
      (await fx.call('u_editor', 'GET', me('/notification-settings'))).json(),
    );
    expect(initial).toMatchObject({ auto_follow_created: true, auto_follow_assigned: true });
    const off = await fx.call('u_editor', 'PUT', me('/notification-settings'), {
      auto_follow_created: false,
    });
    expect(off.statusCode, off.body).toBe(200);
    expect(notificationSettingsSchema.parse(off.json())).toEqual({
      email_frequency: 'immediate',
      daily_hour: 8,
      muted_bases: [],
      auto_follow_created: false,
      auto_follow_assigned: true,
    });
    const quiet = await createOne('u_editor', 'Not followed');
    expect(await status('u_editor', quiet)).toEqual({ following: false, source: null });

    // Email settings alone keep the switches; the switches alone keep the email settings.
    const daily = await fx.call('u_editor', 'PUT', me('/notification-settings'), {
      email_frequency: 'daily',
      daily_hour: 6,
    });
    expect(notificationSettingsSchema.parse(daily.json())).toMatchObject({
      email_frequency: 'daily',
      daily_hour: 6,
      auto_follow_created: false,
      auto_follow_assigned: true,
    });
    const both = await fx.call('u_editor', 'PUT', me('/notification-settings'), {
      auto_follow_created: true,
      auto_follow_assigned: false,
    });
    expect(notificationSettingsSchema.parse(both.json())).toMatchObject({
      email_frequency: 'daily',
      daily_hour: 6,
      auto_follow_created: true,
      auto_follow_assigned: false,
    });
    const followedAgain = await createOne('u_editor', 'Followed again');
    expect(await status('u_editor', followedAgain)).toEqual({
      following: true,
      source: 'created',
    });
    for (const body of [
      {},
      { auto_follow_created: 'no' },
      { auto_follow_assigned: null },
      { auto_follow_commented: true },
    ]) {
      expectProblem(
        await fx.call('u_editor', 'PUT', me('/notification-settings'), body),
        422,
        'VALIDATION_FAILED',
      );
    }
    // Only the caller's own settings; a non-member of the organization gets 404.
    expect(
      notificationSettingsSchema.parse(
        (await fx.call('u_sales1', 'GET', me('/notification-settings'))).json(),
      ),
    ).toMatchObject({ auto_follow_created: true, auto_follow_assigned: true });
    expectProblem(
      await fx.call('stranger', 'PUT', me('/notification-settings'), {
        auto_follow_created: false,
      }),
      404,
      'NOT_FOUND',
    );
    await fx.call('u_editor', 'PUT', me('/notification-settings'), {
      email_frequency: 'immediate',
      daily_hour: 8,
      auto_follow_assigned: true,
    });
  });

  it('unfollowing wins: editing the record or an automatic source never follows again; PUT does', async () => {
    const rec = await createOne('u_editor', 'Unfollow me');
    expect((await fx.call('u_editor', 'DELETE', followUrl(rec))).statusCode).toBe(204);
    expect((await fx.call('u_editor', 'DELETE', followUrl(rec))).statusCode).toBe(204);
    expect(await status('u_editor', rec)).toEqual({ following: false, source: null });
    const edit = await fx.call(
      'u_editor',
      'PATCH',
      `/tables/${fx.orders.id}/records/${rec}?field_key_type=id`,
      { fields: { [F('title')]: 'Unfollow me, edited' } },
    );
    expect(edit.statusCode, edit.body).toBe(200);
    expect(await status('u_editor', rec)).toEqual({ following: false, source: null });
    // Being assigned later (T544's automatic source) does not follow it again.
    const hooks = new RecordFollowHooks(db);
    expect(
      await db.withTx((tx) =>
        hooks.autoFollow(orgScope(fx.orgId, tx), {
          tableId: fx.orders.id,
          userId: fx.users.u_editor.id,
          recordIds: [rec],
          source: 'assigned',
        }),
      ),
    ).toEqual([]);
    expect(await status('u_editor', rec)).toEqual({ following: false, source: null });
    expect((await fx.call('u_editor', 'PUT', followUrl(rec))).statusCode).toBe(204);
    expect(await status('u_editor', rec)).toEqual({ following: true, source: 'manual' });
    // Unfollowing a record never followed is fine too.
    expect((await fx.call('u_reader', 'DELETE', followUrl(rec))).statusCode).toBe(204);
  });

  it('the trash hides the record (404); a purge deletes its follows', async () => {
    const rec = await createOne('u_editor', 'Purge me');
    expect((await fx.call('u_reader', 'PUT', followUrl(rec))).statusCode).toBe(204);
    const trashed = await fx.call('u_admin', 'DELETE', `/tables/${fx.orders.id}/records`, {
      ids: [rec],
    });
    expect(trashed.statusCode, trashed.body).toBe(200);
    for (const method of ['GET', 'PUT', 'DELETE'] as const) {
      expectProblem(await fx.call('u_reader', method, followUrl(rec)), 404, 'NOT_FOUND');
    }
    expect(await followRows({ recordIds: [rec] })).toHaveLength(2);
    const purged = await fx.call('u_admin', 'POST', `/tables/${fx.orders.id}/records/trash/purge`, {
      ids: [rec],
    });
    expect(purged.statusCode, purged.body).toBe(200);
    expect(await followRows({ recordIds: [rec] })).toEqual([]);
  });

  it(`the cap: following record ${String(MAX_RECORD_FOLLOWS_PER_USER + 1)} is 422 TOO_MANY_FOLLOWS`, async () => {
    const rec = await createOne('u_admin', 'Capped', 'u_sales2');
    await sql`
      INSERT INTO meta.record_follows (organization_id, table_id, record_id, user_id, source)
      SELECT ${fx.orgId}, ${fx.customers.id}, 'rec_' || lpad(i::text, 16, '0'),
             ${fx.users.u_sales2.id}, 'manual'
        FROM generate_series(1, ${MAX_RECORD_FOLLOWS_PER_USER}) AS i
    `.execute(db.kysely);
    const refused = await fx.call('u_sales2', 'PUT', followUrl(rec));
    expectProblem(refused, 422, 'VALIDATION_FAILED');
    expect(problemOf(refused.body).errors).toEqual([
      expect.objectContaining({
        path: 'record_id',
        code: TOO_MANY_FOLLOWS,
        params: { maximum: MAX_RECORD_FOLLOWS_PER_USER },
      }),
    ]);
    expect(await status('u_sales2', rec)).toEqual({ following: false, source: null });
    // An unfollowed record does not count.
    await db.kysely
      .updateTable('meta.record_follows')
      .set({ muted: true })
      .where('table_id', '=', fx.customers.id)
      .where('record_id', '=', `rec_${'1'.padStart(16, '0')}`)
      .execute();
    expect((await fx.call('u_sales2', 'PUT', followUrl(rec))).statusCode).toBe(204);
    await db.kysely
      .deleteFrom('meta.record_follows')
      .where('table_id', '=', fx.customers.id)
      .execute();
  });

  it('imports and form submissions: nobody follows the records they create', async () => {
    const before = await followRows({ user: 'u_editor' });

    // A one-row CSV import (a user acting, but through the import job).
    const csv = Buffer.from('title\r\nImported order\r\n');
    const upload = await fx.call(
      'u_editor',
      'POST',
      `/bases/${fx.baseId}/imports/uploads`,
      Buffer.concat([
        Buffer.from(
          `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="orders.csv"\r\n` +
            'Content-Type: text/csv\r\n\r\n',
        ),
        csv,
        Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
      ]),
      { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    );
    expect(upload.statusCode, upload.body).toBe(201);
    const file = importUploadSchema.parse(upload.json());
    const started = await fx.call('u_editor', 'POST', `/bases/${fx.baseId}/imports`, {
      upload_id: file.id,
      mode: 'append',
      table_id: fx.orders.id,
      mapping: [{ column: 0, field_id: F('title') }],
    });
    expect(started.statusCode, started.body).toBe(202);
    const jobId = started.json<{ job_id: Id<'job'> }>().job_id;
    const job = await eventually<JobDto>(async () => {
      const current = jobSchema.parse((await fx.call('u_editor', 'GET', `/jobs/${jobId}`)).json());
      return ['succeeded', 'failed', 'cancelled'].includes(current.status) ? current : undefined;
    }, `import ${jobId}`);
    expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
    expect(job.result).toMatchObject({ imported: 1 });

    // A member form submission.
    const view = await fx.call('owner', 'POST', `/tables/${fx.orders.id}/views`, {
      name: 'Order form',
      type: 'form',
      config: { form: { fields: [{ field: F('title'), required: true }] } },
    });
    expect(view.statusCode, view.body).toBe(201);
    const form = viewSchema.parse(view.json());
    const submitted = await fx.call('u_editor', 'POST', `/views/${form.id}/submit`, {
      fields: { [F('title')]: 'From the form' },
    });
    expect(submitted.statusCode, submitted.body).toBe(200);

    expect(await followRows({ user: 'u_editor' })).toEqual(before);
  });

  it('automations: the records an automation creates are followed by nobody', async () => {
    const created = await fx.call('u_admin', 'POST', `/bases/${fx.baseId}/automations`, {
      name: 'Copy orders',
      enabled: true,
      definition: {
        trigger: { type: 'record.created', table_id: fx.orders.id },
        actions: [
          {
            id: 'act_1',
            type: 'create_record',
            config: {
              table_id: fx.customers.id,
              fields: { [F('customerName')]: { literal: 'Từ automation' } },
            },
          },
        ],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const automationId = created.json<{ id: Id<'aut'> }>().id;
    const order = await createOne('u_editor', 'Starts the automation');
    expect(await status('u_editor', order)).toEqual({ following: true, source: 'created' });
    await eventually(async () => {
      const { rows } = await sql<{ status: string }>`
        SELECT status FROM meta.automation_runs WHERE automation_id = ${automationId}
      `.execute(db.kysely);
      return rows.some((row) => row.status === 'succeeded') ? true : undefined;
    }, 'the automation run');
    const customers = await fx.call('u_admin', 'POST', `/tables/${fx.customers.id}/records/query`, {
      search: 'Từ automation',
    });
    expect(customers.statusCode, customers.body).toBe(200);
    expect(customers.json<{ records: unknown[] }>().records.length).toBeGreaterThan(0);
    expect(await followRows({ tableId: fx.customers.id })).toEqual([]);
    expect(
      (await fx.call('u_admin', 'POST', `/automations/${automationId}/disable`)).statusCode,
    ).toBe(200);
  });
});
