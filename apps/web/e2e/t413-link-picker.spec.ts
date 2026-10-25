import { mkdirSync } from 'node:fs';

import { type Browser, type BrowserContext, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { DEMO_PASSWORD } from './seed';
import { animationsSettled, api, apiSignIn, expectNoSeriousA11yViolations, ok } from './support';

/**
 * T413: link cells and the link picker on the demo base (CONTRACTS §9).
 * The spec adds two link fields to Orders (several customers, one
 * customer) and a few customers of its own, then: links through the
 * dialog with the keyboard (another tab sees the chips), the single-link
 * popover, search, "selected only", the 500-link limit, creating a record
 * inline, undo, paste of titles, locked chips for u_sales1 (P20: Customers
 * is not readable for Sales), a renamed customer in another tab, and the
 * full-screen picker on a phone.
 */

const DEMO_BASE = 'Chăm sóc khách hàng';
const SALES1 = WORKER_ORG.email('sales1');
const RUN = String(Date.now()).slice(-6);
const HEADER_HEIGHT = 36;
const ROW_HEIGHT = 34;
const PRIMARY_WIDTH = 200;
const MULTI_WIDTH = 360;
/** Screenshots compared with the design boards (T413 report); saved only when `T413_SHOTS=<dir>` is set. */
const SHOTS = process.env['T413_SHOTS'];

const names = {
  anPhat: `An Phát ${RUN}`,
  binhMinh: `Bình Minh ${RUN}`,
  hoaBinh: `Cửa hàng Hoà Bình ${RUN}`,
  laXanh: `Quán cà phê Lá Xanh ${RUN}`,
  created: `Khách mới ${RUN}`,
  renamed: `An Phát Group ${RUN}`,
};

interface Ids {
  baseId: string;
  orders: string;
  customers: string;
  multi: string;
  single: string;
  viewId: string;
  salesViewId: string;
  customerIds: Record<string, string>;
  /** Customers created for the 500-link limit. */
  bulk: string[];
  orderIds: string[];
  salesOrderId: string;
}

const ids: Ids = {
  baseId: '',
  orders: '',
  customers: '',
  multi: '',
  single: '',
  viewId: '',
  salesViewId: '',
  customerIds: {},
  bulk: [],
  orderIds: [],
  salesOrderId: '',
};

const multiName = `Khách hàng ${RUN}`;
const singleName = `Khách chính ${RUN}`;

async function openAs(
  browser: Browser,
  email: string,
  viewport = { width: 1440, height: 900 },
  colorScheme: 'light' | 'dark' = 'light',
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport, colorScheme, locale: 'en-US' });
  await context.addInitScript(() => {
    window.localStorage.setItem('cellhive.language', 'en');
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
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

/** A personal grid view of Orders showing the primary field and the two link fields. */
async function personalView(page: Page, name: string, multi: string, single: string) {
  const fields = await ok<{ items: { id: string; is_primary: boolean }[] }>(
    page,
    'GET',
    `/tables/${ids.orders}/fields`,
  );
  const primary = fields.items.find((field) => field.is_primary)?.id ?? '';
  const hidden = fields.items
    .filter((field) => !field.is_primary && field.id !== multi && field.id !== single)
    .map((field) => field.id);
  const view = await ok<{ id: string }>(page, 'POST', `/tables/${ids.orders}/views`, {
    name,
    type: 'grid',
    is_personal: true,
    config: {
      hidden_fields: hidden,
      field_order: [multi, single],
      column_widths: { [primary]: PRIMARY_WIDTH, [multi]: MULTI_WIDTH, [single]: 240 },
    },
  });
  return view.id;
}

async function openGrid(page: Page, viewId: string) {
  await page.goto(`/b/${ids.baseId}/t/${ids.orders}/v/${viewId}`);
  await expect(page.locator('.ob-grid canvas').first()).toBeVisible();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: /records?$/u })
      .first(),
  ).toBeVisible();
}

function cell(page: Page, column: number, row: number) {
  return page.getByTestId(`glide-cell-${String(column)}-${String(row)}`);
}

/** Width of the row numbers for `rows` rows (GridView `numberWidth`). */
function markerWidth(rows: number): number {
  return Math.max(40, String(rows).length * 8 + 16);
}

