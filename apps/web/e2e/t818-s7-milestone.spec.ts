import { readFile } from 'node:fs/promises';

import { type Browser, type BrowserContext, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { E2E_WEB_URL } from './ports';
import { DEMO_PASSWORD } from './seed';
import { api, apiSignIn, collectCspViolations, ok } from './support';

/**
 * Mốc S7 (BACKLOG T818, S§22 as adjusted by the S7 decisions), end to end in
 * a workspace and base of their own: Orders (title, priority, owner,
 * province, district, amount, cost) with r1 (Khẩn, u_sales1, Hà Nội / Ba
 * Đình, 100, cost 150), r2 (Thường, u_sales2, Hà Nội / Cầu Giấy, 200, cost
 * 20) and r3 (Khẩn, u_sales2, Hồ Chí Minh / Quận 1, 300, cost 130). A role
 * "Sales" reads its own Orders (owner = the viewer), never `cost`, reads
 * dashboard D, may share and download. D starts with two slicers, Province
 * → District.
 *
 * - u_admin adds five widgets to D through the UI (KPI count, KPI sum of
 *   cost, bar by priority, pie by province, records table) — P21: u_sales1
 *   counts 1 and the cost KPI says "no permission" without a number;
 * - clicking "Khẩn" in the bar filters every Orders widget;
 * - Province "Hà Nội" → District lists its districts only;
 * - u_sales1's public link of D shows u_sales1's numbers and no cost, and
 *   is framed only by the allowed site;
 * - a view link (district hidden in the view) downloads a CSV without
 *   district or cost;
 * - row colors: "cost > 100 → red" paints r1 for u_admin, never for
 *   u_sales1, whose r1 takes the next rule "amount ≥ 100 → green";
 * - a password reset (the /reset page, "Revoke all my API tokens" on by
 *   default) revokes the member's API token: 401.
 *
 * `afterAll` moves the base to the trash and removes the invited member.
 */

const RUN = Date.now().toString(36);
const ADMIN_EMAIL = WORKER_ORG.email('admin');
const SALES1_EMAIL = WORKER_ORG.email('sales1');
const SALES2_EMAIL = WORKER_ORG.email('sales2');
const MEMBER_EMAIL = `t818-${RUN}+${WORKER_ORG.tag}@cellhive.test`;
const NEW_PASSWORD = 'Cellhive-T818-new-2026';
const DASHBOARD_NAME = `Doanh số T818 ${RUN}`;
const VIEW_NAME = `Đơn T818 ${RUN}`;
const ALLOWED_SITE = 'https://embed-allowed.test';
const OTHER_SITE = 'https://embed-other.test';
/** Canvas rows (CSS px): header 36, compact rows 34. */
const ROW_Y = [36 + 17, 36 + 34 + 17, 36 + 68 + 17] as const;

interface Field {
  id: string;
  options: { options?: { id: string; name: string }[] };
}

const fx = {
  orgId: '',
  baseId: '',
  orders: '',
  gridView: '',
  hiddenView: '',
  dashboardId: '',
  province: '',
  district: '',
  fields: {} as Record<string, string>,
  widgets: {} as Record<string, string>,
  dashboardToken: '',
  memberId: '',
};

type Cookies = Awaited<ReturnType<BrowserContext['cookies']>>;
const cookies: Record<string, Cookies> = {};

/** A new context signed in as `email` (once per user and spec: 20 sign-ins a minute per IP). */
async function openAs(
  browser: Browser,
  email: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: 'en-US',
  });
  await context.addInitScript(() => {
    window.localStorage.setItem('cellhive.language', 'en');
  });
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

/** A browser without any session (someone the link was sent to). */
async function anonymous(
  browser: Browser,
  permissions: string[] = [],
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    locale: 'en-US',
    acceptDownloads: true,
    permissions,
  });
  await context.addInitScript(() => {
    window.localStorage.setItem('cellhive.language', 'en');
  });
  return { context, page: await context.newPage() };
}

