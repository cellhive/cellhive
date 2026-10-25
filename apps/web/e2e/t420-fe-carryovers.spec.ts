import { type Browser, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { apiSignIn, ok, signInFirstAdmin } from './support';

/**
 * T420 (S3 carry-overs): the grid takes the keyboard at once after a
 * toolbar menu closed with Escape, the canvas avatar initials fit their
 * circle at every row height and pixel ratio, the sidebar record counts
 * follow realtime record messages. Self-contained: the first administrator
 * and a base of its own.
 */
const ADMIN = {
  name: 'Nguyễn Văn Ánh',
  email: WORKER_ORG.ownerEmail,
  password: 'E2E-Setup-Password-2026',
};
const RUN = String(Date.now());
const HEADER_HEIGHT = 36;
const ROW_HEIGHT = 34;

const ids = {
  userId: '',
  baseId: '',
  tableId: '',
  viewId: '',
  fields: {} as Record<string, string>,
};
const viewPath = () => `/b/${ids.baseId}/t/${ids.tableId}/v/${ids.viewId}`;

async function openAs(
  browser: Browser,
  options: { width?: number; height?: number; deviceScaleFactor?: number } = {},
) {
  const context = await browser.newContext({
    viewport: { width: options.width ?? 1440, height: options.height ?? 900 },
    deviceScaleFactor: options.deviceScaleFactor ?? 1,
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.localStorage.setItem('cellhive.language', 'en');
  });
  await page.goto('/login');
  await apiSignIn(page, ADMIN.email, ADMIN.password);
  return page;
}

async function gridReady(page: Page) {
  await page.goto(viewPath());
  await expect(page.locator('.ob-grid canvas').first()).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: /records?$/u })).toBeVisible();
}

/** The middle of data row `row`, `x` px from the left of the grid (compact rows). */
async function cellPoint(page: Page, x: number, row: number) {
  const box = await page.locator('.ob-grid canvas').first().boundingBox();
  if (box === null) throw new Error('no grid canvas');
  return { x: box.x + x, y: box.y + HEADER_HEIGHT + ROW_HEIGHT / 2 + ROW_HEIGHT * row };
}

