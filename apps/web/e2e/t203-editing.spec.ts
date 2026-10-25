import { type Browser, type Page, type Request } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { DEMO_PASSWORD } from './seed';
import { api, apiSignIn, collectCspViolations, expectNoSeriousA11yViolations } from './support';

/**
 * T203: editing cells of the demo base (CONTRACTS §9): the optimistic edit
 * with its conflict toast (two users on the same cell), client-side
 * validation, field permissions (u_sales1 and `status`, CONTRACTS §5 P10)
 * and adding / deleting records.
 */

const DEMO_BASE = 'Chăm sóc khách hàng';
const EDITOR_EMAIL = WORKER_ORG.email('editor');
const SALES1_EMAIL = WORKER_ORG.email('sales1');
const ADMIN_NAME = 'Nguyễn Minh Anh';
/** Row markers of a grid with up to 9 999 rows (GridView: 4 digits × 8 + 16). */
const ROW_MARKER_WIDTH = 48;
const HEADER_HEIGHT = 36;
const ROW_HEIGHT = 34;

/** Signs in with the shared `apiSignIn` (waits out the per-IP limit). */
async function signIn(page: Page, email: string, language: 'en' | 'vi' = 'en') {
  await page.addInitScript((lang) => {
    if (window.localStorage.getItem('cellhive.language') === null) {
      window.localStorage.setItem('cellhive.language', lang);
    }
  }, language);
  await page.goto('/login');
  await apiSignIn(page, email, DEMO_PASSWORD);
}

/** Opens a table of the demo base from the organization home; returns its URL. */
async function openTable(page: Page, tableName: string): Promise<string> {
  await page.goto('/');
  await page.getByRole('link', { name: DEMO_BASE }).first().click();
  await expect(page).toHaveURL(/\/t\/tbl_/u);
  await page
    .getByRole('navigation', { name: /Tables|Các bảng/u })
    .getByRole('link', { name: tableName })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: tableName })).toBeVisible();
  await expect(page.locator('table[role="grid"] td[role="gridcell"]').first()).toBeAttached();
  return page.url();
}

async function gotoTable(page: Page, url: string, tableName: string) {
  await page.goto(url);
  await expect(page.getByRole('heading', { level: 1, name: tableName })).toBeVisible();
  await expect(page.locator('table[role="grid"] td[role="gridcell"]').first()).toBeAttached();
}

/** 1-based column of a field in glide's accessibility table. */
async function columnOf(page: Page, fieldName: string): Promise<number> {
  const header = page
    .locator('table[role="grid"] th[role="columnheader"]')
    .filter({ hasText: new RegExp(`^${fieldName}$`, 'u') });
  return Number(await header.getAttribute('aria-colindex'));
}

/** Selects the cell of `fieldName` in data row `row` (0-based) with the keyboard. */
async function selectCell(page: Page, fieldName: string, row = 0) {
  const canvas = page.locator('.ob-grid [data-testid="data-grid-canvas"]');
  const box = await canvas.boundingBox();
  if (box === null) throw new Error('grid not laid out');
  await page.mouse.click(
    box.x + ROW_MARKER_WIDTH + 24,
    box.y + HEADER_HEIGHT + ROW_HEIGHT * row + ROW_HEIGHT / 2,
  );
  await expect(cellText(page, 1, row)).toHaveAttribute('aria-selected', 'true');
  const column = await columnOf(page, fieldName);
  for (let step = 1; step < column; step += 1) await page.keyboard.press('ArrowRight');
  await expect(cellText(page, column, row)).toHaveAttribute('aria-selected', 'true');
}

/** Text of a visible cell in the accessibility table (data row `row`, 0-based). */
function cellText(page: Page, column: number, row = 0) {
  return page.getByTestId(`glide-cell-${String(column)}-${String(row)}`);
}

function editor(page: Page) {
  return page.locator('#portal');
}

function isRecordWrite(request: Request): boolean {
  return (
    request.method() === 'PATCH' && /\/api\/v1\/tables\/tbl_[^/]+\/records/u.test(request.url())
  );
}

async function newUser(browser: Browser, email: string, language: 'en' | 'vi' = 'en') {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1000 } });
  const page = await context.newPage();
  await signIn(page, email, language);
  return { context, page };
}

