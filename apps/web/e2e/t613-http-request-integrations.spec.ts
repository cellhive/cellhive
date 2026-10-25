import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
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

/**
 * T613: the `http_request` / `run_n8n_workflow` editors of the builder and
 * the organization's integrations page (CONTRACTS §21, §24, §25.4–25.5;
 * FRONTEND §13.2, §15.5), end to end:
 *
 * - the owner adds and removes allowlist entries (an IP is refused before
 *   sending), allows the fake destination's host and port, creates a header
 *   secret and a generated signing secret — its value is shown once, and
 *   nowhere after a reload;
 * - in the builder, keyboard first: an `http_request` POST with a JSON body,
 *   the header secret and the signing secret; a `Host` header is flagged
 *   while typing and stops the save; "Send a test" reaches the fake
 *   destination (signed, with the auth header) → `HTTP 200` and the body;
 *   `body.id` is offered to a later `if` step and saved there;
 *   `http://10.0.0.1` is refused because the secrets may not go there (T701), and an allowed
 *   host of the secrets on an internal address is blocked with the allowlist guidance;
 * - an n8n step previews its payload; test send is not offered yet;
 * - a base admin who is not an organization admin gets the 404 screen
 *   (API `403`);
 * - axe on every state, 1440 px light (English) and 375 px dark
 *   (Vietnamese) without horizontal scrolling.
 *
 * Its own stack like T614 (API and worker in this process; the worker
 * resolves the fake destination's name to loopback with its test-only DNS
 * lookup — loopback needs an exact host with its port in the allowlist).
 */

const WEB_PORT = Number(process.env['E2E_T613_WEB_PORT'] ?? E2E_WEB_PORT + 63);
const API_PORT = Number(process.env['E2E_T613_API_PORT'] ?? E2E_API_PORT + 63);
const WEB_URL = `http://127.0.0.1:${String(WEB_PORT)}`;
const WEB_DIR = fileURLToPath(new URL('..', import.meta.url));
const API_DIST = fileURLToPath(new URL('../../api/dist/', import.meta.url));
const EDITOR_EMAIL = 'editor@demo.cellhive.local';
/** The fake destination's name (the worker's lookup answers loopback). */
const ECHO_HOST = 'echo.t613.test';
/** T701: an allowed host of both secrets that resolves to an internal address, not allowlisted. */
const INTERNAL_HOST = 'internal.t613.test';
const HEADER_SECRET = 'Echo token';
const HEADER_VALUE = 'Bearer t613-header-value';
const SIGNING_SECRET = 'Ký n8n T613';

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
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

let postgres: StartedPostgreSqlContainer;
let valkey: StartedTestContainer;
let env: NodeJS.ProcessEnv;
let destination: Server;
let destinationPort = 0;
const received: Received[] = [];
let web: PreviewServer;
const closers: (() => Promise<unknown>)[] = [];
/** Nothing listens there: Telegram calls of the seeded bot fail fast instead of going out. */
const DEAD_TELEGRAM = 'http://127.0.0.1:9';

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

/** The fake destination: records each request and answers JSON with an id. */
async function startDestination(): Promise<void> {
  destination = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({
        method: request.method ?? '',
        path: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 'ord_613', status: 'accepted', items: [{ sku: 'T613' }] }));
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
    logger: logger('e2e-t613-api'),
    telegramClient: { baseUrl: DEAD_TELEGRAM },
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
  const workerLogger = logger('e2e-t613-worker');
  const db = core.createDb({
    url: config.database.url,
    poolMax: 5,
    applicationName: 'e2e-t613-worker',
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
    telegramClient: { baseUrl: DEAD_TELEGRAM },
    // The fake destination is on loopback; any other name is a private address.
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
let automationId = '';
let n8nAutomationId = '';
let headerSecretId = '';
let signingSecretId = '';
let generatedValue = '';
let titleName = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(600_000);
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
  const storage = await mkdtemp(join(tmpdir(), 'cellhive-e2e-t613-'));
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
    `SELECT t.id, t.base_id FROM meta.tables t JOIN meta.bases b ON b.id = t.base_id
      WHERE b.name = 'Chăm sóc khách hàng' AND t.name = 'Tickets' AND t.deleted_at IS NULL`,
  );
  ticketsId = String(tickets?.['id']);
  baseId = String(tickets?.['base_id']);
  const [title] = await sql(
    'SELECT f.name FROM meta.fields f JOIN meta.tables t ON t.primary_field_id = f.id WHERE t.id = $1',
    [ticketsId],
  );
  titleName = String(title?.['name']);
});

