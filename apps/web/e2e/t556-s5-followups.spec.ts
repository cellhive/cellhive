import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { type Browser, type BrowserContext, type Page } from '@playwright/test';

import { pngBytes } from './attachments';
import { expect, test, WORKER_ORG } from './fixtures';
import { E2E_API_PORT, E2E_STACK_ENV } from './ports';
import { DEMO_PASSWORD } from './seed';
import {
  apiSignIn,
  collectCspViolations,
  expectNoSeriousA11yViolations,
  ok,
  retryWhileRateLimited,
} from './support';
import { startFakeSmtp, type CapturedMail, type FakeSmtp } from './t526-smtp';

/**
 * T556: the S5 follow-ups of sprint S5b on the demo organization (CONTRACTS §9):
 *
 * 1. QA S5 L2 — opening the notification panel fetches the unread count and
 *    the list again: realtime is muted for `notification.created` (the socket
 *    stays open, so no reconnect refetch), a notification arrives through the
 *    real pipeline (`notifications.fanout`), and the panel shows it.
 * 2. S5-review §4 #16 — the run history of an automation at 375 px puts the
 *    "Configuration | Run history" tabs on a row below the top bar.
 * 3. QA S5 L1 — a `send_email` step refused with `550 5.1.1` lists the masked
 *    recipient and the reason. The run is written straight into
 *    `meta.automation_runs`/`meta.automation_run_steps` in the shape the engine
 *    stores (T541, asserted by `automation-send-email.int.test.ts`): the shared
 *    stack's worker has no SMTP, so it cannot produce a `550` itself.
 * 4. QA S5 M7 — an identity whose display name was saved before T540 (written
 *    through SQL: the API refuses it now) is flagged; fixing it clears the flag.
 * 5. Duplicating automations (T551): from the list's row menu and the
 *    builder's header; the copy of an automation with an email body image
 *    opens turned off and its test email carries the image; a button
 *    automation cannot be copied and the dialog says why.
 *
 * Like T522, this spec starts its own API process (MODE=api) with `SMTP_URL`
 * pointing at an in-process fake SMTP server and forwards the browser's
 * `/api` calls to it; realtime (WebSocket) still goes to the shared stack.
 * Each screen runs at 1440 px light `en` and 375 px dark `vi` (or 1440 px dark
 * `vi` where phones have no such control), with axe and the keyboard.
 */

const SMTP_USER = 'mailer';
const SMTP_PASSWORD = 'e2e-t556-secret';
const API_PORT = Number(process.env['E2E_T556_API_PORT'] ?? E2E_API_PORT + 56);
const API_URL = `http://127.0.0.1:${String(API_PORT)}`;
const API_MAIN = fileURLToPath(new URL('../../api/dist/main.js', import.meta.url));
const RUN = String(Date.now()).slice(-6);
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

type Language = 'en' | 'vi';

interface Setup {
  readonly name: string;
  readonly viewport: { width: number; height: number };
  readonly language: Language;
  readonly colorScheme: 'light' | 'dark';
}

const DESKTOP: Setup = {
  name: '1440 px, light, en',
  viewport: { width: 1440, height: 900 },
  language: 'en',
  colorScheme: 'light',
};
const PHONE: Setup = {
  name: '375 px, dark, vi',
  viewport: { width: 375, height: 812 },
  language: 'vi',
  colorScheme: 'dark',
};
const DESKTOP_DARK: Setup = {
  name: '1440 px, dark, vi',
  viewport: { width: 1440, height: 900 },
  language: 'vi',
  colorScheme: 'dark',
};

function fakeId(prefix: string): string {
  let id = '';
  for (let index = 0; index < 16; index += 1) {
    id += BASE62[Math.floor(Math.random() * BASE62.length)] ?? '0';
  }
  return `${prefix}_${id}`;
}

interface Pg {
  Client: new (options: { connectionString: string }) => {
    connect: () => Promise<void>;
    query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
    end: () => Promise<void>;
  };
}

