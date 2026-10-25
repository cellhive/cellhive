import { type Browser, type BrowserContext, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { DEMO_PASSWORD } from './seed';
import { animationsSettled, api, apiSignIn, expectNoSeriousA11yViolations, ok } from './support';

/**
 * T469 (boards "S4b · Thùng rác base, xoá vĩnh viễn bảng", "S4b · Đã xoá
 * bảng, Hoàn tác"), on two tables of its own in the demo base (the demo
 * Customers stays for the other specs):
 * - deleting `amount` lists the formulas that will show `#REF!`;
 * - a formula becomes a number ("convert to static values"), then the
 *   conversion is undone: a formula again;
 * - deleting a table offers "Undo" in a toast; the base trash (sidebar
 *   entry, base admins) restores or deletes permanently after the name is
 *   typed, listing the link fields of other tables and the computed fields
 *   hit — another tab sees the link column of the other table disappear;
 * - someone who is not a base admin has no trash entry and gets the 404
 *   screen; the trash reads at 375 px; axe on every screen.
 */

const RUN = String(Date.now()).slice(-6);
const DEMO_BASE = 'Chăm sóc khách hàng';
const SALES1_EMAIL = WORKER_ORG.email('sales1');
const PLAIN = { type: 'plain', precision: 0 };
const names = {
  customers: `Khách T469 ${RUN}`,
  orders: `Đơn T469 ${RUN}`,
  commission: 'Hoa hồng',
  double: 'Gấp đôi',
  customerName: 'Tên khách',
};
const ids = {
  baseId: '',
  customers: '',
  orders: '',
  amount: '',
  link: '',
  commission: '',
  double: '',
  customerName: '',
};
const ROW_MARKER_WIDTH = 48;
const HEADER_HEIGHT = 36;
const ROW_HEIGHT = 34;
let adminState: Awaited<ReturnType<BrowserContext['storageState']>> | undefined;

async function openAdmin(
  browser: Browser,
  viewport = { width: 1440, height: 900 },
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport,
    locale: 'en-US',
    ...(adminState === undefined ? {} : { storageState: adminState }),
  });
  await context.addInitScript(() => {
    window.localStorage.setItem('cellhive.language', 'en');
  });
  const page = await context.newPage();
  if (adminState === undefined) {
    await page.goto('/login');
    await apiSignIn(page, WORKER_ORG.email('admin'), DEMO_PASSWORD);
    adminState = await context.storageState();
  }
  return { context, page };
}

async function findDemoBase(page: Page): Promise<string> {
  const me = await ok<{ orgs: { id: string }[] }>(page, 'GET', '/me');
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
      const base = bases.items.find((item) => item.name === DEMO_BASE);
      if (base !== undefined) return base.id;
    }
  }
  throw new Error('demo base not found');
}

function header(page: Page, name: string) {
  return page.locator('table[role="grid"] th[role="columnheader"]', { hasText: name });
}

function cell(page: Page, column: number, row = 0) {
  return page.getByTestId(`glide-cell-${String(column)}-${String(row)}`);
}

async function openOrders(page: Page) {
  await page.goto(`/b/${ids.baseId}/t/${ids.orders}`);
  await expect(page.locator('table[role="grid"] td[role="gridcell"]').first()).toBeAttached();
}

/** Selects the cell of `name` in data row `row` with the keyboard; returns its a11y column. */
async function selectCell(page: Page, name: string, row = 0): Promise<number> {
  const canvas = page.locator('.ob-grid [data-testid="data-grid-canvas"]');
  const box = await canvas.boundingBox();
  if (box === null) throw new Error('grid not laid out');
  await page.mouse.click(
    box.x + ROW_MARKER_WIDTH + 24,
    box.y + HEADER_HEIGHT + ROW_HEIGHT * row + ROW_HEIGHT / 2,
  );
  await expect(cell(page, 1, row)).toHaveAttribute('aria-selected', 'true');
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.closest('.ob-grid') != null))
    .toBe(true);
  const selectedColumn = async () =>
    Number(
      (await page
        .locator('table[role="grid"] td[role="gridcell"][aria-selected="true"]')
        .first()
        .getAttribute('aria-colindex')) ?? '0',
    );
  for (let step = 0; step < 60; step += 1) {
    const target = Number(await header(page, name).getAttribute('aria-colindex'));
    const current = await selectedColumn();
    if (current === target) return target;
    await page.keyboard.press(current > target ? 'ArrowLeft' : 'ArrowRight');
    await expect.poll(selectedColumn).not.toBe(current);
  }
  throw new Error(`column ${name} not reached`);
}

