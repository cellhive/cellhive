import AxeBuilder from '@axe-core/playwright';
import { type Browser, type BrowserContext, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { DEMO_ORDER_CUSTOMER, DEMO_PASSWORD } from './seed';
import { animationsSettled, api, apiSignIn, expectNoSeriousA11yViolations, ok } from './support';

/**
 * T468: computed cells, headers and record panel (boards "S4b · Cột tính
 * toán: lỗi và tính lại", "S4b · Trình soạn công thức - popover") on the
 * demo Orders table:
 * - "Gấp đôi" = [amount] * 2 and "Cộng một" = [Gấp đôi] + 1; deleting
 *   "Gấp đôi" puts `#REF!` on the header of "Cộng một" in another tab within
 *   1 s, its cells show the grey token; "Restore field" from the error
 *   details (keyboard: Shift+F10) brings the values back;
 * - "Edit formula" of the header menu opens the popover under the header,
 *   the new formula is saved and the cells follow;
 * - pasting into a computed column skips the cells and says so;
 * - u_sales1 (Sales cannot read Customers) sees the lookup
 *   `Khách hàng → Tên` locked: a lock, nothing of the value (P34).
 */

const RUN = String(Date.now()).slice(-6);
const DEMO_BASE = 'Chăm sóc khách hàng';
const SALES1_EMAIL = WORKER_ORG.email('sales1');
const names = {
  double: `Gấp đôi ${RUN}`,
  plusOne: `Cộng một ${RUN}`,
  lookup: `Tên khách ${RUN}`,
};
const ids = { baseId: '', orders: '', customers: '', double: '', plusOne: '', lookup: '' };
/** Plain integers ("2000001"): the cells read the same in every locale. */
const PLAIN = { type: 'plain', precision: 0 };
const ROW_MARKER_WIDTH = 48;
const HEADER_HEIGHT = 36;
const ROW_HEIGHT = 34;

async function openAs(
  browser: Browser,
  email: string,
  viewport = { width: 1920, height: 1000 },
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport, locale: 'en-US' });
  await context.addInitScript(() => {
    window.localStorage.setItem('cellhive.language', 'en');
  });
  const page = await context.newPage();
  await page.goto('/login');
  await apiSignIn(page, email, DEMO_PASSWORD);
  return { context, page };
}

async function findDemo(page: Page) {
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
      if (base === undefined) continue;
      const tables = await ok<{ items: { id: string; name: string }[] }>(
        page,
        'GET',
        `/bases/${base.id}/tables`,
      );
      const id = (name: string) => tables.items.find((table) => table.name === name)?.id ?? '';
      return { baseId: base.id, orders: id('Orders'), customers: id('Customers') };
    }
  }
  throw new Error('demo base not found');
}

function header(page: Page, name: string) {
  return page.locator('table[role="grid"] th[role="columnheader"]', { hasText: name });
}

/** The cell of the column named `name` (its index read now: columns move when one is deleted). */
async function cellOf(page: Page, name: string, row = 0) {
  const column = Number(await header(page, name).getAttribute('aria-colindex'));
  return cell(page, column, row);
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
  for (let step = 0; step < 120; step += 1) {
    const found = await header(page, name).count();
    const target =
      found === 0 ? null : Number(await header(page, name).getAttribute('aria-colindex'));
    const current = await selectedColumn();
    if (target !== null && current === target) return target;
    const key = target !== null && current > target ? 'ArrowLeft' : 'ArrowRight';
    await page.keyboard.press(key);
    // The accessibility table follows the selection on the next frame.
    await expect.poll(selectedColumn).not.toBe(current);
  }
  throw new Error(`column ${name} not reached`);
}

async function firstOrderAmount(page: Page): Promise<number> {
  const answer = await ok<{ records: { fields: Record<string, unknown> }[] }>(
    page,
    'POST',
    `/tables/${ids.orders}/records/query?field_key_type=name`,
    { offset: 0, limit: 1 },
  );
  const amount = answer.records[0]?.fields['amount'];
  return typeof amount === 'number' ? amount : 0;
}

