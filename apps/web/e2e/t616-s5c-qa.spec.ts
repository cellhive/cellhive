import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
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
 * T616 (QA S5c): every S5c screen, in the states a real organization reaches,
 * audited the same way — axe (WCAG 2.2 AA tags) with no serious/critical
 * violation, no horizontal scrolling, no CSP violation — at 1440 px light
 * (Vietnamese), 1440 px dark (English), 375 px light (Vietnamese) and 375 px
 * dark (English); plus the roles (editor, reader, Sales, outsider) and the
 * T616 UI changes (test send of an n8n step, the webhook sample note, the
 * run history filtered by a webhook request, the Telegram webhook choice
 * off when `PUBLIC_URL` is not https, `last_received_at`).
 *
 * States built through the API on the demo seed: an allowlisted fake
 * destination, an `http_header` and a generated `webhook_signing` secret, a
 * Bearer hook whose sample was captured while listening, and one request
 * that runs five automations — `webhook.received` → create a ticket + an
 * HTTP step, then for that ticket an `http_request` (200), a
 * `run_n8n_workflow`, an `http_request` answered `503 Retry-After: 300`
 * (waiting) and one to `10.0.0.1` (blocked, `ssrf_blocked`). The notification
 * bot is the seeded one (fake Telegram, polling).
 *
 * Its own stack (ports `+66`, API and worker in this process; the worker
 * resolves the fake destination to loopback). Set `T616_SHOTS=<dir>` to save
 * a JPEG of each audited screen (the design audit of
 * `docs/reviews/S5c-QA.md`).
 */

