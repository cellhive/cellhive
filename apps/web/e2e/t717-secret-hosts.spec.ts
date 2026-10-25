import { createRequire } from 'node:module';

import { type Browser, type BrowserContext, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { E2E_STACK_ENV } from './ports';
import { DEMO_PASSWORD } from './seed';
import { apiSignIn, collectCspViolations, expectNoSeriousA11yViolations, ok } from './support';

/**
 * T717: allowed hosts of HTTP secrets (CONTRACTS §24, ADR-36 §4; FRONTEND
 * §13.2, §15.5) on the demo data of CONTRACTS §9, as u_admin (org owner):
 *
 * - keyboard only: a header secret without a host is refused; `*.crm.test`
 *   becomes a chip (an IP stays typed with the reason; Backspace/Delete
 *   remove a chip) and the secret saves, listed with its hosts;
 * - secrets stored before allowed hosts existed (made like migration 0051
 *   does: empty list + `legacy_hosts_until`) show "Set hosts before <date>"
 *   or "Sending stopped", and the banner at the top of the page;
 * - in the builder, choosing that secret for an `http_request` whose URL is
 *   `https://attacker.test/` warns before saving; saving puts the server's
 *   `SECRET_HOST_NOT_ALLOWED` on the secret field;
 * - axe on every state; Vietnamese at 375 px dark without horizontal scroll.
 *
 * `afterAll` deletes the automation and the secrets it made.
 */

const RUN = String(Date.now()).slice(-6);
const CRM_SECRET = `T717 CRM ${RUN}`;
const PENDING_SECRET = `T717 cũ ${RUN}`;
const STOPPED_SECRET = `T717 hết hạn ${RUN}`;

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

interface Demo {
  orgId: string;
  orgSlug: string;
  baseId: string;
  ticketsId: string;
}

let demo: Demo;
let cookies: Awaited<ReturnType<BrowserContext['cookies']>> | null = null;
const made = { secrets: [] as string[], automation: '' };

async function openAs(
  browser: Browser,
  options: {
    viewport?: { width: number; height: number };
    language?: 'en' | 'vi';
    colorScheme?: 'light' | 'dark';
  } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1440, height: 900 },
    locale: 'en-US',
    colorScheme: options.colorScheme ?? 'light',
  });
  await context.addInitScript((value) => {
    window.localStorage.setItem('cellhive.language', value);
  }, options.language ?? 'en');
  const page = await context.newPage();
  await page.goto('/login');
  if (cookies === null) {
    await apiSignIn(page, WORKER_ORG.email('admin'), DEMO_PASSWORD);
    cookies = await context.cookies();
  } else {
    await context.addCookies(cookies);
  }
  return { context, page };
}

async function findDemo(page: Page): Promise<Demo> {
  const me = await ok<{ orgs: { id: string; slug: string }[] }>(page, 'GET', '/me');
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
      const ticketsId = tables.items.find((table) => table.name === 'Tickets')?.id ?? '';
      return { orgId: org.id, orgSlug: org.slug, baseId: base.id, ticketsId };
    }
  }
  throw new Error('The demo base is missing.');
}

/** An HTTP secret stored before allowed hosts existed, as migration 0051 leaves it. */
async function legacySecret(page: Page, name: string, deadline: string): Promise<string> {
  const created = await ok<{ id: string }>(page, 'POST', `/orgs/${demo.orgId}/secrets`, {
    kind: 'http_header',
    name,
    value: 'Bearer t717-legacy',
    allowed_hosts: ['placeholder.t717.test'],
  });
  await sql(
    `UPDATE meta.secrets SET allowed_hosts = '{}', legacy_hosts_until = now() + $2::interval
      WHERE id = $1`,
    [created.id, deadline],
  );
  made.secrets.push(created.id);
  return created.id;
}

function noHorizontalScroll(page: Page, width: number) {
  return expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(width);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  const { context, page } = await openAs(browser);
  demo = await findDemo(page);
  await legacySecret(page, PENDING_SECRET, '30 days');
  await legacySecret(page, STOPPED_SECRET, '-1 day');
  await context.close();
});

test.afterAll(async ({ browser }) => {
  const { context, page } = await openAs(browser);
  if (made.automation !== '') await ok(page, 'DELETE', `/automations/${made.automation}`);
  const list = await ok<{ items: { id: string; name: string }[] }>(
    page,
    'GET',
    `/orgs/${demo.orgId}/secrets`,
  );
  const ours = list.items.filter((item) => item.name.startsWith('T717 '));
  for (const item of ours) await ok(page, 'DELETE', `/secrets/${item.id}`);
  await context.close();
});

