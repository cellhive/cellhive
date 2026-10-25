import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { preview, type PreviewServer } from 'vite';

import { E2E_API_PORT, E2E_WEB_PORT } from './ports';
import { DEMO_ADMIN_EMAIL, DEMO_PASSWORD } from './seed';
import { animationsSettled, collectCspViolations } from './support';
import { startFakeTelegramBot, type FakeTelegramBot } from './t555-telegram-bot';

/**
 * T555: the Telegram channel of notifications in the UI (CONTRACTS §22.7,
 * FRONTEND §14.2, §15.4) end to end, with a fake Telegram Bot API in this
 * process (never the real network):
 *
 * - a member sees "not turned on" and no Telegram column while the
 *   organization has no notification bot, and the 404 screen on the bot page;
 * - the admin picks the seeded bot as notification bot (keyboard) →
 *   `@username` + "Working"; the bot is labelled and cannot be deleted;
 * - the member links: "Link Telegram" → `t.me` link (new tab) + QR → the
 *   fake receives `/start <token>` → the page shows "Linked" in < 3 s by
 *   realtime (`channel.changed`), the Telegram column becomes usable;
 * - a notification whose delivery Telegram refuses (`403`) → "Not
 *   delivered" (blocked) + "Link again" → linked again;
 * - the admin adds a second bot and switches to it (confirmation) → the
 *   member sees `bot_changed` with the new bot; links again; unlinks;
 * - the bot's webhook is set elsewhere → the admin sees "Webhook elsewhere"
 *   with what to do;
 * - axe on every state, 1440 px light (English) and 375 px dark
 *   (Vietnamese) without horizontal scrolling.
 *
 * Its own stack, so that the in-process API (`createApp` of the API build
 * with its test-only `telegramClient`) and worker (`buildTaskList` with the
 * same option, realtime through Valkey) both talk to the fake: PostgreSQL +
 * Valkey (Testcontainers), migrations and `seed:demo`, and `vite preview`
 * of the built SPA on its own port proxying `/api` and `/ws` to that API —
 * the browser uses it like the real app (cookies, realtime).
 */

const WEB_PORT = Number(process.env['E2E_T555_WEB_PORT'] ?? E2E_WEB_PORT + 55);
const API_PORT = Number(process.env['E2E_T555_API_PORT'] ?? E2E_API_PORT + 55);
const WEB_URL = `http://127.0.0.1:${String(WEB_PORT)}`;
const WEB_DIR = fileURLToPath(new URL('..', import.meta.url));
const API_DIST = fileURLToPath(new URL('../../api/dist/', import.meta.url));
const EDITOR_EMAIL = 'editor@demo.cellhive.local';
/** The fake token of the seeded bot "Bot CSKH (demo)" (CONTRACTS §9). */
const SEED_BOT_TOKEN = '123456789:DEMO-not-a-real-bot-token-000000000';
const SEED_BOT = 'Bot CSKH (demo)';
const SECOND_BOT_TOKEN = '987654321:T555-second-fake-bot-token-0000000';
const SECOND_BOT = 'Bot thông báo T555';
/** The member's private chat with the bot (the fake's; never shown by the app). */
const CHAT_ID = 777_555_001;

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
let web: PreviewServer;
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

/** The API of this stack, in this process, with the fake Bot API (test-only option). */
async function startApi(): Promise<void> {
  const core = (await import(
    new URL('../../../packages/server-core/dist/index.js', import.meta.url).href
  )) as CoreBuild;
  const build = (await import(
    new URL('../../api/dist/app.factory.js', import.meta.url).href
  )) as ApiBuild;
  const config = core.loadConfig({ ...env, MODE: 'api', PORT: String(API_PORT) });
  const app = await build.createApp(config, {
    logger: logger('e2e-t555-api'),
    telegramClient: { baseUrl: telegram.baseUrl },
  });
  await app.listen({ port: API_PORT, host: '127.0.0.1' });
  closers.push(() => app.close());
}