const WEB_PORT = Number(process.env['E2E_T616_WEB_PORT'] ?? E2E_WEB_PORT + 66);
const API_PORT = Number(process.env['E2E_T616_API_PORT'] ?? E2E_API_PORT + 66);
const WEB_URL = `http://127.0.0.1:${String(WEB_PORT)}`;
const WEB_DIR = fileURLToPath(new URL('..', import.meta.url));
const API_DIST = fileURLToPath(new URL('../../api/dist/', import.meta.url));
const ECHO_HOST = 'echo.t616.test';
const SEED_BOT = 'Bot CSKH (demo)';
const SEED_BOT_TOKEN = '123456789:DEMO-not-a-real-bot-token-000000000';
const SHOTS = process.env['T616_SHOTS'];
const users = {
  admin: DEMO_ADMIN_EMAIL,
  editor: 'editor@demo.cellhive.local',
  reader: 'reader@demo.cellhive.local',
  sales1: 'sales1@demo.cellhive.local',
  out: 'out@demo.cellhive.local',
} as const;

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
interface Received {
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

let postgres: StartedPostgreSqlContainer;
let valkey: StartedTestContainer;
let telegram: FakeTelegramBot;
let env: NodeJS.ProcessEnv;
let destination: Server;
let destinationPort = 0;
const received: Received[] = [];
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

/** The fake destination: `/retry` answers `503 Retry-After: 300`, anything else `200` JSON. */
async function startDestination(): Promise<void> {
  destination = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({
        path: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      if ((request.url ?? '').startsWith('/retry')) {
        response.writeHead(503, { 'content-type': 'text/plain', 'retry-after': '300' });
        response.end('busy');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'ord_616', ok: true }));
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
    logger: logger('e2e-t616-api'),
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
    Redis: new (url: string, options: Record<string, unknown>) => { quit: () => Promise<unknown> };
  };
  const config = core.loadConfig({ ...env, MODE: 'worker' });
  const workerLogger = logger('e2e-t616-worker');
  const db = core.createDb({
    url: config.database.url,
    poolMax: 5,
    applicationName: 'e2e-t616-worker',
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
    httpDelivery: {
      lookup: (host: string) => Promise.resolve(host === ECHO_HOST ? ['127.0.0.1'] : ['10.0.0.7']),
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

interface Variant {
  readonly name: string;
  readonly viewport: { width: number; height: number };
  readonly language: 'en' | 'vi';
  readonly colorScheme: 'light' | 'dark';
}

const VARIANTS: readonly Variant[] = [
  {
    name: '1440-light-vi',
    viewport: { width: 1440, height: 900 },
    language: 'vi',
    colorScheme: 'light',
  },
  {
    name: '1440-dark-en',
    viewport: { width: 1440, height: 900 },
    language: 'en',
    colorScheme: 'dark',
  },
  {
    name: '375-light-vi',
    viewport: { width: 375, height: 812 },
    language: 'vi',
    colorScheme: 'light',
  },
  {
    name: '375-dark-en',
    viewport: { width: 375, height: 812 },
    language: 'en',
    colorScheme: 'dark',
  },
];
const DESKTOP: Variant = VARIANTS[1] as Variant;

async function openAs(
  browser: Browser,
  email: string,
  variant: Variant = DESKTOP,
): Promise<{ context: BrowserContext; page: Page }> {
  const known = sessions.get(email);
  const context = await browser.newContext({
    baseURL: WEB_URL,
    viewport: variant.viewport,
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: variant.colorScheme,
    ...(known === undefined ? {} : { storageState: known }),
  });
  await context.addInitScript((value) => {
    window.localStorage.setItem('cellhive.language', value);
  }, variant.language);
  const page = await context.newPage();
  await page.goto('/login');
  if (known === undefined) {
    const answer = await call(page, 'POST', '/auth/login', { email, password: DEMO_PASSWORD });
    expect(answer.status, `sign in as ${email}`).toBe(204);
    sessions.set(email, await context.storageState());
  }
  return { context, page };
}

/** axe (no serious/critical), no horizontal scroll; a JPEG with `T616_SHOTS`. */
async function audit(page: Page, label: string): Promise<void> {
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
  const { scroll, width } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    width: window.innerWidth,
  }));
  expect(scroll, `horizontal scroll on ${label}`).toBeLessThanOrEqual(width);
  if (SHOTS !== undefined) {
    await mkdir(SHOTS, { recursive: true });
    await page.screenshot({
      path: join(SHOTS, `${label.replace(/[^a-z0-9-]+/giu, '-')}.jpg`),
      type: 'jpeg',
      quality: 60,
    });
  }
}

let orgId = '';
let orgSlug = '';
let baseId = '';
let ticketsId = '';
let titleFieldId = '';
let hookId = '';
let webhookAutomationId = '';
let httpAutomationId = '';
let n8nAutomationId = '';
let waitingRunId = '';
let blockedRunId = '';
let requestEventId = '';
let botSecretId = '';

const webhooksPath = (query = '') => `/b/${baseId}/settings/webhooks${query}`;
const runsPath = (query = '') => `/b/${baseId}/automations/runs${query}`;
const integrationsPath = () => `/o/${encodeURIComponent(orgSlug)}/settings/integrations`;
const botsPath = () => `/o/${encodeURIComponent(orgSlug)}/settings/telegram`;
const echo = (path: string) => `http://${ECHO_HOST}:${String(destinationPort)}${path}`;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(600_000);
  telegram = await startFakeTelegramBot();
  telegram.setUsername(SEED_BOT_TOKEN, 'cskh_t616_bot');
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
  const storage = await mkdtemp(join(tmpdir(), 'cellhive-e2e-t616-'));
  closers.push(() => rm(storage, { recursive: true, force: true }));
  env = {
    PATH: process.env['PATH'],
    HOME: process.env['HOME'],
    NODE_ENV: 'production',
    PUBLIC_URL: WEB_URL,
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
    `SELECT t.id, t.base_id, t.primary_field_id FROM meta.tables t JOIN meta.bases b ON b.id = t.base_id
      WHERE b.name = 'Chăm sóc khách hàng' AND t.name = 'Tickets' AND t.deleted_at IS NULL`,
  );
  ticketsId = String(tickets?.['id']);
  baseId = String(tickets?.['base_id']);
  titleFieldId = String(tickets?.['primary_field_id']);
  const [bot] = await sql('SELECT id FROM meta.secrets WHERE organization_id = $1 AND name = $2', [
    orgId,
    SEED_BOT,
  ]);
  botSecretId = String(bot?.['id']);

