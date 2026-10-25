import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';

import { type Browser, type BrowserContext, type Page } from '@playwright/test';

import { FAKE_OIDC_NAME, MAIL_OIDC_NAME } from './fake-oidc';
import { expect, test, WORKER_ORG } from './fixtures';
import { E2E_API_PORT, E2E_STACK_ENV } from './ports';
import { DEMO_PASSWORD } from './seed';
import { api, apiSignIn, collectCspViolations, ok } from './support';

import type { AddressInfo, Socket } from 'node:net';

/**
 * T719: the S6 milestone (SPEC §22, BACKLOG "Mốc S6", adjusted by "Quyết
 * định S6") end to end on the shared E2E stack (`seed:demo`, the built API
 * with its worker, the built SPA, the fake OIDC provider):
 *
 * 1. u_admin builds the role "Sales" in the role editor (T713) on a base of
 *    its own — Orders: edit, records owned by the viewer, `cost` none,
 *    downloads on — and gives it to u_sales2 (T712) → u_sales2 sees only
 *    their order without `cost` in the grid, through the session API, an
 *    API token made in the tokens page (T714), a WebSocket opened with that
 *    token (Node `ws`, `Authorization`) and the CSV export;
 * 2. the token revoked in the tokens page → HTTP `401` at once, the
 *    WebSocket closed (`4401`) within 1 s;
 * 3. sign-in with the fake IdP: a new person gets an account (JIT); the
 *    email of u_sales1 with an unverified email never reaches u_sales1's
 *    account — neither without linking by email (Fake IdP) nor with it
 *    (Mail IdP, `LINK_BY_EMAIL=true`);
 * 4. the base audit viewer (T716) filtered by person (u_sales2) and action
 *    (records) lists exactly u_sales2's changes;
 * 5. an HTTP secret allowed on one host, sent by an automation whose URL
 *    comes from a field pointing elsewhere → the step fails
 *    `secret_host_not_allowed`, the destination gets 0 connections;
 * 6. a delivery whose job was lost (deleted, its due time moved a minute
 *    back — the injected clock of this test) is rescued by the cron within
 *    2 minutes and delivered.
 *
 * t316/t314 10/10 are separate runs (`--repeat-each=10`, BACKLOG T719).
 */

/** Distinct per run (also per `--repeat-each` round: set in `beforeAll`). */
let RUN = '';
const SALES1_EMAIL = WORKER_ORG.email('sales1');
const SALES2_EMAIL = WORKER_ORG.email('sales2');
const SALES2_NAME = 'Võ Đức Huy';
const API_URL = `http://127.0.0.1:${String(E2E_API_PORT)}`;

const requireFromApi = createRequire(new URL('../../api/package.json', import.meta.url));

interface Pg {
  Client: new (options: { connectionString: string }) => {
    connect: () => Promise<void>;
    query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
    end: () => Promise<void>;
  };
}

/** Direct SQL on the stack's database (checks and the "lost job" of step 6). */
async function sql(text: string, values: unknown[] = []): Promise<Record<string, unknown>[]> {
  const raw = process.env[E2E_STACK_ENV];
  if (raw === undefined) throw new Error('The E2E global setup did not publish the stack env.');
  const { DATABASE_URL } = JSON.parse(raw) as { DATABASE_URL: string };
  const pg = requireFromApi('pg') as Pg;
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return (await client.query(text, values)).rows;
  } finally {
    await client.end();
  }
}

interface WsMessage {
  type: string;
  record_id?: string;
  fields?: Record<string, unknown>;
}

interface TokenSocket {
  readonly messages: WsMessage[];
  readonly closed: Promise<number>;
  send(message: unknown): void;
  close(): void;
}

