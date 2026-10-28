import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { type Browser, type BrowserContext, type Page, type Response } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { E2E_API_PORT, E2E_STACK_ENV } from './ports';
import { DEMO_PASSWORD } from './seed';
import { apiSignIn, collectCspViolations, expectNoSeriousA11yViolations, ok } from './support';

import type { AddressInfo } from 'node:net';

/**
 * T533: sender identities of an organization (CONTRACTS §23.3, ADR-33;
 * boards "S5 · Email identities & signatures", "… - thêm danh tính",
 * "… - xác minh", "S5 · Sender verification page" + 375 px).
 *
 * The shared E2E stack runs without SMTP (t011 checks that), so this spec
 * starts its own: an in-process SMTP server for the instance (`SMTP_URL`), one
 * with AUTH on an identity port (25/465/587/2525) for "own SMTP server", and
 * a second API process on its own port (same PostgreSQL and Valkey as the
 * stack, `SMTP_ALLOW_PRIVATE_HOSTS=true` for 127.0.0.1). The pages of the
 * admin go to that API: `/api/v1` requests of their browser context are
 * forwarded to it (`context.route`). The public verification page opened
 * from the email needs no SMTP and uses the stack as is.
 *
 * `GET /email-identities/:id/usages` is always empty until `send_email`
 * (T514) is merged: the "turn off an identity in use" check answers it with
 * two automations of the demo base.
 */

const RUN = String(Date.now()).slice(-6);
const T533_API_PORT = Number(process.env['E2E_T533_API_PORT'] ?? E2E_API_PORT + 34);
const T533_API = `http://127.0.0.1:${String(T533_API_PORT)}`;
const EDITOR_EMAIL = WORKER_ORG.email('editor');
const OUTSIDER_EMAIL = WORKER_ORG.email('out');
const MAILBOX_USER = `it${RUN}@acme.test`;
const MAILBOX_PASSWORD = `Mailbox-Secret-${RUN}`;
const WRONG_PASSWORD = `Wrong-Secret-${RUN}`;

interface ReceivedMail {
  readonly from: string;
  readonly to: readonly string[];
  readonly raw: string;
}

interface SmtpServerLike {
  readonly server: import('node:net').Server;
  listen(port: number, host: string): void;
  close(callback: () => void): void;
}

type SmtpServerClass = new (options: Record<string, unknown>) => SmtpServerLike;

const requireFromApi = createRequire(new URL('../../api/package.json', import.meta.url));

/** An in-process SMTP server (the API's own dev dependency `smtp-server`), no TLS. */
async function startSmtp(options: {
  readonly ports: readonly number[];
  readonly auth?: { readonly user: string; readonly pass: string };
}): Promise<{ port: number; messages: ReceivedMail[]; close(): Promise<void> }> {
  const { SMTPServer } = requireFromApi('smtp-server') as { SMTPServer: SmtpServerClass };
  const messages: ReceivedMail[] = [];
  for (const port of options.ports) {
    const server = new SMTPServer({
      logger: false,
      disabledCommands: options.auth === undefined ? ['STARTTLS', 'AUTH'] : ['STARTTLS'],
      authOptional: options.auth === undefined,
      allowInsecureAuth: true,
      closeTimeout: 100,
      onAuth(
        auth: { username: string; password: string },
        _session: unknown,
        callback: (error: Error | null, result?: { user: string }) => void,
      ) {
        if (auth.username === options.auth?.user && auth.password === options.auth.pass) {
          callback(null, { user: auth.username });
          return;
        }
        callback(Object.assign(new Error('Invalid credentials'), { responseCode: 535 }));
      },
      onData(
        stream: NodeJS.ReadableStream,
        session: {
          envelope: { mailFrom: { address: string } | false; rcptTo: { address: string }[] };
        },
        callback: () => void,
      ) {
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => {
          messages.push({
            from: session.envelope.mailFrom === false ? '' : session.envelope.mailFrom.address,
            to: session.envelope.rcptTo.map((rcpt) => rcpt.address),
            raw: Buffer.concat(chunks).toString('utf8'),
          });
          callback();
        });
      },
    });
    try {
      server.listen(port, '127.0.0.1');
      await Promise.race([
        once(server.server, 'listening'),
        once(server.server, 'error').then(([error]) => {
          throw error as Error;
        }),
      ]);
    } catch {
      continue;
    }
    return {
      port: (server.server.address() as AddressInfo).port,
      messages,
      close: () =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    };
  }
  throw new Error(`no free port among ${options.ports.join(', ')} for the test SMTP server`);
}

