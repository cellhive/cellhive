/**
 * Opt-in notification bench (BACKLOG T557, S5b): `NOTIFICATION_BENCH=1 pnpm
 * --filter @cellhive/api test:int test/int/notifications.bench` — its own
 * Testcontainers database, the API and a real worker, and reports:
 *
 * 1. an import of 5 000 rows assigning 50 people (`record.assigned` gathered
 *    by `batch.id` = the import job): import time, time from the job's end to
 *    the 50 notifications, `notifications.flush`/`notifications.fanout`
 *    jobs run (expected: one flush, no fan-out — one notification each);
 * 2. 1 000 single edits by the owner of records each followed by 10 people
 *    (`record.followed_changed`, 60 s debounce per record): edit time, then
 *    the flush lag = notification written − (edit + 60 s), p50/p95/max, and
 *    the flush jobs run;
 * 3. the date reminder scan over 20 `datetime` fields of one table of
 *    200 000 rows (records created through `RecordMutationService`, their
 *    events settled like `seed:bench`): one `notifications.date_reminder_scan`
 *    job end to end (scan + fan-out + notifications) for a one-minute and a
 *    one-hour window per field, cursors moved back by SQL.
 *
 * T560 (S5b retrospective) adds: the automatic follows written by the
 * import; `RecordFollowHooks.autoFollow` of 10 000 records for one person
 * (up to the 10 000 cap) and once more at the cap; one edit of a record
 * followed by 500 people (`record.followed_changed` fan-out); Telegram
 * delivery of one notification to 200 linked members (worker with the
 * Valkey pacers of production, fake Bot API): throughput, most `sendMessage`
 * calls in any sliding second (cap 25 per bot) and the per-chat gap
 * (1 per second per chat) for 20 members notified 3 times.
 *
 * Load convention of the S4b/S5 benches: it runs only when the 1-minute load
 * (`uptime`) is below 8; otherwise it prints PENDING with this command and
 * skips. The load is printed with every number. Never fails on the numbers
 * (only on wrong results).
 */
import { loadavg } from 'node:os';
import { performance } from 'node:perf_hooks';
import { Writable } from 'node:stream';

import {
  importUploadSchema,
  jobSchema,
  MAX_RECORD_FOLLOWS_PER_USER,
  newId,
  type Id,
} from '@cellhive/contracts';
import {
  BaseRoleMembersRepository,
  BaseRolesRepository,
  createValkeyTelegramPacers,
  NotificationFanout,
  orgScope,
  RecordFollowHooks,
  RecordMutationService,
  RecordQueryService,
  SchemaService,
  settleEventsWithoutAutomations,
  systemAuditContext,
  TelegramChatAddress,
  UserChannelsRepository,
  valkeyQuotaClient,
  type Db,
} from '@cellhive/server-core';
import { buildTaskList, createWorker, type WorkerHandle } from '@cellhive/worker';
import { sql } from 'kysely';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CACHE_CLIENT, DB } from '../../src/common/tokens.js';
import { insertInBatches, ownerAccessContext } from '../../src/seed/record-seeding.js';

import { Browser, seedOrg, seedUser, type SeededUser } from './auth-support.js';
import { createMigratedDatabase, createTestDb, type TestDatabase } from './database.js';
import { relaxRateLimits } from './record-fixture.js';
import { startTestApp, type TestApp } from './support.js';
import { startFakeTelegramBot, type FakeTelegramBot } from './telegram-bot-support.js';

import type { LightMyRequestResponse } from 'fastify';
import type { Redis } from 'ioredis';

const COMMAND =
  'NOTIFICATION_BENCH=1 pnpm --filter @cellhive/api test:int test/int/notifications.bench';
const MAX_LOAD = 8;
const ASSIGNEES = 50;
const IMPORT_ROWS = 5_000;
const EDITED = 1_000;
const FOLLOWERS = 10;
const REMINDER_FIELDS = 20;
const REMINDER_ROWS = Number(process.env['NOTIFICATION_BENCH_ROWS'] ?? '200000');
const MINUTE = 60_000;
const FOLLOW_DEBOUNCE_MS = 60_000;
const BOUNDARY = 'cellhive-notification-bench';
const FANOUT_FOLLOWERS = 500;
const TELEGRAM_MEMBERS = 200;
const TELEGRAM_REPEATED = 20;
const TELEGRAM_TOKEN = '424243999:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDtgbench';
/** The only worker log lines the bench reads (keeping every line slows the worker down). */
const COUNTED = ['notification buffer flushed', 'notifications fanned out', 'date reminder scan'];

/** A worker logger that keeps only the {@link COUNTED} lines, parsed. */
function countingLogger() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      for (const raw of chunk.toString('utf8').split('\n')) {
        if (raw === '' || !COUNTED.some((msg) => raw.includes(`"msg":"${msg}"`))) continue;
        lines.push(JSON.parse(raw) as Record<string, unknown>);
      }
      callback();
    },
  });
  return { logger: pino({ level: 'info' }, stream), logs: { lines } };
}

