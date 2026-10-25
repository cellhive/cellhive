import { readFile } from 'node:fs/promises';

import {
  type Browser,
  type BrowserContext,
  type Page,
  type PlaywrightWorkerArgs,
} from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { E2E_WEB_URL } from './ports';
import { DEMO_PASSWORD } from './seed';
import { api, apiSignIn, collectCspViolations, expectNoSeriousA11yViolations, ok } from './support';

/**
 * T716: the audit log viewer (FRONTEND §15, §17, CONTRACTS §11.4) on the
 * demo data of CONTRACTS §9, with two bases of its own made through the API
 * in a workspace of its own: B ("Orders", u_sales1 Editor, u_sales2 Admin)
 * and B2 (one table, u_sales2 has no role).
 *
 * - u_sales1 changes `amount` of r1 in the UI's way (session) and through an
 *   API token of theirs;
 * - u_admin (org owner) filters person = u_sales1 + group "Records" → the
 *   two changes; the token's one reads "via API token <name>"; the details
 *   drawer shows the `amount` diff by name; keyboard on the table, Escape
 *   returns the focus;
 * - u_sales2 (admin of B, not an org admin) on B's page sees only B's
 *   entries, the token masked ("via an API token"), and gets 404 on the
 *   organization page;
 * - "Export CSV" → job → the file downloads with the documented columns;
 * - u_editor on the demo base's audit page → 404 (API too);
 * - axe on every state; Vietnamese at 375 px (cards, no horizontal scroll).
 *
 * `afterAll` revokes the token and moves both bases to the trash.
 */

const RUN = Date.now().toString(36);
const SALES1_EMAIL = WORKER_ORG.email('sales1');
const SALES2_EMAIL = WORKER_ORG.email('sales2');
const EDITOR_EMAIL = WORKER_ORG.email('editor');
const SALES1_NAME = 'Phạm Ngọc Lan';
const TOKEN_NAME = `Đồng bộ T716 ${RUN}`;
const B2_TABLE = `Chỉ B2 ${RUN}`;
const CSV_COLUMNS =
  'id,created_at,actor_type,actor_id,actor_name,via,action,entity_type,entity_id,base_id,' +
  'table_id,batch_id,request_id,before,after,ip,user_agent';

interface Fixture {
  orgId: string;
  orgSlug: string;
  baseId: string;
  base2Id: string;
  orders: string;
  amount: string;
  r1: string;
  sales1: string;
  tokenId: string | undefined;
  demoBaseId: string;
}

const fx = {} as Fixture;

type Cookies = Awaited<ReturnType<BrowserContext['cookies']>>;
const cookies: Record<string, Cookies> = {};

/** A new context signed in as `email` (once per user and spec: 20 sign-ins a minute per IP). */
async function openAs(
  browser: Browser,
  email: string,
  options: { viewport?: { width: number; height: number }; language?: 'en' | 'vi' } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1440, height: 900 },
    locale: 'en-US',
  });
  await context.addInitScript((value) => {
    window.localStorage.setItem('cellhive.language', value);
  }, options.language ?? 'en');
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

interface Principal {
  principal_type: string;
  principal_id: string;
  email: string | null;
}