function decodeQuotedPrintable(value: string): string {
  return value
    .replace(/=\r?\n/gu, '')
    .replace(/=([0-9A-F]{2})/gu, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** Link and 6-digit code of the last verification email to `address`. */
async function verificationMail(
  messages: readonly ReceivedMail[],
  address: string,
  after = 0,
): Promise<{ link: string; code: string; mail: ReceivedMail }> {
  let mail: ReceivedMail | undefined;
  await expect
    .poll(() => {
      mail = messages.slice(after).findLast((item) => item.to.includes(address));
      return mail !== undefined;
    })
    .toBe(true);
  const body = decodeQuotedPrintable((mail as ReceivedMail).raw);
  const link = /(https?:\/\/[^\s"<>]+\/verify-sender\?token=[A-Za-z0-9_.%-]+)/u.exec(body)?.[1];
  const code = /: (\d{6})\b/u.exec(body)?.[1];
  if (link === undefined || code === undefined) throw new Error('no link/code in the email');
  return { link, code, mail: mail as ReceivedMail };
}

let instanceSmtp: Awaited<ReturnType<typeof startSmtp>>;
let mailboxSmtp: Awaited<ReturnType<typeof startSmtp>>;
let api: ChildProcess;
let org: { id: string; slug: string };
let baseId: string;

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

/** `/api/v1` of this browser context goes to the API with SMTP. */
async function useSmtpApi(context: BrowserContext): Promise<void> {
  await context.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `${T533_API}${url.pathname}${url.search}` });
    await route.fulfill({ response });
  });
}

async function openAs(
  browser: Browser,
  email = WORKER_ORG.email('admin'),
  options: { viewport?: { width: number; height: number }; language?: 'en' | 'vi' } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const language = options.language ?? 'en';
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1440, height: 900 },
    locale: language === 'vi' ? 'vi-VN' : 'en-US',
  });
  await context.addInitScript((lng) => {
    window.localStorage.setItem('cellhive.language', lng);
  }, language);
  await useSmtpApi(context);
  const page = await context.newPage();
  await page.goto('/login');
  await apiSignIn(page, email, DEMO_PASSWORD);
  return { context, page };
}

/** Every `/api/` response body the page received, to check secrets never come back. */
function collectResponses(page: Page): string[] {
  const bodies: string[] = [];
  page.on('response', (response: Response) => {
    if (!response.url().includes('/api/v1/')) return;
    void response
      .text()
      .then((text) => bodies.push(text))
      .catch(() => undefined);
  });
  return bodies;
}

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/** `u_out` of the demo (CONTRACTS §9): a member without any role. */
async function outsiderId(page: Page): Promise<string> {
  const members = await ok<{ items: { user: { id: string; email: string } }[] }>(
    page,
    'GET',
    `/orgs/${org.id}/members?offset=0&limit=1000`,
  );
  const outsider = members.items.find((member) => member.user.email === OUTSIDER_EMAIL);
  if (outsider === undefined) throw new Error('the demo has no u_out');
  return outsider.user.id;
}

