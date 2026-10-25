import { readFile } from 'node:fs/promises';

import { type Browser, type BrowserContext, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { E2E_WEB_URL } from './ports';
import { DEMO_PASSWORD } from './seed';
import { api, apiSignIn, collectCspViolations, expectNoSeriousA11yViolations, ok } from './support';

/**
 * T814: sharing a dashboard (FRONTEND §18, SPEC §15A, CONTRACTS §16/§16A,
 * ADR-38) and downloading a shared view, in a workspace and base of their
 * own: Orders (title, owner, amount, cost) with r1 (owner u_sales1) and r2
 * (owner u_sales2). A role "Sales" reads Orders where owner is the viewer,
 * never `cost`, may read dashboard D, share and download.
 *
 * - u_sales1 shares D from its heading: public, the scope warning names the
 *   widgets, the address is shown once; "Embed": one allowed site, on, the
 *   `<iframe>` code;
 * - an anonymous visitor opens the link: the numbers are u_sales1's (KPI 1,
 *   not the 2 an admin sees), read-only — no edit, no widget menu (no
 *   click-through); axe; Vietnamese at 375 px without horizontal scroll;
 * - embedded (`?embed=1`) in a page of the allowed site: shown without the
 *   share header; in a page of another site: refused by `frame-ancestors`;
 * - a view link without `allow_export` has no "Download"; u_sales1 turns it
 *   on in the dialog (confirmation) → the visitor downloads a CSV of r1
 *   without `cost`.
 *
 * `afterAll` moves the base to the trash.
 */

const RUN = Date.now().toString(36);
const ADMIN_EMAIL = WORKER_ORG.email('admin');
const SALES1_EMAIL = WORKER_ORG.email('sales1');
const SALES2_EMAIL = WORKER_ORG.email('sales2');
const DASHBOARD_NAME = `Doanh số T814 ${RUN}`;
const VIEW_NAME = `Đơn T814 ${RUN}`;
const TOKEN_URL = /\/s\/([A-Za-z0-9_-]{43})$/u;
/**
 * Sites hosting the frame, answered by the test itself (`page.route`), never
 * the network. The contexts showing them are granted `local-network-access`:
 * Chrome otherwise keeps a public site from framing the E2E stack on
 * 127.0.0.1 at all, which would hide the `frame-ancestors` decision checked
 * here.
 */
const ALLOWED_SITE = 'https://embed-allowed.test';
const OTHER_SITE = 'https://embed-other.test';

interface Fixture {
  orgId: string;
  baseId: string;
  orders: string;
  viewId: string;
  dashboardId: string;
  kpiId: string;
  chartId: string;
  dashboardToken: string;
  viewLinkId: string;
  viewToken: string;
}

const fx = {} as Fixture;

type Cookies = Awaited<ReturnType<BrowserContext['cookies']>>;
const cookies: Record<string, Cookies> = {};

async function prepare(context: BrowserContext, language: 'en' | 'vi'): Promise<void> {
  await context.addInitScript((value) => {
    window.localStorage.setItem('cellhive.language', value);
  }, language);
}

/** A new context signed in as `email` (once per user and spec: 20 sign-ins a minute per IP). */
async function openAs(
  browser: Browser,
  email: string,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
  });
  await prepare(context, 'en');
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
  options: {
    viewport?: { width: number; height: number };
    language?: 'en' | 'vi';
    permissions?: string[];
  } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1440, height: 900 },
    locale: 'en-US',
    acceptDownloads: true,
    permissions: options.permissions ?? [],
  });
  await prepare(context, options.language ?? 'en');
  return { context, page: await context.newPage() };
}

