import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
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
 * T614: the delivery log of HTTP steps in the run history and the webhook
 * mode of the notification bot (CONTRACTS §21, §22.7, §25.5; FRONTEND
 * §13.3, §15.4), end to end:
 *
 * - two automations on Tickets run on a new ticket: one calls a fake
 *   destination that answers `200` JSON, then one that answers `503` with
 *   `Retry-After` — the run waits; the other calls a host that resolves to
 *   a private address outside the allowlist — `ssrf_blocked`;
 * - the base's run history filtered on "Waiting" lists the waiting run; its
 *   drawer shows the host, "1 of 6" attempts, the paused state with the next
 *   attempt time, `HTTP 503`, and the first step's JSON response; the
 *   blocked run explains the block and what an admin can do; never the full
 *   URL;
 * - the admin switches the notification bot to the webhook mode with the
 *   fake Telegram Bot API: a webhook set elsewhere is explained step by
 *   step, then the switch works → "Working"; back to polling deletes the
 *   webhook;
 * - a regular member gets the 404 screen on the bot page;
 * - axe on every state, 1440 px light (English) and 375 px dark
 *   (Vietnamese) without horizontal scrolling.
 *
 * Its own stack like T555 (the API and worker in this process, both on the
 * fake Bot API; the worker resolves the fake destinations with its
 * test-only DNS lookup). The webhook mode needs an `https` `PUBLIC_URL`:
 * the API gets `https://cellhive-t614.e2e.test` (Telegram is fake, nothing
 * resolves it) while the browser talks to the `vite preview` over http —
 * `CORS_ORIGINS` names the preview, cookies follow the request (`auto`).
 */

const WEB_PORT = Number(process.env['E2E_T614_WEB_PORT'] ?? E2E_WEB_PORT + 64);
const API_PORT = Number(process.env['E2E_T614_API_PORT'] ?? E2E_API_PORT + 64);
const WEB_URL = `http://127.0.0.1:${String(WEB_PORT)}`;
const PUBLIC_URL = 'https://cellhive-t614.e2e.test';
const WEB_DIR = fileURLToPath(new URL('..', import.meta.url));
const API_DIST = fileURLToPath(new URL('../../api/dist/', import.meta.url));
const EDITOR_EMAIL = 'editor@demo.cellhive.local';
/** The fake token of the seeded bot "Bot CSKH (demo)" (CONTRACTS §9). */
const SEED_BOT_TOKEN = '123456789:DEMO-not-a-real-bot-token-000000000';
const SEED_BOT = 'Bot CSKH (demo)';
/** Names the worker resolves (test-only lookup): the fake destination, and a private address. */
const OK_HOST = 'ok.t614.test';
const RETRY_HOST = 'retry.t614.test';
const PRIVATE_HOST = 'internal.t614.test';
/** A query parameter that must never reach the page (the log keeps the host only). */
const URL_SECRET = 'T614-query-secret';

interface Pg {
  Client: new (options: { connectionString: string }) => {
    connect: () => Promise<void>;
    query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
    end: () => Promise<void>;
  };
}

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
let destination: Server;
let destinationPort = 0;
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

/** The fake destination: `/ok` answers JSON, `/retry` asks to come back in 10 minutes. */
async function startDestination(): Promise<void> {
  destination = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      if ((request.url ?? '').startsWith('/ok')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ received: true, order: 'T614' }));
        return;
      }
      response.writeHead(503, { 'content-type': 'text/plain', 'retry-after': '600' });
      response.end('busy');
    });
  });
  await new Promise<void>((resolve) => {
    destination.listen(0, '127.0.0.1', resolve);
  });
  const address = destination.address();
  destinationPort = typeof address === 'object' && address !== null ? address.port : 0;
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        destination.closeAllConnections();
        destination.close(() => {
          resolve();
        });
      }),
  );
}

