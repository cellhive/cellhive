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

import { E2E_API_PORT, E2E_WEB_URL } from './ports';
import { DEMO_ADMIN_EMAIL, DEMO_PASSWORD } from './seed';
import { apiSignIn, collectCspViolations, expectNoSeriousA11yViolations, ok } from './support';
import { startFakeTelegram, type FakeTelegram } from './t519-telegram';
import { startFakeSmtp, type CapturedMail, type FakeSmtp } from './t526-smtp';

/**
 * T519: the end-to-end scenario of SPEC §24, S5 version (no AI, no
 * dashboard yet):
 *
 *   ticket from the public form
 *   → A (`record.created`): `update_record` "Mức độ" = Khẩn + "Phụ trách"
 *     (stands in for `ai_classify`)
 *   → B (`record.matches` "Mức độ = Khẩn"): `send_notification` +
 *     `send_email` (fake SMTP) + `send_telegram` (fake Bot API)
 *   → C (`record.created`): `delay` + recheck "Trạng thái ≠ Đã xong" →
 *     `send_telegram` "Quá SLA"
 *   → the person in charge sets "Đã xong" in the grid before the delay ends
 *   → C ends `skipped` (`recheck_not_matched`), no "Quá SLA" message.
 *
 * Its own stack, so that nothing of the shared one runs these automations:
 * PostgreSQL 18 + Valkey 8 (Testcontainers), migrations and `seed:demo`, the
 * built API (`MODE=api`, its own port) with `SMTP_URL` on an in-process fake
 * SMTP server, and the worker **in this process** (`@cellhive/worker` and
 * `@cellhive/server-core` builds) with its test-only Telegram client
 * pointed at an in-process fake Bot API. The browser's `/api` calls go to
 * this API (`context.route`); realtime is not used. The delay is the
 * minimum (1 minute), shortened to ~5 s by moving its end and its job to
 * now like the T506 integration test.
 */

const RUN = String(Date.now()).slice(-6);
const API_PORT = Number(process.env['E2E_T519_API_PORT'] ?? E2E_API_PORT + 19);
const API_URL = `http://127.0.0.1:${String(API_PORT)}`;
const API_DIST = fileURLToPath(new URL('../../api/dist/', import.meta.url));
const SMTP_USER = 'mailer';
const SMTP_PASSWORD = 'e2e-t519-secret';
const EDITOR_EMAIL = 'editor@demo.cellhive.local';
const TITLE = `Máy POS ${RUN} mất kết nối`;
const CHAT_ID = '-1001234567890';
/** Grid geometry (GridView; as in the T203 spec). */
const HEADER_HEIGHT = 36;
const ROW_HEIGHT = 34;
/** The fake token of the seeded bot "Bot CSKH (demo)" (CONTRACTS §9). */
const SEED_BOT_TOKEN = '123456789:DEMO-not-a-real-bot-token-000000000';

interface Pg {
  Client: new (options: { connectionString: string }) => {
    connect: () => Promise<void>;
    query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
    end: () => Promise<void>;
  };
}

/** What the spec uses of the worker and server-core builds (loaded at run time). */
interface WorkerBuild {
  createWorker: (
    config: unknown,
    options: { logger: unknown; taskList: unknown; pollIntervalMs: number },
  ) => Promise<{ close: () => Promise<void> }>;
  buildTaskList: (deps: {
    config: unknown;
    db: unknown;
    logger: unknown;
    telegramClient: { baseUrl: string };
  }) => unknown;
}
interface CoreBuild {
  loadConfig: (env: NodeJS.ProcessEnv) => { database: { url: string } };
  createDb: (config: {
    url: string;
    poolMax: number;
    applicationName: string;
    statementTimeoutMs: number;
  }) => { destroy: () => Promise<void> };
  JOB_STATEMENT_TIMEOUT_MS: number;
}

