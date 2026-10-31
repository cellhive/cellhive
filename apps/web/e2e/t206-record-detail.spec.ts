import { type Browser, type BrowserContext, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { DEMO_PASSWORD } from './seed';
import {
  animationsSettled,
  apiSignIn,
  collectCspViolations,
  expectNoSeriousA11yViolations,
  ok,
} from './support';

/**
 * T206: the record detail panel and its history on the demo base
 * (CONTRACTS §9): a bulk write of 12 cells into one record is one history
 * item with its batch and source; u_sales1 never sees changes of `cost`
 * (field `no_perm`, CONTRACTS §5); a revert is a new entry, and a revert
 * against a stale version answers 409 with the conflict toast; `?record=`
 * opens the panel; below 768 px the grid is a card list and the panel
 * covers the screen.
 */

const DEMO_BASE = 'Chăm sóc khách hàng';
const SALES1_EMAIL = WORKER_ORG.email('sales1');
const ADMIN_NAME = 'Nguyễn Minh Anh';
const NOTES = Array.from({ length: 12 }, (_, index) => `Ghi chú ${String(index + 1)}`);
const RECORD_NAMES = ['Bản ghi A', 'Bản ghi B', 'Bản ghi C'];
/** Grid geometry of a table with fewer than 10 rows (GridView: max(40, digits × 8 + 16)). */
const ROW_MARKER_WIDTH = 40;
const HEADER_HEIGHT = 36;
const ROW_HEIGHT = 34;

type Session = Awaited<ReturnType<BrowserContext['storageState']>>;

/**
 * One sign-in per user for the whole spec (T421b): `POST /auth/login` allows
 * 20 a minute per IP for the whole suite, and a test that had to wait out
 * that window (`apiSignIn` waits up to ~70 s) on top of its own work went
 * past the 90 s test timeout now and then. Later contexts reuse the cookies.
 */
const sessions = new Map<string, Session>();

async function newUser(browser: Browser, email: string, viewport = { width: 1920, height: 1000 }) {
  const known = sessions.get(email);
  const context = await browser.newContext({
    viewport,
    ...(known === undefined ? {} : { storageState: known }),
  });
  await context.addInitScript(() => {
    if (window.localStorage.getItem('cellhive.language') === null) {
      window.localStorage.setItem('cellhive.language', 'en');
    }
  });
  const page = await context.newPage();
  await page.goto('/login');
  if (known === undefined) {
    await apiSignIn(page, email, DEMO_PASSWORD);
    sessions.set(email, await context.storageState());
  }
  return { context, page };
}

/** Opens a table of the demo base from the organization home; returns base, table and URL. */
async function openTable(page: Page, tableName: string) {
  await page.goto('/');
  await page.getByRole('link', { name: DEMO_BASE }).first().click();
  await expect(page).toHaveURL(/\/t\/tbl_/u);
  await page
    .getByRole('navigation', { name: /Tables|Các bảng/u })
    .getByRole('link', { name: tableName })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: tableName })).toBeVisible();
  const match = /\/b\/(bse_[^/]+)\/t\/(tbl_[^/?]+)/u.exec(page.url());
  if (match === null) throw new Error(`not a table URL: ${page.url()}`);
  return { baseId: match[1] ?? '', tableId: match[2] ?? '', url: page.url() };
}

function recordPanel(page: Page, title: string) {
  return page.getByRole('dialog', { name: title });
}

/** Top-level items of the history timeline of a panel or popover. */
function historyItems(scope: ReturnType<Page['getByRole']>) {
  return scope.getByRole('list', { name: 'Changes' }).locator(':scope > li');
}