async function buildFixture(page: Page): Promise<void> {
  const me = await ok<{ orgs: { id: string; slug: string }[] }>(page, 'GET', '/me');
  const org = me.orgs[0];
  fx.orgId = org?.id ?? '';
  fx.orgSlug = org?.slug ?? '';
  const workspaces = await ok<{ items: { id: string }[] }>(
    page,
    'GET',
    `/orgs/${fx.orgId}/workspaces`,
  );
  for (const workspace of workspaces.items) {
    const bases = await ok<{ items: { id: string; name: string }[] }>(
      page,
      'GET',
      `/workspaces/${workspace.id}/bases`,
    );
    const demo = bases.items.find((item) => item.name === 'Chăm sóc khách hàng');
    if (demo !== undefined) fx.demoBaseId = demo.id;
  }
  const workspace = await ok<{ id: string }>(page, 'POST', `/orgs/${fx.orgId}/workspaces`, {
    name: `T716 ${RUN}`,
  });
  const base = await ok<{ id: string }>(page, 'POST', `/workspaces/${workspace.id}/bases`, {
    name: `Nhật ký T716 ${RUN}`,
  });
  const base2 = await ok<{ id: string }>(page, 'POST', `/workspaces/${workspace.id}/bases`, {
    name: `Base khác T716 ${RUN}`,
  });
  fx.baseId = base.id;
  fx.base2Id = base2.id;
  const orders = await ok<{ id: string; primary_field_id: string }>(
    page,
    'POST',
    `/bases/${base.id}/tables`,
    { name: 'Orders', primary_field_name: 'title' },
  );
  await ok(page, 'POST', `/bases/${base2.id}/tables`, {
    name: B2_TABLE,
    primary_field_name: 'title',
  });
  fx.orders = orders.id;
  fx.amount = (
    await ok<{ id: string }>(page, 'POST', `/tables/${orders.id}/fields`, {
      name: 'amount',
      type: 'number',
      options: {},
    })
  ).id;
  const rows = await ok<{ records: { id: string }[] }>(
    page,
    'POST',
    `/tables/${orders.id}/records?field_key_type=id`,
    { records: [{ fields: { [orders.primary_field_id]: 'r1', [fx.amount]: 100 } }] },
  );
  fx.r1 = rows.records[0]?.id ?? '';

  const principals = await ok<{ items: Principal[] }>(
    page,
    'GET',
    `/bases/${base.id}/principals?limit=200`,
  );
  const user = (email: string) =>
    principals.items.find((item) => item.email === email)?.principal_id ?? '';
  fx.sales1 = user(SALES1_EMAIL);
  const roles = await ok<{ items: { id: string; kind: string }[] }>(
    page,
    'GET',
    `/bases/${base.id}/roles`,
  );
  const role = (kind: string) => roles.items.find((item) => item.kind === kind)?.id ?? '';
  await ok(page, 'PUT', `/bases/${base.id}/role-assignments`, {
    principal_type: 'user',
    principal_id: fx.sales1,
    role_id: role('system_editor'),
  });
  await ok(page, 'PUT', `/bases/${base.id}/role-assignments`, {
    principal_type: 'user',
    principal_id: user(SALES2_EMAIL),
    role_id: role('system_admin'),
  });
}

