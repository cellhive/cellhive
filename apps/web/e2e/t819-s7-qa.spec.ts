import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { type Browser, type BrowserContext, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { DEMO_PASSWORD } from './seed';
import { animationsSettled, api, apiSignIn, collectCspViolations, ok } from './support';

/**
 * T819 (QA S7): every S7 screen the demo organization reaches (the sample
 * dashboard "Tổng quan đơn hàng" and the Tickets color rule of the T818
 * seed), audited the same way as T720 — axe (WCAG 2.2 AA tags) without a
 * serious/critical violation, no horizontal scrolling, no CSP violation — at
 * 1440 px light (Vietnamese), 1440 px dark (English), 375 px light
 * (Vietnamese) and 375 px dark (English):
 *
 * - u_admin: the dashboard, a slicer open, "View records" of a widget, edit
 *   mode with the widget library and the settings panel of a chart, TV mode,
 *   the share dialog and its Embed tab, the dashboard trash, the role editor
 *   (Sales) with its Dashboards section, the color rules of the Tickets grid;
 * - u_sales1 (role Sales: own orders, reads the dashboard): the dashboard;
 * - an anonymous visitor: the public link of the dashboard.
 *
 * Plus the roles: u_out (a plain member) gets the "not found" screen for the
 * dashboard, and the API answers 404 for the dashboard and its widget data.
 *
 * Set `T819_SHOTS=<dir>` to save a JPEG of each audited screen (the design
 * audit of `docs/reviews/S7-QA.md`).
 */

const SHOTS = process.env['T819_SHOTS'];
const RUN = Date.now().toString(36);
const users = {
  admin: WORKER_ORG.email('admin'),
  sales1: WORKER_ORG.email('sales1'),
  out: WORKER_ORG.email('out'),
} as const;
const DEMO_BASE = 'Chăm sóc khách hàng';
const DEMO_DASHBOARD = 'Tổng quan đơn hàng';

interface Variant {
  readonly name: string;
  readonly viewport: { width: number; height: number };
  readonly language: 'en' | 'vi';
  readonly colorScheme: 'light' | 'dark';
}

const VARIANTS: readonly Variant[] = [
  {
    name: '1440-light-vi',
    viewport: { width: 1440, height: 900 },
    language: 'vi',
    colorScheme: 'light',
  },
  {
    name: '1440-dark-en',
    viewport: { width: 1440, height: 900 },
    language: 'en',
    colorScheme: 'dark',
  },
  {
    name: '375-light-vi',
    viewport: { width: 375, height: 812 },
    language: 'vi',
    colorScheme: 'light',
  },
  {
    name: '375-dark-en',
    viewport: { width: 375, height: 812 },
    language: 'en',
    colorScheme: 'dark',
  },
];
const DESKTOP = VARIANTS[1] as Variant;

const sessions = new Map<string, Awaited<ReturnType<BrowserContext['storageState']>>>();

async function openAs(
  browser: Browser,
  email: string | null,
  variant: Variant = DESKTOP,
): Promise<{ context: BrowserContext; page: Page }> {
  const known = email === null ? undefined : sessions.get(email);
  const context = await browser.newContext({
    viewport: variant.viewport,
    locale: 'en-US',
    timezoneId: 'Asia/Ho_Chi_Minh',
    colorScheme: variant.colorScheme,
    ...(known === undefined ? {} : { storageState: known }),
  });
  await context.addInitScript((value) => {
    window.localStorage.setItem('cellhive.language', value);
  }, variant.language);
  const page = await context.newPage();
  await page.goto('/login');
  if (email !== null && known === undefined) {
    await apiSignIn(page, email, DEMO_PASSWORD);
    sessions.set(email, await context.storageState());
  }
  return { context, page };
}

/** axe (no serious/critical), no horizontal scroll; a JPEG with `T819_SHOTS`. */
async function audit(page: Page, label: string): Promise<void> {
  await animationsSettled(page);
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const serious = results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => ({
      id: violation.id,
      targets: violation.nodes.map((node) => node.target.join(' ')),
    }));
  expect(serious, `axe violations on ${label}`).toEqual([]);
  const { scroll, width } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    width: window.innerWidth,
  }));
  expect(scroll, `horizontal scroll on ${label}`).toBeLessThanOrEqual(width);
  if (SHOTS !== undefined) {
    await mkdir(SHOTS, { recursive: true });
    await page.screenshot({
      path: join(SHOTS, `${label.replace(/[^a-z0-9-]+/giu, '-')}.jpg`),
      type: 'jpeg',
      quality: 60,
      fullPage: true,
    });
  }
}

interface WidgetDto {
  id: string;
  type: string;
  title: string | null;
}

