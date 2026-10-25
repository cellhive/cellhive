import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { cpus, loadavg, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { preview, type PreviewServer } from 'vite';

import { E2E_API_PORT, E2E_WEB_PORT } from './ports';
import { DEMO_ADMIN_EMAIL, DEMO_PASSWORD } from './seed';
import { collectCspViolations, expectNoSeriousA11yViolations } from './support';
import { startFakeSmtp, type CapturedMail, type FakeSmtp } from './t526-smtp';
import { startFakeTelegramBot, type FakeTelegramBot } from './t555-telegram-bot';

/**
 * T557: the S5b milestone (SPEC §22, BACKLOG "Mốc S5b") end to end on the
 * `seed:demo` data — Orders `owner` and Tickets "Phụ trách" tell their new
 * assignees (`notify_on_assign`), Tickets "Hạn" reminds the person in
 * charge the day before at 09:00 (CONTRACTS §9):
 *
 * 1. u_sales1 links Telegram in the settings with `/start <token>` through
 *    the organization's bot (the seeded "Bot CSKH (demo)", picked by the
 *    admin);
 * 2. u_editor assigns u_sales1 to an order's `owner` → u_sales1's open tab
 *    gets `notification.created` in < 1 s and the bell rings, the item in
 *    the notification center names the order, the email (`immediate`) and
 *    the Telegram message arrive;
 * 3. u_sales2 chose a daily email; u_editor pastes u_sales2 into `owner` of
 *    200 rows of the grid → u_sales2's bell rings **once**, one item "…
 *    N records …" (N = rows not already theirs), no email until the daily
 *    digest runs, then one; u_reader, who follows two of those rows, gets
 *    nothing (bulk changes are never "followed changes");
 * 4. u_editor makes u_sales1 the person in charge of a ticket (Sales cannot
 *    read Tickets) → nothing in-app, by email or on Telegram;
 * 5. the reminder of Tickets "Hạn" fires once, at 09:00 of the day before
 *    in the field's time zone (the organization's, then `Asia/Tokyo` set on
 *    the field), also when the worker was stopped while it fell due and
 *    runs again — the reminder cursor moved back by SQL and the scan job
 *    queued (no test-only clock endpoint, BACKLOG T552/T557);
 * 6. turning a channel off in the settings stops that channel only (email,
 *    then Telegram, then in-app).
 *
 * Its own stack, like t555: PostgreSQL 18 + Valkey 8 (Testcontainers),
 * migrations and `seed:demo` (without SMTP: the seed sends nothing), the
 * API (`createApp` of the build, in this process) with `SMTP_URL` on an
 * in-process fake SMTP server and its test-only `telegramClient` on an
 * in-process fake Bot API, the worker (`buildTaskList`, same options,
 * email/Telegram batches shortened, realtime through Valkey) and `vite
 * preview` of the built SPA proxying `/api` and `/ws` to that API.
 */

const WEB_PORT = Number(process.env['E2E_T557_WEB_PORT'] ?? E2E_WEB_PORT + 57);
const API_PORT = Number(process.env['E2E_T557_API_PORT'] ?? E2E_API_PORT + 57);
const WEB_URL = `http://127.0.0.1:${String(WEB_PORT)}`;
const WEB_DIR = fileURLToPath(new URL('..', import.meta.url));
const API_DIST = fileURLToPath(new URL('../../api/dist/', import.meta.url));
const SALES1_EMAIL = 'sales1@demo.cellhive.local';
const SALES2_EMAIL = 'sales2@demo.cellhive.local';
const EDITOR_EMAIL = 'editor@demo.cellhive.local';
const READER_EMAIL = 'reader@demo.cellhive.local';
const SMTP_USER = 'mailer';
const SMTP_PASSWORD = 'e2e-t557-secret';
/** The fake token of the seeded bot "Bot CSKH (demo)" (CONTRACTS §9). */
const SEED_BOT_TOKEN = '123456789:DEMO-not-a-real-bot-token-000000000';
const SEED_BOT = 'Bot CSKH (demo)';
const BOT_USERNAME = 'cskh_notify_bot';
const SALES1_CHAT = 557_001;
const ORDER_TITLE = 'Tên đơn hàng';
const TICKET_TITLE = 'Tiêu đề';
const ASSIGNEE = 'Phụ trách';
const DUE = 'Hạn';
const ROWS = 200;
const ZONE = 'Asia/Ho_Chi_Minh';
/** Grid geometry (GridView: row marker max(40, digits × 8 + 16) for 5 000 rows, header 36, rows 34). */
const ROW_MARKER_WIDTH = 48;
const HEADER_HEIGHT = 36;
const ROW_HEIGHT = 34;

interface Pg {
  Client: new (options: { connectionString: string }) => {
    connect: () => Promise<void>;
    query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
    end: () => Promise<void>;
  };
}

/** What the spec uses of the server-core, worker and API builds (loaded at run time). */
interface CoreBuild {
  loadConfig: (env: NodeJS.ProcessEnv) => { database: { url: string }; cache: { url: string } };
  createDb: (config: {
    url: string;
    poolMax: number;
    applicationName: string;
    statementTimeoutMs: number;
  }) => { destroy: () => Promise<void> };
  JOB_STATEMENT_TIMEOUT_MS: number;
  ValkeyRealtimeBus: new (client: unknown, onError: (err: unknown) => void) => unknown;
  attachRealtimePublisher: (db: unknown, publisher: unknown) => void;
}
interface WorkerBuild {
  createWorker: (
    config: unknown,
    options: { logger: unknown; taskList: unknown; pollIntervalMs: number },
  ) => Promise<{ close: () => Promise<void> }>;
  buildTaskList: (deps: Record<string, unknown>) => unknown;
}
interface ApiBuild {
  createApp: (
    config: unknown,
    options: { logger: unknown; telegramClient: { baseUrl: string } },
  ) => Promise<{
    listen: (options: { port: number; host: string }) => Promise<unknown>;
    close: () => Promise<void>;
  }>;
}

let postgres: StartedPostgreSqlContainer;
let valkey: StartedTestContainer;
let env: NodeJS.ProcessEnv;
let telegram: FakeTelegramBot;
let smtp: FakeSmtp;
let web: PreviewServer;
/** The running worker (stopped and started again by the reminder test). */
let stopWorker: (() => Promise<void>) | null = null;
const closers: (() => Promise<unknown>)[] = [];

const requireFromApi = createRequire(new URL('../../api/package.json', import.meta.url));
const requireFromWorker = createRequire(new URL('../../worker/package.json', import.meta.url));

async function sql(text: string, values: unknown[] = []): Promise<Record<string, unknown>[]> {
  const pg = requireFromApi('pg') as Pg;
  const client = new pg.Client({ connectionString: postgres.getConnectionUri() });
  await client.connect();
  try {
    return (await client.query(text, values)).rows;
  } finally {
    await client.end();
  }
}

/** Runs an API build script to completion. */
function run(script: string, extra: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [`${API_DIST}${script}`], {
      env: { ...env, ...extra },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} exited with code ${String(code)}`));
    });
  });
}

function logger(service: string): unknown {
  const { pino } = requireFromApi('pino') as {
    pino: (options: { level: string; base: Record<string, string> }) => unknown;
  };
  return pino({ level: 'error', base: { service } });
}

async function importCore(): Promise<CoreBuild> {
  return (await import(
    new URL('../../../packages/server-core/dist/index.js', import.meta.url).href
  )) as CoreBuild;
}

/** The API of this stack, in this process, with SMTP and the fake Bot API (test-only option). */
async function startApi(): Promise<void> {
  const core = await importCore();
  const build = (await import(
    new URL('../../api/dist/app.factory.js', import.meta.url).href
  )) as ApiBuild;
  const config = core.loadConfig({ ...env, MODE: 'api', PORT: String(API_PORT) });
  const app = await build.createApp(config, {
    logger: logger('e2e-t557-api'),
    telegramClient: { baseUrl: telegram.baseUrl },
  });
  await app.listen({ port: API_PORT, host: '127.0.0.1' });
  closers.push(() => app.close());
}

/**
 * The worker of this stack, in this process: the fake Bot API, the
 * notification email batch 0.5 s (5 min in production) and the Telegram
 * batch 0.3 s (5 s), realtime through Valkey to the API's sockets.
 */
async function startWorker(): Promise<void> {
  const core = await importCore();
  const build = (await import(
    new URL('../../worker/dist/index.js', import.meta.url).href
  )) as WorkerBuild;
  const { Redis } = requireFromWorker('ioredis') as {
    Redis: new (url: string, options: Record<string, unknown>) => { quit: () => Promise<unknown> };
  };
  const config = core.loadConfig({ ...env, MODE: 'worker' });
  const workerLogger = logger('e2e-t557-worker');
  const db = core.createDb({
    url: config.database.url,
    poolMax: 5,
    applicationName: 'e2e-t557-worker',
    statementTimeoutMs: core.JOB_STATEMENT_TIMEOUT_MS,
  });
  const cache = new Redis(config.cache.url, { enableOfflineQueue: true, maxRetriesPerRequest: 1 });
  const realtime = new core.ValkeyRealtimeBus(cache, () => undefined);
  core.attachRealtimePublisher(db, realtime);
  const taskList = build.buildTaskList({
    config,
    db,
    logger: workerLogger,
    realtime,
    telegramClient: { baseUrl: telegram.baseUrl },
    notificationEmailBatchMs: 500,
    notificationTelegramBatchMs: 300,
  });
  const worker = await build.createWorker(config, {
    logger: workerLogger,
    taskList,
    pollIntervalMs: 100,
  });
  stopWorker = async () => {
    await worker.close();
    await db.destroy();
    await cache.quit();
  };
}

/**
 * A call from inside the page like the SPA (session cookie + CSRF echo,
 * CONTRACTS §1.1) — on this spec's own origin, without navigating (the
 * shared `support.ok` targets the shared stack's origin).
 */
async function call(
  page: Page,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return page.evaluate(
    async ({ method, path, body }) => {
      const csrf = document.cookie
        .split('; ')
        .find((cookie) => cookie.startsWith('ob_csrf='))
        ?.slice('ob_csrf='.length);
      const response = await fetch(`/api/v1${path}`, {
        method,
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(csrf === undefined ? {} : { 'X-CSRF-Token': decodeURIComponent(csrf) }),
        },
        body: body === undefined ? null : JSON.stringify(body),
      });
      const text = await response.text();
      return { status: response.status, body: (text === '' ? null : JSON.parse(text)) as unknown };
    },
    { method, path, body },
  );
}

async function ok<T = Record<string, unknown>>(
  page: Page,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const answer = await call(page, method, path, body);
  expect(answer.status, `${method} ${path}: ${JSON.stringify(answer.body)}`).toBeLessThan(300);
  return answer.body as T;
}

interface Opened {
  readonly context: BrowserContext;
  readonly page: Page;
  /** `notification.created` frames the page's WebSocket received, with their arrival time. */
  readonly created: { at: number; type: string }[];
}

type Session = Awaited<ReturnType<BrowserContext['storageState']>>;
/** One sign-in per user for the whole spec (`POST /auth/login`: 20 a minute per IP). */
const sessions = new Map<string, Session>();

async function openAs(
  browser: Browser,
  email: string,
  options: { readonly colorScheme?: 'light' | 'dark' } = {},
): Promise<Opened> {
  const known = sessions.get(email);
  const context = await browser.newContext({
    baseURL: WEB_URL,
    viewport: { width: 1600, height: 1000 },
    locale: 'en-US',
    colorScheme: options.colorScheme ?? 'light',
    ...(known === undefined ? {} : { storageState: known }),
  });
  await context.addInitScript(() => {
    window.localStorage.setItem('cellhive.language', 'en');
  });
  const page = await context.newPage();
  const created: Opened['created'] = [];
  page.on('websocket', (socket) => {
    socket.on('framereceived', (frame) => {
      if (typeof frame.payload !== 'string' || !frame.payload.includes('notification.created')) {
        return;
      }
      const message = JSON.parse(frame.payload) as { type: string; notification_type?: string };
      if (message.type === 'notification.created') {
        created.push({ at: Date.now(), type: message.notification_type ?? '' });
      }
    });
  });
  await page.goto('/login');
  if (known === undefined) {
    const answer = await call(page, 'POST', '/auth/login', { email, password: DEMO_PASSWORD });
    expect(answer.status, `sign in as ${email}`).toBe(204);
    sessions.set(email, await context.storageState());
  }
  return { context, page, created };
}

interface Notification {
  id: string;
  type: string;
  table_id: string | null;
  entity: { type: string; id: string; title: string | null };
  actor: { type: string; id: string | null; name: string | null } | null;
  data: Record<string, unknown>;
  read_at: string | null;
}

const ids = {
  orgId: '',
  orgSlug: '',
  baseId: '',
  orders: '',
  tickets: '',
  allOrdersView: '',
  botSecret: '',
  users: {} as Record<'admin' | 'editor' | 'reader' | 'sales1' | 'sales2', string>,
  editorName: '',
  fields: {} as Record<string, string>,
};

async function notificationsOf(page: Page): Promise<Notification[]> {
  return (
    await ok<{ items: Notification[] }>(
      page,
      'GET',
      `/orgs/${ids.orgId}/me/notifications?limit=200`,
    )
  ).items;
}

/** The bell's badge as a number (0 without a badge), read now. */
async function badge(page: Page): Promise<number> {
  const texts = await page
    .getByTestId('notification-badge')
    .filter({ visible: true })
    .allInnerTexts();
  const text = texts[0];
  return text === undefined ? 0 : Number(text.replace(/\D/gu, ''));
}

async function openPanel(page: Page) {
  const bell = page.getByTestId('notification-bell').filter({ visible: true });
  await bell.click();
  const panel = page.getByTestId('notification-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('notification-list')).toBeVisible();
  return panel;
}

/** Decoded `text/plain` part of a raw message (quoted-printable or base64). */
function plainText(raw: string): string {
  const boundary = /boundary="?([^";\r\n]+)"?/u.exec(raw)?.[1] ?? '';
  for (const part of raw.split(`--${boundary}`)) {
    const split = part.search(/\r?\n\r?\n/u);
    if (split < 0 || !/content-type:\s*text\/plain/iu.test(part.slice(0, split))) continue;
    const head = part.slice(0, split);
    const body = part.slice(split).trim();
    if (/content-transfer-encoding:\s*base64/iu.test(head)) {
      return Buffer.from(body.replace(/\s+/gu, ''), 'base64').toString('utf8');
    }
    if (/content-transfer-encoding:\s*quoted-printable/iu.test(head)) {
      const bytes: number[] = [];
      const value = body.replace(/=\r?\n/gu, '');
      for (let i = 0; i < value.length; i += 1) {
        const hex = value.slice(i + 1, i + 3);
        if (value[i] === '=' && /^[0-9A-F]{2}$/iu.test(hex)) {
          bytes.push(parseInt(hex, 16));
          i += 2;
        } else {
          bytes.push(value.charCodeAt(i));
        }
      }
      return Buffer.from(bytes).toString('utf8');
    }
    return body;
  }
  return '';
}

/** The decoded `Subject` header (RFC 2047 `B`/`Q` words). */
function subjectOf(raw: string): string {
  const header = /^Subject:(.*(?:\r\n[ \t].*)*)/imu.exec(raw)?.[1] ?? '';
  return header
    .replace(/\r\n[ \t]/gu, ' ')
    .replace(/\?=\s+=\?/gu, '?==?')
    .replace(/=\?utf-8\?([bq])\?([^?]*)\?=/giu, (_word, encoding: string, text: string) =>
      encoding.toLowerCase() === 'b'
        ? Buffer.from(text, 'base64').toString('utf8')
        : Buffer.from(
            text
              .replace(/_/gu, ' ')
              .replace(/=([0-9A-F]{2})/giu, (_m, hex: string) =>
                String.fromCharCode(parseInt(hex, 16)),
              ),
            'latin1',
          ).toString('utf8'),
    )
    .trim();
}

const mailsTo = (email: string): CapturedMail[] =>
  smtp.messages.filter((message) => message.to.includes(email));
const telegramTo = (chat: number) =>
  telegram.sent().filter((message) => message.chatId === String(chat));

/** Every event dispatched; no dispatch, fan-out, assigned flush, delivery or scan job left. */
async function settled(): Promise<void> {
  await expect
    .poll(
      async () => {
        const [row] = await sql(
          `SELECT (SELECT count(*)::int FROM meta.events WHERE dispatched_at IS NULL) AS events,
                  (SELECT count(*)::int FROM graphile_worker._private_jobs p
                     JOIN graphile_worker._private_tasks k ON k.id = p.task_id
                    WHERE k.identifier IN ('events.dispatch', 'notifications.fanout',
                                           'notifications.deliver',
                                           'notifications.date_reminder_scan')
                       OR (k.identifier = 'notifications.flush'
                           AND p.payload->>'kind' = 'assigned')) AS jobs`,
        );
        return Number(row?.['events']) + Number(row?.['jobs']);
      },
      { timeout: 120_000, intervals: [200] },
    )
    .toBe(0);
}

async function patchOrder(page: Page, recordId: string, fields: Record<string, unknown>) {
  await ok(page, 'PATCH', `/tables/${ids.orders}/records?field_key_type=id`, {
    records: [{ id: recordId, fields }],
  });
}

async function patchTicket(page: Page, recordId: string, fields: Record<string, unknown>) {
  await ok(page, 'PATCH', `/tables/${ids.tickets}/records?field_key_type=id`, {
    records: [{ id: recordId, fields }],
  });
}

/** Records of a table in the order of a query (`field_key_type=id`). */
async function query(
  page: Page,
  tableId: string,
  body: Record<string, unknown>,
): Promise<{ id: string; fields: Record<string, unknown> }[]> {
  return (
    await ok<{ records: { id: string; fields: Record<string, unknown> }[] }>(
      page,
      'POST',
      `/tables/${tableId}/records/query?field_key_type=id`,
      { include_total: false, ...body },
    )
  ).records;
}

const ownerIds = (record: { fields: Record<string, unknown> }, field: string): string[] =>
  ((record.fields[field] as { id: string }[] | null | undefined) ?? []).map((user) => user.id);

/** `YYYY-MM-DD` of today in `zone`, shifted by `days`. */
function dayIn(zone: string, days = 0): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Date.now() + days * 86_400_000));
}

/** Moves the reminder cursor of Tickets "Hạn" back to `at` (as if nothing was scanned since). */
async function rewindReminder(at: Date): Promise<void> {
  await sql(
    `UPDATE meta.date_reminder_cursors
        SET armed_at = $2, scanned_until = $2, boundary_due_at = NULL, boundary_record_ids = '{}'
      WHERE field_id = $1`,
    [ids.fields[DUE], at.toISOString()],
  );
}

async function queueReminderScan(): Promise<void> {
  await sql(
    `SELECT graphile_worker.add_job('notifications.date_reminder_scan', '{}'::json, priority => -100)`,
  );
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(600_000);
  telegram = await startFakeTelegramBot();
  telegram.setUsername(SEED_BOT_TOKEN, BOT_USERNAME);
  closers.push(() => telegram.close());
  smtp = await startFakeSmtp({ user: SMTP_USER, pass: SMTP_PASSWORD });
  closers.push(() => smtp.close());
  [postgres, valkey] = await Promise.all([
    new PostgreSqlContainer('postgres:18').start(),
    new GenericContainer('valkey/valkey:8')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/u))
      .start(),
  ]);
  closers.push(
    () => postgres.stop(),
    () => valkey.stop(),
  );
  const storage = await mkdtemp(join(tmpdir(), 'cellhive-e2e-t557-'));
  closers.push(() => rm(storage, { recursive: true, force: true }));
  env = {
    PATH: process.env['PATH'],
    HOME: process.env['HOME'],
    NODE_ENV: 'production',
    PUBLIC_URL: WEB_URL,
    DATABASE_URL: postgres.getConnectionUri(),
    CACHE_URL: `redis://${valkey.getHost()}:${String(valkey.getMappedPort(6379))}`,
    APP_MASTER_KEY: randomBytes(32).toString('base64'),
    SESSION_SECRET: randomBytes(32).toString('base64'),
    STORAGE_DRIVER: 'local',
    STORAGE_LOCAL_PATH: storage,
    DEFAULT_LOCALE: 'en',
    DEFAULT_TIMEZONE: 'UTC',
    LOG_LEVEL: 'warn',
  };
  await run('main.js', { MODE: 'migrate' });
  // The demo data, as a developer seeds it (no SMTP: nothing is ever sent by the seed).
  await run('seed.js', { NODE_ENV: 'development' });
  env = {
    ...env,
    SMTP_URL: `smtp://${SMTP_USER}:${SMTP_PASSWORD}@127.0.0.1:${String(smtp.port)}`,
    SMTP_FROM: 'Cellhive <noreply@cellhive.test>',
    SMTP_ALLOW_INSECURE: 'true',
  };
  await startApi();
  await startWorker();
  closers.push(async () => {
    await stopWorker?.();
  });
  const previous = process.env['VITE_API_TARGET'];
  process.env['VITE_API_TARGET'] = `http://127.0.0.1:${String(API_PORT)}`;
  web = await preview({
    root: WEB_DIR,
    configFile: join(WEB_DIR, 'vite.config.ts'),
    logLevel: 'warn',
    preview: { host: '127.0.0.1', port: WEB_PORT, strictPort: true, open: false },
  });
  if (previous === undefined) delete process.env['VITE_API_TARGET'];
  else process.env['VITE_API_TARGET'] = previous;
  closers.push(() => web.close());

  // Nothing about the sample data was notified, sent or queued by the seed.
  const [quiet] = await sql(
    `SELECT (SELECT count(*)::int FROM meta.notifications) AS notifications,
            (SELECT count(*)::int FROM meta.notification_deliveries) AS deliveries`,
  );
  expect(quiet).toEqual({ notifications: 0, deliveries: 0 });

  const [org] = await sql('SELECT id, slug FROM meta.organizations ORDER BY created_at LIMIT 1');
  ids.orgId = String(org?.['id']);
  ids.orgSlug = String(org?.['slug']);
  for (const [key, email] of [
    ['admin', DEMO_ADMIN_EMAIL],
    ['editor', EDITOR_EMAIL],
    ['reader', READER_EMAIL],
    ['sales1', SALES1_EMAIL],
    ['sales2', SALES2_EMAIL],
  ] as const) {
    const [user] = await sql('SELECT id, display_name FROM meta.users WHERE email = $1', [email]);
    ids.users[key] = String(user?.['id']);
    if (key === 'editor') ids.editorName = String(user?.['display_name']);
  }
  const tables = await sql(
    `SELECT t.id, t.name, t.base_id FROM meta.tables t
      WHERE t.organization_id = $1 AND t.name IN ('Orders', 'Tickets') AND t.deleted_at IS NULL`,
    [ids.orgId],
  );
  ids.orders = String(tables.find((row) => row['name'] === 'Orders')?.['id']);
  ids.tickets = String(tables.find((row) => row['name'] === 'Tickets')?.['id']);
  ids.baseId = String(tables[0]?.['base_id']);
  const fields = await sql(
    `SELECT id, name, table_id FROM meta.fields WHERE table_id = ANY($1::text[]) AND deleted_at IS NULL`,
    [[ids.orders, ids.tickets]],
  );
  const fieldOf = (tableId: string, name: string) =>
    String(fields.find((row) => row['table_id'] === tableId && row['name'] === name)?.['id']);
  ids.fields = {
    owner: fieldOf(ids.orders, 'owner'),
    [ORDER_TITLE]: fieldOf(ids.orders, ORDER_TITLE),
    [TICKET_TITLE]: fieldOf(ids.tickets, TICKET_TITLE),
    [ASSIGNEE]: fieldOf(ids.tickets, ASSIGNEE),
    [DUE]: fieldOf(ids.tickets, DUE),
  };
  const [view] = await sql(`SELECT id FROM meta.views WHERE table_id = $1 AND name = $2`, [
    ids.orders,
    'Tất cả đơn hàng',
  ]);
  ids.allOrdersView = String(view?.['id']);
  const [secret] = await sql(`SELECT id FROM meta.secrets WHERE name = $1`, [SEED_BOT]);
  ids.botSecret = String(secret?.['id']);

  // The admin makes the seeded bot the organization's notification bot (T555 covers the page).
  const admin = await openAs(browser, DEMO_ADMIN_EMAIL);
  const channels = await ok<{ telegram: { bot_username: string | null } }>(
    admin.page,
    'PATCH',
    `/orgs/${ids.orgId}/notification-channels`,
    { telegram_secret_id: ids.botSecret },
  );
  expect(channels.telegram.bot_username).toBe(BOT_USERNAME);
  await admin.context.close();
});

