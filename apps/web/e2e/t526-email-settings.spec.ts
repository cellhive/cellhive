import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { type Browser, type BrowserContext, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { E2E_API_PORT, E2E_STACK_ENV } from './ports';
import { DEMO_PASSWORD } from './seed';
import { apiSignIn, collectCspViolations, expectNoSeriousA11yViolations, ok } from './support';
import { startFakeSmtp, type FakeSmtp } from './t526-smtp';

/**
 * T526: email settings of an organization (CONTRACTS §23.2, §23.4; boards
 * "S5 · Admin email settings", "… - trạng thái", "… - 375 px") on the demo
 * organization (CONTRACTS §9).
 *
 * The shared E2E stack has no SMTP (the "not configured" state). For the
 * configured states this spec starts its own API processes on their own
 * ports against the same PostgreSQL/Valkey (sessions are shared), each with
 * `SMTP_URL` pointing at an in-process fake SMTP server (`t526-smtp.ts`):
 * one with the right password and `EMAIL_AUTOMATION_FOOTER=org`, one with a
 * wrong password. The browser's `/api` calls are forwarded to them with
 * `page.route`.
 */

const SMTP_USER = 'mailer';
const SMTP_PASSWORD = 'e2e-smtp-secret';
const GOOD_PORT = Number(process.env['E2E_T526_API_PORT'] ?? E2E_API_PORT + 26);
const BAD_PORT = GOOD_PORT + 1;
const EDITOR_EMAIL = WORKER_ORG.email('editor');
const SIGNATURE = `**Phòng HC** · 028 1234 5678 ${String(Date.now()).slice(-5)}`;

const API_MAIN = fileURLToPath(new URL('../../api/dist/main.js', import.meta.url));

interface ExtraApi {
  readonly port: number;
  stop(): Promise<void>;
}

async function startApi(port: number, env: Record<string, string>): Promise<ExtraApi> {
  const raw = process.env[E2E_STACK_ENV];
  if (raw === undefined) throw new Error('The E2E global setup did not publish the stack env.');
  const child: ChildProcess = spawn(process.execPath, [API_MAIN], {
    env: { ...(JSON.parse(raw) as NodeJS.ProcessEnv), ...env, MODE: 'api', PORT: String(port) },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`API exited with ${String(child.exitCode)}`);
    try {
      if ((await fetch(`http://127.0.0.1:${String(port)}/healthz`)).ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`API on ${String(port)} did not start`);
    await sleep(250);
  }
  return {
    port,
    stop: async () => {
      if (child.exitCode !== null) return;
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await exited;
    },
  };
}

function smtpUrl(smtp: FakeSmtp, password: string): string {
  return `smtp://${SMTP_USER}:${encodeURIComponent(password)}@127.0.0.1:${String(smtp.port)}`;
}

/** Sends the page's `/api` calls to the API on `port` (same cookies, same database). */
async function useApi(page: Page, port: number): Promise<void> {
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    url.host = `127.0.0.1:${String(port)}`;
    const response = await route.fetch({ url: url.toString() });
    await route.fulfill({ response });
  });
}

interface Demo {
  readonly orgId: string;
  readonly orgSlug: string;
  readonly orgName: string;
}

async function signedIn(
  browser: Browser,
  options: { email?: string; viewport?: { width: number; height: number }; language?: string } = {},
): Promise<{ context: BrowserContext; page: Page; demo: Demo }> {
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1440, height: 900 },
    locale: 'en-US',
  });
  await context.addInitScript((value) => {
    window.localStorage.setItem('cellhive.language', value);
  }, options.language ?? 'en');
  const page = await context.newPage();
  await page.goto('/login');
  await apiSignIn(page, options.email ?? WORKER_ORG.email('admin'), DEMO_PASSWORD);
  const me = await ok<{ orgs: { id: string; slug: string; name: string }[] }>(page, 'GET', '/me');
  const org = me.orgs[0];
  if (org === undefined) throw new Error('The demo user belongs to no organization.');
  return { context, page, demo: { orgId: org.id, orgSlug: org.slug, orgName: org.name } };
}