test.afterAll(async () => {
  for (const close of closers.reverse()) await close();
});

const integrationsPath = () => `/o/${encodeURIComponent(orgSlug)}/settings/integrations`;

test('integrations: allowlist entries and HTTP secrets, the signing secret shown once', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { context, page } = await openAs(browser, DEMO_ADMIN_EMAIL);
  const csp = collectCspViolations(page);
  await page.goto(`/o/${encodeURIComponent(orgSlug)}/settings/telegram`);
  // The entry in the "Organization settings" nav.
  await page.getByTestId('nav-integrations').click();
  await expect(page).toHaveURL(new RegExp(`${integrationsPath()}$`, 'u'));
  await expect(page.getByRole('heading', { level: 1, name: 'Integrations' })).toBeVisible();
  const allowlist = page.getByTestId('allowlist-section');
  // The seed's example entry (CONTRACTS §9, T615) is the only one so far.
  await expect(allowlist.getByTestId('allowlist-empty')).toHaveCount(0);
  await expect(allowlist.getByTestId('allowlist-row')).toHaveCount(1);
  await expect(allowlist.getByTestId('allowlist-row')).toContainText('n8n.local:5678');
  await expect(allowlist).toContainText('Cloud metadata, broadcast and reserved addresses');
  await expectAccessible(page, 'integrations page (seeded entry)');

  // An IP address is refused before sending.
  await allowlist.getByTestId('allowlist-pattern').fill('10.0.0.1');
  await allowlist.getByTestId('allowlist-add').click();
  await expect(allowlist.getByText(/IP addresses and ranges are not accepted/u)).toBeVisible();
  // Add an entry, then remove it after the confirmation.
  await allowlist.getByTestId('allowlist-pattern').fill('Tmp.T613.Test');
  await expect(allowlist.getByText('Will be saved as tmp.t613.test')).toBeVisible();
  await allowlist.getByTestId('allowlist-add').click();
  await expect(page.getByText('tmp.t613.test added to the allowlist.')).toBeVisible();
  const tmpRow = allowlist.getByTestId('allowlist-row').filter({ hasText: 'tmp.t613.test' });
  await expect(tmpRow).toContainText('Ports 80 and 443');
  await tmpRow.getByRole('button', { name: 'Remove tmp.t613.test' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Remove tmp.t613.test?' });
  await expectAccessible(page, 'remove allowlist entry');
  await confirm.getByTestId('allowlist-remove-dialog-confirm').click();
  await expect(page.getByText('tmp.t613.test removed from the allowlist.')).toBeVisible();
  await expect(tmpRow).toHaveCount(0);
  // The fake destination: exact host with its port (loopback).
  const pattern = `${ECHO_HOST}:${String(destinationPort)}`;
  await allowlist.getByTestId('allowlist-pattern').fill(pattern);
  await allowlist.getByTestId('allowlist-note').fill('Đích giả T613');
  await allowlist.getByTestId('allowlist-pattern').press('Enter');
  await expect(allowlist.getByTestId('allowlist-row').filter({ hasText: pattern })).toContainText(
    `Port ${String(destinationPort)}`,
  );

  // A header secret: write-only value.
  const secrets = page.getByTestId('http-secrets-section');
  await secrets.getByTestId('secret-add').click();
  let dialog = page.getByRole('dialog', { name: 'Add an HTTP secret' });
  await dialog.getByTestId('secret-name').fill(HEADER_SECRET);
  await dialog.getByTestId('secret-value').fill('line\u0007break');
  await dialog.getByTestId('secret-save').click();
  await expect(dialog.getByText(/printable characters only/u)).toBeVisible();
  await dialog.getByTestId('secret-value').fill(HEADER_VALUE);
  // T701: an HTTP secret names the hosts it may be sent to (required).
  await dialog.getByTestId('secret-save').click();
  await expect(dialog.getByText('List at least one host.')).toBeVisible();
  await dialog.getByTestId('secret-allowed-hosts').fill(`${pattern} ${INTERNAL_HOST}:80`);
  await expectAccessible(page, 'add header secret');
  await dialog.getByTestId('secret-save').click();
  await expect(page.getByText(`Secret ${HEADER_SECRET} added.`)).toBeVisible();

  // A generated signing secret: shown once, with Copy, closed only once stored.
  await secrets.getByTestId('secret-add').click();
  dialog = page.getByRole('dialog', { name: 'Add an HTTP secret' });
  await dialog.getByTestId('secret-kind-webhook_signing').check();
  await expect(dialog.getByTestId('secret-mode-generate')).toBeChecked();
  await dialog.getByTestId('secret-name').fill(SIGNING_SECRET);
  await dialog.getByTestId('secret-allowed-hosts').fill(`${pattern} ${INTERNAL_HOST}:80`);
  await dialog.getByTestId('secret-save').click();
  const reveal = page.getByTestId('secret-reveal');
  const value = reveal.getByTestId('secret-reveal-value');
  await expect(value).toHaveValue(/^whsec_[A-Za-z0-9+/]{43}=$/u);
  generatedValue = await value.inputValue();
  await expect(reveal.getByTestId('secret-reveal-value-copy')).toBeVisible();
  await expectAccessible(page, 'signing secret shown once');
  await page.keyboard.press('Escape');
  await expect(reveal.getByRole('alert')).toContainText('cannot be shown again');
  await reveal.getByTestId('secret-reveal-confirm').check();
  await reveal.getByTestId('secret-reveal-done').click();
  await expect(reveal).toHaveCount(0);
  const rows = secrets.getByTestId('http-secret-row');
  // The two of this test and the seed's "CRM API (demo)" (T719, CONTRACTS §9).
  await expect(rows).toHaveCount(3);
  await expect(rows.filter({ hasText: 'CRM API (demo)' })).toHaveCount(1);
  await expect(rows.filter({ hasText: SIGNING_SECRET })).toContainText('Signing secret');
  // Bots of the organization stay on their own page.
  await expect(secrets).not.toContainText('Bot CSKH (demo)');
  await expectAccessible(page, 'integrations page (filled)');

  // After a reload the value is nowhere: not on the page, not in the API.
  await page.reload();
  await expect(page.getByTestId('http-secret-row')).toHaveCount(3);
  await expect(page.locator('body')).not.toContainText(generatedValue);
  const list = await ok<{ items: { id: string; name: string }[] }>(
    page,
    'GET',
    `/orgs/${orgId}/secrets`,
  );
  expect(JSON.stringify(list)).not.toContain(generatedValue);
  expect(JSON.stringify(list)).not.toContain(HEADER_VALUE);
  headerSecretId = list.items.find((item) => item.name === HEADER_SECRET)?.id ?? '';
  signingSecretId = list.items.find((item) => item.name === SIGNING_SECRET)?.id ?? '';
  expect(csp).toEqual([]);
  await context.close();
});

test('builder: an HTTP request built with the keyboard, sent as a test, its body.id used later', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const { context, page } = await openAs(browser, DEMO_ADMIN_EMAIL);
  const csp = collectCspViolations(page);
  const created = await ok<{ id: string }>(page, 'POST', `/bases/${baseId}/automations`, {
    name: 'T613 Gửi ticket ra ngoài',
    definition: { trigger: { type: 'record.created', table_id: ticketsId }, actions: [] },
  });
  automationId = created.id;
  await page.goto(`/b/${baseId}/automations/${automationId}`);
  const addStep = page.getByTestId('add-step');
  await addStep.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('add-http_request')).toBeVisible();
  await page.getByTestId('add-http_request').press('Enter');
  const panel = page.getByTestId('config-panel');
  await expect(panel.getByRole('heading', { name: 'Step 1 · Send HTTP request' })).toBeFocused();
  const editor = panel.getByTestId('http-request-editor');

  // Saving the empty step names the URL.
  await page.keyboard.press('Control+s');
  await expect(editor.getByText('Choose a value.').first()).toBeVisible();

  await expect(editor.getByTestId('http-method')).toHaveValue('POST');
  const url = editor.getByRole('textbox', { name: 'URL' });
  await url.click();
  await page.keyboard.type(`http://${ECHO_HOST}:${String(destinationPort)}/orders`);

  // A header the outbox owns is flagged while typing and stops the save.
  await editor.getByTestId('http-headers-add').click();
  const headerName = editor.getByTestId('http-headers-row-name');
  await headerName.fill('Host');
  await expect(editor.getByTestId('http-headers-row-warning')).toHaveText(
    'Cellhive sets Host itself: remove this header.',
  );
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('issue-summary')).toBeVisible();
  await headerName.fill('X-Source');
  await editor.getByRole('textbox', { name: 'Header value' }).click();
  await page.keyboard.type('cellhive');
  await expect(editor.getByTestId('http-headers-row-warning')).toHaveCount(0);

  // Auth with the header secret, a JSON body, the signing secret.
  await editor.getByText('Header with a secret', { exact: true }).click();
  await editor.getByTestId('http-auth-secret').selectOption({ label: HEADER_SECRET });
  await editor.getByText('JSON', { exact: true }).click();
  const body = editor.getByRole('textbox', { name: 'JSON body' });
  await body.click();
  await page.keyboard.type('{"source": "t613", "count": ');
  await expect(editor.getByTestId('http-json-problem')).toBeVisible();
  await page.keyboard.type('1}');
  await expect(editor.getByTestId('http-json-problem')).toHaveCount(0);
  await editor.getByTestId('http-signing-secret').selectOption({ label: SIGNING_SECRET });
  await expectAccessible(page, 'HTTP request editor');

  await page.keyboard.press('Control+s');
  await expect(page.getByText('Saved “T613 Gửi ticket ra ngoài”.')).toBeVisible();
  await expect(page.getByTestId('step-act_1')).toContainText(`POST http://${ECHO_HOST}`);

  // Send a test: through the outbox to the fake destination.
  const testSection = editor.getByTestId('http-test');
  await expect(testSection.getByTestId('http-test-record')).not.toHaveValue('');
  await testSection.getByTestId('http-test-send').focus();
  await page.keyboard.press('Enter');
  const result = testSection.getByTestId('http-test-result');
  await expect(result).toHaveAttribute('data-status', 'succeeded', { timeout: 60_000 });
  await expect(testSection.getByTestId('http-test-status')).toHaveText('HTTP 200');
  await expect(testSection.getByTestId('http-test-body')).toContainText('"ord_613"');
  const sent = received.at(-1);
  expect(sent?.method).toBe('POST');
  expect(sent?.path).toBe('/orders');
  expect(JSON.parse(sent?.body ?? 'null')).toEqual({ source: 't613', count: 1 });
  expect(sent?.headers['authorization']).toBe(HEADER_VALUE);
  expect(sent?.headers['x-source']).toBe('cellhive');
  expect(sent?.headers['webhook-signature']).toMatch(/^v1,/u);
  expect(sent?.headers['x-cellhive-causation']).toBeUndefined();
  await expectAccessible(page, 'HTTP test result');

  // Offer body.id to later steps (keyboard), then use it in an "if" after.
  const use = testSection.getByRole('button', { name: 'Use body.id in later steps' });
  await use.focus();
  await page.keyboard.press('Enter');
  await expect(use).toHaveAttribute('aria-pressed', 'true');
  await expect(editor.getByTestId('http-path-picked')).toContainText('body.id');
  await page.keyboard.press('Escape');
  await page.getByTestId('add-step').click();
  await page.getByTestId('add-if').click();
  await panel.getByRole('button', { name: 'Value comparison' }).click();
  await panel.getByRole('button', { name: 'Choose a value for Value 1' }).click();
  await page.getByRole('option', { name: 'Step 1 · body.id' }).click();
  await expect(panel.getByTestId('if-value-condition')).toContainText('Step 1 · body.id');
  await page.keyboard.press('Control+s');
  await expect(page.getByText('Unsaved changes')).toHaveCount(0);
  type Saved = { definition: { actions: Record<string, unknown>[] } };
  let saved: Saved = { definition: { actions: [] } };
  await expect
    .poll(async () => {
      saved = await ok<Saved>(page, 'GET', `/automations/${automationId}`);
      return saved.definition.actions.length;
    })
    .toBe(2);
  expect(saved.definition.actions[0]).toMatchObject({
    id: 'act_1',
    type: 'http_request',
    config: {
      method: 'POST',
      url: { literal: `http://${ECHO_HOST}:${String(destinationPort)}/orders` },
      headers: [{ name: 'X-Source', value: { literal: 'cellhive' } }],
      auth: { header_name: 'Authorization', secret_id: headerSecretId },
      body: { type: 'json', value: { template: '\\{"source": "t613", "count": 1}' } },
      signing_secret_id: signingSecretId,
      fail_on_http_error: true,
    },
  });
  expect(saved.definition.actions[1]).toMatchObject({
    type: 'if',
    config: { conditions: [{ value: { step: 'act_1', path: 'body.id' } }] },
  });

  // T701: a host the secrets may not be sent to is refused before anything is queued.
  await page.getByTestId('step-act_1').getByRole('button').first().click();
  const url2 = panel.getByRole('textbox', { name: 'URL' });
  await url2.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('http://10.0.0.1/hook');
  await panel.getByTestId('http-test-send').click();
  await expect(
    panel.getByText('This secret may not be sent to the host of this URL', { exact: false }),
  ).toHaveCount(2);
  // An allowed host of the secrets on an internal address outside the allowlist: blocked,
  // with the guidance (allowed hosts never open internal addresses).
  await url2.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(`http://${INTERNAL_HOST}/hook`);
  await panel.getByTestId('http-test-send').click();
  const error = panel.getByTestId('http-test-error');
  await expect(error).toContainText('This host is on an internal network.', { timeout: 60_000 });
  await expect(error.getByTestId('http-test-allowlist-hint')).toContainText(
    `${INTERNAL_HOST} is an internal address`,
  );
  await expect(error.getByRole('link', { name: 'Open the allowlist' })).toHaveAttribute(
    'href',
    integrationsPath(),
  );
  await expectAccessible(page, 'HTTP test blocked');
  expect(csp).toEqual([]);
  await context.close();
});