test.afterAll(async () => {
  for (const close of closers.reverse()) await close();
});

const settingsPath = () => `/o/${encodeURIComponent(ids.orgSlug)}/settings/notifications`;

test('u_sales1 links Telegram with /start <token> through the organization bot', async ({
  browser,
}) => {
  const { context, page } = await openAs(browser, SALES1_EMAIL);
  const csp = collectCspViolations(page);
  await page.goto(settingsPath());
  const card = page.getByTestId('telegram-channel');
  await card.getByTestId('telegram-link').click();
  const href = (await card.getByTestId('telegram-open').getAttribute('href')) ?? '';
  const url = new URL(href);
  expect(`${url.origin}${url.pathname}`).toBe(`https://t.me/${BOT_USERNAME}`);
  const token = url.searchParams.get('start') ?? '';
  expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/u);
  telegram.send({ chatId: SALES1_CHAT, text: `/start ${token}` });
  await expect(card.getByTestId('telegram-linked')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('pref-record.assigned-telegram')).toBeChecked();
  // The fixed confirmation is the only message so far.
  await expect.poll(() => telegramTo(SALES1_CHAT).length).toBe(1);
  await expectNoSeriousA11yViolations(page, 'settings: Telegram linked');
  expect(csp).toEqual([]);
  await context.close();
});

