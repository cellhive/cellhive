import { type Browser, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { DEMO_PASSWORD } from './seed';
import { api, apiSignIn, trackApiCalls } from './support';

/**
 * S2 QA regressions of the web client: editor popovers stay inside the
 * window, the mobile record card, requests per field creation, the
 * read-only hint, and smaller UI fixes.
 */

const DEMO_BASE = 'Chăm sóc khách hàng';
const READER_EMAIL = WORKER_ORG.email('reader');
const HEADER_HEIGHT = 36;
const ROW_HEIGHT = 34;
const VIEWPORT = { width: 1440, height: 900 };

async function newUser(
  browser: Browser,
  email: string,
  viewport: { width: number; height: number } = VIEWPORT,
  language: 'en' | 'vi' = 'en',
) {
  const context = await browser.newContext({ viewport });
  await context.addInitScript((lang) => {
    if (window.localStorage.getItem('cellhive.language') === null) {
      window.localStorage.setItem('cellhive.language', lang);
    }
  }, language);
  const page = await context.newPage();
  await page.goto('/login');
  await apiSignIn(page, email, DEMO_PASSWORD);
  return { context, page };
}

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

async function columnOf(page: Page, fieldName: string): Promise<number> {
  const header = page
    .locator('table[role="grid"] th[role="columnheader"]')
    .filter({ hasText: new RegExp(`^${fieldName}$`, 'u') });
  return Number(await header.getAttribute('aria-colindex'));
}

/** Data row (0-based) of the last row fully shown in the grid. */
async function lastVisibleRow(page: Page): Promise<number> {
  const box = await page.locator('.ob-grid [data-testid="data-grid-canvas"]').boundingBox();
  if (box === null) throw new Error('grid not laid out');
  return Math.floor((box.height - HEADER_HEIGHT) / ROW_HEIGHT) - 1;
}

/** Selects the cell of `fieldName` in data row `row` (click the primary cell, then arrows). */
async function selectCell(page: Page, fieldName: string, row: number) {
  const box = await page.locator('.ob-grid [data-testid="data-grid-canvas"]').boundingBox();
  if (box === null) throw new Error('grid not laid out');
  // Right after loading, the first click may come before the rows: try again.
  await expect(async () => {
    await page.mouse.click(box.x + 100, box.y + HEADER_HEIGHT + ROW_HEIGHT * row + ROW_HEIGHT / 2);
    await expect(page.getByTestId(`glide-cell-1-${String(row)}`)).toHaveAttribute(
      'aria-selected',
      'true',
      { timeout: 2000 },
    );
  }).toPass({ timeout: 20_000 });
  const column = await columnOf(page, fieldName);
  for (let step = 1; step < column; step += 1) await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId(`glide-cell-${String(column)}-${String(row)}`)).toHaveAttribute(
    'aria-selected',
    'true',
  );
}

/** The editor popover is inside the window and its input keeps the cell height. */
async function expectPopoverInWindow(page: Page, input: string) {
  const frame = page.locator('#portal [data-placement]');
  await expect(frame).toBeVisible();
  // Placement settles after the list / calendar content is measured.
  await expect
    .poll(async () => {
      const box = await frame.boundingBox();
      return box !== null && box.y >= 0 && box.y + box.height <= VIEWPORT.height;
    })
    .toBe(true);
  const field = await page
    .locator('#portal')
    .getByRole(input === 'combobox' ? 'combobox' : 'textbox')
    .boundingBox();
  expect(field?.height ?? 0, 'input height').toBeGreaterThanOrEqual(24);
}