async function buildFixture(page: Page): Promise<void> {
  const me = await ok<{ orgs: { id: string; name: string }[] }>(page, 'GET', '/me');
  fx.orgId = me.orgs.find((org) => org.name === WORKER_ORG.orgName)?.id ?? '';
  const workspace = await ok<{ id: string }>(page, 'POST', `/orgs/${fx.orgId}/workspaces`, {
    name: `T818 ${RUN}`,
  });
  const base = await ok<{ id: string }>(page, 'POST', `/workspaces/${workspace.id}/bases`, {
    name: `Mốc S7 T818 ${RUN}`,
  });
  fx.baseId = base.id;
  const orders = await ok<{ id: string; primary_field_id: string }>(
    page,
    'POST',
    `/bases/${base.id}/tables`,
    { name: 'Orders', primary_field_name: 'title' },
  );
  fx.orders = orders.id;
  const add = async (name: string, type: string, options: unknown = {}) => {
    const field = await ok<Field>(page, 'POST', `/tables/${orders.id}/fields`, {
      name,
      type,
      options,
    });
    fx.fields[name] = field.id;
    return field;
  };
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
  const cost = await add('cost', 'number');
  const option = (field: Field, name: string) =>
    field.options.options?.find((item) => item.name === name)?.id;

  const principals = await ok<{ items: { principal_id: string; email: string | null }[] }>(
    page,
    'GET',
    `/bases/${base.id}/principals?limit=200`,
  );
  const user = (email: string) =>
    principals.items.find((item) => item.email === email)?.principal_id ?? '';
  const row = (
    title: string,
    level: string,
    who: string,
    city: string,
    area: string,
    value: number,
    spent: number,
  ) => ({
    fields: {
      [orders.primary_field_id]: title,
      [priority.id]: option(priority, level),
      [owner.id]: [{ id: who }],
      [province.id]: option(province, city),
      [district.id]: option(district, area),
      [amount.id]: value,
      [cost.id]: spent,
    },
  });
  await ok(page, 'POST', `/tables/${orders.id}/records?field_key_type=id`, {
    records: [
      row('r1', 'Khẩn', user(SALES1_EMAIL), 'Hà Nội', 'Ba Đình', 100, 150),
      row('r2', 'Thường', user(SALES2_EMAIL), 'Hà Nội', 'Cầu Giấy', 200, 20),
      row('r3', 'Khẩn', user(SALES2_EMAIL), 'Hồ Chí Minh', 'Quận 1', 300, 130),
    ],
  });

  // The grid view: "cost > 100 → red row", then "amount ≥ 100 → green row".
  const views = await ok<{ items: { id: string }[] }>(page, 'GET', `/tables/${orders.id}/views`);
  fx.gridView = views.items[0]?.id ?? '';
  const rule = (id: string, field: string, operator: string, value: number, color: string) => ({
    id,
    enabled: true,
    filter: { op: 'and', items: [{ field, operator, value }] },
    color,
    target: 'row',
    field_id: null,
  });
  await ok(page, 'PATCH', `/views/${fx.gridView}`, {
    config: {
      row_height: 'short',
      color_rules: [
        rule(`clr_T818Cost${RUN.padEnd(8, '0').slice(0, 8)}`, cost.id, 'gt', 100, 'red'),
        rule(`clr_T818Amnt${RUN.padEnd(8, '0').slice(0, 8)}`, amount.id, 'gte', 100, 'green'),
      ],
    },
  });
  // A second view hiding the district: its link's export leaves it out.
  const hidden = await ok<{ id: string }>(page, 'POST', `/tables/${orders.id}/views`, {
    name: VIEW_NAME,
    type: 'grid',
    config: { hidden_fields: [district.id] },
  });
  fx.hiddenView = hidden.id;

  // Dashboard D with the two slicers; the widgets come from the UI.
  const dashboard = await ok<{ id: string }>(page, 'POST', `/bases/${base.id}/dashboards`, {
    name: DASHBOARD_NAME,
  });
  fx.dashboardId = dashboard.id;
  const control = async (body: Record<string, unknown>) =>
    (await ok<{ id: string }>(page, 'POST', `/dashboards/${dashboard.id}/widgets`, body)).id;
  fx.province = await control({
    type: 'filter_control',
    title: 'Province',
    config: { table_id: orders.id, field: province.id, control: 'select' },
    layout: { x: 0, y: 0, w: 3, h: 2 },
  });
  fx.district = await control({
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

  const sales = await ok<{ id: string }>(page, 'POST', `/bases/${base.id}/roles`, {
    name: `Sales ${RUN}`,
    config: {
      base_rule: { copy: false, download: true, share_link: true },
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
          field_rule: {
            mode: 'specify',
            fields: { [cost.id]: 'no_perm' },
            option_edit_fields: [],
            file_download_fields: [],
          },
        },
      },
      dashboards: { [dashboard.id]: 'read_only' },
    },
  });
  await ok(page, 'PUT', `/bases/${base.id}/role-assignments`, {
    principal_type: 'user',
    principal_id: user(SALES1_EMAIL),
    role_id: sales.id,
  });
}