test('assigning u_sales1 to an order owner: realtime < 1 s, the bell, the item, email, Telegram', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const sales1 = await openAs(browser, SALES1_EMAIL);
  const editor = await openAs(browser, EDITOR_EMAIL);
  const csp = collectCspViolations(sales1.page);
  await sales1.page.goto(`/o/${encodeURIComponent(ids.orgSlug)}`);
  await expect(
    sales1.page.getByTestId('notification-bell').filter({ visible: true }),
  ).toBeVisible();
  expect(await badge(sales1.page)).toBe(0);
  // An order of u_sales2 far from the rows pasted later (the first 200 of the view).
  const [order] = await query(editor.page, ids.orders, {
    view_id: ids.allOrdersView,
    offset: 400,
    limit: 50,
    filter: {
      op: 'and',
      items: [{ field: ids.fields['owner'], operator: 'has_any_of', value: [ids.users.sales2] }],
    },
  });
  if (order === undefined) throw new Error('no order of u_sales2');
  const title = order.fields[ids.fields[ORDER_TITLE] ?? ''] as string;
  const mails = mailsTo(SALES1_EMAIL).length;
  const messages = telegramTo(SALES1_CHAT).length;
  // Wait for the realtime socket of the tab before the change.
  await expect.poll(() => sales1.page.evaluate(() => document.readyState)).toBe('complete');
  await sales1.page.waitForTimeout(1_000);

  await patchOrder(editor.page, order.id, {
    [ids.fields['owner'] ?? '']: [{ id: ids.users.sales1 }],
  });
  const answered = Date.now();
  await expect
    .poll(() => sales1.created.filter((item) => item.type === 'record.assigned').length, {
      timeout: 30_000,
      intervals: [20],
    })
    .toBe(1);
  const latency =
    (sales1.created.find((item) => item.type === 'record.assigned')?.at ?? 0) - answered;
  const load = loadavg()[0] ?? 0;
  test.info().annotations.push({
    type: 'latency',
    description: `PATCH answered → notification.created: ${String(latency)} ms (load ${load.toFixed(1)}, ${String(cpus().length)} CPUs)`,
  });
  process.stdout.write(
    `T557 assignment → notification.created ${String(latency)} ms (load ${load.toFixed(1)})\n`,
  );
  // Performance is asserted on a machine that is not overloaded (S5b convention, T544).
  if (load < 2 * cpus().length) expect(latency).toBeLessThan(1_000);
  await expect.poll(() => badge(sales1.page), { timeout: 10_000 }).toBe(1);

  const [assigned] = (await notificationsOf(sales1.page)).filter(
    (item) => item.type === 'record.assigned' && item.entity.id === order.id,
  );
  expect(assigned).toMatchObject({
    table_id: ids.orders,
    entity: { type: 'record', id: order.id, title },
    actor: { type: 'user', id: ids.users.editor },
    data: { batch_id: null, count: 1, record_ids: [order.id], field_ids: [ids.fields['owner']] },
  });
  const panel = await openPanel(sales1.page);
  const item = panel.getByTestId(`notification-${assigned?.id ?? ''}`);
  await expect(
    item.getByRole('link', { name: `${ids.editorName} assigned you to «${title}» · owner` }),
  ).toHaveAttribute('href', `/b/${ids.baseId}/t/${ids.orders}?record=${order.id}`);
  await expectNoSeriousA11yViolations(sales1.page, 'panel: assigned to an order');
  await sales1.page.keyboard.press('Escape');

  // `immediate` email (u_sales1's language: vi) and the Telegram message, once each.
  await expect.poll(() => mailsTo(SALES1_EMAIL).length, { timeout: 30_000 }).toBe(mails + 1);
  const mail = plainText(mailsTo(SALES1_EMAIL).at(-1)?.raw ?? '');
  expect(mail).toContain('Bạn được gán một bản ghi trong');
  expect(mail).toContain(title);
  expect(mail).toContain(`${WEB_URL}/b/${ids.baseId}/t/${ids.orders}?record=${order.id}`);
  await expect.poll(() => telegramTo(SALES1_CHAT).length, { timeout: 30_000 }).toBe(messages + 1);
  expect(telegramTo(SALES1_CHAT).at(-1)?.text).toContain(title);
  // u_sales1 now follows the order (`assigned`, T544).
  expect(await ok(sales1.page, 'GET', `/tables/${ids.orders}/records/${order.id}/follow`)).toEqual({
    following: true,
    source: 'assigned',
  });
  await settled();
  expect(mailsTo(SALES1_EMAIL)).toHaveLength(mails + 1);
  expect(csp).toEqual([]);
  await ok(sales1.page, 'POST', `/orgs/${ids.orgId}/me/notifications/read`, { all: true });
  await editor.context.close();
  await sales1.context.close();
});

