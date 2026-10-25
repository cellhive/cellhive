import { readFile } from 'node:fs/promises';

import { type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { DEMO_PASSWORD } from './seed';
import { api, apiSignIn, collectCspViolations, expectNoSeriousA11yViolations, ok } from './support';

/**
 * T813: dashboard filters, cross-filter, click-through, TV mode and export
 * (FRONTEND §18.3, CONTRACTS §28.4–28.6), in a workspace and base of their
 * own: Orders (title, priority, owner, province, district, amount) with
 * r1 (Khẩn, u_sales1, Hà Nội / Ba Đình, 100), r2 (Thường, u_sales2, Hà Nội
 * / Cầu Giấy, 200) and r3 (Khẩn, u_sales2, Hồ Chí Minh / Quận 1, 300);
 * Tickets (one record) on another table. Dashboard D: a bar chart "By
 * priority", KPIs "Orders" (count) and "Amount" (sum) — all on Orders and
 * following the two slicers "Province" → "District" — and a KPI "Tickets".
 * u_reader holds the system reader role; the custom role "Sales" reads its
 * own Orders and D, without `base_rule.download`.
 *
 * - "Khẩn" picked in the chart (keyboard: arrows + Enter) → every Orders
 *   widget changes, Tickets says in text the filter does not apply; again →
 *   the filter goes;
 * - Province "Hà Nội" → District lists only its districts; "Ba Đình" → 1;
 * - u_sales1's click-through lists r1 only; u_sales1 has no export items;
 * - u_reader downloads the chart's CSV (the aggregate table);
 * - TV mode goes full screen and Escape leaves it;
 * - axe on every state, no CSP violation, Vietnamese at 375 px.
 *
 * `afterAll` moves the base to the trash.
 */

const RUN = Date.now().toString(36);
const ADMIN_EMAIL = WORKER_ORG.email('admin');
const READER_EMAIL = WORKER_ORG.email('reader');
const SALES1_EMAIL = WORKER_ORG.email('sales1');
const SALES2_EMAIL = WORKER_ORG.email('sales2');

interface Fixture {
  baseId: string;
  dashboardId: string;
  chart: string;
  orders: string;
  amount: string;
  tickets: string;
  province: string;
  district: string;
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
    acceptDownloads: true,
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

interface Field {
  id: string;
  options: { options?: { id: string; name: string }[] };
}

async function buildFixture(page: Page): Promise<void> {
  const me = await ok<{ orgs: { id: string }[] }>(page, 'GET', '/me');
  const orgId = me.orgs[0]?.id ?? '';
  const workspace = await ok<{ id: string }>(page, 'POST', `/orgs/${orgId}/workspaces`, {
    name: `T813 ${RUN}`,
  });
  const base = await ok<{ id: string }>(page, 'POST', `/workspaces/${workspace.id}/bases`, {
    name: `Dashboard T813 ${RUN}`,
  });
  fx.baseId = base.id;
  const table = (name: string) =>
    ok<{ id: string; primary_field_id: string }>(page, 'POST', `/bases/${base.id}/tables`, {
      name,
      primary_field_name: 'title',
    });
  const orders = await table('Orders');
  const tickets = await table('Tickets');
  const add = (name: string, type: string, options: unknown = {}) =>
    ok<Field>(page, 'POST', `/tables/${orders.id}/fields`, { name, type, options });
  const select = (name: string, values: string[]) =>
    add(name, 'select', {
      multiple: false,
      options: values.map((value, index) => ({ name: value, color: index + 1 })),
    });
  const priority = await select('priority', ['Khẩn', 'Thường']);
  const owner = await add('owner', 'user', { multiple: false });
  const province = await select('province', ['Hà Nội', 'Hồ Chí Minh']);
  const district = await select('district', ['Ba Đình', 'Cầu Giấy', 'Quận 1']);
  const amount = await add('amount', 'number');
  const option = (field: Field, name: string) =>
    field.options.options?.find((item) => item.name === name)?.id;

  const principals = await ok<{ items: { principal_id: string; email: string | null }[] }>(
    page,
    'GET',
    `/bases/${base.id}/principals?limit=200`,
  );
  const user = (email: string) =>
    principals.items.find((item) => item.email === email)?.principal_id ?? '';
  const sales1 = user(SALES1_EMAIL);
  const sales2 = user(SALES2_EMAIL);
  const row = (
    title: string,
    level: string,
    who: string,
    city: string,
    area: string,
    value: number,
  ) => ({
    fields: {
      [orders.primary_field_id]: title,
      [priority.id]: option(priority, level),
      [owner.id]: [{ id: who }],
      [province.id]: option(province, city),
      [district.id]: option(district, area),
      [amount.id]: value,
    },
  });
  await ok(page, 'POST', `/tables/${orders.id}/records?field_key_type=id`, {
    records: [
      row('r1', 'Khẩn', sales1, 'Hà Nội', 'Ba Đình', 100),
      row('r2', 'Thường', sales2, 'Hà Nội', 'Cầu Giấy', 200),
      row('r3', 'Khẩn', sales2, 'Hồ Chí Minh', 'Quận 1', 300),
    ],
  });
  await ok(page, 'POST', `/tables/${tickets.id}/records?field_key_type=id`, {
    records: [{ fields: { [tickets.primary_field_id]: 't1' } }],
  });

  const dashboard = await ok<{ id: string }>(page, 'POST', `/bases/${base.id}/dashboards`, {
    name: `Sales T813 ${RUN}`,
  });
  fx.dashboardId = dashboard.id;
  const widget = async (body: Record<string, unknown>) =>
    (await ok<{ id: string }>(page, 'POST', `/dashboards/${dashboard.id}/widgets`, body)).id;
  fx.province = await widget({
    type: 'filter_control',
    title: 'Province',
    config: { table_id: orders.id, field: province.id, control: 'select' },
    layout: { x: 0, y: 0, w: 3, h: 2 },
  });
  fx.district = await widget({
    type: 'filter_control',
    title: 'District',
    config: {
      table_id: orders.id,
      field: district.id,
      control: 'select',
      parent_control_id: fx.province,
    },
    layout: { x: 3, y: 0, w: 3, h: 2 },
  });
  const bindings = [fx.province, fx.district];
  const count = [{ id: 'm1', aggregation: 'count' }];
  fx.orders = await widget({
    type: 'kpi',
    title: 'Orders',
    config: { table_id: orders.id, metrics: count, filter_bindings: bindings },
    layout: { x: 0, y: 2, w: 3, h: 3 },
  });
  fx.amount = await widget({
    type: 'kpi',
    title: 'Amount',
    config: {
      table_id: orders.id,
      metrics: [{ id: 'm1', aggregation: 'sum', field: amount.id }],
      filter_bindings: bindings,
    },
    layout: { x: 3, y: 2, w: 3, h: 3 },
  });
  fx.tickets = await widget({
    type: 'kpi',
    title: 'Tickets',
    config: { table_id: tickets.id, metrics: count },
    layout: { x: 6, y: 2, w: 3, h: 3 },
  });
  fx.chart = await widget({
    type: 'bar',
    title: 'By priority',
    config: {
      table_id: orders.id,
      dimension: { field: priority.id },
      metrics: count,
      filter_bindings: bindings,
    },
    layout: { x: 0, y: 5, w: 8, h: 6 },
  });

  const roles = await ok<{ items: { id: string; kind: string }[] }>(
    page,
    'GET',
    `/bases/${base.id}/roles`,
  );
  await ok(page, 'PUT', `/bases/${base.id}/role-assignments`, {
    principal_type: 'user',
    principal_id: user(READER_EMAIL),
    role_id: roles.items.find((role) => role.kind === 'system_reader')?.id,
  });
  const sales = await ok<{ id: string }>(page, 'POST', `/bases/${base.id}/roles`, {
    name: `Sales ${RUN}`,
    config: {
      base_rule: { copy: false, download: false, share_link: false },
      tables: {
        [orders.id]: {
          perm: 'read_only',
          view_rule: { allow_edit: false, visible_views: null },
          record_rule: {
            operations: [],
            edit_filter: null,
            read_scope: 'filter',
            read_filter: {
              op: 'and',
              items: [
                { field: owner.id, operator: 'has_any_of', value: [{ $var: 'current_user' }] },
              ],
            },
          },
        },
      },
      dashboards: { [dashboard.id]: 'read_only' },
    },
  });
  await ok(page, 'PUT', `/bases/${base.id}/role-assignments`, {
    principal_type: 'user',
    principal_id: sales1,
    role_id: sales.id,
  });
}

const dashboardUrl = () => `/b/${fx.baseId}/d/${fx.dashboardId}`;
const kpi = (page: Page, widgetId: string) =>
  page.getByTestId(`widget-${widgetId}`).getByTestId('kpi-value');

async function pick(page: Page, control: string, option: string): Promise<void> {
  const prefix = `filter-control-${control}`;
  await page.getByTestId(`${prefix}-button`).click();
  const panel = page.getByTestId(`${prefix}-panel`);
  await panel.getByRole('checkbox', { name: option }).check();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
}

async function openWidgetMenu(page: Page, widgetId: string, name: string): Promise<Locator> {
  await page
    .getByTestId(`widget-${widgetId}`)
    .getByRole('button', { name: `Actions for ${name}` })
    .click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  return menu;
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

test('a cross-filter from the chart narrows every Orders widget; again removes it', async ({
  browser,
}) => {
  const { context, page } = await openAs(browser, ADMIN_EMAIL);
  const csp = collectCspViolations(page);
  await page.goto(dashboardUrl());
  await expect(kpi(page, fx.orders)).toHaveText('3');
  await expect(kpi(page, fx.amount)).toHaveText('600');
  await expect(kpi(page, fx.tickets)).toHaveText('1');

  // Keyboard on the chart: the first group ("Khẩn"), Enter filters.
  const chart = page.getByTestId(`widget-${fx.chart}`).getByTestId('widget-chart');
  await chart.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId(`widget-${fx.chart}`).getByTestId('chart-live')).toContainText(
    'Khẩn',
  );
  await page.keyboard.press('Enter');
  const chip = page.getByTestId(`cross-chip-${fx.chart}`);
  await expect(chip).toHaveText(/Filtered by: Khẩn/u);
  await expect(kpi(page, fx.orders)).toHaveText('2');
  await expect(kpi(page, fx.amount)).toHaveText('400');
  // Another table: unchanged, said in text.
  await expect(kpi(page, fx.tickets)).toHaveText('1');
  await expect(
    page.getByTestId(`widget-${fx.tickets}`).getByTestId('widget-filter-notices'),
  ).toContainText('does not apply: it filters another table');
  // The link carries the filter.
  expect(new URL(page.url()).searchParams.get('f')).not.toBeNull();
  await expectNoSeriousA11yViolations(page, 'cross-filtered dashboard');
  await page.screenshot({ path: test.info().outputPath('t813-cross-filter.png') });

  // The same group again removes it.
  await page.keyboard.press('Enter');
  await expect(chip).toHaveCount(0);
  await expect(kpi(page, fx.orders)).toHaveText('3');
  await expect(kpi(page, fx.amount)).toHaveText('600');
  expect(csp).toEqual([]);
  await context.close();
});

test('slicers cascade: a province lists its districts only', async ({ browser }) => {
  const { context, page } = await openAs(browser, ADMIN_EMAIL);
  const csp = collectCspViolations(page);
  await page.goto(dashboardUrl());
  await expect(kpi(page, fx.orders)).toHaveText('3');
  await pick(page, fx.province, 'Hà Nội');
  await expect(kpi(page, fx.orders)).toHaveText('2');

  await page.getByTestId(`filter-control-${fx.district}-button`).click();
  const districts = page.getByTestId(`filter-control-${fx.district}-panel`);
  await expect(districts.getByRole('listitem')).toHaveText(['Ba Đình', 'Cầu Giấy']);
  await expectNoSeriousA11yViolations(page, 'district list');
  await districts.getByRole('checkbox', { name: 'Ba Đình' }).check();
  await page.keyboard.press('Escape');
  await expect(kpi(page, fx.orders)).toHaveText('1');
  await expect(kpi(page, fx.amount)).toHaveText('100');
  // Tickets does not follow the slicers.
  await expect(kpi(page, fx.tickets)).toHaveText('1');

  await page.getByTestId('dashboard-clear-filters').click();
  await expect(kpi(page, fx.orders)).toHaveText('3');
  expect(csp).toEqual([]);
  await context.close();
});

test('u_sales1: click-through lists r1 only, no export items', async ({ browser }) => {
  const { context, page } = await openAs(browser, SALES1_EMAIL);
  const csp = collectCspViolations(page);
  await page.goto(dashboardUrl());
  await expect(kpi(page, fx.orders)).toHaveText('1');
  const menu = await openWidgetMenu(page, fx.orders, 'Orders');
  await expect(menu.getByRole('menuitem')).toHaveText(['View records']);
  await menu.getByRole('menuitem', { name: 'View records' }).click();
  const drawer = page.getByTestId('drill-drawer');
  await expect(drawer.getByTestId('drill-open-record')).toHaveText(['r1']);
  await expect(drawer.getByTestId('drill-summary')).toHaveText('1 record');
  await expectNoSeriousA11yViolations(page, 'records drawer');
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);

  const chartMenu = await openWidgetMenu(page, fx.chart, 'By priority');
  await expect(chartMenu.getByRole('menuitem', { name: /Download/u })).toHaveCount(0);
  await page.keyboard.press('Escape');
  expect(csp).toEqual([]);
  await context.close();
});

test('u_reader downloads the chart as CSV and PNG', async ({ browser }) => {
  const { context, page } = await openAs(browser, READER_EMAIL);
  const csp = collectCspViolations(page);
  await page.goto(dashboardUrl());
  await expect(kpi(page, fx.orders)).toHaveText('3');
  await expect(page.getByTestId(`widget-${fx.chart}`).locator('canvas')).toBeVisible();

  let menu = await openWidgetMenu(page, fx.chart, 'By priority');
  const csv = page.waitForEvent('download');
  await menu.getByRole('menuitem', { name: 'Download as CSV' }).click();
  const file = await csv;
  expect(file.suggestedFilename()).toMatch(/\.csv$/u);
  const text = (await readFile(await file.path())).toString('utf8');
  // The aggregate table: one line per group, no record.
  expect(text).toMatch(/Khẩn.*2/u);
  expect(text).toMatch(/Thường.*1/u);
  expect(text).not.toContain('r1');

  menu = await openWidgetMenu(page, fx.chart, 'By priority');
  const png = page.waitForEvent('download');
  await menu.getByRole('menuitem', { name: 'Download as PNG' }).click();
  const image = await png;
  expect(image.suggestedFilename()).toMatch(/\.png$/u);
  const bytes = await readFile(await image.path());
  expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
  expect(csp).toEqual([]);
  await context.close();
});

test('TV mode fills the screen and Escape leaves it', async ({ browser }) => {
  const { context, page } = await openAs(browser, READER_EMAIL);
  const csp = collectCspViolations(page);
  await page.goto(dashboardUrl());
  await expect(kpi(page, fx.orders)).toHaveText('3');
  await page.getByTestId('dashboard-tv').click();
  const bar = page.getByTestId('dashboard-tv-bar');
  await expect(bar).toBeVisible();
  await expect(page).toHaveURL(/[?&]tv=1/u);
  await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(true);
  // The app frame is covered; the numbers stay.
  await expect(kpi(page, fx.orders)).toHaveText('3');
  await expectNoSeriousA11yViolations(page, 'TV mode');
  await page.screenshot({ path: test.info().outputPath('t813-tv.png') });

  await page.keyboard.press('Escape');
  await expect(bar).toHaveCount(0);
  await expect(page).not.toHaveURL(/[?&]tv=1/u);
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  expect(csp).toEqual([]);
  await context.close();
});

test('in Vietnamese at 375 px: filters fit, no horizontal scroll', async ({ browser }) => {
  const { context, page } = await openAs(browser, ADMIN_EMAIL, {
    viewport: { width: 375, height: 812 },
    language: 'vi',
  });
  await page.goto(dashboardUrl());
  await expect(page.getByTestId('dashboard-grid')).toHaveAttribute('data-layout', 'column');
  await expect(kpi(page, fx.orders)).toHaveText('3');
  await pick(page, fx.province, 'Hà Nội');
  await expect(kpi(page, fx.orders)).toHaveText('2');
  await expect(page.getByTestId('dashboard-clear-filters')).toHaveText('Xoá lọc');
  await noHorizontalScroll(page, 375);
  await expectNoSeriousA11yViolations(page, 'filters vi 375');
  await page.screenshot({ path: test.info().outputPath('t813-vi-375.png') });
  await context.close();
});