async function sql(text: string, values: unknown[] = []): Promise<Record<string, unknown>[]> {
  const raw = process.env[E2E_STACK_ENV];
  if (raw === undefined) throw new Error('The E2E global setup did not publish the stack env.');
  const { DATABASE_URL } = JSON.parse(raw) as { DATABASE_URL: string };
  const pg = createRequire(new URL('../../api/package.json', import.meta.url))('pg') as Pg;
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return (await client.query(text, values)).rows;
  } finally {
    await client.end();
  }
}

async function startApi(env: Record<string, string>): Promise<ChildProcess> {
  const raw = process.env[E2E_STACK_ENV];
  if (raw === undefined) throw new Error('The E2E global setup did not publish the stack env.');
  const child = spawn(process.execPath, [API_MAIN], {
    env: { ...(JSON.parse(raw) as NodeJS.ProcessEnv), ...env, MODE: 'api', PORT: String(API_PORT) },
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

async function openAs(
  browser: Browser,
  setup: Setup = DESKTOP,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: setup.viewport,
    colorScheme: setup.colorScheme,
    locale: setup.language === 'vi' ? 'vi-VN' : 'en-US',
  });
  await context.addInitScript((language) => {
    window.localStorage.setItem('cellhive.language', language);
  }, setup.language);
  await context.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    try {
      const response = await route.fetch({ url: `${API_URL}${url.pathname}${url.search}` });
      await route.fulfill({ response });
    } catch {
      // The page dropped the request meanwhile (a preview superseded by a newer one).
      await route.abort().catch(() => undefined);
    }
  });
  const page = await context.newPage();
  await page.goto('/login');
  await apiSignIn(page, WORKER_ORG.email('admin'), DEMO_PASSWORD);
  return { context, page };
}

interface Field {
  id: string;
  name: string;
  type: string;
  is_primary: boolean;
}

interface Demo {
  orgId: string;
  orgSlug: string;
  userId: string;
  baseId: string;
  tickets: string;
  ticketFields: Field[];
}

async function findDemo(page: Page): Promise<Demo> {
  const me = await ok<{ user: { id: string }; orgs: { id: string; slug: string }[] }>(
    page,
    'GET',
    '/me',
  );
  for (const org of me.orgs) {
    const workspaces = await ok<{ items: { id: string }[] }>(
      page,
      'GET',
      `/orgs/${org.id}/workspaces`,
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
      return {
        orgId: org.id,
        orgSlug: org.slug,
        userId: me.user.id,
        baseId: base.id,
        tickets,
        ticketFields: fields.items,
      };
    }
  }
  throw new Error('The demo base is missing.');
}

/** An email body image of an automation, uploaded like the editor does (CONTRACTS §23.5). */
async function uploadEmailImage(page: Page, automationId: string): Promise<string> {
  const bytes = pngBytes([15, 118, 110], 200, 60);
  const answer = await retryWhileRateLimited(() =>
    page.evaluate(
      async ({ automationId: target, base64 }) => {
        const csrf = document.cookie
          .split('; ')
          .find((cookie) => cookie.startsWith('ob_csrf='))
          ?.slice('ob_csrf='.length);
        const headers = {
          Accept: 'application/json',
          ...(csrf === undefined ? {} : { 'X-CSRF-Token': decodeURIComponent(csrf) }),
        };
        const data = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
        const root = `/api/v1/automations/${target}/email-assets/uploads`;
        const created = await fetch(root, {
          method: 'POST',
          credentials: 'include',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: 'logo-t556.png', size: data.length, mime: 'image/png' }),
        });
        if (created.status !== 201) {
          return { status: created.status, body: await created.text(), retryAfter: null };
        }
        const upload = (await created.json()) as {
          id: string;
          upload: { url: string; headers: Record<string, string> };
        };
        const put = await fetch(upload.upload.url, {
          method: 'PUT',
          headers: upload.upload.headers,
          body: data,
        });
        if (!put.ok) return { status: put.status, body: await put.text(), retryAfter: null };
        const done = await fetch(`${root}/${upload.id}/complete`, {
          method: 'POST',
          credentials: 'include',
          headers,
        });
        return {
          status: done.status,
          body: await done.text(),
          retryAfter: done.headers.get('retry-after'),
        };
      },
      { automationId, base64: bytes.toString('base64') },
    ),
  );
  expect(answer.status, `email image upload: ${answer.body}`).toBe(200);
  return (JSON.parse(answer.body) as { markdown: string }).markdown;
}