let postgres: StartedPostgreSqlContainer;
let valkey: StartedTestContainer;
let storage: string;
let env: NodeJS.ProcessEnv;
let api: ChildProcess;
let smtp: FakeSmtp;
let telegram: FakeTelegram;
let worker: { close: () => Promise<void> };
let workerDb: { destroy: () => Promise<void> };
let formToken = '';
/** Teardown of what `beforeAll` started, in start order. */
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

/** Runs an API build script to completion; returns its stdout. */
function run(script: string, extra: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [`${API_DIST}${script}`], {
      env: { ...env, ...extra },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`${script} exited with code ${String(code)}:\n${out}`));
    });
  });
}

async function startApi(): Promise<ChildProcess> {
  const child = spawn(process.execPath, [`${API_DIST}main.js`], {
    env: { ...env, MODE: 'api', PORT: String(API_PORT) },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`API exited with ${String(child.exitCode)}`);
    try {
      if ((await fetch(`${API_URL}/healthz`)).ok) return child;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`API on ${String(API_PORT)} did not start`);
    await sleep(250);
  }
}

/** The worker of this stack, in this process, with the fake Bot API (test-only option). */
async function startWorker(): Promise<void> {
  const core = (await import(
    new URL('../../../packages/server-core/dist/index.js', import.meta.url).href
  )) as CoreBuild;
  const build = (await import(
    new URL('../../worker/dist/index.js', import.meta.url).href
  )) as WorkerBuild;
  const { pino } = requireFromApi('pino') as {
    pino: (options: { level: string; base: Record<string, string> }) => unknown;
  };
  const config = core.loadConfig({ ...env, MODE: 'worker' });
  const logger = pino({ level: 'warn', base: { service: 'e2e-t519-worker' } });
  workerDb = core.createDb({
    url: config.database.url,
    poolMax: 5,
    applicationName: 'e2e-t519-worker',
    statementTimeoutMs: core.JOB_STATEMENT_TIMEOUT_MS,
  });
  const taskList = build.buildTaskList({
    config,
    db: workerDb,
    logger,
    telegramClient: { baseUrl: telegram.baseUrl },
  });
  worker = await build.createWorker(config, { logger, taskList, pollIntervalMs: 100 });
}

async function openAs(
  browser: Browser,
  email: string | null,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    locale: 'en-US',
  });
  await context.addInitScript(() => {
    window.localStorage.setItem('cellhive.language', 'en');
  });
  await context.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `${API_URL}${url.pathname}${url.search}` });
    await route.fulfill({ response });
  });
  const page = await context.newPage();
  await page.goto('/login');
  if (email !== null) await apiSignIn(page, email, DEMO_PASSWORD);
  return { context, page };
}

interface Field {
  id: string;
  name: string;
}

interface Demo {
  baseId: string;
  tickets: string;
  fields: Field[];
  botId: string;
  editorId: string;
}

async function findDemo(page: Page): Promise<Demo> {
  const me = await ok<{ orgs: { id: string }[] }>(page, 'GET', '/me');
  const orgId = me.orgs[0]?.id ?? '';
  const workspaces = await ok<{ items: { id: string }[] }>(
    page,
    'GET',
    `/orgs/${orgId}/workspaces`,
  );
  for (const workspace of workspaces.items) {
    const bases = await ok<{ items: { id: string; name: string }[] }>(
      page,
      'GET',
      `/workspaces/${workspace.id}/bases`,
    );
    const base = bases.items.find((item) => item.name === 'Chăm sóc khách hàng');
    if (base === undefined) continue;
    const tables = await ok<{ items: { id: string; name: string }[] }>(
      page,
      'GET',
      `/bases/${base.id}/tables`,
    );
    const tickets = tables.items.find((table) => table.name === 'Tickets')?.id ?? '';
    const fields = await ok<{ items: Field[] }>(page, 'GET', `/tables/${tickets}/fields`);
    const bots = await ok<{ items: { id: string; name: string }[] }>(
      page,
      'GET',
      `/bases/${base.id}/secrets?kind=telegram_bot`,
    );
    const editor = await sql('SELECT id FROM meta.users WHERE email = $1', [EDITOR_EMAIL]);
    return {
      baseId: base.id,
      tickets,
      fields: fields.items,
      botId: bots.items.find((bot) => bot.name === 'Bot CSKH (demo)')?.id ?? '',
      editorId: typeof editor[0]?.['id'] === 'string' ? editor[0]['id'] : '',
    };
  }
  throw new Error('The demo base is missing.');
}