test.describe.serial('T203 cell editing', () => {
  test.use({ viewport: { width: 1920, height: 1000 } });

  let ticketsUrl = '';
  let ordersUrl = '';

  test('typing letters into a number cell sends nothing and explains', async ({ page }) => {
    const cspViolations = collectCspViolations(page);
    await signIn(page, WORKER_ORG.email('admin'));
    ticketsUrl = await openTable(page, 'Tickets');
    const writes: string[] = [];
    page.on('request', (request) => {
      if (isRecordWrite(request)) writes.push(request.url());
    });

    await selectCell(page, 'Số tiền');
    await page.keyboard.press('Enter');
    const input = editor(page).getByRole('textbox', { name: 'Số tiền' });
    await expect(input).toBeFocused();
    await input.fill('abc');
    await page.keyboard.press('Enter');
    await expect(editor(page).getByRole('alert')).toHaveText('Expected a number.');
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expectNoSeriousA11yViolations(page, 'number editor with an error');
    await page.screenshot({ path: test.info().outputPath('number-editor-error.png') });
    await page.keyboard.press('Escape');
    await expect(input).toBeHidden();
    expect(writes).toEqual([]);

    await test.step('a select cell opens its option list', async () => {
      await selectCell(page, 'Trạng thái');
      await page.keyboard.press('Enter');
      const listbox = editor(page).getByRole('listbox', { name: 'Trạng thái' });
      await expect(listbox.getByRole('option', { name: 'Đang xử lý' })).toBeVisible();
      await expectNoSeriousA11yViolations(page, 'select editor');
      await page.screenshot({ path: test.info().outputPath('select-editor.png') });
      await page.keyboard.press('Escape');
      await expect(listbox).toBeHidden();
    });
    expect(writes).toEqual([]);
    expect(cspViolations).toEqual([]);

    // The Orders table of the same base, for the permission test.
    await page
      .getByRole('navigation', { name: 'Tables' })
      .getByRole('link', { name: 'Orders' })
      .click();
    await expect(page.getByRole('heading', { level: 1, name: 'Orders' })).toBeVisible();
    ordersUrl = page.url();
  });

  test('two users edit the same cell: the second one sees the conflict and writes again', async ({
    browser,
  }) => {
    const admin = await newUser(browser, WORKER_ORG.email('admin'));
    const editorUser = await newUser(browser, EDITOR_EMAIL, 'vi');
    try {
      await gotoTable(admin.page, ticketsUrl, 'Tickets');
      await gotoTable(editorUser.page, ticketsUrl, 'Tickets');
      const column = await columnOf(admin.page, 'Tiêu đề');
      const suffix = String(Date.now());
      const theirs = `Máy in lỗi (A ${suffix})`;
      const mine = `Máy in lỗi (B ${suffix})`;

      // Both open the editor; with realtime (T204) the editor's grid gets the
      // admin's value, but it edits what it saw when the editor opened.
      // Right after loading, the first Enter may come before the grid is ready: try again.
      await expect(async () => {
        await selectCell(editorUser.page, 'Tiêu đề');
        await editorUser.page.keyboard.press('Enter');
        await expect(editor(editorUser.page).getByRole('textbox', { name: 'Tiêu đề' })).toBeVisible(
          { timeout: 2000 },
        );
      }).toPass({ timeout: 20_000 });

      // The admin writes first.
      await selectCell(admin.page, 'Tiêu đề');
      await admin.page.keyboard.press('Enter');
      await editor(admin.page).getByRole('textbox', { name: 'Tiêu đề' }).fill(theirs);
      const saved = admin.page.waitForResponse(
        (response) => isRecordWrite(response.request()) && response.status() === 200,
      );
      await admin.page.keyboard.press('Enter');
      await saved;
      await expect(cellText(admin.page, column)).toHaveText(theirs);

      // The editor still edits the old version.
      await expect(cellText(editorUser.page, column)).toHaveText(theirs);
      await editor(editorUser.page).getByRole('textbox', { name: 'Tiêu đề' }).fill(mine);
      const refused = editorUser.page.waitForResponse(
        (response) => isRecordWrite(response.request()) && response.status() === 409,
      );
      await editorUser.page.keyboard.press('Enter');
      await refused;

      const toast = editorUser.page.getByRole('status').filter({ hasText: 'Người khác vừa sửa' });
      await expect(toast).toContainText(ADMIN_NAME);
      await expect(toast).toContainText(theirs);
      await expect(toast).toContainText(mine);
      // The cell shows the server value meanwhile.
      await expect(cellText(editorUser.page, column)).toHaveText(theirs);
      await expectNoSeriousA11yViolations(editorUser.page, 'conflict toast');
      await editorUser.page.screenshot({ path: test.info().outputPath('conflict-toast.png') });

      const written = editorUser.page.waitForResponse(
        (response) => isRecordWrite(response.request()) && response.status() === 200,
      );
      await toast.getByRole('button', { name: 'Ghi giá trị của tôi' }).click();
      await written;
      await expect(cellText(editorUser.page, column)).toHaveText(mine);
      await expect(toast).toBeHidden();
    } finally {
      await admin.context.close();
      await editorUser.context.close();
    }
  });

  test('u_sales1 cannot edit status: the cell is read-only and the API refuses', async ({
    page,
  }) => {
    await signIn(page, SALES1_EMAIL);
    // The admin's URL names "Tất cả đơn hàng", hidden from Sales: open the table,
    // which lands on the first view Sales sees (T309 seed: "Đơn của tôi").
    await gotoTable(page, ordersUrl.replace(/\/v\/viw_[^/?#]+/u, ''), 'Orders');
    await expect(page).toHaveTitle(/^Đơn của tôi · Orders · Cellhive$/u);
    const writes: string[] = [];
    page.on('request', (request) => {
      if (isRecordWrite(request)) writes.push(request.url());
    });

    await expect(
      page.locator('table[role="grid"] th[role="columnheader"]').filter({ hasText: /^status$/u }),
    ).toHaveAttribute('aria-label', 'status, single select, read-only');
    await selectCell(page, 'status');
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('status').filter({ hasText: 'You cannot edit this field.' }),
    ).toBeVisible();
    await expect(editor(page).getByRole('listbox')).toHaveCount(0);
    expect(writes).toEqual([]);

    // Forcing the write: 403 FIELD_READ_ONLY (CONTRACTS §5 P10).
    const tableId = /\/t\/(tbl_[^/]+)/u.exec(page.url())?.[1] ?? '';
    const rows = await api<{
      records: { id: string; version: number; fields: Record<string, unknown> }[];
    }>(page, 'POST', `/tables/${tableId}/records/query?field_key_type=name`, { limit: 1 });
    expect(rows.status).toBe(200);
    const record = rows.body.records[0];
    if (record === undefined) throw new Error('u_sales1 sees no order');
    const forced = await api<{ code: string }>(
      page,
      'PATCH',
      `/tables/${tableId}/records?field_key_type=name`,
      {
        records: [{ id: record.id, version: record.version, fields: { status: 'Xong' } }],
      },
    );
    expect(forced.status).toBe(403);
    expect(forced.body.code).toBe('FIELD_READ_ONLY');
  });

  test('add a record (button and shortcut) and delete it after confirming', async ({ page }) => {
    await signIn(page, WORKER_ORG.email('admin'));
    const customersUrl = ticketsUrl;
    await gotoTable(page, customersUrl, 'Tickets');
    await page
      .getByRole('navigation', { name: 'Tables' })
      .getByRole('link', { name: 'Customers' })
      .click();
    await expect(page.getByRole('heading', { level: 1, name: 'Customers' })).toBeVisible();
    const footer = page.getByRole('status').filter({ hasText: /records?$/u });
    await expect(footer).toHaveText(/^[\d,]+ records$/u);
    const before = Number((await footer.textContent())?.replace(/\D/gu, ''));
    const count = (value: number) => `${value.toLocaleString('en-US')} records`;

    for (const how of ['button', 'shortcut'] as const) {
      await test.step(`add with the ${how}, name it, delete it`, async () => {
        const created = page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            /\/records(\?|$)/u.test(response.url()) &&
            response.status() === 201,
        );
        if (how === 'button') await page.getByRole('button', { name: 'Add record' }).click();
        else await page.keyboard.press('ControlOrMeta+Shift+Enter');
        await created;
        await expect(footer).toHaveText(count(before + 1));

        // The new row is selected: type its name.
        await page.keyboard.press('Enter');
        const name = `Khách E2E ${how}`;
        await editor(page).getByRole('textbox', { name: 'Tên' }).fill(name);
        const saved = page.waitForResponse(
          (response) => isRecordWrite(response.request()) && response.status() === 200,
        );
        await page.keyboard.press('Enter');
        await saved;

        // T322a: "Delete N records" acts on whole rows — select the row (Shift+Space).
        if (!(await page.getByRole('button', { name: 'Delete 1 record' }).isVisible())) {
          await page.keyboard.press('Shift+Space');
        }
        await page.getByRole('button', { name: 'Delete 1 record' }).click();
        const dialog = page.getByRole('dialog', { name: 'Delete 1 record?' });
        await expect(dialog).toBeVisible();
        await expectNoSeriousA11yViolations(page, 'delete confirmation');
        await dialog.getByRole('button', { name: 'Delete record' }).click();
        await expect(
          page.getByRole('status').filter({ hasText: '1 record moved to the trash.' }),
        ).toBeVisible();
        await expect(footer).toHaveText(count(before));
      });
    }
  });
});
