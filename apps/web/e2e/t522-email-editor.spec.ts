import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { type Browser, type BrowserContext, type Page } from '@playwright/test';

import { pngBytes } from './attachments';
import { expect, test, WORKER_ORG } from './fixtures';
import { E2E_API_PORT, E2E_STACK_ENV } from './ports';
import { DEMO_PASSWORD } from './seed';
import { apiSignIn, collectCspViolations, expectNoSeriousA11yViolations, ok } from './support';
import { startFakeSmtp, type CapturedMail, type FakeSmtp } from './t526-smtp';

/**
 * T522: the `send_email` editor of the builder (boards "S5 · Email template
 * editor", "… - tab và lỗi", "… - 375 px") on the demo base (CONTRACTS §9).
 *
 * The shared E2E stack has no SMTP. This spec starts its own API process on
 * its own port against the same PostgreSQL/Valkey (sessions are shared),
 * with `SMTP_URL` pointing at an in-process fake SMTP server (`t526-smtp.ts`),
 * and forwards the browser's `/api` calls to it (`context.route`). A sender
 * identity of an address outside `SMTP_ALLOWED_FROM_DOMAINS` (so it sends
 * `on_behalf`) is created and verified with the code of its email.
 */

const SMTP_USER = 'mailer';
const SMTP_PASSWORD = 'e2e-t522-secret';
const API_PORT = Number(process.env['E2E_T522_API_PORT'] ?? E2E_API_PORT + 22);
const API_URL = `http://127.0.0.1:${String(API_PORT)}`;
const API_MAIN = fileURLToPath(new URL('../../api/dist/main.js', import.meta.url));
const RUN = String(Date.now()).slice(-6);
const HR_EMAIL = `hr-${RUN}@nhansu.example`;
const HR_NAME = 'Phòng Nhân sự';
const SCRIPT_TITLE = `<script>window.__pwned = 1</script> **đậm** # ${RUN}`;

interface Field {
  id: string;
  name: string;
  type: string;
}

interface Demo {
  orgId: string;
  baseId: string;
  tickets: string;
  fields: Field[];
}

let smtp: FakeSmtp;
let api: ChildProcess;
let demo: Demo;
let recordId: string;
let automationId: string;

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
  await context.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `${API_URL}${url.pathname}${url.search}` });
    await route.fulfill({ response });
  });
  const page = await context.newPage();
  await page.goto('/login');
  await apiSignIn(page, WORKER_ORG.email('admin'), DEMO_PASSWORD);
  return { context, page };
}

async function findDemo(page: Page): Promise<Demo> {
  const me = await ok<{ orgs: { id: string }[] }>(page, 'GET', '/me');
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
      return { orgId: org.id, baseId: base.id, tickets, fields: fields.items };
    }
  }
  throw new Error('The demo base is missing.');
}

function field(name: string): Field {
  const found = demo.fields.find((item) => item.name === name);
  if (found === undefined) throw new Error(`Tickets has no field ${name}`);
  return found;
}