async function eventually<T>(
  probe: () => Promise<T | undefined | false>,
  label: string,
  timeoutMs = 1_800_000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const load = () => (loadavg()[0] ?? 0).toFixed(1);

/** Most of `times` (ms) within any window of one second. */
function maxWithinOneSecond(times: readonly number[]): number {
  const sorted = [...times].sort((x, y) => x - y);
  let best = 0;
  let start = 0;
  for (let end = 0; end < sorted.length; end += 1) {
    while ((sorted[end] ?? 0) - (sorted[start] ?? 0) >= 1_000) start += 1;
    best = Math.max(best, end - start + 1);
  }
  return best;
}

/** Shortest time between a call and the 25th after it (≥ 1 s when 25/s holds), or n/a. */
function shortest26(times: readonly number[]): string {
  const sorted = [...times].sort((x, y) => x - y);
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i + 25 < sorted.length; i += 1) {
    best = Math.min(best, (sorted[i + 25] ?? 0) - (sorted[i] ?? 0));
  }
  return Number.isFinite(best) ? `${best.toFixed(0)} ms` : 'n/a';
}

/** p-th percentile (nearest rank). */
function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? Number.NaN;
}

function multipart(filename: string, bytes: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        'Content-Type: text/csv\r\n\r\n',
    ),
    bytes,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
}