async function buildFixture(page: Page): Promise<void> {
  const me = await ok<{ orgs: { id: string }[] }>(page, 'GET', '/me');
  fx.orgId = me.orgs[0]?.id ?? '';
  await ok(page, 'PATCH', `/orgs/${fx.orgId}`, { settings: { public_sharing: 'allowed' } });
  const workspace = await ok<{ id: string }>(page, 'POST', `/orgs/${fx.orgId}/workspaces`, {
    name: `T814 ${RUN}`,
  });
  const base = await ok<{ id: string }>(page, 'POST', `/workspaces/${workspace.id}/bases`, {
    name: `Share T814 ${RUN}`,
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
  const owner = await add('owner', 'user', { multiple: false });
  const amount = await add('amount', 'number');
  const cost = await add('cost', 'number');

  const principals = await ok<{ items: { principal_id: string; email: string | null }[] }>(
    page,
    'GET',
    `/bases/${base.id}/principals?limit=200`,
  );
  const user = (email: string) =>
    principals.items.find((item) => item.email === email)?.principal_id ?? '';
  const sales1 = user(SALES1_EMAIL);
  await ok(page, 'POST', `/tables/${orders.id}/records?field_key_type=id`, {
    records: [
      {
        fields: {
          [orders.primary_field_id]: 'r1',
          [owner]: [{ id: sales1 }],
          [amount]: 100,
          [cost]: 7,
        },
      },
      {
        fields: {
          [orders.primary_field_id]: 'r2',
          [owner]: [{ id: user(SALES2_EMAIL) }],
          [amount]: 200,
          [cost]: 9,
        },
      },
    ],
  });
  fx.viewId = (
    await ok<{ id: string }>(page, 'POST', `/tables/${orders.id}/views`, {
      name: VIEW_NAME,
      type: 'grid',
    })
  ).id;

  const dashboard = await ok<{ id: string }>(page, 'POST', `/bases/${base.id}/dashboards`, {
    name: DASHBOARD_NAME,
  });
  fx.dashboardId = dashboard.id;
  fx.kpiId = (
    await ok<{ id: string }>(page, 'POST', `/dashboards/${dashboard.id}/widgets`, {
      type: 'kpi',
      title: 'Orders',
      config: { table_id: orders.id, metrics: [{ id: 'm1', aggregation: 'count' }] },
      layout: { x: 0, y: 0, w: 4, h: 4 },
    })
  ).id;
  fx.chartId = (
    await ok<{ id: string }>(page, 'POST', `/dashboards/${dashboard.id}/widgets`, {
      type: 'bar',
      title: 'Orders by owner',
      config: {
        table_id: orders.id,
        dimension: { field: owner },
        metrics: [{ id: 'm1', aggregation: 'count' }],
      },
      layout: { x: 4, y: 0, w: 8, h: 6 },
    })
  ).id;

  const role = await ok<{ id: string }>(page, 'POST', `/bases/${base.id}/roles`, {
    name: `Sales sharing ${RUN}`,
    config: {
      base_rule: { copy: false, download: true, share_link: true },
      tables: {
        [orders.id]: {
          perm: 'read_only',
          view_rule: { allow_edit: false, visible_views: null },
          field_rule: { mode: 'specify', fields: { [cost]: 'no_perm' } },
          record_rule: {
            operations: [],
            edit_filter: null,
            read_scope: 'filter',
            read_filter: {
              op: 'and',
              items: [{ field: owner, operator: 'has_any_of', value: [{ $var: 'current_user' }] }],
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
    role_id: role.id,
  });
}

/** A page of `site` that frames `src` (as the embed code does), answered by the test. */
async function hostPage(page: Page, site: string, src: string): Promise<void> {
  await page.route(`${site}/**`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html lang="en"><head><title>Host</title></head><body><main><h1>Host</h1><iframe id="frame" src="${src}" title="Shared dashboard" width="1000" height="700" loading="lazy" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-downloads allow-popups allow-popups-to-escape-sandbox"></iframe></main></body></html>`,
    }),
  );
  await page.goto(`${site}/intranet.html`);
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

test('u_sales1 shares D publicly and lets one site embed it', async ({ browser }) => {
  const { context, page } = await openAs(browser, SALES1_EMAIL);
  const csp = collectCspViolations(page);
  await page.goto(`/b/${fx.baseId}/d/${fx.dashboardId}`);
  await expect(page.getByTestId(`widget-${fx.kpiId}`).getByTestId('kpi-value')).toHaveText('1');
  await page.getByTestId('dashboard-share').click();
  const dialog = page.getByRole('dialog', { name: `Share “${DASHBOARD_NAME}”` });
  await expect(
    dialog.getByText('Create a link to this dashboard for people outside the base.'),
  ).toBeVisible();
  await dialog.getByRole('radio', { name: 'Anyone with the link' }).check();
  const warning = dialog.getByTestId('share-scope-warning');
  await expect(warning).toContainText(
    'People with the link will see numbers computed with your permissions on 2 widgets.',
  );
  await expectNoSeriousA11yViolations(page, 'dashboard share dialog');
  const create = dialog.getByRole('button', { name: 'Create link' });
  await expect(create).toBeDisabled();
  await warning
    .getByRole('checkbox', { name: 'I understand who will be able to see this data' })
    .check();
  await create.click();
  const address = dialog.getByRole('textbox', { name: 'Link address' });
  await expect(address).toHaveValue(TOKEN_URL);
  fx.dashboardToken = TOKEN_URL.exec(await address.inputValue())?.[1] ?? '';
  // Dashboard options of the link: live filters, refresh, TV mode, widget CSV.
  const options = dialog.getByTestId('share-options');
  await expect(options.getByRole('switch', { name: 'Use the filters' })).toBeChecked();
  await expect(options.getByRole('switch', { name: 'TV mode' })).not.toBeChecked();
  await expect(
    options.getByRole('switch', { name: 'Download widget data (CSV)' }),
  ).not.toBeChecked();

  await dialog.getByRole('tab', { name: 'Embed' }).click();
  const embed = dialog.getByTestId('share-embed');
  await expect(embed.getByTestId('share-embed-blocked')).toHaveCount(0);
  await expect(embed.getByRole('switch', { name: 'Allow embedding' })).toBeDisabled();
  await embed.getByTestId('embed-origin-input').fill(`${ALLOWED_SITE}/intranet`);
  await embed.getByTestId('embed-origin-input').press('Enter');
  await expect(embed.getByTestId('embed-origin-error')).toBeVisible();
  await embed.getByTestId('embed-origin-input').fill(ALLOWED_SITE);
  await embed.getByRole('button', { name: 'Add site' }).click();
  await expect(embed.getByTestId('embed-origins')).toContainText(ALLOWED_SITE);
  await embed.getByRole('switch', { name: 'Allow embedding' }).click();
  await expect(embed.getByRole('switch', { name: 'Allow embedding' })).toBeChecked();
  const code = await embed.getByTestId('embed-code').inputValue();
  expect(code).toContain(`/s/${fx.dashboardToken}?embed=1"`);
  expect(code).toContain(`title="${DASHBOARD_NAME}"`);
  expect(code).toContain('loading="lazy"');
  expect(code).toContain('referrerpolicy="no-referrer"');
  expect(code).toContain(
    'sandbox="allow-scripts allow-same-origin allow-downloads allow-popups allow-popups-to-escape-sandbox"',
  );
  await expectNoSeriousA11yViolations(page, 'embed tab');
  const links = await ok<{ items: { settings: { embed: unknown } }[] }>(
    page,
    'GET',
    `/dashboards/${fx.dashboardId}/share-links`,
  );
  expect(links.items[0]?.settings.embed).toEqual({
    enabled: true,
    allowed_origins: [ALLOWED_SITE],
  });
  expect(csp).toEqual([]);
  await context.close();
});

test('an anonymous visitor sees the numbers of u_sales1, read-only', async ({ browser }) => {
  const { context, page } = await anonymous(browser);
  const csp = collectCspViolations(page);
  const memberCalls: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/v1/widgets/') || path.startsWith('/api/v1/dashboards/')) {
      memberCalls.push(path);
    }
  });
  await page.goto(`/s/${fx.dashboardToken}`);
  await expect(page.getByTestId('dashboard-title')).toHaveText(DASHBOARD_NAME);
  // The creator's numbers: r1 only (an admin of the base sees 2).
  await expect(page.getByTestId(`widget-${fx.kpiId}`).getByTestId('kpi-value')).toHaveText('1');
  await expect(
    page.getByTestId(`widget-${fx.chartId}`).getByTestId('widget-chart'),
  ).toHaveAccessibleName(/Bar chart: Orders by owner, 1 group\./u);
  await expect(page.getByTestId('shared-refresh-every')).toHaveText('Updates every minute');
  // Read-only: no editing, no widget menu (no click-through, no downloads), no TV mode.
  await expect(page.getByTestId('dashboard-edit')).toHaveCount(0);
  await expect(page.getByTestId('widget-menu')).toHaveCount(0);
  await expect(page.getByTestId('dashboard-tv')).toHaveCount(0);
  await page.getByTestId(`widget-${fx.chartId}`).locator('canvas').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // Opened directly (not embedded): the share header with the product mark.
  await expect(page.getByRole('combobox', { name: 'Language' })).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'shared dashboard');
  expect(memberCalls).toEqual([]);
  expect(csp).toEqual([]);
  await context.close();
});

test('in Vietnamese at 375 px: one column, no horizontal scroll', async ({ browser }) => {
  const { context, page } = await anonymous(browser, {
    viewport: { width: 375, height: 812 },
    language: 'vi',
  });
  await page.goto(`/s/${fx.dashboardToken}`);
  await expect(page.getByTestId('dashboard-grid')).toHaveAttribute('data-layout', 'column');
  await expect(page.getByTestId(`widget-${fx.kpiId}`).getByTestId('kpi-value')).toHaveText('1');
  await expect(page.getByTestId('shared-refresh-every')).toHaveText('Cập nhật mỗi 1 phút');
  await expect(page.getByRole('button', { name: 'Làm mới' })).toBeVisible();
  await noHorizontalScroll(page, 375);
  await expectNoSeriousA11yViolations(page, 'shared dashboard vi 375');
  await page.screenshot({ path: test.info().outputPath('t814-vi-375.png') });
  await context.close();
});

test('embedded: shown in a page of the allowed site, refused in another', async ({ browser }) => {
  const src = `${E2E_WEB_URL}/s/${fx.dashboardToken}?embed=1`;
  const allowed = await anonymous(browser, { permissions: ['local-network-access'] });
  await hostPage(allowed.page, ALLOWED_SITE, src);
  const frame = allowed.page.frameLocator('#frame');
  await expect(frame.getByTestId('dashboard-title')).toHaveText(DASHBOARD_NAME);
  await expect(frame.getByTestId(`widget-${fx.kpiId}`).getByTestId('kpi-value')).toHaveText('1');
  // No share header inside the frame: the host page is the frame.
  await expect(frame.getByRole('combobox', { name: 'Language' })).toHaveCount(0);
  await expect(frame.locator('[data-embed]')).toHaveCount(1);
  await allowed.page.screenshot({ path: test.info().outputPath('t814-embed-allowed.png') });
  await allowed.context.close();

  const other = await anonymous(browser, { permissions: ['local-network-access'] });
  const refused = collectCspViolations(other.page);
  await hostPage(other.page, OTHER_SITE, src);
  await expect.poll(() => refused.join('\n')).toContain('frame-ancestors');
  await expect(other.page.frameLocator('#frame').getByTestId('dashboard-title')).toHaveCount(0);
  await other.context.close();
});

test('a view link: no download without allow_export; turned on, a CSV without cost', async ({
  browser,
}) => {
  const sales = await openAs(browser, SALES1_EMAIL);
  const link = await ok<{ id: string; token: string }>(
    sales.page,
    'POST',
    `/views/${fx.viewId}/share-links`,
    { audience: 'public' },
  );
  fx.viewLinkId = link.id;
  fx.viewToken = link.token;

  const visitor = await anonymous(browser);
  await visitor.page.goto(`/s/${fx.viewToken}`);
  await expect(visitor.page.getByRole('heading', { name: VIEW_NAME, level: 1 })).toBeVisible();
  await expect(visitor.page.getByText('1 record')).toBeVisible();
  await expect(visitor.page.getByTestId('share-export')).toHaveCount(0);

  // u_sales1 turns downloads on in the share dialog of the view (with a confirmation).
  await sales.page.goto(`/b/${fx.baseId}/t/${fx.orders}/v/${fx.viewId}`);
  await sales.page.getByRole('button', { name: `Share view ${VIEW_NAME}` }).click();
  const dialog = sales.page.getByRole('dialog', { name: `Share “${VIEW_NAME}”` });
  await dialog
    .getByTestId('share-options')
    .getByRole('switch', { name: 'Download the data (CSV/XLSX)' })
    .click();
  const confirm = dialog.getByRole('alertdialog', {
    name: 'Let people with the link download the data?',
  });
  await expect(confirm).toContainText('1 record');
  await expectNoSeriousA11yViolations(sales.page, 'allow export confirmation');
  await confirm.getByRole('button', { name: 'Allow downloads' }).click();
  await expect(
    dialog
      .getByTestId('share-options')
      .getByRole('switch', { name: 'Download the data (CSV/XLSX)' }),
  ).toBeChecked();
  await sales.context.close();

  await visitor.page.reload();
  const button = visitor.page.getByTestId('share-export');
  await expect(button).toBeVisible();
  await expectNoSeriousA11yViolations(visitor.page, 'shared view with downloads');
  await button.click();
  const [download] = await Promise.all([
    visitor.page.waitForEvent('download'),
    visitor.page.getByRole('menuitem', { name: 'CSV' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.csv$/u);
  const csv = (await readFile(await download.path())).toString('utf8').replace(/^\uFEFF/u, '');
  const [header, ...rows] = csv.trim().split(/\r?\n/u);
  expect(header).toContain('title');
  expect(header).toContain('amount');
  expect(header).not.toContain('cost');
  expect(rows).toHaveLength(1);
  expect(rows[0]).toContain('r1');
  await visitor.context.close();
});