test('builder: an n8n step previews its payload and sends a test (T616)', async ({ browser }) => {
  const { context, page } = await openAs(browser, DEMO_ADMIN_EMAIL);
  const created = await ok<{ id: string }>(page, 'POST', `/bases/${baseId}/automations`, {
    name: 'T613 n8n',
    definition: { trigger: { type: 'record.created', table_id: ticketsId }, actions: [] },
  });
  n8nAutomationId = created.id;
  await page.goto(`/b/${baseId}/automations/${n8nAutomationId}`);
  await page.getByTestId('add-step').click();
  await page.getByTestId('add-run_n8n_workflow').click();
  const panel = page.getByTestId('config-panel');
  const editor = panel.getByTestId('n8n-editor');
  await editor.getByRole('textbox', { name: 'Webhook URL' }).click();
  await page.keyboard.type(`http://${ECHO_HOST}:${String(destinationPort)}/webhook/t613`);
  await editor.getByTestId('n8n-secret').selectOption({ label: SIGNING_SECRET });
  await expect(editor.getByTestId('n8n-preview')).toContainText('"record.created"');
  await expect(editor.getByTestId('n8n-preview')).toContainText(`"${titleName}"`);
  await editor.getByText('Chosen fields', { exact: true }).click();
  await expect(editor.getByTestId('n8n-fields')).toBeVisible();
  await expectAccessible(page, 'n8n editor');
  await page.keyboard.press('Control+s');
  await expect(page.getByText('Saved “T613 n8n”.')).toBeVisible();

  // "Send a test" (T616): the real payload, built by the server as the caller, signed.
  const testSection = editor.getByTestId('http-test');
  await expect(testSection.getByTestId('http-test-record')).not.toHaveValue('');
  const before = received.length;
  await testSection.getByTestId('http-test-send').click();
  await expect(testSection.getByTestId('http-test-result')).toHaveAttribute(
    'data-status',
    'succeeded',
    { timeout: 60_000 },
  );
  expect(received.length - before).toBe(1);
  const sent = received.at(-1);
  expect(sent?.path).toBe('/webhook/t613');
  expect(sent?.headers['webhook-signature']).toMatch(/^v1,/u);
  const payload = JSON.parse(sent?.body ?? 'null') as {
    event: { type: string; id: string | null };
    record: { fields: Record<string, unknown> } | null;
  };
  expect(payload.event).toMatchObject({ type: 'record.created', id: null });
  expect(payload.record).not.toBeNull();
  await expectAccessible(page, 'n8n test result');
  await context.close();
});

