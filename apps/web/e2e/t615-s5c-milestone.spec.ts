import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  GenericContainer,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers';

import { E2E_API_PORT, E2E_WEB_PORT } from './ports';
import { DEMO_ADMIN_EMAIL, DEMO_PASSWORD } from './seed';
import { collectCspViolations, expectNoSeriousA11yViolations } from './support';
import { startFakeTelegramBot, type FakeTelegramBot } from './t555-telegram-bot';

import type { AddressInfo, Socket } from 'node:net';

/**
 * T615: the S5c milestone (SPEC §22, BACKLOG "Mốc S5c") end to end on the
 * `seed:demo` data, through the **nginx of the compose file** (the image's
 * templates `infra/docker/web/*.template`, the built SPA) in front of the
 * API, with the real UI of T611–T614:
 *
 * 1. the S5c samples of the seed: the "Đơn từ website" hook with its
 *    automation, the allowlist entry, the HTTP sample automation (off);
 * 2. A → `http_request` to the hook of B through nginx, called by an
 *    internal name (not `PUBLIC_URL`, like a compose service) → B creates the
 *    order that would run A again: stopped by the loop guard (the causation
 *    token crossed nginx: B's order carries depth 2 and the chain [A, B], a
 *    webhook hop costs one level like a record write — ADR-27 amendment
 *    2026-10-25); hook B made in the webhooks page (T611), B built
 *    with "Listen for a sample" (T612, sample within 3 minutes), A with the
 *    HTTP request editor and a header secret from the integrations page
 *    (T613), A's run and its delivery in the run history (T614);
 * 3. the n8n loop: a `run_n8n_workflow` step of u_sales1 (Sales managing
 *    Orders) → a fake n8n that checks the Standard Webhooks signature, finds
 *    no field u_sales1 cannot read (`cost`) and forwards
 *    `X-Cellhive-Causation` to hook B' → B' creates the order that would run
 *    the n8n step again: stopped by the loop guard;
 * 4. a hook over its rate limit → `429` + `Retry-After` through nginx;
 * 5. `http_request` to internal addresses outside the allowlist: blocked
 *    (the trap on loopback gets 0 connections), the cloud metadata address
 *    blocked even when its name is allowlisted, explained in the run history;
 * 6. the worker killed between the two phases of the outbox → after the
 *    lease the destination gets the call again with the same `webhook-id`
 *    and processes it once; no worker connection is held while a call waits;
 * 7. Telegram in webhook mode (switched in the bot settings, T614): `/start`
 *    links at once; 200 hook requests assigning u_sales1 → the bell rings
 *    once, one Telegram message; `/stop` unlinks at once.
 *
 * Its own stack: PostgreSQL 18 + Valkey 8 (Testcontainers), migrations and
 * `seed:demo`, the API in this process (fake Bot API), the worker in a
 * process of its own (`e2e/t615-worker.ts`, killed with `SIGKILL` in 6; its
 * test-only DNS sends the internal names to loopback or to the probe
 * addresses) and nginx (`nginx:1.29-alpine`, Testcontainers, published on
 * its own port — never 3000/5173) proxying `/api` and `/ws` to the API
 * through `host.docker.internal`. The webhook mode of Telegram needs an
 * `https` `PUBLIC_URL`: the API gets `https://cellhive-t615.e2e.test` (like
 * T614), the browser talks to nginx over http (`CORS_ORIGINS`), hook URLs
 * are called on nginx.
 */

const WEB_PORT = Number(process.env['E2E_T615_WEB_PORT'] ?? E2E_WEB_PORT + 615);
const API_PORT = Number(process.env['E2E_T615_API_PORT'] ?? E2E_API_PORT + 615);
const WEB_URL = `http://127.0.0.1:${String(WEB_PORT)}`;
const PUBLIC_URL = 'https://cellhive-t615.e2e.test';
const WEB_DIR = fileURLToPath(new URL('..', import.meta.url));
const INFRA_DIR = fileURLToPath(new URL('../../../infra/docker/web/', import.meta.url));
const API_DIST = fileURLToPath(new URL('../../api/dist/', import.meta.url));
const WORKER_SCRIPT = fileURLToPath(new URL('./t615-worker.ts', import.meta.url));
const SALES1_EMAIL = 'sales1@demo.cellhive.local';
const EDITOR_EMAIL = 'editor@demo.cellhive.local';
/** The fake token of the seeded bot "Bot CSKH (demo)" (CONTRACTS §9). */
const SEED_BOT_TOKEN = '123456789:DEMO-not-a-real-bot-token-000000000';
const SEED_BOT = 'Bot CSKH (demo)';
const BOT_USERNAME = 'cskh_t615_bot';
const SALES1_CHAT = 615_001;
const ORDER_TITLE = 'Tên đơn hàng';
/** Internal names (the worker's test-only DNS): nginx, the fake n8n, the slow destination. */
const WEB_HOST = 'web.t615.internal';
const N8N_HOST = 'n8n.t615.internal';
const SLOW_HOST = 'slow.t615.internal';
const TRAP_HOST = 'trap.t615.internal';
const METADATA_HOST = 'metadata.t615.internal';
const HOOKS = 200;

interface Pg {
  Client: new (options: { connectionString: string }) => {
    connect: () => Promise<void>;
    query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
    end: () => Promise<void>;
  };
}