  // --- The S5c states, through the API as the demo admin (owner).
  const { context, page } = await openAs(browser, users.admin);
  await ok(page, 'POST', `/orgs/${orgId}/http-allowlist`, {
    pattern: `${ECHO_HOST}:${String(destinationPort)}`,
    note: 'QA S5c',
  });
  const header = await ok<{ id: string }>(page, 'POST', `/orgs/${orgId}/secrets`, {
    kind: 'http_header',
    name: 'QA header',
    value: 'Bearer qa-t616',
    // T701: HTTP secrets name the hosts they may be sent to.
    allowed_hosts: [`${ECHO_HOST}:${String(destinationPort)}`],
  });
  const signing = await ok<{ id: string }>(page, 'POST', `/orgs/${orgId}/secrets`, {
    kind: 'webhook_signing',
    name: 'QA ký',
    generate: true,
    // T701: HTTP secrets name the hosts they may be sent to.
    allowed_hosts: [`${ECHO_HOST}:${String(destinationPort)}`],
  });
  const hook = await ok<{ id: string; url: string; bearer_token: string }>(
    page,
    'POST',
    `/bases/${baseId}/incoming-webhooks`,
    { name: 'QA đơn hàng', auth: 'bearer' },
  );
  hookId = hook.id;
  const automation = async (name: string, definition: object) =>
    (
      await ok<{ id: string }>(page, 'POST', `/bases/${baseId}/automations`, {
        name,
        enabled: true,
        definition,
      })
    ).id;
  const onTicket = { type: 'record.created', table_id: ticketsId };
  const httpStep = (id: string, url: string, extra: object = {}) => ({
    id,
    type: 'http_request',
    config: { method: 'POST', url: { literal: url }, ...extra },
  });
  webhookAutomationId = await automation('QA webhook → ticket', {
    trigger: { type: 'webhook.received', incoming_webhook_id: hookId },
    actions: [
      {
        id: 'act_create',
        type: 'create_record',
        config: {
          table_id: ticketsId,
          fields: { [titleFieldId]: { template: 'QA {{ [@body.title] }}' } },
        },
      },
      httpStep('act_hook_http', echo('/from-hook'), {
        body: { type: 'json', value: { template: '{"title": "{{ [@body.title] }}"}' } },
      }),
    ],
  });
  httpAutomationId = await automation('QA HTTP ok', {
    trigger: onTicket,
    actions: [
      httpStep('act_http', echo('/orders'), {
        auth: { header_name: 'Authorization', secret_id: header.id },
        signing_secret_id: signing.id,
      }),
    ],
  });
  n8nAutomationId = await automation('QA n8n', {
    trigger: onTicket,
    actions: [
      {
        id: 'act_n8n',
        type: 'run_n8n_workflow',
        config: { url: { literal: echo('/webhook/n8n') }, signing_secret_id: signing.id },
      },
    ],
  });
  const retryAutomationId = await automation('QA HTTP 503', {
    trigger: onTicket,
    actions: [httpStep('act_retry', echo('/retry'))],
  });
  const blockedAutomationId = await automation('QA HTTP private', {
    trigger: onTicket,
    actions: [httpStep('act_private', 'http://10.0.0.1/hook')],
  });

  // Listen, then one request: it becomes the sample and runs the five automations.
  await ok(page, 'POST', `/incoming-webhooks/${hookId}/listen`);
  const sent = await fetch(hook.url.replace(/^https?:\/\/[^/]+/u, WEB_URL), {
    method: 'POST',
    headers: { authorization: `Bearer ${hook.bearer_token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      title: 'Đơn QA-616',
      customer: { email: 'qa@example.com' },
      items: [{ sku: 'S1' }],
    }),
  });
  expect(sent.status).toBe(202);
  const runOf = async (automationId: string, statuses: readonly string[]) => {
    const deadline = Date.now() + 90_000;
    for (;;) {
      const rows = await sql(
        `SELECT id FROM meta.automation_runs WHERE automation_id = $1 AND status = ANY($2::text[])`,
        [automationId, statuses],
      );
      if (rows[0] !== undefined) return String(rows[0]['id']);
      if (Date.now() > deadline) throw new Error(`no ${statuses.join('/')} run of ${automationId}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };
  await runOf(webhookAutomationId, ['succeeded']);
  await runOf(httpAutomationId, ['succeeded']);
  await runOf(n8nAutomationId, ['succeeded']);
  blockedRunId = await runOf(blockedAutomationId, ['failed']);
  waitingRunId = await runOf(retryAutomationId, ['waiting']);
  // The waiting delivery has had its first attempt (503) before the screens are audited.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const [row] = await sql('SELECT attempts FROM meta.http_deliveries WHERE run_id = $1', [
      waitingRunId,
    ]);
    if (Number(row?.['attempts']) >= 1) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const log = await ok<{ items: { event_id: string | null }[] }>(
    page,
    'GET',
    `/incoming-webhooks/${hookId}/requests`,
  );
  requestEventId = String(log.items[0]?.event_id);
  // The seeded bot as notification bot (fake Telegram, polling).
  await ok(page, 'PATCH', `/orgs/${orgId}/notification-channels`, {
    telegram_secret_id: botSecretId,
  });
  await context.close();
});

