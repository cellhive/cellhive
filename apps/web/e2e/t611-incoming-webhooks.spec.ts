import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { preview, type PreviewServer } from 'vite';

import { E2E_API_PORT, E2E_WEB_PORT } from './ports';
import { DEMO_ADMIN_EMAIL, DEMO_PASSWORD } from './seed';
import { collectCspViolations, expectNoSeriousA11yViolations } from './support';

/**
 * T611: managing the incoming webhooks of a base (CONTRACTS §25.1, BACKLOG
 * T611) on the `seed:demo` data:
 *
 * 1. the seeded hook "Đơn từ website" is listed (CONTRACTS §9, T615); u_admin
 *    creates a `bearer` hook → URL and token shown once (copy
 *    fields, "I stored it" required to close); after a reload no token is
 *    anywhere on the page;
 * 2. a request with that token (an API call of the test, like `curl`) gets
 *    `202` and a new row in the request log; without it, `401` and no row;
 * 3. adding a signing secret then rotating it: confirmation, the new secret
 *    shown once, "previous secret accepted until …";
 * 4. deleting a hook an automation uses lists that automation (a real
 *    `webhook.received` automation, created off through the API — T612
 *    replaced the SQL-made usage; the builder flow is t612's);
 * 5. u_editor: no sidebar entry, the route is the 404 screen, the API `403`;
 * 6. keyboard only, axe on every state, Vietnamese at 375 px without
 *    horizontal scroll.
 *
 * Its own stack, like t555/t557: PostgreSQL 18 + Valkey 8 (Testcontainers),
 * migrations and `seed:demo`, the built API (`MODE=all`) and `vite preview`
 * of the built SPA proxying `/api` to it, on ports of its own (never the dev
 * servers). `PUBLIC_URL` is the preview, so hook URLs go through its proxy.
 */

const WEB_PORT = Number(process.env['E2E_T611_WEB_PORT'] ?? E2E_WEB_PORT + 61);
const API_PORT = Number(process.env['E2E_T611_API_PORT'] ?? E2E_API_PORT + 61);
const WEB_URL = `http://127.0.0.1:${String(WEB_PORT)}`;
const WEB_DIR = fileURLToPath(new URL('..', import.meta.url));
const API_DIST = fileURLToPath(new URL('../../api/dist/', import.meta.url));
const EDITOR_EMAIL = 'editor@demo.cellhive.local';
/** The automation, triggered by the hook, that keeps it from being deleted. */
const USING_AUTOMATION = 'Đơn từ cửa hàng online';

interface Pg {
  Client: new (options: { connectionString: string }) => {
    connect: () => Promise<void>;
    query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
    end: () => Promise<void>;
  };
}

let postgres: StartedPostgreSqlContainer;
let valkey: StartedTestContainer;
let env: NodeJS.ProcessEnv;
let api: ChildProcess;
let web: PreviewServer;
const closers: (() => Promise<unknown>)[] = [];
const requireFromApi = createRequire(new URL('../../api/package.json', import.meta.url));

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

async function waitUntilUp(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`API exited with code ${String(child.exitCode)}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not listening yet
    }
    await sleep(250);
  }
  throw new Error(`API did not answer ${url} within 60 s`);
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

async function openAs(
  browser: Browser,
  email: string,
  options: {
    readonly viewport?: { width: number; height: number };
    readonly language?: 'en' | 'vi';
  } = {},
): Promise<Opened> {
  const known = sessions.get(email);
  const context = await browser.newContext({
    baseURL: WEB_URL,
    viewport: options.viewport ?? { width: 1440, height: 900 },
    locale: 'en-US',
    permissions: ['clipboard-read', 'clipboard-write'],
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

/** A request to a hook URL from outside the browser, like `curl`. */
async function send(
  url: string,
  token: string | null,
  body: unknown = { order: 1 },
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
}

let baseId = '';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(600_000);
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
  const storage = await mkdtemp(join(tmpdir(), 'cellhive-e2e-t611-'));
  closers.push(() => rm(storage, { recursive: true, force: true }));
  env = {
    PATH: process.env['PATH'],
    HOME: process.env['HOME'],
    NODE_ENV: 'production',
    PORT: String(API_PORT),
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
  api = spawn(process.execPath, [`${API_DIST}main.js`], {
    env: { ...env, MODE: 'all' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  closers.push(async () => {
    if (api.exitCode !== null) return;
    const exited = new Promise((resolve) => api.once('exit', resolve));
    api.kill('SIGTERM');
    await exited;
  });
  await waitUntilUp(`http://127.0.0.1:${String(API_PORT)}/healthz`, api);
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
  const [base] = await sql(
    "SELECT id FROM meta.bases WHERE name = 'Chăm sóc khách hàng' AND deleted_at IS NULL",
  );
  baseId = String(base?.['id']);
});