const dashboardUrl = () => `/b/${fx.baseId}/d/${fx.dashboardId}`;
const kpi = (page: Page, widgetId: string) =>
  page.getByTestId(`widget-${widgetId}`).getByTestId('kpi-value');

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

async function pick(page: Page, control: string, option: string): Promise<void> {
  const prefix = `filter-control-${control}`;
  await page.getByTestId(`${prefix}-button`).click();
  const panel = page.getByTestId(`${prefix}-panel`);
  await panel.getByRole('checkbox', { name: option }).check();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
}

/** A page of `site` that frames `src` (as the embed code does), answered by the test. */
async function hostPage(page: Page, site: string, src: string): Promise<void> {
  await page.route(`${site}/**`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html lang="en"><head><title>Host</title></head><body><main><h1>Host</h1><iframe id="frame" src="${src}" title="Shared dashboard" width="1000" height="700" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-downloads"></iframe></main></body></html>`,
    }),
  );
  await page.goto(`${site}/intranet.html`);
}

/** `#rrggbb` of a CSS custom property of `<html>`, as `[r, g, b]`. */
async function tokenRgb(page: Page, name: string): Promise<number[]> {
  const hex = await page.evaluate(
    (token) => getComputedStyle(document.documentElement).getPropertyValue(token).trim(),
    name,
  );
  return [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
}

/** Whether most of the canvas row at `y` (CSS px) is painted `rgb` (text pixels aside). */
async function rowPainted(page: Page, y: number, rgb: readonly number[]): Promise<boolean> {
  return page.evaluate(
    ([py, color]) => {
      const canvas = document.querySelector<HTMLCanvasElement>(
        '.ob-grid [data-testid="data-grid-canvas"]',
      );
      const context = canvas?.getContext('2d') ?? null;
      if (canvas === null || context === null) return false;
      const ratio = canvas.width / canvas.getBoundingClientRect().width;
      let hits = 0;
      let samples = 0;
      for (let x = 120; x < 600; x += 8) {
        const [r = 0, g = 0, b = 0] = context.getImageData(x * ratio, py * ratio, 1, 1).data;
        samples += 1;
        if (
          Math.abs(r - (color[0] ?? 0)) <= 2 &&
          Math.abs(g - (color[1] ?? 0)) <= 2 &&
          Math.abs(b - (color[2] ?? 0)) <= 2
        ) {
          hits += 1;
        }
      }
      return hits > samples / 2;
    },
    [y, rgb] as const,
  );
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
  if (fx.memberId !== '') await api(page, 'DELETE', `/orgs/${fx.orgId}/members/${fx.memberId}`);
  await context.close();
});