/** Selects the primary cell of data row `row`, then moves right `right` columns with the keyboard. */
async function selectCell(page: Page, row: number, right: number, rows = 5000) {
  const canvas = page.locator('.ob-grid [data-testid="data-grid-canvas"]');
  const box = await canvas.boundingBox();
  if (box === null) throw new Error('grid not laid out');
  await page.mouse.click(
    box.x + markerWidth(rows) + 24,
    box.y + HEADER_HEIGHT + ROW_HEIGHT * row + ROW_HEIGHT / 2,
  );
  await expect(cell(page, 1, row)).toHaveAttribute('aria-selected', 'true');
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.closest('.ob-grid') != null))
    .toBe(true);
  for (let step = 0; step < right; step += 1) await page.keyboard.press('ArrowRight');
  await expect(cell(page, 1 + right, row)).toHaveAttribute('aria-selected', 'true');
}

interface LinkRef {
  id: string;
  title: string | null;
}

async function linksOf(page: Page, recordId: string, fieldId: string): Promise<LinkRef[]> {
  const record = await ok<{ fields: Record<string, LinkRef[] | null> }>(
    page,
    'GET',
    `/tables/${ids.orders}/records/${recordId}?field_key_type=id`,
  );
  return record.fields[fieldId] ?? [];
}

async function setLinks(page: Page, recordId: string, fieldId: string, value: string[] | null) {
  await ok(page, 'PATCH', `/tables/${ids.orders}/records/${recordId}?field_key_type=id`, {
    fields: { [fieldId]: value },
  });
}