test('a base admin who is not an organization admin gets the 404 screen and 403', async ({
  browser,
}) => {
  // Make the editor an admin of the base's workspace (a base admin), still a plain org member.
  await sql(
    `INSERT INTO meta.workspace_members (organization_id, workspace_id, principal_type, principal_id, role)
     SELECT b.organization_id, b.workspace_id, 'user', u.id, 'admin'
       FROM meta.users u, meta.bases b
      WHERE u.email = $1 AND b.id = $2
     ON CONFLICT (workspace_id, principal_type, principal_id) DO UPDATE SET role = 'admin'`,
    [EDITOR_EMAIL, baseId],
  );
  // Cached access is keyed by the permission version.
  await sql('UPDATE meta.bases SET permission_version = permission_version + 1 WHERE id = $1', [
    baseId,
  ]);
  const { context, page } = await openAs(browser, EDITOR_EMAIL);
  const base = await ok<{ access: { is_admin: boolean } }>(page, 'GET', `/bases/${baseId}`);
  expect(base.access.is_admin).toBe(true);
  await page.goto(integrationsPath());
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  expect((await call(page, 'GET', `/orgs/${orgId}/http-allowlist`)).status).toBe(403);
  expect((await call(page, 'GET', `/orgs/${orgId}/secrets`)).status).toBe(403);
  await context.close();
});

