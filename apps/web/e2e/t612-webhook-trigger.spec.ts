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
 * T612: the `webhook.received` trigger in the automation builder (BACKLOG
 * T612, F§13.2, CONTRACTS §21, §25.3) on the `seed:demo` data:
 *
 * 1. u_admin creates an automation "When a webhook request is received"
 *    (the seed's hook "Đơn từ website" is offered — T615), makes its hook from
 *    the builder ("New webhook": URL + token shown once),
 *    listens for a sample, a request (an API call of the test, like `curl`)
 *    makes the tree appear in < 2 s — without the `authorization` header —
 *    and the tree is browsed with the arrow keys;
 * 2. a `create_record` step on Customers takes `body.customer.email`,
 *    `body.customer.name` and `query.source` from the "+" menu ("Webhook
 *    data"), is saved and turned on; a real request creates that customer;
 * 3. the automation list names the hook;
 * 4. listening 3 minutes without a request ends "expired" (page clock);
 * 5. u_editor: the API refuses such an automation (`403`);
 * 6. Vietnamese at 375 px (the builder is view-only there): no horizontal
 *    scroll, axe on every state.
 *
 * Its own stack, like t611/t614: PostgreSQL 18 + Valkey 8 (Testcontainers),
 * migrations and `seed:demo`, the built API (`MODE=all`, worker included)
 * and `vite preview` of the built SPA proxying `/api` to it, on ports of its
 * own (never the dev servers). `PUBLIC_URL` is the preview, so hook URLs go
 * through its proxy.
 */

const WEB_PORT = Number(process.env['E2E_T612_WEB_PORT'] ?? E2E_WEB_PORT + 62);
const API_PORT = Number(process.env['E2E_T612_API_PORT'] ?? E2E_API_PORT + 62);
const WEB_URL = `http://127.0.0.1:${String(WEB_PORT)}`;
const WEB_DIR = fileURLToPath(new URL('..', import.meta.url));
const API_DIST = fileURLToPath(new URL('../../api/dist/', import.meta.url));
const EDITOR_EMAIL = 'editor@demo.cellhive.local';
const AUTOMATION_NAME = 'Khách từ cửa hàng online';
const HOOK_NAME = 'Shop orders';
const CUSTOMER_EMAIL = `lan.${randomBytes(3).toString('hex')}@example.com`;
const CUSTOMER_NAME = 'Nguyễn Thị Lan';

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
    readonly clock?: boolean;
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
  if (options.clock === true) await page.clock.install();
  await page.goto('/login');
  if (known === undefined) {
    const answer = await call(page, 'POST', '/auth/login', { email, password: DEMO_PASSWORD });
    expect(answer.status, `sign in as ${email}`).toBe(204);
    sessions.set(email, await context.storageState());
  }
  return { context, page };
}

/** A request to a hook URL from outside the browser, like `curl`. */
async function send(url: string, token: string, body: unknown): Promise<number> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  await response.text();
  return response.status;
}

let baseId = '';
let customersId = '';

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
  const storage = await mkdtemp(join(tmpdir(), 'cellhive-e2e-t612-'));
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
  const [customers] = await sql(
    "SELECT id FROM meta.tables WHERE base_id = $1 AND name = 'Customers' AND deleted_at IS NULL",
    [baseId],
  );
  customersId = String(customers?.['id']);
});

test.afterAll(async () => {
  for (const close of closers.reverse()) await close();
});

/** State shared by the serial tests. */
const created = { hookId: '', url: '', token: '', automationId: '' };

/** Picks `label` from the "+" menu of the value control named `control`. */
async function pickValue(page: Page, control: RegExp, label: RegExp): Promise<void> {
  const panel = page.getByTestId('config-panel');
  await panel.getByRole('button', { name: control }).click();
  const picker = panel.getByTestId('value-picker');
  await expect(picker.getByRole('group', { name: 'Webhook data' })).toBeVisible();
  await picker.getByRole('option', { name: label }).click();
}

