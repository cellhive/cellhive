import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type Browser, type BrowserContext, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { DEMO_PASSWORD } from './seed';
import { api, apiSignIn, collectCspViolations, expectNoSeriousA11yViolations, ok } from './support';

/**
 * T1020: whole-base export and import (`.chbase`, CONTRACTS §12.2,
 * FRONTEND §17.5) through the UI, as the demo administrator of the worker's
 * organization (a base admin and an organization admin):
 *
 * - Base settings › Export base: what the package holds, the dialog that
 *   says it carries every field (even those roles hide) and not members,
 *   secrets or history, the phases of the `base.export` job, the download;
 * - a second workspace: "Import base from a .chbase file", the downloaded
 *   package dropped in, the phases of `base.import`, the report (automations
 *   off, what to set up again with links to the automations, the personal
 *   view left out), "Open base": the tables with their records, the grid,
 *   the dashboard and its widgets;
 * - a damaged package: the import fails with `INVALID_PACKAGE`, each problem
 *   with its message and where it is in the package; nothing is created;
 * - axe on every state, no CSP violation, 375 px without horizontal scroll.
 *
 * `afterAll` moves the imported base to the trash.
 */

const RUN = Date.now().toString(36);
const WORKSPACE_NAME = `Nhập T1020 ${RUN}`;
const DEMO_BASE = 'Chăm sóc khách hàng';
const DEMO_DASHBOARD = 'Tổng quan đơn hàng';

const fx = {
  orgId: '',
  orgSlug: '',
  baseId: '',
  workspaceId: '',
  importedBaseId: '',
  dir: '',
  packagePath: '',
  /** Tables of the demo base (other specs of the worker may have added records). */
  tables: [] as { id: string; name: string }[],
  /** "Orders" count of the demo base's sidebar when it was exported. */
  ordersCount: '',
};

type Cookies = Awaited<ReturnType<BrowserContext['cookies']>>;
let cookies: Cookies | undefined;

async function openAs(
  browser: Browser,
  viewport = { width: 1440, height: 900 },
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport, locale: 'en-US', acceptDownloads: true });
  await context.addInitScript(() => {
    window.localStorage.setItem('cellhive.language', 'en');
  });
  const page = await context.newPage();
  await page.goto('/login');
  if (cookies === undefined) {
    await apiSignIn(page, WORKER_ORG.email('admin'), DEMO_PASSWORD);
    cookies = await context.cookies();
  } else {
    await context.addCookies(cookies);
  }
  return { context, page };
}

async function noHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  const { context, page } = await openAs(browser);
  const me = await ok<{ orgs: { id: string; name: string; slug: string }[] }>(page, 'GET', '/me');
  const org = me.orgs.find((item) => item.name === WORKER_ORG.orgName);
  if (org === undefined) throw new Error(`The organization ${WORKER_ORG.orgName} is missing.`);
  fx.orgId = org.id;
  fx.orgSlug = org.slug;
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
    const demo = bases.items.find((base) => base.name === DEMO_BASE);
    if (demo !== undefined) fx.baseId = demo.id;
  }
  expect(fx.baseId, 'the demo base').not.toBe('');
  fx.tables = (
    await ok<{ items: { id: string; name: string }[] }>(page, 'GET', `/bases/${fx.baseId}/tables`)
  ).items;
  const created = await ok<{ id: string }>(page, 'POST', `/orgs/${org.id}/workspaces`, {
    name: WORKSPACE_NAME,
  });
  fx.workspaceId = created.id;
  fx.dir = await mkdtemp(join(tmpdir(), 'cellhive-t1020-'));
  await context.close();
});

test.afterAll(async ({ browser }) => {
  if (fx.dir !== '') await rm(fx.dir, { recursive: true, force: true });
  if (fx.importedBaseId === '') return;
  const { context, page } = await openAs(browser);
  await api(page, 'DELETE', `/bases/${fx.importedBaseId}`);
  await context.close();
});