/** Queues `notifications.fanout` like a producer does (CONTRACTS §22.2, as in T524). */
async function notify(title: string): Promise<void> {
  const payload = {
    organization_id: demo.orgId,
    type: 'automation.message',
    base_id: demo.baseId,
    table_id: null,
    entity_type: 'automation',
    entity_id: refusedAutomationId,
    actor: null,
    group_key: fakeId('key'),
    recipients: { user_ids: [demo.userId], base_admins: false },
    requires: { record_id: null, field_ids: [] },
    skip_actor: false,
    data: {
      automation_id: refusedAutomationId,
      run_id: fakeId('run'),
      title,
      body: `Body of ${title}`,
    },
  };
  await sql(`SELECT graphile_worker.add_job('notifications.fanout', $1::json, priority => -100)`, [
    JSON.stringify(payload),
  ]);
}

async function unreadCount(page: Page): Promise<number> {
  const body = await ok<{ count: number }>(
    page,
    'GET',
    `/orgs/${demo.orgId}/me/notifications/unread-count`,
  );
  return body.count;
}

/** The bell's badge as a number (0 without a badge). */
async function badge(page: Page): Promise<number> {
  const texts = await page
    .getByTestId('notification-badge')
    .filter({ visible: true })
    .allInnerTexts();
  const text = texts[0];
  return text === undefined ? 0 : Number(text.replace(/\D/gu, ''));
}

async function noHorizontalScroll(page: Page, width: number): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    width,
  );
}

async function lastMailTo(address: string, after: number): Promise<CapturedMail> {
  let mail: CapturedMail | undefined;
  await expect
    .poll(() => {
      mail = smtp.messages.slice(after).findLast((item) => item.to.includes(address));
      return mail !== undefined;
    })
    .toBe(true);
  return mail as CapturedMail;
}

test.describe.configure({ mode: 'serial' });

let smtp: FakeSmtp;
let api: ChildProcess;
let demo: Demo;
let refusedAutomationId = '';
let refusedRunId = '';
let imageAutomationId = '';
let imageAutomationName = '';
let sourceAssetId = '';
let identityId = '';
let identityName = '';

