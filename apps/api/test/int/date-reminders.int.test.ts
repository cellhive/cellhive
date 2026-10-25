import {
  fieldSchema,
  notificationListSchema,
  notificationPreferencesSchema,
  roleListSchema,
  type Id,
  type NotificationDto,
} from '@cellhive/contracts';
import {
  DateReminderScanner,
  orgScope,
  SchemaService,
  systemAuditContext,
  type Db,
} from '@cellhive/server-core';
import { createWorker, type WorkerHandle } from '@cellhive/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import {
  buildRecordFixture,
  expectProblem,
  type FixtureUser,
  type RecordFixture,
} from './record-fixture.js';
import { captureLogger, problemOf, startTestApp, type TestApp } from './support.js';

async function eventually<T>(
  probe: () => Promise<T | undefined | false>,
  label: string,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * BACKLOG T547 through the real HTTP API and the real worker: saving
 * `datetime.options.reminder` needs the right to change the schema (`403`
 * for an editor or a reader, `404` for another organization, `422` with
 * `options.reminder.*` paths for references outside the table or the
 * organization), `date.reminder` shows in the notification settings, and
 * reminders queued by the scanner (injected clock, dates far from the real
 * one so the worker's own cron never reaches them) reach exactly the
 * recipients who read the record and the date field when sent (P41), the
 * `field_user` recipient being the owner **at that moment**.
 */
describe('date reminders through the API (T547)', () => {
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let worker: WorkerHandle;
  let scanner: DateReminderScanner;
  let due: Id<'fld'>;
  let deadline: Id<'fld'>;

  const F = (name: string) => fx.fld[name]?.id as Id<'fld'>;
  const me = (path = '') => `/orgs/${fx.orgId}/me${path}`;

  async function patchField(user: FixtureUser, fieldId: Id<'fld'>, options: object) {
    return fx.call(user, 'PATCH', `/fields/${fieldId}`, { options });
  }

  async function createOrder(fields: Record<string, unknown>): Promise<Id<'rec'>> {
    const response = await fx.call(
      'u_admin',
      'POST',
      `/tables/${fx.orders.id}/records?field_key_type=id`,
      { records: [{ fields }] },
    );
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ records: { id: Id<'rec'> }[] }>().records[0]?.id as Id<'rec'>;
  }

  async function reminders(user: FixtureUser): Promise<NotificationDto[]> {
    const response = await fx.call(user, 'GET', me('/notifications'));
    expect(response.statusCode, response.body).toBe(200);
    return notificationListSchema
      .parse(response.json())
      .items.filter((item) => item.type === 'date.reminder');
  }

  async function settledFanout(): Promise<void> {
    await eventually(async () => {
      const rows = await db.kysely
        .selectFrom('graphile_worker.jobs' as never)
        .select('id' as never)
        .where('task_identifier' as never, '=', 'notifications.fanout' as never)
        .execute();
      return rows.length === 0;
    }, 'fan-out jobs done');
  }

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    fx = await buildRecordFixture(t, db);
    const schema = t.app.get(SchemaService);
    const scope = orgScope(fx.orgId);
    due = (
      await schema.addField(
        scope,
        fx.orders.id,
        {
          name: 'due',
          type: 'datetime',
          options: { style: { format: 'yyyy-MM-dd' }, timezone: 'Asia/Ho_Chi_Minh' },
        },
        systemAuditContext(),
      )
    ).id;
    deadline = (
      await schema.addField(
        scope,
        fx.orders.id,
        { name: 'deadline', type: 'datetime', options: { style: { format: 'yyyy-MM-dd HH:mm' } } },
        systemAuditContext(),
      )
    ).id;
    scanner = new DateReminderScanner(db, {
      defaults: { timeZone: t.config.defaults.timezone, locale: t.config.defaults.locale },
      schema,
    });
    worker = await createWorker(t.config, { logger: captureLogger().logger, pollIntervalMs: 50 });
  });

  afterAll(async () => {
    await worker.close();
    await t.close();
    await db.destroy();
    await database.drop();
  });

  it('needs the right to change the schema: 403 editor/reader, 404 elsewhere', async () => {
    const reminder = { recipients: 'users', user_ids: [fx.users.u_reader.id] };
    expectProblem(await patchField('u_editor', due, { reminder }), 403, 'PERMISSION_DENIED');
    expectProblem(await patchField('u_reader', due, { reminder }), 403, 'PERMISSION_DENIED');
    expectProblem(await patchField('stranger', due, { reminder }), 404, 'NOT_FOUND');
    const field = await fx.call('u_admin', 'GET', `/fields/${due}`);
    expect(fieldSchema.parse(field.json()).options).not.toHaveProperty('reminder');
  });

  it('422 for references outside the table or the organization, and malformed reminders', async () => {
    const cases: [object, string, string | null][] = [
      [
        { recipients: 'field_user', user_field_id: F('ticketStatus') },
        'options.reminder.user_field_id',
        'UNKNOWN_FIELD',
      ],
      [
        { recipients: 'field_user', user_field_id: F('amount') },
        'options.reminder.user_field_id',
        'INVALID_FIELD_TYPE',
      ],
      [
        { recipients: 'users', user_ids: [fx.users.u_reader.id, fx.users.stranger.id] },
        'options.reminder.user_ids[1]',
        'USER_NOT_FOUND',
      ],
      [{ recipients: 'users', user_ids: [] }, 'options.reminder.user_ids', null],
      [{ recipients: 'everyone' }, 'options.reminder.recipients', null],
    ];
    for (const [reminder, path, code] of cases) {
      const response = await patchField('u_admin', due, { reminder });
      expectProblem(response, 422, 'VALIDATION_FAILED');
      const errors = (problemOf(response.body).errors ?? []) as { path: string; code: string }[];
      expect(errors.map((item) => item.path)).toContain(path);
      if (code !== null) expect(errors.map((item) => item.code)).toContain(code);
    }
    const timeOfDay = await patchField('u_admin', deadline, {
      reminder: { recipients: 'users', user_ids: [fx.users.u_reader.id], time_of_day: '09:00' },
    });
    expectProblem(timeOfDay, 422, 'VALIDATION_FAILED');
    expect(
      (problemOf(timeOfDay.body).errors as { path: string }[]).map((item) => item.path),
    ).toEqual(['options.reminder.time_of_day']);
  });

  it('lists date.reminder in the notification settings (email on by default)', async () => {
    const response = await fx.call('u_reader', 'GET', me('/notification-preferences'));
    const items = notificationPreferencesSchema.parse(response.json()).items;
    expect(items).toContainEqual({
      type: 'date.reminder',
      channel: 'in_app',
      enabled: true,
      locked: false,
    });
    expect(items).toContainEqual(
      expect.objectContaining({ type: 'date.reminder', channel: 'email' }),
    );
  });

  it('P41: users [u_sales1, u_reader] — each gets only the reminders of records and a date field they read', async () => {
    const saved = await patchField('u_admin', due, {
      reminder: {
        recipients: 'users',
        user_ids: [fx.users.u_sales1.id, fx.users.u_reader.id],
        offset_minutes: -1440,
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(fieldSchema.parse(saved.json()).options['reminder']).toEqual({
      offset_minutes: -1440,
      time_of_day: null,
      recipients: 'users',
      user_ids: [fx.users.u_sales1.id, fx.users.u_reader.id],
    });
    const r1 = await createOrder({
      [F('title')]: 'P41 r1',
      [F('owner')]: [{ id: fx.users.u_sales1.id }],
      [due]: '2027-03-10',
    });
    const r2 = await createOrder({
      [F('title')]: 'P41 r2',
      [F('owner')]: [{ id: fx.users.u_sales2.id }],
      [due]: '2027-03-10',
    });
    // 2027-03-09 09:00 in Ho Chi Minh City = 02:00 UTC.
    expect(
      await scanner.scanField(
        { organizationId: fx.orgId, fieldId: due },
        new Date('2027-03-09T01:59:00Z'),
      ),
    ).toMatchObject({ outcome: 'idle' });
    expect(
      await scanner.scanField(
        { organizationId: fx.orgId, fieldId: due },
        new Date('2027-03-09T02:00:00Z'),
      ),
    ).toMatchObject({ outcome: 'reminded', reminders: 2 });
    await settledFanout();
    const forReader = await eventually(async () => {
      const items = await reminders('u_reader');
      return items.length === 2 ? items : undefined;
    }, 'reader reminders');
    expect(forReader.map((item) => item.entity.id).sort()).toEqual([r1, r2].sort());
    const one = forReader.find((item) => item.entity.id === r1);
    expect(one).toMatchObject({
      table_id: fx.orders.id,
      entity: { type: 'record', id: r1, title: 'P41 r1' },
      actor: null,
      data: { field_id: due, due_at: '2027-03-09T02:00:00.000Z', value: '2027-03-10' },
    });
    // u_sales1 reads its own order only.
    expect((await reminders('u_sales1')).map((item) => item.entity.id)).toEqual([r1]);
    // Nobody else was named.
    expect(await reminders('u_sales2')).toEqual([]);
    expect(await reminders('u_admin')).toEqual([]);
  });

  it('field_user: a recipient who cannot read the recipient field is not reminded (QA T559)', async () => {
    const schema = t.app.get(SchemaService);
    const scope = orgScope(fx.orgId);
    const watchers = (
      await schema.addField(
        scope,
        fx.orders.id,
        { name: 'watchers', type: 'user', options: { multiple: true } },
        systemAuditContext(),
      )
    ).id;
    const checkpoint = (
      await schema.addField(
        scope,
        fx.orders.id,
        {
          name: 'checkpoint',
          type: 'datetime',
          options: { style: { format: 'yyyy-MM-dd HH:mm' } },
        },
        systemAuditContext(),
      )
    ).id;
    // Sales cannot read `watchers`: being in it is not to be disclosed (as for assignments).
    const roles = roleListSchema.parse(
      (await fx.call('u_admin', 'GET', `/bases/${fx.baseId}/roles`)).json(),
    ).items;
    const sales = roles.find((role) => role.name === 'Sales');
    const tables = sales?.config.tables as Record<string, Record<string, unknown>>;
    const orders = tables[fx.orders.id] ?? {};
    const rule = orders['field_rule'] as { fields: Record<string, string> };
    const patchedRole = await fx.call(
      'u_admin',
      'PATCH',
      `/bases/${fx.baseId}/roles/${String(sales?.id)}`,
      {
        config: {
          ...sales?.config,
          tables: {
            ...tables,
            [fx.orders.id]: {
              ...orders,
              field_rule: { ...rule, fields: { ...rule.fields, [watchers]: 'no_perm' } },
            },
          },
        },
      },
    );
    expect(patchedRole.statusCode, patchedRole.body).toBe(200);
    const saved = await patchField('u_admin', checkpoint, {
      reminder: { recipients: 'field_user', user_field_id: watchers },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const record = await createOrder({
      [F('title')]: 'watched',
      [F('owner')]: [{ id: fx.users.u_sales1.id }],
      [watchers]: [{ id: fx.users.u_sales1.id }, { id: fx.users.u_reader.id }],
      [checkpoint]: '2027-05-01T10:00:00.000Z',
    });
    expect(
      await scanner.scanField(
        { organizationId: fx.orgId, fieldId: checkpoint },
        new Date('2027-05-01T10:00:00Z'),
      ),
    ).toMatchObject({ outcome: 'reminded', reminders: 1 });
    await settledFanout();
    await eventually(
      async () =>
        (await reminders('u_reader')).some((item) => item.entity.id === record) || undefined,
      'reader reminder',
    );
    // u_sales1 reads the order and the date, not `watchers`.
    expect((await reminders('u_sales1')).map((item) => item.entity.id)).not.toContain(record);
  });

  it('field_user = owner: the owner when the reminder fires, 15 minutes before', async () => {
    const saved = await patchField('u_admin', deadline, {
      reminder: { recipients: 'field_user', user_field_id: F('owner'), offset_minutes: -15 },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const record = await createOrder({
      [F('title')]: 'handed over',
      [F('owner')]: [{ id: fx.users.u_sales1.id }],
      [deadline]: '2027-04-01T10:00:00.000Z',
    });
    const patched = await fx.call(
      'u_admin',
      'PATCH',
      `/tables/${fx.orders.id}/records?field_key_type=id`,
      { records: [{ id: record, fields: { [F('owner')]: [{ id: fx.users.u_sales2.id }] } }] },
    );
    expect(patched.statusCode, patched.body).toBe(200);
    expect(
      await scanner.scanField(
        { organizationId: fx.orgId, fieldId: deadline },
        new Date('2027-04-01T09:45:00Z'),
      ),
    ).toMatchObject({ outcome: 'reminded', reminders: 1 });
    await settledFanout();
    const got = await eventually(async () => {
      const items = (await reminders('u_sales2')).filter((item) => item.entity.id === record);
      return items.length === 1 ? items : undefined;
    }, 'owner reminder');
    expect(got[0]?.data).toEqual({
      field_id: deadline,
      due_at: '2027-04-01T09:45:00.000Z',
      value: '2027-04-01T10:00:00.000Z',
    });
    expect((await reminders('u_sales1')).map((item) => item.entity.id)).not.toContain(record);
    // Turning it off over the API removes the reminder.
    const off = await patchField('u_admin', deadline, { reminder: null });
    expect(off.statusCode, off.body).toBe(200);
    expect(
      await scanner.scanField(
        { organizationId: fx.orgId, fieldId: deadline },
        new Date('2027-04-02T00:00:00Z'),
      ),
    ).toMatchObject({ outcome: 'turned_off' });
  });
});