test.describe.serial('S2 QA web', () => {
  test('editor popovers on the last row open above the cell, inside the window', async ({
    browser,
  }) => {
    const admin = await newUser(browser, WORKER_ORG.email('admin'));
    try {
      await openTable(admin.page, 'Tickets');
      const row = await lastVisibleRow(admin.page);
      for (const [fieldName, role] of [
        ['Hạn', 'textbox'],
        ['Trạng thái', 'combobox'],
        ['Phụ trách', 'combobox'],
      ] as const) {
        await selectCell(admin.page, fieldName, row);
        await admin.page.keyboard.press('Enter');
        await expectPopoverInWindow(admin.page, role);
        await expect(admin.page.locator('#portal [data-placement]')).toHaveAttribute(
          'data-placement',
          'above',
        );
        // Opened upwards, the input still covers the edited cell.
        const canvas = await admin.page
          .locator('.ob-grid [data-testid="data-grid-canvas"]')
          .boundingBox();
        const cellTop = (canvas?.y ?? 0) + HEADER_HEIGHT + ROW_HEIGHT * row;
        await expect
          .poll(async () => {
            const box = await admin.page
              .locator('#portal')
              .getByRole(role === 'combobox' ? 'combobox' : 'textbox')
              .boundingBox();
            return Math.abs((box?.y ?? 0) + (box?.height ?? 0) / 2 - (cellTop + ROW_HEIGHT / 2));
          })
          .toBeLessThan(8);
        await admin.page.screenshot({ path: test.info().outputPath(`popover-${fieldName}.png`) });
        if (fieldName === 'Phụ trách') {
          // Names come first and whole; the email is the secondary line.
          const option = admin.page.locator('#portal').getByRole('option').first();
          const name = option.locator('span.truncate').first();
          await expect(name).toBeVisible();
          const cut = await name.evaluate((element) => element.scrollWidth > element.clientWidth);
          expect(cut, 'member name truncated').toBe(false);
        }
        await admin.page.keyboard.press('Escape');
        await expect(admin.page.locator('#portal [data-placement]')).toBeHidden();
      }
    } finally {
      await admin.context.close();
    }
  });

  test('creating a field costs at most 4 reads, also with a second tab open', async ({
    browser,
  }) => {
    const admin = await newUser(browser, WORKER_ORG.email('admin'));
    const otherTab = await admin.context.newPage();
    const tabs = [admin.page, otherTab];
    // T319: count only what the field creation causes. Late reads of the
    // two page loads (sidebar, views, members) used to land in the count
    // on a busy machine: wait until neither tab has an API call in flight.
    const inFlight = tabs.map(trackApiCalls);
    try {
      await openTable(admin.page, 'Customers');
      await otherTab.goto(admin.page.url());
      await expect(otherTab.getByRole('heading', { level: 1, name: 'Customers' })).toBeVisible();
      await Promise.all(inFlight.map((tracker) => tracker.idle()));

      await admin.page.getByRole('button', { name: 'More actions' }).click();
      await admin.page.getByRole('menuitem', { name: 'Add field' }).click();
      const dialog = admin.page.getByRole('dialog', { name: 'New field' });
      await dialog.getByLabel('Name', { exact: true }).fill(`Ghi chú ${String(Date.now())}`);
      await Promise.all(inFlight.map((tracker) => tracker.idle()));

      const reads: string[] = [];
      const otherReads: string[] = [];
      const statuses: number[] = [];
      admin.page.on('request', (request) => {
        if (request.url().includes('/api/v1/') && !['POST', 'PATCH'].includes(request.method()))
          reads.push(`${request.method()} ${new URL(request.url()).pathname}`);
        if (request.method() === 'POST' && request.url().includes('/records/query'))
          reads.push(`POST ${new URL(request.url()).pathname}`);
      });
      otherTab.on('request', (request) => {
        if (request.url().includes('/api/v1/')) otherReads.push(request.url());
      });
      for (const page of tabs) {
        page.on('response', (response) => {
          if (response.url().includes('/api/v1/')) statuses.push(response.status());
        });
      }
      // Both tabs refetch the fields once the `schema.changed` message arrives.
      const fieldsRead = tabs.map((page) =>
        page.waitForResponse(
          (response) =>
            response.request().method() === 'GET' &&
            /\/tables\/tbl_[^/]+\/fields$/u.test(new URL(response.url()).pathname),
        ),
      );
      const createdField = admin.page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          /\/tables\/tbl_[^/]+\/fields$/u.test(response.url()),
      );
      await dialog.getByRole('button', { name: 'Create field' }).click();
      await expect(dialog).toBeHidden();
      const fieldId = ((await (await createdField).json()) as { id: string }).id;
      // The realtime messages of the change arrived and every refetch is over.
      await Promise.all(fieldsRead);
      await Promise.all(inFlight.map((tracker) => tracker.idle()));
      // Measured: the fields, the grid block and the sidebar's base (tables and
      // their counts, T320b) — 3 reads; `GET /orgs/:id` seen in failing runs was
      // a late read of the page load. Each resource is read once at most. The
      // second tab also reads the base trash once (T469's sidebar entry) and
      // the automations of the base (T520's sidebar count) and its dashboards
      // (T811's sidebar list: which ones a member sees follows their role), both
      // under the base prefix so that the new `permission_version` asks them again.
      expect(reads.length, reads.join('\n')).toBeLessThanOrEqual(4);
      expect(new Set(reads).size, reads.join('\n')).toBe(reads.length);
      expect(otherReads.length, otherReads.join('\n')).toBeLessThanOrEqual(9);
      expect(new Set(otherReads).size, otherReads.join('\n')).toBe(otherReads.length);
      expect(statuses.filter((status) => status === 429)).toEqual([]);
      await api(admin.page, 'DELETE', `/fields/${fieldId}`);
    } finally {
      await admin.context.close();
    }
  });

  test('unknown paths: sign-in first when signed out, 404 in the profile language', async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: VIEWPORT });
    try {
      const page = await context.newPage();
      await page.goto('/me');
      await expect(page).toHaveURL(/\/login\?next=%2Fme$/u);
      // The demo admin's profile is Vietnamese; this device has no language of its own.
      await apiSignIn(page, WORKER_ORG.email('admin'), DEMO_PASSWORD);
      await page.goto('/some/random/path');
      await expect(
        page.getByRole('heading', { level: 1, name: 'Không tìm thấy trang' }),
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('mobile record cards show their whole title line', async ({ browser }) => {
    const mobile = await newUser(browser, WORKER_ORG.email('admin'), { width: 390, height: 844 });
    try {
      await mobile.page.goto('/');
      await mobile.page.getByRole('link', { name: DEMO_BASE }).first().click();
      await expect(mobile.page).toHaveURL(/\/t\/tbl_/u);
      const title = mobile.page
        // The record cards, not the view tabs (T310).
        .getByRole('list', { name: /^Records of / })
        .getByRole('button')
        .first()
        .locator('span')
        .first();
      await expect(title).toBeVisible();
      const box = await title.boundingBox();
      expect(box?.height ?? 0, 'card title height').toBeGreaterThanOrEqual(20);
      const clipped = await title.evaluate(
        (element) => element.scrollHeight > element.clientHeight + 1,
      );
      expect(clipped, 'card title clipped vertically').toBe(false);
      await mobile.page.screenshot({ path: test.info().outputPath('mobile-cards.png') });
    } finally {
      await mobile.context.close();
    }
  });

  // T310 removed the "saved views are coming soon" hint; since T311 the Sort button with its
  // count is what must stay whole.
  test('the sort button of the toolbar is never cut off', async ({ browser }) => {
    const admin = await newUser(browser, WORKER_ORG.email('admin'));
    try {
      await openTable(admin.page, 'Tickets');
      await selectCell(admin.page, 'Trạng thái', 0);
      await admin.page.keyboard.press('Shift+F10');
      await admin.page.getByRole('menuitem', { name: 'Sort ascending' }).click();
      // T320b: the button says what applies (design "Sắp xếp: Hạn").
      const button = admin.page.getByRole('button', { name: 'Sort: Trạng thái' });
      await expect(button).toBeVisible();
      const cut = await button.evaluate((element) =>
        [element, ...element.querySelectorAll('span')].some(
          (part) => part.scrollWidth > part.clientWidth + 1,
        ),
      );
      expect(cut, 'sort button cut off').toBe(false);
      await admin.page.screenshot({ path: test.info().outputPath('toolbar-sorted.png') });
      // A temporary sort (T311): discarded, the shared view never had it.
      await admin.page
        .getByRole('group', { name: 'Unsaved changes' })
        .getByRole('button', { name: 'Discard' })
        .click();
      await expect(admin.page.getByRole('button', { name: 'Sort', exact: true })).toBeVisible();
      await expect
        .poll(() =>
          admin.page.evaluate(async () => {
            const path = window.location.pathname.split('/');
            const response = await fetch(`/api/v1/views/${path[path.length - 1] ?? ''}`);
            return ((await response.json()) as { config: { sort: unknown[] } }).config.sort.length;
          }),
        )
        .toBe(0);
    } finally {
      await admin.context.close();
    }
  });

  test('a reader typing or pressing Enter on a cell sees the read-only hint', async ({
    browser,
  }) => {
    const reader = await newUser(browser, READER_EMAIL);
    try {
      await openTable(reader.page, 'Tickets');
      await selectCell(reader.page, 'Tiêu đề', 1);
      const hint = reader.page.locator('.ob-grid [role="status"]');
      await reader.page.keyboard.press('Enter');
      await expect(hint).toHaveText('You cannot edit this field.');
      await selectCell(reader.page, 'Tiêu đề', 2);
      await expect(hint).toHaveText('');
      await reader.page.keyboard.press('k');
      await expect(hint).toHaveText('You cannot edit this field.');
      await expect(reader.page.locator('#portal [data-placement]')).toHaveCount(0);
    } finally {
      await reader.context.close();
    }
  });
});