interface CoreBuild {
  loadConfig: (env: NodeJS.ProcessEnv) => unknown;
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
let network: StartedNetwork;
let nginx: StartedTestContainer;
let env: NodeJS.ProcessEnv;
let telegram: FakeTelegramBot;
let worker: ChildProcess | null = null;
/** JSON log lines of the worker processes (`event dispatched` carries loop outcomes). */
const workerLines: Record<string, unknown>[] = [];
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

// --- Fake destinations -------------------------------------------------------------------

interface Received {
  readonly path: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: string;
}

interface Destination {
  readonly port: number;
  readonly received: Received[];
  connections: number;
  /** Handles one request; default: `200 {"ok":true}`. */
  handler: ((request: Received, res: ServerResponse) => void) | null;
  close(): Promise<void>;
}

async function startDestination(): Promise<Destination> {
  const sockets = new Set<Socket>();
  const destination: Destination = {
    port: 0,
    received: [],
    connections: 0,
    handler: null,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, 'close');
    },
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const received = {
        path: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      destination.received.push(received);
      if (destination.handler !== null) {
        destination.handler(received, res);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  server.on('connection', (socket) => {
    destination.connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  (destination as { port: number }).port = (server.address() as AddressInfo).port;
  return destination;
}

/** Standard Webhooks v1 (ADR-22): `v1,<base64 HMAC-SHA256(id.timestamp.body)>` with the `whsec_` key. */
function verifyStandardWebhook(secret: string, request: Received): boolean {
  const id = String(request.headers['webhook-id'] ?? '');
  const timestamp = String(request.headers['webhook-timestamp'] ?? '');
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${request.body}`).digest();
  return String(request.headers['webhook-signature'] ?? '')
    .split(' ')
    .some((entry) => {
      const [version, value] = entry.split(',');
      const given = Buffer.from(value ?? '', 'base64');
      return (
        version === 'v1' && given.length === expected.length && timingSafeEqual(given, expected)
      );
    });
}

let n8n: Destination;
let slow: Destination;
let trap: Destination;

// --- The stack ---------------------------------------------------------------------------

function logger(service: string): unknown {
  const { pino } = requireFromApi('pino') as {
    pino: (options: { level: string; base: Record<string, string> }) => unknown;
  };
  return pino({ level: 'error', base: { service } });
}

/** The API of this stack, in this process, on the fake Bot API (test-only option). */
async function startApi(): Promise<void> {
  const core = (await import(
    new URL('../../../packages/server-core/dist/index.js', import.meta.url).href
  )) as CoreBuild;
  const build = (await import(
    new URL('../../api/dist/app.factory.js', import.meta.url).href
  )) as ApiBuild;
  const config = core.loadConfig({ ...env, MODE: 'api', PORT: String(API_PORT) });
  const app = await build.createApp(config, {
    logger: logger('e2e-t615-api'),
    telegramClient: { baseUrl: telegram.baseUrl },
  });
  // nginx reaches it through `host.docker.internal`: loopback on Docker Desktop, the
  // bridge gateway on Linux.
  await app.listen({
    port: API_PORT,
    host: process.platform === 'linux' ? '0.0.0.0' : '127.0.0.1',
  });
  closers.push(() => app.close());
}

/** Starts the worker process and waits for `ready`. */
async function startWorker(): Promise<void> {
  const child = spawn(process.execPath, [WORKER_SCRIPT], {
    env: {
      ...env,
      T615_WORKER: JSON.stringify({
        telegramBaseUrl: telegram.baseUrl,
        hosts: {
          [WEB_HOST]: ['127.0.0.1'],
          [N8N_HOST]: ['127.0.0.1'],
          [SLOW_HOST]: ['127.0.0.1'],
          [TRAP_HOST]: ['127.0.0.1'],
          [METADATA_HOST]: ['169.254.169.254'],
        },
      }),
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  worker = child;
  let buffered = '';
  const ready = new Promise<void>((resolve, reject) => {
    child.once('exit', (code) => {
      reject(new Error(`worker exited with ${String(code)}`));
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        if (line === 'ready') resolve();
        else if (line.startsWith('{')) {
          try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            if (parsed['msg'] === 'event dispatched' || Number(parsed['level']) >= 50) {
              workerLines.push(parsed);
            }
          } catch {
            // not a log line
          }
        }
      }
    });
  });
  await ready;
}

async function stopWorker(signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
  const child = worker;
  worker = null;
  if (child === null || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill(signal);
  await exited;
}

async function startNginx(): Promise<void> {
  network = await new Network().start();
  closers.push(() => network.stop());
  // The address of `host.docker.internal` (from /etc/hosts: nginx's resolver does not
  // read it), then the image's own entrypoint renders the templates.
  const entry =
    "API_UPSTREAM=\"$(getent ahostsv4 host.docker.internal | awk 'NR==1{print $1}'):" +
    `${String(API_PORT)}"; export API_UPSTREAM; exec /docker-entrypoint.sh nginx -g 'daemon off;'`;
  nginx = await new GenericContainer('nginx:1.29-alpine')
    .withNetwork(network)
    .withExtraHosts([{ host: 'host.docker.internal', ipAddress: 'host-gateway' }])
    .withExposedPorts({ container: 80, host: WEB_PORT })
    .withEnvironment({ NGINX_RESOLVER: '127.0.0.11', STORAGE_PUBLIC_ORIGIN: '' })
    .withCopyFilesToContainer([
      {
        source: join(INFRA_DIR, 'default.conf.template'),
        target: '/etc/nginx/templates/default.conf.template',
      },
      {
        source: join(INFRA_DIR, 'security-headers.conf.template'),
        target: '/etc/nginx/templates/snippets/security-headers.conf.template',
      },
      {
        source: join(INFRA_DIR, 'share-page-headers.conf.template'),
        target: '/etc/nginx/templates/snippets/share-page-headers.conf.template',
      },
      {
        source: join(INFRA_DIR, 'share-embed-headers.conf.template'),
        target: '/etc/nginx/templates/snippets/share-embed-headers.conf.template',
      },
    ])
    .withCopyDirectoriesToContainer([
      { source: join(WEB_DIR, 'dist'), target: '/usr/share/nginx/html' },
    ])
    .withEntrypoint(['/bin/sh', '-c'])
    .withCommand([entry])
    .withWaitStrategy(Wait.forHttp('/', 80))
    .start();
  closers.push(() => nginx.stop());
}

// --- Browser and API helpers -------------------------------------------------------------

interface Opened {
  readonly context: BrowserContext;
  readonly page: Page;
  /** `notification.created` frames of the page's WebSocket. */
  readonly created: { at: number; type: string }[];
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

async function openAs(browser: Browser, email: string): Promise<Opened> {
  const known = sessions.get(email);
  const context = await browser.newContext({
    baseURL: WEB_URL,
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'UTC',
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

/** A hook URL of `PUBLIC_URL` on nginx (what an outside caller would reach). */
const onNginx = (url: string) => url.replace(PUBLIC_URL, WEB_URL);
/** The same hook by the internal name the worker resolves to nginx. */
const internal = (url: string) => url.replace(PUBLIC_URL, `http://${WEB_HOST}:${String(WEB_PORT)}`);

/** A request to a hook from outside, like `curl`, through nginx. */
async function sendToHook(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; retryAfter: string | null; body: string }> {
  const response = await fetch(onNginx(url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    retryAfter: response.headers.get('retry-after'),
    body: await response.text(),
  };
}

const ids = {
  orgId: '',
  orgSlug: '',
  baseId: '',
  orders: '',
  customers: '',
  users: {} as Record<'admin' | 'editor' | 'sales1' | 'sales2', string>,
  fields: {} as Record<'title' | 'owner' | 'cost' | 'customerName', string>,
  botSecret: '',
  salesRole: '',
};

const webhooksPath = () => `/b/${encodeURIComponent(ids.baseId)}/settings/webhooks`;
const integrationsPath = () => `/o/${encodeURIComponent(ids.orgSlug)}/settings/integrations`;
const runsPath = (query = '') => `/b/${ids.baseId}/automations/runs${query}`;
const botsPath = () => `/o/${encodeURIComponent(ids.orgSlug)}/settings/telegram`;
const settingsPath = () => `/o/${encodeURIComponent(ids.orgSlug)}/settings/notifications`;

/** Every event dispatched; no run queued/running, no delivery pending/sending, no dispatch job. */
async function settled(): Promise<void> {
  await expect
    .poll(
      async () => {
        const [row] = await sql(
          `SELECT (SELECT count(*)::int FROM meta.events WHERE dispatched_at IS NULL)
                + (SELECT count(*)::int FROM meta.automation_runs
                    WHERE status IN ('queued', 'running'))
                + (SELECT count(*)::int FROM meta.http_deliveries
                    WHERE status IN ('pending', 'sending'))
                + (SELECT count(*)::int FROM graphile_worker._private_jobs p
                     JOIN graphile_worker._private_tasks k ON k.id = p.task_id
                    WHERE k.identifier IN ('events.dispatch', 'automation.run',
                                           'notifications.fanout', 'notifications.deliver'))
                   AS n`,
        );
        return Number(row?.['n']);
      },
      { timeout: 120_000, intervals: [200] },
    )
    .toBe(0);
}

async function runsOf(automationId: string): Promise<{ id: string; status: string }[]> {
  return (await sql(
    'SELECT id, status FROM meta.automation_runs WHERE automation_id = $1 ORDER BY created_at, id',
    [automationId],
  )) as { id: string; status: string }[];
}

/** Loop-guard outcomes the worker logged for `automationId`. */
function loopOutcomes(automationId: string): string[] {
  return workerLines
    .flatMap((line) =>
      Array.isArray(line['automations'])
        ? (line['automations'] as { automation_id: string; outcome: string }[])
        : [],
    )
    .filter((item) => item.automation_id === automationId && item.outcome.startsWith('loop_'))
    .map((item) => item.outcome);
}

/** Depth and chain of the `record.created` events written by `automationId`. */
async function chainOf(automationId: string): Promise<{ depth: number; chain: string[] }[]> {
  return (await sql(
    `SELECT (causation->>'depth')::int AS depth,
            ARRAY(SELECT jsonb_array_elements_text(causation->'automation_chain')) AS chain
       FROM meta.events
      WHERE type = 'record.created' AND actor_type = 'automation' AND actor_id = $1`,
    [automationId],
  )) as { depth: number; chain: string[] }[];
}

/** Picks `label` from the "+" menu of the value control named `control`. */
async function pickValue(page: Page, control: RegExp, label: RegExp): Promise<void> {
  const panel = page.getByTestId('config-panel');
  await panel.getByRole('button', { name: control }).click();
  const picker = panel.getByTestId('value-picker');
  await expect(picker.getByRole('group', { name: 'Webhook data' })).toBeVisible();
  await picker.getByRole('option', { name: label }).click();
}

/** Makes a hook in the webhooks page (T611); returns its id, URL and credential shown once. */
async function createHookInUi(
  page: Page,
  name: string,
  options: { auth: 'bearer' | 'none'; rate?: number },
): Promise<{ id: string; url: string; token: string }> {
  await page.goto(webhooksPath());
  await page.getByTestId('hook-add').click();
  const dialog = page.getByRole('dialog', { name: 'New incoming webhook' });
  await dialog.getByTestId(`hook-auth-${options.auth}`).check();
  if (options.auth === 'none') await dialog.getByTestId('hook-none-ack').check();
  await dialog.getByTestId('hook-name').fill(name);
  if (options.rate !== undefined) await dialog.getByTestId('hook-rate').fill(String(options.rate));
  await dialog.getByTestId('hook-create-submit').click();
  const reveal = page.getByTestId('secret-reveal');
  const url = await reveal.getByTestId('reveal-url').inputValue();
  const token =
    options.auth === 'bearer' ? await reveal.getByTestId('reveal-bearer_token').inputValue() : '';
  // "I stored it" only when a credential is shown once.
  if (options.auth !== 'none') await reveal.getByTestId('secret-reveal-confirm').check();
  await reveal.getByTestId('secret-reveal-done').click();
  await expect(reveal).toHaveCount(0);
  const [hook] = await sql('SELECT id FROM meta.incoming_webhooks WHERE name = $1', [name]);
  expect(url.startsWith(`${PUBLIC_URL}/api/v1/hooks/`)).toBe(true);
  return { id: String(hook?.['id']), url, token };
}

/** Adds an allowlist entry in the integrations page (T613). */
async function allowInUi(page: Page, pattern: string): Promise<void> {
  await page.goto(integrationsPath());
  const allowlist = page.getByTestId('allowlist-section');
  await allowlist.getByTestId('allowlist-pattern').fill(pattern);
  await allowlist.getByTestId('allowlist-pattern').press('Enter');
  await expect(allowlist.getByTestId('allowlist-row').filter({ hasText: pattern })).toBeVisible();
}

/** What Telegram posts to the registered webhook, through nginx (`/api/v1/telegram/webhook/…`). */
async function telegramUpdate(text: string): Promise<{ status: number }> {
  const registered = new URL(telegram.webhookUrl());
  const setWebhook = telegram.calls.filter((item) => item.method === 'setWebhook').at(-1);
  const secret = setWebhook?.body['secret_token'];
  const response = await fetch(`${WEB_URL}${registered.pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': typeof secret === 'string' ? secret : '',
    },
    body: JSON.stringify({
      update_id: Math.floor(Math.random() * 1e9),
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: SALES1_CHAT, type: 'private' },
        from: { id: SALES1_CHAT, is_bot: false, first_name: 'Sales', language_code: 'vi' },
        text,
      },
    }),
  });
  await response.text();
  return { status: response.status };
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(600_000);
  telegram = await startFakeTelegramBot();
  telegram.setUsername(SEED_BOT_TOKEN, BOT_USERNAME);
  closers.push(() => telegram.close());
  [n8n, slow, trap] = await Promise.all([
    startDestination(),
    startDestination(),
    startDestination(),
  ]);
  closers.push(
    () => n8n.close(),
    () => slow.close(),
    () => trap.close(),
  );
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
  const storage = await mkdtemp(join(tmpdir(), 'cellhive-e2e-t615-'));
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
  // The demo data, as a developer seeds it (the seed sends nothing anywhere).
  await run('seed.js', { NODE_ENV: 'development' });
  await startApi();
  await startWorker();
  closers.push(() => stopWorker('SIGTERM'));
  await startNginx();

  const [org] = await sql('SELECT id, slug FROM meta.organizations ORDER BY created_at LIMIT 1');
  ids.orgId = String(org?.['id']);
  ids.orgSlug = String(org?.['slug']);
  for (const [key, email] of [
    ['admin', DEMO_ADMIN_EMAIL],
    ['editor', EDITOR_EMAIL],
    ['sales1', SALES1_EMAIL],
    ['sales2', 'sales2@demo.cellhive.local'],
  ] as const) {
    const [user] = await sql('SELECT id FROM meta.users WHERE email = $1', [email]);
    ids.users[key] = String(user?.['id']);
  }
  const tables = await sql(
    `SELECT id, name, base_id FROM meta.tables
      WHERE organization_id = $1 AND name IN ('Orders', 'Customers') AND deleted_at IS NULL`,
    [ids.orgId],
  );
  ids.orders = String(tables.find((row) => row['name'] === 'Orders')?.['id']);
  ids.customers = String(tables.find((row) => row['name'] === 'Customers')?.['id']);
  ids.baseId = String(tables[0]?.['base_id']);
  const fields = await sql(
    'SELECT id, name, table_id FROM meta.fields WHERE table_id = ANY($1::text[]) AND deleted_at IS NULL',
    [[ids.orders, ids.customers]],
  );
  const fieldOf = (tableId: string, name: string) =>
    String(fields.find((row) => row['table_id'] === tableId && row['name'] === name)?.['id']);
  ids.fields = {
    title: fieldOf(ids.orders, ORDER_TITLE),
    owner: fieldOf(ids.orders, 'owner'),
    cost: fieldOf(ids.orders, 'cost'),
    customerName: fieldOf(ids.customers, 'Tên'),
  };
  const [secret] = await sql('SELECT id FROM meta.secrets WHERE name = $1', [SEED_BOT]);
  ids.botSecret = String(secret?.['id']);
  const [role] = await sql("SELECT id FROM meta.base_roles WHERE base_id = $1 AND name = 'Sales'", [
    ids.baseId,
  ]);
  ids.salesRole = String(role?.['id']);

  // The admin makes the seeded bot the organization's notification bot.
  const admin = await openAs(browser, DEMO_ADMIN_EMAIL);
  await ok(admin.page, 'PATCH', `/orgs/${ids.orgId}/notification-channels`, {
    telegram_secret_id: ids.botSecret,
  });
  await admin.context.close();
});

test.afterAll(async () => {
  for (const close of closers.reverse()) await close();
});

/** State shared by the serial tests. */
const hookB = { id: '', url: '', token: '', automation: '' };
let automationA = '';

test('the seeded S5c samples: the website hook, its automation, the allowlist entry', async ({
  browser,
}) => {
  const { context, page } = await openAs(browser, DEMO_ADMIN_EMAIL);
  const csp = collectCspViolations(page);
  // Through nginx: the security headers of the compose image.
  const response = await page.goto(webhooksPath());
  expect(response?.headers()['content-security-policy']).toContain("default-src 'self'");
  const row = page.getByTestId('hook-row').filter({ hasText: 'Đơn từ website' });
  await expect(row.getByTestId('hook-auth')).toHaveText('Bearer token');
  await expect(row.getByTestId('hook-status')).toHaveText('Receiving');
  await row.getByTestId('hook-open').click();
  await expect(page.getByTestId('hook-url')).toHaveValue(
    new RegExp(`^${PUBLIC_URL}/api/v1/hooks/[A-Za-z0-9_-]{43}$`, 'u'),
  );
  await expect(page.getByTestId('hook-usages')).toContainText('Đơn từ website: tạo đơn hàng');
  await expectNoSeriousA11yViolations(page, 'seeded webhook');

  await page.goto(integrationsPath());
  await expect(
    page.getByTestId('allowlist-section').getByTestId('allowlist-row').filter({
      hasText: 'n8n.local:5678',
    }),
  ).toContainText('Port 5678');

  await page.goto(`/b/${encodeURIComponent(ids.baseId)}/automations`);
  for (const name of ['Đơn từ website: tạo đơn hàng', 'Gửi đơn mới ra hệ thống ngoài (mẫu)']) {
    await expect(page.getByText(name, { exact: true })).toBeVisible();
  }
  // Nothing was ever sent: no delivery, no request.
  const [quiet] = await sql(
    `SELECT (SELECT count(*)::int FROM meta.http_deliveries) AS deliveries,
            (SELECT count(*)::int FROM meta.incoming_webhook_requests) AS requests`,
  );
  expect(quiet).toEqual({ deliveries: 0, requests: 0 });
  expect(csp).toEqual([]);
  await context.close();
});

test('A → http_request to the hook of B through nginx → B creates the order that would run A: stopped by the loop guard', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const { context, page } = await openAs(browser, DEMO_ADMIN_EMAIL);
  const csp = collectCspViolations(page);

  // Hook B (T611) and its Bearer as a header secret for A (T613); nginx by its internal name.
  Object.assign(hookB, await createHookInUi(page, 'Hook B (T615)', { auth: 'bearer' }));
  await allowInUi(page, `${WEB_HOST}:${String(WEB_PORT)}`);
  const secrets = page.getByTestId('http-secrets-section');
  await secrets.getByTestId('secret-add').click();
  const dialog = page.getByRole('dialog', { name: 'Add an HTTP secret' });
  await dialog.getByTestId('secret-name').fill('Hook B bearer');
  await dialog.getByTestId('secret-value').fill(`Bearer ${hookB.token}`);
  // T701: the secret goes to nginx (hook B) only.
  await dialog.getByTestId('secret-allowed-hosts').fill(`${WEB_HOST}:${String(WEB_PORT)}`);
  await dialog.getByTestId('secret-save').click();
  await expect(page.getByText('Secret Hook B bearer added.')).toBeVisible();

  // B (T612): "when a webhook request is received" on hook B, a sample within 3 minutes,
  // then create an order titled from `body.title`.
  await page.goto(`/b/${encodeURIComponent(ids.baseId)}/automations`);
  await page.getByTestId('create-automation').click();
  const create = page.getByTestId('create-automation-dialog');
  await create.getByTestId('create-automation-name').fill('B: đơn từ hook B');
  await create.getByText('When a webhook request is received').click();
  await create.getByTestId('create-automation-submit').click();
  const trigger = page.getByTestId('webhook-trigger');
  await trigger.getByTestId('webhook-trigger-hook').selectOption(hookB.id);
  await expect(trigger.getByTestId('webhook-trigger-url')).toHaveValue(hookB.url);
  await trigger.getByTestId('webhook-listen-start').click();
  await expect(trigger.getByTestId('webhook-listen-countdown')).toContainText(/[23]:\d\d left/u);
  const sample = await sendToHook(
    hookB.url,
    { title: 'Mẫu từ A' },
    { authorization: `Bearer ${hookB.token}` },
  );
  expect(sample.status).toBe(202);
  await expect(trigger.getByRole('tree', { name: 'Sample request data' })).toBeVisible();
  await page.getByTestId('add-step').click();
  await page.getByTestId('add-create_record').click();
  const panel = page.getByTestId('config-panel');
  await panel.getByTestId('action-table').selectOption({ label: 'Orders' });
  await panel.getByTestId('field-map-add').selectOption({ label: ORDER_TITLE });
  await pickValue(page, new RegExp(`Insert a value into .*${ORDER_TITLE}`, 'u'), /^body\.title/u);
  await page.getByTestId('builder-save').click();
  await expect(page).toHaveURL(/\/automations\/aut_/u);
  hookB.automation = /\/automations\/(aut_[^/?]+)/u.exec(page.url())?.[1] ?? '';
  await page.getByTestId('builder-enabled').click();
  await expect(page.getByTestId('builder-enabled')).toBeChecked();

  // A (T613): a new order → POST to hook B by the internal name, with the Bearer secret.
  const shell = await ok<{ id: string }>(page, 'POST', `/bases/${ids.baseId}/automations`, {
    name: 'A: gửi đơn sang hook B',
    definition: { trigger: { type: 'record.created', table_id: ids.orders }, actions: [] },
  });
  automationA = shell.id;
  await page.goto(`/b/${ids.baseId}/automations/${automationA}`);
  await page.getByTestId('add-step').click();
  await page.getByTestId('add-http_request').click();
  const editor = panel.getByTestId('http-request-editor');
  await editor.getByRole('textbox', { name: 'URL' }).click();
  await page.keyboard.type(internal(hookB.url));
  await editor.getByText('Header with a secret', { exact: true }).click();
  await editor.getByTestId('http-auth-secret').selectOption({ label: 'Hook B bearer' });
  await editor.getByText('JSON', { exact: true }).click();
  await editor.getByRole('textbox', { name: 'JSON body' }).click();
  await page.keyboard.type('{"title": "Từ A"}');
  await expect(editor.getByTestId('http-json-problem')).toHaveCount(0);
  await page.keyboard.press('Control+s');
  await expect(page.getByText('Saved “A: gửi đơn sang hook B”.')).toBeVisible();
  await page.getByTestId('builder-enabled').click();
  await expect(page.getByTestId('builder-enabled')).toBeChecked();
  await settled();

  // A person's new order starts the loop.
  await ok(page, 'POST', `/tables/${ids.orders}/records?field_key_type=id`, {
    records: [{ fields: { [ids.fields.title]: 'Đơn khởi đầu T615' } }],
  });
  await expect
    .poll(async () => (await runsOf(hookB.automation)).map((item) => item.status), {
      timeout: 60_000,
    })
    .toEqual(['succeeded']);
  await settled();
  // A once (the person's order), B once (A's call); B's order did not run A again.
  const runsA = await runsOf(automationA);
  expect(runsA.map((item) => item.status)).toEqual(['succeeded']);
  expect((await runsOf(hookB.automation)).map((item) => item.status)).toEqual(['succeeded']);
  const chain = await chainOf(hookB.automation);
  expect(chain).toHaveLength(1);
  // Person (0) → A → hook (1) → B → order (2): one level per hop (ADR-27 amendment
  // 2026-10-25); A is already in the chain the token carried across nginx.
  expect(chain[0]?.depth).toBe(2);
  expect(chain[0]?.chain).toEqual([automationA, hookB.automation]);
  expect(loopOutcomes(automationA)).toEqual(['loop_already_in_chain']);
  // The token crossed nginx: the hook took it (the sample request carried none).
  const requests = await sql(
    `SELECT causation_accepted FROM meta.incoming_webhook_requests
      WHERE incoming_webhook_id = $1 ORDER BY received_at`,
    [hookB.id],
  );
  expect(requests).toEqual([{ causation_accepted: false }, { causation_accepted: true }]);

  // The log of hook B shows the chained request (T611); A's run its delivery (T614).
  await page.goto(`${webhooksPath()}?hook=${hookB.id}&tab=requests`);
  const log = page.getByTestId('hook-log');
  await expect(log.getByTestId('hook-log-row')).toHaveCount(2);
  await expect(log.getByTestId('hook-log-causation')).toHaveCount(1);
  await page.goto(runsPath(`?range=24h&run=${runsA[0]?.id ?? ''}`));
  const step = page.getByTestId('run-detail').getByTestId('http-step-act_1');
  await expect(step.getByTestId('http-host')).toHaveText(WEB_HOST);
  await expect(step.getByTestId('http-phase')).toHaveText('Delivered');
  await expect(page.getByTestId('run-detail')).not.toContainText(hookB.token);
  await expectNoSeriousA11yViolations(page, 'run of A');
  await ok(page, 'POST', `/automations/${automationA}/disable`);
  expect(csp).toEqual([]);
  await context.close();
});

test('n8n: a signed payload without the fields u_sales1 cannot read; the forwarded causation stops the loop', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const admin = await openAs(browser, DEMO_ADMIN_EMAIL);
  // n8n by its internal name, a generated signing secret shown once (T613).
  await allowInUi(admin.page, `${N8N_HOST}:${String(n8n.port)}`);
  const secrets = admin.page.getByTestId('http-secrets-section');
  await secrets.getByTestId('secret-add').click();
  const dialog = admin.page.getByRole('dialog', { name: 'Add an HTTP secret' });
  await dialog.getByTestId('secret-kind-webhook_signing').check();
  await dialog.getByTestId('secret-name').fill('n8n T615');
  // T701: the signing secret goes to n8n only.
  await dialog.getByTestId('secret-allowed-hosts').fill(`${N8N_HOST}:${String(n8n.port)}`);
  await dialog.getByTestId('secret-save').click();
  const reveal = admin.page.getByTestId('secret-reveal');
  const signing = await reveal.getByTestId('secret-reveal-value').inputValue();
  expect(signing).toMatch(/^whsec_/u);
  await reveal.getByTestId('secret-reveal-confirm').check();
  await reveal.getByTestId('secret-reveal-done').click();

  // Hook B' creates an order of u_sales1 (so their n8n step reads it) from the forwarded call.
  const hook = await ok<{ id: string; url: string; bearer_token: string }>(
    admin.page,
    'POST',
    `/bases/${ids.baseId}/incoming-webhooks`,
    { name: "Hook B' (n8n)", auth: 'bearer', rate_limit_per_sec: 10 },
  );
  const automationB = await ok<{ id: string }>(
    admin.page,
    'POST',
    `/bases/${ids.baseId}/automations`,
    {
      name: "B': đơn từ n8n",
      enabled: true,
      definition: {
        trigger: { type: 'webhook.received', incoming_webhook_id: hook.id },
        actions: [
          {
            id: 'act_create',
            type: 'create_record',
            config: {
              table_id: ids.orders,
              fields: {
                [ids.fields.title]: { template: 'Từ n8n: {{ [@body.title] }}' },
                [ids.fields.owner]: { literal: [{ id: ids.users.sales1 }] },
                [ids.fields.cost]: { literal: 615_615 },
              },
            },
          },
        ],
      },
    },
  );
  // The fake n8n: checks the signature, answers, then calls B' forwarding the causation header.
  const forwarded: { status: number; header: string }[] = [];
  const verified: boolean[] = [];
  n8n.handler = (request, res) => {
    verified.push(verifyStandardWebhook(signing, request));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"accepted":true}');
    const header = String(request.headers['x-cellhive-causation'] ?? '');
    const title = (JSON.parse(request.body) as { record: { fields: Record<string, unknown> } })
      .record.fields[ORDER_TITLE];
    void sendToHook(
      hook.url,
      { title },
      { authorization: `Bearer ${hook.bearer_token}`, 'x-cellhive-causation': header },
    ).then((answer) => forwarded.push({ status: answer.status, header }));
  };

  // Sales manages Orders (P29/P32 variant): u_sales1 builds the n8n step in the editor (T613).
  const role = await ok<{ config: { tables: Record<string, Record<string, unknown>> } }>(
    admin.page,
    'GET',
    `/bases/${ids.baseId}/roles/${ids.salesRole}`,
  );
  const tables = role.config.tables;
  await ok(admin.page, 'PATCH', `/bases/${ids.baseId}/roles/${ids.salesRole}`, {
    config: {
      ...role.config,
      tables: { ...tables, [ids.orders]: { ...tables[ids.orders], perm: 'manage' } },
    },
  });
  const sales1 = await openAs(browser, SALES1_EMAIL);
  const shell = await ok<{ id: string }>(sales1.page, 'POST', `/bases/${ids.baseId}/automations`, {
    name: 'n8n của u_sales1',
    definition: { trigger: { type: 'record.created', table_id: ids.orders }, actions: [] },
  });
  await sales1.page.goto(`/b/${ids.baseId}/automations/${shell.id}`);
  await sales1.page.getByTestId('add-step').click();
  await sales1.page.getByTestId('add-run_n8n_workflow').click();
  const editor = sales1.page.getByTestId('config-panel').getByTestId('n8n-editor');
  await editor.getByRole('textbox', { name: 'Webhook URL' }).click();
  await sales1.page.keyboard.type(`http://${N8N_HOST}:${String(n8n.port)}/webhook/cellhive`);
  await editor.getByTestId('n8n-secret').selectOption({ label: 'n8n T615' });
  await expect(editor.getByTestId('n8n-preview')).toContainText('"record.created"');
  await expect(editor.getByTestId('n8n-preview')).not.toContainText('"cost"');
  await sales1.page.keyboard.press('Control+s');
  await expect(sales1.page.getByText('Saved “n8n của u_sales1”.')).toBeVisible();
  await sales1.page.getByTestId('builder-enabled').click();
  await expect(sales1.page.getByTestId('builder-enabled')).toBeChecked();
  await settled();

  // u_sales1's own new order (cost set by the admin) starts it.
  await ok(admin.page, 'POST', `/tables/${ids.orders}/records?field_key_type=id`, {
    records: [
      {
        fields: {
          [ids.fields.title]: 'Đơn n8n T615',
          [ids.fields.owner]: [{ id: ids.users.sales1 }],
          [ids.fields.cost]: 777_615,
        },
      },
    ],
  });
  await expect.poll(() => forwarded.length, { timeout: 60_000 }).toBe(1);
  await expect
    .poll(async () => (await runsOf(automationB.id)).map((item) => item.status), {
      timeout: 60_000,
    })
    .toEqual(['succeeded']);
  await settled();
  // n8n got one call, signed; nothing u_sales1 cannot read.
  expect(n8n.received).toHaveLength(1);
  expect(verified).toEqual([true]);
  const payload = JSON.parse(n8n.received[0]?.body ?? '{}') as {
    automation: { id: string };
    record: { fields: Record<string, unknown>; fields_by_id: Record<string, unknown> };
  };
  expect(payload.automation.id).toBe(shell.id);
  expect(payload.record.fields[ORDER_TITLE]).toBe('Đơn n8n T615');
  expect(Object.keys(payload.record.fields)).not.toContain('cost');
  expect(Object.keys(payload.record.fields_by_id)).not.toContain(ids.fields.cost);
  expect(n8n.received[0]?.body).not.toContain('777615');
  // The forwarded token was taken; B' wrote at depth 2 with the n8n step's automation in the
  // chain, so the n8n step stopped there (one level per hop, ADR-27 amendment 2026-10-25).
  expect(forwarded[0]?.status).toBe(202);
  expect(forwarded[0]?.header).not.toBe('');
  const [request] = await sql(
    'SELECT causation_accepted FROM meta.incoming_webhook_requests WHERE incoming_webhook_id = $1',
    [hook.id],
  );
  expect(request).toEqual({ causation_accepted: true });
  expect((await runsOf(shell.id)).map((item) => item.status)).toEqual(['succeeded']);
  const chain = await chainOf(automationB.id);
  expect(chain[0]?.depth).toBe(2);
  expect(chain[0]?.chain).toEqual([shell.id, automationB.id]);
  expect(loopOutcomes(shell.id)).toEqual(['loop_already_in_chain']);

  n8n.handler = null;
  await ok(sales1.page, 'POST', `/automations/${shell.id}/disable`);
  await ok(admin.page, 'POST', `/automations/${automationB.id}/disable`);
  await ok(admin.page, 'PATCH', `/bases/${ids.baseId}/roles/${ids.salesRole}`, {
    config: role.config,
  });
  await sales1.context.close();
  await admin.context.close();
});

test('a hook over its rate limit answers 429 with Retry-After through nginx', async ({
  browser,
}) => {
  const { context, page } = await openAs(browser, DEMO_ADMIN_EMAIL);
  const hook = await createHookInUi(page, 'Giới hạn 1/s', { auth: 'none', rate: 1 });
  const answers = await Promise.all(
    Array.from({ length: 8 }, (_unused, i) => sendToHook(hook.url, { i })),
  );
  // Burst = 4 × rate (CONTRACTS §25.2): four in (five if the bucket refilled meanwhile),
  // every other one refused.
  const accepted = answers.filter((answer) => answer.status === 202).length;
  expect(accepted).toBeGreaterThanOrEqual(4);
  expect(accepted).toBeLessThanOrEqual(5);
  const refused = answers.filter((answer) => answer.status === 429);
  expect(refused).toHaveLength(answers.length - accepted);
  for (const answer of refused) {
    expect(Number(answer.retryAfter)).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(answer.body)).toMatchObject({ code: 'RATE_LIMITED' });
  }
  const [stored] = await sql(
    'SELECT count(*)::int AS n FROM meta.incoming_webhook_requests WHERE incoming_webhook_id = $1',
    [hook.id],
  );
  expect(stored?.['n']).toBe(accepted);
  await context.close();
});

test('http_request to internal addresses outside the allowlist is blocked, the trap gets 0 connections', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const { context, page } = await openAs(browser, DEMO_ADMIN_EMAIL);
  const csp = collectCspViolations(page);
  // The metadata name is allowlisted: its address stays blocked.
  await allowInUi(page, METADATA_HOST);
  const step = (url: string) => ({
    id: 'act_http',
    type: 'http_request',
    config: { method: 'POST', url: { literal: url } },
  });
  const trigger = { type: 'record.created', table_id: ids.customers };
  // `null`: any reason (the loopback literal on the trap's port).
  const cases = [
    [`http://${TRAP_HOST}/`, 'private_address'],
    [`http://${TRAP_HOST}:${String(trap.port)}/`, 'port_not_allowed'],
    ['http://10.0.0.5/', 'private_address'],
    [`http://127.0.0.1:${String(trap.port)}/`, null],
    [`http://${METADATA_HOST}/latest/meta-data/`, 'blocked_address'],
  ] as const;
  const flows: string[] = [];
  for (const [url] of cases) {
    const created = await ok<{ id: string }>(page, 'POST', `/bases/${ids.baseId}/automations`, {
      name: `SSRF ${url}`,
      enabled: true,
      definition: { trigger, actions: [step(url)] },
    });
    flows.push(created.id);
  }
  await ok(page, 'POST', `/tables/${ids.customers}/records?field_key_type=id`, {
    records: [{ fields: { [ids.fields.customerName]: 'Khách SSRF T615' } }],
  });
  await settled();
  const runs: string[] = [];
  for (const [index, [url, reason]] of cases.entries()) {
    const [row] = await sql(
      'SELECT id, status, error FROM meta.automation_runs WHERE automation_id = $1',
      [flows[index]],
    );
    expect(row, url).toMatchObject({ status: 'failed', error: { code: 'ssrf_blocked' } });
    const error = row?.['error'] as { params?: { reason?: string } };
    if (reason !== null) expect(error.params?.reason, url).toBe(reason);
    runs.push(String(row?.['id']));
    await ok(page, 'POST', `/automations/${flows[index] ?? ''}/disable`);
  }
  expect(trap.connections).toBe(0);

  // The run history explains the block and what an organization admin can do (T614).
  await page.goto(runsPath(`?range=24h&run=${runs[0] ?? ''}`));
  const detail = page.getByTestId('run-detail');
  await expect(detail.getByTestId('step-error-act_http')).toContainText(
    "The URL leads to a private network address that the organization's HTTP allowlist does not open.",
  );
  await expect(detail.getByTestId('http-step-act_http').getByTestId('http-host')).toHaveText(
    TRAP_HOST,
  );
  await expect(detail.getByTestId('http-ssrf-hint')).toContainText(
    'can open this host (and its port)',
  );
  await expectNoSeriousA11yViolations(page, 'blocked internal address');
  expect(csp).toEqual([]);
  await context.close();
});

test('the worker killed between the two phases: after the lease the destination gets the same webhook-id and processes it once', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const { context, page } = await openAs(browser, DEMO_ADMIN_EMAIL);
  await ok(page, 'POST', `/orgs/${ids.orgId}/http-allowlist`, {
    pattern: `${SLOW_HOST}:${String(slow.port)}`,
  });
  // The destination keeps the first call open (the worker dies while it waits),
  // answers the next ones, and processes each webhook-id once.
  const processed = new Set<string>();
  let held: ServerResponse | null = null;
  slow.handler = (request, res) => {
    if (held === null && slow.received.length === 1) {
      held = res;
      return;
    }
    processed.add(String(request.headers['webhook-id']));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  };
  const flow = await ok<{ id: string }>(page, 'POST', `/bases/${ids.baseId}/automations`, {
    name: 'Gửi khách mới ra hệ thống chậm',
    enabled: true,
    definition: {
      trigger: { type: 'record.created', table_id: ids.customers },
      actions: [
        {
          id: 'act_http',
          type: 'http_request',
          config: { method: 'POST', url: { literal: `http://${SLOW_HOST}:${String(slow.port)}/` } },
        },
      ],
    },
  });
  await settled();
  await ok(page, 'POST', `/tables/${ids.customers}/records?field_key_type=id`, {
    records: [{ fields: { [ids.fields.customerName]: 'Khách T615 chậm' } }],
  });
  await expect.poll(() => slow.received.length, { timeout: 60_000 }).toBe(1);
  // While the call waits: no worker connection active or inside a transaction.
  await page.waitForTimeout(1_000);
  const [busy] = await sql(
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE application_name = 'e2e-t615-worker'
        AND state IN ('active', 'idle in transaction', 'idle in transaction (aborted)')`,
  );
  expect(busy?.['n']).toBe(0);
  const [sending] = await sql(
    `SELECT id, status, attempts, message_id FROM meta.http_deliveries
      WHERE automation_id = $1`,
    [flow.id],
  );
  expect(sending).toMatchObject({ status: 'sending', attempts: 1 });

  // The worker dies (SIGKILL: no clean shutdown); its job locks are released like an
  // operator would (graphile-worker keeps them 4 h), then a new worker starts.
  await stopWorker('SIGKILL');
  await sql(
    `SELECT graphile_worker.force_unlock_workers(
              ARRAY(SELECT DISTINCT locked_by FROM graphile_worker._private_jobs
                     WHERE locked_by IS NOT NULL))`,
  );
  await startWorker();
  // After the 30 s lease the delivery is taken again: same webhook-id, same key.
  await expect.poll(() => slow.received.length, { timeout: 120_000 }).toBe(2);
  await expect
    .poll(async () => (await runsOf(flow.id)).map((item) => item.status), { timeout: 60_000 })
    .toEqual(['succeeded']);
  const [first, second] = slow.received;
  expect(second?.headers['webhook-id']).toBe(first?.headers['webhook-id']);
  expect(second?.headers['webhook-id']).toBe(sending?.['message_id']);
  expect(second?.headers['idempotency-key']).toBe(first?.headers['idempotency-key']);
  expect([...processed]).toEqual([sending?.['message_id']]);
  const [done] = await sql('SELECT status, attempts FROM meta.http_deliveries WHERE id = $1', [
    sending?.['id'],
  ]);
  expect(done).toEqual({ status: 'succeeded', attempts: 2 });
  slow.handler = null;
  (held as ServerResponse | null)?.destroy();
  await ok(page, 'POST', `/automations/${flow.id}/disable`);
  await settled();
  await context.close();
});

test('Telegram in webhook mode: switched in the bot settings, /start through nginx links at once', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const admin = await openAs(browser, DEMO_ADMIN_EMAIL);
  await admin.page.goto(botsPath());
  const mode = admin.page.getByTestId('delivery-mode');
  await expect(admin.page.getByTestId('notification-bot-username')).toHaveText(`@${BOT_USERNAME}`);
  await mode.getByRole('radio', { name: /^Webhook/u }).check();
  await mode.getByTestId('delivery-mode-save').click();
  await expect(mode).toHaveAttribute('data-mode', 'webhook');
  await expect(mode.getByTestId('delivery-mode-webhook-status')).toHaveText('Working');
  expect(telegram.webhookUrl().startsWith(`${PUBLIC_URL}/api/v1/telegram/webhook/`)).toBe(true);
  await admin.context.close();

  const sales1 = await openAs(browser, SALES1_EMAIL);
  await sales1.page.goto(settingsPath());
  const card = sales1.page.getByTestId('telegram-channel');
  await card.getByTestId('telegram-link').click();
  const href = (await card.getByTestId('telegram-open').getAttribute('href')) ?? '';
  const token = new URL(href).searchParams.get('start') ?? '';
  const started = Date.now();
  expect((await telegramUpdate(`/start ${token}`)).status).toBe(200);
  await expect(card.getByTestId('telegram-linked')).toBeVisible({ timeout: 10_000 });
  const linkedAfter = Date.now() - started;
  test.info().annotations.push({
    type: 'latency',
    description: `/start → linked ${String(linkedAfter)} ms`,
  });
  await sales1.context.close();
});

test('200 hook requests assigning u_sales1: the bell rings once, one Telegram message', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const admin = await openAs(browser, DEMO_ADMIN_EMAIL);
  const hook = await ok<{ id: string; url: string }>(
    admin.page,
    'POST',
    `/bases/${ids.baseId}/incoming-webhooks`,
    { name: 'Phân công đơn (T615)', auth: 'none', rate_limit_per_sec: 20 },
  );
  await ok(admin.page, 'POST', `/bases/${ids.baseId}/automations`, {
    name: 'Giao đơn cho người bán từ hệ thống ngoài',
    enabled: true,
    definition: {
      trigger: { type: 'webhook.received', incoming_webhook_id: hook.id },
      actions: [
        {
          id: 'act_assign',
          type: 'update_record',
          config: {
            table_id: ids.orders,
            record_id: { trigger: 'body', path: 'record_id' },
            fields: { [ids.fields.owner]: { literal: [{ id: ids.users.sales1 }] } },
          },
        },
      ],
    },
  });
  // 200 orders of u_sales2 → u_sales1.
  const page = await ok<{ records: { id: string }[] }>(
    admin.page,
    'POST',
    `/tables/${ids.orders}/records/query?field_key_type=id`,
    {
      limit: HOOKS,
      include_total: false,
      fields: [ids.fields.title],
      filter: {
        op: 'and',
        items: [{ field: ids.fields.owner, operator: 'has_any_of', value: [ids.users.sales2] }],
      },
    },
  );
  expect(page.records).toHaveLength(HOOKS);
  await settled();
  // Earlier windows (hook B' wrote an order of u_sales1 in the n8n test) close first.
  await expect
    .poll(
      async () => {
        const [row] = await sql(
          `SELECT (SELECT count(*)::int FROM graphile_worker._private_jobs p
                     JOIN graphile_worker._private_tasks k ON k.id = p.task_id
                    WHERE k.identifier IN ('notifications.flush', 'notifications.deliver'))
                + (SELECT count(*)::int FROM meta.notification_buffer) AS n`,
        );
        return Number(row?.['n']);
      },
      { timeout: 120_000, intervals: [500] },
    )
    .toBe(0);

  const sales1 = await openAs(browser, SALES1_EMAIL);
  await sales1.page.goto(`/o/${encodeURIComponent(ids.orgSlug)}`);
  const bell = sales1.page.getByTestId('notification-bell').filter({ visible: true });
  await expect(bell).toBeVisible();
  await ok(sales1.page, 'POST', `/orgs/${ids.orgId}/me/notifications/read`, { all: true });
  await sales1.page.reload();
  await expect(bell).toBeVisible();
  const badge = async () => {
    const texts = await sales1.page
      .getByTestId('notification-badge')
      .filter({ visible: true })
      .allInnerTexts();
    return texts[0] === undefined ? 0 : Number(texts[0].replace(/\D/gu, ''));
  };
  expect(await badge()).toBe(0);
  const seen: number[] = [];
  const watch = setInterval(() => {
    void badge()
      .then((value) => {
        if (seen.at(-1) !== value) seen.push(value);
      })
      .catch(() => undefined);
  }, 100);
  const messages = telegram.sent().filter((item) => item.chatId === String(SALES1_CHAT)).length;

  // 15 requests a second through nginx (under 20/s per client IP and the hook's 20/s):
  // each request starts at least 1/15 s after the previous one started. Never on a
  // fixed timetable — after a slow answer a timetable sends the late requests back
  // to back, and over 20 of them in one second of the per-IP window answer 429.
  const gapMs = Math.ceil(1000 / 15);
  const statuses: number[] = [];
  let next = Date.now();
  for (const record of page.records) {
    const wait = next - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    next = Date.now() + gapMs;
    statuses.push((await sendToHook(hook.url, { record_id: record.id })).status);
  }
  expect(statuses.filter((status) => status !== 202)).toEqual([]);

  // The window of (hook, table) closes 60 s after its first write.
  await expect.poll(badge, { timeout: 120_000, intervals: [500] }).toBe(1);
  await settled();
  await expect
    .poll(() => telegram.sent().filter((item) => item.chatId === String(SALES1_CHAT)).length, {
      timeout: 30_000,
    })
    .toBe(messages + 1);
  await sales1.page.waitForTimeout(2_000);
  clearInterval(watch);
  expect(seen).toEqual([0, 1]);
  expect(sales1.created.filter((item) => item.type === 'record.assigned')).toHaveLength(1);
  const list = await ok<{
    items: { type: string; entity: { type: string }; data: Record<string, unknown> }[];
  }>(sales1.page, 'GET', `/orgs/${ids.orgId}/me/notifications?limit=50`);
  const assigned = list.items.filter(
    (item) =>
      item.type === 'record.assigned' &&
      (item.data['source'] as { incoming_webhook_id?: string } | null)?.incoming_webhook_id ===
        hook.id,
  );
  expect(assigned).toHaveLength(1);
  expect(assigned[0]).toMatchObject({
    entity: { type: 'table' },
    data: { count: HOOKS, source: { incoming_webhook_id: hook.id } },
  });
  await expectNoSeriousA11yViolations(sales1.page, 'bell after 200 hook writes');
  await sales1.context.close();
  await admin.context.close();
});

test('Telegram in webhook mode: /stop unlinks at once', async ({ browser }) => {
  const sales1 = await openAs(browser, SALES1_EMAIL);
  const started = Date.now();
  expect((await telegramUpdate('/stop')).status).toBe(200);
  await expect
    .poll(
      async () =>
        (await ok<{ items: unknown[] }>(sales1.page, 'GET', `/orgs/${ids.orgId}/me/channels`)).items
          .length,
      { timeout: 10_000, intervals: [100] },
    )
    .toBe(0);
  const unlinkedAfter = Date.now() - started;
  test.info().annotations.push({
    type: 'latency',
    description: `/stop → unlinked ${String(unlinkedAfter)} ms`,
  });
  expect(unlinkedAfter).toBeLessThan(5_000);
  await sales1.page.goto(settingsPath());
  await expect(
    sales1.page.getByTestId('telegram-channel').getByTestId('telegram-link'),
  ).toBeVisible();
  await sales1.context.close();
});