test('export the demo base from Base settings › Export base and download the package', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { context, page } = await openAs(browser);
  const csp = collectCspViolations(page);
  const sourceOrders = fx.tables.find((table) => table.name === 'Orders')?.id ?? '';
  await page.goto(`/b/${fx.baseId}`);
  const count = page.getByTestId(`table-count-${sourceOrders}`);
  await expect(count).toHaveText(/^[\d,]+$/u);
  fx.ordersCount = (await count.textContent()) ?? '';
  await page.goto(`/b/${fx.baseId}/settings`);
  await page.getByTestId('base-settings-nav-export').click();
  await expect(page).toHaveURL(new RegExp(`/b/${fx.baseId}/settings/export$`, 'u'));
  const holds = page.getByTestId('base-export-page');
  await expect(holds).toContainText('including fields that roles hide from other members');
  await expect(holds).toContainText('Members, groups and the roles they have');
  await expect(holds).toContainText(`cellhive base export --base ${fx.baseId}`);
  await expectNoSeriousA11yViolations(page, 'export page');

  await page.getByTestId('export-open').click();
  const dialog = page.getByRole('dialog', { name: `Export ${DEMO_BASE}` });
  await expect(dialog.getByRole('note')).toContainText(
    'The package holds every field of this base, including fields that roles hide',
  );
  await expect(dialog).toContainText('Members, secrets and history stay here');
  await expectNoSeriousA11yViolations(page, 'export dialog');

  await dialog.getByTestId('export-start').click();
  // The phases show while the job runs (it may already be past some).
  await expect(
    dialog.getByTestId('job-phases').or(dialog.getByTestId('export-ready')),
  ).toBeVisible();
  const ready = dialog.getByTestId('export-ready');
  await expect(ready).toBeVisible({ timeout: 120_000 });
  await expect(ready).toContainText('The package is ready');
  await expect(ready).toContainText(`${DEMO_BASE}.chbase`);
  await expectNoSeriousA11yViolations(page, 'export ready');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    ready.getByTestId('export-download').click(),
  ]);
  expect(download.suggestedFilename()).toBe(`${DEMO_BASE}.chbase`);
  fx.packagePath = join(fx.dir, 'demo.chbase');
  await download.saveAs(fx.packagePath);

  // Closed, the page keeps the download of this export.
  await dialog.getByRole('button', { name: 'Close' }).first().click();
  await expect(page.getByTestId('export-status')).toContainText('Ready to download');
  expect(csp).toEqual([]);
  await context.close();
});

test('import the package into another workspace, read the report and open the new base', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  expect(fx.packagePath, 'the package of the export test').not.toBe('');
  const { context, page } = await openAs(browser);
  const csp = collectCspViolations(page);
  await page.goto(`/o/${fx.orgSlug}/w/${fx.workspaceId}`);
  const open = page.getByRole('button', { name: 'Import base from a .chbase file' });
  await expect(open).toBeVisible();
  await open.click();
  const dialog = page.getByRole('dialog', { name: 'Import base from a .chbase file' });
  await expect(dialog).toContainText(`The base is created in ${WORKSPACE_NAME}`);
  await expect(dialog.getByTestId('import-base-start')).toBeDisabled();
  await expectNoSeriousA11yViolations(page, 'import drop');

  await dialog.getByTestId('import-base-file').setInputFiles(fx.packagePath);
  await expect(dialog.getByTestId('import-chosen')).toContainText('demo.chbase');
  await dialog.getByTestId('import-base-start').click();
  await expect(
    dialog.getByTestId('import-progress').or(dialog.getByTestId('import-report')),
  ).toBeVisible();

  const report = dialog.getByTestId('import-report');
  await expect(report).toBeVisible({ timeout: 180_000 });
  await expect(report).toContainText(`${DEMO_BASE} is ready`);
  const tablesCount = report
    .getByTestId('import-report-counts')
    .locator('div', { has: page.getByText('Tables', { exact: true }) })
    .locator('dd');
  await expect(tablesCount).toHaveText(String(fx.tables.length));
  await expect(report.getByTestId('import-report-automations')).toContainText(
    'were imported turned off',
  );
  // The Telegram bot and the incoming webhook of the demo, each with the automation using it.
  const reconnect = report.getByTestId('import-report-reconnect');
  await expect(reconnect).toContainText('Incoming webhook');
  await expect(reconnect).toContainText('Đơn từ website');
  await expect(reconnect.getByRole('link').first()).toHaveAttribute(
    'href',
    /\/b\/bse_[0-9A-Za-z]{16}\/automations\/aut_[0-9A-Za-z]{16}$/u,
  );
  // u_editor's personal view stays with u_editor.
  await expect(report.getByTestId('import-report-views')).toContainText('1 personal view');
  await expectNoSeriousA11yViolations(page, 'import report');

  await report.getByTestId('import-open-base').click();
  await expect(page).toHaveURL(/\/b\/bse_[0-9A-Za-z]{16}/u);
  fx.importedBaseId = /\/b\/(bse_[0-9A-Za-z]{16})/u.exec(page.url())?.[1] ?? '';
  expect(fx.importedBaseId).not.toBe(fx.baseId);

  // The data: every table with its records, the grid of Orders.
  const tables = await ok<{ items: { id: string; name: string }[] }>(
    page,
    'GET',
    `/bases/${fx.importedBaseId}/tables`,
  );
  const orders = tables.items.find((table) => table.name === 'Orders');
  expect(orders, 'Orders in the new base').toBeDefined();
  await expect(page.getByTestId(`table-count-${orders?.id ?? ''}`)).toHaveText(fx.ordersCount);
  await page.goto(`/b/${fx.importedBaseId}/t/${orders?.id ?? ''}`);
  await expect(page.locator('table[role="grid"] td[role="gridcell"]').first()).toBeAttached();

  // The dashboard and its widgets.
  const nav = page.getByTestId('dashboards-nav');
  const dashboard = nav.getByRole('link', { name: DEMO_DASHBOARD });
  await expect(dashboard).toBeVisible();
  await dashboard.click();
  await expect(page.getByTestId('dashboard-title')).toHaveText(DEMO_DASHBOARD);
  await expect(page.getByTestId('kpi-value').first()).toBeVisible({ timeout: 30_000 });
  expect(csp).toEqual([]);
  await context.close();
});