const mailDefinition = (body: string) => ({
  trigger: { type: 'record.created', table_id: demo.tickets },
  actions: [
    {
      id: 'act_mail',
      type: 'send_email',
      config: {
        to: [{ literal: 'customer@example.com' }],
        subject: { template: `T556 ${RUN}` },
        body: { format: 'markdown', template: body },
      },
    },
  ],
});

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  smtp = await startFakeSmtp({ user: SMTP_USER, pass: SMTP_PASSWORD });
  api = await startApi({
    SMTP_URL: `smtp://${SMTP_USER}:${SMTP_PASSWORD}@127.0.0.1:${String(smtp.port)}`,
    SMTP_FROM: 'Cellhive Demo <no-reply@cellhive.test>',
    SMTP_ALLOWED_FROM_DOMAINS: 'cellhive.test',
    SMTP_ALLOW_INSECURE: 'true',
  });
  const { context, page } = await openAs(browser);
  demo = await findDemo(page);
  await ok(page, 'POST', `/orgs/${demo.orgId}/me/notifications/read`, { all: true });

  // (2, 3) An automation whose email step was refused by the receiving server.
  const refused = await ok<{ id: string; definition: unknown }>(
    page,
    'POST',
    `/bases/${demo.baseId}/automations`,
    {
      name: `E2E refused recipients ${RUN} — a long name to wrap`,
      definition: mailDefinition('Hi'),
    },
  );
  refusedAutomationId = refused.id;
  const [owner] = await sql(`SELECT organization_id FROM meta.automations WHERE id = $1`, [
    refusedAutomationId,
  ]);
  const orgId = owner?.['organization_id'] as string;
  refusedRunId = fakeId('run');
  const params = {
    reason: 'rejected',
    smtp: { code: 550, enhanced: '5.1.1' },
    rejected: [
      { masked: 'c***@example.com', code: 'smtp_rejected', smtp: { code: 550, enhanced: '5.1.1' } },
    ],
    rejected_count: 1,
    accepted_count: 0,
  };
  await sql(
    `INSERT INTO meta.automation_runs
       (id, organization_id, automation_id, automation_version, trigger_unit, status, error,
        input, started_at, finished_at, created_at)
     VALUES ($1, $2, $3, 1, $1, 'failed', $4::jsonb, $5::jsonb, now(), now(), now())`,
    [
      refusedRunId,
      orgId,
      refusedAutomationId,
      JSON.stringify({ code: 'smtp_rejected', step: 'act_mail' }),
      JSON.stringify({
        automation_version: 1,
        definition: refused.definition,
        trigger: {
          event_id: null,
          type: 'record.created',
          table_id: demo.tickets,
          record_id: null,
          bulk: false,
          batch: null,
        },
      }),
    ],
  );
  await sql(
    `INSERT INTO meta.automation_run_steps
       (id, organization_id, run_id, action_id, status, attempt, idempotency_key, finished_at,
        error)
     VALUES ($1, $2, $3, 'act_mail', 'failed', 1, $4, now(), $5::jsonb)`,
    [
      fakeId('stp'),
      orgId,
      refusedRunId,
      `${refusedAutomationId}:${refusedRunId}:act_mail`,
      JSON.stringify({ code: 'smtp_rejected', attempt: 1, params }),
    ],
  );

  // (5) An automation whose email body shows an uploaded image.
  imageAutomationName = `E2E image ${RUN}`;
  const withImage = await ok<{ id: string; version: number }>(
    page,
    'POST',
    `/bases/${demo.baseId}/automations`,
    { name: imageAutomationName, definition: mailDefinition('Chào bạn,') },
  );
  imageAutomationId = withImage.id;
  const markdown = await uploadEmailImage(page, imageAutomationId);
  sourceAssetId = /asset:(att_[0-9A-Za-z]{16})/u.exec(markdown)?.[1] ?? '';
  expect(sourceAssetId).not.toBe('');
  await ok(page, 'PATCH', `/automations/${imageAutomationId}`, {
    version: withImage.version,
    definition: mailDefinition(`Chào bạn,\n\n${markdown}`),
  });

  // (4) A sender identity of the seed, its name made one the API refuses since T540.
  const identities = await ok<{ items: { id: string; display_name: string }[] }>(
    page,
    'GET',
    `/orgs/${demo.orgId}/email-identities`,
  );
  const identity = identities.items[0];
  if (identity === undefined) throw new Error('The demo organization has no sender identity.');
  identityId = identity.id;
  identityName = identity.display_name;
  await context.close();
});

test.afterAll(async () => {
  if (identityId !== '') {
    await sql(`UPDATE meta.email_identities SET display_name = $2 WHERE id = $1`, [
      identityId,
      identityName,
    ]);
  }
  if (api.exitCode === null) {
    const exited = new Promise((resolve) => api.once('exit', resolve));
    api.kill('SIGTERM');
    await exited;
  }
  await smtp.close();
});

for (const setup of [DESKTOP, PHONE]) {
  test(`L2: opening the panel shows a notification realtime missed (${setup.name})`, async ({
    browser,
  }) => {
    const { context, page } = await openAs(browser, setup);
    const csp = collectCspViolations(page);
    // Realtime drops `notification.created` (the socket stays up: no reconnect refetch).
    await page.routeWebSocket(/\/ws$/u, (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        if (typeof message === 'string' && message.includes('notification.created')) return;
        socket.send(message);
      });
    });
    const countCalls: string[] = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/notifications/unread-count')) countCalls.push(request.url());
    });
    await page.goto(`/o/${demo.orgSlug}`);
    const bell = page.getByTestId('notification-bell').filter({ visible: true });
    await expect(bell).toBeVisible();
    const before = await unreadCount(page);
    await expect.poll(() => badge(page)).toBe(before);

    const title = `Missed ${setup.language} ${RUN}`;
    await notify(title);
    await expect.poll(() => unreadCount(page), { timeout: 20_000 }).toBe(before + 1);
    // Realtime is blocked: the bell has not heard of it.
    await sleep(1_500);
    expect(await badge(page)).toBe(before);

    // Open the panel with the keyboard: one refetch of the count and of the list.
    const callsBefore = countCalls.length;
    await bell.focus();
    await page.keyboard.press('Enter');
    const panel = page.getByTestId('notification-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('link', { name: title })).toBeVisible();
    await expect.poll(() => badge(page)).toBe(before + 1);
    await expect(panel.getByTestId('mark-all-read')).toBeEnabled();
    await expect(panel.getByRole('status').filter({ hasText: /\d/u })).toHaveText(
      setup.language === 'en'
        ? `${String(before + 1)} unread notification${before + 1 === 1 ? '' : 's'}`
        : `${String(before + 1)} thông báo chưa đọc`,
    );
    // No polling: nothing more while the panel stays open.
    await sleep(3_000);
    expect(countCalls.length - callsBefore).toBe(1);
    await expectNoSeriousA11yViolations(page, `notification panel after refresh (${setup.name})`);
    if (setup.viewport.width < 768) await noHorizontalScroll(page, setup.viewport.width);

    await panel.getByTestId('mark-all-read').click();
    await expect.poll(() => badge(page)).toBe(0);
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(bell).toBeFocused();
    expect(csp).toEqual([]);
    await context.close();
  });
}