test.afterAll(async () => {
  for (const close of closers.reverse()) await close();
});

const pagePath = () => `/b/${encodeURIComponent(baseId)}/settings/webhooks`;
/** The hook of `seed:demo` (CONTRACTS §9, T615). */
const SEEDED_HOOK = 'Đơn từ website';
const shopRow = (page: Page) => page.getByTestId('hook-row').filter({ hasText: 'Shop orders' });

/** State shared by the serial tests. */
const created = { id: '', url: '', token: '' };

test('creates a bearer hook: URL and token once, then never again', async ({ browser }) => {
  const { context, page } = await openAs(browser, DEMO_ADMIN_EMAIL);
  const csp = collectCspViolations(page);
  await page.goto(`/b/${encodeURIComponent(baseId)}`);
  // T712: the entry is "Webhooks" in the base settings nav (sidebar: "Base settings").
  await page.getByTestId('base-settings-link').click();
  await page.getByTestId('base-settings-nav-webhooks').click();
  await expect(page).toHaveURL(new RegExp(`${pagePath()}$`, 'u'));
  // The seed's hook (T615) is the only one so far.
  await expect(page.getByTestId('hooks-empty')).toHaveCount(0);
  await expect(page.getByTestId('hook-row')).toHaveCount(1);
  await expect(page.getByTestId('hook-row')).toContainText(SEEDED_HOOK);
  await expectNoSeriousA11yViolations(page, 'webhooks page (seeded hook)');

  await page.getByTestId('hook-add').click();
  const dialog = page.getByRole('dialog', { name: 'New incoming webhook' });
  await expect(dialog.getByTestId('hook-auth-bearer')).toBeChecked();
  await dialog.getByTestId('hook-auth-none').check();
  await expect(dialog.getByTestId('hook-none-warning')).toContainText(
    'Anyone with the URL can call this webhook',
  );
  await expectNoSeriousA11yViolations(page, 'create dialog (none warning)');
  await dialog.getByTestId('hook-auth-bearer').check();
  await dialog.getByTestId('hook-name').fill('Shop orders');
  await dialog.getByTestId('hook-create-submit').click();

  const reveal = page.getByTestId('secret-reveal');
  await expect(reveal.getByTestId('secret-reveal-warning')).toContainText('Shown only once');
  created.url = await reveal.getByTestId('reveal-url').inputValue();
  created.token = await reveal.getByTestId('reveal-bearer_token').inputValue();
  expect(created.url).toMatch(new RegExp(`^${WEB_URL}/api/v1/hooks/[A-Za-z0-9_-]{43}$`, 'u'));
  expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  await expect(reveal.getByTestId('reveal-signing_secret')).toHaveCount(0);
  await reveal.getByTestId('reveal-bearer_token-copy').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(created.token);
  await expectNoSeriousA11yViolations(page, 'secret shown once');
  // Escape and "Done" do not close it before "I stored it".
  await page.keyboard.press('Escape');
  await expect(reveal.getByRole('alert')).toContainText('Confirm that you stored the secret');
  await expect(reveal.getByTestId('secret-reveal-confirm')).toBeFocused();
  await reveal.getByTestId('secret-reveal-done').click();
  await expect(reveal).toBeVisible();
  await reveal.getByTestId('secret-reveal-confirm').check();
  await reveal.getByTestId('secret-reveal-done').click();
  await expect(reveal).toHaveCount(0);

  const row = page.getByTestId('hook-row').filter({ hasText: 'Shop orders' });
  await expect(row).toBeVisible();
  await expect(row.getByTestId('hook-status')).toHaveText('Receiving');
  await expect(row.getByTestId('hook-auth')).toHaveText('Bearer token');
  const [hook] = await sql('SELECT id FROM meta.incoming_webhooks WHERE name = $1', [
    'Shop orders',
  ]);
  created.id = String(hook?.['id']);

  await page.reload();
  await expect(shopRow(page)).toBeVisible();
  await shopRow(page).getByTestId('hook-open').click();
  await expect(page.getByTestId('hook-url')).toHaveValue(created.url);
  expect(await page.content()).not.toContain(created.token);
  await expectNoSeriousA11yViolations(page, 'webhook drawer (settings)');
  expect(csp).toEqual([]);
  await context.close();
});