async function startApi(): Promise<void> {
  const core = (await import(
    new URL('../../../packages/server-core/dist/index.js', import.meta.url).href
  )) as CoreBuild;
  const build = (await import(
    new URL('../../api/dist/app.factory.js', import.meta.url).href
  )) as ApiBuild;
  const config = core.loadConfig({ ...env, MODE: 'api', PORT: String(API_PORT) });
  const app = await build.createApp(config, {
    logger: logger('e2e-t614-api'),
    telegramClient: { baseUrl: telegram.baseUrl },
  });
  await app.listen({ port: API_PORT, host: '127.0.0.1' });
  closers.push(() => app.close());
}

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
  const workerLogger = logger('e2e-t614-worker');
  const db = core.createDb({
    url: config.database.url,
    poolMax: 5,
    applicationName: 'e2e-t614-worker',
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
    // The fake destinations are on loopback; the "internal" host is a private address.
    httpDelivery: {
      lookup: (host: string) =>
        Promise.resolve(host === PRIVATE_HOST ? ['10.0.0.7'] : ['127.0.0.1']),
    },
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
const sessions = new Map<string, Session>();

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
    timezoneId: 'UTC',
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

let orgId = '';
let orgSlug = '';
let baseId = '';
let ticketsId = '';
let botSecretId = '';
let waitingRunId = '';
let blockedRunId = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(600_000);
  telegram = await startFakeTelegramBot();
  telegram.setUsername(SEED_BOT_TOKEN, 'cskh_t614_bot');
  closers.push(() => telegram.close());
  await startDestination();
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
  const storage = await mkdtemp(join(tmpdir(), 'cellhive-e2e-t614-'));
  closers.push(() => rm(storage, { recursive: true, force: true }));
  env = {
    PATH: process.env['PATH'],
    HOME: process.env['HOME'],
    NODE_ENV: 'production',
    PUBLIC_URL,
    CORS_ORIGINS: WEB_URL,
    COOKIE_SECURE: 'auto',
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
  const [tickets] = await sql(
    `SELECT t.id, t.base_id FROM meta.tables t JOIN meta.bases b ON b.id = t.base_id
      WHERE b.name = 'Chăm sóc khách hàng' AND t.name = 'Tickets' AND t.deleted_at IS NULL`,
  );
  ticketsId = String(tickets?.['id']);
  baseId = String(tickets?.['base_id']);
  const [bot] = await sql('SELECT id FROM meta.secrets WHERE organization_id = $1 AND name = $2', [
    orgId,
    SEED_BOT,
  ]);
  botSecretId = String(bot?.['id']);
});

test.afterAll(async () => {
  for (const close of closers.reverse()) await close();
});

const botsPath = () => `/o/${encodeURIComponent(orgSlug)}/settings/telegram`;
const runsPath = (query = '') => `/b/${baseId}/automations/runs${query}`;

const httpStep = (id: string, url: string) => ({
  id,
  type: 'http_request',
  config: {
    method: 'POST',
    url: { literal: url },
    query: [],
    headers: [],
    auth: null,
    body: null,
    signing_secret_id: null,
    fail_on_http_error: true,
  },
});

test('HTTP steps run: a delivery waits for its retry, another is blocked', async ({ browser }) => {
  test.setTimeout(240_000);
  const { context, page } = await openAs(browser, DEMO_ADMIN_EMAIL);
  const port = String(destinationPort);
  for (const host of [OK_HOST, RETRY_HOST]) {
    await ok(page, 'POST', `/orgs/${orgId}/http-allowlist`, { pattern: `${host}:${port}` });
  }
  const trigger = { type: 'record.created', table_id: ticketsId };
  const waiting = await ok<{ id: string }>(page, 'POST', `/bases/${baseId}/automations`, {
    name: 'T614 deliver then retry',
    enabled: true,
    definition: {
      trigger,
      actions: [
        httpStep('act_ok', `http://${OK_HOST}:${port}/ok?key=${URL_SECRET}`),
        httpStep('act_retry', `http://${RETRY_HOST}:${port}/retry?key=${URL_SECRET}`),
      ],
    },
  });
  const blocked = await ok<{ id: string }>(page, 'POST', `/bases/${baseId}/automations`, {
    name: 'T614 blocked address',
    enabled: true,
    definition: { trigger, actions: [httpStep('act_private', `http://${PRIVATE_HOST}/hook`)] },
  });
  const fields = await ok<{ items: { id: string; is_primary: boolean }[] }>(
    page,
    'GET',
    `/tables/${ticketsId}/fields`,
  );
  const title = fields.items.find((field) => field.is_primary)?.id ?? '';
  await ok(page, 'POST', `/tables/${ticketsId}/records?field_key_type=id`, {
    records: [{ fields: { [title]: 'T614 ticket' } }],
  });
  // The worker runs both: one waits on its second step (503 + Retry-After), one fails.
  await expect
    .poll(
      async () => {
        const rows = await sql(
          `SELECT r.id, r.automation_id, r.status, d.attempts, d.last_status, d.status AS delivery
             FROM meta.automation_runs r
             LEFT JOIN meta.http_deliveries d ON d.run_id = r.id AND d.status <> 'succeeded'
            WHERE r.automation_id = ANY($1)`,
          [[waiting.id, blocked.id]],
        );
        const wait = rows.find((row) => row['automation_id'] === waiting.id);
        const fail = rows.find((row) => row['automation_id'] === blocked.id);
        waitingRunId = typeof wait?.['id'] === 'string' ? wait['id'] : '';
        blockedRunId = typeof fail?.['id'] === 'string' ? fail['id'] : '';
        return (
          wait?.['status'] === 'waiting' &&
          wait['delivery'] === 'pending' &&
          Number(wait['last_status']) === 503 &&
          fail?.['status'] === 'failed'
        );
      },
      { timeout: 120_000, intervals: [500, 1000, 2000] },
    )
    .toBe(true);
  await context.close();
});

test('run history: the waiting filter, the retry time, the response and the blocked address', async ({
  browser,
}) => {
  const { context, page } = await openAs(browser, DEMO_ADMIN_EMAIL);
  const csp = collectCspViolations(page);
  await page.goto(runsPath('?status=waiting&range=24h'));
  await expect(page.getByTestId('run-filter-status')).toHaveValue('waiting');
  const list = page.getByTestId('run-list');
  await expect(list.getByTestId(`run-row-${waitingRunId}`)).toBeVisible();
  await expect(list.getByTestId(`run-row-${blockedRunId}`)).toHaveCount(0);
  await expect(list.getByTestId(`run-row-${waitingRunId}`)).toContainText(
    'Waiting: a Wait step or an HTTP delivery',
  );
  await page.getByTestId(`run-open-${waitingRunId}`).click();
  const detail = page.getByTestId('run-detail');
  const retry = detail.getByTestId('http-step-act_retry');
  await expect(retry.getByTestId('http-host')).toHaveText(RETRY_HOST);
  await expect(retry.getByTestId('http-attempts')).toHaveText('1 of 6');
  await expect(retry.getByTestId('http-phase')).toHaveAttribute('data-phase', 'paused');
  await expect(retry.getByTestId('http-phase')).toContainText(
    'Paused: the server asked to wait (Retry-After). Next attempt at',
  );
  await expect(retry.getByTestId('http-last-status')).toHaveText('HTTP 503');
  await expect(retry.getByTestId('http-last-error')).toContainText(
    'The server answered with HTTP status 503.',
  );
  const delivered = detail.getByTestId('http-step-act_ok');
  await expect(delivered.getByTestId('http-phase')).toHaveText('Delivered');
  await expect(delivered.getByTestId('http-body')).toContainText('"received": true');
  // The log keeps the host only: never the full URL with its query.
  await expect(detail).not.toContainText(URL_SECRET);
  await expectAccessible(page, 'waiting HTTP run');

  await page.goto(runsPath(`?range=24h&run=${blockedRunId}`));
  const blocked = page.getByTestId('run-detail');
  await expect(blocked.getByTestId('step-error-act_private')).toContainText(
    "The URL leads to a private network address that the organization's HTTP allowlist does not open.",
  );
  await expect(blocked.getByTestId('http-step-act_private').getByTestId('http-host')).toHaveText(
    PRIVATE_HOST,
  );
  await expect(blocked.getByTestId('http-ssrf-hint')).toContainText(
    'can open this host (and its port)',
  );
  await expectAccessible(page, 'blocked HTTP run');
  expect(csp).toEqual([]);
  await context.close();
});

test('run history at 375 px (dark, Vietnamese): no horizontal scroll', async ({ browser }) => {
  const { context, page } = await openAs(browser, DEMO_ADMIN_EMAIL, {
    viewport: { width: 375, height: 812 },
    language: 'vi',
    colorScheme: 'dark',
  });
  await page.goto(runsPath(`?status=waiting&range=24h&run=${waitingRunId}`));
  const retry = page.getByTestId('run-detail').getByTestId('http-step-act_retry');
  await expect(retry.getByTestId('http-attempts')).toHaveText('1 / 6');
  await expect(retry.getByTestId('http-phase')).toContainText('Tạm dừng: máy chủ yêu cầu chờ');
  await expectNoHorizontalScroll(page);
  await expectAccessible(page, 'waiting HTTP run at 375 px');
  await context.close();
});

test('a member has no Telegram bot settings (404)', async ({ browser }) => {
  const { context, page } = await openAs(browser, EDITOR_EMAIL);
  await page.goto(botsPath());
  await expect(page.getByRole('heading', { name: /not found/iu })).toBeVisible();
  await expect(page.getByTestId('delivery-mode')).toHaveCount(0);
  const answer = await call(page, 'GET', `/orgs/${orgId}/notification-channels`);
  expect(answer.status).toBe(403);
  await context.close();
});

test('the notification bot switches to the webhook mode with the fake Telegram', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { context, page } = await openAs(browser, DEMO_ADMIN_EMAIL);
  const csp = collectCspViolations(page);
  await ok(page, 'PATCH', `/orgs/${orgId}/notification-channels`, {
    telegram_secret_id: botSecretId,
  });
  await page.goto(botsPath());
  const mode = page.getByTestId('delivery-mode');
  await expect(page.getByTestId('notification-bot-username')).toHaveText('@cskh_t614_bot');
  await expect(mode).toHaveAttribute('data-mode', 'polling');
  await expect(mode.getByRole('radio', { name: /Polling \(default\)/u })).toBeChecked();

  // A webhook set by another system: refused, explained step by step.
  telegram.setWebhook(true);
  try {
    await mode.getByRole('radio', { name: /^Webhook/u }).check();
    await mode.getByTestId('delivery-mode-save').click();
    const error = mode.getByTestId('delivery-mode-error');
    await expect(error).toContainText('This bot already sends its messages to another webhook');
    await expect(error.getByRole('listitem')).toHaveCount(2);
    await expect(mode).toHaveAttribute('data-mode', 'polling');
    expect(telegram.webhookUrl()).toBe('https://elsewhere.example/telegram/hook');
    await expectAccessible(page, 'webhook conflict');
  } finally {
    telegram.setWebhook(false);
  }

  // Free again: the switch registers Cellhive's webhook → "Working".
  await mode.getByTestId('delivery-mode-save').click();
  await expect(mode).toHaveAttribute('data-mode', 'webhook');
  await expect(mode.getByTestId('delivery-mode-webhook-status')).toHaveText('Working');
  await expect(page.getByText('Telegram now sends this bot’s messages straight')).toBeVisible();
  expect(telegram.webhookUrl().startsWith(`${PUBLIC_URL}/api/v1/telegram/webhook/`)).toBe(true);
  const set = telegram.calls.filter((item) => item.method === 'setWebhook');
  expect(set).toHaveLength(1);
  expect(typeof set[0]?.body['secret_token']).toBe('string');
  // The page never shows the webhook URL (it holds the path token).
  await expect(page.locator('body')).not.toContainText('/api/v1/telegram/webhook/');
  await expectAccessible(page, 'webhook mode working');

  // 375 px, dark, Vietnamese.
  const phone = await openAs(browser, DEMO_ADMIN_EMAIL, {
    viewport: { width: 375, height: 812 },
    language: 'vi',
    colorScheme: 'dark',
  });
  await phone.page.goto(botsPath());
  await expect(phone.page.getByTestId('delivery-mode-webhook-status')).toHaveText('Đang hoạt động');
  await expectNoHorizontalScroll(phone.page);
  await expectAccessible(phone.page, 'webhook mode at 375 px');
  await phone.context.close();

  // Back to polling: the webhook is deleted.
  await mode.getByRole('radio', { name: /Polling \(default\)/u }).check();
  await mode.getByTestId('delivery-mode-save').click();
  await expect(mode).toHaveAttribute('data-mode', 'polling');
  await expect.poll(() => telegram.webhookUrl()).toBe('');
  expect(csp).toEqual([]);
  await context.close();
});