test('u_admin adds five widgets through the UI; u_sales1 counts r1 only and sees no cost (P21)', async ({
  browser,
}) => {
  const admin = await openAs(browser, ADMIN_EMAIL);
  const page = admin.page;
  const csp = collectCspViolations(page);
  await page.goto(dashboardUrl());
  await page.getByTestId('dashboard-edit').click();
  await expect(page.getByTestId('dashboard-edit-bar')).toBeVisible();
  const panel = page.getByTestId('widget-panel');

  await addWidget(page, 'kpi', 'Orders');
  await closePanel(page);
  await addWidget(page, 'kpi', 'Cost');
  await panel.getByTestId('metric-0-aggregation').selectOption('sum');
  await panel.getByTestId('metric-0-field').selectOption({ label: 'cost' });
  await closePanel(page);
  await addWidget(page, 'bar', 'By priority');
  await panel.getByTestId('dimension-field').selectOption({ label: 'priority' });
  await closePanel(page);
  await addWidget(page, 'pie', 'By province');
  await panel.getByTestId('dimension-field').selectOption({ label: 'province' });
  await closePanel(page);
  await addWidget(page, 'table', 'Orders list');
  await closePanel(page);

  // The five widgets follow both slicers (bound from the slicers' panels in
  // the UI; here through the API to keep the milestone short).
  const built = await ok<{
    widgets: { id: string; type: string; title: string; config: Record<string, unknown> }[];
  }>(page, 'GET', `/dashboards/${fx.dashboardId}`);
  const data = built.widgets.filter((widget) => widget.type !== 'filter_control');
  expect(data.map((widget) => widget.type).sort()).toEqual(
    ['bar', 'kpi', 'kpi', 'pie', 'table'].sort(),
  );
  for (const widget of data) {
    fx.widgets[widget.title] = widget.id;
    await ok(page, 'PATCH', `/widgets/${widget.id}`, {
      config: { ...widget.config, filter_bindings: [fx.province, fx.district] },
    });
  }
  await page.goto(dashboardUrl());
  await expect(page.getByTestId('dashboard-edit-bar')).toBeHidden();
  await expect(kpi(page, fx.widgets['Orders'] ?? '')).toHaveText('3');
  await expect(kpi(page, fx.widgets['Cost'] ?? '')).toHaveText('300');
  expect(csp).toEqual([]);
  await admin.context.close();

  const sales = await openAs(browser, SALES1_EMAIL);
  await sales.page.goto(dashboardUrl());
  await expect(kpi(sales.page, fx.widgets['Orders'] ?? '')).toHaveText('1');
  const costCard = sales.page.getByTestId(`widget-${fx.widgets['Cost'] ?? ''}`);
  await expect(costCard).toContainText("You don't have permission to see this widget's data");
  await expect(costCard.getByTestId('kpi-value')).toHaveCount(0);
  await expect(costCard).not.toContainText('150');
  await expect(
    sales.page.getByTestId(`widget-${fx.widgets['By priority'] ?? ''}`).getByTestId('widget-chart'),
  ).toHaveAccessibleName(/1 group/u);
  await sales.context.close();
});

test('"Khẩn" in the bar filters every Orders widget', async ({ browser }) => {
  const { context, page } = await openAs(browser, ADMIN_EMAIL);
  await page.goto(dashboardUrl());
  const orders = fx.widgets['Orders'] ?? '';
  const cost = fx.widgets['Cost'] ?? '';
  const bar = fx.widgets['By priority'] ?? '';
  await expect(kpi(page, orders)).toHaveText('3');
  const chart = page.getByTestId(`widget-${bar}`).getByTestId('widget-chart');
  await chart.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId(`widget-${bar}`).getByTestId('chart-live')).toContainText('Khẩn');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId(`cross-chip-${bar}`)).toHaveText(/Filtered by: Khẩn/u);
  await expect(kpi(page, orders)).toHaveText('2');
  await expect(kpi(page, cost)).toHaveText('280');
  const pie = page.getByTestId(`widget-${fx.widgets['By province'] ?? ''}`);
  await expect(pie.getByTestId('widget-chart')).toHaveAccessibleName(/2 groups/u);
  await context.close();
});

test('slicers cascade: Hà Nội lists its districts only', async ({ browser }) => {
  const { context, page } = await openAs(browser, ADMIN_EMAIL);
  await page.goto(dashboardUrl());
  const orders = fx.widgets['Orders'] ?? '';
  await expect(kpi(page, orders)).toHaveText('3');
  await pick(page, fx.province, 'Hà Nội');
  await expect(kpi(page, orders)).toHaveText('2');
  await page.getByTestId(`filter-control-${fx.district}-button`).click();
  const districts = page.getByTestId(`filter-control-${fx.district}-panel`);
  await expect(districts.getByRole('listitem')).toHaveText(['Ba Đình', 'Cầu Giấy']);
  await districts.getByRole('checkbox', { name: 'Ba Đình' }).check();
  await page.keyboard.press('Escape');
  await expect(kpi(page, orders)).toHaveText('1');
  await expect(kpi(page, fx.widgets['Cost'] ?? '')).toHaveText('150');
  await context.close();
});