test('a request with the token appears in the log; without it, 401 and nothing', async ({
  browser,
}) => {
  expect((await send(created.url, null)).status).toBe(401);
  const accepted = await send(created.url, created.token, { order: 42, customer: 'Lan' });
  expect(accepted.status).toBe(202);
  expect(accepted.body).toEqual({ request_id: expect.stringMatching(/^whr_/u) as unknown });

  const { context, page } = await openAs(browser, DEMO_ADMIN_EMAIL);
  await page.goto(`${pagePath()}?hook=${created.id}&tab=requests`);
  const log = page.getByTestId('hook-log');
  await expect(log.getByTestId('hook-log-row')).toHaveCount(1);
  await expect(log).not.toContainText('Lan');
  await expect(shopRow(page).getByTestId('hook-last')).toContainText('Last request');
  expect((await send(created.url, created.token, { order: 43 })).status).toBe(202);
  await log.getByTestId('hook-log-refresh').click();
  await expect(log.getByTestId('hook-log-row')).toHaveCount(2);
  await expectNoSeriousA11yViolations(page, 'request log');
  await context.close();
});

test('adds a signing secret, then rotates it with a 24 h overlap', async ({ browser }) => {
  const { context, page } = await openAs(browser, DEMO_ADMIN_EMAIL);
  await page.goto(`${pagePath()}?hook=${created.id}`);
  const drawer = page.getByTestId('hook-drawer');
  await drawer.getByTestId('hook-add-signature').click();
  const confirm = page.getByRole('alertdialog', { name: 'Require a signature?' });
  await confirm.getByTestId('hook-confirm-confirm').click();
  let reveal = page.getByTestId('secret-reveal');
  const first = await reveal.getByTestId('reveal-signing_secret').inputValue();
  expect(first).toMatch(/^whsec_/u);
  await expect(reveal.getByTestId('reveal-url')).toHaveCount(0);
  await reveal.getByTestId('secret-reveal-confirm').check();
  await reveal.getByTestId('secret-reveal-done').click();
  await expect(shopRow(page).getByTestId('hook-auth')).toHaveText('Bearer + signature');

  await drawer.getByTestId('hook-rotate').click();
  const rotate = page.getByRole('alertdialog', { name: 'Rotate the signing secret?' });
  await expect(rotate).toContainText('keeps working for 24 hours');
  await expectNoSeriousA11yViolations(page, 'rotate confirmation');
  await rotate.getByTestId('hook-confirm-confirm').click();
  reveal = page.getByTestId('secret-reveal');
  const second = await reveal.getByTestId('reveal-signing_secret').inputValue();
  expect(second).toMatch(/^whsec_/u);
  expect(second).not.toBe(first);
  await expect(reveal).toContainText('The previous secret keeps working until');
  await reveal.getByTestId('secret-reveal-confirm').check();
  await reveal.getByTestId('secret-reveal-done').click();
  await expect(drawer.getByTestId('hook-rotating')).toContainText(
    'The previous secret is still accepted until',
  );
  expect(await page.content()).not.toContain(second);
  await context.close();
});

test('deleting a hook an automation uses lists that automation', async ({ browser }) => {
  const { context, page } = await openAs(browser, DEMO_ADMIN_EMAIL);
  const [tickets] = await sql(
    "SELECT id FROM meta.tables WHERE base_id = $1 AND name = 'Tickets' AND deleted_at IS NULL",
    [baseId],
  );
  const automation = await call(page, 'POST', `/bases/${baseId}/automations`, {
    name: USING_AUTOMATION,
    enabled: false,
    definition: {
      trigger: { type: 'webhook.received', incoming_webhook_id: created.id },
      condition: null,
      actions: [
        {
          id: 'act_1',
          type: 'create_record',
          config: { table_id: String(tickets?.['id']), fields: {} },
        },
      ],
    },
  });
  expect(automation.status, JSON.stringify(automation.body)).toBe(201);
  await page.goto(`${pagePath()}?hook=${created.id}`);
  await expect(page.getByTestId('hook-usages')).toContainText(USING_AUTOMATION);
  await page.getByTestId('hook-delete').click();
  const dialog = page.getByRole('alertdialog', { name: 'Delete “Shop orders”?' });
  await expect(dialog.getByTestId('hook-delete-usages')).toContainText(USING_AUTOMATION);
  await expect(dialog.getByTestId('hook-delete-dialog-confirm')).toBeDisabled();
  await expectNoSeriousA11yViolations(page, 'delete in use');
  // The API refuses too: `409 WEBHOOK_IN_USE` naming the automation.
  const refused = await call(page, 'DELETE', `/incoming-webhooks/${created.id}`);
  expect(refused.status).toBe(409);
  expect(JSON.stringify(refused.body)).toContain(USING_AUTOMATION);
  await context.close();
});