interface Run {
  id: string;
  status: string;
  error: { code: string } | null;
}

async function runsOf(page: Page, automationId: string): Promise<Run[]> {
  return (await ok<{ items: Run[] }>(page, 'GET', `/automations/${automationId}/runs`)).items;
}

/** Quoted-printable / base64 MIME words of a header as text (enough to find the run tag). */
function decodedSubject(raw: string): string {
  const line = (/^Subject: (.*(?:\r?\n[ \t].*)*)/mu.exec(raw)?.[1] ?? '')
    // Whitespace between two encoded words is not part of the text (RFC 2047 §6.2).
    .replace(/\?=\s+=\?/gu, '?==?');
  return line.replace(/=\?UTF-8\?([BQ])\?([^?]*)\?=/giu, (_all, kind: string, text: string) =>
    kind.toUpperCase() === 'B'
      ? Buffer.from(text, 'base64').toString('utf8')
      : Buffer.from(
          text
            .replace(/_/gu, ' ')
            .replace(/=([0-9A-F]{2})/giu, (_m, hex: string) =>
              String.fromCharCode(parseInt(hex, 16)),
            ),
          'latin1',
        ).toString('utf8'),
  );
}

/** `X-Cellhive-Automation` of a raw message (header names are case-insensitive). */
function automationHeader(raw: string): string | undefined {
  return /^X-Cellhive-Automation: (\S+)/imu.exec(raw)?.[1];
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(600_000);
  [smtp, telegram] = await Promise.all([
    startFakeSmtp({ user: SMTP_USER, pass: SMTP_PASSWORD }),
    startFakeTelegram(),
  ]);
  closers.push(
    () => smtp.close(),
    () => telegram.close(),
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
  storage = await mkdtemp(join(tmpdir(), 'cellhive-e2e-t519-'));
  closers.push(() => rm(storage, { recursive: true, force: true }));
  env = {
    PATH: process.env['PATH'],
    HOME: process.env['HOME'],
    NODE_ENV: 'production',
    PUBLIC_URL: E2E_WEB_URL,
    DATABASE_URL: postgres.getConnectionUri(),
    CACHE_URL: `redis://${valkey.getHost()}:${String(valkey.getMappedPort(6379))}`,
    APP_MASTER_KEY: randomBytes(32).toString('base64'),
    SESSION_SECRET: randomBytes(32).toString('base64'),
    STORAGE_DRIVER: 'local',
    STORAGE_LOCAL_PATH: storage,
    DEFAULT_LOCALE: 'en',
    DEFAULT_TIMEZONE: 'UTC',
    LOG_LEVEL: 'warn',
    SMTP_URL: `smtp://${SMTP_USER}:${SMTP_PASSWORD}@127.0.0.1:${String(smtp.port)}`,
    SMTP_FROM: 'Cellhive Demo <no-reply@cellhive.test>',
    SMTP_ALLOWED_FROM_DOMAINS: 'cellhive.test',
    SMTP_ALLOW_INSECURE: 'true',
  };
  await run('main.js', { MODE: 'migrate' });
  // The demo data (CONTRACTS §9), development passwords; nothing is mailed by the seed.
  const seeded = await run('seed.js', { NODE_ENV: 'development' });
  expect(smtp.messages).toEqual([]);
  formToken = /Gửi yêu cầu hỗ trợ\s+public\s+\S+\/s\/([A-Za-z0-9_-]{43})/u.exec(seeded)?.[1] ?? '';
  expect(formToken).not.toBe('');
  api = await startApi();
  closers.push(async () => {
    if (api.exitCode !== null) return;
    const exited = new Promise((resolve) => api.once('exit', resolve));
    api.kill('SIGTERM');
    await exited;
  });
  await startWorker();
  closers.push(
    () => workerDb.destroy(),
    () => worker.close(),
  );
});

