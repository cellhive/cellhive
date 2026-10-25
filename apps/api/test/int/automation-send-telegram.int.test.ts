import {
  baseSecretListSchema,
  newId,
  secretListSchema,
  secretSchema,
  type Id,
  type SecretDto,
} from '@cellhive/contracts';
import {
  AutomationRunEngine,
  AutomationRunsRepository,
  AutomationRunStepsRepository,
  AutomationsRepository,
  createSendTelegramAction,
  defaultActionRegistry,
  NO_AUTOMATION_NOTIFICATIONS,
  orgScope,
  RecordMutationService,
  RecordQueryService,
  type Db,
  type DeferrableJob,
  type JsonObject,
} from '@cellhive/server-core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DB } from '../../src/common/tokens.js';

import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import {
  buildRecordFixture,
  expectProblem,
  type FixtureUser,
  type RecordFixture,
} from './record-fixture.js';
import { problemOf, startTestApp, TEST_PUBLIC_URL, type TestApp } from './support.js';
import { startFakeTelegram, type FakeTelegram } from './telegram-support.js';

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0';
const OTHER_TOKEN = '987654321:BBHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw9';

function jobOf(orgId: Id<'org'>, runId: Id<'run'>): DeferrableJob {
  return {
    task_identifier: 'automation.run',
    payload: { organization_id: orgId, run_id: runId },
    priority: 0,
    attempts: 1,
    max_attempts: 25,
    key: null,
    flags: null,
    queue_name: null,
  };
}

/**
 * BACKLOG T516: organization secrets (Telegram bot tokens) through the API
 * — owner/admin management, base scope, names only for automation managers,
 * `409` while in use, values never in a response, the audit log or the logs
 * — and the `send_telegram` handler of the run engine against a fake Bot
 * API (HTML escaping of values, `429 retry_after`, other 4xx, scope change).
 */