test('a paste of 200 rows: the assignee rings once (daily email), the follower gets nothing', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  // u_sales2 chooses a daily email at the current hour of their zone (users.timezone = GMT+7).
  const sales2 = await openAs(browser, SALES2_EMAIL);
  await sales2.page.goto(settingsPath());
  // The saved settings are loaded first (the default: immediate), then daily is chosen.
  await expect(sales2.page.getByTestId('frequency-immediate')).toBeChecked();
  await sales2.page.getByTestId('frequency-daily').click();
  await expect(sales2.page.getByTestId('frequency-daily')).toBeChecked();
  await expect(sales2.page.getByTestId('daily-hour')).toBeEnabled();
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, hour: '2-digit', hourCycle: 'h23' }).format(
      new Date(),
    ),
  );
  await sales2.page.getByTestId('daily-hour').selectOption(String(hour));
  await expect
    .poll(async () =>
      ok<{ email_frequency: string; daily_hour: number }>(
        sales2.page,
        'GET',
        `/orgs/${ids.orgId}/me/notification-settings`,
      ),
    )
    .toMatchObject({ email_frequency: 'daily', daily_hour: hour });
  await sales2.page.goto(`/o/${encodeURIComponent(ids.orgSlug)}`);
  await expect(
    sales2.page.getByTestId('notification-bell').filter({ visible: true }),
  ).toBeVisible();
  expect(await badge(sales2.page)).toBe(0);
  const seen: number[] = [];
  const watch = setInterval(() => {
    void badge(sales2.page)
      .then((value) => {
        if (seen.at(-1) !== value) seen.push(value);
      })
      .catch(() => undefined);
  }, 100);

  // The first 200 rows of "Tất cả đơn hàng" (the grid's order) and who owns them now.
  const editor = await openAs(browser, EDITOR_EMAIL, {});
  const rows = await query(editor.page, ids.orders, {
    view_id: ids.allOrdersView,
    limit: ROWS,
    fields: [ids.fields['owner'], ids.fields[ORDER_TITLE]],
  });
  expect(rows).toHaveLength(ROWS);
  const newlyAssigned = rows.filter(
    (row) => !ownerIds(row, ids.fields['owner'] ?? '').includes(ids.users.sales2),
  );
  expect(newlyAssigned.length).toBeGreaterThan(0);
  // u_reader follows two of them by hand (and nobody else's edits are involved).
  const reader = await openAs(browser, READER_EMAIL);
  const followed = [rows[3]?.id ?? '', rows[150]?.id ?? ''];
  for (const id of followed)
    await ok(reader.page, 'PUT', `/tables/${ids.orders}/records/${id}/follow`);
  const readerBefore = (await notificationsOf(reader.page)).length;
  const mails = mailsTo(SALES2_EMAIL).length;

  // Tab A: u_editor pastes u_sales2's email into `owner` of the 200 rows.
  await editor.context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await editor.page.goto(`/b/${ids.baseId}/t/${ids.orders}?view=${ids.allOrdersView}`);
  const canvas = editor.page.locator('.ob-grid [data-testid="data-grid-canvas"]');
  await expect(
    editor.page.locator('table[role="grid"] td[role="gridcell"]').first(),
  ).toBeAttached();
  const header = editor.page
    .locator('table[role="grid"] th[role="columnheader"]')
    .filter({ hasText: /^owner$/u });
  const column = Number(await header.getAttribute('aria-colindex'));
  const box = await canvas.boundingBox();
  if (box === null) throw new Error('grid not laid out');
  await editor.page.mouse.click(
    box.x + ROW_MARKER_WIDTH + 24,
    box.y + HEADER_HEIGHT + ROW_HEIGHT / 2,
  );
  await expect
    .poll(() => editor.page.evaluate(() => document.activeElement?.closest('.ob-grid') != null))
    .toBe(true);
  for (let step = 1; step < column; step += 1) await editor.page.keyboard.press('ArrowRight');
  await expect(editor.page.getByTestId(`glide-cell-${String(column)}-0`)).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await editor.page.evaluate(
    (value) => navigator.clipboard.writeText(value),
    `${Array.from({ length: ROWS }, () => SALES2_EMAIL).join('\r\n')}\r\n`,
  );
  const written = editor.page.waitForResponse(
    (response) =>
      response.request().method() === 'PATCH' &&
      /\/api\/v1\/tables\/tbl_[^/]+\/records\?/u.test(response.url()) &&
      response.status() === 200,
  );
  await editor.page.keyboard.press('ControlOrMeta+v');
  const patch = await written;
  const sent = (patch.request().postDataJSON() as { records: { id: string }[] }).records;
  expect(sent.map((record) => record.id)).toEqual(rows.map((row) => row.id));

  // Tab B: +1 once — one notification for the whole paste (gathered by batch.id).
  await expect.poll(() => badge(sales2.page), { timeout: 60_000 }).toBe(1);
  await settled();
  await sales2.page.waitForTimeout(2_000);
  clearInterval(watch);
  expect(seen).toEqual([0, 1]);
  const assigned = (await notificationsOf(sales2.page)).filter(
    (item) => item.type === 'record.assigned',
  );
  expect(assigned).toHaveLength(1);
  expect(assigned[0]).toMatchObject({
    entity: { type: 'table', id: ids.orders },
    actor: { type: 'user', id: ids.users.editor },
    data: { count: newlyAssigned.length, field_ids: [ids.fields['owner']] },
  });
  // 20 of them (in the order they entered the buffer — events are dispatched concurrently).
  const listed = assigned[0]?.data['record_ids'] as string[];
  expect(new Set(listed).size).toBe(20);
  const newIds = new Set(newlyAssigned.map((row) => row.id));
  expect(listed.filter((id) => !newIds.has(id))).toEqual([]);
  const panel = await openPanel(sales2.page);
  await expect(
    panel.getByTestId(`notification-${assigned[0]?.id ?? ''}`).getByRole('link', {
      name: `${ids.editorName} assigned you ${String(newlyAssigned.length)} records in «Orders»`,
    }),
  ).toHaveAttribute('href', `/b/${ids.baseId}/t/${ids.orders}`);
  await expectNoSeriousA11yViolations(sales2.page, 'panel: 200-row paste');
  await sales2.page.keyboard.press('Escape');

  // The follower: no buffered change, no notification (bulk writes are never followed changes).
  const [buffered] = await sql(
    `SELECT count(*)::int AS n FROM meta.notification_buffer WHERE kind = 'followed' AND group_key = ANY($1::text[])`,
    [followed],
  );
  expect(buffered?.['n']).toBe(0);
  await reader.page.waitForTimeout(2_000);
  expect(await notificationsOf(reader.page)).toHaveLength(readerBefore);

  // Daily: no email yet; the digest of the hour sends one with the paste in it.
  expect(mailsTo(SALES2_EMAIL)).toHaveLength(mails);
  await sql(
    `SELECT graphile_worker.add_job('notifications.daily_digest', '{}'::json, priority => -100)`,
  );
  await expect.poll(() => mailsTo(SALES2_EMAIL).length, { timeout: 60_000 }).toBe(mails + 1);
  const digest = mailsTo(SALES2_EMAIL).at(-1)?.raw ?? '';
  expect(subjectOf(digest)).toMatch(/^Tóm tắt ngày .+: 1 thông báo$/u);
  expect(plainText(digest)).toContain(`Bạn được gán ${String(newlyAssigned.length)} bản ghi trong`);
  await ok(sales2.page, 'POST', `/orgs/${ids.orgId}/me/notifications/read`, { all: true });
  await reader.context.close();
  await editor.context.close();
  await sales2.context.close();
});