/** The worker of this stack, in this process, with the fake Bot API and the Valkey realtime bus. */
async function startWorker(): Promise<void> {
  const core = (await import(
    new URL('../../../packages/server-core/dist/index.js', import.meta.url).href
  )) as CoreBuild;
  const build = (await import(
    new URL('../../worker/dist/index.js', import.meta.url).href
  )) as WorkerBuild;
  const { Redis } = requireFromWorker('ioredis') as {
    Redis: new (
      url: string,
      options: Record<string, unknown>,
    ) => {
      quit: () => Promise<unknown>;
    };
  };
  const config = core.loadConfig({ ...env, MODE: 'worker' });
  const workerLogger = logger('e2e-t555-worker');
  const db = core.createDb({
    url: config.database.url,
    poolMax: 5,
    applicationName: 'e2e-t555-worker',
    statementTimeoutMs: core.JOB_STATEMENT_TIMEOUT_MS,
  });
  const cache = new Redis(config.cache.url, { enableOfflineQueue: true, maxRetriesPerRequest: 1 });
  // `channel.changed` of the poller and of the delivery reach the API's sockets through Valkey.
  const realtime = new core.ValkeyRealtimeBus(cache, () => undefined);
  core.attachRealtimePublisher(db, realtime);
  const taskList = build.buildTaskList({
    config,
    db,
    logger: workerLogger,
    realtime,
    telegramClient: { baseUrl: telegram.baseUrl },
    // The Telegram batch of a recipient: 0.5 s instead of 5 s.
    notificationTelegramBatchMs: 500,
  });
  const worker = await build.createWorker(config, {
    logger: workerLogger,
    taskList,
    pollIntervalMs: 100,
  });
  closers.push(
    () => db.destroy(),
    () => cache.quit(),
    () => worker.close(),
  );
}

interface Opened {
  readonly context: BrowserContext;
  readonly page: Page;
}

type Session = Awaited<ReturnType<BrowserContext['storageState']>>;
/** One sign-in per user for the whole spec (`POST /auth/login`: 20 a minute per IP). */
const sessions = new Map<string, Session>();

/** A call from inside the page like the SPA (session cookie + CSRF echo, CONTRACTS §1.1). */
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

async function openAs(
  browser: Browser,
  email: string,
  options: {
    readonly viewport?: { width: number; height: number };
    readonly language?: 'en' | 'vi';
    readonly colorScheme?: 'light' | 'dark';
  } = {},
): Promise<Opened> {
  const known = sessions.get(email);
  const context = await browser.newContext({
    baseURL: WEB_URL,
    viewport: options.viewport ?? { width: 1440, height: 900 },
    locale: 'en-US',
    colorScheme: options.colorScheme ?? 'light',
    ...(known === undefined ? {} : { storageState: known }),
  });
  await context.addInitScript((value) => {
    window.localStorage.setItem('cellhive.language', value);
  }, options.language ?? 'en');
  const page = await context.newPage();
  await page.goto('/login');
  if (known === undefined) {
    const answer = await call(page, 'POST', '/auth/login', { email, password: DEMO_PASSWORD });
    expect(answer.status, `sign in as ${email}`).toBe(204);
    sessions.set(email, await context.storageState());
  }
  return { context, page };
}

/** axe on the settled page: no "serious" or "critical" WCAG 2.x A/AA violation. */
async function expectAccessible(page: Page, label: string): Promise<void> {
  await animationsSettled(page);
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const serious = results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => ({
      id: violation.id,
      targets: violation.nodes.map((node) => node.target.join(' ')),
    }));
  expect(serious, `axe violations on ${label}`).toEqual([]);
}

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const { scroll, width } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    width: window.innerWidth,
  }));
  expect(scroll).toBeLessThanOrEqual(width);
}

/** The link token of the `t.me` link shown on the page (to play `/start` in the fake). */
async function linkToken(page: Page): Promise<string> {
  const href = (await page.getByTestId('telegram-open').getAttribute('href')) ?? '';
  const url = new URL(href);
  expect(url.origin).toBe('https://t.me');
  const token = url.searchParams.get('start') ?? '';
  expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/u);
  return token;
}

let orgId = '';
let orgSlug = '';
let editorId = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(600_000);
  telegram = await startFakeTelegramBot();
  telegram.setUsername(SEED_BOT_TOKEN, 'cskh_notify_bot');
  telegram.setUsername(SECOND_BOT_TOKEN, 't555_second_bot');
  closers.push(() => telegram.close());
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
  const storage = await mkdtemp(join(tmpdir(), 'cellhive-e2e-t555-'));
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
  await run('seed.js', { NODE_ENV: 'development' });
  await startApi();
  await startWorker();
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
  const [org] = await sql('SELECT id, slug FROM meta.organizations ORDER BY created_at LIMIT 1');
  orgId = String(org?.['id']);
  orgSlug = String(org?.['slug']);
  const [editor] = await sql('SELECT id FROM meta.users WHERE email = $1', [EDITOR_EMAIL]);
  editorId = String(editor?.['id']);
});