const identitiesPath = () => `/o/${encodeURIComponent(org.slug)}/settings/email/identities`;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  instanceSmtp = await startSmtp({ ports: [0] });
  mailboxSmtp = await startSmtp({
    ports: [2525, 587, 465, 25],
    auth: { user: MAILBOX_USER, pass: MAILBOX_PASSWORD },
  });
  const raw = process.env[E2E_STACK_ENV];
  if (raw === undefined) throw new Error('The E2E global setup did not publish the stack env.');
  api = spawn(
    process.execPath,
    [fileURLToPath(new URL('../../api/dist/main.js', import.meta.url))],
    {
      env: {
        ...(JSON.parse(raw) as NodeJS.ProcessEnv),
        MODE: 'api',
        PORT: String(T533_API_PORT),
        SMTP_URL: `smtp://127.0.0.1:${String(instanceSmtp.port)}`,
        SMTP_FROM: 'Acme <no-reply@acme.test>',
        SMTP_ALLOW_INSECURE: 'true',
        SMTP_ALLOW_PRIVATE_HOSTS: 'true',
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    },
  );
  await waitUntilUp(`${T533_API}/healthz`, api);

  const { context, page } = await openAs(browser);
  const me = await ok<{ orgs: { id: string; slug: string }[] }>(page, 'GET', '/me');
  const first = me.orgs[0];
  if (first === undefined) throw new Error('the demo admin has no organization');
  org = first;
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
    const demo = bases.items.find((base) => base.name === 'Chăm sóc khách hàng');
    if (demo !== undefined) baseId = demo.id;
  }
  // u_out (no role) becomes a base admin, who must still not see the page.
  const roles = await ok<{ items: { id: string; kind: string }[] }>(
    page,
    'GET',
    `/bases/${baseId}/roles?offset=0&limit=100`,
  );
  const admin = roles.items.find((role) => role.kind === 'system_admin');
  const outsider = await outsiderId(page);
  if (admin === undefined) throw new Error('the demo base has no admin role');
  await ok(page, 'PUT', `/bases/${baseId}/role-assignments`, {
    principal_type: 'user',
    principal_id: outsider,
    role_id: admin.id,
  });
  await context.close();
});

test.afterAll(async ({ browser }) => {
  const { context, page } = await openAs(browser);
  await ok(page, 'DELETE', `/bases/${baseId}/role-assignments`, {
    principal_type: 'user',
    principal_id: await outsiderId(page),
  });
  await context.close();
  if (api.exitCode === null) {
    const exited = once(api, 'exit');
    api.kill('SIGTERM');
    await exited;
  }
  await Promise.all([instanceSmtp.close(), mailboxSmtp.close()]);
});

test('adds an identity, sends a verification email and verifies it by code', async ({
  browser,
}) => {
  const { context, page } = await openAs(browser);
  const csp = collectCspViolations(page);
  await page.goto(`/o/${encodeURIComponent(org.slug)}`);
  await page.getByTestId('org-settings-open').click();
  await page.getByTestId('nav-email-identities').click();
  await expect(page).toHaveURL(new RegExp(`${identitiesPath()}$`, 'u'));
  await expect(page.getByRole('heading', { name: 'Sender identities', level: 1 })).toBeVisible();
  await expect(page.getByTestId('domains-note')).toContainText('acme.test');

  const email = `hr${RUN}@acme.test`;
  await page.getByTestId('identity-add').click();
  const drawer = page.getByRole('dialog', { name: 'Add sender identity' });
  await drawer.getByLabel('Email address').fill(email);
  await drawer.getByLabel('Display name').fill('Human Resources');
  await expect(drawer.getByTestId('sender-preview')).toContainText('Sent directly');
  await expect(drawer.getByTestId('sender-preview')).toContainText(`Human Resources <${email}>`);
  await drawer
    .getByRole('textbox', { name: 'Signature' })
    .fill('**Human Resources** · 028 1234 5678');
  await expect(drawer.getByTestId('signature-preview')).toContainText('Human Resources · 028');
  await expectNoSeriousA11yViolations(page, 'add identity drawer');
  await drawer.getByRole('button', { name: 'Save and send verification email' }).click();

  const verify = page.getByRole('dialog', { name: `Verify ${email}` });
  await expect(verify.getByTestId('verify-sent')).toContainText(email);
  const { code, mail } = await verificationMail(instanceSmtp.messages, email);
  // The verification email leaves from the instance sender, never the
  // unverified display name (T528, QA S5 M7).
  expect(mail.from).toBe('no-reply@acme.test');
  const wrong = code === '000000' ? '111111' : '000000';
  await verify.getByLabel('6-digit code').fill(wrong);
  await verify.getByRole('button', { name: 'Verify', exact: true }).click();
  await expect(verify.getByRole('alert')).toContainText('Wrong code. 4 attempts left.');
  await verify.getByLabel('6-digit code').fill(code);
  await verify.getByRole('button', { name: 'Verify', exact: true }).click();
  await expect(verify.getByTestId('verify-done')).toContainText(`${email} is verified`);
  await expectNoSeriousA11yViolations(page, 'verification done');
  await verify.getByRole('button', { name: 'Close' }).last().click();

  const row = page.locator('tr', { hasText: email });
  await expect(row).toContainText('Verified');
  await expect(row).toContainText('By code');
  await expectNoSeriousA11yViolations(page, 'identity list');
  expect(csp).toEqual([]);
  await context.close();
});