test('a damaged package fails with INVALID_PACKAGE: each problem, where it is; nothing created', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { context, page } = await openAs(browser);
  const before = await ok<{ items: unknown[] }>(page, 'GET', `/workspaces/${fx.workspaceId}/bases`);
  // A zip whose only entry is not part of a package.
  const damaged = join(fx.dir, 'damaged.chbase');
  await writeFile(damaged, Buffer.from('PK\u0005\u0006'.padEnd(22, '\u0000'), 'latin1'));
  await page.goto(`/o/${fx.orgSlug}/w/${fx.workspaceId}`);
  await page.getByRole('button', { name: 'Import base from a .chbase file' }).click();
  const dialog = page.getByRole('dialog', { name: 'Import base from a .chbase file' });
  // Not a .chbase: refused before any upload.
  await dialog.getByTestId('import-base-file').setInputFiles({
    name: 'orders.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('a,b\n1,2\n'),
  });
  await expect(dialog).toContainText('orders.csv is not a .chbase package');
  await expect(dialog.getByTestId('import-base-start')).toBeDisabled();

  await dialog.getByTestId('import-base-file').setInputFiles(damaged);
  await dialog.getByTestId('import-base-start').click();
  const failed = dialog.getByTestId('import-error');
  await expect(failed).toBeVisible({ timeout: 60_000 });
  await expect(failed).toContainText('This package cannot be imported');
  await expect(failed.getByTestId('import-problem').first()).toBeVisible();
  await expect(failed).toContainText('Nothing was created');
  await expectNoSeriousA11yViolations(page, 'import error');
  const after = await ok<{ items: unknown[] }>(page, 'GET', `/workspaces/${fx.workspaceId}/bases`);
  expect(after.items).toHaveLength(before.items.length);
  await context.close();
});

test('375 px: the export page and the import dialog fit without horizontal scroll', async ({
  browser,
}) => {
  const { context, page } = await openAs(browser, { width: 375, height: 812 });
  await page.goto(`/b/${fx.baseId}/settings/export`);
  await expect(page.getByTestId('base-export-page')).toBeVisible();
  await noHorizontalScroll(page);
  await page.getByTestId('export-open').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await noHorizontalScroll(page);
  await expectNoSeriousA11yViolations(page, 'export dialog 375');
  await page.goto(`/o/${fx.orgSlug}/w/${fx.workspaceId}`);
  await page.getByRole('button', { name: 'Import base from a .chbase file' }).click();
  await expect(page.getByTestId('import-dropzone')).toBeVisible();
  await noHorizontalScroll(page);
  await expectNoSeriousA11yViolations(page, 'import drop 375');
  await context.close();
});