test.afterAll(async () => {
  // What started, in reverse order (the worker and API before the database).
  for (const close of closers.reverse()) await close();
});

const settingsPath = () => `/o/${encodeURIComponent(orgSlug)}/settings/notifications`;
const botsPath = () => `/o/${encodeURIComponent(orgSlug)}/settings/telegram`;

test('without a notification bot: explained to members, no Telegram column, no bot page', async ({
  browser,
}) => {
  const { context, page } = await openAs(browser, EDITOR_EMAIL);
  const csp = collectCspViolations(page);
  await page.goto(settingsPath());
  await expect(page.getByTestId('telegram-unavailable')).toContainText(
    'Ask an organization owner or admin to choose a notification bot.',
  );
  await expect(page.getByTestId('telegram-setup-bot')).toHaveCount(0);
  await expect(page.getByTestId('pref-record.assigned-in_app')).toBeVisible();
  await expect(page.getByTestId('pref-record.assigned-telegram')).toHaveCount(0);
  await expectAccessible(page, 'notification settings without a bot');
  // The bot page is for owners/admins only: the 404 screen.
  await page.goto(botsPath());
  await expect(page.getByRole('heading', { name: /not found/iu })).toBeVisible();
  await expect(page.getByTestId('notification-bot')).toHaveCount(0);
  expect(csp).toEqual([]);
  await context.close();
});