for (const setup of [DESKTOP, PHONE]) {
  test(`L1 + run history tabs: refused recipients, tabs layout (${setup.name})`, async ({
    browser,
  }) => {
    const { context, page } = await openAs(browser, setup);
    const csp = collectCspViolations(page);
    await page.goto(`/b/${demo.baseId}/automations/${refusedAutomationId}/runs`);
    const title = page.getByTestId('runs-title');
    await expect(title).toContainText(`E2E refused recipients ${RUN}`);
    const tabs = page.getByTestId('automation-tab-runs');
    await expect(tabs).toHaveAttribute('aria-current', 'page');
    if (setup.viewport.width < 768) {
      // S5-review §4 #16: like the builder, the tabs leave the top bar on phones.
      await expect(page.getByTestId('automation-tabs-row')).toBeVisible();
      const bell = await page
        .getByTestId('notification-bell')
        .filter({ visible: true })
        .boundingBox();
      const tabBox = await tabs.boundingBox();
      expect(tabBox?.y ?? 0).toBeGreaterThanOrEqual((bell?.y ?? 0) + (bell?.height ?? 0));
      expect((await title.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(40);
      await noHorizontalScroll(page, setup.viewport.width);
    } else {
      await expect(page.getByTestId('automation-tabs-row')).toHaveCount(0);
    }
    await expectNoSeriousA11yViolations(page, `run history (${setup.name})`);

    // Open the run with the keyboard; the step error lists the refused recipient.
    const row = page.getByTestId(`run-open-${refusedRunId}`);
    await row.focus();
    await page.keyboard.press('Enter');
    const detail = page.getByTestId('run-detail');
    await expect(detail).toHaveAttribute('data-run-status', 'failed');
    const error = detail.getByTestId('step-error-act_mail');
    const recipient = error.getByTestId('rejected-recipient');
    await expect(recipient).toContainText(
      setup.language === 'en'
        ? 'c***@example.com · mailbox does not exist'
        : 'c***@example.com · hộp thư không tồn tại',
    );
    await expect(recipient).toContainText('550 5.1.1');
    await expect(error).toContainText(
      setup.language === 'en'
        ? 'The email server refused the message.'
        : 'Máy chủ email từ chối thư.',
    );
    await expect(detail).not.toContainText('customer@example.com');
    await expectNoSeriousA11yViolations(page, `run drawer with refused recipients (${setup.name})`);
    if (setup.viewport.width < 768) await noHorizontalScroll(page, setup.viewport.width);
    await page.keyboard.press('Escape');
    await expect(detail).toHaveCount(0);
    expect(csp).toEqual([]);
    await context.close();
  });
}

for (const setup of [DESKTOP, PHONE]) {
  test(`M7: a refused display name is flagged and fixed (${setup.name})`, async ({ browser }) => {
    const badName = `PayPal <security@paypal.com> ${setup.language}`;
    await sql(`UPDATE meta.email_identities SET display_name = $2 WHERE id = $1`, [
      identityId,
      badName,
    ]);
    const { context, page } = await openAs(browser, setup);
    const csp = collectCspViolations(page);
    await page.goto(`/o/${demo.orgSlug}/settings/email/identities`);
    const container = page.getByTestId(
      setup.viewport.width < 768 ? `identity-card-${identityId}` : `identity-row-${identityId}`,
    );
    const flag = container.getByTestId('display-name-issue');
    await expect(flag).toContainText(
      setup.language === 'en' ? 'Display name needs a fix' : 'Tên hiển thị cần sửa',
    );
    await expect(flag).toContainText(
      setup.language === 'en'
        ? 'The display name cannot contain < or >: recipients could take it for an email address.'
        : 'Tên hiển thị không được chứa < hoặc >: người nhận có thể nhầm là địa chỉ email.',
    );
    await expectNoSeriousA11yViolations(page, `flagged identity (${setup.name})`);
    if (setup.viewport.width < 768) {
      await noHorizontalScroll(page, setup.viewport.width);
      const fixBox = await flag.getByTestId('fix-display-name').boundingBox();
      expect(fixBox?.height ?? 0).toBeGreaterThanOrEqual(44);
    }

    // "Fix display name" with the keyboard: the form opens on the name, says why.
    await flag.getByTestId('fix-display-name').focus();
    await page.keyboard.press('Enter');
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByTestId('display-name-issue-note')).toBeVisible();
    const name = drawer.getByLabel(setup.language === 'en' ? 'Display name' : 'Tên hiển thị', {
      exact: true,
    });
    await expect(name).toBeFocused();
    await expect(name).toHaveAttribute('aria-invalid', 'true');
    await expectNoSeriousA11yViolations(page, `identity form with a refused name (${setup.name})`);

    // Another refused name is worded by its own reason and not sent.
    await name.fill('Hỗ trợ www.paypal.com');
    await expect(drawer).toContainText(
      setup.language === 'en'
        ? 'The display name cannot look like a web address'
        : 'Tên hiển thị không được trông giống địa chỉ web',
    );
    const fixed = `Phòng hỗ trợ ${setup.language} ${RUN}`;
    await name.fill(fixed);
    await expect(name).toHaveAttribute('aria-invalid', 'false');
    await page.keyboard.press('Enter');
    await expect(drawer).toHaveCount(0);
    await expect(container).toContainText(fixed);
    await expect(container.getByTestId('display-name-issue')).toHaveCount(0);
    const stored = await ok<{ items: { id: string; display_name_issue: string | null }[] }>(
      page,
      'GET',
      `/orgs/${demo.orgId}/email-identities`,
    );
    expect(stored.items.find((item) => item.id === identityId)?.display_name_issue).toBeNull();
    expect(csp).toEqual([]);
    await context.close();
  });
}

test('duplicate from the list: the copy opens turned off and its test email has the image', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { context, page } = await openAs(browser, DESKTOP);
  const csp = collectCspViolations(page);
  await page.goto(`/b/${demo.baseId}/automations`);
  const menu = page.getByTestId(`automation-menu-${imageAutomationId}`);
  // The row menu with the keyboard: Enter opens it, the item is reached with the arrows.
  await menu.focus();
  await page.keyboard.press('Enter');
  const item = page.getByTestId(`automation-duplicate-${imageAutomationId}`);
  await expect(item).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'automation row menu with Duplicate');
  while (!(await item.evaluate((element) => element === document.activeElement))) {
    await page.keyboard.press('ArrowDown');
  }
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/b/${demo.baseId}/automations/aut_`, 'u'));
  await expect(page).not.toHaveURL(new RegExp(imageAutomationId, 'u'));
  const copyId = /automations\/(aut_[0-9A-Za-z]{16})/u.exec(page.url())?.[1] ?? '';
  await expect(page.getByTestId('builder-title')).toContainText(imageAutomationName);
  await expect(page.getByTestId('builder-title')).toContainText(/\((copy|bản sao)\)/u);
  await expect(page.getByTestId('builder-enabled')).not.toBeChecked();
  await expect(
    page.getByText(/created\. The copy is off and will run with your permissions\./u),
  ).toBeVisible();

  // The copy has an image of its own (copied row + object), and the test email carries it.
  const copy = await ok<{ definition: { actions: { config: { body: { template: string } } }[] } }>(
    page,
    'GET',
    `/automations/${copyId}`,
  );
  const template = copy.definition.actions[0]?.config.body.template ?? '';
  const copiedAssetId = /asset:(att_[0-9A-Za-z]{16})/u.exec(template)?.[1] ?? '';
  expect(copiedAssetId).not.toBe('');
  expect(copiedAssetId).not.toBe(sourceAssetId);
  await page.locator('[data-step-button="act_mail"]').click();
  await expect(page.getByTestId('email-editor')).toBeVisible();
  // The preview first: when it arrives the pane grows, and a click aimed before
  // that lands beside the button (CI on 25dea1c6: no request sent).
  await expect(page.getByTestId('preview-subject')).toBeVisible();
  await expect(page.getByTestId('email-preview').locator('[aria-busy="true"]')).toHaveCount(0);
  const before = smtp.messages.length;
  await page.getByTestId('email-test').click();
  await expect(page.getByTestId('test-status')).toContainText(
    `Test email sent to ${WORKER_ORG.email('admin')}.`,
  );
  const mail = await lastMailTo(WORKER_ORG.email('admin'), before);
  const contentId = /^Content-ID: <([^>]+)>$/imu.exec(mail.raw)?.[1];
  expect(contentId).toBeDefined();
  expect(mail.raw).toMatch(/^Content-Disposition: inline/imu);
  expect(mail.raw).toMatch(/^Content-Type: image\/png/imu);
  expect(csp).toEqual([]);
  await context.close();
});

test('duplicate from the builder header, and a button automation explains why it cannot', async ({
  browser,
}) => {
  const { context, page } = await openAs(browser, DESKTOP_DARK);
  const csp = collectCspViolations(page);
  // The builder of the automation with the image: "Nhân bản" in the header.
  await page.goto(`/b/${demo.baseId}/automations/${imageAutomationId}`);
  const duplicate = page.getByTestId('builder-duplicate');
  await expect(duplicate).toBeEnabled();
  await expect(duplicate).toHaveAccessibleName('Nhân bản');
  await expectNoSeriousA11yViolations(page, 'builder header with Duplicate (dark, vi)');
  await duplicate.focus();
  await page.keyboard.press('Enter');
  await expect(page).not.toHaveURL(new RegExp(`${imageAutomationId}$`, 'u'));
  await expect(page.getByTestId('builder-title')).toContainText('(bản sao)');
  await expect(page.getByText(/Bản sao đang tắt và sẽ chạy bằng quyền của bạn\./u)).toBeVisible();
  await expect(page.getByTestId('builder-enabled')).not.toBeChecked();

  // The seed's button automation ("Duyệt nhanh đơn hàng"): a button runs one automation.
  const list = await ok<{ items: { id: string; name: string }[] }>(
    page,
    'GET',
    `/bases/${demo.baseId}/automations?limit=200`,
  );
  const approve = list.items.find((item) => item.name === 'Duyệt nhanh đơn hàng');
  if (approve === undefined) throw new Error('The demo button automation is missing.');
  await page.goto(`/b/${demo.baseId}/automations`);
  await page.getByTestId(`automation-menu-${approve.id}`).click();
  await page.getByTestId(`automation-duplicate-${approve.id}`).click();
  const dialog = page.getByRole('alertdialog', {
    name: 'Không nhân bản được «Duyệt nhanh đơn hàng»',
  });
  await expect(dialog.getByTestId('duplicate-failed-reason')).toContainText(
    'mỗi nút chỉ chạy một automation, nên không nhân bản được',
  );
  await expectNoSeriousA11yViolations(page, 'duplicate refused dialog (dark, vi)');
  await expect(dialog.getByRole('link', { name: 'Mở automation' })).toHaveAttribute(
    'href',
    `/b/${demo.baseId}/automations/${approve.id}`,
  );
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  const after = await ok<{ items: { name: string }[] }>(
    page,
    'GET',
    `/bases/${demo.baseId}/automations?limit=200`,
  );
  expect(after.items.filter((item) => item.name.startsWith('Duyệt nhanh đơn hàng'))).toHaveLength(
    1,
  );
  expect(csp).toEqual([]);
  await context.close();
});