test.afterAll(async () => {
  for (const close of closers.reverse()) await close();
});

test('roles: only base admins manage hooks, only org admins the integrations (404 screens, 403/404 API)', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  for (const [user, hooksStatus] of [
    ['editor', 403],
    ['reader', 403],
    ['sales1', 403],
    ['out', 404],
  ] as const) {
    const { context, page } = await openAs(browser, users[user]);
    await page.goto(webhooksPath());
    await expect(page.getByRole('heading', { name: /not found/iu }), user).toBeVisible();
    expect((await call(page, 'GET', `/bases/${baseId}/incoming-webhooks`)).status, user).toBe(
      hooksStatus,
    );
    expect((await call(page, 'GET', `/incoming-webhooks/${hookId}/sample`)).status, user).toBe(
      hooksStatus === 403 ? 403 : 404,
    );
    await page.goto(integrationsPath());
    await expect(page.getByRole('heading', { name: /not found/iu }), user).toBeVisible();
    expect(
      (await call(page, 'POST', `/orgs/${orgId}/http-allowlist`, { pattern: 'x.example' })).status,
      user,
      // Every one of them is a member of the organization (u_out only lacks base B): 403 (P49).
    ).toBe(403);
    // Run details with HTTP steps: managers only (404 for the others, P50).
    expect((await call(page, 'GET', `/automation-runs/${waitingRunId}`)).status, user).toBe(404);
    await audit(page, `t616 ${user} 404 screen`);
    await context.close();
  }
});

for (const variant of VARIANTS) {
  test(`every S5c screen, ${variant.name}: axe, no horizontal scroll, no CSP violation`, async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const { context, page } = await openAs(browser, users.admin, variant);
    const csp = collectCspViolations(page);
    const tag = (screen: string) => `t616 ${variant.name} ${screen}`;

    // Incoming webhooks: list (last request from `last_received_at`), drawer, request log.
    await page.goto(webhooksPath());
    const row = page.getByTestId('hook-row').filter({ hasText: 'QA đơn hàng' });
    await expect(row.getByTestId('hook-last').locator('time')).toBeVisible();
    await audit(page, tag('webhooks list'));
    await page.goto(webhooksPath(`?hook=${hookId}&tab=settings`));
    await expect(page.getByTestId('hook-drawer')).toBeVisible();
    await audit(page, tag('webhook drawer settings'));
    await page.goto(webhooksPath(`?hook=${hookId}&tab=requests`));
    const runsLink = page.getByTestId('hook-log').getByRole('link').first();
    await expect(runsLink).toHaveAttribute('href', new RegExp(`event=${requestEventId}`, 'u'));
    await audit(page, tag('webhook request log'));

    // Run history: one webhook request's runs, a waiting HTTP step, a blocked one.
    await page.goto(runsPath(`?event=${requestEventId}&range=all`));
    await expect(page.getByTestId('run-filter-event')).toBeVisible();
    await expect(page.getByTestId('run-list').locator('li')).toHaveCount(1);
    // The run of a webhook request is named, not shown as its raw event type (QA S5c L).
    await expect(page.getByTestId('run-list')).not.toContainText('webhook.received');
    await expect(page.getByTestId('run-list')).toContainText(
      variant.language === 'vi' ? 'Webhook nhận request' : 'Webhook request received',
    );
    await audit(page, tag('runs of a webhook request'));
    await page.goto(runsPath(`?range=all&run=${waitingRunId}`));
    const waiting = page.getByTestId('run-detail');
    await expect(waiting.getByTestId('http-attempts')).toBeVisible();
    await audit(page, tag('run waiting HTTP 503'));
    await page.goto(runsPath(`?range=all&run=${blockedRunId}`));
    await expect(page.getByTestId('run-detail').getByTestId('http-ssrf-hint')).toBeVisible();
    await audit(page, tag('run blocked SSRF'));

    // Integrations: allowlist + HTTP secrets.
    await page.goto(integrationsPath());
    await expect(page.getByTestId('allowlist-section')).toContainText(ECHO_HOST);
    await audit(page, tag('integrations'));

    // Telegram notification bot: PUBLIC_URL is http here, so the webhook choice is off up front.
    await page.goto(botsPath());
    const mode = page.getByTestId('delivery-mode');
    await expect(mode.getByTestId('delivery-mode-webhook')).toBeDisabled();
    await expect(mode.getByTestId('delivery-mode-unavailable')).toBeVisible();
    await audit(page, tag('telegram delivery mode'));

    // The builder of the webhook automation (read-only below 768 px).
    await page.goto(`/b/${baseId}/automations/${webhookAutomationId}`);
    await expect(page.getByTestId('step-act_hook_http')).toBeVisible();
    await audit(page, tag('builder webhook automation'));
    expect(csp).toEqual([]);
    await context.close();
  });
}