test('u_sales1’s public link: its numbers, no cost; framed by the allowed site only', async ({
  browser,
}) => {
  const sales = await openAs(browser, SALES1_EMAIL);
  const link = await ok<{ token: string }>(
    sales.page,
    'POST',
    `/dashboards/${fx.dashboardId}/share-links`,
    {
      audience: 'public',
      settings: { embed: { enabled: true, allowed_origins: [ALLOWED_SITE] } },
    },
  );
  fx.dashboardToken = link.token;
  await sales.context.close();

  const visitor = await anonymous(browser);
  const answers: Promise<string>[] = [];
  visitor.page.on('response', (response) => {
    if (response.url().includes('/api/v1/shares/')) {
      answers.push(response.text().catch(() => ''));
    }
  });
  await visitor.page.goto(`/s/${fx.dashboardToken}`);
  await expect(visitor.page.getByTestId('dashboard-title')).toHaveText(DASHBOARD_NAME);
  await expect(kpi(visitor.page, fx.widgets['Orders'] ?? '')).toHaveText('1');
  const costCard = visitor.page.getByTestId(`widget-${fx.widgets['Cost'] ?? ''}`);
  await expect(costCard).toContainText("You don't have permission to see this widget's data");
  await expect(costCard.getByTestId('kpi-value')).toHaveCount(0);
  // Nothing the visitor's browser received names cost or its values.
  const bodies = await Promise.all(answers);
  const config = await ok<{ widgets: { config: unknown }[] }>(
    visitor.page,
    'GET',
    `/shares/${fx.dashboardToken}/dashboard`,
  );
  expect(JSON.stringify(config)).not.toContain(fx.fields['cost'] ?? 'cost');
  for (const body of bodies) expect(body).not.toContain(fx.fields['cost'] ?? 'cost');
  await expect(visitor.page.getByText('r2')).toHaveCount(0);
  await visitor.context.close();

  const src = `${E2E_WEB_URL}/s/${fx.dashboardToken}?embed=1`;
  const allowed = await anonymous(browser, ['local-network-access']);
  await hostPage(allowed.page, ALLOWED_SITE, src);
  const frame = allowed.page.frameLocator('#frame');
  await expect(frame.getByTestId('dashboard-title')).toHaveText(DASHBOARD_NAME);
  await expect(
    frame.getByTestId(`widget-${fx.widgets['Orders'] ?? ''}`).getByTestId('kpi-value'),
  ).toHaveText('1');
  await allowed.context.close();

  const other = await anonymous(browser, ['local-network-access']);
  const refused = collectCspViolations(other.page);
  await hostPage(other.page, OTHER_SITE, src);
  await expect.poll(() => refused.join('\n')).toContain('frame-ancestors');
  await expect(other.page.frameLocator('#frame').getByTestId('dashboard-title')).toHaveCount(0);
  await other.context.close();
});

test('a view link’s CSV has neither the hidden district nor cost', async ({ browser }) => {
  const sales = await openAs(browser, SALES1_EMAIL);
  const link = await ok<{ token: string }>(
    sales.page,
    'POST',
    `/views/${fx.hiddenView}/share-links`,
    { audience: 'public', settings: { allow_export: true } },
  );
  await sales.context.close();

  const visitor = await anonymous(browser);
  await visitor.page.goto(`/s/${link.token}`);
  await expect(visitor.page.getByRole('heading', { name: VIEW_NAME, level: 1 })).toBeVisible();
  await expect(visitor.page.getByText('1 record')).toBeVisible();
  await visitor.page.getByTestId('share-export').click();
  const [download] = await Promise.all([
    visitor.page.waitForEvent('download'),
    visitor.page.getByRole('menuitem', { name: 'CSV' }).click(),
  ]);
  const csv = (await readFile(await download.path())).toString('utf8').replace(/^\uFEFF/u, '');
  const [header, ...rows] = csv.trim().split(/\r?\n/u);
  expect(header).toContain('title');
  expect(header).toContain('province');
  expect(header).not.toContain('district');
  expect(header).not.toContain('cost');
  expect(rows).toHaveLength(1);
  expect(rows[0]).toContain('r1');
  expect(rows[0]).not.toContain('Ba Đình');
  expect(rows[0]).not.toContain('150');
  await visitor.context.close();
});