test('the admin picks the notification bot (keyboard): @username and its state', async ({
  browser,
}) => {
  const { context, page } = await openAs(browser, DEMO_ADMIN_EMAIL);
  // Without a bot the admin's settings lead to the bot page.
  await page.goto(settingsPath());
  await page.getByTestId('telegram-setup-bot').click();
  await expect(page).toHaveURL(new RegExp(`${botsPath()}$`, 'u'));
  const section = page.getByTestId('notification-bot');
  await expect(section.getByTestId('notification-bot-none')).toBeVisible();
  await expectAccessible(page, 'bot page without a notification bot');
  const select = section.getByTestId('notification-bot-select');
  await select.focus();
  await select.selectOption({ label: SEED_BOT });
  await page.keyboard.press('Tab');
  await expect(section.getByTestId('notification-bot-save')).toBeFocused();
  await page.keyboard.press('Enter');
  // The first bot: no confirmation.
  await expect(section.getByTestId('notification-bot-username')).toHaveText('@cskh_notify_bot');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(section.getByTestId('notification-bot-status')).toHaveText('Working');
  const row = page.getByTestId('bot-row').filter({ hasText: SEED_BOT });
  await expect(row.getByTestId('bot-notification-label')).toHaveText('Notification bot');
  expect(telegram.calls.some((item) => item.method === 'getMe')).toBe(true);
  await expectAccessible(page, 'bot page with a notification bot');
  // The notification bot cannot be deleted.
  await row.getByTestId('bot-delete').click();
  const dialog = page.getByRole('alertdialog', { name: `Delete ${SEED_BOT}?` });
  await expect(dialog.getByTestId('bot-delete-blocked')).toContainText(
    'It cannot be deleted while it sends members their notifications.',
  );
  await expect(dialog.getByTestId('bot-delete-confirm')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(SEED_BOT_TOKEN);
  await context.close();
});

test('the member links Telegram: t.me link + QR, /start → "Linked" in < 3 s by realtime', async ({
  browser,
}) => {
  const { context, page } = await openAs(browser, EDITOR_EMAIL);
  const csp = collectCspViolations(page);
  await page.goto(settingsPath());
  const card = page.getByTestId('telegram-channel');
  await expect(card.getByTestId('telegram-unlinked')).toContainText(
    "a private chat with the organization's bot",
  );
  // The Telegram column is there, waiting for a link.
  const telegramSwitch = page.getByTestId('pref-record.assigned-telegram');
  await expect(telegramSwitch).toBeDisabled();
  await expect(page.getByTestId('pref-telegram-note')).toBeVisible();
  // Keyboard: "Link Telegram" of the table moves to the card's button.
  await page.getByTestId('pref-telegram-link').focus();
  await page.keyboard.press('Enter');
  await expect(card.getByTestId('telegram-link')).toBeFocused();
  await page.keyboard.press('Enter');
  const open = card.getByTestId('telegram-open');
  await expect(open).toBeFocused();
  await expect(open).toHaveAttribute('target', '_blank');
  await expect(open).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(open).toHaveAccessibleName('Open Telegram (opens in a new tab)');
  await expect(card.getByTestId('telegram-qr')).toBeVisible();
  await expect(card.getByTestId('telegram-countdown')).toContainText(
    /expires in (10:00|9:[0-5]\d)/u,
  );
  await expect(card.getByTestId('telegram-waiting')).toBeVisible();
  const token = await linkToken(page);
  await expectAccessible(page, 'Telegram link waiting');

  const started = Date.now();
  telegram.send({ chatId: CHAT_ID, text: `/start ${token}` });
  await expect(card.getByTestId('telegram-linked')).toBeVisible({ timeout: 3000 });
  expect(Date.now() - started).toBeLessThan(3000);
  await expect(card.getByTestId('telegram-linked')).toContainText(
    'Linked to @cskh_notify_bot since',
  );
  await expect(page.getByTestId('settings-saved')).toContainText('Telegram is linked.');
  await expect(telegramSwitch).toBeEnabled();
  await expect(page.getByTestId('pref-telegram-note')).toHaveCount(0);
  // The fixed confirmation went to the chat; the page never shows the chat or the token.
  await expect
    .poll(() => telegram.sent().filter((item) => item.chatId === String(CHAT_ID)).length)
    .toBeGreaterThan(0);
  await expect(page.locator('body')).not.toContainText(String(CHAT_ID));
  await expect(page.locator('body')).not.toContainText(token);
  await expectAccessible(page, 'Telegram linked');
  expect(csp).toEqual([]);
  await context.close();
});

test('Telegram refuses delivery (403): "Not delivered" + "Link again" → linked again', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const admin = await openAs(browser, DEMO_ADMIN_EMAIL);
  const member = await openAs(browser, EDITOR_EMAIL);
  await member.page.goto(settingsPath());
  const card = member.page.getByTestId('telegram-channel');
  await expect(card.getByTestId('telegram-linked')).toBeVisible();
  await expect(member.page.getByTestId('pref-record.assigned-telegram')).toBeChecked();

  // Assigning the member through a `notify_on_assign` field notifies them on Telegram.
  const [tickets] = await sql(
    `SELECT t.id FROM meta.tables t JOIN meta.bases b ON b.id = t.base_id
      WHERE t.name = 'Tickets' AND b.name = 'Chăm sóc khách hàng' AND t.deleted_at IS NULL`,
  );
  const tableId = String(tickets?.['id']);
  const fields = await ok<{ items: { id: string; name: string; primary?: boolean }[] }>(
    admin.page,
    'GET',
    `/tables/${tableId}/fields`,
  );
  const assignee = fields.items.find((field) => field.name === 'Phụ trách')?.id ?? '';
  const title = fields.items.find((field) => field.name === 'Tiêu đề')?.id ?? '';
  await ok(admin.page, 'PATCH', `/fields/${assignee}`, {
    options: { multiple: false, notify_on_assign: true },
  });
  telegram.queue('sendMessage', {
    status: 403,
    body: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' },
  });
  await ok(admin.page, 'POST', `/tables/${tableId}/records?field_key_type=id`, {
    records: [{ fields: { [title]: 'Máy in T555 kẹt giấy', [assignee]: [{ id: editorId }] } }],
  });
  // The delivery marks the channel `error` (`blocked`) and says so in realtime.
  await expect(card.getByTestId('telegram-error')).toBeVisible({ timeout: 60_000 });
  await expect(card.getByTestId('telegram-state')).toHaveText('Not delivered');
  await expect(card.getByTestId('telegram-error-reason')).toContainText(
    'you may have blocked @cskh_notify_bot or deleted the chat',
  );
  await expect(member.page.getByTestId('pref-record.assigned-telegram')).toBeDisabled();
  await expectAccessible(member.page, 'Telegram blocked');

  await card.getByTestId('telegram-relink').click();
  const token = await linkToken(member.page);
  telegram.send({ chatId: CHAT_ID, text: `/start ${token}` });
  await expect(card.getByTestId('telegram-linked')).toBeVisible({ timeout: 3000 });
  await admin.context.close();
  await member.context.close();
});