/** A Node WebSocket client with `Authorization: Bearer` (no Origin), like a script would. */
async function openTokenSocket(token: string): Promise<TokenSocket> {
  const { WebSocket } = requireFromApi('ws') as {
    WebSocket: new (
      url: string,
      options: { headers: Record<string, string> },
    ) => {
      on(event: 'message', listener: (data: Buffer) => void): void;
      on(event: 'close', listener: (code: number) => void): void;
      once(event: 'open' | 'error', listener: (error?: Error) => void): void;
      send(data: string): void;
      close(): void;
    };
  };
  const ws = new WebSocket(`ws://127.0.0.1:${String(E2E_API_PORT)}/ws`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const messages: WsMessage[] = [];
  ws.on('message', (data) => messages.push(JSON.parse(data.toString('utf8')) as WsMessage));
  const closed = new Promise<number>((resolve) => {
    ws.on('close', (code) => {
      resolve(code);
    });
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => {
      resolve();
    });
    ws.once('error', reject);
  });
  return {
    messages,
    closed,
    send: (message) => {
      ws.send(JSON.stringify(message));
    },
    close: () => {
      ws.close();
    },
  };
}

/** A loopback HTTP destination counting connections; `reply` decides each answer. */
interface Destination {
  readonly port: number;
  connections: number;
  readonly received: { url: string; at: number; headers: IncomingMessage['headers'] }[];
  reply: (req: IncomingMessage, res: ServerResponse) => void;
  close(): Promise<void>;
}

async function startDestination(): Promise<Destination> {
  const sockets = new Set<Socket>();
  const destination: Destination = {
    port: 0,
    connections: 0,
    received: [],
    reply: (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, 'close');
    },
  };
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      destination.received.push({ url: req.url ?? '', at: Date.now(), headers: req.headers });
      destination.reply(req, res);
    });
  });
  server.on('connection', (socket) => {
    destination.connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  // `localhost` may resolve to ::1 or 127.0.0.1: listen on both.
  server.listen(0, '::');
  await once(server, 'listening');
  (destination as { port: number }).port = (server.address() as AddressInfo).port;
  return destination;
}

interface Fixture {
  orgId: string;
  orgSlug: string;
  baseId: string;
  orders: string;
  fld: Record<'title' | 'amount' | 'cost' | 'owner', string>;
  records: Record<'r1' | 'r2' | 'r3', string>;
  sales1: string;
  sales2: string;
  roleId: string;
  token: string;
}

const fx = {} as Fixture;
const cleanup: ((page: Page) => Promise<unknown>)[] = [];

type Cookies = Awaited<ReturnType<BrowserContext['cookies']>>;
const cookies: Record<string, Cookies> = {};

/** A new context signed in as `email` (once per user and spec: 20 sign-ins a minute per IP). */
async function openAs(
  browser: Browser,
  email: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    ignoreHTTPSErrors: true,
  });
  await context.addInitScript(() => {
    window.localStorage.setItem('cellhive.language', 'en');
  });
  const page = await context.newPage();
  await page.goto('/login');
  const saved = cookies[email];
  if (saved === undefined) {
    await apiSignIn(page, email, DEMO_PASSWORD);
    cookies[email] = await context.cookies();
  } else {
    await context.addCookies(saved);
  }
  return { context, page };
}

