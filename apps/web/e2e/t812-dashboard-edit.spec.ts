import { type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { DEMO_PASSWORD } from './seed';
import { api, apiSignIn, collectCspViolations, expectNoSeriousA11yViolations, ok } from './support';

/**
 * T812: dashboards in edit mode (FRONTEND §18.2, SPEC §10, CONTRACTS §28),
 * in a workspace and base of their own: Orders (title, stage, owner, amount)
 * with three records; u_reader holds the system reader role of the base.
 *
 * - u_admin builds a dashboard through the UI: KPI, 100 % stacked bar,
 *   combo, pie, table and text, each from the widget library and its
 *   settings panel; drags the KPI to the right (the bar moves up), resizes
 *   it with the keyboard, undoes the last resize; after a reload the layout
 *   is the one left on screen (and the one the API has);
 * - u_reader opening `?edit=1` gets the view (no edit bar, `?edit` dropped);
 * - axe on the editor, the library and the panel, no CSP violation;
 *   Vietnamese at 375 px: the settings panel takes the whole screen.
 *
 * `afterAll` moves the base to the trash.
 */

const RUN = Date.now().toString(36);
const ADMIN_EMAIL = WORKER_ORG.email('admin');
const READER_EMAIL = WORKER_ORG.email('reader');

interface Fixture {
  baseId: string;
  orders: string;
  dashboardId: string;
}

const fx = {} as Fixture;

type Cookies = Awaited<ReturnType<BrowserContext['cookies']>>;
const cookies: Record<string, Cookies> = {};

interface Layout {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface DashboardBody {
  version: number;
  widgets: { id: string; type: string; title: string; layout: Layout; config: unknown }[];
}

/** A new context signed in as `email` (once per user and spec: 20 sign-ins a minute per IP). */
async function openAs(
  browser: Browser,
  email: string,
  options: { viewport?: { width: number; height: number }; language?: 'en' | 'vi' } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1440, height: 1000 },
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
    name: `T812 ${RUN}`,
  });
  const base = await ok<{ id: string }>(page, 'POST', `/workspaces/${workspace.id}/bases`, {
    name: `Dashboard T812 ${RUN}`,
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
    ok<{ id: string; options: { options?: { id: string; name: string }[] } }>(
      page,
      'POST',
      `/tables/${orders.id}/fields`,
      { name, type, options },
    );
  const stage = await add('stage', 'select', {
    multiple: false,
    options: [
      { name: 'New', color: 1 },
      { name: 'Won', color: 2 },
    ],
  });
  await add('owner', 'user', { multiple: false });
  const amount = await add('amount', 'number');
  const [fresh, won] = stage.options.options ?? [];
  await ok(page, 'POST', `/tables/${orders.id}/records?field_key_type=id`, {
    records: [
      { fields: { [orders.primary_field_id]: 'r1', [stage.id]: fresh?.id, [amount.id]: 100 } },
      { fields: { [orders.primary_field_id]: 'r2', [stage.id]: won?.id, [amount.id]: 200 } },
      { fields: { [orders.primary_field_id]: 'r3', [stage.id]: won?.id, [amount.id]: 300 } },
    ],
  });

  const dashboard = await ok<{ id: string }>(page, 'POST', `/bases/${base.id}/dashboards`, {
    name: `Sales T812 ${RUN}`,
  });
  fx.dashboardId = dashboard.id;

  // u_reader reads the base (system reader role).
  const principals = await ok<{ items: { principal_id: string; email: string | null }[] }>(
    page,
    'GET',
    `/bases/${base.id}/principals?limit=200`,
  );
  const reader = principals.items.find((item) => item.email === READER_EMAIL)?.principal_id;
  const roles = await ok<{ items: { id: string; kind: string }[] }>(
    page,
    'GET',
    `/bases/${base.id}/roles`,
  );
  await ok(page, 'PUT', `/bases/${base.id}/role-assignments`, {
    principal_type: 'user',
    principal_id: reader,
    role_id: roles.items.find((role) => role.kind === 'system_reader')?.id,
  });
}

const dashboardOf = (page: Page) => ok<DashboardBody>(page, 'GET', `/dashboards/${fx.dashboardId}`);

const editPath = () => `/b/${fx.baseId}/d/${fx.dashboardId}?edit=1`;

/** Adds a widget from the library; its settings panel opens. */
async function addWidget(page: Page, type: string, title: string): Promise<void> {
  await page.getByTestId('dashboard-add-widget').click();
  const library = page.getByTestId('widget-library');
  await expect(library).toBeVisible();
  await library.getByTestId(`widget-library-${type}`).click();
  await expect(library).toBeHidden();
  const panel = page.getByTestId('widget-panel');
  await expect(panel).toBeVisible();
  await panel.getByTestId('widget-title-input').fill(title);
}

/** Waits for the panel and the editor to have saved everything, then closes the panel. */
async function closePanel(page: Page): Promise<void> {
  const panel = page.getByTestId('widget-panel');
  await expect(panel.getByTestId('widget-panel-state')).toHaveText('Saved');
  await panel.getByTestId('widget-panel-close').click();
  await expect(panel).toBeHidden();
  await expect(page.getByTestId('dashboard-save-state')).toHaveText('All changes saved');
}

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  if (found === null) throw new Error('Not on screen');
  return found;
}