test.afterAll(async () => {
  // What started, in reverse order (the worker and API before the database).
  for (const close of closers.reverse()) await close();
});

test('S§24 (S5): public form → A → B notifies, mails, Telegram → C skipped once done', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const admin = await openAs(browser, DEMO_ADMIN_EMAIL);
  const demo = await findDemo(admin.page);
  const field = (name: string): string => {
    const found = demo.fields.find((item) => item.name === name);
    if (found === undefined) throw new Error(`Tickets has no field ${name}`);
    return found.id;
  };
  expect(demo.botId).not.toBe('');

  // "Mức độ": what the AI step of SPEC §24 would fill (A sets it instead).
  const level = await ok<{ id: string }>(admin.page, 'POST', `/tables/${demo.tickets}/fields`, {
    name: 'Mức độ',
    type: 'select',
    options: { options: [{ name: 'Thường' }, { name: 'Khẩn' }] },
  });
  const ref = (id: string) => `{{ [${id}] }}`;
  const create = async (name: string, definition: object) =>
    (
      await ok<{ id: string; enabled: boolean }>(
        admin.page,
        'POST',
        `/bases/${demo.baseId}/automations`,
        { name: `${name} ${RUN}`, enabled: true, definition },
      )
    ).id;
  const automationA = await create('A · phân loại', {
    trigger: { type: 'record.created', table_id: demo.tickets },
    actions: [
      {
        id: 'act_classify',
        type: 'update_record',
        config: {
          table_id: demo.tickets,
          fields: {
            [level.id]: { literal: 'Khẩn' },
            [field('Phụ trách')]: { literal: [{ id: demo.editorId }] },
          },
        },
      },
    ],
  });
  const automationB = await create('B · báo khẩn', {
    trigger: {
      type: 'record.matches',
      table_id: demo.tickets,
      condition: { op: 'and', items: [{ field: level.id, operator: 'is', value: 'Khẩn' }] },
    },
    actions: [
      {
        id: 'act_notify',
        type: 'send_notification',
        config: {
          recipients: [{ field: field('Phụ trách') }],
          title: { template: `Khẩn: ${ref(field('Tiêu đề'))}` },
        },
      },
      {
        id: 'act_email',
        type: 'send_email',
        config: {
          to: [{ field: field('Phụ trách') }],
          subject: { template: `[Khẩn] ${ref(field('Tiêu đề'))}` },
          body: {
            format: 'markdown',
            template: `Ticket **${ref(field('Tiêu đề'))}** cần xử lý gấp.`,
          },
        },
      },
      {
        id: 'act_telegram',
        type: 'send_telegram',
        config: {
          secret_id: demo.botId,
          chat_id: { literal: CHAT_ID },
          text: { template: `<b>Khẩn</b>: ${ref(field('Tiêu đề'))}` },
        },
      },
    ],
  });
  const automationC = await create('C · SLA', {
    trigger: { type: 'record.created', table_id: demo.tickets },
    actions: [
      {
        id: 'act_wait',
        type: 'delay',
        config: {
          minutes: 1,
          recheck_condition: {
            op: 'and',
            items: [{ field: field('Trạng thái'), operator: 'is_not', value: 'Đã xong' }],
          },
        },
      },
      {
        id: 'act_late',
        type: 'send_telegram',
        config: {
          secret_id: demo.botId,
          chat_id: { literal: CHAT_ID },
          text: { template: `Quá SLA: ${ref(field('Tiêu đề'))}` },
        },
      },
    ],
  });

  await test.step('an anonymous visitor sends the public support form', async () => {
    const visitor = await openAs(browser, null);
    const csp = collectCspViolations(visitor.page);
    await visitor.page.goto(`/s/${formToken}`);
    await expect(
      visitor.page.getByRole('heading', { level: 1, name: 'Gửi yêu cầu hỗ trợ' }),
    ).toBeVisible();
    await visitor.page
      .getByTestId('form-question')
      .filter({ hasText: 'Vấn đề gặp phải' })
      .getByRole('textbox')
      .fill(TITLE);
    await visitor.page.getByRole('button', { name: 'Submit' }).click();
    // The minimum fill time (3 s) is waited for by the page.
    await expect(visitor.page.getByRole('heading', { name: 'Response sent' })).toBeVisible({
      timeout: 15_000,
    });
    expect(csp).toEqual([]);
    await visitor.context.close();
  });

  let ticket = '';
  await expect
    .poll(async () => {
      const found = await ok<{ records: { id: string }[] }>(
        admin.page,
        'POST',
        `/tables/${demo.tickets}/records/query`,
        {
          filter: { op: 'and', items: [{ field: field('Tiêu đề'), operator: 'eq', value: TITLE }] },
          limit: 10,
        },
      );
      ticket = found.records.length === 1 ? (found.records[0]?.id ?? '') : '';
      return ticket;
    })
    .not.toBe('');

  await test.step('A fills "Mức độ" and the person in charge; B notifies, mails and posts', async () => {
    await expect
      .poll(async () => (await runsOf(admin.page, automationA)).map((item) => item.status), {
        timeout: 60_000,
      })
      .toEqual(['succeeded']);
    await expect
      .poll(async () => (await runsOf(admin.page, automationB)).map((item) => item.status), {
        timeout: 60_000,
      })
      .toEqual(['succeeded']);
    const record = await ok<{ fields: Record<string, unknown> }>(
      admin.page,
      'GET',
      `/tables/${demo.tickets}/records/${ticket}?field_key_type=id`,
    );
    expect(record.fields[level.id]).toBe('Khẩn');
    // Email: from the system sender to the person in charge, with the automation header.
    const mail = smtp.messages.find(
      (item: CapturedMail) =>
        item.to.includes(EDITOR_EMAIL) && automationHeader(item.raw) === automationB,
    );
    expect(mail).toBeDefined();
    expect(decodedSubject(mail?.raw ?? '')).toContain(TITLE);
    expect(mail?.raw).toMatch(/^Auto-Submitted: auto-generated/mu);
    // Telegram: the seeded bot, the chat of the step, the title as text.
    const posted = telegram.calls.filter((call) => call.method === 'sendMessage');
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      token: SEED_BOT_TOKEN,
      body: { chat_id: CHAT_ID, text: `<b>Khẩn</b>: ${TITLE}`, parse_mode: 'HTML' },
    });
    // C waits in its delay.
    expect((await runsOf(admin.page, automationC)).map((item) => item.status)).toEqual(['waiting']);
  });

  const editor = await openAs(browser, EDITOR_EMAIL);
  await test.step('the person in charge sees the notification in the app', async () => {
    const csp = collectCspViolations(editor.page);
    await editor.page.goto('/');
    const bell = editor.page.getByTestId('notification-bell').filter({ visible: true });
    await expect(bell).toBeVisible();
    // The S5 message, and (T557: the seed turns on `notify_on_assign` of
    // "Phụ trách") the assignment A made — an automation is no user actor.
    await expect(
      editor.page.getByTestId('notification-badge').filter({ visible: true }),
    ).toHaveText('2');
    await bell.click();
    const panel = editor.page.getByTestId('notification-panel');
    await expect(panel.getByRole('link', { name: `Khẩn: ${TITLE}` })).toBeVisible();
    await expect(
      panel.getByRole('link', { name: new RegExp(`«${TITLE}» · Phụ trách$`, 'u') }),
    ).toBeVisible();
    await expectNoSeriousA11yViolations(editor.page, 'notification panel with the S5 message');
    await editor.page.keyboard.press('Escape');
    expect(csp).toEqual([]);
  });

  await test.step('they set "Đã xong" in the grid before the delay ends', async () => {
    // A personal view with only this ticket: its row is the first one.
    const view = await ok<{ id: string }>(editor.page, 'POST', `/tables/${demo.tickets}/views`, {
      name: `Ticket ${RUN}`,
      type: 'grid',
      is_personal: true,
      config: {
        filter: { op: 'and', items: [{ field: field('Tiêu đề'), operator: 'eq', value: TITLE }] },
      },
    });
    await editor.page.goto(`/b/${demo.baseId}/t/${demo.tickets}/v/${view.id}`);
    await expect(
      editor.page.locator('table[role="grid"] td[role="gridcell"]').filter({ hasText: TITLE }),
    ).toHaveCount(1);
    const header = editor.page
      .locator('table[role="grid"] th[role="columnheader"]')
      .filter({ hasText: /^Trạng thái$/u });
    const column = Number(await header.getAttribute('aria-colindex'));
    const cell = editor.page.getByTestId(`glide-cell-${String(column)}-0`);
    const first = editor.page.getByTestId('glide-cell-1-0');
    // The accessibility table is off screen: click the canvas, in the first data row.
    const canvas = editor.page.locator('.ob-grid [data-testid="data-grid-canvas"]');
    const box = await canvas.boundingBox();
    if (box === null) throw new Error('grid not laid out');
    await editor.page.mouse.click(box.x + 150, box.y + HEADER_HEIGHT + ROW_HEIGHT / 2);
    await expect(first).toHaveAttribute('aria-selected', 'true');
    for (let step = 1; step < column; step += 1) await editor.page.keyboard.press('ArrowRight');
    await expect(cell).toHaveAttribute('aria-selected', 'true');
    await editor.page.keyboard.press('Enter');
    const listbox = editor.page.locator('#portal').getByRole('listbox', { name: 'Trạng thái' });
    const saved = editor.page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' &&
        /\/api\/v1\/tables\/tbl_[^/]+\/records/u.test(response.url()),
    );
    await listbox.getByRole('option', { name: 'Đã xong' }).click();
    expect((await saved).status()).toBe(200);
    await expect(cell).toHaveText('Đã xong');
  });

  await test.step('the delay ends (shortened to ~5 s): C ends skipped, no "Quá SLA"', async () => {
    const [waiting] = await runsOf(admin.page, automationC);
    if (waiting === undefined) throw new Error('C has no run');
    await sleep(5_000);
    // The end of the delay and its job move to now (the T506 way), instead of a minute.
    await sql(
      `UPDATE meta.automation_run_steps
          SET output = jsonb_set(output, '{until}', to_jsonb($2::text))
        WHERE run_id = $1 AND status = 'waiting'`,
      [waiting.id, new Date(Date.now() - 1_000).toISOString()],
    );
    await sql(`UPDATE graphile_worker._private_jobs SET run_at = now() WHERE key = $1`, [
      `automation.run:wait:${waiting.id}`,
    ]);
    await expect
      .poll(async () => (await runsOf(admin.page, automationC))[0], { timeout: 60_000 })
      .toMatchObject({ status: 'skipped', error: { code: 'recheck_not_matched' } });
    expect(
      telegram.calls.filter(
        (call) => typeof call.body['text'] === 'string' && call.body['text'].startsWith('Quá SLA'),
      ),
    ).toEqual([]);
  });

  await editor.context.close();
  await admin.context.close();
});