test('row colors follow the reader’s permissions', async ({ browser }) => {
  const gridUrl = `/b/${fx.baseId}/t/${fx.orders}/v/${fx.gridView}`;
  const admin = await openAs(browser, ADMIN_EMAIL);
  await admin.page.goto(gridUrl);
  await expect(admin.page.locator('.ob-grid [data-testid="data-grid-canvas"]')).toBeVisible();
  const red = await tokenRgb(admin.page, '--rule-red-bg');
  const green = await tokenRgb(admin.page, '--rule-green-bg');
  // r1 (cost 150) red, r2 (cost 20, amount 200) green, r3 (cost 130) red.
  await expect.poll(() => rowPainted(admin.page, ROW_Y[0], red)).toBe(true);
  await expect.poll(() => rowPainted(admin.page, ROW_Y[1], green)).toBe(true);
  await expect.poll(() => rowPainted(admin.page, ROW_Y[2], red)).toBe(true);
  await admin.context.close();

  const sales = await openAs(browser, SALES1_EMAIL);
  await sales.page.goto(gridUrl);
  await expect(sales.page.locator('.ob-grid [data-testid="data-grid-canvas"]')).toBeVisible();
  // u_sales1 cannot read cost: the red rule is not theirs; r1 takes the green one.
  await expect.poll(() => rowPainted(sales.page, ROW_Y[0], green)).toBe(true);
  expect(await rowPainted(sales.page, ROW_Y[0], red)).toBe(false);
  await sales.context.close();
});

test('a password reset revokes the member’s API tokens', async ({ browser, request }) => {
  const admin = await openAs(browser, ADMIN_EMAIL);
  const invitation = await ok<{ invite_url: string }>(
    admin.page,
    'POST',
    `/orgs/${fx.orgId}/invitations`,
    { email: MEMBER_EMAIL, role: 'member' },
  );

  const member = await anonymous(browser);
  const inviteToken = new URL(invitation.invite_url).pathname.split('/').pop() ?? '';
  await member.page.goto('/login');
  const accepted = await ok<{ user: { id: string } }>(
    member.page,
    'POST',
    `/invitations/${inviteToken}/accept`,
    { display_name: `T818 ${RUN}`, password: DEMO_PASSWORD },
  );
  fx.memberId = accepted.user.id;
  await apiSignIn(member.page, MEMBER_EMAIL, DEMO_PASSWORD);
  const created = await ok<{ token: string }>(
    member.page,
    'POST',
    `/orgs/${fx.orgId}/me/api-tokens`,
    {
      name: `T818 ${RUN}`,
      scopes: ['records:read', 'schema:read'],
      expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    },
  );
  const bearer = { authorization: `Bearer ${created.token}` };
  expect((await request.get('/api/v1/me', { headers: bearer })).status()).toBe(200);
  await member.context.close();

  // The administrator's link keeps the tokens; the member's own choice on /reset decides.
  const reset = await ok<{ reset_url: string }>(
    admin.page,
    'POST',
    `/orgs/${fx.orgId}/members/${fx.memberId}/password-reset`,
    { revoke_tokens: false },
  );
  await admin.context.close();
  expect((await request.get('/api/v1/me', { headers: bearer })).status()).toBe(200);

  const visitor = await anonymous(browser);
  await visitor.page.goto(new URL(reset.reset_url).pathname);
  await visitor.page.getByLabel('New password').fill(NEW_PASSWORD);
  await visitor.page.getByLabel('Confirm password').fill(NEW_PASSWORD);
  await expect(
    visitor.page.getByRole('checkbox', { name: 'Revoke all my API tokens' }),
  ).toBeChecked();
  await visitor.page.getByRole('button', { name: 'Change password' }).click();
  await expect(visitor.page).toHaveURL(/\/login/u);
  await visitor.context.close();

  const revoked = await request.get('/api/v1/me', { headers: bearer });
  expect(revoked.status()).toBe(401);
  expect(await revoked.json()).toMatchObject({ code: 'TOKEN_REVOKED' });
});
