import { mkdirSync } from 'node:fs';

import AxeBuilder from '@axe-core/playwright';
import { type Browser, type BrowserContext, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { DEMO_ORDER_TITLE, DEMO_PASSWORD } from './seed';
import { animationsSettled, api, apiSignIn, expectNoSeriousA11yViolations, ok } from './support';

/**
 * T416: the embedded sub-table of link fields in the record panel, on the
 * demo base (CONTRACTS §9). The spec links Orders to Customers both ways
 * (Customers gets the reverse field "Orders <run>") and Orders to Orders
 * one way, then: a customer's orders as a sub-table, an amount edited in
 * place (a second tab sees it live), a new order added pre-linked, an
 * existing one linked through the picker, an unlink undone, the column
 * choice saved to the view, "50 / N" with "View all", u_sales1's locked
 * rows (P20) and the cards on a phone.
 */

const SALES1 = WORKER_ORG.email('sales1');
const RUN = String(Date.now()).slice(-6);
/** Screenshots compared with the design boards (T416 report); saved only when `T416_SHOTS=<dir>` is set. */
const SHOTS = process.env['T416_SHOTS'];

const names = {
  customerLink: `Khách T416 ${RUN}`,
  reverse: `Đơn hàng ${RUN}`,
  related: `Đơn liên quan ${RUN}`,
  small: `Siêu thị mini Hoà Bình ${RUN}`,
  big: `Chuỗi cà phê Lá Xanh ${RUN}`,
  added: `Đơn mới ${RUN}`,
};

const ids = {
  baseId: '',
  orders: '',
  customers: '',
  /** Orders → Customers (two-way) and its reverse field on Customers. */
  customerLink: '',
  reverse: '',
  /** Orders → Orders (one-way). */
  related: '',
  small: '',
  big: '',
  customersView: '',
  orderIds: [] as string[],
  salesOrder: '',
  otherOrder: '',
  salesView: '',
};

async function openAs(
  browser: Browser,
  email: string,
  viewport = { width: 1440, height: 900 },
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
      const base = bases.items.find((item) => item.name === 'Chăm sóc khách hàng');
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

interface LinkRef {
  id: string;
  title: string | null;
}

async function reverseLinks(page: Page, customerId: string): Promise<LinkRef[]> {
  const record = await ok<{ fields: Record<string, LinkRef[] | null> }>(
    page,
    'GET',
    `/tables/${ids.customers}/records/${customerId}?field_key_type=id`,
  );
  return record.fields[ids.reverse] ?? [];
}

async function shot(page: Page, name: string) {
  await animationsSettled(page);
  if (SHOTS === undefined) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

async function openCustomer(page: Page, customerId: string) {
  await page.goto(
    `/b/${ids.baseId}/t/${ids.customers}/v/${ids.customersView}?record=${customerId}`,
  );
  const section = page.getByTestId('subtable').filter({ hasText: names.reverse });
  await expect(section).toBeVisible();
  return section;
}

test.describe.serial('T416 embedded sub-table', () => {
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
    Object.assign(ids, await findDemo(page));
    const link = await ok<{ id: string; options: { symmetric_field_id: string } }>(
      page,
      'POST',
      `/tables/${ids.orders}/fields`,
      {
        name: names.customerLink,
        type: 'link',
        options: {
          link_table: ids.customers,
          bidirectional: true,
          bidirectional_link_field_name: names.reverse,
        },
      },
    );
    ids.customerLink = link.id;
    ids.reverse = link.options.symmetric_field_id;
    const related = await ok<{ id: string }>(page, 'POST', `/tables/${ids.orders}/fields`, {
      name: names.related,
      type: 'link',
      options: { link_table: ids.orders },
    });
    ids.related = related.id;
    const customers = await ok<{ records: { id: string }[] }>(
      page,
      'POST',
      `/tables/${ids.customers}/records?field_key_type=name`,
      { records: [{ fields: { Tên: names.small } }, { fields: { Tên: names.big } }] },
    );
    ids.small = customers.records[0]?.id ?? '';
    ids.big = customers.records[1]?.id ?? '';
    const orders = await ok<{ records: { id: string }[] }>(
      page,
      'POST',
      `/tables/${ids.orders}/records/query?field_key_type=id`,
      { offset: 0, limit: 80, include_total: false },
    );
    ids.orderIds = orders.records.map((record) => record.id);
    // Three orders of the small customer, 55 of the big one (written on the reverse side).
    await ok(page, 'PATCH', `/tables/${ids.customers}/records?field_key_type=id`, {
      records: [
        { id: ids.small, fields: { [ids.reverse]: ids.orderIds.slice(0, 3) } },
        { id: ids.big, fields: { [ids.reverse]: ids.orderIds.slice(10, 65) } },
      ],
    });
    // A personal view of Customers: the column choice is saved there.
    const view = await ok<{ id: string }>(page, 'POST', `/tables/${ids.customers}/views`, {
      name: `T416 ${RUN}`,
      type: 'grid',
      is_personal: true,
    });
    ids.customersView = view.id;
    await context.close();

    // u_sales1's own order, linked (by the admin) to one of theirs and one they cannot read.
    const sales = await openAs(browser, SALES1);
    const views = await ok<{ items: { id: string; name: string }[] }>(
      sales.page,
      'GET',
      `/tables/${ids.orders}/views`,
    );
    ids.salesView = views.items.find((item) => item.name === 'Đơn của tôi')?.id ?? '';
    const mine = await ok<{ records: { id: string }[] }>(
      sales.page,
      'POST',
      `/tables/${ids.orders}/records/query?field_key_type=id`,
      { view_id: ids.salesView, offset: 0, limit: 2, include_total: false },
    );
    ids.salesOrder = mine.records[0]?.id ?? '';
    const readable = new Set(mine.records.map((record) => record.id));
    const all = await ok<{ records: { id: string }[] }>(
      sales.page,
      'POST',
      `/tables/${ids.orders}/records/query?field_key_type=id`,
      { offset: 0, limit: 1000, include_total: false },
    );
    const salesReads = new Set(all.records.map((record) => record.id));
    ids.otherOrder = ids.orderIds.find((id) => !salesReads.has(id) && !readable.has(id)) ?? '';
    await sales.context.close();
    const admin = await openAs(browser, WORKER_ORG.email('admin'));
    await ok(
      admin.page,
      'PATCH',
      `/tables/${ids.orders}/records/${ids.salesOrder}?field_key_type=id`,
      {
        fields: { [ids.related]: [mine.records[1]?.id ?? '', ids.otherOrder] },
      },
    );
    await admin.context.close();
  });

  test.afterAll(async ({ browser }) => {
    const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
    // The demo base goes back to its fields (the next specs count on them).
    await api(page, 'DELETE', `/fields/${ids.reverse}`);
    await api(page, 'DELETE', `/fields/${ids.customerLink}`);
    await api(page, 'DELETE', `/fields/${ids.related}`);
    await api(page, 'DELETE', `/views/${ids.customersView}`);
    await context.close();
  });

  test("a customer's orders as a sub-table: default columns, totals, keyboard", async ({
    browser,
  }) => {
    const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
    const section = await openCustomer(page, ids.small);
    await expect(section.getByTestId('subtable-count')).toHaveText('3 rows');
    const table = section.getByRole('table', { name: names.reverse });
    // The first five fields of Orders (the reverse link, always this customer, left out).
    await expect(table.getByRole('columnheader')).toHaveText([
      'Row',
      DEMO_ORDER_TITLE,
      'amount',
      'cost',
      'status',
      'owner',
      'Actions',
    ]);
    await expect(section.getByTestId('subtable-row')).toHaveCount(3);
    await expect(section.getByTestId('subtable-summary')).toContainText('Total 3 rows');
    // Arrow keys move between cells, the panel stays on the record.
    const first = section.getByTestId('subtable-row').first();
    await first.getByRole('button', { name: /^amount/u }).focus();
    await page.keyboard.press('ArrowDown');
    await expect(
      section
        .getByTestId('subtable-row')
        .nth(1)
        .getByRole('button', { name: /^amount/u }),
    ).toBeFocused();
    expect(page.url()).toContain(`record=${ids.small}`);
    await expectNoSeriousA11yViolations(page, 'record panel with sub-table');
    await first.hover();
    await shot(page, 'subtable-desktop');
    await context.close();
  });

  test('edits an amount in place; a second tab sees it live', async ({ browser }) => {
    const a = await openAs(browser, WORKER_ORG.email('admin'));
    const b = await openAs(browser, WORKER_ORG.email('admin'));
    const sectionA = await openCustomer(a.page, ids.small);
    const sectionB = await openCustomer(b.page, ids.small);
    await expect(sectionB.getByTestId('subtable-row')).toHaveCount(3);
    const row = sectionA.getByTestId('subtable-row').first();
    await row.getByRole('button', { name: /^amount/u }).click();
    const input = a.page.getByTestId('subtable-editor').getByRole('textbox');
    await expect(input).toBeFocused();
    await input.fill('1234567');
    await a.page.keyboard.press('Enter');
    await expect(row).toContainText('1,234,567');
    await expect(row.getByRole('button', { name: /^amount/u })).toBeFocused();
    await expect(sectionB.getByTestId('subtable-row').first()).toContainText('1,234,567', {
      timeout: 5_000,
    });
    const order = await ok<{ fields: Record<string, unknown> }>(
      a.page,
      'GET',
      `/tables/${ids.orders}/records/${ids.orderIds[0] ?? ''}?field_key_type=name`,
    );
    expect(order.fields['amount']).toBe(1_234_567);
    await a.context.close();
    await b.context.close();
  });

  test('adds a new order already linked, then names it in place', async ({ browser }) => {
    const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
    const section = await openCustomer(page, ids.small);
    await section.getByTestId('subtable-add-row').click();
    await expect(section.getByTestId('subtable-row')).toHaveCount(4);
    const input = page.getByTestId('subtable-editor').getByRole('textbox');
    await expect(input).toBeFocused();
    await input.fill(names.added);
    await page.keyboard.press('Enter');
    await expect(section.getByTestId('subtable-row').nth(3)).toContainText(names.added);
    await expect
      .poll(async () => (await reverseLinks(page, ids.small)).map((ref) => ref.title))
      .toContain(names.added);
    await context.close();
  });

  test('links an existing order through the picker; unlinks it with undo', async ({ browser }) => {
    const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
    const section = await openCustomer(page, ids.small);
    // A title found once (demo titles repeat).
    const title = `Đơn chọn ${RUN}`;
    await ok(
      page,
      'PATCH',
      `/tables/${ids.orders}/records/${ids.orderIds[5] ?? ''}?field_key_type=name`,
      { fields: { [DEMO_ORDER_TITLE]: title } },
    );
    await section.getByTestId('subtable-link-existing').click();
    const dialog = page.getByRole('dialog', { name: 'Link Orders' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('combobox').fill(title);
    await expect(dialog.getByRole('option')).toHaveCount(1);
    await expect(dialog.getByRole('option').first()).toContainText(title);
    await page.keyboard.press('Enter');
    await dialog.getByTestId('link-save').click();
    await expect(dialog).toBeHidden();
    await expect(section.getByTestId('subtable-row')).toHaveCount(5);
    await expect
      .poll(async () => (await reverseLinks(page, ids.small)).map((ref) => ref.id))
      .toContain(ids.orderIds[5]);

    // Unlink: the order leaves the sub-table, not the table; "Undo" puts it back.
    const row = section.locator(`[data-record-id="${ids.orderIds[5] ?? ''}"]`);
    await row.hover();
    await row.getByTestId('subtable-unlink').click();
    await expect(section.getByTestId('subtable-row')).toHaveCount(4);
    const toast = page.getByRole('status').filter({ hasText: 'Unlinked' });
    await expect(toast).toBeVisible();
    await shot(page, 'subtable-unlink-toast');
    const still = await api(page, 'GET', `/tables/${ids.orders}/records/${ids.orderIds[5] ?? ''}`);
    expect(still.status).toBe(200);
    await toast.getByRole('button', { name: 'Undo' }).click();
    await expect(section.getByTestId('subtable-row')).toHaveCount(5);
    await expect
      .poll(async () => (await reverseLinks(page, ids.small)).map((ref) => ref.id))
      .toContain(ids.orderIds[5]);
    await context.close();
  });

  test('the column choice is saved to the view', async ({ browser }) => {
    const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
    const section = await openCustomer(page, ids.small);
    await section.getByTestId('subtable-columns').click();
    const picker = page.getByRole('dialog', { name: 'Columns in the sub-table' });
    await expect(picker).toContainText(`Saved for the view “T416 ${RUN}”`);
    await expectNoSeriousA11yViolations(page, 'sub-table column picker');
    await shot(page, 'subtable-columns');
    await picker.getByRole('checkbox', { name: 'cost' }).uncheck();
    await expect(section.getByRole('columnheader', { name: 'cost' })).toHaveCount(0);
    const fields = await ok<{ items: { id: string; name: string }[] }>(
      page,
      'GET',
      `/tables/${ids.orders}/fields`,
    );
    const fieldId = (name: string) => fields.items.find((item) => item.name === name)?.id;
    await expect
      .poll(async () => {
        const view = await ok<{
          config: { record_detail?: { link_columns: Record<string, string[]> } };
        }>(page, 'GET', `/views/${ids.customersView}`);
        return view.config.record_detail?.link_columns[ids.reverse] ?? [];
      })
      .toEqual([DEMO_ORDER_TITLE, 'amount', 'status', 'owner'].map(fieldId));
    await page.reload();
    const again = page.getByTestId('subtable').filter({ hasText: names.reverse });
    await expect(again.getByRole('columnheader', { name: 'amount' })).toBeVisible();
    await expect(again.getByRole('columnheader', { name: 'cost' })).toHaveCount(0);
    await context.close();
  });

  test('more than 50 links: "50 / 55" and "View all" opens Orders filtered', async ({
    browser,
  }) => {
    const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
    const section = await openCustomer(page, ids.big);
    await expect(section.getByTestId('subtable-count')).toHaveText('50 / 55');
    await expect(section.getByTestId('subtable-row')).toHaveCount(50);
    await section.getByTestId('subtable-view-all').scrollIntoViewIfNeeded();
    await shot(page, 'subtable-capped');
    await section.getByTestId('subtable-view-all').click();
    await expect(page).toHaveURL(new RegExp(`/b/${ids.baseId}/t/${ids.orders}/v/viw_`, 'u'));
    // The view screen drops `?linked=` once the view is loaded and the filter applied
    // (`useLinkedFilterParam`): wait for it, a one-off read of the URL can come first.
    await expect(page).not.toHaveURL(/[?&]linked=/u);
    // A temporary filter of the view on the reverse link: exactly this customer's orders.
    await expect(page.getByRole('button', { name: 'Filter: 1 condition' })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: /^55 records$/u })).toBeVisible();
    await shot(page, 'subtable-view-all');
    await context.close();
  });

  test('u_sales1: a record out of reach is a locked row; unreadable table is a count (P20)', async ({
    browser,
  }) => {
    const { context, page } = await openAs(browser, SALES1);
    await page.goto(`/b/${ids.baseId}/t/${ids.orders}/v/${ids.salesView}?record=${ids.salesOrder}`);
    const section = page.getByTestId('subtable').filter({ hasText: names.related });
    await expect(section.getByTestId('subtable-row')).toHaveCount(2);
    await expect(section.getByTestId('subtable-locked-row')).toHaveCount(1);
    await expect(section.getByTestId('subtable-locked-row')).toHaveText(
      'You cannot see this record',
    );
    // Customers is not readable for Sales: no rows, only the count.
    await expect(
      page.getByTestId('subtable-locked').filter({ hasText: names.customerLink }),
    ).toContainText('You do not have access to the linked table.');
    await expectNoSeriousA11yViolations(page, 'sub-table for u_sales1');
    await shot(page, 'subtable-sales-locked');
    await context.close();
  });

  test('phone: the sub-table is a list of cards', async ({ browser }) => {
    const { context, page } = await openAs(browser, WORKER_ORG.email('admin'), {
      width: 390,
      height: 844,
    });
    const section = await openCustomer(page, ids.small);
    await expect(section.getByTestId('subtable-cards')).toBeVisible();
    await expect(section.getByTestId('subtable-card')).toHaveCount(
      (await reverseLinks(page, ids.small)).length,
    );
    const menu = section.getByTestId('subtable-card-menu').first();
    const box = await menu.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
    await section.getByTestId('subtable-add').scrollIntoViewIfNeeded();
    // The panel covers the screen; the Customers card list behind it is not part of T416
    // (its tel:/mailto: links fail target-size there: carried over to T421).
    await animationsSettled(page);
    const results = await new AxeBuilder({ page })
      .include('[data-testid="record-panel"]')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(
      results.violations
        .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
        .map((violation) => violation.id),
      'axe violations on sub-table cards (phone)',
    ).toEqual([]);
    await shot(page, 'subtable-mobile');
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(390);
    await menu.click();
    await page.getByRole('menuitem', { name: 'Open record' }).click();
    await expect(page).toHaveURL(new RegExp(`/t/${ids.orders}/.*record=rec_`, 'u'));
    await context.close();
  });
});