test('u_editor: no entry, the 404 screen, and 403 from the API', async ({ browser }) => {
  const { context, page } = await openAs(browser, EDITOR_EMAIL);
  await page.goto(`/b/${encodeURIComponent(baseId)}`);
  await expect(page.getByRole('navigation', { name: 'Tables' })).toBeVisible();
  await expect(page.getByTestId('base-settings-link')).toHaveCount(0);
  await page.goto(pagePath());
  await expect(page.getByText(/not found|404/iu).first()).toBeVisible();
  await expect(page.getByTestId('hook-list')).toHaveCount(0);
  expect((await call(page, 'GET', `/bases/${baseId}/incoming-webhooks`)).status).toBe(403);
  await context.close();
});

test('keyboard only: create a hook and switch drawer tabs', async ({ browser }) => {
  const { context, page } = await openAs(browser, DEMO_ADMIN_EMAIL);
  await page.goto(pagePath());
  // The seeded hook and "Shop orders".
  await expect(page.getByTestId('hook-row')).toHaveCount(2);
  await page.getByTestId('hook-add').focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'New incoming webhook' });
  await expect(dialog.getByTestId('hook-name')).toBeFocused();
  await page.keyboard.type('Form tool');
  // Arrow keys move through the radio group of checks.
  await dialog.getByTestId('hook-auth-bearer').focus();
  await page.keyboard.press('ArrowDown');
  await expect(dialog.getByTestId('hook-auth-both')).toBeChecked();
  await dialog.getByTestId('hook-name').focus();
  await page.keyboard.press('Enter');
  const reveal = page.getByTestId('secret-reveal');
  await expect(reveal.getByTestId('reveal-signing_secret')).toBeVisible();
  await expect(reveal.getByTestId('reveal-bearer_token')).toBeVisible();
  await reveal.getByTestId('secret-reveal-confirm').focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('Tab');
  await expect(reveal.getByTestId('secret-reveal-done')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(reveal).toHaveCount(0);
  await expect(page.getByTestId('hook-row')).toHaveCount(3);

  const manage = page.getByRole('button', { name: 'Manage Form tool' });
  await manage.focus();
  await page.keyboard.press('Enter');
  const settingsTab = page.getByTestId('hook-tab-settings');
  await settingsTab.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('hook-tab-requests')).toBeFocused();
  await expect(page.getByTestId('hook-tab-requests')).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(/tab=requests/u);
  await expect(page.getByTestId('hook-log-empty')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('hook-drawer')).toHaveCount(0);
  await expect(page).not.toHaveURL(/hook=/u);
  await context.close();
});

test('Vietnamese at 375 px: no horizontal scroll, accessible', async ({ browser }) => {
  const { context, page } = await openAs(browser, DEMO_ADMIN_EMAIL, {
    viewport: { width: 375, height: 812 },
    language: 'vi',
  });
  await page.goto(pagePath());
  await expect(page.getByRole('heading', { name: 'Webhook nhận vào' })).toBeVisible();
  await expect(page.getByTestId('hook-row').first()).toContainText('Đang nhận');
  const overflow = () =>
    page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
  expect(await overflow()).toBeLessThanOrEqual(0);
  await expectNoSeriousA11yViolations(page, 'webhooks page 375 px vi');
  await page.getByTestId('hook-open').first().click();
  await expect(page.getByTestId('hook-drawer')).toBeVisible();
  await expect(page.getByTestId('hook-tab-settings')).toHaveText('Cài đặt');
  expect(await overflow()).toBeLessThanOrEqual(0);
  await expectNoSeriousA11yViolations(page, 'webhook drawer 375 px vi');
  await context.close();
});