test('a ticket assigned to u_sales1, who cannot read Tickets: nothing in-app, by email or Telegram', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const sales1 = await openAs(browser, SALES1_EMAIL);
  const editor = await openAs(browser, EDITOR_EMAIL);
  await sales1.page.goto(`/o/${encodeURIComponent(ids.orgSlug)}`);
  await expect(
    sales1.page.getByTestId('notification-bell').filter({ visible: true }),
  ).toBeVisible();
  const before = {
    inApp: (await notificationsOf(sales1.page)).length,
    mails: mailsTo(SALES1_EMAIL).length,
    telegram: telegramTo(SALES1_CHAT).length,
    frames: sales1.created.length,
  };
  // u_sales1 cannot reach Tickets at all (the Sales role names Orders only).
  expect(
    await sales1.page.evaluate(
      async (path) => (await fetch(path, { credentials: 'include' })).status,
      `/api/v1/tables/${ids.tickets}/fields`,
    ),
  ).toBe(404);
  const [ticket] = await query(editor.page, ids.tickets, { limit: 1 });
  if (ticket === undefined) throw new Error('no ticket');
  await patchTicket(editor.page, ticket.id, {
    [ids.fields[ASSIGNEE] ?? '']: [{ id: ids.users.sales1 }],
  });
  await settled();
  await sales1.page.waitForTimeout(2_000);
  expect(await notificationsOf(sales1.page)).toHaveLength(before.inApp);
  expect(await badge(sales1.page)).toBe(0);
  expect(sales1.created).toHaveLength(before.frames);
  expect(mailsTo(SALES1_EMAIL)).toHaveLength(before.mails);
  expect(telegramTo(SALES1_CHAT)).toHaveLength(before.telegram);
  const [row] = await sql(
    `SELECT (SELECT count(*)::int FROM meta.notifications
              WHERE user_id = $1 AND entity_id = $2) AS notifications,
            (SELECT count(*)::int FROM meta.record_follows
              WHERE user_id = $1 AND record_id = $2) AS follows`,
    [ids.users.sales1, ticket.id],
  );
  expect(row).toEqual({ notifications: 0, follows: 0 });
  await editor.context.close();
  await sales1.context.close();
});