test('builds a webhook automation: new hook, sample in < 2 s, keyboard tree, mapped paths', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { context, page } = await openAs(browser, DEMO_ADMIN_EMAIL);
  const csp = collectCspViolations(page);
  await page.goto(`/b/${encodeURIComponent(baseId)}/automations`);
  await page.getByTestId('create-automation').click();
  const dialog = page.getByTestId('create-automation-dialog');
  await dialog.getByTestId('create-automation-name').fill(AUTOMATION_NAME);
  await dialog.getByText('When a webhook request is received').click();
  await expect(dialog.getByTestId('trigger-webhook.received')).toBeChecked();
  await dialog.getByTestId('create-automation-submit').click();

  // The seed's hook "Đơn từ website" (CONTRACTS §9, T615) is offered, none chosen yet;
  // a new one is made in the dialog of T611.
  const trigger = page.getByTestId('webhook-trigger');
  await expect(trigger.getByTestId('webhook-trigger-empty')).toHaveCount(0);
  await expect(trigger.getByTestId('webhook-trigger-hook')).toHaveValue('');
  await expect(
    trigger.getByTestId('webhook-trigger-hook').getByRole('option', { name: 'Đơn từ website' }),
  ).toHaveCount(1);
  await expectNoSeriousA11yViolations(page, 'webhook trigger with the seeded hook');
  await trigger.getByTestId('webhook-trigger-create').click();
  const create = page.getByRole('dialog', { name: 'New incoming webhook' });
  await create.getByTestId('hook-name').fill(HOOK_NAME);
  await create.getByTestId('hook-create-submit').click();
  const reveal = page.getByTestId('secret-reveal');
  created.url = await reveal.getByTestId('reveal-url').inputValue();
  created.token = await reveal.getByTestId('reveal-bearer_token').inputValue();
  await reveal.getByTestId('secret-reveal-confirm').check();
  await reveal.getByTestId('secret-reveal-done').click();
  await expect(reveal).toHaveCount(0);
  const [hook] = await sql('SELECT id FROM meta.incoming_webhooks WHERE name = $1', [HOOK_NAME]);
  created.hookId = String(hook?.['id']);
  await expect(trigger.getByTestId('webhook-trigger-hook')).toHaveValue(created.hookId);
  await expect(trigger.getByTestId('webhook-trigger-url')).toHaveValue(created.url);
  await expect(trigger).toContainText(
    'A sample request still runs the automations of this webhook that are on.',
  );
  expect(await page.content()).not.toContain(created.token);

  // Listen, then a request from outside: the tree appears within 2 s.
  await trigger.getByTestId('webhook-listen-start').click();
  await expect(trigger.getByTestId('webhook-listen-waiting')).toBeVisible();
  await expect(trigger.getByTestId('webhook-listen-countdown')).toContainText(/[23]:\d\d left/u);
  await expectNoSeriousA11yViolations(page, 'listening');
  const sentAt = Date.now();
  expect(
    await send(`${created.url}?source=shop`, created.token, {
      customer: { email: 'sample@example.com', name: 'Sample' },
      items: [{ sku: 'A-1' }],
    }),
  ).toBe(202);
  const tree = trigger.getByRole('tree', { name: 'Sample request data' });
  await expect(tree).toBeVisible({ timeout: 2000 });
  expect(Date.now() - sentAt).toBeLessThan(2000);
  await expect(trigger.getByTestId('webhook-listen-captured')).toBeVisible();
  await expect(tree).not.toContainText('authorization');
  await expectNoSeriousA11yViolations(page, 'sample tree');

  // Keyboard: Body → items → customer (jsonb keeps shorter keys first) → open → email → choose.
  await tree.getByRole('treeitem', { name: /^Body/u }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(tree.getByRole('treeitem', { name: /^items/u })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(tree.getByRole('treeitem', { name: /^customer/u })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(tree.getByRole('treeitem', { name: /^customer/u })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await page.keyboard.press('ArrowRight');
  await expect(tree.getByRole('treeitem', { name: /^name/u })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(tree.getByRole('treeitem', { name: /^email/u })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(trigger.getByTestId('sample-path-reference')).toHaveText(
    '{{ [@body.customer.email] }}',
  );
  await page.keyboard.press('ArrowLeft');
  await expect(tree.getByRole('treeitem', { name: /^customer/u })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(tree.getByRole('treeitem', { name: /^Body/u })).toBeFocused();

  // A step creates the customer from the request's data.
  await page.getByTestId('add-step').click();
  await page.getByTestId('add-create_record').click();
  const panel = page.getByTestId('config-panel');
  await panel.getByTestId('action-table').selectOption({ label: 'Customers' });
  await panel.getByTestId('field-map-add').selectOption({ label: 'Email' });
  await pickValue(page, /Insert a value into .*Email/u, /^body\.customer\.email/u);
  await panel.getByTestId('field-map-add').selectOption({ label: 'Tên' });
  await pickValue(page, /Insert a value into .*Tên/u, /^body\.customer\.name/u);
  await panel.getByTestId('field-map-add').selectOption({ label: 'Mã khách hàng' });
  await pickValue(page, /Insert a value into .*Mã khách hàng/u, /^query\.source/u);
  await expect(panel).toContainText('body.customer.email');
  await expectNoSeriousA11yViolations(page, 'create_record with webhook data');
  await page.getByTestId('builder-save').click();
  await expect(page).toHaveURL(/\/automations\/aut_/u);
  created.automationId = /\/automations\/(aut_[^/?]+)/u.exec(page.url())?.[1] ?? '';
  await page.getByTestId('builder-enabled').click();
  await expect(page.getByTestId('builder-enabled')).toBeChecked();
  await expect(page.getByTestId('step-trigger')).toContainText(HOOK_NAME);

  const [stored] = await sql('SELECT definition FROM meta.automations WHERE id = $1', [
    created.automationId,
  ]);
  const definition = stored?.['definition'] as {
    trigger: unknown;
    actions: { config: { fields: Record<string, unknown> } }[];
  };
  expect(definition.trigger).toEqual({
    type: 'webhook.received',
    incoming_webhook_id: created.hookId,
  });
  const values = Object.values(definition.actions[0]?.config.fields ?? {});
  expect(values).toContainEqual({ template: '{{ [@body.customer.email] }}' });
  expect(values).toContainEqual({ template: '{{ [@body.customer.name] }}' });
  expect(values).toContainEqual({ template: '{{ [@query.source] }}' });

  // A real request runs it: the customer is created with the request's data.
  expect(
    await send(`${created.url}?source=shopify`, created.token, {
      customer: { email: CUSTOMER_EMAIL, name: CUSTOMER_NAME },
    }),
  ).toBe(202);
  const views = (await call(page, 'GET', `/tables/${customersId}/views`)).body as {
    items: { id: string; type: string }[];
  };
  const viewId = views.items.find((view) => view.type === 'grid')?.id ?? '';
  await expect
    .poll(
      async () => {
        const answer = await call(
          page,
          'POST',
          `/tables/${customersId}/records/query?field_key_type=name&cell_format=text`,
          { view_id: viewId, offset: 0, limit: 500 },
        );
        const records = (answer.body as { records?: { fields: Record<string, unknown> }[] })
          .records;
        return records?.find((record) => record.fields['Email'] === CUSTOMER_EMAIL)?.fields ?? null;
      },
      { timeout: 30_000 },
    )
    .toMatchObject({ Tên: CUSTOMER_NAME, 'Mã khách hàng': 'shopify' });
  expect(csp).toEqual([]);
  await context.close();
});

test('the automation list names the hook', async ({ browser }) => {
  const { context, page } = await openAs(browser, DEMO_ADMIN_EMAIL);
  await page.goto(`/b/${encodeURIComponent(baseId)}/automations`);
  const row = page.getByTestId(`automation-row-${created.automationId}`);
  await expect(row).toContainText('When a webhook request is received');
  await expect(row).toContainText(HOOK_NAME);
  await expectNoSeriousA11yViolations(page, 'automation list with a webhook trigger');
  await context.close();
});

test('listening 3 minutes without a request ends expired', async ({ browser }) => {
  const { context, page } = await openAs(browser, DEMO_ADMIN_EMAIL, { clock: true });
  await page.goto(`/b/${encodeURIComponent(baseId)}/automations/${created.automationId}`);
  const trigger = page.getByTestId('webhook-trigger');
  await trigger.getByTestId('webhook-listen-start').click();
  await expect(trigger.getByTestId('webhook-listen-waiting')).toBeVisible();
  await page.clock.fastForward('03:01');
  await expect(trigger.getByTestId('webhook-listen-expired')).toContainText(
    'No request arrived within 3 minutes.',
  );
  await expect(trigger.getByTestId('webhook-listen-start')).toHaveText('Listen again');
  await expectNoSeriousA11yViolations(page, 'listening expired');
  // Close the server's window so that later requests are not samples.
  expect((await call(page, 'DELETE', `/incoming-webhooks/${created.hookId}/listen`)).status).toBe(
    204,
  );
  await context.close();
});

test('u_editor cannot create a webhook automation (403)', async ({ browser }) => {
  const { context, page } = await openAs(browser, EDITOR_EMAIL);
  const refused = await call(page, 'POST', `/bases/${baseId}/automations`, {
    name: 'Not mine',
    enabled: false,
    definition: {
      trigger: { type: 'webhook.received', incoming_webhook_id: created.hookId },
      condition: null,
      actions: [],
    },
  });
  expect(refused.status).toBe(403);
  await context.close();
});

test('Vietnamese at 375 px: view only, no horizontal scroll, accessible', async ({ browser }) => {
  const { context, page } = await openAs(browser, DEMO_ADMIN_EMAIL, {
    viewport: { width: 375, height: 812 },
    language: 'vi',
  });
  await page.goto(`/b/${encodeURIComponent(baseId)}/automations/${created.automationId}`);
  const card = page.getByTestId('step-trigger');
  await expect(card).toContainText('Khi webhook nhận request');
  await expect(card).toContainText(HOOK_NAME);
  await expect(page.getByTestId('config-panel')).toHaveCount(0);
  const overflow = () =>
    page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
  expect(await overflow()).toBeLessThanOrEqual(0);
  await expectNoSeriousA11yViolations(page, 'builder 375 px vi');
  await page.goto(`/b/${encodeURIComponent(baseId)}/automations`);
  await expect(page.getByText(HOOK_NAME).first()).toBeVisible();
  expect(await overflow()).toBeLessThanOrEqual(0);
  await context.close();
});