test.describe.serial('T468 computed cells, headers and panel', () => {
  test.use({ actionTimeout: 15_000 });

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(420_000);
    const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
    Object.assign(ids, await findDemo(page));
    const created = async (body: Record<string, unknown>) =>
      (await ok<{ id: string }>(page, 'POST', `/tables/${ids.orders}/fields`, body)).id;
    ids.double = await created({
      name: names.double,
      type: 'formula',
      options: { expression: '[amount] * 2', style: PLAIN },
    });
    ids.plusOne = await created({
      name: names.plusOne,
      type: 'formula',
      options: { expression: `[${names.double}] + 1`, style: PLAIN },
    });
    const orderFields = await ok<{ items: { id: string; name: string }[] }>(
      page,
      'GET',
      `/tables/${ids.orders}/fields`,
    );
    const customerLink = orderFields.items.find((item) => item.name === DEMO_ORDER_CUSTOMER)?.id;
    const customerFields = await ok<{ items: { id: string; name: string; is_primary: boolean }[] }>(
      page,
      'GET',
      `/tables/${ids.customers}/fields`,
    );
    const customerName = customerFields.items.find((item) => item.is_primary)?.id;
    ids.lookup = await created({
      name: names.lookup,
      type: 'lookup',
      options: {
        from: ids.customers,
        select: customerName,
        where: { field: '__id', operator: 'is_any_of', value: { field_ref: customerLink } },
      },
    });
    // Stored fields fill in the background: wait until every one is ready.
    await expect
      .poll(
        async () => {
          const fields = await ok<{ items: { id: string; compute_state?: string }[] }>(
            page,
            'GET',
            `/tables/${ids.orders}/fields`,
          );
          return fields.items
            .filter((item) => [ids.double, ids.plusOne, ids.lookup].includes(item.id))
            .map((item) => item.compute_state)
            .join(',');
        },
        { timeout: 240_000, intervals: [1_000] },
      )
      .toBe('ready,ready,ready');
    await context.close();
  });

  test.afterAll(async ({ browser }) => {
    const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
    for (const id of [ids.lookup, ids.plusOne, ids.double]) {
      if (id !== '') await api(page, 'DELETE', `/fields/${id}`);
    }
    await context.close();
  });

  test('deleting a referenced field shows #REF! in another tab < 1 s; restoring brings values back', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const a = await openAs(browser, WORKER_ORG.email('admin'));
    const b = await openAs(browser, WORKER_ORG.email('admin'));
    const amount = await firstOrderAmount(a.page);
    await openOrders(b.page);
    const column = await selectCell(b.page, names.plusOne);
    const plusOne = header(b.page, names.plusOne);
    await expect(plusOne).not.toHaveAttribute('aria-label', /#REF!/u);
    await expect(cell(b.page, column)).toHaveText(String(amount * 2 + 1));

    await ok(a.page, 'DELETE', `/fields/${ids.double}`);
    // From the answer of the delete (committed) to the header of the other tab.
    // T470 (H4): the first schema message of a burst refetches at once (leading edge).
    const started = Date.now();
    await expect(plusOne).toHaveAttribute('aria-label', /error #REF!/u, { timeout: 5_000 });
    const elapsed = Date.now() - started;
    process.stdout.write(`[t468] #REF on the other tab after ${String(elapsed)} ms\n`);
    expect(elapsed).toBeLessThan(1_000);
    await expect(await cellOf(b.page, names.plusOne)).toHaveText('#REF!');
    await b.page.screenshot({ path: test.info().outputPath('ref-header.png') });

    // Keyboard: the header menu of the cell's column, then the error details.
    await selectCell(b.page, names.plusOne);
    await b.page.keyboard.press('Shift+F10');
    await b.page.getByRole('menuitem', { name: 'Error details' }).click();
    const popover = b.page.getByTestId('computed-error-popover');
    await expect(popover).toContainText('Reference deleted');
    await expect(popover).toContainText(names.double);
    await expectNoSeriousA11yViolations(b.page, 'computed error popover');
    await popover.getByRole('button', { name: 'Restore field' }).click();
    await expect(plusOne).not.toHaveAttribute('aria-label', /#REF!/u, { timeout: 15_000 });
    await expect
      .poll(async () => (await cellOf(b.page, names.plusOne)).textContent(), { timeout: 30_000 })
      .toBe(String(amount * 2 + 1));
    await a.context.close();
    await b.context.close();
  });

  test('"Edit formula" opens the popover under the header; saving updates the cells', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
    const amount = await firstOrderAmount(page);
    await openOrders(page);
    const column = await selectCell(page, names.plusOne);
    await page.keyboard.press('Shift+F10');
    await page.getByRole('menuitem', { name: 'Edit formula' }).click();
    const popover = page.getByTestId('formula-popover');
    await expect(popover).toBeVisible();
    await expect(popover.getByRole('heading', { level: 2 })).toContainText(names.plusOne);
    // Under the header of the column.
    const box = await popover.boundingBox();
    const grid = await page.locator('.ob-grid').boundingBox();
    expect(box !== null && grid !== null && box.y >= grid.y + HEADER_HEIGHT - 1).toBe(true);
    const previewDigits = () =>
      popover
        .getByTestId('formula-preview-value')
        .textContent()
        .then((text) => (text ?? '').replace(/\D/gu, ''));
    await expect.poll(previewDigits).toBe(String(amount * 2 + 1));
    await expectNoSeriousA11yViolations(page, 'formula popover');
    const editor = popover.getByRole('textbox', { name: 'Formula' });
    await editor.click();
    await page.keyboard.press('End');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('5');
    await expect.poll(previewDigits).toBe(String(amount * 2 + 5));
    await popover.getByTestId('formula-confirm').click();
    await expect(popover).toBeHidden();
    await expect(cell(page, column)).toHaveText(String(amount * 2 + 5), { timeout: 30_000 });
    await context.close();
  });

  test('pasting into a computed column skips its cells and says how many', async ({ browser }) => {
    const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openOrders(page);
    const column = await selectCell(page, names.plusOne);
    const before = await cell(page, column).textContent();
    await page.evaluate(() => navigator.clipboard.writeText('1\r\n2\r\n'));
    await page.keyboard.press('ControlOrMeta+v');
    await expect(page.getByText('2 cells were skipped: they are read-only.')).toBeVisible();
    await expect(cell(page, column)).toHaveText(before ?? '');
    await context.close();
  });

  test('u_sales1 sees the lookup through Customers locked, nothing of the value', async ({
    browser,
  }) => {
    const { context, page } = await openAs(browser, SALES1_EMAIL);
    await openOrders(page);
    const column = await selectCell(page, names.lookup);
    await expect(header(page, names.lookup)).toHaveAttribute(
      'aria-label',
      /no access to the source data/u,
    );
    await expect(cell(page, column)).toHaveText(
      'You cannot read the data this value is computed from.',
    );
    // The grid is scrolled right to the lookup: the summary bar (T472) slides its cells under
    // the frozen columns, which axe reports as obscured targets — outside T468, left out here.
    const serious = async () =>
      (
        await new AxeBuilder({ page })
          .exclude('[data-testid^="summary-cell"]')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
          .analyze()
      ).violations.filter((item) => item.impact === 'serious' || item.impact === 'critical');
    expect(await serious()).toEqual([]);
    // The record panel: a lock, no value.
    await page.keyboard.press('Space');
    const panel = page.getByRole('dialog').filter({ has: page.getByTestId('record-field') });
    const row = panel.getByTestId('record-field').filter({ hasText: names.lookup });
    await expect(row.getByTestId('computed-locked')).toContainText('No access');
    await animationsSettled(page);
    expect(await serious()).toEqual([]);
    await context.close();

    // 375 px: the card list and the full-screen panel.
    const phone = await openAs(browser, SALES1_EMAIL, { width: 375, height: 812 });
    await openOrdersPhone(phone.page);
    const overflow = await phone.page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await phone.context.close();
  });
});

async function openOrdersPhone(page: Page) {
  await page.goto(`/b/${ids.baseId}/t/${ids.orders}`);
  await expect(page.getByRole('list').or(page.getByRole('grid')).first()).toBeVisible();
}