test('the admin switches bots (confirmed) → the member sees bot_changed, links again, unlinks', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const admin = await openAs(browser, DEMO_ADMIN_EMAIL);
  const member = await openAs(browser, EDITOR_EMAIL);
  await member.page.goto(settingsPath());
  const card = member.page.getByTestId('telegram-channel');
  await expect(card.getByTestId('telegram-linked')).toBeVisible();

  await admin.page.goto(botsPath());
  // A second bot, added in the page (token write-only).
  await admin.page.getByTestId('bot-add').click();
  const form = admin.page.getByRole('dialog', { name: 'Add a Telegram bot' });
  await form.getByLabel('Name').fill(SECOND_BOT);
  await form.getByLabel('Bot token').fill(SECOND_BOT_TOKEN);
  await form.getByTestId('bot-save').click();
  await expect(admin.page.getByTestId('bot-row').filter({ hasText: SECOND_BOT })).toBeVisible();
  const section = admin.page.getByTestId('notification-bot');
  await section.getByTestId('notification-bot-select').selectOption({ label: SECOND_BOT });
  await section.getByTestId('notification-bot-save').click();
  const confirm = admin.page.getByRole('alertdialog', { name: 'Change the notification bot?' });
  await expect(confirm).toContainText('Members have to link Telegram again');
  await expectAccessible(admin.page, 'change bot confirmation');
  await confirm.getByTestId('notification-bot-confirm').click();
  await expect(section.getByTestId('notification-bot-username')).toHaveText('@t555_second_bot');

  // The member's open page follows by realtime.
  await expect(card.getByTestId('telegram-error-reason')).toHaveText(
    'The organization changed its notification bot. Link again, this time with @t555_second_bot.',
    { timeout: 10_000 },
  );
  await card.getByTestId('telegram-relink').click();
  const token = await linkToken(member.page);
  telegram.send({ chatId: CHAT_ID, text: `/start ${token}` });
  await expect(card.getByTestId('telegram-linked')).toContainText('@t555_second_bot', {
    timeout: 3000,
  });

  // Unlink, after confirming (keyboard).
  await card.getByTestId('telegram-unlink').focus();
  await member.page.keyboard.press('Enter');
  const unlink = member.page.getByRole('alertdialog', { name: 'Unlink Telegram?' });
  await expect(unlink).toBeVisible();
  await expectAccessible(member.page, 'unlink confirmation');
  await unlink.getByTestId('telegram-unlink-confirm').click();
  await expect(card.getByTestId('telegram-unlinked')).toBeVisible();
  await expect(member.page.getByTestId('settings-saved')).toContainText('Telegram unlinked.');
  await expect(member.page.getByTestId('pref-record.assigned-telegram')).toBeDisabled();
  const channels = await ok<{ items: unknown[] }>(member.page, 'GET', `/orgs/${orgId}/me/channels`);
  expect(channels.items).toEqual([]);
  await admin.context.close();
  await member.context.close();
});

test('a webhook set elsewhere: the admin sees "Webhook elsewhere" and what to do', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const member = await openAs(browser, EDITOR_EMAIL);
  telegram.setWebhook(true);
  try {
    await member.page.goto(settingsPath());
    await member.page.getByTestId('telegram-link').click();
    await expect(member.page.getByTestId('telegram-open')).toBeVisible();
    // The poller (enqueued with the link) gets `409` from getUpdates.
    await expect
      .poll(
        async () =>
          (
            await sql(
              `SELECT settings->'notifications'->>'telegram_status' AS status
                 FROM meta.organizations WHERE id = $1`,
              [orgId],
            )
          )[0]?.['status'],
        { timeout: 30_000 },
      )
      .toBe('webhook_conflict');
    const admin = await openAs(browser, DEMO_ADMIN_EMAIL);
    await admin.page.goto(botsPath());
    const section = admin.page.getByTestId('notification-bot');
    await expect(section.getByTestId('notification-bot-status')).toHaveText('Webhook elsewhere');
    await expect(section.getByTestId('notification-bot-guidance')).toContainText(
      'Remove that webhook (deleteWebhook) or create a bot only for Cellhive',
    );
    await expectAccessible(admin.page, 'webhook conflict');
    await admin.context.close();
    // The member cancels the waiting link.
    await member.page.getByTestId('telegram-cancel').click();
    await expect(member.page.getByTestId('telegram-unlinked')).toBeVisible();
  } finally {
    telegram.setWebhook(false);
  }
  await member.context.close();
});

