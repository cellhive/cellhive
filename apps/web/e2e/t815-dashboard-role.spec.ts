import { type Browser, type BrowserContext, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { DEMO_PASSWORD } from './seed';
import { api, apiSignIn, expectNoSeriousA11yViolations, ok } from './support';

/**
 * T815: dashboard permissions in the role editor and in a member's
 * effective access (FRONTEND §17.4, CONTRACTS §28, SPEC §14.1), in a
 * workspace and base of their own: Orders (title, owner), a dashboard D,
 * and a custom role "Sales" (Orders read only, no dashboard) given to
 * u_sales1 directly.
 *
 * - D is new, so the role does not read it (deny by default): u_sales1's
 *   sidebar has no D;
 * - u_admin gives the role "View" on D with the keyboard and saves → D
 *   shows in u_sales1's open tab without a reload (`permission.changed`);
 *   the access panel of u_sales1 lists D; "No access" again → D goes away;
 * - system roles show every dashboard viewed, read-only;
 * - axe on every state; Vietnamese at 375 px (no horizontal scroll, 44 px).
 *
 * `afterAll` moves the base to the trash.
 */

const RUN = Date.now().toString(36);
const ADMIN_EMAIL = WORKER_ORG.email('admin');
const SALES1_EMAIL = WORKER_ORG.email('sales1');
const SALES1_NAME = 'Phạm Ngọc Lan';
const DASHBOARD_NAME = `Doanh số T815 ${RUN}`;
const ROLE_NAME = `Sales T815 ${RUN}`;

interface Fixture {
  baseId: string;
  orders: string;
  dashboardId: string;
  roleId: string;
  editorRoleId: string;
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

async function buildFixture(page: Page): Promise<void> {
  const me = await ok<{ orgs: { id: string }[] }>(page, 'GET', '/me');
  const orgId = me.orgs[0]?.id ?? '';
  const workspace = await ok<{ id: string }>(page, 'POST', `/orgs/${orgId}/workspaces`, {
    name: `T815 ${RUN}`,
  });
  const base = await ok<{ id: string }>(page, 'POST', `/workspaces/${workspace.id}/bases`, {
    name: `Dashboard roles T815 ${RUN}`,
  });
  fx.baseId = base.id;
  const orders = await ok<{ id: string }>(page, 'POST', `/bases/${base.id}/tables`, {
    name: 'Orders',
    primary_field_name: 'title',
  });
  fx.orders = orders.id;
  const dashboard = await ok<{ id: string }>(page, 'POST', `/bases/${base.id}/dashboards`, {
    name: DASHBOARD_NAME,
  });
  fx.dashboardId = dashboard.id;

  const principals = await ok<{ items: { principal_id: string; email: string | null }[] }>(
    page,
    'GET',
    `/bases/${base.id}/principals?limit=200`,
  );
  const sales1 = principals.items.find((item) => item.email === SALES1_EMAIL)?.principal_id ?? '';
  const role = await ok<{ id: string }>(page, 'POST', `/bases/${base.id}/roles`, {
    name: ROLE_NAME,
    config: {
      base_rule: { copy: false, download: false, share_link: false },
      tables: { [orders.id]: { perm: 'read_only' } },
      dashboards: {},
    },
  });
  fx.roleId = role.id;
  await ok(page, 'PUT', `/bases/${base.id}/role-assignments`, {
    principal_type: 'user',
    principal_id: sales1,
    role_id: role.id,
  });
  const roles = await ok<{ items: { id: string; kind: string }[] }>(
    page,
    'GET',
    `/bases/${base.id}/roles`,
  );
  fx.editorRoleId = roles.items.find((item) => item.kind === 'system_editor')?.id ?? '';
}

function noHorizontalScroll(page: Page, width: number) {
  return expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(width);
}

const dashboardGroup = (page: Page, name: string) =>
  page.getByRole('radiogroup', { name: `Access to the dashboard ${name}` });

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  const { context, page } = await openAs(browser, ADMIN_EMAIL);
  await buildFixture(page);
  await context.close();
});

test.afterAll(async ({ browser }) => {
  const { context, page } = await openAs(browser, ADMIN_EMAIL);
  await api(page, 'DELETE', `/bases/${fx.baseId}`);
  await context.close();
});