test('a secret without a host is refused; *.crm.test as a chip saves (keyboard only)', async ({
  browser,
}) => {
  const { context, page } = await openAs(browser);
  const csp = collectCspViolations(page);
  await page.goto(`/o/${demo.orgSlug}/settings/integrations`);
  const secrets = page.getByTestId('http-secrets-section');
  await secrets.getByTestId('secret-add').focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Add an HTTP secret' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('secret-allowed-hosts-rules')).toContainText(
    'not example.com itself',
  );
  await dialog.getByTestId('secret-name').focus();
  await page.keyboard.type(CRM_SECRET);
  await dialog.getByTestId('secret-value').focus();
  await page.keyboard.type('Bearer t717-crm');
  await page.keyboard.press('Enter');
  const hosts = dialog.getByTestId('secret-allowed-hosts');
  await expect(dialog.getByText('List at least one host.')).toBeVisible();
  await expect(hosts).toHaveAttribute('aria-invalid', 'true');
  await expectNoSeriousA11yViolations(page, 'secret without a host');

  // An IP address is not a host: it stays typed with the reason.
  await hosts.focus();
  await page.keyboard.type('10.0.0.1');
  await page.keyboard.press('Enter');
  await expect(dialog.getByTestId('secret-allowed-hosts-problem')).toContainText(
    'Not a host: 10.0.0.1.',
  );
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
  // Two chips; Backspace moves to the last, Delete removes it.
  await page.keyboard.type('*.CRM.test,api.other.test');
  await page.keyboard.press('Enter');
  const chips = dialog.getByTestId('secret-allowed-host-chip');
  await expect(chips).toHaveText(['*.crm.test', 'api.other.test']);
  await page.keyboard.press('Backspace');
  await expect(dialog.getByRole('button', { name: 'Remove api.other.test' })).toBeFocused();
  await page.keyboard.press('Delete');
  await expect(chips).toHaveText(['*.crm.test']);
  await expect(dialog.getByRole('status').filter({ hasText: 'Removed' })).toContainText(
    'Removed api.other.test.',
  );
  await expect(dialog.getByTestId('secret-allowed-hosts-count')).toHaveText('1 / 20 hosts');
  await expectNoSeriousA11yViolations(page, 'secret with a host chip');
  await dialog.getByTestId('secret-save').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText(`Secret ${CRM_SECRET} added.`)).toBeVisible();
  const row = secrets.getByTestId('http-secret-row').filter({ hasText: CRM_SECRET });
  await expect(row.getByTestId('http-secret-hosts')).toHaveText('Sent only to: *.crm.test');
  await expect(row.getByTestId('http-secret-legacy')).toHaveCount(0);
  const list = await ok<{ items: { id: string; name: string; allowed_hosts: string[] }[] }>(
    page,
    'GET',
    `/orgs/${demo.orgId}/secrets`,
  );
  const saved = list.items.find((item) => item.name === CRM_SECRET);
  expect(saved?.allowed_hosts).toEqual(['*.crm.test']);
  made.secrets.push(saved?.id ?? '');
  expect(csp).toEqual([]);
  await context.close();
});

test('secrets stored before allowed hosts show their deadline, and a banner on top', async ({
  browser,
}) => {
  const { context, page } = await openAs(browser);
  await page.goto(`/o/${demo.orgSlug}/settings/integrations`);
  const banner = page.getByTestId('legacy-hosts-banner');
  await expect(banner).toContainText(/HTTP secrets? (has|have) no allowed hosts/u);
  await expect(banner).toContainText('already stopped sending');
  const pending = page.getByTestId('http-secret-row').filter({ hasText: PENDING_SECRET });
  await expect(pending.getByTestId('http-secret-legacy')).toContainText('Set hosts before');
  const stopped = page.getByTestId('http-secret-row').filter({ hasText: STOPPED_SECRET });
  await expect(stopped.getByTestId('http-secret-legacy')).toContainText('Sending stopped');
  await expectNoSeriousA11yViolations(page, 'legacy secrets and banner');

  // "Set hosts" opens the form; a host ends the transition period.
  await stopped.getByRole('button', { name: `Set allowed hosts of ${STOPPED_SECRET}` }).click();
  const dialog = page.getByRole('dialog', { name: `Change ${STOPPED_SECRET}` });
  await expect(dialog).toContainText('This secret has no allowed hosts yet');
  await dialog.getByTestId('secret-allowed-hosts').fill('hooks.t717.test');
  await dialog.getByTestId('secret-save').click();
  await expect(page.getByText(`Secret ${STOPPED_SECRET} saved.`)).toBeVisible();
  await expect(stopped.getByTestId('http-secret-legacy')).toHaveCount(0);
  await expect(stopped.getByTestId('http-secret-hosts')).toHaveText(
    'Sent only to: hooks.t717.test',
  );
  const rows = await sql('SELECT legacy_hosts_until FROM meta.secrets WHERE name = $1', [
    STOPPED_SECRET,
  ]);
  expect(rows[0]?.['legacy_hosts_until']).toBeNull();
  await context.close();
});