test.describe.serial('T206 record detail and history', () => {
  test.use({ viewport: { width: 1920, height: 1000 } });

  const ids = { baseId: '', ordersId: '', ordersUrl: '', tableId: '', recordIds: [] as string[] };

  test('a bulk write of 12 cells into one record is one history item, with its source', async ({
    browser,
  }) => {
    const { context, page } = await newUser(browser, WORKER_ORG.email('admin'));
    const cspViolations = collectCspViolations(page);
    const orders = await openTable(page, 'Orders');
    ids.baseId = orders.baseId;
    ids.ordersId = orders.tableId;
    ids.ordersUrl = orders.url;

    // A table with 12 text fields and 3 records.
    const table = await ok<{ id: string }>(page, 'POST', `/bases/${ids.baseId}/tables`, {
      name: `Lịch sử T206 ${String(Date.now())}`,
    });
    ids.tableId = table.id;
    for (const name of NOTES) {
      await ok(page, 'POST', `/tables/${table.id}/fields`, { name, type: 'text' });
    }
    const created = await ok<{ records: { id: string }[] }>(
      page,
      'POST',
      `/tables/${table.id}/records?field_key_type=name`,
      { records: RECORD_NAMES.map((name) => ({ fields: { Name: name } })) },
    );
    ids.recordIds = created.records.map((record) => record.id);

    // One bulk PATCH (the shape of a paste, FRONTEND §4.2) with the session: 12 cells of A, 1 of B and C.
    const [a, b, c] = ids.recordIds;
    await ok(page, 'PATCH', `/tables/${table.id}/records?field_key_type=name`, {
      records: [
        {
          id: a,
          fields: Object.fromEntries(
            NOTES.map((name, index) => [name, `Giá trị ${String(index + 1)}`]),
          ),
        },
        { id: b, fields: { [NOTES[0] ?? '']: 'B' } },
        { id: c, fields: { [NOTES[0] ?? '']: 'C' } },
      ],
    });

    // Deep link: `?record=` opens the panel.
    await page.goto(`/b/${ids.baseId}/t/${table.id}?record=${a ?? ''}`);
    const panel = recordPanel(page, RECORD_NAMES[0] ?? '');
    await expect(panel).toBeVisible();
    await expect(panel.getByRole('group', { name: 'Ghi chú 12' })).toContainText('Giá trị 12');
    const items = historyItems(panel);
    await expect(items).toHaveCount(2);
    const paste = items.first();
    await expect(paste).toContainText(`${ADMIN_NAME} changed 12 fields`);
    await expect(paste).toContainText('In the app · Part of a change to 3 records');
    await paste.getByRole('button', { name: 'Show all 12 changes' }).click();
    await expect(
      paste.getByRole('list', { name: 'Changed fields' }).getByRole('listitem'),
    ).toHaveCount(12);
    await expect(items.nth(1)).toContainText(`${ADMIN_NAME} created this record`);
    await expectNoSeriousA11yViolations(page, 'record panel with history');
    await page.screenshot({ path: test.info().outputPath('record-panel.png') });
    expect(cspViolations).toEqual([]);
    await context.close();
  });

  test('the expand button, ↑/↓, Escape and the cell history from the cell menu', async ({
    browser,
  }) => {
    const { context, page } = await newUser(browser, WORKER_ORG.email('admin'));
    await page.goto(`/b/${ids.baseId}/t/${ids.tableId}`);
    const canvas = page.locator('.ob-grid [data-testid="data-grid-canvas"]');
    await expect(page.locator('table[role="grid"] td[role="gridcell"]').first()).toBeAttached();
    const box = await canvas.boundingBox();
    if (box === null) throw new Error('grid not laid out');
    const firstRow = {
      x: box.x + ROW_MARKER_WIDTH + 24,
      y: box.y + HEADER_HEIGHT + ROW_HEIGHT / 2,
    };

    await page.mouse.move(firstRow.x, firstRow.y);
    await page.getByRole('button', { name: 'Expand record' }).click();
    const panel = recordPanel(page, RECORD_NAMES[0] ?? '');
    await expect(panel).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`\\?record=${ids.recordIds[0] ?? ''}$`, 'u'));
    await expect(panel).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(recordPanel(page, RECORD_NAMES[1] ?? '')).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`\\?record=${ids.recordIds[1] ?? ''}$`, 'u'));
    await page.keyboard.press('ArrowUp');
    await expect(recordPanel(page, RECORD_NAMES[0] ?? '')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page).not.toHaveURL(/record=/u);

    await page.mouse.click(firstRow.x, firstRow.y, { button: 'right' });
    await page.getByRole('menuitem', { name: 'View cell history' }).click();
    const popover = page.getByRole('dialog', { name: 'History of Name' });
    await expect(popover).toBeVisible();
    await expect(historyItems(popover)).toHaveCount(1);
    await expect(historyItems(popover).first()).toContainText('created this record');
    await expectNoSeriousA11yViolations(page, 'cell history popover');
    await page.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);
    await context.close();
  });

  test('u_sales1 does not see changes of cost in the history', async ({ browser }) => {
    const admin = await newUser(browser, WORKER_ORG.email('admin'));
    const sales = await newUser(browser, SALES1_EMAIL);
    try {
      const mine = await ok<{ records: { id: string; fields: Record<string, unknown> }[] }>(
        sales.page,
        'POST',
        `/tables/${ids.ordersId}/records/query?field_key_type=name`,
        { limit: 1 },
      );
      const order = mine.records[0];
      if (order === undefined) throw new Error('u_sales1 sees no order');
      expect(order.fields).not.toHaveProperty('cost');
      // The admin changes cost, then amount, of that order.
      await ok(admin.page, 'PATCH', `/tables/${ids.ordersId}/records?field_key_type=name`, {
        records: [{ id: order.id, fields: { cost: 111_000 } }],
      });
      await ok(admin.page, 'PATCH', `/tables/${ids.ordersId}/records?field_key_type=name`, {
        records: [{ id: order.id, fields: { amount: 222_000 } }],
      });

      // The admin's URL names "Tất cả đơn hàng", hidden from Sales (T309 seed): open the table.
      const tableUrl = ids.ordersUrl.replace(/\/v\/viw_[^/?#]+/u, '');
      await sales.page.goto(`${tableUrl}?record=${order.id}`);
      const salesPanel = sales.page.getByRole('dialog');
      const salesHistory = historyItems(salesPanel);
      await expect(salesHistory.first()).toContainText(`${ADMIN_NAME} changed amount`);
      await expect(salesPanel.getByRole('list', { name: 'Changes' })).not.toContainText('cost');
      await expect(salesPanel.getByRole('group', { name: 'cost' })).toHaveCount(0);
      await expectNoSeriousA11yViolations(sales.page, 'record panel (u_sales1)');

      await admin.page.goto(`${ids.ordersUrl}?record=${order.id}`);
      const adminHistory = historyItems(admin.page.getByRole('dialog'));
      await expect(adminHistory.first()).toContainText(`${ADMIN_NAME} changed amount`);
      await expect(adminHistory.nth(1)).toContainText(`${ADMIN_NAME} changed cost`);
    } finally {
      await admin.context.close();
      await sales.context.close();
    }
  });

  test('restore a previous value: a new entry; with a stale version: 409 and the conflict toast', async ({
    browser,
  }) => {
    const { context, page } = await newUser(browser, WORKER_ORG.email('admin'));
    // Realtime (T204) keeps the panel's version current; a missed message
    // (realtime is best effort, CONTRACTS §7) is what leaves it stale below.
    let realtimeMuted = false;
    await page.routeWebSocket(/\/ws$/u, (socket) => {
      const server = socket.connectToServer();
      server.onMessage((message) => {
        if (!realtimeMuted) socket.send(message);
      });
    });
    const [recordId] = ids.recordIds;
    const before = await ok<{ fields: Record<string, unknown>; version: number }>(
      page,
      'GET',
      `/tables/${ids.tableId}/records/${recordId ?? ''}?field_key_type=name`,
    );
    await ok(page, 'PATCH', `/tables/${ids.tableId}/records?field_key_type=name`, {
      records: [{ id: recordId, fields: { 'Ghi chú 1': 'Sửa lần hai' } }],
    });
    await page.goto(`/b/${ids.baseId}/t/${ids.tableId}?record=${recordId ?? ''}`);
    const panel = recordPanel(page, RECORD_NAMES[0] ?? '');
    const items = historyItems(panel);
    await expect(items.first()).toContainText(`${ADMIN_NAME} changed Ghi chú 1`);

    await items.first().getByRole('button', { name: 'Restore previous value' }).click();
    const confirm = page.getByRole('dialog', { name: 'Restore the previous value?' });
    await expectNoSeriousA11yViolations(page, 'revert confirmation');
    await confirm.getByRole('button', { name: 'Restore' }).click();
    await expect(page.getByText('Previous value restored.')).toBeVisible();
    await expect(items.first()).toContainText(`${ADMIN_NAME} restored an earlier value`);
    await expect(items.first()).toContainText('Restored from an earlier change');
    await expect(panel.getByRole('group', { name: 'Ghi chú 1', exact: true })).toContainText(
      String(before.fields['Ghi chú 1']),
    );

    // Someone writes the record behind the panel's back and the realtime
    // message is lost: its version is stale now.
    realtimeMuted = true;
    await ok(page, 'PATCH', `/tables/${ids.tableId}/records?field_key_type=name`, {
      records: [{ id: recordId, fields: { 'Ghi chú 2': 'Người khác sửa' } }],
    });
    const reverts: number[] = [];
    page.on('response', (response) => {
      if (new URL(response.url()).pathname.endsWith('/revert')) reverts.push(response.status());
    });
    const older = items.filter({ hasText: `${ADMIN_NAME} changed Ghi chú 1` }).first();
    await older.getByRole('button', { name: 'Restore previous value' }).click();
    await confirm.getByRole('button', { name: 'Restore' }).click();
    await expect(page.getByText('Record changed since')).toBeVisible();
    expect(reverts).toEqual([409]);
    await expectNoSeriousA11yViolations(page, 'revert conflict toast');
    await page.screenshot({ path: test.info().outputPath('revert-conflict.png') });
    // The latest values are loaded: the other person's change shows.
    await expect(panel.getByRole('group', { name: 'Ghi chú 2', exact: true })).toContainText(
      'Người khác sửa',
    );
    await context.close();
  });

  test('below 768 px: a card list instead of the grid and a full-screen panel', async ({
    browser,
  }) => {
    const viewport = { width: 390, height: 844 };
    const phone = await newUser(browser, WORKER_ORG.email('admin'), viewport);
    try {
      await phone.page.goto(ids.ordersUrl);
      const list = phone.page.getByRole('list', { name: 'Records of Orders' });
      await expect(list).toBeVisible();
      await expect(phone.page.locator('.ob-grid')).toHaveCount(0);
      const card = list.getByRole('button').first();
      await expect(card).toBeVisible();
      await expectNoSeriousA11yViolations(phone.page, 'card list (mobile)');
      await card.click();
      const panel = phone.page.getByRole('dialog');
      await expect(panel).toBeVisible();
      // The full-screen panel slides in (`animate-sheet-in`); measure where it lands.
      await animationsSettled(phone.page);
      const box = await panel.boundingBox();
      expect(box).toEqual({ x: 0, y: 0, width: viewport.width, height: viewport.height });
      await expect(panel.getByRole('tab', { name: 'Details' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await panel.getByRole('tab', { name: 'History' }).click();
      await expect(panel.getByRole('list', { name: 'Changes' })).toBeVisible();
      await expectNoSeriousA11yViolations(phone.page, 'record panel (mobile)');
      await phone.page.screenshot({ path: test.info().outputPath('record-panel-mobile.png') });
      await panel.getByRole('button', { name: 'Close record' }).click();
      await expect(list).toBeVisible();
    } finally {
      await phone.context.close();
    }
  });
});