/**
 * "Delete table" of the open dialog. Requests of one base are rate limited
 * (SPEC §13.1) and the other tab refetches on every schema message: a `429`
 * shows in the dialog ("try again in 1 second"), so the click is repeated.
 */
async function confirmTableDelete(page: Page) {
  const dialog = page.getByTestId('delete-table-dialog');
  await expect(async () => {
    if (await dialog.isVisible()) await page.getByTestId('delete-table-confirm').click();
    await expect(dialog).toBeHidden({ timeout: 3_000 });
  }).toPass({ timeout: 60_000, intervals: [2_000] });
}

interface FieldState {
  type: string;
  compute_state?: string;
  conversion?: { status: string } | null;
}

async function fieldState(page: Page, id: string): Promise<FieldState> {
  return ok<FieldState>(page, 'GET', `/fields/${id}`);
}

test.describe.serial('T469 dependents, computed conversions, base trash', () => {
  test.use({ actionTimeout: 15_000 });

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    const { context, page } = await openAdmin(browser);
    ids.baseId = await findDemoBase(page);
    const table = async (name: string, primary: string) =>
      (
        await ok<{ id: string }>(page, 'POST', `/bases/${ids.baseId}/tables`, {
          name,
          primary_field_name: primary,
        })
      ).id;
    ids.customers = await table(names.customers, 'Tên');
    ids.orders = await table(names.orders, 'Tên đơn');
    const field = async (tableId: string, body: Record<string, unknown>) =>
      (await ok<{ id: string }>(page, 'POST', `/tables/${tableId}/fields`, body)).id;
    ids.amount = await field(ids.orders, {
      name: 'amount',
      type: 'number',
      options: { style: PLAIN },
    });
    ids.link = await field(ids.orders, {
      name: 'customer',
      type: 'link',
      options: { link_table: ids.customers, allow_multiple: false },
    });
    ids.commission = await field(ids.orders, {
      name: names.commission,
      type: 'formula',
      options: { expression: '[amount] * 0.1', style: PLAIN },
    });
    ids.double = await field(ids.orders, {
      name: names.double,
      type: 'formula',
      options: { expression: '[amount] * 2', style: PLAIN },
    });
    ids.customerName = await field(ids.orders, {
      name: names.customerName,
      type: 'formula',
      options: { expression: '[customer].[Tên].ARRAYJOIN()' },
    });
    const customers = await ok<{ records: { id: string }[] }>(
      page,
      'POST',
      `/tables/${ids.customers}/records?field_key_type=name`,
      { records: [{ fields: { Tên: 'An Phát' } }, { fields: { Tên: 'Hoà Bình' } }] },
    );
    await ok(page, 'POST', `/tables/${ids.orders}/records?field_key_type=name`, {
      records: [
        { fields: { 'Tên đơn': 'Đơn 1', amount: 1000, customer: [customers.records[0]?.id] } },
        { fields: { 'Tên đơn': 'Đơn 2', amount: 250, customer: [customers.records[1]?.id] } },
      ],
    });
    await expect
      .poll(
        async () =>
          (
            await Promise.all(
              [ids.commission, ids.double, ids.customerName].map((id) => fieldState(page, id)),
            )
          )
            .map((item) => item.compute_state)
            .join(','),
        { timeout: 120_000, intervals: [1_000] },
      )
      .toBe('ready,ready,ready');
    await context.close();
  });

  test.afterAll(async ({ browser }) => {
    const { context, page } = await openAdmin(browser);
    if (ids.orders !== '') await api(page, 'DELETE', `/tables/${ids.orders}`);
    await context.close();
  });

  test('deleting amount lists the formulas that will show #REF!', async ({ browser }) => {
    const { context, page } = await openAdmin(browser);
    await openOrders(page);
    await selectCell(page, 'amount');
    await page.keyboard.press('Shift+F10');
    await page.getByRole('menuitem', { name: 'Delete field' }).click();
    const dialog = page.getByTestId('delete-field-dialog');
    const computed = dialog.getByTestId('computed-dependents');
    await expect(computed).toContainText('2 formulas and lookups will show #REF!');
    await expect(computed).toContainText(names.commission);
    await expect(computed).toContainText(names.double);
    await expect(computed).toContainText(`in ${names.orders}`);
    await expect(computed).toContainText('Formula');
    await animationsSettled(page);
    await expectNoSeriousA11yViolations(page, 'delete field dialog');
    await page.screenshot({ path: test.info().outputPath('delete-field.png') });
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    expect((await fieldState(page, ids.amount)).type).toBe('number');
    await context.close();
  });

  test('a formula becomes static numbers, then the conversion is undone', async ({ browser }) => {
    test.setTimeout(180_000);
    const { context, page } = await openAdmin(browser);
    await openOrders(page);
    await selectCell(page, names.double);
    await page.keyboard.press('Shift+F10');
    await page.getByRole('menuitem', { name: 'Edit field' }).click();
    await page.getByTestId('convert-to-static').click();
    await expect(page.getByTestId('type-target')).toHaveValue('number');
    const pane = page.getByTestId('conversion-pane');
    await expect(pane.getByTestId('conversion-static')).toContainText(
      'The current values are kept as static values.',
    );
    await expect(pane.getByTestId('stat-affected')).toContainText('2');
    await animationsSettled(page);
    await expectNoSeriousA11yViolations(page, 'convert to static values');
    await page.screenshot({ path: test.info().outputPath('convert-static.png') });
    const submit = page.getByTestId('field-dialog-submit');
    await expect(submit).toHaveText('Convert to static values');
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect
      .poll(async () => fieldState(page, ids.double), { timeout: 90_000, intervals: [1_000] })
      .toMatchObject({ type: 'number', conversion: { status: 'succeeded' } });
    const column = await selectCell(page, names.double);
    await expect(cell(page, column)).toHaveText('2000', { timeout: 15_000 });

    await selectCell(page, names.double);
    await page.keyboard.press('Shift+F10');
    await page.getByRole('menuitem', { name: /Undo type change/u }).click();
    await expect(page.getByTestId('revert-to-computed')).toContainText(
      'The field becomes a Formula again.',
    );
    await page.getByTestId('revert-submit').click();
    await expect
      .poll(async () => (await fieldState(page, ids.double)).type, {
        timeout: 90_000,
        intervals: [1_000],
      })
      .toBe('formula');
    await expect
      .poll(async () => (await fieldState(page, ids.double)).compute_state, {
        timeout: 90_000,
        intervals: [1_000],
      })
      .toBe('ready');
    await context.close();
  });

  test('delete a table with Undo, then delete it permanently from the base trash', async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const a = await openAdmin(browser);
    const b = await openAdmin(browser);
    // Earlier specs may have left tables of the demo base in its trash (T470).
    const trashed = await ok<{ items: unknown[] }>(
      a.page,
      'GET',
      `/bases/${ids.baseId}/tables/trash`,
    );
    await openOrders(b.page);
    await expect(header(b.page, 'customer')).toHaveCount(1);

    // Delete Customers from the sidebar menu; the toast undoes it.
    await a.page.goto(`/b/${ids.baseId}/t/${ids.customers}`);
    const sidebarLink = a.page.getByRole('link', { name: names.customers, exact: true });
    await expect(sidebarLink).toBeVisible();
    await sidebarLink.hover();
    await a.page.getByTestId(`table-menu-${ids.customers}`).click();
    await a.page.getByRole('menuitem', { name: 'Delete table' }).click();
    const dialog = a.page.getByTestId('delete-table-dialog');
    await expect(dialog.getByTestId('computed-dependents')).toContainText(names.customerName);
    await animationsSettled(a.page);
    await expectNoSeriousA11yViolations(a.page, 'delete table dialog');
    await confirmTableDelete(a.page);
    const toast = a.page
      .getByRole('status')
      .filter({ hasText: `Table ${names.customers} deleted` });
    await expect(toast).toBeVisible();
    await expect(sidebarLink).toHaveCount(0);
    await toast.getByRole('button', { name: 'Undo' }).click();
    await expect(a.page.getByText(`Table ${names.customers} restored.`)).toBeVisible();
    await expect(sidebarLink).toBeVisible();

    // Again, then the base trash.
    await sidebarLink.hover();
    await a.page.getByTestId(`table-menu-${ids.customers}`).click();
    await a.page.getByRole('menuitem', { name: 'Delete table' }).click();
    await confirmTableDelete(a.page);
    await expect(a.page.getByTestId('base-trash-count')).toHaveText(
      String(trashed.items.length + 1),
    );
    await a.page.getByTestId('base-trash-link').click();
    await expect(a.page).toHaveURL(new RegExp(`/b/${ids.baseId}/trash$`, 'u'));
    const row = a.page.getByTestId(`trashed-table-${ids.customers}`);
    await expect(row).toContainText(names.customers);
    await expect(row).toContainText('1 link from another table');
    await expect(row).toContainText('30 days left');
    await animationsSettled(a.page);
    await expectNoSeriousA11yViolations(a.page, 'base trash');
    await a.page.screenshot({ path: test.info().outputPath('base-trash.png') });

    // 375 px: one card per table, no sideways scrolling.
    await a.page.setViewportSize({ width: 375, height: 812 });
    await expect(a.page.getByTestId('table-trash-cards')).toBeVisible();
    expect(
      await a.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await expectNoSeriousA11yViolations(a.page, 'base trash 375 px');
    await a.page.screenshot({ path: test.info().outputPath('base-trash-375.png') });
    await a.page.setViewportSize({ width: 1440, height: 900 });

    await row.getByRole('button', { name: `Delete table ${names.customers} permanently` }).click();
    const purge = a.page.getByTestId('purge-table-dialog');
    await expect(purge.getByTestId('purge-table-partners')).toContainText('customer');
    await expect(purge.getByTestId('purge-table-partners')).toContainText(`in ${names.orders}`);
    await expect(purge.getByTestId('purge-table-computed')).toContainText(names.customerName);
    const confirm = purge.getByTestId('purge-table-confirm');
    await expect(confirm).toBeDisabled();
    await purge.getByTestId('purge-table-name').fill(names.customers);
    await expect(confirm).toBeEnabled();
    await animationsSettled(a.page);
    await expectNoSeriousA11yViolations(a.page, 'purge table dialog');
    await a.page.screenshot({ path: test.info().outputPath('purge-dialog.png') });
    await confirm.click();
    await expect(
      a.page.getByText(`Table ${names.customers} and its 2 records deleted permanently.`),
    ).toBeVisible();
    await expect(row).toHaveCount(0);
    // The empty state only when no other spec left a table in the trash (T470).
    if (trashed.items.length === 0) {
      await expect(a.page.getByText('No deleted tables')).toBeVisible();
    }
    // The other tab: the link column of Orders goes away (schema.changed field deleted).
    await expect(header(b.page, 'customer')).toHaveCount(0, { timeout: 10_000 });
    ids.customers = '';
    await a.context.close();
    await b.context.close();
  });

  test('someone who is not a base admin has no base trash', async ({ browser }) => {
    const context = await browser.newContext({ locale: 'en-US' });
    await context.addInitScript(() => {
      window.localStorage.setItem('cellhive.language', 'en');
    });
    const page = await context.newPage();
    await page.goto('/login');
    await apiSignIn(page, SALES1_EMAIL, DEMO_PASSWORD);
    const tables = await ok<{ items: { id: string }[] }>(
      page,
      'GET',
      `/bases/${ids.baseId}/tables`,
    );
    await page.goto(`/b/${ids.baseId}/t/${tables.items[0]?.id ?? ''}`);
    await expect(page.getByRole('navigation', { name: 'Tables' })).toBeVisible();
    await expect(page.getByTestId('base-trash-link')).toHaveCount(0);
    expect((await api(page, 'GET', `/bases/${ids.baseId}/tables/trash`)).status).toBe(403);
    await page.goto(`/b/${ids.baseId}/trash`);
    await expect(page.getByText('Page not found')).toBeVisible();
    await context.close();
  });
});