test('u_admin gives Sales "View" on D: u_sales1 sees it without a reload, then loses it', async ({
  browser,
}) => {
  const sales = await openAs(browser, SALES1_EMAIL);
  await sales.page.goto(`/b/${fx.baseId}/t/${fx.orders}`);
  await expect(
    sales.page.getByRole('navigation', { name: 'Tables' }).getByRole('link', { name: 'Orders' }),
  ).toBeVisible();
  const salesLink = sales.page.getByTestId(`dashboard-link-${fx.dashboardId}`);
  // A new dashboard is not in a custom role (deny by default).
  await expect(salesLink).toHaveCount(0);

  const admin = await openAs(browser, ADMIN_EMAIL);
  const page = admin.page;
  await page.goto(`/b/${fx.baseId}/settings/roles/${fx.roleId}`);
  const section = page.getByTestId('dashboard-section');
  await expect(section.getByRole('heading', { name: 'Dashboards' })).toBeVisible();
  await expect(section).toContainText('New dashboards start at “No access” for this role');
  await expect(section.getByTestId('dashboard-widgets-note')).toContainText(
    "Widgets still apply this role's table, field and record permissions",
  );
  const group = dashboardGroup(page, DASHBOARD_NAME);
  const none = group.getByRole('radio', { name: 'No access' });
  await expect(none).toHaveAttribute('aria-checked', 'true');
  await expectNoSeriousA11yViolations(page, 'role editor: dashboards');

  // Keyboard: the chosen level is the tab stop; an arrow moves and chooses.
  await none.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(group.getByRole('radio', { name: 'View' })).toHaveAttribute('aria-checked', 'true');
  await expect(group.getByRole('radio', { name: 'View' })).toBeFocused();
  await expect(page.getByTestId('unsaved-bar')).toContainText('Unsaved changes');
  await page.getByTestId('role-save').click();
  await expect(page.getByTestId('unsaved-bar')).toHaveCount(0);
  const saved = await ok<{ config: { dashboards: Record<string, string> } }>(
    page,
    'GET',
    `/bases/${fx.baseId}/roles/${fx.roleId}`,
  );
  expect(saved.config.dashboards).toEqual({ [fx.dashboardId]: 'read_only' });

  // u_sales1's open tab: `permission.changed` refetches the sidebar.
  await expect(salesLink).toBeVisible();
  await expect(salesLink).toHaveText(DASHBOARD_NAME);

  // The access panel of u_sales1 lists D.
  await page.goto(`/b/${fx.baseId}/settings/members`);
  await page.getByLabel('Search people and groups').fill(SALES1_NAME);
  await page.getByRole('button', { name: `View the access of ${SALES1_NAME}` }).click();
  const panel = page.getByRole('dialog', { name: `Access of ${SALES1_NAME}` });
  await expect(panel.getByTestId('access-dashboards-list')).toHaveText(DASHBOARD_NAME);
  await expectNoSeriousA11yViolations(page, 'member access panel: dashboards');
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);

  // "No access to any" → D goes away from u_sales1's sidebar.
  await page.goto(`/b/${fx.baseId}/settings/roles/${fx.roleId}`);
  await expect(
    dashboardGroup(page, DASHBOARD_NAME).getByRole('radio', { name: 'View' }),
  ).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('dashboards-none').click();
  await page.getByTestId('role-save').click();
  await expect(page.getByTestId('unsaved-bar')).toHaveCount(0);
  await expect(salesLink).toHaveCount(0);
  await admin.context.close();
  await sales.context.close();
});

test('the Editor role views every dashboard, read-only', async ({ browser }) => {
  const { context, page } = await openAs(browser, ADMIN_EMAIL);
  await page.goto(`/b/${fx.baseId}/settings/roles/${fx.editorRoleId}`);
  const group = dashboardGroup(page, DASHBOARD_NAME);
  await expect(group).toHaveAttribute('aria-disabled', 'true');
  await expect(group.getByRole('radio', { name: 'View' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('dashboards-read-all')).toHaveCount(0);
  await expectNoSeriousA11yViolations(page, 'editor role: dashboards');
  await context.close();
});

test('Vietnamese at 375 px: the dashboard rows fit, 44 px targets', async ({ browser }) => {
  const { context, page } = await openAs(browser, ADMIN_EMAIL, {
    viewport: { width: 375, height: 812 },
    language: 'vi',
  });
  await page.goto(`/b/${fx.baseId}/settings/roles/${fx.roleId}`);
  const section = page.getByTestId('dashboard-section');
  await expect(section.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  const group = page.getByRole('radiogroup', { name: `Quyền trên dashboard ${DASHBOARD_NAME}` });
  const view = group.getByRole('radio', { name: 'Xem' });
  await expect(group.getByRole('radio', { name: 'Không truy cập' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  expect((await view.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  const readAll = section.getByRole('button', { name: 'Xem tất cả' });
  expect((await readAll.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  await section.scrollIntoViewIfNeeded();
  await noHorizontalScroll(page, 375);
  await expectNoSeriousA11yViolations(page, 'role editor dashboards at 375 px (vi)');
  await page.screenshot({ path: test.info().outputPath('t815-vi-375.png'), fullPage: true });
  await context.close();
});