async function shot(page: Page, name: string) {
  await animationsSettled(page);
  if (SHOTS === undefined) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

test.describe.serial('T413 link cells and picker', () => {
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
    Object.assign(ids, await findDemo(page));
    const created = await ok<{ records: { id: string; fields: Record<string, unknown> }[] }>(
      page,
      'POST',
      `/tables/${ids.customers}/records?field_key_type=name`,
      {
        records: Object.values(names)
          .slice(0, 4)
          .map((name) => ({ fields: { Tên: name } })),
      },
    );
    for (const record of created.records) {
      ids.customerIds[String(record.fields['Tên'])] = record.id;
    }
    const bulk = await ok<{ records: { id: string }[] }>(
      page,
      'POST',
      `/tables/${ids.customers}/records?field_key_type=name`,
      {
        records: Array.from({ length: 501 }, (_, index) => ({
          fields: { Tên: `Lô ${RUN} ${String(index + 1).padStart(3, '0')}` },
        })),
      },
    );
    ids.bulk = bulk.records.map((record) => record.id);
    const multi = await ok<{ id: string }>(page, 'POST', `/tables/${ids.orders}/fields`, {
      name: multiName,
      type: 'link',
      options: { link_table: ids.customers },
    });
    const single = await ok<{ id: string }>(page, 'POST', `/tables/${ids.orders}/fields`, {
      name: singleName,
      type: 'link',
      options: { link_table: ids.customers, allow_multiple: false },
    });
    ids.multi = multi.id;
    ids.single = single.id;
    ids.viewId = await personalView(page, `T413 ${RUN}`, multi.id, single.id);
    const orders = await ok<{ records: { id: string }[] }>(
      page,
      'POST',
      `/tables/${ids.orders}/records/query?field_key_type=id`,
      { view_id: ids.viewId, offset: 0, limit: 6, include_total: false },
    );
    ids.orderIds = orders.records.map((record) => record.id);
    // The 500-link limit: row 4 already holds 500 customers.
    await setLinks(page, ids.orderIds[4] ?? '', ids.multi, ids.bulk.slice(0, 500));
    await context.close();

    // u_sales1's own order (P20): linked by the admin to a customer Sales cannot read.
    const sales = await openAs(browser, SALES1);
    ids.salesViewId = await personalView(sales.page, `T413 sales ${RUN}`, multi.id, single.id);
    const mine = await ok<{ records: { id: string }[] }>(
      sales.page,
      'POST',
      `/tables/${ids.orders}/records/query?field_key_type=id`,
      { view_id: ids.salesViewId, offset: 0, limit: 1, include_total: false },
    );
    ids.salesOrderId = mine.records[0]?.id ?? '';
    await sales.context.close();
    const admin = await openAs(browser, WORKER_ORG.email('admin'));
    await setLinks(admin.page, ids.salesOrderId, ids.multi, [
      ids.customerIds[names.anPhat] ?? '',
      ids.customerIds[names.binhMinh] ?? '',
    ]);
    await admin.context.close();
  });

  test.afterAll(async ({ browser }) => {
    const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
    // The demo base goes back to its fields (the next specs count on them).
    await api(page, 'DELETE', `/fields/${ids.multi}`);
    await api(page, 'DELETE', `/fields/${ids.single}`);
    await context.close();
  });

  test('links 3 customers with the keyboard in the dialog; another tab sees the chips', async ({
    browser,
  }) => {
    const a = await openAs(browser, WORKER_ORG.email('admin'));
    const b = await openAs(browser, WORKER_ORG.email('admin'));
    await openGrid(a.page, ids.viewId);
    await openGrid(b.page, ids.viewId);

    await selectCell(a.page, 0, 1);
    await a.page.keyboard.press('Enter');
    const dialog = a.page.getByRole('dialog', { name: 'Link Customers' });
    await expect(dialog).toBeVisible();
    const search = dialog.getByRole('combobox');
    await expect(search).toBeFocused();
    for (const name of [names.anPhat, names.binhMinh, names.hoaBinh]) {
      await search.fill(name);
      await expect(dialog.getByRole('option').first()).toContainText(name);
      await expect(dialog.getByRole('option')).toHaveCount(1);
      await a.page.keyboard.press('Enter');
      await expect(dialog.getByTestId('link-selected').filter({ hasText: name })).toBeVisible();
    }
    await expect(dialog.getByTestId('link-selected-count')).toHaveText('3 / 500');
    await expectNoSeriousA11yViolations(a.page, 'link picker dialog');

    // "Selected only": exactly the three chosen records.
    await search.fill('');
    await dialog.getByTestId('link-scope-selected').click();
    await expect(dialog.getByRole('option')).toHaveCount(3);
    await dialog.getByTestId('link-scope-all').click();
    await shot(a.page, 'dialog-light');

    const started = Date.now();
    await a.page.keyboard.press('ControlOrMeta+Enter');
    await expect(dialog).toBeHidden();
    // Focus back on the cell.
    await expect
      .poll(() => a.page.evaluate(() => document.activeElement?.closest('.ob-grid') != null))
      .toBe(true);
    await expect(cell(b.page, 2, 0)).toContainText(names.anPhat, { timeout: 5_000 });
    expect(Date.now() - started).toBeLessThan(5_000);
    await expect(cell(b.page, 2, 0)).toContainText(names.hoaBinh);
    const links = await linksOf(a.page, ids.orderIds[0] ?? '', ids.multi);
    expect(links.map((link) => link.title)).toEqual([names.anPhat, names.binhMinh, names.hoaBinh]);
    await shot(a.page, 'cell-chips');
    await a.context.close();
    await b.context.close();
  });

  test('the single-link popover: search, Enter chooses and closes; undo restores', async ({
    browser,
  }) => {
    const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
    await openGrid(page, ids.viewId);
    await selectCell(page, 1, 2);
    await page.keyboard.type('hoa');
    const popover = page.getByRole('dialog', { name: 'Choose Customers' });
    await expect(popover).toBeVisible();
    await expect(popover.getByRole('combobox')).toHaveValue('hoa');
    await popover.getByRole('combobox').fill(`Hoà Bình ${RUN}`);
    await expect(popover.getByRole('option')).toHaveCount(1);
    await expect(popover.getByRole('option').locator('mark')).toHaveText(`Hoà Bình ${RUN}`);
    await expectNoSeriousA11yViolations(page, 'link picker popover');
    await shot(page, 'popover');
    await page.keyboard.press('Enter');
    await expect(popover).toBeHidden();
    await expect(cell(page, 3, 1)).toContainText(names.hoaBinh);
    await expect
      .poll(async () => (await linksOf(page, ids.orderIds[1] ?? '', ids.single)).map((l) => l.id))
      .toEqual([ids.customerIds[names.hoaBinh]]);

    // Undo (Ctrl/⌘+Z) takes the link away again.
    await page.keyboard.press('ControlOrMeta+z');
    await expect
      .poll(async () => (await linksOf(page, ids.orderIds[1] ?? '', ids.single)).length)
      .toBe(0);
    await expect(cell(page, 3, 1)).toHaveText('');

    // Escape cancels without writing.
    await page.keyboard.press('Enter');
    await expect(popover).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
    expect(await linksOf(page, ids.orderIds[1] ?? '', ids.single)).toEqual([]);
    await context.close();
  });

  test('the cell full at 500 links blocks adding; the chips end with +N', async ({ browser }) => {
    const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
    await openGrid(page, ids.viewId);
    await expect(cell(page, 2, 4)).toContainText(`Lô ${RUN} 001`);
    await selectCell(page, 4, 1);
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Link Customers' });
    await expect(dialog.getByTestId('link-selected-count')).toHaveText('500 / 500');
    await expect(dialog.getByText('The cell holds 500 links.')).toBeVisible();
    await dialog.getByRole('combobox').fill(`Lô ${RUN} 501`);
    const extra = dialog.getByRole('option').filter({ hasText: `Lô ${RUN} 501` });
    await expect(extra).toHaveAttribute('aria-disabled', 'true');
    // Enter on it (the active option) adds nothing.
    await page.keyboard.press('Enter');
    await expect(extra).toHaveAttribute('aria-selected', 'false');
    await expect(dialog.getByTestId('link-selected-count')).toHaveText('500 / 500');
    await shot(page, 'dialog-limit');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await context.close();
  });

  test('creates a customer inline and links it', async ({ browser }) => {
    const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
    await openGrid(page, ids.viewId);
    await selectCell(page, 2, 1);
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Link Customers' });
    await dialog.getByRole('combobox').fill(names.created);
    await expect(dialog.getByText(`Nothing in Customers matches “${names.created}”`)).toBeVisible();
    await dialog.getByTestId('link-create').click();
    await expect(
      dialog.getByTestId('link-selected').filter({ hasText: names.created }),
    ).toBeVisible();
    await dialog.getByTestId('link-save').click();
    await expect(dialog).toBeHidden();
    await expect
      .poll(async () => (await linksOf(page, ids.orderIds[2] ?? '', ids.multi)).map((l) => l.title))
      .toEqual([names.created]);
    await context.close();
  });

  test('pasting "title, title" links both customers', async ({ browser }) => {
    const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
    await openGrid(page, ids.viewId);
    await selectCell(page, 3, 1);
    await page.evaluate(
      (text) => navigator.clipboard.writeText(text),
      `${names.anPhat}, ${names.binhMinh}`,
    );
    await page.keyboard.press('ControlOrMeta+v');
    await expect
      .poll(async () => (await linksOf(page, ids.orderIds[3] ?? '', ids.multi)).map((l) => l.id))
      .toEqual([ids.customerIds[names.anPhat], ids.customerIds[names.binhMinh]]);
    await expect(cell(page, 2, 3)).toContainText(names.binhMinh);
    await context.close();
  });

  test('hover card of a chip, renamed customer updates the chips of another tab', async ({
    browser,
  }) => {
    const a = await openAs(browser, WORKER_ORG.email('admin'));
    await openGrid(a.page, ids.viewId);
    const canvas = a.page.locator('.ob-grid [data-testid="data-grid-canvas"]');
    const box = await canvas.boundingBox();
    if (box === null) throw new Error('grid not laid out');
    await a.page.mouse.move(
      box.x + markerWidth(5000) + PRIMARY_WIDTH + 30,
      box.y + HEADER_HEIGHT + ROW_HEIGHT / 2,
    );
    const card = a.page.getByTestId('link-hover-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText(names.anPhat);
    await expect(card.getByRole('button', { name: 'Open record' })).toBeVisible();
    await shot(a.page, 'hover-card');
    await a.page.mouse.move(box.x + 5, box.y + 5);
    await expect(card).toBeHidden();

    const b = await openAs(browser, WORKER_ORG.email('admin'));
    await ok(
      b.page,
      'PATCH',
      `/tables/${ids.customers}/records/${ids.customerIds[names.anPhat] ?? ''}?field_key_type=name`,
      { fields: { Tên: names.renamed } },
    );
    await expect(cell(a.page, 2, 0)).toContainText(names.renamed, { timeout: 5_000 });
    await a.context.close();
    await b.context.close();
  });

  test('u_sales1 sees locked chips and cannot open the picker (P20)', async ({ browser }) => {
    const { context, page } = await openAs(browser, SALES1);
    await openGrid(page, ids.salesViewId);
    await expect(cell(page, 2, 0)).toHaveText('2 links');
    const total = Number(
      (
        (await page
          .getByRole('status')
          .filter({ hasText: /records?$/u })
          .first()
          .textContent()) ?? '0'
      ).replace(/[^0-9]/gu, ''),
    );
    await selectCell(page, 0, 1, total);
    await page.keyboard.press('Enter');
    await expect(page.getByText('You cannot see the linked table')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await shot(page, 'sales-locked');
    const links = await linksOf(page, ids.salesOrderId, ids.multi);
    expect(links).toHaveLength(2);
    expect(links.every((link) => link.title === null)).toBe(true);
    await context.close();
  });

  test('dark theme dialog', async ({ browser }) => {
    const { context, page } = await openAs(browser, WORKER_ORG.email('admin'), undefined, 'dark');
    await openGrid(page, ids.viewId);
    await selectCell(page, 0, 1);
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Link Customers' });
    await expect(dialog.getByRole('option').first()).toBeVisible();
    await expectNoSeriousA11yViolations(page, 'link picker dialog (dark)');
    await shot(page, 'dialog-dark');
    await context.close();
  });

  test('the field dialog creates a link field with a table, one record and a condition', async ({
    browser,
  }) => {
    const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
    await openGrid(page, ids.viewId);
    await page.getByTestId('grid-add-field').click();
    const dialog = page.getByRole('dialog', { name: 'New field' });
    const name = `Khách giới thiệu ${RUN}`;
    await dialog.getByLabel('Name').fill(name);
    await dialog.getByLabel('Field type').selectOption('link');
    await dialog.getByRole('button', { name: 'Create field' }).click();
    // No table chosen yet: the form says so and sends nothing.
    await expect(dialog.getByText('Required', { exact: false }).first()).toBeVisible();
    await dialog.getByLabel('Linked table').selectOption({ label: 'Customers' });
    await dialog.getByLabel('Allow several records').uncheck();
    const conditions = dialog.getByRole('group', { name: 'Only records that match' });
    await conditions.getByRole('button', { name: 'Add condition', exact: true }).click();
    await conditions.getByRole('textbox').first().fill('Lô');
    await expectNoSeriousA11yViolations(page, 'link field dialog');
    await shot(page, 'field-dialog-link');
    await dialog.getByRole('button', { name: 'Create field' }).click();
    await expect(dialog).toBeHidden();
    const fields = await ok<{
      items: { id: string; name: string; options: Record<string, unknown> }[];
    }>(page, 'GET', `/tables/${ids.orders}/fields`);
    const created = fields.items.find((item) => item.name === name);
    expect(created?.options).toMatchObject({ link_table: ids.customers, allow_multiple: false });
    expect(JSON.stringify(created?.options['record_filter'])).toContain('Lô');
    await api(page, 'DELETE', `/fields/${created?.id ?? ''}`);
    await context.close();
  });

  test('phone: the picker covers the screen and saves', async ({ browser }) => {
    const { context, page } = await openAs(browser, WORKER_ORG.email('admin'), {
      width: 390,
      height: 844,
    });
    await page.goto(
      `/b/${ids.baseId}/t/${ids.orders}/v/${ids.viewId}?record=${ids.orderIds[5] ?? ''}`,
    );
    // Several records: the field is an embedded sub-table (T416), empty here.
    const field = page.getByTestId('subtable').filter({ hasText: multiName });
    await field.getByRole('button', { name: 'Link existing' }).click();
    const sheet = page.getByTestId('link-picker-sheet');
    await expect(sheet).toBeVisible();
    await sheet.getByRole('combobox').fill(names.laXanh);
    await sheet.getByRole('option').filter({ hasText: names.laXanh }).click();
    await expect(sheet.getByTestId('link-save')).toHaveText('Save (1)');
    await expectNoSeriousA11yViolations(page, 'link picker (phone)');
    await shot(page, 'mobile-sheet');
    await sheet.getByTestId('link-save').click();
    await expect(sheet).toBeHidden();
    await expect
      .poll(async () => (await linksOf(page, ids.orderIds[5] ?? '', ids.multi)).map((l) => l.title))
      .toEqual([names.laXanh]);
    await context.close();
  });
});