/** A request with the API token, straight to the API (a script, not a browser). */
async function bearer(
  token: string,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> | null; text: string }> {
  const response = await fetch(`${API_URL}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> | null;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  return { status: response.status, body: parsed, text };
}

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
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const group = (page: Page, name: string) => page.getByRole('radiogroup', { name });
const gridCells = (page: Page) => page.locator('table[role="grid"] td[role="gridcell"]');
const columnHeader = (page: Page, name: string) =>
  page.locator('table[role="grid"] th[role="columnheader"]').filter({ hasText: name });

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  RUN = randomBytes(3).toString('hex');
  const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
  const me = await ok<{ orgs: { id: string; slug: string }[] }>(page, 'GET', '/me');
  fx.orgId = me.orgs[0]?.id ?? '';
  fx.orgSlug = me.orgs[0]?.slug ?? '';
  const workspace = await ok<{ id: string }>(page, 'POST', `/orgs/${fx.orgId}/workspaces`, {
    name: `T719 ${RUN}`,
  });
  const base = await ok<{ id: string }>(page, 'POST', `/workspaces/${workspace.id}/bases`, {
    name: `Mốc S6 ${RUN}`,
  });
  fx.baseId = base.id;
  cleanup.push((admin) => api(admin, 'DELETE', `/bases/${base.id}`));
  const orders = await ok<{ id: string; primary_field_id: string }>(
    admin(page),
    'POST',
    `/bases/${base.id}/tables`,
    { name: 'Orders', primary_field_name: 'title' },
  );
  fx.orders = orders.id;
  const add = async (name: string, type: string, options: unknown = {}) =>
    (await ok<{ id: string }>(page, 'POST', `/tables/${orders.id}/fields`, { name, type, options }))
      .id;
  fx.fld = {
    title: orders.primary_field_id,
    amount: await add('amount', 'number'),
    cost: await add('cost', 'number'),
    owner: await add('owner', 'user', { multiple: false }),
  };
  const principals = await ok<{
    items: { principal_type: string; principal_id: string; email: string | null }[];
  }>(page, 'GET', `/bases/${base.id}/principals?limit=200`);
  const user = (email: string) =>
    principals.items.find((item) => item.email === email)?.principal_id ?? '';
  fx.sales1 = user(SALES1_EMAIL);
  fx.sales2 = user(SALES2_EMAIL);
  const rows = await ok<{ records: { id: string }[] }>(
    page,
    'POST',
    `/tables/${orders.id}/records?field_key_type=id`,
    {
      records: [
        {
          fields: {
            [fx.fld.title]: `S6-r1-${RUN}`,
            [fx.fld.owner]: [{ id: fx.sales1 }],
            [fx.fld.amount]: 100,
            [fx.fld.cost]: 40,
          },
        },
        {
          fields: {
            [fx.fld.title]: `S6-r2-${RUN}`,
            [fx.fld.owner]: [{ id: fx.sales2 }],
            [fx.fld.amount]: 200,
            [fx.fld.cost]: 80,
          },
        },
        { fields: { [fx.fld.title]: `S6-r3-${RUN}` } },
      ],
    },
  );
  fx.records = {
    r1: rows.records[0]?.id ?? '',
    r2: rows.records[1]?.id ?? '',
    r3: rows.records[2]?.id ?? '',
  };
  await context.close();
});

/** The same page (readability: `ok(admin(page), …)`). */
function admin(page: Page): Page {
  return page;
}

test.afterAll(async ({ browser }) => {
  const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
  for (const step of cleanup.reverse()) await step(page);
  await context.close();
});

test('u_admin builds Sales in the role editor; u_sales2 sees only r2 in the grid, the API, a token, a token WebSocket and the export', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
  const csp = collectCspViolations(page);
  await page.goto(`/b/${fx.baseId}/settings/roles`);
  await page.getByTestId('role-create').click();
  await page.getByRole('dialog', { name: 'New role' }).getByLabel('Name').fill('Sales');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Role “Sales” created.')).toBeVisible();
  await page.getByRole('link', { name: 'Permissions of Sales' }).click();
  await expect(page).toHaveURL(/\/settings\/roles\/rol_[^/?]+$/u);
  fx.roleId = new URL(page.url()).pathname.split('/').pop() ?? '';

  // General: exports allowed (the milestone exports as u_sales2).
  await page.getByTestId('base-rule-download').check();
  // Orders: Edit.
  await group(page, 'Access to Orders').getByRole('radio', { name: 'Edit' }).click();
  await page.getByRole('link', { name: /^Details of Orders/u }).click();
  const detail = page.getByTestId('table-detail');
  await detail.getByRole('checkbox', { name: 'Add records' }).check();
  await detail.getByTestId('records-edit-where').check();
  const rule = detail.getByTestId('rule-filter');
  await rule.getByRole('button', { name: 'Add condition', exact: true }).click();
  await rule.getByRole('combobox', { name: 'Field' }).selectOption({ label: 'owner' });
  await rule.getByRole('checkbox', { name: 'Current user (whoever views)' }).check();
  await detail.getByTestId('records-read-editable').check();
  await detail.getByTestId('field-mode-specify').check();
  await group(page, 'Permission on cost').getByRole('radio', { name: 'None' }).click();
  await page.getByTestId('role-save').click();
  await expect(page.getByText('Permissions of “Sales” saved.')).toBeVisible();

  const saved = await ok<{
    config: { base_rule: { download: boolean }; tables: Record<string, Record<string, unknown>> };
  }>(page, 'GET', `/bases/${fx.baseId}/roles/${fx.roleId}`);
  expect(saved.config.base_rule.download).toBe(true);
  expect(saved.config.tables[fx.orders]).toMatchObject({
    perm: 'edit',
    record_rule: { read_scope: 'editable', operations: ['add'] },
    field_rule: { mode: 'specify', fields: { [fx.fld.cost]: 'no_perm' } },
  });

  // Members: give it to u_sales2.
  await page
    .getByRole('navigation', { name: 'Base settings' })
    .getByRole('link', { name: 'Members' })
    .click();
  await page.getByLabel('Search people and groups').fill(SALES2_NAME);
  await page
    .getByRole('combobox', { name: `Role of ${SALES2_NAME}` })
    .selectOption({ label: 'Sales' });
  await expect(page.getByText(`${SALES2_NAME} now has the role Sales.`)).toBeVisible();
  expect(csp).toEqual([]);
  await context.close();

  // u_sales2 — the grid: r2 only, no cost column.
  const sales2 = await openAs(browser, SALES2_EMAIL);
  await sales2.page.goto(`/b/${fx.baseId}/t/${fx.orders}`);
  await expect(gridCells(sales2.page).filter({ hasText: `S6-r2-${RUN}` })).toHaveCount(1);
  await expect(columnHeader(sales2.page, 'amount')).toHaveCount(1);
  await expect(columnHeader(sales2.page, 'cost')).toHaveCount(0);
  await expect(gridCells(sales2.page).filter({ hasText: `S6-r1-${RUN}` })).toHaveCount(0);
  await expect(gridCells(sales2.page).filter({ hasText: `S6-r3-${RUN}` })).toHaveCount(0);

  // The session API.
  const list = await ok<{ records: { id: string; fields: Record<string, unknown> }[] }>(
    sales2.page,
    'GET',
    `/tables/${fx.orders}/records?field_key_type=id`,
  );
  expect(list.records.map((record) => record.id)).toEqual([fx.records.r2]);
  expect(Object.keys(list.records[0]?.fields ?? {})).not.toContain(fx.fld.cost);

  // An API token made in the tokens page ("Read data", 90 days).
  await sales2.page.goto(`/o/${fx.orgSlug}/settings/api-tokens`);
  await sales2.page.getByTestId('token-create').click();
  const dialog = sales2.page.getByRole('dialog', { name: 'New API token' });
  await dialog.getByTestId('token-name-input').fill(`Milestone ${RUN}`);
  await expect(dialog.getByTestId('token-preset-read')).toBeChecked();
  await sales2.page.keyboard.press('Enter');
  const reveal = sales2.page.getByRole('dialog', { name: 'Copy your new token' });
  fx.token = await reveal.getByTestId('token-value').inputValue();
  expect(fx.token).toMatch(/^cht_[0-9A-Za-z]{36}$/u);
  await reveal.getByTestId('token-reveal-confirm').check();
  await reveal.getByTestId('token-reveal-done').click();
  await expect(reveal).toBeHidden();

  const viaToken = await bearer(fx.token, 'GET', `/tables/${fx.orders}/records?field_key_type=id`);
  expect(viaToken.status, viaToken.text).toBe(200);
  const tokenRecords = (viaToken.body?.['records'] ?? []) as {
    id: string;
    fields: Record<string, unknown>;
  }[];
  expect(tokenRecords.map((record) => record.id)).toEqual([fx.records.r2]);
  expect(Object.keys(tokenRecords[0]?.fields ?? {})).not.toContain(fx.fld.cost);
  const write = await bearer(fx.token, 'PATCH', `/tables/${fx.orders}/records/${fx.records.r2}`, {
    fields: { amount: 1 },
  });
  expect(write.status).toBe(403);
  expect(write.body?.['code']).toBe('INSUFFICIENT_SCOPE');

  // A WebSocket opened with the token: only r2, without cost.
  const socket = await openTokenSocket(fx.token);
  socket.send({ type: 'subscribe', req_id: 's1', channel: `table:${fx.orders}` });
  await expect.poll(() => socket.messages.some((m) => m.type === 'subscribed')).toBe(true);
  const adminPage = await openAs(browser, WORKER_ORG.email('admin'));
  const patch = (id: string, fields: Record<string, unknown>) =>
    ok(adminPage.page, 'PATCH', `/tables/${fx.orders}/records?field_key_type=id`, {
      records: [{ id, fields }],
    });
  await patch(fx.records.r1, { [fx.fld.amount]: 101 });
  await patch(fx.records.r2, { [fx.fld.cost]: 81 });
  await patch(fx.records.r2, { [fx.fld.amount]: 201 });
  const update = await eventually(
    () =>
      Promise.resolve(
        socket.messages.find((m) => m.type === 'record.updated' && m.record_id === fx.records.r2),
      ),
    'the r2 update over the token WebSocket',
    10_000,
  );
  expect(update.fields).toEqual({ [fx.fld.amount]: 201 });
  expect(socket.messages.filter((m) => m.record_id === fx.records.r1)).toEqual([]);
  expect(socket.messages.filter((m) => m.record_id === fx.records.r2)).toHaveLength(1);

  // The export (CSV): r2 only, no cost column.
  const csv = await sales2.page.request.get(`/api/v1/tables/${fx.orders}/export?format=csv`);
  expect(csv.status()).toBe(200);
  const text = await csv.text();
  expect(text.split(/\r?\n/u)[0]).not.toContain('cost');
  expect(text).toContain(`S6-r2-${RUN}`);
  expect(text).not.toContain(`S6-r1-${RUN}`);
  expect(text).not.toContain(`S6-r3-${RUN}`);

  // Revoked in the tokens page: 401 at once, the socket closes within 1 s.
  await sales2.page.goto(`/o/${fx.orgSlug}/settings/api-tokens`);
  await sales2.page.getByRole('button', { name: `Revoke Milestone ${RUN}` }).click();
  const confirm = sales2.page.getByRole('alertdialog', { name: `Revoke “Milestone ${RUN}”?` });
  const revoked = sales2.page.waitForResponse(
    (response) =>
      response.request().method() === 'DELETE' && /\/api-tokens\//u.test(response.url()),
  );
  await confirm.getByTestId('token-revoke-confirm').click();
  expect((await revoked).status()).toBe(204);
  const since = Date.now();
  const after = await bearer(fx.token, 'GET', `/tables/${fx.orders}/records`);
  expect(after.status).toBe(401);
  expect(after.body?.['code']).toBe('TOKEN_REVOKED');
  expect(await socket.closed).toBe(4401);
  expect(Date.now() - since).toBeLessThan(1_000);
  await sales2.context.close();
  await adminPage.context.close();
});

test('sign-in with the fake IdP; an unverified email never takes over u_sales1', async ({
  browser,
}) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'en-US' });
  const page = await context.newPage();
  const atProvider = async (
    provider: string,
    user: { sub: string; email: string; verified: boolean },
  ) => {
    await page.goto('/login');
    await page.getByRole('link', { name: `Continue with ${provider}` }).click();
    await expect(page.getByRole('heading', { name: 'Fake IdP' })).toBeVisible();
    await page.getByLabel('Subject').fill(user.sub);
    await page.getByLabel('Email', { exact: true }).fill(user.email);
    await page.getByLabel('Email verified').setChecked(user.verified);
    await page.getByRole('button', { name: 'Sign in to Fake IdP' }).click();
  };

  // u_sales1's email, unverified, on both providers → no account taken.
  for (const provider of [FAKE_OIDC_NAME, MAIL_OIDC_NAME]) {
    await atProvider(provider, {
      sub: `takeover-${provider.slice(0, 4)}-${RUN}`,
      email: SALES1_EMAIL,
      verified: false,
    });
    await expect(page).toHaveURL(/\/login\?error=OIDC_ACCOUNT_EXISTS$/u);
    expect((await api(page, 'GET', '/me')).status).toBe(401);
  }
  const sales1Identities = await sql(
    `SELECT count(*)::int AS n FROM meta.user_identities i JOIN meta.users u ON u.id = i.user_id
      WHERE u.email = $1`,
    [SALES1_EMAIL],
  );
  expect(sales1Identities[0]?.['n']).toBe(0);

  // A new person signs in with the provider (JIT on the Fake IdP).
  const email = `s6-${RUN}@sso.example.test`;
  await atProvider(FAKE_OIDC_NAME, { sub: `s6-${RUN}`, email, verified: true });
  await expect(page).not.toHaveURL(/\/login/u);
  const me = await ok<{ user: { email: string } }>(page, 'GET', '/me');
  expect(me.user.email).toBe(email);
  await context.close();
});

test('the base audit viewer filtered by person (u_sales2) and action (records)', async ({
  browser,
}) => {
  // Two changes by u_sales2 (session) on r2.
  const sales2 = await openAs(browser, SALES2_EMAIL);
  for (const amount of [210, 220]) {
    await ok(sales2.page, 'PATCH', `/tables/${fx.orders}/records?field_key_type=id`, {
      records: [{ id: fx.records.r2, fields: { [fx.fld.amount]: amount } }],
    });
  }
  await sales2.context.close();

  const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
  await page.goto(`/b/${fx.baseId}/settings/audit`);
  await expect(page.getByTestId('audit-row').first()).toBeVisible();
  await page.getByTestId('audit-filter-people').click();
  await page.getByRole('menuitemcheckbox', { name: new RegExp(SALES2_NAME, 'u') }).click();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(new RegExp(`actor=${fx.sales2}`, 'u'));
  await page.getByTestId('audit-filter-action').click();
  await page.getByRole('menuitemcheckbox', { name: 'Records' }).click();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/group=record\./u);
  const rows = page.getByTestId('audit-row');
  await expect(rows).toHaveCount(2);
  for (const row of await rows.all()) {
    await expect(row.getByTestId('audit-actor')).toHaveText(SALES2_NAME);
    await expect(row).toContainText('Records · updated');
  }
  await context.close();
});

test('an HTTP secret is never sent outside its hosts: the destination gets 0 connections', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const trap = await startDestination();
  const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
  try {
    // The trap passes the SSRF guard (allowlisted by name and port) — only the
    // secret's own hosts keep it out.
    const entry = await ok<{ id: string }>(page, 'POST', `/orgs/${fx.orgId}/http-allowlist`, {
      pattern: `localhost:${String(trap.port)}`,
    });
    cleanup.push((admin) => api(admin, 'DELETE', `/http-allowlist/${entry.id}`));
    const secret = await ok<{ id: string }>(page, 'POST', `/orgs/${fx.orgId}/secrets`, {
      kind: 'http_header',
      name: `CRM ${RUN}`,
      value: `Bearer t719-canary-${RUN}`,
      allowed_hosts: ['api.crm.example.com'],
    });
    cleanup.push((admin) => api(admin, 'DELETE', `/secrets/${secret.id}`));
    // A literal URL elsewhere is refused when saved …
    const refused = await api<{ errors: { code: string }[] }>(
      page,
      'POST',
      `/bases/${fx.baseId}/automations`,
      {
        name: `Literal ${RUN}`,
        enabled: false,
        definition: {
          trigger: { type: 'record.created', table_id: fx.orders },
          actions: [
            {
              id: 'act_http',
              type: 'http_request',
              config: {
                method: 'POST',
                url: { literal: `http://localhost:${String(trap.port)}/steal` },
                auth: { header_name: 'Authorization', secret_id: secret.id },
              },
            },
          ],
        },
      },
    );
    expect(refused.status).toBe(422);
    expect(refused.body.errors.map((error) => error.code)).toEqual(['SECRET_HOST_NOT_ALLOWED']);
    // … a URL from a field is refused when sent.
    const automation = await ok<{ id: string }>(page, 'POST', `/bases/${fx.baseId}/automations`, {
      name: `From field ${RUN}`,
      enabled: true,
      definition: {
        trigger: { type: 'record.created', table_id: fx.orders },
        actions: [
          {
            id: 'act_http',
            type: 'http_request',
            config: {
              method: 'POST',
              url: { field: fx.fld.title },
              auth: { header_name: 'Authorization', secret_id: secret.id },
            },
          },
        ],
      },
    });
    cleanup.push((admin) => api(admin, 'DELETE', `/automations/${automation.id}`));
    await ok(page, 'POST', `/tables/${fx.orders}/records?field_key_type=id`, {
      records: [{ fields: { [fx.fld.title]: `http://localhost:${String(trap.port)}/steal` } }],
    });
    const run = await eventually(async () => {
      const rows = await sql(
        `SELECT status, error FROM meta.automation_runs
          WHERE automation_id = $1 AND status IN ('succeeded', 'failed')`,
        [automation.id],
      );
      return rows[0];
    }, 'the run of the secret automation');
    expect(run['status']).toBe('failed');
    expect(run['error']).toMatchObject({
      code: 'secret_host_not_allowed',
      params: { reason: 'not_listed', secret_id: secret.id },
    });
    await ok(page, 'POST', `/automations/${automation.id}/disable`);
    expect(trap.connections).toBe(0);
    expect(trap.received).toEqual([]);
  } finally {
    await trap.close();
    await context.close();
  }
});