test.describe('T420 FE carry-overs', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto('/login');
    // Any order of the specs (T470/T527): set up, signed in, or invited by the demo admin.
    await signInFirstAdmin(page, ADMIN);
    const me = await ok<{ user: { id: string }; orgs: { id: string }[] }>(page, 'GET', '/me');
    ids.userId = me.user.id;
    const orgId = me.orgs[0]?.id ?? '';
    const workspace = await ok<{ id: string }>(page, 'POST', `/orgs/${orgId}/workspaces`, {
      name: `T420 ${RUN}`,
    });
    const base = await ok<{ id: string }>(page, 'POST', `/workspaces/${workspace.id}/bases`, {
      name: 'Tồn đọng T420',
    });
    ids.baseId = base.id;
    const table = await ok<{ id: string }>(page, 'POST', `/bases/${base.id}/tables`, {
      name: 'Phiếu T420',
    });
    ids.tableId = table.id;
    for (const body of [
      { name: 'Trạng thái', type: 'text' },
      { name: 'Phụ trách', type: 'user' },
    ]) {
      const field = await ok<{ id: string }>(page, 'POST', `/tables/${table.id}/fields`, body);
      ids.fields[body.name] = field.id;
    }
    await ok(page, 'POST', `/tables/${table.id}/records?field_key_type=name`, {
      records: ['Máy in kẹt giấy', 'Két tiền treo', 'Màn hình khách'].map((name) => ({
        fields: { Name: name, 'Trạng thái': 'Mới', 'Phụ trách': [{ id: ids.userId }] },
      })),
    });
    const views = await ok<{ items: { id: string }[] }>(page, 'GET', `/tables/${table.id}/views`);
    ids.viewId = views.items[0]?.id ?? '';
    await page.close();
  });

  for (const menu of ['More actions', 'Filter'] as const) {
    test(`after "${menu}" closed with Escape, one click on a cell gives the grid the keyboard`, async ({
      browser,
    }) => {
      const page = await openAs(browser);
      await gridReady(page);
      const cell = await cellPoint(page, 330, 1);

      // Shift+Space selects the clicked cell's row at once.
      await page.getByRole('button', { name: menu, exact: true }).click();
      await expect(page.getByRole(menu === 'Filter' ? 'dialog' : 'menu')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole(menu === 'Filter' ? 'dialog' : 'menu')).toBeHidden();
      await page.mouse.click(cell.x, cell.y);
      await expect(page.getByText('1 row selected')).toBeVisible();
      await page.keyboard.press('Shift+Space');
      await expect(page.getByRole('button', { name: 'Delete 1 record' })).toBeVisible();

      // Typing edits the clicked cell at once.
      await page.getByRole('button', { name: menu, exact: true }).click();
      await expect(page.getByRole(menu === 'Filter' ? 'dialog' : 'menu')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole(menu === 'Filter' ? 'dialog' : 'menu')).toBeHidden();
      await page.mouse.click(cell.x, cell.y);
      await page.keyboard.type('Xử lý gấp');
      const editor = page.locator('#portal textarea, #portal input').first();
      await expect(editor).toBeFocused();
      await expect(editor).toHaveValue('Xử lý gấp');
      await page.keyboard.press('Escape');
      await page.context().close();
    });
  }

  for (const density of ['Compact', 'Comfortable'] as const) {
    for (const dpr of [1, 2]) {
      test(`avatar initials fit their circle: ${density} rows, pixel ratio ${String(dpr)}`, async ({
        browser,
      }) => {
        const page = await openAs(browser, { deviceScaleFactor: dpr });
        await gridReady(page);
        if (density === 'Comfortable') {
          await page.getByRole('button', { name: 'More actions', exact: true }).click();
          await page.getByRole('menuitemradio', { name: 'Comfortable' }).click();
          await expect(page.getByRole('menu')).toBeHidden();
        }
        const rowHeight = density === 'Compact' ? 34 : 44;
        const canvas = page.locator('.ob-grid [data-testid="data-grid-canvas"]');
        const box = await canvas.boundingBox();
        if (box === null) throw new Error('no grid canvas');
        // The first data row, from the "Phụ trách" column on (after Name and Trạng thái).
        const clip = { x: box.x + 420, y: box.y + HEADER_HEIGHT, width: 240, height: rowHeight };
        await page.screenshot({
          path: test.info().outputPath(`avatar-${density.toLowerCase()}-dpr${String(dpr)}.png`),
          clip,
        });
        // Pixels of the grid canvas: the avatar circle (an `--avatar-N` color)
        // and its white initials, in CSS pixels.
        const found = await canvas.evaluate(
          (element, { left, top, width, height }) => {
            const grid = element as HTMLCanvasElement;
            const ctx = grid.getContext('2d');
            if (ctx === null) return null;
            const scale = grid.width / grid.getBoundingClientRect().width;
            const root = getComputedStyle(document.documentElement);
            const hex = (value: string) => {
              const text = value.trim().replace('#', '');
              return [0, 2, 4].map((index) => Number.parseInt(text.slice(index, index + 2), 16));
            };
            const avatars = Array.from({ length: 8 }, (_, index) =>
              hex(root.getPropertyValue(`--avatar-${String(index)}`)),
            );
            const x0 = Math.round(left * scale);
            const y0 = Math.round(top * scale);
            const w = Math.round(width * scale);
            const h = Math.round(height * scale);
            const data = ctx.getImageData(x0, y0, w, h).data;
            const near = (r: number, g: number, b: number, color: number[]) =>
              Math.abs(r - (color[0] ?? 0)) +
                Math.abs(g - (color[1] ?? 0)) +
                Math.abs(b - (color[2] ?? 0)) <
              12;
            const circle = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
            for (let y = 0; y < h; y += 1) {
              for (let x = 0; x < w; x += 1) {
                const at = (y * w + x) * 4;
                const [r = 0, g = 0, b = 0] = [data[at], data[at + 1], data[at + 2]];
                if (avatars.some((color) => near(r, g, b, color))) {
                  circle.minX = Math.min(circle.minX, x);
                  circle.maxX = Math.max(circle.maxX, x);
                  circle.minY = Math.min(circle.minY, y);
                  circle.maxY = Math.max(circle.maxY, y);
                }
              }
            }
            if (circle.minX === Infinity) return null;
            // Only the first avatar: its right edge is the last column of circle
            // pixels before a column without any. Not its left edge plus its
            // height: the anti-aliased rim reads as the circle's color on the
            // sides and not at the top and bottom (or the other way round),
            // depending on the color, which cut 2 px off the right margin.
            const columnHasCircle = (x: number) => {
              for (let y = circle.minY; y <= circle.maxY; y += 1) {
                const at = (y * w + x) * 4;
                const [r = 0, g = 0, b = 0] = [data[at], data[at + 1], data[at + 2]];
                if (avatars.some((color) => near(r, g, b, color))) return true;
              }
              return false;
            };
            let right = circle.minX;
            while (right + 1 < w && columnHasCircle(right + 1)) right += 1;
            circle.maxX = right;
            const text = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
            // Inside the circle only (the white page shows around it).
            const cx = (circle.minX + circle.maxX) / 2;
            const cy = (circle.minY + circle.maxY) / 2;
            const radius = (circle.maxY - circle.minY) / 2;
            for (let y = circle.minY; y <= circle.maxY; y += 1) {
              for (let x = circle.minX; x <= circle.maxX; x += 1) {
                if (Math.hypot(x - cx, y - cy) > radius - 0.5) continue;
                const at = (y * w + x) * 4;
                if (
                  (data[at] ?? 0) > 200 &&
                  (data[at + 1] ?? 0) > 200 &&
                  (data[at + 2] ?? 0) > 200
                ) {
                  text.minX = Math.min(text.minX, x);
                  text.maxX = Math.max(text.maxX, x);
                  text.minY = Math.min(text.minY, y);
                  text.maxY = Math.max(text.maxY, y);
                }
              }
            }
            const css = (value: number) => value / scale;
            return {
              diameter: css(circle.maxY - circle.minY + 1),
              textWidth: css(text.maxX - text.minX + 1),
              left: css(text.minX - circle.minX),
              right: css(circle.maxX - text.maxX),
              top: css(text.minY - circle.minY),
              bottom: css(circle.maxY - text.maxY),
            };
          },
          { left: 420, top: HEADER_HEIGHT, width: 240, height: rowHeight },
        );
        expect(found, 'avatar drawn').not.toBeNull();
        if (found === null) return;
        // The DOM avatar of a user value: 24 px (28 px on comfortable rows);
        // the anti-aliased edge (about 1 px) does not match the solid color.
        const diameter = density === 'Compact' ? 24 : 28;
        expect(found.diameter).toBeGreaterThanOrEqual(diameter - 2.5);
        expect(found.diameter).toBeLessThanOrEqual(diameter);
        // Two initials ("NÁ"), with room on every side of the circle.
        expect(found.textWidth).toBeGreaterThan(10);
        for (const side of ['left', 'right', 'top', 'bottom'] as const) {
          expect(found[side], side).toBeGreaterThanOrEqual(2.5);
        }
        await page.context().close();
      });
    }
  }

  test('sidebar record count follows an import and a delete made in another tab', async ({
    browser,
  }) => {
    const tabA = await openAs(browser);
    const tabB = await openAs(browser);
    await gridReady(tabA);
    await gridReady(tabB);
    const count = tabA.getByTestId(`table-count-${ids.tableId}`);
    const before = Number((await count.textContent())?.replace(/\D/gu, ''));
    expect(before).toBeGreaterThan(0);
    const countReads: string[] = [];
    tabA.on('request', (request) => {
      const body = request.postData() ?? '';
      if (request.url().includes('/records/query') && body.includes('"limit":1,'))
        countReads.push(body);
    });

    // An import-sized write (150 records: one `record.batch`), then one delete.
    const created = await ok<{ records: { id: string }[] }>(
      tabB,
      'POST',
      `/tables/${ids.tableId}/records?field_key_type=name`,
      {
        records: Array.from({ length: 150 }, (_, index) => ({
          fields: { Name: `Nhập ${String(index + 1)}` },
        })),
      },
    );
    let started = Date.now();
    await expect(count).toHaveText(String(before + 150), { timeout: 2000 });
    const importMs = Date.now() - started;

    started = Date.now();
    await ok(tabB, 'DELETE', `/tables/${ids.tableId}/records/${created.records[0]?.id ?? ''}`);
    await expect(count).toHaveText(String(before + 149), { timeout: 2000 });
    const deleteMs = Date.now() - started;
    test.info().annotations.push({
      type: 'sidebar count latency',
      description: `import ${String(importMs)} ms, delete ${String(deleteMs)} ms`,
    });
    // One count read per change, not one per record message.
    expect(countReads.length, countReads.join('\n')).toBeLessThanOrEqual(2);
    await ok(tabB, 'DELETE', `/tables/${ids.tableId}/records`, {
      ids: created.records.slice(1).map((record) => record.id),
    });
    await tabA.context().close();
    await tabB.context().close();
  });
});