test('an address of another domain is sent on behalf, and the link confirms only on the button', async ({
  browser,
}) => {
  const { context, page } = await openAs(browser);
  await page.goto(identitiesPath());
  const email = `desk${RUN}@partner.test`;
  await page.getByTestId('identity-add').click();
  const drawer = page.getByRole('dialog', { name: 'Add sender identity' });
  await drawer.getByLabel('Email address').fill(email);
  await drawer.getByLabel('Display name').fill('IT Helpdesk');
  const preview = drawer.getByTestId('sender-preview');
  await expect(preview).toContainText('Sent on behalf');
  await expect(preview).toContainText(/IT Helpdesk \((via|qua) Cellhive\) <no-reply@acme\.test>/u);
  await drawer.getByRole('button', { name: 'Save and send verification email' }).click();
  const verify = page.getByRole('dialog', { name: `Verify ${email}` });
  await expect(verify.getByTestId('verify-sent')).toBeVisible();
  await verify.getByRole('button', { name: 'Close' }).last().click();
  const row = page.locator('tr', { hasText: email });
  await expect(row).toContainText(/IT Helpdesk \((via|qua) Cellhive\)/u);
  await expect(row).toContainText('Waiting for verification');

  // The link, in a private window: opening it confirms nothing.
  const { link } = await verificationMail(instanceSmtp.messages, email);
  const incognito = await browser.newContext({ viewport: { width: 375, height: 812 } });
  await incognito.addInitScript(() => {
    window.localStorage.setItem('cellhive.language', 'en');
  });
  const visitor = await incognito.newPage();
  const csp = collectCspViolations(visitor);
  const opened = await visitor.goto(link);
  expect(opened?.headers()['referrer-policy']).toBe('no-referrer');
  expect(opened?.headers()['x-robots-tag']).toBe('noindex, nofollow');
  const card = visitor.getByTestId('verify-sender-page');
  await expect(card).toContainText(email);
  await expect(card).toContainText('IT Helpdesk');
  await expectNoHorizontalScroll(visitor);
  await expectNoSeriousA11yViolations(visitor, 'verify-sender page (375 px)');
  const identities = await ok<{ items: { email: string; status: string }[] }>(
    page,
    'GET',
    `/orgs/${org.id}/email-identities`,
  );
  expect(identities.items.find((item) => item.email === email)?.status).toBe('pending');
  await card.getByRole('button', { name: 'Confirm' }).click();
  await expect(visitor.getByTestId('verify-sender-done')).toContainText(email);
  // Used once: opening it again says so.
  await visitor.reload();
  await expect(visitor.getByTestId('verify-sender-invalid')).toBeVisible();
  expect(csp).toEqual([]);
  await incognito.close();

  await page.reload();
  await expect(page.locator('tr', { hasText: email })).toContainText('By link');
  await context.close();
});