const fx = {
  baseId: '',
  tickets: '',
  ticketsView: '',
  salesRole: '',
  dashboardId: '',
  widgets: [] as WidgetDto[],
  token: '',
};

const widgetOf = (type: string): WidgetDto => {
  const widget = fx.widgets.find((item) => item.type === type);
  if (widget === undefined) throw new Error(`no ${type} widget in the demo dashboard`);
  return widget;
};
const dashboardPath = () => `/b/${fx.baseId}/d/${fx.dashboardId}`;

/**
 * Every widget of the page has left its loading state, and none failed:
 * the browser zone is `Asia/Ho_Chi_Minh`, which Chromium reports as
 * `Asia/Saigon` — a name `postgres:18` did not know (500 before T819).
 */
async function widgetsLoaded(page: Page): Promise<void> {
  await expect(page.getByTestId('dashboard-grid')).toBeVisible();
  await expect(page.getByTestId('widget-skeleton')).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator('[data-testid="widget-state"][data-state="error"]')).toHaveCount(0);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  const { context, page } = await openAs(browser, users.admin);
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
    const demo = bases.items.find((item) => item.name === DEMO_BASE);
    if (demo !== undefined) fx.baseId = demo.id;
  }
  const tables = await ok<{ items: { id: string; name: string }[] }>(
    page,
    'GET',
    `/bases/${fx.baseId}/tables`,
  );
  fx.tickets = tables.items.find((table) => table.name === 'Tickets')?.id ?? '';
  const views = await ok<{ items: { id: string; name: string }[] }>(
    page,
    'GET',
    `/tables/${fx.tickets}/views`,
  );
  fx.ticketsView = views.items.find((view) => view.name === 'Tất cả phiếu')?.id ?? '';
  const roles = await ok<{ items: { id: string; name: string }[] }>(
    page,
    'GET',
    `/bases/${fx.baseId}/roles`,
  );
  fx.salesRole = roles.items.find((role) => role.name === 'Sales')?.id ?? '';
  const dashboards = await ok<{ items: { id: string; name: string }[] }>(
    page,
    'GET',
    `/bases/${fx.baseId}/dashboards`,
  );
  fx.dashboardId = dashboards.items.find((item) => item.name === DEMO_DASHBOARD)?.id ?? '';
  const dashboard = await ok<{ widgets: WidgetDto[] }>(
    page,
    'GET',
    `/dashboards/${fx.dashboardId}`,
  );
  fx.widgets = dashboard.widgets;
  // A public link (no password) the anonymous visitor opens.
  const link = await ok<{ token: string }>(
    page,
    'POST',
    `/dashboards/${fx.dashboardId}/share-links`,
    { audience: 'public', settings: { allow_export: true, dashboard: { tv_mode: true } } },
  );
  fx.token = link.token;
  // A dashboard in the trash, so the trash tab has a row.
  const spare = await ok<{ id: string }>(page, 'POST', `/bases/${fx.baseId}/dashboards`, {
    name: `QA S7 ${RUN}`,
  });
  await ok(page, 'DELETE', `/dashboards/${spare.id}`);
  await context.close();
  expect(fx.dashboardId).not.toBe('');
  expect(fx.ticketsView).not.toBe('');
});