test('builder, 1440 px: listened sample in the trigger, test sends from the sample and of an n8n step', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  for (const variant of VARIANTS.slice(0, 2)) {
    const { context, page } = await openAs(browser, users.admin, variant);
    const csp = collectCspViolations(page);
    const tag = (screen: string) => `t616 ${variant.name} ${screen}`;
    const panel = page.getByTestId('config-panel');

    await page.goto(`/b/${baseId}/automations/${webhookAutomationId}`);
    await page.getByTestId('step-trigger').getByRole('button').first().click();
    await expect(panel.getByTestId('webhook-listen-captured')).toBeVisible();
    await audit(page, tag('trigger with captured sample'));

    // The HTTP step of a webhook automation: the test reads the captured sample.
    await page.getByTestId('step-act_hook_http').getByRole('button').first().click();
    const test = panel.getByTestId('http-test');
    await expect(test.getByTestId('http-test-sample')).toBeVisible();
    const before = received.length;
    await test.getByTestId('http-test-send').click();
    await expect(test.getByTestId('http-test-result')).toHaveAttribute('data-status', 'succeeded', {
      timeout: 60_000,
    });
    await expect(test.getByTestId('http-test-no-sample')).toHaveCount(0);
    expect(received.slice(before).some((item) => item.body.includes('Đơn QA-616'))).toBe(true);
    await audit(page, tag('http step test from the sample'));

    // An n8n step: "Send a test" with the real payload (T616).
    await page.goto(`/b/${baseId}/automations/${n8nAutomationId}`);
    await page.getByTestId('step-act_n8n').getByRole('button').first().click();
    const n8nTest = panel.getByTestId('http-test');
    await expect(n8nTest.getByTestId('http-test-record')).not.toHaveValue('');
    const n8nBefore = received.length;
    await n8nTest.getByTestId('http-test-send').click();
    await expect(n8nTest.getByTestId('http-test-result')).toHaveAttribute(
      'data-status',
      'succeeded',
      { timeout: 60_000 },
    );
    const payload = received.slice(n8nBefore).find((item) => item.path === '/webhook/n8n');
    expect(payload?.headers['webhook-signature']).toMatch(/^v1,/u);
    expect(JSON.parse(payload?.body ?? '{}')).toMatchObject({
      event: { type: 'record.created', id: null },
    });
    await audit(page, tag('n8n step test result'));

    // The HTTP step editor with a test result.
    await page.goto(`/b/${baseId}/automations/${httpAutomationId}`);
    await page.getByTestId('step-act_http').getByRole('button').first().click();
    await panel.getByTestId('http-test').getByTestId('http-test-send').click();
    await expect(panel.getByTestId('http-test-status')).toHaveText('HTTP 200', { timeout: 60_000 });
    await audit(page, tag('http step test result'));
    expect(csp).toEqual([]);
    await context.close();
  }
});