/** Quoted-printable parts of a raw message as UTF-8 text. */
function decodeQuotedPrintable(value: string): string {
  const binary = value
    .replace(/=\r?\n/gu, '')
    .replace(/=([0-9A-F]{2})/gu, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return Buffer.from(binary, 'latin1').toString('utf8');
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

/** The chips of an editable template (`span[data-expr]`) as their names. */
function chips(page: Page, testId: string) {
  return page.getByTestId(testId).locator('span[data-expr]');
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  smtp = await startFakeSmtp({ user: SMTP_USER, pass: SMTP_PASSWORD });
  api = await startApi({
    SMTP_URL: `smtp://${SMTP_USER}:${SMTP_PASSWORD}@127.0.0.1:${String(smtp.port)}`,
    SMTP_FROM: 'Cellhive Demo <no-reply@cellhive.test>',
    SMTP_ALLOWED_FROM_DOMAINS: 'cellhive.test',
    SMTP_ALLOW_INSECURE: 'true',
  });
  const { context, page } = await openAs(browser);
  demo = await findDemo(page);

  // A sender identity outside the allowed domains: it sends on behalf (ADR-33).
  const before = smtp.messages.length;
  const created = await ok<{ identity: { id: string; mode: string } }>(
    page,
    'POST',
    `/orgs/${demo.orgId}/email-identities`,
    {
      email: HR_EMAIL,
      display_name: HR_NAME,
      transport: 'system',
      signature_md: `**${HR_NAME}** · 028 3822 1234`,
    },
  );
  expect(created.identity.mode).toBe('on_behalf');
  const verification = decodeQuotedPrintable((await lastMailTo(HR_EMAIL, before)).raw);
  const code = /: (\d{6})\b/u.exec(verification)?.[1];
  if (code === undefined) throw new Error('no code in the verification email');
  await ok(page, 'POST', `/email-identities/${created.identity.id}/verify-code`, { code });

  // A ticket whose title holds markup and Markdown: it must stay text.
  const records = await ok<{ records: { id: string }[] }>(
    page,
    'POST',
    `/tables/${demo.tickets}/records?field_key_type=name`,
    { records: [{ fields: { 'Tiêu đề': SCRIPT_TITLE } }] },
  );
  recordId = records.records[0]?.id ?? '';

  // The automation: an email step to fill in the editor (turned off: it never runs).
  const automation = await ok<{ id: string }>(page, 'POST', `/bases/${demo.baseId}/automations`, {
    name: `E2E email ${RUN}`,
    definition: {
      trigger: { type: 'record.created', table_id: demo.tickets },
      actions: [
        {
          id: 'act_1',
          type: 'send_email',
          config: {
            to: [{ field: field('Phụ trách').id }],
            subject: { template: 'Ticket' },
            body: { format: 'markdown', template: 'Chào bạn,' },
          },
        },
      ],
    },
  });
  automationId = automation.id;
  await context.close();
});

test.afterAll(async () => {
  if (api.exitCode === null) {
    const exited = new Promise((resolve) => api.once('exit', resolve));
    api.kill('SIGTERM');
    await exited;
  }
  await smtp.close();
});

test('composes with chips and the toolbar, previews in a sandbox, sends a test', async ({
  browser,
}) => {
  const { context, page } = await openAs(browser);
  const csp = collectCspViolations(page);
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await page.goto(`/b/${demo.baseId}/automations/${automationId}`);
  await page.locator('[data-step-button="act_1"]').click();
  const editor = page.getByTestId('email-editor');
  await expect(editor.getByRole('heading', { name: 'Step 1 · Send email' })).toBeFocused();

  // Subject: "Ticket " + the chip "Tiêu đề" from the value menu.
  const subject = page.getByTestId('email-subject');
  await subject.click();
  await page.keyboard.press('End');
  await page.keyboard.type(' {{');
  const picker = page.getByTestId('value-picker');
  await picker.getByRole('combobox').fill('Tiêu đề');
  await page.keyboard.press('Enter');
  await expect(chips(page, 'email-subject')).toHaveText(['Tiêu đề']);

  // Body: a bulleted line with "Phụ trách", then bold text — all with the keyboard.
  const body = page.getByTestId('email-body');
  await body.click();
  await page.keyboard.press('End');
  await page.getByTestId('md-bullet').click();
  await page.keyboard.type('Người phụ trách: ');
  await page.getByTestId('md-insert-value').click();
  await picker.getByRole('combobox').fill('Phụ trách');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+b');
  await page.keyboard.type('Khẩn');
  // Past the closing `**`.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(chips(page, 'email-body')).toHaveText(['Phụ trách']);
  await expect(page.getByTestId('md-length')).toContainText('/ 20,000');

  // A line with the title; a chip too many goes whole with Backspace, the focus stays.
  await page.keyboard.press('Enter');
  for (let index = 0; index < 2; index += 1) {
    await page.getByTestId('md-insert-value').click();
    await picker.getByRole('combobox').fill('Tiêu đề');
    await page.keyboard.press('Enter');
  }
  await expect(chips(page, 'email-body')).toHaveCount(3);
  await page.keyboard.press('Backspace');
  await expect(chips(page, 'email-body')).toHaveText(['Phụ trách', 'Tiêu đề']);
  await expect(body).toBeFocused();

  // An image uploaded for this automation, on a line of its own (T534). Its name has
  // brackets, which the alt text cannot keep through the chip editor: they become ( ).
  // The menu also offers the images of the ticket's attachment field.
  await page.getByTestId('email-image-insert').click();
  const imageMenu = page.getByRole('menu', { name: 'Insert image' });
  await expect(imageMenu.getByRole('menuitem', { name: 'Tệp đính kèm' })).toBeVisible();
  const chooser = page.waitForEvent('filechooser');
  await imageMenu.getByRole('menuitem', { name: 'Upload an image' }).click();
  await (
    await chooser
  ).setFiles({
    name: 'banner [e2e].png',
    mimeType: 'image/png',
    buffer: pngBytes([0, 120, 215], 240, 80),
  });
  await expect(page.getByTestId('email-image-status')).toContainText('banner [e2e].png inserted.');
  await expect(body).toContainText(/!\[banner \(e2e\)\]\(asset:att_[0-9A-Za-z]{16} =240\)/u);

  // The system sender: "None" is locked and says why.
  await expect(editor.getByRole('radio', { name: 'None' })).toBeDisabled();
  await expect(editor).toContainText('Emails from the system sender always have a footer.');

  // Preview on the ticket with markup in its title: text in a frame without scripts.
  const imageLoaded = page.waitForResponse(
    (response) =>
      response.url().includes('/api/v1/storage/local/') &&
      response.request().resourceType() === 'image',
  );
  await page.getByTestId('preview-record-search').fill(RUN);
  await expect(page.getByTestId('preview-record')).toHaveValue(recordId);
  const frame = page.frameLocator('[data-testid="email-preview-frame"]');
  await expect(frame.locator('body')).toContainText('<script>window.__pwned = 1</script>');
  await expect(frame.locator('body')).toContainText(`**đậm** # ${RUN}`);
  await expect(frame.locator('li')).toContainText('Người phụ trách:');
  await expect(frame.locator('strong').first()).toHaveText('Khẩn');
  await expect(page.getByTestId('email-preview-frame')).toHaveAttribute('sandbox', '');
  // The inline image shows through the viewer's signed URL; the frame loads only its origin.
  const origin = new URL(page.url()).origin;
  const image = frame.locator('img[alt="banner (e2e)"]');
  await expect(image).toHaveAttribute('src', new RegExp(`^${origin}/api/v1/storage/local/`, 'u'));
  expect((await imageLoaded).status()).toBe(200);
  const srcdoc = (await page.getByTestId('email-preview-frame').getAttribute('srcdoc')) ?? '';
  expect(srcdoc).toContain(`img-src ${origin};`);
  expect(srcdoc).not.toContain('cid:');
  await expect(page.getByTestId('preview-subject')).toContainText(`Ticket ${SCRIPT_TITLE}`);
  await page.screenshot({ path: 'test-results/t522-email-editor.png', fullPage: true });
  expect(await page.evaluate(() => (window as { __pwned?: number }).__pwned)).toBeUndefined();

  // The text part.
  await page.getByRole('tab', { name: 'Text' }).click();
  await expect(page.getByTestId('preview-text')).toContainText('- Người phụ trách:');

  // "Send a test to me": through the fake SMTP, with the required headers.
  const before = smtp.messages.length;
  await page.getByTestId('email-test').click();
  await expect(page.getByTestId('test-status')).toContainText(
    `Test email sent to ${WORKER_ORG.email('admin')}.`,
  );
  await expect(page.getByTestId('test-left')).toContainText('4 / 5 left this minute');
  const test1 = await lastMailTo(WORKER_ORG.email('admin'), before);
  expect(test1.raw).toContain('Auto-Submitted: auto-generated');
  expect(test1.raw).toMatch(new RegExp(`^X-Cellhive-Automation: ${automationId}$`, 'imu'));
  expect(decodeQuotedPrintable(test1.raw)).toContain('Khẩn');
  // The image travels inside the email: an inline part referenced by `cid:`.
  const contentId = /^Content-ID: <([^>]+)>$/imu.exec(test1.raw)?.[1];
  expect(contentId).toBeDefined();
  expect(test1.raw).toMatch(/^Content-Disposition: inline/imu);
  expect(decodeQuotedPrintable(test1.raw)).toContain(`src="cid:${contentId ?? ''}"`);

  // HR sends on behalf: the Headers tab shows "(qua/via Cellhive)" and the Reply-To.
  await editor
    .getByTestId(/^sender-eid_/u)
    .filter({ hasText: HR_EMAIL })
    .click();
  await expect(page.getByTestId('sender-shows')).toContainText(`${HR_NAME} (`);
  await expect(page.getByTestId('sender-shows')).toContainText(HR_EMAIL);
  await page.getByRole('tab', { name: 'Headers' }).click();
  const headers = page.getByTestId('preview-headers');
  await expect(headers).toContainText(/Cellhive\) <no-reply@cellhive\.test>/u);
  await expect(headers).toContainText(HR_EMAIL);
  await expect(editor).toContainText('Emails sent on behalf always have a footer.');

  // Save, reload: the chips come back by name.
  await page.getByTestId('builder-save').click();
  await expect(page.getByTestId('builder-unsaved')).toHaveCount(0);
  await page.reload();
  await page.locator('[data-step-button="act_1"]').click();
  await expect(chips(page, 'email-subject')).toHaveText(['Tiêu đề']);
  await expect(chips(page, 'email-body')).toHaveText(['Phụ trách', 'Tiêu đề']);
  // axe cannot run inside the sandboxed frame (no scripts there): check the page on the Text tab.
  await page.getByRole('tab', { name: 'Text' }).click();
  await expect(page.getByTestId('preview-text')).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'email editor');
  expect(dialogs).toEqual([]);
  expect(csp).toEqual([]);
  await context.close();
});