function widgetOfType(dashboard: DashboardBody, type: string) {
  const found = dashboard.widgets.find((widget) => widget.type === type);
  if (found === undefined) throw new Error(`No ${type} widget`);
  return found;
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

test('u_admin builds a dashboard of six widgets, arranges it and undoes', async ({ browser }) => {
  const { context, page } = await openAs(browser, ADMIN_EMAIL);
  const csp = collectCspViolations(page);
  await page.goto(`/b/${fx.baseId}/d/${fx.dashboardId}`);
  await page.getByTestId('dashboard-edit').click();
  await expect(page).toHaveURL(/\?edit=1$/u);
  await expect(page.getByTestId('dashboard-edit-bar')).toBeVisible();
  await expect(page.getByTestId('dashboard-empty')).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'empty editor');

  await test.step('KPI', async () => {
    await page.getByTestId('dashboard-add-widget').click();
    await expectNoSeriousA11yViolations(page, 'widget library');
    await page.keyboard.press('Escape');
    await addWidget(page, 'kpi', 'Orders');
    await expectNoSeriousA11yViolations(page, 'settings panel (KPI)');
    await closePanel(page);
  });
  await test.step('100 % stacked bar', async () => {
    await addWidget(page, 'bar', 'Orders by stage');
    await page.getByTestId('widget-panel').getByTestId('display-stack').selectOption('percent');
    await closePanel(page);
  });
  await test.step('combo (count as bars, sum of amount as a line)', async () => {
    await addWidget(page, 'combo', 'Count and amount');
    await closePanel(page);
  });
  await test.step('pie', async () => {
    await addWidget(page, 'pie', 'Share by stage');
    await closePanel(page);
  });
  await test.step('table', async () => {
    await addWidget(page, 'table', 'Latest orders');
    await closePanel(page);
  });
  await test.step('text', async () => {
    await addWidget(page, 'text', 'Notes');
    await page.getByTestId('widget-panel').getByTestId('markdown-input').fill('**Weekly** review');
    await closePanel(page);
  });

  const built = await dashboardOf(page);
  expect(built.widgets.map((widget) => widget.type).sort()).toEqual(
    ['bar', 'combo', 'kpi', 'pie', 'table', 'text'].sort(),
  );
  const byType = (type: string) => widgetOfType(built, type);
  const kpi = byType('kpi');
  const bar = byType('bar');
  expect(bar.config).toMatchObject({ display: { stack: 'percent' } });
  expect(byType('combo').config).toMatchObject({
    metrics: [
      { aggregation: 'count', chart: 'bar', axis: 'left' },
      { aggregation: 'sum', chart: 'line', axis: 'right' },
    ],
  });
  // New widgets go below the others: the KPI on top, the bar under it.
  expect(kpi.layout).toEqual({ x: 0, y: 0, w: 3, h: 4 });
  expect(bar.layout).toMatchObject({ x: 0, y: 4 });
  const kpiCard = page.getByTestId(`widget-${kpi.id}`);
  await expect(kpiCard.getByTestId('kpi-value')).toHaveText('3');
  await expect(page.getByTestId(`widget-${byType('text').id}`)).toContainText('Weekly review');

  await test.step('drag the KPI to the right: the bar moves up', async () => {
    const grid = page.getByTestId('dashboard-grid');
    await expect(grid).toHaveAttribute('data-layout', 'grid');
    // The last widget added was scrolled to: back to the top row.
    await kpiCard.scrollIntoViewIfNeeded();
    const gridBox = await box(grid);
    const cardBox = await box(kpiCard);
    const handle = kpiCard.getByTestId('widget-drag-handle');
    const handleBox = await box(handle);
    const column = (gridBox.width + 16) / 12;
    const startX = handleBox.x + handleBox.width / 2;
    const startY = handleBox.y + handleBox.height / 2;
    // Card's left edge to column 7 (x = 6), top edge unchanged.
    const dx = gridBox.x + 6 * column - cardBox.x;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    for (let step = 1; step <= 10; step += 1) {
      await page.mouse.move(startX + (dx * step) / 10, startY + 2);
    }
    await page.mouse.up();
    await expect
      .poll(async () => (await dashboardOf(page)).widgets.find((w) => w.id === kpi.id)?.layout)
      .toEqual({ x: 6, y: 0, w: 3, h: 4 });
    const after = await dashboardOf(page);
    expect(after.widgets.find((widget) => widget.id === bar.id)?.layout).toMatchObject({
      x: 0,
      y: 0,
    });
  });

  const resizeWithKeys = async (keys: string[]) => {
    await kpiCard.getByTestId('widget-actions').click();
    await page.getByRole('menuitem', { name: 'Resize with the keyboard' }).click();
    await expect(kpiCard).toBeFocused();
    await expect(page.getByTestId('widget-keyboard-hint')).toBeVisible();
    for (const key of keys) await page.keyboard.press(key);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('dashboard-announcer')).toHaveText('Position kept');
  };

  await test.step('resize the KPI with the keyboard, twice', async () => {
    await resizeWithKeys(['ArrowRight', 'ArrowRight']);
    await expect(page.getByTestId('widget-keyboard-hint')).toBeHidden();
    await resizeWithKeys(['ArrowDown']);
    await expect
      .poll(async () => (await dashboardOf(page)).widgets.find((w) => w.id === kpi.id)?.layout)
      .toEqual({ x: 6, y: 0, w: 5, h: 5 });
  });

  await test.step('undo takes back the last resize only', async () => {
    await page.getByTestId('dashboard-undo').click();
    await expect(page.getByTestId('dashboard-announcer')).toHaveText('Undone');
    await expect
      .poll(async () => (await dashboardOf(page)).widgets.find((w) => w.id === kpi.id)?.layout)
      .toEqual({ x: 6, y: 0, w: 5, h: 4 });
    await expect(page.getByTestId('dashboard-redo')).toBeEnabled();
  });

  await test.step('after a reload the layout is the one left on screen', async () => {
    const saved = await dashboardOf(page);
    await page.reload();
    await expect(page.getByTestId('dashboard-edit-bar')).toBeVisible();
    // Undo history is not kept across a reload.
    await expect(page.getByTestId('dashboard-undo')).toBeDisabled();
    await expect(kpiCard).toBeVisible();
    const reloaded = await dashboardOf(page);
    expect(reloaded.widgets.map((widget) => [widget.id, widget.layout])).toEqual(
      saved.widgets.map((widget) => [widget.id, widget.layout]),
    );
    // On screen: the KPI right of the bar, both on the first row, the KPI 5 columns wide.
    const kpiBox = await box(kpiCard);
    const barBox = await box(page.getByTestId(`widget-${bar.id}`));
    expect(kpiBox.x).toBeGreaterThan(barBox.x + barBox.width - 1);
    expect(Math.abs(kpiBox.y - barBox.y)).toBeLessThan(2);
    const gridBox = await box(page.getByTestId('dashboard-grid'));
    const column = (gridBox.width + 16) / 12;
    expect(Math.abs(kpiBox.width - (5 * column - 16))).toBeLessThan(3);
    await expectNoSeriousA11yViolations(page, 'editor with six widgets');
  });

  await page.getByTestId('dashboard-edit-done').click();
  await expect(page).not.toHaveURL(/edit=1/u);
  await expect(page.getByTestId('dashboard-edit-bar')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('t812-admin-view.png') });
  expect(csp).toEqual([]);
  await context.close();
});