test('375 px dark, Vietnamese: integrations and the builder without horizontal scrolling', async ({
  browser,
}) => {
  const { context, page } = await openAs(browser, DEMO_ADMIN_EMAIL, {
    viewport: { width: 375, height: 812 },
    language: 'vi',
    colorScheme: 'dark',
  });
  await page.goto(integrationsPath());
  await expect(page.getByRole('heading', { level: 1, name: 'Tích hợp' })).toBeVisible();
  // The seed's example entry and the fake destination.
  await expect(page.getByTestId('allowlist-row')).toHaveCount(2);
  // This test's two secrets and the seed's (T719).
  await expect(page.getByTestId('http-secret-row')).toHaveCount(3);
  await expectNoHorizontalScroll(page);
  await expectAccessible(page, 'integrations 375 px vi dark');
  await page.getByTestId('secret-add').click();
  await expect(page.getByRole('dialog', { name: 'Thêm secret HTTP' })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await expectAccessible(page, 'add secret 375 px vi dark');
  await page.keyboard.press('Escape');

  // The builder on a phone is read-only: the HTTP step card shows method and URL.
  await page.goto(`/b/${baseId}/automations/${automationId}`);
  await expect(page.getByTestId('step-act_1')).toContainText('POST');
  await expectNoHorizontalScroll(page);
  await expectAccessible(page, 'builder 375 px vi dark');
  await context.close();
});