test('a delivery whose job was lost is rescued by the cron within 2 minutes', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const target = await startDestination();
  // The first call fails (503, no Retry-After): the delivery waits for its retry.
  let calls = 0;
  target.reply = (_req, res) => {
    calls += 1;
    res.writeHead(calls === 1 ? 503 : 200, { 'content-type': 'application/json' });
    res.end('{}');
  };
  const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
  try {
    const entry = await ok<{ id: string }>(page, 'POST', `/orgs/${fx.orgId}/http-allowlist`, {
      pattern: `localhost:${String(target.port)}`,
    });
    cleanup.push((admin) => api(admin, 'DELETE', `/http-allowlist/${entry.id}`));
    const automation = await ok<{ id: string }>(page, 'POST', `/bases/${fx.baseId}/automations`, {
      name: `Rescue ${RUN}`,
      enabled: true,
      definition: {
        trigger: { type: 'record.created', table_id: fx.orders },
        actions: [
          {
            id: 'act_http',
            type: 'http_request',
            config: {
              method: 'POST',
              url: { literal: `http://localhost:${String(target.port)}/rescue` },
            },
          },
        ],
      },
    });
    cleanup.push((admin) => api(admin, 'DELETE', `/automations/${automation.id}`));
    await ok(page, 'POST', `/tables/${fx.orders}/records?field_key_type=id`, {
      records: [{ fields: { [fx.fld.title]: `rescue-${RUN}` } }],
    });
    // After the first attempt: pending, its job scheduled for the retry.
    const delivery = await eventually(async () => {
      const rows = await sql(
        `SELECT id FROM meta.http_deliveries
          WHERE automation_id = $1 AND status = 'pending' AND attempts = 1`,
        [automation.id],
      );
      return rows[0]?.['id'] as string | undefined;
    }, 'the delivery waiting for its retry');
    // The job is lost; the row is a minute overdue (the clock of this test).
    const removed = await sql(`SELECT graphile_worker.remove_job($1) AS job`, [`http:${delivery}`]);
    expect(removed[0]?.['job']).not.toBeNull();
    await sql(
      `UPDATE meta.http_deliveries SET next_attempt_at = now() - interval '61 seconds'
        WHERE id = $1`,
      [delivery],
    );
    const lostAt = Date.now();
    expect(calls).toBe(1);
    const rescued = await eventually(
      () => Promise.resolve(target.received[1]),
      'the rescued delivery',
      150_000,
    );
    const seconds = (rescued.at - lostAt) / 1000;
    test.info().annotations.push({ type: 'rescued after', description: `${seconds.toFixed(1)} s` });
    process.stdout.write(`t719: lost delivery rescued after ${seconds.toFixed(1)} s\n`);
    expect(seconds).toBeLessThanOrEqual(120);
    // Same message (webhook-id) as the first attempt.
    expect(rescued.headers['webhook-id']).toBe(target.received[0]?.headers['webhook-id']);
    const row = await eventually(async () => {
      const rows = await sql(`SELECT status FROM meta.http_deliveries WHERE id = $1`, [delivery]);
      return rows[0]?.['status'] === 'succeeded' ? rows[0] : undefined;
    }, 'the delivery to succeed');
    expect(row['status']).toBe('succeeded');
    await ok(page, 'POST', `/automations/${automation.id}/disable`);
  } finally {
    await target.close();
    await context.close();
  }
});