test('the "Hạn" reminder fires once at 09:00 the day before in the field time zone, across a worker restart', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const editor = await openAs(browser, EDITOR_EMAIL, { colorScheme: 'dark' });
  const admin = await openAs(browser, DEMO_ADMIN_EMAIL);
  const tickets = await query(admin.page, ids.tickets, {
    limit: 2,
    filter: {
      op: 'and',
      items: [{ field: ids.fields[ASSIGNEE], operator: 'has_any_of', value: [ids.users.editor] }],
    },
  });
  const [a, b] = tickets;
  if (a === undefined || b === undefined) throw new Error('the editor has fewer than 2 tickets');
  const reminders = async (recordId: string) =>
    (await notificationsOf(editor.page)).filter(
      (item) => item.type === 'date.reminder' && item.entity.id === recordId,
    );

  // A: "Hạn" today (GMT+7) → due yesterday 09:00 GMT+7 (the organization's zone: the
  // field has none) = 02:00 UTC. The cursor goes back a minute before, as if the
  // scans had not run since; the worker's own clock (now) closes the window.
  const today = dayIn(ZONE);
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
  await patchTicket(admin.page, a.id, { [ids.fields[DUE] ?? '']: today });
  await settled();
  const dueA = `${yesterday}T02:00:00.000Z`;
  await rewindReminder(new Date(Date.parse(dueA) - 60_000));
  await queueReminderScan();
  await expect.poll(async () => (await reminders(a.id)).length, { timeout: 60_000 }).toBe(1);
  expect((await reminders(a.id))[0]).toMatchObject({
    entity: { type: 'record', id: a.id },
    actor: null,
    data: { field_id: ids.fields[DUE], due_at: dueA, value: today },
  });
  // Scanned again over the same window: still one.
  await rewindReminder(new Date(Date.parse(dueA) - 60_000));
  await queueReminderScan();
  await settled();
  expect(await reminders(a.id)).toHaveLength(1);

  // The field's own time zone wins: Asia/Tokyo → 09:00 JST = 00:00 UTC.
  await ok(admin.page, 'PATCH', `/fields/${ids.fields[DUE] ?? ''}`, {
    options: { timezone: 'Asia/Tokyo' },
  });
  await patchTicket(admin.page, b.id, { [ids.fields[DUE] ?? '']: today });
  await settled();
  const dueB = `${yesterday}T00:00:00.000Z`;

  // The worker stops before B falls due and runs again after: B is reminded once.
  await stopWorker?.();
  stopWorker = null;
  await rewindReminder(new Date(Date.parse(dueB) - 60_000));
  await editor.page.waitForTimeout(1_000);
  expect(await reminders(b.id)).toHaveLength(0);
  await startWorker();
  await queueReminderScan();
  await expect.poll(async () => (await reminders(b.id)).length, { timeout: 60_000 }).toBe(1);
  expect((await reminders(b.id))[0]?.data).toEqual({
    field_id: ids.fields[DUE],
    due_at: dueB,
    value: today,
  });
  // A second pass (and the cron one) adds nothing; A (same value, now due 00:00 UTC
  // inside the window again) is not reminded twice.
  await queueReminderScan();
  await settled();
  expect(await reminders(b.id)).toHaveLength(1);
  expect(await reminders(a.id)).toHaveLength(1);

  // The notification center shows them as due today (the viewer's zone: GMT+7).
  await editor.page.goto(`/o/${encodeURIComponent(ids.orgSlug)}`);
  const panel = await openPanel(editor.page);
  const itemB = panel.getByTestId(`notification-${(await reminders(b.id))[0]?.id ?? ''}`);
  await expect(itemB).toContainText(`«${DUE}» is due today`);
  await expect(itemB.getByTestId('status-pill')).toHaveText('Due today');
  await expect(itemB.getByRole('link').first()).toHaveAttribute(
    'href',
    `/b/${ids.baseId}/t/${ids.tickets}?record=${b.id}`,
  );
  await expectNoSeriousA11yViolations(editor.page, 'panel: date reminders (dark)');
  await editor.page.keyboard.press('Escape');
  await ok(editor.page, 'POST', `/orgs/${ids.orgId}/me/notifications/read`, { all: true });
  await admin.context.close();
  await editor.context.close();
});