test('u_reader opening ?edit=1 gets the view', async ({ browser }) => {
  const { context, page } = await openAs(browser, READER_EMAIL);
  await page.goto(editPath());
  await expect(page.getByTestId('dashboard-title')).toHaveText(`Sales T812 ${RUN}`);
  await expect(page).not.toHaveURL(/edit=1/u);
  await expect(page.getByTestId('dashboard-edit-bar')).toHaveCount(0);
  await expect(page.getByTestId('dashboard-edit')).toHaveCount(0);
  await expect(page.getByTestId('widget-actions')).toHaveCount(0);
  await expectNoSeriousA11yViolations(page, 'reader view');
  await context.close();
});

test('in Vietnamese at 375 px the settings panel takes the whole screen', async ({ browser }) => {
  const { context, page } = await openAs(browser, ADMIN_EMAIL, {
    viewport: { width: 375, height: 812 },
    language: 'vi',
  });
  const kpi = widgetOfType(await dashboardOf(page), 'kpi');
  await page.goto(editPath());
  await expect(page.getByTestId('dashboard-edit-bar')).toBeVisible();
  await expect(page.getByTestId('dashboard-grid')).toHaveAttribute('data-layout', 'column');
  await noHorizontalScroll(page, 375);
  const card = page.getByTestId(`widget-${kpi.id}`);
  await card.getByRole('button', { name: 'Thao tác với Orders' }).click();
  await page.getByRole('menuitem', { name: 'Cài đặt' }).click();
  const panel = page.getByTestId('widget-panel');
  await expect(panel).toBeVisible();
  const panelBox = await box(panel);
  expect(panelBox.x).toBe(0);
  expect(panelBox.width).toBe(375);
  await expect(panel.getByTestId('widget-panel-preview')).toBeVisible();
  await noHorizontalScroll(page, 375);
  await expectNoSeriousA11yViolations(page, 'settings panel vi 375');
  await page.screenshot({ path: test.info().outputPath('t812-vi-375-panel.png') });
  await panel.getByRole('button', { name: 'Đóng cài đặt' }).click();
  await expect(panel).toBeHidden();
  await expect(card).toBeFocused();
  await context.close();
});