test('375 px dark, Vietnamese: linking and linked fit the screen and pass axe', async ({
  browser,
}) => {
  const member = await openAs(browser, EDITOR_EMAIL, {
    viewport: { width: 375, height: 812 },
    language: 'vi',
    colorScheme: 'dark',
  });
  const page = member.page;
  await page.goto(settingsPath());
  const card = page.getByTestId('telegram-channel');
  await expect(card.getByRole('heading', { name: 'Telegram' })).toBeVisible();
  await expect(card.getByTestId('telegram-link')).toHaveText('Liên kết Telegram');
  await expect(page.getByTestId('pref-telegram-note')).toContainText(
    'Cột Telegram có hiệu lực sau khi bạn liên kết Telegram.',
  );
  await expectNoHorizontalScroll(page);
  await expectAccessible(page, 'Telegram card at 375 px (dark, vi)');
  await card.getByTestId('telegram-link').click();
  // On a phone the button opens the Telegram app; the QR code is for another device.
  await expect(card.getByTestId('telegram-open')).toHaveText('Mở Telegram');
  await expect(card.getByTestId('telegram-qr')).toBeHidden();
  await expect(card.getByTestId('telegram-countdown')).toContainText('Link dùng một lần');
  const box = await card.getByTestId('telegram-open').boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  await expectNoHorizontalScroll(page);
  await expectAccessible(page, 'Telegram link waiting at 375 px (dark, vi)');
  const token = await linkToken(page);
  telegram.send({ chatId: CHAT_ID, text: `/start ${token}` });
  await expect(card.getByTestId('telegram-linked')).toContainText(
    'Đã liên kết với @t555_second_bot',
    {
      timeout: 3000,
    },
  );
  await expectNoHorizontalScroll(page);
  await expectAccessible(page, 'Telegram linked at 375 px (dark, vi)');
  await member.context.close();

  const admin = await openAs(browser, DEMO_ADMIN_EMAIL, {
    viewport: { width: 375, height: 812 },
    language: 'vi',
    colorScheme: 'dark',
  });
  await admin.page.goto(botsPath());
  const section = admin.page.getByTestId('notification-bot');
  await expect(section.getByRole('heading', { name: 'Bot gửi thông báo' })).toBeVisible();
  await expect(section.getByTestId('notification-bot-status')).toHaveText('Đang hoạt động');
  await expectNoHorizontalScroll(admin.page);
  await expectAccessible(admin.page, 'notification bot at 375 px (dark, vi)');
  await admin.context.close();
});

test('1440 px dark and 375 px light: the linked card and the bot section pass axe', async ({
  browser,
}) => {
  for (const options of [
    { viewport: { width: 1440, height: 900 }, colorScheme: 'dark', language: 'vi' },
    { viewport: { width: 375, height: 812 }, colorScheme: 'light', language: 'en' },
  ] as const) {
    const label = `${String(options.viewport.width)} px ${options.colorScheme}`;
    const member = await openAs(browser, EDITOR_EMAIL, options);
    await member.page.goto(settingsPath());
    await expect(member.page.getByTestId('telegram-linked')).toBeVisible();
    await expect(member.page.getByTestId('pref-record.assigned-telegram')).toBeEnabled();
    await expectNoHorizontalScroll(member.page);
    await expectAccessible(member.page, `Telegram linked at ${label}`);
    await member.context.close();
    const admin = await openAs(browser, DEMO_ADMIN_EMAIL, options);
    await admin.page.goto(botsPath());
    await expect(admin.page.getByTestId('notification-bot-username')).toHaveText(
      '@t555_second_bot',
    );
    await expectNoHorizontalScroll(admin.page);
    await expectAccessible(admin.page, `notification bot at ${label}`);
    await admin.context.close();
  }
});
