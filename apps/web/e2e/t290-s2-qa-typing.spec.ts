import { type Browser, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { DEMO_PASSWORD } from './seed';
import { api, apiSignIn } from './support';

/**
 * S2 QA regression: type-to-edit after clicking another cell must open the
 * editor with the typed character every time, also while another user
 * edits the same table (realtime patches re-render the grid meanwhile).
 */

const DEMO_BASE = 'Chăm sóc khách hàng';
const EDITOR_EMAIL = WORKER_ORG.email('editor');
const HEADER_HEIGHT = 36;
const ROW_HEIGHT = 34;
const ITERATIONS = 30;

async function newUser(browser: Browser, email: string, width = 1440) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.addInitScript(() => {
    if (window.localStorage.getItem('cellhive.language') === null) {
      window.localStorage.setItem('cellhive.language', 'en');
    }
  });
  const page = await context.newPage();
  await page.goto('/login');
  await apiSignIn(page, email, DEMO_PASSWORD);
  return { context, page };
}

async function openOrders(page: Page): Promise<string> {
  await page.goto('/');
  await page.getByRole('link', { name: DEMO_BASE }).first().click();
  await expect(page).toHaveURL(/\/t\/tbl_/u);
  // T320b: the tables are in the sidebar, a drawer below 1024 px.
  const menu = page.getByRole('button', { name: 'Open navigation' });
  if (await menu.isVisible()) await menu.click();
  await page
    .getByRole('navigation', { name: 'Tables' })
    .getByRole('link', { name: 'Orders' })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Orders' })).toBeVisible();
  // Rows loaded (the footer counts them); not the accessibility table, absent under the dev server.
  await expect(page.getByRole('status').filter({ hasText: /records?$/u })).toBeVisible();
  const match = /\/t\/(tbl_[^/?]+)/u.exec(page.url());
  if (match?.[1] === undefined) throw new Error('no table id in the URL');
  return match[1];
}

/** Clicks the primary (first) cell of data row `row`. */
async function clickPrimary(page: Page, row: number) {
  const canvas = page.locator('.ob-grid [data-testid="data-grid-canvas"]');
  const box = await canvas.boundingBox();
  if (box === null) throw new Error('grid not laid out');
  await page.mouse.click(
    box.x + 60 + 40,
    box.y + HEADER_HEIGHT + ROW_HEIGHT * row + ROW_HEIGHT / 2,
  );
}

test.describe.serial('S2 QA: type to edit', () => {
  test('30 clicks on other cells then a letter always open the editor, under realtime load', async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    // Narrow enough for the grid to scroll sideways (the primary column stays frozen).
    const admin = await newUser(browser, WORKER_ORG.email('admin'), 1000);
    const other = await newUser(browser, EDITOR_EMAIL);
    const designer = await newUser(browser, WORKER_ORG.email('admin'));
    const load = { writing: true, edits: 0, schemaChanges: 0 };
    try {
      const tableId = await openOrders(admin.page);
      await openOrders(other.page);
      const list = await api<{ records: { id: string }[] }>(
        other.page,
        'POST',
        `/tables/${tableId}/records/query?field_key_type=name`,
        { limit: 12, include_total: false },
      );
      const ids = list.body.records.map((record) => record.id);
      expect(ids.length).toBeGreaterThan(4);

      // The other user keeps editing records shown on the admin's screen.
      const writer = (async () => {
        while (load.writing) {
          const id = ids[load.edits % ids.length] ?? '';
          load.edits += 1;
          await api(other.page, 'PATCH', `/tables/${tableId}/records/${id}?field_key_type=name`, {
            fields: { amount: 25_000 * load.edits },
          }).catch(() => undefined);
          await other.page.waitForTimeout(40);
        }
      })();
      // Another admin adds a field now and then: each bumps the base
      // `permission_version` (every grid of the base gets a new block loader).
      // They are removed once the typing is over.
      const stressFields: string[] = [];
      const designing = (async () => {
        while (load.writing) {
          await designer.page.waitForTimeout(1500);
          const created = await api<{ id: string }>(
            designer.page,
            'POST',
            `/tables/${tableId}/fields`,
            { name: `Stress ${String(load.schemaChanges)} ${String(Date.now())}`, type: 'text' },
          );
          if (created.status < 300) {
            stressFields.push(created.body.id);
            load.schemaChanges += 1;
          }
        }
      })();

      const input = admin.page.locator('#portal').getByRole('textbox');
      const failures: string[] = [];
      const waits = [0, 30, 120, 400];
      const letters = 'abcdefghijklmnopqrstuvwxyz';
      for (let i = 0; i < ITERATIONS; i += 1) {
        if (i === ITERATIONS / 2) {
          // Scrolled sideways past a column: glide 6.0.3 alone dropped the key on frozen columns.
          const canvas = await admin.page
            .locator('.ob-grid [data-testid="data-grid-canvas"]')
            .boundingBox();
          if (canvas === null) throw new Error('grid not laid out');
          await admin.page.mouse.move(canvas.x + canvas.width - 50, canvas.y + 200);
          await admin.page.mouse.wheel(600, 0);
          await admin.page.waitForTimeout(300);
        }
        const row = (i * 3) % 8;
        const letter = letters[i % letters.length] ?? 'x';
        await clickPrimary(admin.page, row);
        await admin.page.waitForTimeout(waits[i % waits.length] ?? 0);
        await admin.page.keyboard.type(letter);
        try {
          await expect(input).toBeVisible({ timeout: 1500 });
          await expect(input).toHaveValue(letter, { timeout: 1000 });
        } catch {
          failures.push(`#${String(i)} row ${String(row)} '${letter}'`);
        }
        await admin.page.keyboard.press('Escape');
        await expect(input).toBeHidden();
      }
      load.writing = false;
      await Promise.all([writer, designing]);
      for (const fieldId of stressFields) await api(designer.page, 'DELETE', `/fields/${fieldId}`);
      expect(failures).toEqual([]);
      expect(load.edits, 'realtime load during the test').toBeGreaterThan(5);
      expect(load.schemaChanges, 'schema changes during the test').toBeGreaterThan(2);
    } finally {
      load.writing = false;
      await admin.context.close();
      await other.context.close();
      await designer.context.close();
    }
  });

  test('a Vietnamese letter (not ASCII) also starts editing', async ({ browser }) => {
    // Glide 6.0.3 only starts editing on printable ASCII.
    const admin = await newUser(browser, WORKER_ORG.email('admin'));
    try {
      await openOrders(admin.page);
      const input = admin.page.locator('#portal').getByRole('textbox');
      await clickPrimary(admin.page, 1);
      // The key a Vietnamese keyboard layout sends (Playwright's `type` would only insert text).
      const cdp = await admin.context.newCDPSession(admin.page);
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Đ', text: 'Đ' });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Đ' });
      await expect(input).toBeVisible();
      await expect(input).toHaveValue('Đ');
      await admin.page.keyboard.press('Escape');
      await expect(input).toBeHidden();
    } finally {
      await admin.context.close();
    }
  });
});