const settingsPath = (demo: Demo) => `/o/${demo.orgSlug}/settings/email`;

const stack: { smtp?: FakeSmtp; good?: ExtraApi; bad?: ExtraApi } = {};

function started<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('beforeAll did not start the SMTP stack.');
  return value;
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  const smtp = await startFakeSmtp({ user: SMTP_USER, pass: SMTP_PASSWORD });
  stack.smtp = smtp;
  const common = {
    SMTP_FROM: 'Cellhive Demo <no-reply@cellhive.test>',
    SMTP_ALLOWED_FROM_DOMAINS: 'cellhive.test',
    SMTP_ALLOW_INSECURE: 'true',
  };
  [stack.good, stack.bad] = await Promise.all([
    startApi(GOOD_PORT, {
      ...common,
      SMTP_URL: smtpUrl(smtp, SMTP_PASSWORD),
      EMAIL_AUTOMATION_FOOTER: 'org',
    }),
    startApi(BAD_PORT, { ...common, SMTP_URL: smtpUrl(smtp, 'wrong-password') }),
  ]);
});

test.afterAll(async () => {
  await Promise.all([stack.good?.stop(), stack.bad?.stop()]);
  await stack.smtp?.close();
});

test('no SMTP: configuration guide, footer locked by the instance; entry on the org home', async ({
  browser,
}) => {
  const { context, page, demo } = await signedIn(browser);
  const csp = collectCspViolations(page);
  await page.goto(`/o/${demo.orgSlug}`);
  // T830: one "Organization settings" entry on the org home, then the settings nav.
  await page.getByTestId('org-settings-open').click();
  await page.getByTestId('nav-email').click();
  await expect(page).toHaveURL(new RegExp(`${settingsPath(demo)}$`, 'u'));
  await expect(page.getByRole('heading', { level: 1, name: 'Email' })).toBeVisible();
  await expect(page.getByTestId('smtp-status')).toHaveText('Not configured');
  const missing = page.getByTestId('smtp-missing');
  await expect(missing).toContainText('No email server yet.');
  for (const name of [
    'SMTP_URL',
    'SMTP_FROM',
    'SMTP_ALLOWED_FROM_DOMAINS',
    'EMAIL_AUTOMATION_FOOTER',
  ]) {
    await expect(missing).toContainText(`${name}=`);
  }
  await expect(page.getByTestId('test-connection')).toHaveCount(0);
  await expect(page.getByTestId('footer-required')).toBeDisabled();
  await expect(page.getByTestId('footer-locked')).toContainText('EMAIL_AUTOMATION_FOOTER=required');
  await expect(page.getByTestId('limit-recipients')).toHaveText('50');
  await expectNoSeriousA11yViolations(page, 'email settings without SMTP');

  // The "Organization settings" nav links the email pages (T533's page too).
  const nav = page.getByRole('navigation', { name: 'Organization settings' });
  await expect(nav.getByRole('link', { name: 'Email settings' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await nav.getByRole('link', { name: 'Sender identities' }).click();
  await expect(page).toHaveURL(new RegExp(`${settingsPath(demo)}/identities$`, 'u'));
  await expect(page.getByRole('heading', { level: 1, name: 'Sender identities' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Sender identities' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await nav.getByRole('link', { name: 'Email settings' }).click();
  await expect(page.getByTestId('smtp-status')).toBeVisible();
  expect(csp).toEqual([]);
  await context.close();
});

test('SMTP: test connection, footer policy with env org, default signature, system sender', async ({
  browser,
}) => {
  const { context, page, demo } = await signedIn(browser);
  await useApi(page, started(stack.good).port);
  // Restore the defaults afterwards: the database is shared with other specs.
  const restore = () =>
    ok(page, 'PATCH', `/orgs/${demo.orgId}/email-settings`, {
      footer_policy: 'required',
      default_signature_md: null,
      system_sender_enabled: true,
    });
  try {
    await restore();
    await page.goto(settingsPath(demo));
    await expect(page.getByTestId('smtp-status')).toHaveText('Configured');
    await expect(page.getByTestId('smtp-host')).toHaveText('***');
    await expect(page.getByTestId('smtp-from')).toHaveText(
      'Cellhive Demo <no-reply@cellhive.test>',
    );
    await expect(page.getByTestId('smtp-domains')).toContainText('cellhive.test');
    await expect(page.getByTestId('test-hint')).toContainText(
      `Sends a test email to ${WORKER_ORG.email('admin')}. 5 tests left this minute.`,
    );

    // Test connection: a real email to the caller through the fake SMTP.
    const smtp = started(stack.smtp);
    const before = smtp.messages.length;
    await page.getByTestId('test-connection').click();
    const result = page.getByTestId('test-result');
    await expect(result).toContainText('Connection works.');
    await expect(result).toContainText(`A test email was sent to ${WORKER_ORG.email('admin')}`);
    await expect(page.getByTestId('test-reply')).toContainText('250 2.0.0');
    await expect(page.getByTestId('test-hint')).toContainText('4 tests left this minute.');
    await expect.poll(() => smtp.messages.length).toBe(before + 1);
    expect(smtp.messages.at(-1)?.to).toEqual([WORKER_ORG.email('admin')]);
    await expectNoSeriousA11yViolations(page, 'email settings with SMTP after a test');

    // EMAIL_AUTOMATION_FOOTER=org: the organization decides.
    await expect(page.getByTestId('footer-org')).toContainText('EMAIL_AUTOMATION_FOOTER=org');
    await expect(page.getByTestId('footer-author_choice')).toBeEnabled();
    await page.getByTestId('footer-author_choice').check();

    // Default signature: the toolbar inserts Markdown, the preview renders it.
    const signature = page.getByTestId('signature');
    const input = signature.getByRole('textbox', { name: 'Signature' });
    await input.fill('Hi {{ name }}');
    await expect(signature).toContainText('remove the double curly braces');
    await expect(page.getByTestId('email-settings-save')).toBeDisabled();
    await input.fill(SIGNATURE);
    await expect(input).toHaveAttribute('aria-invalid', 'false');
    await input.press('End');
    await input.press('Enter');
    await signature.getByRole('button', { name: 'Insert link' }).click();
    await expect(input).toHaveValue(`${SIGNATURE}\n[link text](https://)`);
    await page.keyboard.type('https://cellhive.test');
    const preview = page.getByTestId('signature-preview');
    await expect(preview.locator('strong')).toHaveText('Phòng HC');
    await expect(preview.getByRole('link', { name: 'link text' })).toHaveAttribute(
      'href',
      'https://cellhive.test',
    );
    await expectNoSeriousA11yViolations(page, 'email settings with a draft');
    await page.getByTestId('email-settings-save').click();
    await expect(page.getByText('Email settings saved.')).toBeVisible();
    await expect(page.getByTestId('email-settings-save')).toBeDisabled();

    await page.reload();
    await expect(page.getByTestId('footer-author_choice')).toBeChecked();
    await expect(page.getByRole('textbox', { name: 'Signature' })).toHaveValue(
      `${SIGNATURE}\n[link text](https://cellhive.test)`,
    );
    const saved = await ok<{ automation: { footer_policy: string; default_signature_md: string } }>(
      page,
      'GET',
      `/orgs/${demo.orgId}/email-settings`,
    );
    expect(saved.automation).toMatchObject({
      footer_policy: 'author_choice',
      default_signature_md: `${SIGNATURE}\n[link text](https://cellhive.test)`,
    });

    // System sender: automations using it (send_email lands with T514, so the
    // count of the answer is stubbed) → confirmation before the real PATCH.
    await page.route(`**/api/v1/orgs/${demo.orgId}/email-settings`, async (route) => {
      const url = new URL(route.request().url());
      url.host = `127.0.0.1:${String(started(stack.good).port)}`;
      const response = await route.fetch({ url: url.toString() });
      const body = (await response.json()) as {
        automation: { system_sender_usage: { automations: number; enabled_automations: number } };
      };
      body.automation.system_sender_usage = { automations: 3, enabled_automations: 2 };
      await route.fulfill({ response, json: body });
    });
    await page.reload();
    await expect(page.getByTestId('system-sender-usage')).toHaveText(
      '3 automations use it (2 turned on).',
    );
    const toggle = page.getByRole('switch', {
      name: 'Allow automations to send as Cellhive Demo <no-reply@cellhive.test>',
    });
    await expect(toggle).toBeChecked();
    await toggle.click();
    const dialog = page.getByRole('alertdialog', { name: 'Turn off the system sender?' });
    await expect(dialog).toContainText('3 automations send with the system sender (2 turned on).');
    await expectNoSeriousA11yViolations(page, 'turn off the system sender dialog');
    await dialog.getByTestId('system-sender-confirm').click();
    await expect(page.getByTestId('system-sender-saved')).toHaveText(
      'Saved: the system sender is turned off.',
    );
    await expect(toggle).not.toBeChecked();
    await expect
      .poll(async () => {
        const answer = await ok<{ automation: { system_sender_enabled: boolean } }>(
          page,
          'GET',
          `/orgs/${demo.orgId}/email-settings`,
        );
        return answer.automation.system_sender_enabled;
      })
      .toBe(false);
  } finally {
    await restore();
    await context.close();
  }
});

test('SMTP with a wrong password: the sign-in failure is explained', async ({ browser }) => {
  const { context, page, demo } = await signedIn(browser);
  await useApi(page, started(stack.bad).port);
  await page.goto(settingsPath(demo));
  await expect(page.getByTestId('smtp-status')).toHaveText('Configured');
  await page.getByTestId('test-connection').click();
  const result = page.getByTestId('test-result');
  await expect(result).toContainText('The server refused to sign in.');
  await expect(result).toContainText('Check the user name and password in SMTP_URL.');
  await expect(page.getByTestId('test-reply')).toContainText('535 5.7.8');
  await expectNoSeriousA11yViolations(page, 'email settings after a failed test');
  await context.close();
});

test('375 px in Vietnamese: no horizontal scroll, save bar at the bottom', async ({ browser }) => {
  const { context, page, demo } = await signedIn(browser, {
    viewport: { width: 375, height: 812 },
    language: 'vi',
  });
  await useApi(page, started(stack.good).port);
  await page.goto(settingsPath(demo));
  await expect(page.getByTestId('smtp-status')).toHaveText('Đã cấu hình');
  await expect(page.getByRole('button', { name: 'Kiểm tra kết nối' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await expect(page.getByTestId('email-settings-bar')).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Chữ ký' }).fill('Phòng HC');
  const bar = page.getByTestId('email-settings-bar');
  await expect(bar).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Lưu thay đổi' })).toBeEnabled();
  const box = await bar.boundingBox();
  expect(box?.y ?? 0).toBeGreaterThan(700);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await expectNoSeriousA11yViolations(page, 'email settings at 375 px');
  await bar.getByRole('button', { name: 'Huỷ' }).click();
  await expect(bar).toHaveCount(0);
  await context.close();
});

test('a member who is not an admin gets the 404 screen', async ({ browser }) => {
  const { context, page, demo } = await signedIn(browser, { email: EDITOR_EMAIL });
  await page.goto(settingsPath(demo));
  await expect(page.getByText('Page not found')).toBeVisible();
  await expect(page.getByTestId('smtp')).toHaveCount(0);
  await expect(page.getByTestId('org-settings-nav')).toHaveCount(0);
  const answer = await page.evaluate(
    async (orgId) => (await fetch(`/api/v1/orgs/${orgId}/email-settings`)).status,
    demo.orgId,
  );
  expect(answer).toBe(403);
  await context.close();
});
