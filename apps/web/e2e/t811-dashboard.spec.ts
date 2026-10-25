import { type Browser, type BrowserContext, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { DEMO_PASSWORD } from './seed';
import { api, apiSignIn, collectCspViolations, expectNoSeriousA11yViolations, ok } from './support';

/**
 * T811: dashboards in view mode (FRONTEND §18, SPEC §10, CONTRACTS §28) in
 * a workspace and base of their own (the demo data has no dashboard):
 * Orders (title, owner, amount) with r1 (owner u_sales1) and r2 (owner
 * u_sales2); a custom role "Sales" reads Orders where owner is the viewer
 * and may read dashboard D.
 *
 * - u_admin creates an empty dashboard through the sidebar: it opens, the
 *   sidebar lists it, the page says there are no widgets yet;
 * - a KPI "count of Orders" on D (API: the editor is T812); u_sales1 opens D
 *   and reads 1 — only r1 (P21 through the UI);
 * - two tabs: a record change in tab 1 → the KPI in tab 2 (u_sales1) moves
 *   within 7 s (`dashboard.data_changed`, refetch with the viewer's rights);
 * - axe on every state, no CSP violation; Vietnamese at 375 px (one column,
 *   no horizontal scroll).
 *
 * `afterAll` moves the base to the trash.
 */

const RUN = Date.now().toString(36);
const ADMIN_EMAIL = WORKER_ORG.email('admin');
const SALES1_EMAIL = WORKER_ORG.email('sales1');
const SALES2_EMAIL = WORKER_ORG.email('sales2');
const DASHBOARD_NAME = `Doanh số T811 ${RUN}`;

interface Fixture {
  baseId: string;
  orders: string;
  owner: string;
  r2: string;
  sales1: string;
  sales2: string;
  dashboardId: string;
  widgetId: string;
  chartId: string;
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
    name: `T811 ${RUN}`,
  });
  const base = await ok<{ id: string }>(page, 'POST', `/workspaces/${workspace.id}/bases`, {
    name: `Dashboard T811 ${RUN}`,
  });
  fx.baseId = base.id;
  const orders = await ok<{ id: string; primary_field_id: string }>(
    page,
    'POST',
    `/bases/${base.id}/tables`,
    { name: 'Orders', primary_field_name: 'title' },
  );
  fx.orders = orders.id;
  const add = async (name: string, type: string, options: unknown = {}) =>
    (await ok<{ id: string }>(page, 'POST', `/tables/${orders.id}/fields`, { name, type, options }))
      .id;
  fx.owner = await add('owner', 'user', { multiple: false });
  const amount = await add('amount', 'number');

  const principals = await ok<{ items: { principal_id: string; email: string | null }[] }>(
    page,
    'GET',
    `/bases/${base.id}/principals?limit=200`,
  );
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
            [orders.primary_field_id]: 'r1',
            [fx.owner]: [{ id: fx.sales1 }],
            [amount]: 100,
          },
        },
        {
          fields: {
            [orders.primary_field_id]: 'r2',
            [fx.owner]: [{ id: fx.sales2 }],
            [amount]: 200,
          },
        },
      ],
    },
  );
  fx.r2 = rows.records[1]?.id ?? '';
}

/** The KPI of D and the role "Sales" that reads D and its own Orders (C§5 P21). */
async function shareWithSales(page: Page): Promise<void> {
  const widget = await ok<{ id: string }>(page, 'POST', `/dashboards/${fx.dashboardId}/widgets`, {
    type: 'kpi',
    title: 'Orders',
    config: { table_id: fx.orders, metrics: [{ id: 'm1', aggregation: 'count' }] },
    layout: { x: 0, y: 0, w: 4, h: 4 },
  });
  fx.widgetId = widget.id;
  const chart = await ok<{ id: string }>(page, 'POST', `/dashboards/${fx.dashboardId}/widgets`, {
    type: 'bar',
    title: 'Orders by owner',
    config: {
      table_id: fx.orders,
      dimension: { field: fx.owner },
      metrics: [{ id: 'm1', aggregation: 'count' }],
    },
    layout: { x: 4, y: 0, w: 8, h: 6 },
  });
  fx.chartId = chart.id;
  const role = await ok<{ id: string }>(page, 'POST', `/bases/${fx.baseId}/roles`, {
    name: `Sales ${RUN}`,
    config: {
      base_rule: { copy: false, download: false, share_link: false },
      tables: {
        [fx.orders]: {
          perm: 'read_only',
          view_rule: { allow_edit: false, visible_views: null },
          record_rule: {
            operations: [],
            edit_filter: null,
            read_scope: 'filter',
            read_filter: {
              op: 'and',
              items: [
                { field: fx.owner, operator: 'has_any_of', value: [{ $var: 'current_user' }] },
              ],
            },
          },
        },
      },
      dashboards: { [fx.dashboardId]: 'read_only' },
    },
  });
  await ok(page, 'PUT', `/bases/${fx.baseId}/role-assignments`, {
    principal_type: 'user',
    principal_id: fx.sales1,
    role_id: role.id,
  });
}

function noHorizontalScroll(page: Page, width: number) {
  return expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(width);
}

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