test('own SMTP server: "Test & verify" reports a wrong password, the password never comes back', async ({
  browser,
}) => {
  const { context, page } = await openAs(browser);
  const responses = collectResponses(page);
  await page.goto(identitiesPath());
  await page.getByTestId('identity-add').click();
  const drawer = page.getByRole('dialog', { name: 'Add sender identity' });
  await drawer.getByLabel('Email address').fill(MAILBOX_USER);
  await drawer.getByLabel('Display name').fill('IT');
  await drawer.getByRole('radio', { name: /Own SMTP server/u }).check();
  await drawer.getByLabel('Host').fill('127.0.0.1');
  await drawer.getByLabel('Port').selectOption(String(mailboxSmtp.port));
  await drawer.getByRole('radio', { name: 'None' }).check();
  await expect(drawer.getByTestId('smtp-insecure')).toBeVisible();
  await drawer.getByLabel('User name').fill(MAILBOX_USER);
  await drawer.getByTestId('smtp-password').fill(WRONG_PASSWORD);
  await expect(drawer.getByText('SPF and DKIM')).toBeVisible();
  await expect(drawer.getByText('Microsoft 365 and Gmail')).toBeVisible();
  // `security = none` is refused until confirmed.
  await drawer.getByRole('button', { name: 'Save, test and verify' }).click();
  await expect(
    drawer.getByText('Confirm the unencrypted connection, or choose STARTTLS or TLS.'),
  ).toBeVisible();
  await drawer.getByLabel('I understand, use an unencrypted connection').check();
  await drawer.getByRole('button', { name: 'Save, test and verify' }).click();

  const verify = page.getByRole('dialog', { name: `Verify ${MAILBOX_USER}` });
  const failed = verify.getByTestId('verify-failed');
  await expect(failed).toContainText('The server refused the user name or password');
  await expect(failed).toContainText('535');
  await expect(failed.locator('li[data-step="auth"]')).toHaveAttribute('data-state', 'failed');
  await expect(failed.locator('li[data-step="connect"]')).toHaveAttribute('data-state', 'done');
  await expectNoSeriousA11yViolations(page, 'test & verify failed');
  await verify.getByRole('button', { name: 'Close' }).last().click();

  // Edit: the password is "Saved", never shown; a new one needs a new verification.
  await page.getByRole('button', { name: 'Actions for IT', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit IT' });
  await expect(edit.getByTestId('smtp-password-saved')).toContainText('Saved');
  await expect(edit.getByTestId('smtp-password')).toHaveCount(0);
  await edit.getByRole('button', { name: 'Change password' }).click();
  await expect(edit.getByTestId('smtp-password')).toHaveValue('');
  await edit.getByTestId('smtp-password').fill(MAILBOX_PASSWORD);
  await expect(edit.getByTestId('reverify-warning')).toBeVisible();
  const before = mailboxSmtp.messages.length;
  await edit.getByRole('button', { name: 'Save, test and verify' }).click();
  const retest = page.getByRole('dialog', { name: `Verify ${MAILBOX_USER}` });
  const sent = retest.getByTestId('verify-sent');
  await expect(sent).toContainText(MAILBOX_USER);
  await expect(sent.locator('li[data-step="tls"]')).toHaveAttribute('data-state', 'skipped');
  await expect(sent.locator('li[data-step="send"]')).toHaveAttribute('data-state', 'done');
  const { code, mail } = await verificationMail(mailboxSmtp.messages, MAILBOX_USER, before);
  expect(mail.from).toBe(MAILBOX_USER);
  await retest.getByLabel('6-digit code').fill(code);
  await retest.getByRole('button', { name: 'Verify', exact: true }).click();
  await expect(retest.getByTestId('verify-done')).toBeVisible();
  await retest.getByRole('button', { name: 'Close' }).last().click();
  await expect(page.locator('tr', { hasText: MAILBOX_USER })).toContainText('Verified');

  await page.getByRole('button', { name: 'Actions for IT', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  await expect(
    page.getByRole('dialog', { name: 'Edit IT' }).getByTestId('smtp-password-saved'),
  ).toBeVisible();
  await page.waitForTimeout(500);
  const leaked = responses.filter(
    (body) => body.includes(MAILBOX_PASSWORD) || body.includes(WRONG_PASSWORD),
  );
  expect(leaked).toEqual([]);
  expect(responses.length).toBeGreaterThan(0);
  await context.close();
});

test('turning off an identity in use lists its automations first', async ({ browser }) => {
  const { context, page } = await openAs(browser);
  await page.route('**/api/v1/email-identities/*/usages', (route) =>
    route.fulfill({
      json: {
        items: [
          { automation_id: 'aut_E2eUsage00000001', base_id: baseId, name: 'Thư mời phỏng vấn' },
          { automation_id: 'aut_E2eUsage00000002', base_id: 'bse_Hidden0000000001', name: null },
        ],
        total: 2,
      },
    }),
  );
  await page.goto(identitiesPath());
  const email = `hr${RUN}@acme.test`;
  const row = page.locator('tr', { hasText: email });
  await expect(row.getByTestId('identity-usage')).toHaveText('2');
  await row.getByRole('button', { name: /^Actions for/u }).click();
  await page.getByRole('menuitem', { name: 'Turn off' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Turn off Human Resources?' });
  const usages = confirm.getByTestId('identity-usages');
  await expect(usages).toContainText('Thư mời phỏng vấn');
  await expect(usages).toContainText('Automation of a base you cannot see');
  await expectNoSeriousA11yViolations(page, 'turn off confirmation');
  await confirm.getByTestId('identity-confirm').click();
  await expect(row).toContainText('Off');
  await row.getByRole('button', { name: /Turn back on/u }).click();
  await expect(row).toContainText('Verified');
  await context.close();
});

test('members and base admins who are not organization admins get the 404 screen', async ({
  browser,
}) => {
  for (const email of [EDITOR_EMAIL, OUTSIDER_EMAIL]) {
    const { context, page } = await openAs(browser, email);
    await page.goto(identitiesPath());
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    const answer = await page.evaluate(async (path) => {
      const response = await fetch(path, { credentials: 'include' });
      return response.status;
    }, `/api/v1/orgs/${org.id}/email-identities`);
    expect(answer).toBe(403);
    await context.close();
  }
});

test('375 px and Vietnamese: cards, a bottom sheet, no horizontal scroll', async ({ browser }) => {
  const { context, page } = await openAs(browser, WORKER_ORG.email('admin'), {
    viewport: { width: 375, height: 812 },
    language: 'vi',
  });
  await page.goto(identitiesPath());
  await expect(page.getByRole('heading', { name: 'Danh tính gửi', level: 1 })).toBeVisible();
  const card = page.getByRole('listitem').filter({ hasText: `hr${RUN}@acme.test` });
  await expect(card).toContainText('Đã xác minh');
  await expect(card).toContainText('Gửi trực tiếp');
  await expectNoHorizontalScroll(page);
  await expectNoSeriousA11yViolations(page, 'identity cards (375 px, vi)');
  await page.getByTestId('identity-add').click();
  const sheet = page.getByRole('dialog', { name: 'Thêm danh tính gửi' });
  await expect(sheet.getByRole('button', { name: 'Lưu và gửi thư xác nhận' })).toBeVisible();
  await sheet.getByRole('radio', { name: /Máy chủ SMTP riêng/u }).check();
  await expect(sheet.getByText('Microsoft 365 và Gmail')).toBeVisible();
  await expectNoHorizontalScroll(page);
  await expectNoSeriousA11yViolations(page, 'add identity sheet (375 px, vi)');
  await context.close();
});