/** u_sales1 changes r1.amount with the session (100 → 150), then with an API token (→ 175). */
async function salesChanges(
  browser: Browser,
  playwright: PlaywrightWorkerArgs['playwright'],
): Promise<void> {
  const { context, page } = await openAs(browser, SALES1_EMAIL);
  await ok(page, 'PATCH', `/tables/${fx.orders}/records/${fx.r1}?field_key_type=id`, {
    fields: { [fx.amount]: 150 },
  });
  const created = await ok<{ id: string; token: string }>(
    page,
    'POST',
    `/orgs/${fx.orgId}/me/api-tokens`,
    {
      name: TOKEN_NAME,
      scopes: ['records:read', 'records:write'],
      base_ids: [fx.baseId],
      expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    },
  );
  fx.tokenId = created.id;
  // Only the Bearer token (no cookie, no CSRF), like an integration.
  await context.close();
  const integration = await playwright.request.newContext({ baseURL: E2E_WEB_URL });
  const bearer = await integration.fetch(
    `/api/v1/tables/${fx.orders}/records/${fx.r1}?field_key_type=id`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${created.token}`, 'Content-Type': 'application/json' },
      data: { fields: { [fx.amount]: 175 } },
    },
  );
  expect(bearer.status(), await bearer.text()).toBe(200);
  await integration.dispose();
}

function noHorizontalScroll(page: Page, width: number) {
  return expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(width);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser, playwright }) => {
  const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
  await buildFixture(page);
  await context.close();
  await salesChanges(browser, playwright);
});

test.afterAll(async ({ browser }) => {
  const sales = await openAs(browser, SALES1_EMAIL);
  if (fx.tokenId !== undefined) await api(sales.page, 'DELETE', `/api-tokens/${fx.tokenId}`);
  await sales.context.close();
  const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
  await api(page, 'DELETE', `/bases/${fx.baseId}`);
  await api(page, 'DELETE', `/bases/${fx.base2Id}`);
  await context.close();
});

test('u_admin filters person + "Records": token name, diff by field name, keyboard', async ({
  browser,
}) => {
  const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
  const csp = collectCspViolations(page);
  await page.goto(`/o/${fx.orgSlug}/settings/email`);
  // The entry in the organization settings nav.
  await page.getByTestId('nav-audit').click();
  await expect(page).toHaveURL(new RegExp(`/o/${fx.orgSlug}/settings/audit$`, 'u'));
  await expect(page.getByRole('heading', { name: 'Audit log', level: 1 })).toBeVisible();
  await expect(page.getByTestId('audit-filter-range')).toContainText('Last 7 days');
  await expect(page.getByTestId('audit-retention')).toContainText('Entries are kept');
  await expect(page.getByTestId('audit-row').first()).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'org audit: list');

  // Person = u_sales1 (keyboard in the menu), group = Records.
  await page.getByTestId('audit-filter-people').click();
  await page.getByRole('menuitemcheckbox', { name: new RegExp(SALES1_NAME, 'u') }).click();
  await page.keyboard.press('Escape');
  await page.getByTestId('audit-filter-action').click();
  await page.getByRole('menuitemcheckbox', { name: 'Records' }).click();
  await page.keyboard.press('Escape');
  await expect(page).toHaveURL(/group=record\./u);
  // Other specs of the run may have changed records as u_sales1: this spec's base only.
  await page.getByTestId('audit-filter-base').click();
  await page.getByRole('menuitemradio', { name: `Nhật ký T716 ${RUN}` }).click();
  await expect(page).toHaveURL(new RegExp(`base=${fx.baseId}`, 'u'));

  const rows = page.getByTestId('audit-row');
  await expect(rows).toHaveCount(2);
  for (const row of await rows.all()) {
    await expect(row.getByTestId('audit-actor')).toHaveText(SALES1_NAME);
    await expect(row).toContainText('Records · updated');
    await expect(row).toContainText('in Orders');
  }
  // Newest first: the token's change, then the session's.
  await expect(rows.nth(0).getByTestId('audit-via')).toHaveText(`via API token ${TOKEN_NAME}`);
  await expect(rows.nth(1).getByTestId('audit-via')).toHaveCount(0);
  await expectNoSeriousA11yViolations(page, 'org audit: filtered');

  // Keyboard: focus the first entry, ArrowDown to the second, Enter opens the details.
  const openers = page.locator('[data-audit-open]');
  await openers.nth(0).focus();
  await page.keyboard.press('ArrowDown');
  await expect(openers.nth(1)).toBeFocused();
  await page.keyboard.press('Enter');
  const drawer = page.getByTestId('audit-drawer');
  await expect(drawer).toBeVisible();
  const diff = drawer.getByTestId('audit-diff-row').filter({ hasText: 'amount' });
  await expect(diff.getByTestId('audit-diff-before')).toHaveText('100');
  await expect(diff.getByTestId('audit-diff-after')).toHaveText('150');
  await expect(drawer.getByTestId('audit-detail-request')).toContainText('req_');
  await expectNoSeriousA11yViolations(page, 'org audit: drawer');
  // Escape closes it; the focus goes back to the entry.
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(openers.nth(1)).toBeFocused();

  // The token's entry names the token in the drawer too.
  await openers.nth(0).click();
  await expect(page.getByTestId('audit-drawer').getByTestId('audit-via')).toHaveText(
    `via API token ${TOKEN_NAME}`,
  );
  await page.keyboard.press('Escape');

  // Base filter: B2's table, made by u_admin, is there for the organization.
  await page.goto(`/o/${fx.orgSlug}/settings/audit?base=${fx.base2Id}&group=table.`);
  await expect(page.getByTestId('audit-row').filter({ hasText: B2_TABLE })).toHaveCount(1);
  expect(csp).toEqual([]);
  await context.close();
});

test('the base admin sees only that base, tokens of others masked; org page 404', async ({
  browser,
}) => {
  const { context, page } = await openAs(browser, SALES2_EMAIL);
  await page.goto(`/b/${fx.baseId}/settings`);
  await page.getByTestId('base-settings-nav-audit').click();
  await expect(page).toHaveURL(new RegExp(`/b/${fx.baseId}/settings/audit$`, 'u'));
  await expect(page.getByTestId('base-settings-nav-audit')).toHaveAttribute('aria-current', 'page');
  const rows = page.getByTestId('audit-row');
  await expect(rows.filter({ hasText: 'Orders' }).first()).toBeVisible();
  await expect(page.getByText(B2_TABLE)).toHaveCount(0);
  await expect(page.getByTestId('audit-filter-base')).toHaveCount(0);
  // u_sales1's token is not theirs: "via an API token", no name.
  await page.getByTestId('audit-filter-via').click();
  await page.getByRole('menuitemcheckbox', { name: 'API tokens' }).click();
  await page.keyboard.press('Escape');
  await expect(rows).toHaveCount(1);
  await expect(rows.first().getByTestId('audit-via')).toHaveText('via an API token');
  await expect(page.getByText(TOKEN_NAME)).toHaveCount(0);
  await expectNoSeriousA11yViolations(page, 'base audit: base admin');

  // The API agrees: only B's entries; the organization route is 404.
  const list = await ok<{ items: { base_id: string | null }[] }>(
    page,
    'GET',
    `/bases/${fx.baseId}/audit-logs?limit=200`,
  );
  expect(list.items.length).toBeGreaterThan(0);
  expect(list.items.every((item) => item.base_id === fx.baseId)).toBe(true);
  expect((await api(page, 'GET', `/orgs/${fx.orgId}/audit-logs`)).status).toBe(404);
  await page.goto(`/o/${fx.orgSlug}/settings/audit`);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(page.getByTestId('audit-table')).toHaveCount(0);
  await context.close();
});

test('"Export CSV" starts a job and downloads the file with the documented columns', async ({
  browser,
}) => {
  const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
  await page.goto(
    `/o/${fx.orgSlug}/settings/audit?actor=${fx.sales1}&group=record.&base=${fx.baseId}`,
  );
  await expect(page.getByTestId('audit-row')).toHaveCount(2);
  await page.getByTestId('audit-export').click();
  const link = page.getByTestId('audit-export-download');
  await expect(link).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('audit-export-status')).toContainText(
    'The CSV is ready: 2 entries.',
  );
  await expectNoSeriousA11yViolations(page, 'org audit: export ready');
  const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
  const path = await download.path();
  const text = await readFile(path, 'utf8');
  expect(text.startsWith('\uFEFF')).toBe(true);
  const lines = text.slice(1).trim().split(/\r\n/u);
  expect(lines[0]).toBe(CSV_COLUMNS);
  expect(lines).toHaveLength(3);
  expect(lines.slice(1).every((line) => line.includes('record.updated'))).toBe(true);
  // The `via` column names the token for the organization owner.
  expect(text).toContain(TOKEN_NAME);
  await context.close();
});

test('u_editor opening the audit page of the demo base gets 404 (API too)', async ({ browser }) => {
  const { context, page } = await openAs(browser, EDITOR_EMAIL);
  await page.goto(`/b/${fx.demoBaseId}/settings/audit`);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(page.getByTestId('base-settings-nav')).toHaveCount(0);
  await expect(page.getByTestId('audit-table')).toHaveCount(0);
  expect((await api(page, 'GET', `/bases/${fx.demoBaseId}/audit-logs`)).status).toBe(404);
  await expectNoSeriousA11yViolations(page, 'base audit: 404');
  await context.close();
});

test('Vietnamese at 375 px: cards, drawer as a sheet, no horizontal scroll', async ({
  browser,
}) => {
  const { context, page } = await openAs(browser, SALES2_EMAIL, {
    viewport: { width: 375, height: 800 },
    language: 'vi',
  });
  await page.goto(`/b/${fx.baseId}/settings/audit`);
  await expect(page.getByRole('heading', { name: 'Nhật ký', level: 1 })).toBeVisible();
  const cards = page.getByTestId('audit-cards');
  await expect(cards).toBeVisible();
  await expect(page.getByTestId('audit-table')).toHaveCount(0);
  await expect(page.getByTestId('audit-filter-range')).toContainText('7 ngày qua');
  await expect(page.getByTestId('audit-retention')).toContainText('Các mục được');
  await noHorizontalScroll(page, 375);
  await expectNoSeriousA11yViolations(page, 'base audit: vi 375 px');
  await cards.getByTestId('audit-row').first().locator('[data-audit-open]').click();
  const drawer = page.getByTestId('audit-drawer');
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText('Chi tiết');
  await noHorizontalScroll(page, 375);
  await expectNoSeriousA11yViolations(page, 'base audit: vi 375 px drawer');
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await context.close();
});