test('turning a channel off stops that channel only: email, then Telegram, then in-app', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const sales1 = await openAs(browser, SALES1_EMAIL);
  const editor = await openAs(browser, EDITOR_EMAIL);
  // Orders of u_sales2, away from those of the other tests: each a new assignment.
  const orders = await query(editor.page, ids.orders, {
    view_id: ids.allOrdersView,
    offset: 600,
    limit: 3,
    filter: {
      op: 'and',
      items: [{ field: ids.fields['owner'], operator: 'has_any_of', value: [ids.users.sales2] }],
    },
  });
  expect(orders).toHaveLength(3);
  const assign = async (recordId: string) => {
    await patchOrder(editor.page, recordId, {
      [ids.fields['owner'] ?? '']: [{ id: ids.users.sales1 }],
    });
    await settled();
    // Past the Telegram (0.3 s) and email (0.5 s) batches of the stack.
    await sales1.page.waitForTimeout(2_000);
  };
  const state = async (recordId: string) => ({
    inApp: (await notificationsOf(sales1.page)).filter(
      (item) => item.type === 'record.assigned' && item.entity.id === recordId,
    ).length,
    mails: mailsTo(SALES1_EMAIL).length,
    telegram: telegramTo(SALES1_CHAT).length,
  });

  await sales1.page.goto(settingsPath());
  const toggle = async (channel: 'email' | 'telegram' | 'in_app', label: string) => {
    const box = sales1.page.getByTestId(`pref-record.assigned-${channel}`);
    await expect(box).toBeChecked();
    await box.click();
    await expect(sales1.page.getByTestId('settings-saved')).toContainText(`${label} off`);
    await expect(box).not.toBeChecked();
  };

  // Email off: in-app and Telegram still come.
  await toggle('email', 'Email');
  let before = await state(orders[0]?.id ?? '');
  await assign(orders[0]?.id ?? '');
  let after = await state(orders[0]?.id ?? '');
  expect(after).toEqual({
    inApp: 1,
    mails: before.mails,
    telegram: before.telegram + 1,
  });

  // Telegram off too: in-app only.
  await toggle('telegram', 'Telegram');
  before = await state(orders[1]?.id ?? '');
  await assign(orders[1]?.id ?? '');
  after = await state(orders[1]?.id ?? '');
  expect(after).toEqual({ inApp: 1, mails: before.mails, telegram: before.telegram });

  // In-app off as well: nothing listed, no badge, nothing sent.
  await toggle('in_app', 'In app');
  await sales1.page.goto(`/o/${encodeURIComponent(ids.orgSlug)}`);
  await ok(sales1.page, 'POST', `/orgs/${ids.orgId}/me/notifications/read`, { all: true });
  await expect(
    sales1.page.getByTestId('notification-bell').filter({ visible: true }),
  ).toBeVisible();
  const frames = sales1.created.length;
  before = await state(orders[2]?.id ?? '');
  await assign(orders[2]?.id ?? '');
  after = await state(orders[2]?.id ?? '');
  expect(after).toEqual({ inApp: 0, mails: before.mails, telegram: before.telegram });
  expect(sales1.created).toHaveLength(frames);
  expect(await badge(sales1.page)).toBe(0);
  // The assignment still made u_sales1 follow the record (T544: kept even with every channel off).
  expect(
    await ok(sales1.page, 'GET', `/tables/${ids.orders}/records/${orders[2]?.id ?? ''}/follow`),
  ).toEqual({ following: true, source: 'assigned' });

  // Back to the defaults.
  await ok(sales1.page, 'PUT', `/orgs/${ids.orgId}/me/notification-preferences`, {
    items: (['in_app', 'email', 'telegram'] as const).map((channel) => ({
      type: 'record.assigned',
      channel,
      enabled: true,
    })),
  });
  await editor.context.close();
  await sales1.context.close();
});