test('a renamed field renames its chip; REGEX in a formula is refused with a way out', async ({
  browser,
}) => {
  const { context, page } = await openAs(browser);
  const title = field('Tiêu đề');
  const renamed = `Tiêu đề ${RUN}`;
  await ok(page, 'PATCH', `/fields/${title.id}`, { name: renamed });
  try {
    await page.goto(`/b/${demo.baseId}/automations/${automationId}`);
    await page.locator('[data-step-button="act_1"]').click();
    await expect(chips(page, 'email-subject')).toHaveText([renamed]);
  } finally {
    await ok(page, 'PATCH', `/fields/${title.id}`, { name: title.name });
  }
  await page.getByTestId('md-formula').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByTestId('expression-input').fill(`REGEXMATCH([${title.name}], "a")`);
  await dialog.getByRole('button', { name: 'Insert' }).click();
  await expect(dialog.getByTestId('expression-regex-hint')).toContainText(
    'REGEXMATCH cannot be used in an automation',
  );
  await context.close();
});

test('phones see the email step read only (375 px, vi)', async ({ browser }) => {
  const { context, page } = await openAs(browser, {
    viewport: { width: 375, height: 812 },
    language: 'vi',
  });
  await page.goto(`/b/${demo.baseId}/automations/${automationId}`);
  const card = page.getByTestId('step-act_1');
  await expect(card).toContainText('Gửi email');
  await expect(card).toContainText(`Từ: ${HR_NAME} <${HR_EMAIL}>`);
  await expect(card).toContainText('Tới:');
  await expect(card).toContainText('Footer tối giản · Kèm chữ ký');
  await expect(page.getByTestId('email-editor')).toHaveCount(0);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await expectNoSeriousA11yViolations(page, 'email step at 375 px');
  await context.close();
});