test('the builder warns before saving a secret with https://attacker.test/, then the server error lands on the secret field', async ({
  browser,
}) => {
  const { context, page } = await openAs(browser);
  const created = await ok<{ id: string }>(page, 'POST', `/bases/${demo.baseId}/automations`, {
    name: `T717 Gửi CRM ${RUN}`,
    definition: {
      trigger: { type: 'record.created', table_id: demo.ticketsId },
      actions: [
        {
          id: 'act_1',
          type: 'http_request',
          config: { method: 'POST', url: { literal: 'https://attacker.test/' } },
        },
      ],
    },
  });
  made.automation = created.id;
  await page.goto(`/b/${demo.baseId}/automations/${created.id}`);
  await page.getByTestId('step-act_1').getByRole('button').first().click();
  const panel = page.getByTestId('config-panel');
  const editor = panel.getByTestId('http-request-editor');
  await editor.getByText('Header with a secret', { exact: true }).click();
  await editor.getByTestId('http-auth-secret').selectOption({ label: CRM_SECRET });
  const warning = editor.getByTestId('http-auth-secret-hosts');
  await expect(warning).toHaveAttribute('data-verdict', 'not_listed');
  await expect(warning).toContainText('attacker.test is not an allowed host of this secret');
  await expect(warning).toContainText('Allowed hosts: *.crm.test.');
  await expectNoSeriousA11yViolations(page, 'builder warning before saving');

  await page.keyboard.press('Control+s');
  const field = editor.getByTestId('http-auth-secret');
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(
    editor.getByText('This secret may not be sent to the host of this URL', { exact: false }),
  ).toBeVisible();
  await expect(page.getByTestId('issue-summary')).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'builder server error on the secret');

  // An allowed host: the warning gives way to the hosts.
  const url = editor.getByRole('textbox', { name: 'URL' });
  await url.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('https://api.crm.test/orders');
  await expect(warning).toHaveAttribute('data-verdict', 'allowed');
  await page.keyboard.press('Control+s');
  await expect(page.getByText(`Saved “T717 Gửi CRM ${RUN}”.`)).toBeVisible();
  await context.close();
});

test('Vietnamese at 375 px, dark: labels, banner and the chip input without horizontal scroll', async ({
  browser,
}) => {
  const { context, page } = await openAs(browser, {
    viewport: { width: 375, height: 812 },
    language: 'vi',
    colorScheme: 'dark',
  });
  await page.goto(`/o/${demo.orgSlug}/settings/integrations`);
  await expect(page.getByTestId('legacy-hosts-banner')).toContainText('chưa có host được phép');
  const pending = page.getByTestId('http-secret-row').filter({ hasText: PENDING_SECRET });
  await expect(pending.getByTestId('http-secret-legacy')).toContainText('Cần đặt host trước');
  await noHorizontalScroll(page, 375);
  await expectNoSeriousA11yViolations(page, 'integrations at 375 px (vi, dark)');
  await pending.getByRole('button', { name: `Đặt host được phép cho ${PENDING_SECRET}` }).click();
  const dialog = page.getByRole('dialog', { name: `Sửa ${PENDING_SECRET}` });
  await expect(dialog.getByTestId('secret-allowed-hosts-rules')).toContainText(
    'không gồm chính example.com',
  );
  await dialog.getByTestId('secret-allowed-hosts').focus();
  await page.keyboard.type('api.crm.test');
  await page.keyboard.press('Enter');
  await expect(dialog.getByTestId('secret-allowed-host-chip')).toHaveText(['api.crm.test']);
  await noHorizontalScroll(page, 375);
  await expectNoSeriousA11yViolations(page, 'secret form at 375 px (vi, dark)');
  await context.close();
});