test('u_admin creates an empty dashboard from the sidebar', async ({ browser }) => {
  const { context, page } = await openAs(browser, ADMIN_EMAIL);
  const csp = collectCspViolations(page);
  await page.goto(`/b/${fx.baseId}/t/${fx.orders}`);
  const nav = page.getByTestId('dashboards-nav');
  await expect(nav.getByRole('heading', { name: 'Dashboards' })).toBeVisible();
  await nav.getByTestId('new-dashboard').click();
  const dialog = page.getByTestId('dashboard-name-dialog');
  await expect(dialog.getByLabel('Name')).toHaveValue('Untitled dashboard');
  await expectNoSeriousA11yViolations(page, 'new dashboard dialog');
  await dialog.getByLabel('Name').fill(DASHBOARD_NAME);
  await dialog.getByRole('button', { name: 'Create' }).click();

  await expect(page).toHaveURL(new RegExp(`/b/${fx.baseId}/d/dsh_[A-Za-z0-9]+$`, 'u'));
  fx.dashboardId = page.url().split('/d/')[1] ?? '';
  await expect(page.getByTestId('dashboard-title')).toHaveText(DASHBOARD_NAME);
  await expect(nav.getByTestId(`dashboard-link-${fx.dashboardId}`)).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByTestId('dashboard-empty')).toContainText('No widgets yet');
  await expectNoSeriousA11yViolations(page, 'empty dashboard');
  expect(csp).toEqual([]);
  await context.close();
});

test('u_sales1 reads only their order; a change in another tab shows within 7 s', async ({
  browser,
}) => {
  const admin = await openAs(browser, ADMIN_EMAIL);
  await shareWithSales(admin.page);

  const sales = await openAs(browser, SALES1_EMAIL);
  const csp = collectCspViolations(sales.page);
  await sales.page.goto(`/b/${fx.baseId}/d/${fx.dashboardId}`);
  const card = sales.page.getByTestId(`widget-${fx.widgetId}`);
  // P21 through the UI: the count is over the records u_sales1 may read (r1 only).
  await expect(card.getByTestId('kpi-value')).toHaveText('1');
  await expect(card.getByRole('heading', { name: 'Orders' })).toBeVisible();
  // Members see the dashboards they may read, without the admin actions.
  const nav = sales.page.getByTestId('dashboards-nav');
  await expect(nav.getByTestId(`dashboard-link-${fx.dashboardId}`)).toBeVisible();
  await expect(nav.getByTestId('new-dashboard')).toHaveCount(0);
  // The bar chart draws on a canvas (ECharts) named by its numbers; "View as table" swaps it.
  const chart = sales.page.getByTestId(`widget-${fx.chartId}`);
  await expect(chart.getByTestId('widget-chart')).toHaveAccessibleName(
    /Bar chart: Orders by owner, 1 group\. Phạm Ngọc Lan: 1/u,
  );
  await expect(chart.locator('canvas')).toBeVisible();
  await expectNoSeriousA11yViolations(sales.page, 'dashboard with a KPI and a chart');
  await sales.page.screenshot({ path: test.info().outputPath('t811-sales1-desktop.png') });
  await chart.getByRole('button', { name: 'View as table' }).click();
  await expect(chart.getByTestId('widget-data-table').getByRole('rowheader')).toHaveText([
    'Phạm Ngọc Lan',
  ]);
  await expectNoSeriousA11yViolations(sales.page, 'chart as a table');

  // Tab 1 (u_admin) gives r2 to u_sales1: tab 2's KPI follows through `dashboard.data_changed`.
  await admin.page.goto(`/b/${fx.baseId}/d/${fx.dashboardId}`);
  await expect(admin.page.getByTestId(`widget-${fx.widgetId}`).getByTestId('kpi-value')).toHaveText(
    '2',
  );
  const changedAt = Date.now();
  await ok(admin.page, 'PATCH', `/tables/${fx.orders}/records/${fx.r2}?field_key_type=id`, {
    fields: { [fx.owner]: [{ id: fx.sales1 }] },
  });
  await expect(card.getByTestId('kpi-value')).toHaveText('2', { timeout: 7_000 });
  expect(Date.now() - changedAt).toBeLessThanOrEqual(7_000);

  // And back: the next change is gathered into the 5 s window, still within 7 s.
  const backAt = Date.now();
  await ok(admin.page, 'PATCH', `/tables/${fx.orders}/records/${fx.r2}?field_key_type=id`, {
    fields: { [fx.owner]: [{ id: fx.sales2 }] },
  });
  await expect(card.getByTestId('kpi-value')).toHaveText('1', { timeout: 7_000 });
  expect(Date.now() - backAt).toBeLessThanOrEqual(7_000);
  expect(csp).toEqual([]);
  await admin.context.close();
  await sales.context.close();
});

test('in Vietnamese at 375 px: one column, no horizontal scroll', async ({ browser }) => {
  const { context, page } = await openAs(browser, SALES1_EMAIL, {
    viewport: { width: 375, height: 812 },
    language: 'vi',
  });
  await page.goto(`/b/${fx.baseId}/d/${fx.dashboardId}`);
  await expect(page.getByTestId('dashboard-grid')).toHaveAttribute('data-layout', 'column');
  const card = page.getByTestId(`widget-${fx.widgetId}`);
  await expect(card.getByTestId('kpi-value')).toHaveText('1');
  await noHorizontalScroll(page, 375);
  await expectNoSeriousA11yViolations(page, 'dashboard vi 375');
  await page.screenshot({ path: test.info().outputPath('t811-vi-375.png') });
  await context.close();
});