describe.skipIf(process.env['NOTIFICATION_BENCH'] !== '1')('notification bench (T557)', () => {
  const startLoad = loadavg()[0] ?? 0;
  const pending = startLoad >= MAX_LOAD;
  const report: string[] = [];
  const { logger, logs } = countingLogger();
  let database: TestDatabase;
  let db: Db;
  let t: TestApp;
  let worker: WorkerHandle;
  let telegram: FakeTelegramBot;
  /** Members added for the fan-out and Telegram cases (no password, editor role). */
  const crowd: SeededUser[] = [];
  let crowdRecord: { tableId: Id<'tbl'>; recordId: Id<'rec'>; amount: Id<'fld'> } | undefined;
  let orgId: Id<'org'>;
  let baseId: Id<'bse'>;
  let owner: SeededUser;
  let ownerBrowser: Browser;
  const people: SeededUser[] = [];

  const scope = () => orgScope(orgId);

  async function call(
    browser: Browser,
    method: 'GET' | 'POST' | 'PATCH' | 'PUT',
    url: string,
    payload?: object | Buffer,
    headers?: Record<string, string>,
  ): Promise<LightMyRequestResponse> {
    return browser.request({
      method,
      url: `/api/v1${url}`,
      ...(payload === undefined ? {} : { payload }),
      ...(headers === undefined ? {} : { headers }),
    });
  }

  /** Lines the worker logged with `msg` since `from` (index into the log). */
  const logged = (msg: string, from: number) =>
    logs.lines.slice(from).filter((line) => line['msg'] === msg);

  async function notificationsOf(type: string, since: Date) {
    const { rows } = await sql<{
      user_id: string;
      entity_id: string;
      created_at: Date;
      payload: Record<string, unknown>;
    }>`
      SELECT user_id, entity_id, created_at, payload FROM meta.notifications
       WHERE organization_id = ${orgId} AND type = ${type} AND created_at >= ${since}
    `.execute(db.kysely);
    return rows;
  }

  /** A table of the bench base with the given fields (as `POST /tables` + `POST /fields`). */
  async function createTable(
    name: string,
    fields: readonly { name: string; type: string; options?: unknown }[],
  ): Promise<{ tableId: Id<'tbl'>; fieldIds: Record<string, Id<'fld'>> }> {
    const schema = t.app.get(SchemaService);
    const { table, primaryField } = await schema.createTable(
      scope(),
      { baseId, name, primaryFieldName: 'title' },
      systemAuditContext(),
    );
    const fieldIds: Record<string, Id<'fld'>> = { title: primaryField.id };
    for (const field of fields) {
      fieldIds[field.name] = (
        await schema.addField(
          scope(),
          table.id,
          { name: field.name, type: field.type, options: field.options ?? {} },
          systemAuditContext(),
        )
      ).id;
    }
    return { tableId: table.id, fieldIds };
  }

  beforeAll(async () => {
    if (pending) {
      process.stdout.write(
        `PENDING notification bench: 1-minute load ${startLoad.toFixed(1)} ≥ ${String(MAX_LOAD)}; run when idle:\n  ${COMMAND}\n`,
      );
      return;
    }
    database = await createMigratedDatabase();
    db = createTestDb(database.url);
    telegram = await startFakeTelegramBot();
    t = await startTestApp(
      { DATABASE_URL: database.url, LOG_LEVEL: 'warn' },
      { telegramClient: { baseUrl: telegram.baseUrl } },
    );
    relaxRateLimits(t);
    orgId = await seedOrg(db, 'Notification bench');
    owner = await seedUser(db, { memberships: [{ orgId, role: 'owner' }], displayName: 'Owner' });
    for (let n = 0; n < ASSIGNEES; n += 1) {
      people.push(
        await seedUser(db, {
          memberships: [{ orgId, role: 'member' }],
          displayName: `Người ${String(n + 1)}`,
        }),
      );
    }
    ownerBrowser = new Browser(t.app);
    expect((await ownerBrowser.login(owner.email)).statusCode).toBe(204);
    const workspace = await call(ownerBrowser, 'POST', `/orgs/${orgId}/workspaces`, {
      name: 'Bench',
    });
    const base = await call(
      ownerBrowser,
      'POST',
      `/workspaces/${workspace.json<{ id: string }>().id}/bases`,
      { name: 'Bench' },
    );
    baseId = base.json<{ id: Id<'bse'> }>().id;
    // Everyone reads the base (system editor role, as an admin would assign it).
    const roles = await new BaseRolesRepository(db).listByBase(scope(), baseId);
    const editor = roles.find((role) => role.kind === 'system_editor')?.id as Id<'rol'>;
    const assignments = new BaseRoleMembersRepository(db);
    for (const person of people) {
      await assignments.assign(scope(), {
        baseId,
        roleId: editor,
        principalType: 'user',
        principalId: person.id,
      });
    }
    worker = await createWorker(t.config, {
      logger,
      pollIntervalMs: 50,
      taskList: buildTaskList({
        config: t.config,
        db: t.app.get<Db>(DB),
        logger,
        // As in production (worker.module): the bot's limit shared through Valkey.
        telegramPacers: createValkeyTelegramPacers(
          valkeyQuotaClient(t.app.get<Redis>(CACHE_CLIENT)),
          { keyPrefix: `bench-${String(Date.now())}:` },
        ),
        telegramClient: { baseUrl: telegram.baseUrl },
        notificationTelegramBatchMs: 300,
      }),
    });
  }, 600_000);

  afterAll(async () => {
    if (pending) return;
    process.stdout.write(
      `Notification bench (T557, load ${startLoad.toFixed(1)} at start, ${load()} at end):\n${report.map((line) => `  ${line}`).join('\n')}\n`,
    );
    await worker.close();
    await t.close();
    await telegram.close();
    await db.destroy();
    await database.drop();
  }, 600_000);

  it(`imports ${String(IMPORT_ROWS)} rows assigning ${String(ASSIGNEES)} people: one notification each`, async (context) => {
    if (pending) context.skip();
    const { tableId, fieldIds } = await createTable('Bench import', [
      { name: 'Phụ trách', type: 'user', options: { multiple: false, notify_on_assign: true } },
    ]);
    const lines = ['title,assignee'];
    for (let n = 0; n < IMPORT_ROWS; n += 1) {
      lines.push(`Nhập ${String(n)},${people[n % ASSIGNEES]?.email ?? ''}`);
    }
    const upload = await call(
      ownerBrowser,
      'POST',
      `/bases/${baseId}/imports/uploads`,
      multipart('bench.csv', Buffer.from(`${lines.join('\r\n')}\r\n`)),
      { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    );
    expect(upload.statusCode, upload.body).toBe(201);
    const fromLog = logs.lines.length;
    const since = new Date();
    const began = performance.now();
    const startLoadImport = load();
    const start = await call(ownerBrowser, 'POST', `/bases/${baseId}/imports`, {
      upload_id: importUploadSchema.parse(upload.json()).id,
      mode: 'append',
      table_id: tableId,
      mapping: [
        { column: 0, field_id: fieldIds['title'] },
        { column: 1, field_id: fieldIds['Phụ trách'] },
      ],
    });
    expect(start.statusCode, start.body).toBe(202);
    const jobId = start.json<{ job_id: Id<'job'> }>().job_id;
    const job = await eventually(async () => {
      const dto = jobSchema.parse((await call(ownerBrowser, 'GET', `/jobs/${jobId}`)).json());
      return ['succeeded', 'failed', 'cancelled'].includes(dto.status) ? dto : undefined;
    }, 'the import');
    expect(job.status).toBe('succeeded');
    const imported = performance.now();
    const notices = await eventually(async () => {
      const rows = await notificationsOf('record.assigned', since);
      return rows.length >= ASSIGNEES ? rows : undefined;
    }, 'the 50 assignment notifications');
    const flushed = performance.now();
    // Nothing more comes: the buffer is empty and no flush is waiting.
    await eventually(async () => {
      const { rows } = await sql<{ buffered: number; jobs: number }>`
        SELECT (SELECT count(*)::int FROM meta.notification_buffer WHERE kind = 'assigned') AS buffered,
               (SELECT count(*)::int FROM graphile_worker.jobs
                 WHERE task_identifier IN ('notifications.flush', 'notifications.fanout')) AS jobs
      `.execute(db.kysely);
      return rows[0]?.buffered === 0 && rows[0].jobs === 0;
    }, 'the assigned buffer to empty');
    expect(notices).toHaveLength(ASSIGNEES);
    expect(new Set(notices.map((notice) => notice.user_id)).size).toBe(ASSIGNEES);
    for (const notice of notices) {
      expect(notice.payload).toMatchObject({ batch_id: jobId, count: IMPORT_ROWS / ASSIGNEES });
    }
    const flushJobs = logged('notification buffer flushed', fromLog).length;
    const fanoutJobs = logged('notifications fanned out', fromLog).filter(
      (line) => line['notification_type'] === 'record.assigned',
    ).length;
    const { rows: follows } = await sql<{ source: string; n: number }>`
      SELECT source, count(*)::int AS n FROM meta.record_follows
       WHERE organization_id = ${orgId} AND table_id = ${tableId} GROUP BY source ORDER BY source
    `.execute(db.kysely);
    report.push(
      `import auto-follows: ${follows.map((row) => `${row.source} ${String(row.n)}`).join(', ')}`,
    );
    report.push(
      `import ${String(IMPORT_ROWS)} rows → ${String(ASSIGNEES)} assignees: import ${seconds(imported - began)}, ` +
        `job end → ${String(ASSIGNEES)} notifications ${seconds(flushed - imported)} (10 s debounce after the last row), ` +
        `${String(flushJobs)} notifications.flush + ${String(fanoutJobs)} notifications.fanout jobs ` +
        `(load ${startLoadImport} → ${load()})`,
    );
    expect(fanoutJobs).toBe(0);
  }, 1_800_000);

  it(`edits ${String(EDITED)} records one by one, each followed by ${String(FOLLOWERS)} people: flush lag`, async (context) => {
    if (pending) context.skip();
    const { tableId, fieldIds } = await createTable('Bench follows', [
      { name: 'Số tiền', type: 'number' },
    ]);
    const created: Id<'rec'>[] = [];
    for (let offset = 0; offset < EDITED; offset += 500) {
      const response = await call(
        ownerBrowser,
        'POST',
        `/tables/${tableId}/records?field_key_type=id`,
        {
          records: Array.from({ length: Math.min(500, EDITED - offset) }, (_, n) => ({
            fields: {
              [fieldIds['title'] ?? '']: `Theo dõi ${String(offset + n)}`,
              [fieldIds['Số tiền'] ?? '']: 0,
            },
          })),
        },
      );
      expect(response.statusCode, response.body).toBe(201);
      created.push(...response.json<{ records: { id: Id<'rec'> }[] }>().records.map((r) => r.id));
    }
    // 10 followers per record, through `PUT …/follow` like the "Follow" button.
    const followers = people.slice(0, FOLLOWERS);
    const browsers: Browser[] = [];
    for (const person of followers) {
      const browser = new Browser(t.app);
      expect((await browser.login(person.email)).statusCode).toBe(204);
      browsers.push(browser);
    }
    const followedAt = performance.now();
    for (const browser of browsers) {
      for (let offset = 0; offset < created.length; offset += 50) {
        await Promise.all(
          created.slice(offset, offset + 50).map(async (id) => {
            const response = await call(browser, 'PUT', `/tables/${tableId}/records/${id}/follow`);
            expect(response.statusCode, response.body).toBe(204);
          }),
        );
      }
    }
    report.push(
      `${String(EDITED * FOLLOWERS)} follows (PUT …/follow) in ${seconds(performance.now() - followedAt)}`,
    );
    // Earlier events (creates) dispatched first: only the edits count.
    await eventually(async () => {
      const { rows } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM meta.events
         WHERE organization_id = ${orgId} AND dispatched_at IS NULL
      `.execute(db.kysely);
      return rows[0]?.n === 0;
    }, 'earlier events dispatched');

    const fromLog = logs.lines.length;
    const since = new Date();
    const editedAt = new Map<Id<'rec'>, number>();
    const editLoad = load();
    const began = Date.now();
    for (const [index, id] of created.entries()) {
      const response = await call(
        ownerBrowser,
        'PATCH',
        `/tables/${tableId}/records?field_key_type=id`,
        {
          records: [{ id, fields: { [fieldIds['Số tiền'] ?? '']: index + 1 } }],
        },
      );
      expect(response.statusCode, response.body).toBe(200);
      editedAt.set(id, Date.now());
    }
    const edited = Date.now();
    const notices = await eventually(
      async () => {
        const rows = await notificationsOf('record.followed_changed', since);
        return rows.length >= EDITED * FOLLOWERS ? rows : undefined;
      },
      'the followed notifications',
      1_800_000,
      250,
    );
    const done = Date.now();
    expect(notices).toHaveLength(EDITED * FOLLOWERS);
    const lastByRecord = new Map<string, number>();
    for (const notice of notices) {
      lastByRecord.set(
        notice.entity_id,
        Math.max(lastByRecord.get(notice.entity_id) ?? 0, notice.created_at.getTime()),
      );
      expect(notice.payload).toMatchObject({ change_count: 1, actor_ids: [owner.id] });
    }
    const lags = [...lastByRecord].map(
      ([id, at]) => at - ((editedAt.get(id as Id<'rec'>) ?? 0) + FOLLOW_DEBOUNCE_MS),
    );
    const flushJobs = logged('notification buffer flushed', fromLog).length;
    report.push(
      `${String(EDITED)} single edits × ${String(FOLLOWERS)} followers: edits ${seconds(edited - began)}, ` +
        `last edit → all ${String(EDITED * FOLLOWERS)} notifications ${seconds(done - edited)}; ` +
        `flush lag after the 60 s debounce p50 ${percentile(lags, 50).toFixed(0)} ms, ` +
        `p95 ${percentile(lags, 95).toFixed(0)} ms, max ${Math.max(...lags).toFixed(0)} ms; ` +
        `${String(flushJobs)} notifications.flush jobs (load ${editLoad} → ${load()})`,
    );
    expect(flushJobs).toBe(EDITED);
  }, 3_600_000);

  it(`auto-follows ${String(MAX_RECORD_FOLLOWS_PER_USER)} records for one person, then at the cap (T560)`, async (context) => {
    if (pending) context.skip();
    const { tableId } = await createTable('Bench follow cap', []);
    const person = people[ASSIGNEES - 1] as SeededUser;
    const hooks = new RecordFollowHooks(db);
    const ids = (from: number, count: number) =>
      Array.from(
        { length: count },
        (_, n) => `rec_cap${String(from + n).padStart(13, '0')}` as Id<'rec'>,
      );
    const { rows: before } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM meta.record_follows
       WHERE organization_id = ${orgId} AND user_id = ${person.id}
    `.execute(db.kysely);
    const already = before[0]?.n ?? 0;
    const startLoad = load();
    let began = performance.now();
    const first = await db.withTx((tx) =>
      hooks.autoFollow(orgScope(orgId, tx), {
        tableId,
        userId: person.id,
        recordIds: ids(0, MAX_RECORD_FOLLOWS_PER_USER),
        source: 'assigned',
      }),
    );
    const firstMs = performance.now() - began;
    began = performance.now();
    const second = await db.withTx((tx) =>
      hooks.autoFollow(orgScope(orgId, tx), {
        tableId,
        userId: person.id,
        recordIds: ids(MAX_RECORD_FOLLOWS_PER_USER, 1_000),
        source: 'assigned',
      }),
    );
    const secondMs = performance.now() - began;
    report.push(
      `autoFollow ${String(MAX_RECORD_FOLLOWS_PER_USER)} ids (person already had ${String(already)} rows): ` +
        `${String(first.length)} rows in ${firstMs.toFixed(0)} ms; 1 000 more at the cap: ` +
        `${String(second.length)} rows in ${secondMs.toFixed(0)} ms (load ${startLoad} → ${load()})`,
    );
    expect(first.length + already).toBe(MAX_RECORD_FOLLOWS_PER_USER);
    expect(second).toHaveLength(0);
  }, 600_000);

  /**
   * The members of the fan-out and Telegram cases (no password, editor role)
   * and their record, created once (either case may run alone with `-t`).
   */
  async function crowdSetup(): Promise<NonNullable<typeof crowdRecord>> {
    if (crowdRecord !== undefined) return crowdRecord;
    const roles = await new BaseRolesRepository(db).listByBase(scope(), baseId);
    const editor = roles.find((role) => role.kind === 'system_editor')?.id as Id<'rol'>;
    const assignments = new BaseRoleMembersRepository(db);
    for (let n = 0; n < FANOUT_FOLLOWERS; n += 1) {
      const user = await seedUser(db, {
        memberships: [{ orgId, role: 'member' }],
        password: null,
        displayName: `Theo dõi ${String(n + 1)}`,
      });
      await assignments.assign(scope(), {
        baseId,
        roleId: editor,
        principalType: 'user',
        principalId: user.id,
      });
      crowd.push(user);
    }
    const { tableId, fieldIds } = await createTable('Bench fan-out', [
      { name: 'Số tiền', type: 'number' },
    ]);
    const amount = fieldIds['Số tiền'] as Id<'fld'>;
    const created = await call(
      ownerBrowser,
      'POST',
      `/tables/${tableId}/records?field_key_type=id`,
      {
        records: [
          { fields: { [fieldIds['title'] ?? '']: 'Đơn đông người theo dõi', [amount]: 0 } },
        ],
      },
    );
    expect(created.statusCode, created.body).toBe(201);
    const recordId = created.json<{ records: { id: Id<'rec'> }[] }>().records[0]?.id as Id<'rec'>;
    crowdRecord = { tableId, recordId, amount };
    return crowdRecord;
  }

  it(`edits one record followed by ${String(FANOUT_FOLLOWERS)} people: fan-out (T560)`, async (context) => {
    if (pending) context.skip();
    const { tableId, recordId, amount } = await crowdSetup();
    await sql`
      INSERT INTO meta.record_follows (organization_id, table_id, record_id, user_id, source)
      SELECT ${orgId}, ${tableId}, ${recordId}, u, 'manual'
        FROM unnest(${crowd.map((user) => user.id)}::text[]) AS u
    `.execute(db.kysely);
    await eventually(async () => {
      const { rows } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM meta.events
         WHERE organization_id = ${orgId} AND dispatched_at IS NULL
      `.execute(db.kysely);
      return rows[0]?.n === 0;
    }, 'earlier events dispatched');
    const fromLog = logs.lines.length;
    const since = new Date();
    const startLoad = load();
    const editedAt = Date.now();
    const edit = await call(ownerBrowser, 'PATCH', `/tables/${tableId}/records?field_key_type=id`, {
      records: [{ id: recordId, fields: { [amount]: 1 } }],
    });
    expect(edit.statusCode, edit.body).toBe(200);
    const notices = await eventually(
      async () => {
        const rows = await notificationsOf('record.followed_changed', since);
        return rows.length >= FANOUT_FOLLOWERS ? rows : undefined;
      },
      'the fan-out notifications',
      600_000,
      50,
    );
    // The flush job logs after its transaction committed.
    await eventually(
      () => Promise.resolve(logged('notification buffer flushed', fromLog).length > 0),
      'the flush log line',
      30_000,
      50,
    );
    const written = notices.map((notice) => notice.created_at.getTime());
    const fanouts = logged('notifications fanned out', fromLog).filter(
      (line) => line['notification_type'] === 'record.followed_changed',
    ).length;
    report.push(
      `1 edit × ${String(FANOUT_FOLLOWERS)} followers: ${String(notices.length)} notifications; edit + 60 s → last written ` +
        `${String(Math.max(...written) - (editedAt + FOLLOW_DEBOUNCE_MS))} ms; first → last written ` +
        `${String(Math.max(...written) - Math.min(...written))} ms; ` +
        `${String(logged('notification buffer flushed', fromLog).length)} flush + ${String(fanouts)} fan-out jobs ` +
        `(load ${startLoad} → ${load()})`,
    );
    expect(new Set(notices.map((notice) => notice.user_id)).size).toBe(FANOUT_FOLLOWERS);
  }, 900_000);

  it(`delivers over Telegram to ${String(TELEGRAM_MEMBERS)} linked members under the bot cap (T560)`, async (context) => {
    if (pending) context.skip();
    const target = await crowdSetup();
    telegram.setUsername(TELEGRAM_TOKEN, 'cellhive_bench_bot');
    const secret = await call(ownerBrowser, 'POST', `/orgs/${orgId}/secrets`, {
      kind: 'telegram_bot',
      name: 'Bench bot',
      value: TELEGRAM_TOKEN,
    });
    expect(secret.statusCode, secret.body).toBe(201);
    const secretId = secret.json<{ id: Id<'sec'> }>().id;
    const bot = await call(ownerBrowser, 'PATCH', `/orgs/${orgId}/notification-channels`, {
      telegram_secret_id: secretId,
    });
    expect(bot.statusCode, bot.body).toBe(200);
    const address = new TelegramChatAddress(t.config.security.appMasterKey);
    const channels = new UserChannelsRepository(db);
    const members = crowd.slice(0, TELEGRAM_MEMBERS);
    const chats = new Set<string>();
    for (const [n, member] of members.entries()) {
      const chatId = String(9_100_000_000 + n);
      await channels.upsertLinked(scope(), {
        id: newId('uch'),
        userId: member.id,
        kind: 'telegram',
        secretId,
        addressEnc: address.seal(chatId),
        addressHmac: address.lookup(secretId, chatId),
        linkedAt: new Date(),
      });
      chats.add(chatId);
    }
    const fanout = new NotificationFanout(t.app.get<Db>(DB), t.app.get(RecordQueryService), {
      emailEnabled: false,
      // As the worker above (default 5 s): rounds 600 ms apart are separate messages.
      telegramBatchMs: 300,
      defaults: { timeZone: 'UTC', locale: 'en' },
    });
    const message = (userIds: readonly Id<'usr'>[], title: string) =>
      fanout.run({
        organization_id: orgId,
        type: 'automation.message',
        base_id: baseId,
        table_id: target.tableId,
        entity_type: 'record',
        entity_id: target.recordId,
        actor: null,
        group_key: null,
        recipients: { user_ids: [...userIds], base_admins: false },
        requires: { record_id: target.recordId, field_ids: [] },
        skip_actor: false,
        data: {
          automation_id: 'aut_TgBenchAuto00001',
          run_id: 'run_TgBenchRun000001',
          title,
          body: `Nội dung ${title}`,
        },
      });
    const sendCalls = (from: number) => telegram.callsOf('sendMessage').slice(from);

    // 1. One notification to every linked member.
    const before = telegram.callsOf('sendMessage').length;
    const startLoad = load();
    const began = performance.now();
    await message(
      members.map((member) => member.id),
      'Thông báo hàng loạt',
    );
    const calls = await eventually(
      () => {
        const got = sendCalls(before);
        return Promise.resolve(got.length >= TELEGRAM_MEMBERS ? got : undefined);
      },
      'the Telegram messages',
      180_000,
      50,
    ).catch(async (error: unknown) => {
      // Where the deliveries stopped (statuses and error codes only).
      const { rows } = await sql<{ status: string; error_code: string | null; n: number }>`
        SELECT status, error_code, count(*)::int AS n FROM meta.notification_deliveries
         WHERE organization_id = ${orgId} AND channel = 'telegram'
         GROUP BY status, error_code
      `.execute(db.kysely);
      report.push(
        `Telegram deliveries when it timed out: ${JSON.stringify(rows)}; ` +
          `${String(sendCalls(before).length)} sendMessage calls`,
      );
      throw error;
    });
    const times = calls.map((item) => item.at);
    const first = Math.min(...times);
    const last = Math.max(...times);
    report.push(
      `Telegram, 1 notification × ${String(TELEGRAM_MEMBERS)} linked members ` +
        `(WORKER_CONCURRENCY ${String(t.config.limits.workerConcurrency)}, Valkey pacers): ` +
        `fan-out → last sendMessage ${seconds(last - began)}, first → last ${seconds(last - first)} ` +
        `(${((calls.length - 1) / ((last - first) / 1000)).toFixed(1)} msg/s), ` +
        `most in one sliding second ${String(maxWithinOneSecond(times))} (cap 25), shortest span of 26 consecutive calls ${shortest26(times)} (load ${startLoad} → ${load()})`,
    );
    expect(calls).toHaveLength(TELEGRAM_MEMBERS);

    // 2. 20 members notified 3 times, 600 ms apart (each after the 300 ms batch):
    //    never 2 messages to a chat within 1 s.
    const repeated = members.slice(0, TELEGRAM_REPEATED);
    const from = telegram.callsOf('sendMessage').length;
    const repeatLoad = load();
    for (let round = 0; round < 3; round += 1) {
      await message(
        repeated.map((member) => member.id),
        `Lần ${String(round + 1)}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    await eventually(
      async () => {
        const { rows } = await sql<{ n: number }>`
          SELECT count(*)::int AS n FROM meta.notification_deliveries
           WHERE organization_id = ${orgId} AND channel = 'telegram' AND status = 'pending'
        `.execute(db.kysely);
        return rows[0]?.n === 0;
      },
      'the repeated Telegram deliveries',
      600_000,
      100,
    );
    const byChat = new Map<string, number[]>();
    for (const item of sendCalls(from)) {
      const chat = String(item.body['chat_id']);
      byChat.set(chat, [...(byChat.get(chat) ?? []), item.at]);
    }
    const gaps = [...byChat.values()].flatMap((list) => {
      const sorted = [...list].sort((x, y) => x - y);
      return sorted.slice(1).map((at, n) => at - (sorted[n] ?? 0));
    });
    const perChat = [...byChat.values()].map((list) => list.length);
    report.push(
      `Telegram, ${String(TELEGRAM_REPEATED)} members × 3 notifications 600 ms apart: ` +
        `${String(sendCalls(from).length)} messages (${String(Math.min(...perChat))}–${String(Math.max(...perChat))} per chat), ` +
        `smallest gap between two messages to one chat ` +
        `${gaps.length === 0 ? 'n/a' : `${Math.min(...gaps).toFixed(0)} ms`} (cap 1/s per chat) ` +
        `(load ${repeatLoad} → ${load()})`,
    );
    expect(byChat.size).toBe(TELEGRAM_REPEATED);
    expect([...byChat.keys()].every((chat) => chats.has(chat))).toBe(true);
  }, 900_000);

  it(`scans date reminders over ${String(REMINDER_FIELDS)} fields × ${String(REMINDER_ROWS)} rows`, async (context) => {
    if (pending) context.skip();
    const recipient = people[0] as SeededUser;
    const fields = Array.from({ length: REMINDER_FIELDS }, (_, n) => ({
      name: `Hạn ${String(n + 1)}`,
      type: 'datetime',
      options: {
        style: { format: 'yyyy-MM-dd HH:mm' },
        reminder: { recipients: 'users', user_ids: [recipient.id] },
      },
    }));
    const { tableId } = await createTable('Bench reminders', fields);
    const seeded = performance.now();
    const access = await ownerAccessContext(db, scope(), baseId, owner.id, {
      timeZone: 'UTC',
      locale: 'en',
    });
    // The worker scans with the real clock: row r of field n is due at
    // base + r minutes + n seconds, the middle row around now — one due
    // moment per minute per field all along the bench, about 70 days each way.
    const base = Math.floor(Date.now() / MINUTE) * MINUTE - Math.floor(REMINDER_ROWS / 2) * MINUTE;
    await insertInBatches({
      records: t.app.get(RecordMutationService),
      scope: scope(),
      tableId,
      access,
      actorId: owner.id,
      count: REMINDER_ROWS,
      row: (index) => {
        const row: Record<string, unknown> = { title: `Nhắc ${String(index)}` };
        fields.forEach((field, n) => {
          row[field.name] = new Date(base + index * MINUTE + n * 1000).toISOString();
        });
        return row;
      },
    });
    const settled = await settleEventsWithoutAutomations(db, scope());
    // The worker dispatched some events while the records were written: let it finish.
    await eventually(async () => {
      const { rows } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM graphile_worker.jobs
         WHERE task_identifier IN ('events.dispatch', 'notifications.fanout')
      `.execute(db.kysely);
      return rows[0]?.n === 0;
    }, 'the dispatch backlog');
    report.push(
      `reminder table: ${String(REMINDER_ROWS)} rows × ${String(REMINDER_FIELDS)} datetime fields through RecordMutationService in ${seconds(performance.now() - seeded)}; ${String(settled.events)} events settled`,
    );

    /**
     * One `notifications.date_reminder_scan` job in the worker over the last
     * `windowMinutes` minutes of every field (cursors moved back by SQL):
     * `windowMinutes` reminders per field, timed until all are written. The
     * reminders of earlier passes are removed first: a window overlapping an
     * earlier one would otherwise find them already sent (`group_key`) and
     * write nothing. The cron pass of the minute may add its own minute.
     */
    const scanJob = async (windowMinutes: number, label: string) => {
      await sql`
        DELETE FROM meta.notifications WHERE organization_id = ${orgId} AND type = 'date.reminder'
      `.execute(db.kysely);
      const from = new Date(Date.now() - windowMinutes * MINUTE);
      await sql`
        UPDATE meta.date_reminder_cursors
           SET armed_at = ${from}, scanned_until = ${from},
               boundary_due_at = NULL, boundary_record_ids = '{}'
         WHERE organization_id = ${orgId}
      `.execute(db.kysely);
      const fromLog = logs.lines.length;
      const since = new Date();
      const startedLoad = load();
      const began = performance.now();
      await sql`SELECT graphile_worker.add_job('notifications.date_reminder_scan', '{}'::json, priority => -100)`.execute(
        db.kysely,
      );
      const expected = windowMinutes * REMINDER_FIELDS;
      // Done: every field reminded by this pass (logged), no scan or fan-out job left,
      // the reminders of the window written.
      const rows = await eventually(
        async () => {
          const fieldsDone = new Set(
            logged('date reminder scan', fromLog).map((line) => line['field_id']),
          ).size;
          if (fieldsDone < REMINDER_FIELDS) return undefined;
          const { rows: jobs } = await sql<{ n: number }>`
            SELECT count(*)::int AS n FROM graphile_worker.jobs
             WHERE task_identifier IN ('notifications.date_reminder_scan', 'notifications.fanout')
          `.execute(db.kysely);
          if (jobs[0]?.n !== 0) return undefined;
          const found = await notificationsOf('date.reminder', since);
          return found.length >= expected ? found : undefined;
        },
        `${label}: ${String(expected)} reminders`,
        600_000,
        50,
      );
      const total = performance.now() - began;
      const scanned = logged('date reminder scan', fromLog);
      report.push(
        `reminder scan job, ${label} window × ${String(REMINDER_FIELDS)} fields: ${String(rows.length)} reminders written in ${total.toFixed(0)} ms end to end (scan + fan-out + notifications), ${String(scanned.length)} field scans logged (load ${startedLoad} → ${load()})`,
      );
      expect(new Set(scanned.map((line) => line['field_id'])).size).toBe(REMINDER_FIELDS);
      expect(rows.length).toBeGreaterThanOrEqual(expected);
    };
    // Warm-up: the first pass also builds the 20 scan indexes.
    await scanJob(1, 'one-minute (first, builds the indexes)');
    await scanJob(1, 'one-minute');
    await scanJob(60, 'one-hour');
  }, 3_600_000);
});