for (const variant of VARIANTS) {
  test(`u_admin: every S7 screen at ${variant.name}`, async ({ browser }) => {
    test.setTimeout(240_000);
    const { context, page } = await openAs(browser, users.admin, variant);
    const csp = collectCspViolations(page);
    const at = (screen: string) => `${screen} ${variant.name}`;

    // The dashboard.
    await page.goto(dashboardPath());
    await widgetsLoaded(page);
    await audit(page, at('dashboard'));

    // A slicer open (the status control of the seed).
    const control =
      fx.widgets.find((item) => item.type === 'filter_control' && item.title === 'Trạng thái') ??
      widgetOf('filter_control');
    const controlButton = page.getByTestId(`filter-control-${control.id}-button`);
    if ((await controlButton.count()) > 0) {
      await controlButton.click();
      await expect(page.getByTestId(`filter-control-${control.id}-panel`)).toBeVisible();
      await audit(page, at('dashboard-slicer'));
      await page.keyboard.press('Escape');
    }

    // View records of the bar chart.
    const bar = widgetOf('bar');
    const barActions = page
      .getByTestId(`widget-${bar.id}`)
      .getByRole('button', { name: /^(Actions for|Thao tác với) / });
    await barActions.click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await audit(page, at('dashboard-widget-menu'));
    // The full-page screenshot of the audit resizes the page, which closes the menu.
    if (!(await menu.isVisible())) await barActions.click();
    await menu
      .getByRole('menuitem', { name: variant.language === 'vi' ? 'Xem record' : 'View records' })
      .click();
    const drawer = page.getByTestId('drill-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByTestId('drill-records')).toBeVisible({ timeout: 20_000 });
    await audit(page, at('dashboard-drill'));
    await drawer.getByTestId('drill-close').click();
    await expect(drawer).toBeHidden();

    // TV mode.
    await page.goto(`${dashboardPath()}?tv=1`);
    await expect(page.getByTestId('dashboard-tv-bar')).toBeVisible();
    await widgetsLoaded(page);
    await audit(page, at('dashboard-tv'));

    // The share dialog and its Embed tab.
    await page.goto(dashboardPath());
    await widgetsLoaded(page);
    await page.getByTestId('dashboard-share').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await audit(page, at('dashboard-share'));
    const embedTab = dialog.getByRole('tab', {
      name: variant.language === 'vi' ? 'Nhúng' : 'Embed',
    });
    if ((await embedTab.count()) > 0 && (await embedTab.isEnabled())) {
      await embedTab.click();
      await expect(dialog.getByTestId('share-embed')).toBeVisible();
      await audit(page, at('dashboard-share-embed'));
    }
    await page.keyboard.press('Escape');

    // Edit mode: the widget library and a chart's settings.
    if (variant.viewport.width >= 1024) {
      await page.goto(`${dashboardPath()}?edit=1`);
      await expect(page.getByTestId('dashboard-edit-bar')).toBeVisible();
      await widgetsLoaded(page);
      await audit(page, at('dashboard-edit'));
      await page.getByTestId('dashboard-add-widget').click();
      await expect(page.getByTestId('widget-library')).toBeVisible();
      await audit(page, at('dashboard-edit-library'));
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('widget-library')).toBeHidden();
      await page.getByTestId(`widget-${bar.id}`).getByTestId('widget-actions').click();
      await page.getByRole('menuitem').first().click();
      await expect(page.getByTestId('widget-panel')).toBeVisible();
      await audit(page, at('dashboard-edit-panel'));
      await page.getByTestId('widget-panel-close').click();
      await page.getByTestId('dashboard-edit-done').click();
    }

    // The dashboard trash.
    await page.goto(`/b/${fx.baseId}/trash?tab=dashboards`);
    await expect(page.getByText(`QA S7 ${RUN}`).filter({ visible: true })).toBeVisible();
    await audit(page, at('trash-dashboards'));

    // The role editor (Sales) and its Dashboards section.
    await page.goto(`/b/${fx.baseId}/settings/roles/${fx.salesRole}`);
    await expect(page.getByTestId('dashboard-section')).toBeVisible();
    await audit(page, at('role-dashboards'));

    // The color rules of the Tickets grid.
    await page.goto(`/b/${fx.baseId}/t/${fx.tickets}/v/${fx.ticketsView}`);
    const rulesButton = page.getByTestId('color-rules-button');
    await expect(rulesButton).toBeVisible({ timeout: 20_000 });
    await rulesButton.click();
    await expect(page.getByTestId('color-rule').first()).toBeVisible();
    await audit(page, at('color-rules'));
    await page.keyboard.press('Escape');

    expect(csp, `CSP violations at ${variant.name}`).toEqual([]);
    await context.close();
  });

  test(`u_sales1 and the public link at ${variant.name}`, async ({ browser }) => {
    test.setTimeout(120_000);
    const sales = await openAs(browser, users.sales1, variant);
    const csp = collectCspViolations(sales.page);
    await sales.page.goto(dashboardPath());
    await widgetsLoaded(sales.page);
    await audit(sales.page, `sales1-dashboard ${variant.name}`);
    expect(csp).toEqual([]);
    await sales.context.close();

    const visitor = await openAs(browser, null, variant);
    const visitorCsp = collectCspViolations(visitor.page);
    await visitor.page.goto(`/s/${fx.token}`);
    await widgetsLoaded(visitor.page);
    await audit(visitor.page, `shared-dashboard ${variant.name}`);
    await visitor.page.goto(`/s/${fx.token}?tv=1`);
    await widgetsLoaded(visitor.page);
    await audit(visitor.page, `shared-dashboard-tv ${variant.name}`);
    expect(visitorCsp).toEqual([]);
    await visitor.context.close();
  });
}

test('u_out: the dashboard is not found, in the app and the API', async ({ browser }) => {
  const { context, page } = await openAs(browser, users.out);
  await page.goto(dashboardPath());
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  const read = await api(page, 'GET', `/dashboards/${fx.dashboardId}`);
  expect(read.status).toBe(404);
  const data = await api(page, 'POST', `/widgets/${widgetOf('kpi').id}/data`, {});
  expect(data.status).toBe(404);
  await context.close();
});