describe('send_telegram and organization secrets (T516)', () => {
  let database: TestDatabase;
  let db: Db;
  let appDb: Db;
  let t: TestApp;
  let fx: RecordFixture;
  let telegram: FakeTelegram;
  let records: RecordMutationService;
  let query: RecordQueryService;
  let otherBase: Id<'bse'>;

  const F = (name: string) => fx.fld[name]?.id as Id<'fld'>;
  const scope = () => orgScope(fx.orgId);

  function engine(now?: () => Date): AutomationRunEngine {
    return new AutomationRunEngine(appDb, {
      defaults: { timeZone: 'Asia/Ho_Chi_Minh', locale: 'vi' },
      query,
      actions: defaultActionRegistry({ records, query }, [
        [
          'send_telegram',
          createSendTelegramAction({
            db: appDb,
            masterKey: t.config.security.appMasterKey,
            client: { baseUrl: telegram.baseUrl },
          }),
        ],
      ]),
      publicUrl: TEST_PUBLIC_URL,
      notifier: NO_AUTOMATION_NOTIFICATIONS,
      random: () => 0,
      ...(now === undefined ? {} : { now }),
    });
  }

  async function createSecret(
    body: Record<string, unknown>,
    as: FixtureUser = 'owner',
  ): Promise<SecretDto> {
    const response = await fx.call(as, 'POST', `/orgs/${fx.orgId}/secrets`, {
      kind: 'telegram_bot',
      value: TOKEN,
      ...body,
    });
    expect(response.statusCode, response.body).toBe(201);
    return secretSchema.parse(response.json());
  }

  async function createRecord(fields: Record<string, unknown>): Promise<Id<'rec'>> {
    const response = await fx.call(
      'u_admin',
      'POST',
      `/tables/${fx.orders.id}/records?field_key_type=id`,
      { records: [{ fields }] },
    );
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{ records: { id: Id<'rec'> }[] }>().records[0]?.id as Id<'rec'>;
  }

  const telegramStep = (secretId: Id<'sec'>, config: Record<string, unknown> = {}) => ({
    id: 'act_tg',
    type: 'send_telegram',
    config: {
      secret_id: secretId,
      chat_id: { literal: '-100123456' },
      text: { template: `✅ <b>{{ [${F('title')}] }}</b> xong` },
      ...config,
    },
  });

  /** An enabled automation (run as u_admin) and one `queued` run on `recordId`. */
  async function queuedRun(
    actions: unknown[],
    recordId: Id<'rec'> | null,
  ): Promise<{ automationId: Id<'aut'>; runId: Id<'run'> }> {
    const trigger =
      recordId === null
        ? { type: 'schedule', cron: '0 8 * * *', timezone: null }
        : { type: 'record.created', table_id: fx.orders.id, skip_bulk: false };
    const definition = { trigger, condition: null, actions } as unknown as JsonObject;
    const automationId = newId('aut');
    await new AutomationsRepository(db).insert(scope(), {
      id: automationId,
      baseId: fx.baseId,
      name: 'Báo Telegram',
      description: '',
      enabled: true,
      definition,
      triggerType: trigger.type,
      triggerTableId: recordId === null ? null : fx.orders.id,
      createdBy: fx.users.u_admin.id,
    });
    const runId = newId('run');
    await new AutomationRunsRepository(db).insert(scope(), {
      id: runId,
      automationId,
      automationVersion: 1,
      triggerEventId: null,
      triggerUnit: newId('evt'),
      status: 'queued',
      depth: 0,
      input: {
        automation_version: 1,
        definition,
        trigger: {
          event_id: null,
          event_created_at: null,
          type: trigger.type,
          table_id: recordId === null ? null : fx.orders.id,
          record_id: recordId,
          bulk: false,
          batch: null,
          ...(recordId === null ? { fired_at: new Date().toISOString() } : {}),
        },
      },
    });
    return { automationId, runId };
  }

  const execute = (runId: Id<'run'>, now?: () => Date) =>
    engine(now).execute(scope(), runId, jobOf(fx.orgId, runId));
  const stepOf = async (runId: Id<'run'>) =>
    (await new AutomationRunStepsRepository(db).listByRun(scope(), runId)).at(-1);

  beforeAll(async () => {
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    t = await startTestApp({ DATABASE_URL: database.url });
    appDb = t.app.get<Db>(DB);
    fx = await buildRecordFixture(t, db);
    records = t.app.get(RecordMutationService);
    query = t.app.get(RecordQueryService);
    telegram = await startFakeTelegram();
    const workspace = await db.kysely
      .selectFrom('meta.bases')
      .select('workspace_id')
      .where('id', '=', fx.baseId)
      .executeTakeFirstOrThrow();
    const base = await fx.call('owner', 'POST', `/workspaces/${workspace.workspace_id}/bases`, {
      name: 'Hỗ trợ',
    });
    expect(base.statusCode, base.body).toBe(201);
    otherBase = base.json<{ id: Id<'bse'> }>().id;
  });

  afterAll(async () => {
    await telegram.close();
    await t.close();
    await db.destroy();
    await database.drop();
  });

  describe('secrets API (owner/admin)', () => {
    it('stores a bot token sealed and never returns, audits or logs it', async () => {
      const bot = await createSecret({ name: 'Bot Kinh doanh' });
      expect(bot).toMatchObject({
        kind: 'telegram_bot',
        name: 'Bot Kinh doanh',
        base_scope: 'all',
        base_ids: [],
        created_by: { id: fx.users.owner.id, name: 'Owner' },
      });
      const list = await fx.call('owner', 'GET', `/orgs/${fx.orgId}/secrets`);
      expect(list.statusCode).toBe(200);
      expect(secretListSchema.parse(list.json()).items.map((item) => item.id)).toContain(bot.id);
      for (const body of [JSON.stringify(bot), list.body]) {
        expect(body).not.toContain(TOKEN);
        expect(body).not.toContain('AAHdqTcv');
      }
      const row = await db.kysely
        .selectFrom('meta.secrets')
        .select('ciphertext')
        .where('id', '=', bot.id)
        .executeTakeFirstOrThrow();
      expect(row.ciphertext).not.toContain('AAHdqTcv');
      const { rows } = await sql<{ action: string; after: unknown }>`
        SELECT action, after FROM meta.audit_logs
        WHERE organization_id = ${fx.orgId} AND entity_id = ${bot.id}
      `.execute(db.kysely);
      expect(rows).toEqual([
        {
          action: 'secret.created',
          after: { kind: 'telegram_bot', name: 'Bot Kinh doanh', base_scope: 'all', base_ids: [] },
        },
      ]);
      // Replacing the value is audited without it.
      const patched = await fx.call('owner', 'PATCH', `/secrets/${bot.id}`, {
        value: OTHER_TOKEN,
      });
      expect(patched.statusCode, patched.body).toBe(200);
      const { rows: updates } = await sql<{ after: Record<string, unknown> }>`
        SELECT after FROM meta.audit_logs
        WHERE organization_id = ${fx.orgId} AND entity_id = ${bot.id} AND action = 'secret.updated'
      `.execute(db.kysely);
      expect(updates[0]?.after).toMatchObject({ value_replaced: true });
      expect(JSON.stringify(updates)).not.toContain('BBHdqTcv');
      expect(t.logs.raw()).not.toContain('AAHdqTcv');
      expect(t.logs.raw()).not.toContain('BBHdqTcv');
      const back = await fx.call('owner', 'PATCH', `/secrets/${bot.id}`, { value: TOKEN });
      expect(back.statusCode).toBe(200);
    });

    it.each([
      ['a malformed token', { name: 'Sai', value: 'not-a-token' }, 'INVALID_BOT_TOKEN'],
      ['a taken name (any case)', { name: 'bot KINH DOANH' }, 'SECRET_NAME_TAKEN'],
      [
        'a base of another organization',
        { name: 'Khác', base_scope: 'selected', base_ids: ['bse_NotInThisOrg0001'] },
        'UNKNOWN_BASE',
      ],
    ])('refuses %s (422)', async (_name, body, code) => {
      const response = await fx.call('owner', 'POST', `/orgs/${fx.orgId}/secrets`, {
        kind: 'telegram_bot',
        value: TOKEN,
        ...body,
      });
      expectProblem(response, 422, 'VALIDATION_FAILED');
      expect(problemOf(response.body)['errors']).toEqual([expect.objectContaining({ code })]);
      expect(response.body).not.toContain('AAHdqTcv');
    });

    it('is for organization owners/admins only: members 403 (base admin too), others 404', async () => {
      const bot = await createSecret({ name: 'Bot quyền' });
      for (const user of ['u_admin', 'u_reader'] as const) {
        expectProblem(
          await fx.call(user, 'GET', `/orgs/${fx.orgId}/secrets`),
          403,
          'PERMISSION_DENIED',
        );
        expectProblem(
          await fx.call(user, 'POST', `/orgs/${fx.orgId}/secrets`, {
            kind: 'telegram_bot',
            name: 'X',
            value: TOKEN,
          }),
          403,
          'PERMISSION_DENIED',
        );
        expectProblem(
          await fx.call(user, 'PATCH', `/secrets/${bot.id}`, { name: 'Y' }),
          403,
          'PERMISSION_DENIED',
        );
        expectProblem(
          await fx.call(user, 'DELETE', `/secrets/${bot.id}`),
          403,
          'PERMISSION_DENIED',
        );
      }
      // Another organization's owner: the secret does not exist for them.
      expectProblem(
        await fx.call('stranger', 'GET', `/orgs/${fx.orgId}/secrets`),
        404,
        'NOT_FOUND',
      );
      expectProblem(
        await fx.call('stranger', 'PATCH', `/secrets/${bot.id}`, { name: 'Y' }),
        404,
        'NOT_FOUND',
      );
      expectProblem(await fx.call('stranger', 'DELETE', `/secrets/${bot.id}`), 404, 'NOT_FOUND');
      expectProblem(
        await fx.call('stranger', 'GET', `/secrets/${bot.id}/usages`),
        404,
        'NOT_FOUND',
      );
    });

    it('lists bots by name to automation managers of a base in scope only', async () => {
      const sales = await createSecret({
        name: 'Bot chỉ Hỗ trợ',
        base_scope: 'selected',
        base_ids: [otherBase],
      });
      const response = await fx.call(
        'u_admin',
        'GET',
        `/bases/${fx.baseId}/secrets?kind=telegram_bot`,
      );
      expect(response.statusCode, response.body).toBe(200);
      const items = baseSecretListSchema.parse(response.json()).items;
      expect(items.map((item) => item.name)).toContain('Bot Kinh doanh');
      expect(items.map((item) => item.id)).not.toContain(sales.id);
      for (const item of items) expect(Object.keys(item).sort()).toEqual(['id', 'kind', 'name']);
      // Reads the base but manages no automation → 403; outside the base → 404.
      expectProblem(
        await fx.call('u_reader', 'GET', `/bases/${fx.baseId}/secrets`),
        403,
        'PERMISSION_DENIED',
      );
      expectProblem(
        await fx.call('stranger', 'GET', `/bases/${fx.baseId}/secrets`),
        404,
        'NOT_FOUND',
      );
    });

    it('checks the bot when an automation is saved, and refuses to delete it while used (409)', async () => {
      const bot = await createSecret({ name: 'Bot đang dùng' });
      const elsewhere = await createSecret({
        name: 'Bot nơi khác',
        base_scope: 'selected',
        base_ids: [otherBase],
      });
      const save = (secretId: Id<'sec'>) =>
        fx.call('u_admin', 'POST', `/bases/${fx.baseId}/automations`, {
          name: 'Báo nhóm',
          definition: {
            trigger: { type: 'record.created', table_id: fx.orders.id },
            actions: [telegramStep(secretId)],
          },
        });
      const refused = await save(elsewhere.id);
      expectProblem(refused, 422, 'AUTOMATION_INVALID');
      expect(problemOf(refused.body)['errors']).toEqual([
        expect.objectContaining({
          path: 'definition.actions[0].config.secret_id',
          code: 'SECRET_NOT_USABLE',
        }),
      ]);
      const saved = await save(bot.id);
      expect(saved.statusCode, saved.body).toBe(201);
      const automationId = saved.json<{ id: Id<'aut'> }>().id;

      const blocked = await fx.call('owner', 'DELETE', `/secrets/${bot.id}`);
      expectProblem(blocked, 409, 'SECRET_IN_USE');
      expect(problemOf(blocked.body)['errors']).toEqual([
        expect.objectContaining({
          code: 'SECRET_IN_USE',
          params: {
            usages: [
              {
                kind: 'automation',
                automation_id: automationId,
                base_id: fx.baseId,
                name: 'Báo nhóm',
              },
            ],
            total: 1,
          },
        }),
      ]);
      const usages = await fx.call('owner', 'GET', `/secrets/${bot.id}/usages`);
      expect(usages.json()).toEqual({
        items: [
          {
            kind: 'automation',
            automation_id: automationId,
            base_id: fx.baseId,
            name: 'Báo nhóm',
          },
        ],
        total: 1,
      });

      expect((await fx.call('u_admin', 'DELETE', `/automations/${automationId}`)).statusCode).toBe(
        204,
      );
      expect((await fx.call('owner', 'DELETE', `/secrets/${bot.id}`)).statusCode).toBe(204);
      const { rows } = await sql<{ action: string }>`
        SELECT action FROM meta.audit_logs WHERE entity_id = ${bot.id} ORDER BY created_at
      `.execute(db.kysely);
      expect(rows.map((row) => row.action)).toEqual(['secret.created', 'secret.deleted']);
    });
  });

  describe('run (handler, fake Bot API)', () => {
    let bot: SecretDto;

    beforeAll(async () => {
      bot = await createSecret({ name: 'Bot chạy' });
    });

    it('sends HTML with every record value escaped: a <b> in a record shows as text', async () => {
      const recordId = await createRecord({ [F('title')]: '<b>Gấp</b> & "nhanh"' });
      const { runId } = await queuedRun([telegramStep(bot.id)], recordId);
      const before = telegram.calls.length;
      expect(await execute(runId)).toEqual({ status: 'succeeded' });
      const call = telegram.calls[before];
      expect(call).toEqual({
        token: TOKEN,
        method: 'sendMessage',
        body: {
          chat_id: '-100123456',
          text: '✅ <b>&lt;b&gt;Gấp&lt;/b&gt; &amp; &quot;nhanh&quot;</b> xong',
          parse_mode: 'HTML',
        },
      });
      const step = await stepOf(runId);
      expect(step?.status).toBe('succeeded');
      expect(step?.output).toEqual({
        message_id: expect.any(Number) as number,
        secret_id: bot.id,
        length: Array.from(String(call?.body['text'])).length,
        truncated: false,
      });
      expect(JSON.stringify(step)).not.toContain('Gấp');
      expect(JSON.stringify(step)).not.toContain('-100123456');
      expect(t.logs.raw()).not.toContain('AAHdqTcv');
    });

    it('a chat id from a field and a digest of find_records', async () => {
      const chat = await fx.call('owner', 'POST', `/tables/${fx.orders.id}/fields`, {
        name: 'chat',
        type: 'text',
      });
      expect(chat.statusCode, chat.body).toBe(201);
      const chatField = chat.json<{ id: Id<'fld'> }>().id;
      const recordId = await createRecord({ [F('title')]: 'Có chat', [chatField]: '@ops_alerts' });
      const find = {
        id: 'act_find',
        type: 'find_records',
        config: {
          table_id: fx.orders.id,
          filter: { field: F('title'), operator: 'contains', value: '<i>' },
          fields: [F('title')],
          limit: 10,
        },
      };
      await createRecord({ [F('title')]: 'Dòng <i>1</i>' });
      const { runId } = await queuedRun(
        [
          find,
          telegramStep(bot.id, {
            chat_id: { field: chatField },
            text: {
              template: '<b>Danh sách</b>\n{{ [@digest] }}',
              digest: {
                step: 'act_find',
                row_template: `• <i>{{ [${F('title')}] }}</i>`,
                max_rows: 50,
                separator: '\n',
              },
            },
          }),
        ],
        recordId,
      );
      const before = telegram.calls.length;
      expect(await execute(runId)).toEqual({ status: 'succeeded' });
      expect(telegram.calls[before]?.body).toMatchObject({
        chat_id: '@ops_alerts',
        text: '<b>Danh sách</b>\n• <i>Dòng &lt;i&gt;1&lt;/i&gt;</i>',
      });
    });

    it('429: retried after retry_after, then sent', async () => {
      const recordId = await createRecord({ [F('title')]: 'Chậm lại' });
      const { runId } = await queuedRun([telegramStep(bot.id)], recordId);
      telegram.queue({
        status: 429,
        body: {
          ok: false,
          error_code: 429,
          description: 'Too Many Requests: retry after 42',
          parameters: { retry_after: 42 },
        },
      });
      const now = new Date();
      const first = await execute(runId, () => now);
      expect(first).toEqual({ status: 'retry_scheduled', step: 'act_tg', delayMs: 42_000 });
      expect(await stepOf(runId)).toMatchObject({
        status: 'failed',
        error: {
          code: 'telegram_rate_limited',
          params: { status: 429, retry_after_ms: 42_000 },
          retry_at: new Date(now.getTime() + 42_000).toISOString(),
        },
      });
      expect(await execute(runId)).toEqual({ status: 'succeeded' });
      expect((await stepOf(runId))?.status).toBe('succeeded');
    });

    it('another 4xx fails the step at once (no retry); the automation stays on', async () => {
      const recordId = await createRecord({ [F('title')]: 'Không có chat' });
      const { automationId, runId } = await queuedRun([telegramStep(bot.id)], recordId);
      telegram.queue({
        status: 400,
        body: { ok: false, error_code: 400, description: 'Bad Request: chat not found' },
      });
      expect(await execute(runId)).toMatchObject({ status: 'failed', code: 'telegram_rejected' });
      expect((await stepOf(runId))?.error).toMatchObject({
        code: 'telegram_rejected',
        params: { status: 400, error_code: 400 },
        attempt: 1,
      });
      expect((await stepOf(runId))?.error).not.toHaveProperty('retry_at');
      expect((await new AutomationsRepository(db).get(scope(), automationId))?.enabled).toBe(true);
    });

    it('a scope that leaves the base out: secret_unavailable, the automation stays on', async () => {
      const scoped = await createSecret({ name: 'Bot đổi phạm vi' });
      const recordId = await createRecord({ [F('title')]: 'Ngoài phạm vi' });
      const { automationId, runId } = await queuedRun([telegramStep(scoped.id)], recordId);
      const patched = await fx.call('owner', 'PATCH', `/secrets/${scoped.id}`, {
        base_scope: 'selected',
        base_ids: [otherBase],
      });
      expect(patched.statusCode, patched.body).toBe(200);
      const before = telegram.calls.length;
      expect(await execute(runId)).toMatchObject({ status: 'failed', code: 'secret_unavailable' });
      expect(telegram.calls).toHaveLength(before);
      expect((await new AutomationsRepository(db).get(scope(), automationId))?.enabled).toBe(true);
    });

    it('an empty chat id fails with invalid_chat_id before calling Telegram', async () => {
      const recordId = await createRecord({ [F('title')]: 'Không chat' });
      const chatField = (
        await db.kysely
          .selectFrom('meta.fields')
          .select('id')
          .where('table_id', '=', fx.orders.id)
          .where('name', '=', 'chat')
          .executeTakeFirstOrThrow()
      ).id;
      const { runId } = await queuedRun(
        [telegramStep(bot.id, { chat_id: { field: chatField } })],
        recordId,
      );
      const before = telegram.calls.length;
      expect(await execute(runId)).toMatchObject({ status: 'failed', code: 'invalid_chat_id' });
      expect(telegram.calls).toHaveLength(before);
    });
  });
});
