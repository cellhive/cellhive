import { type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { DEMO_PASSWORD } from './seed';
import { apiSignIn, collectCspViolations, expectNoSeriousA11yViolations } from './support';

/**
 * T202: the grid of the demo base (CONTRACTS §9). Runs after t011 (files run
 * in name order on one worker): the instance is set up, then `seed:demo`
 * adds the demo organization.
 */

const DEMO_BASE = 'Chăm sóc khách hàng';
const TICKET_STATUSES = ['Mới', 'Đang xử lý', 'Chờ khách', 'Đã xong'];

async function signIn(page: Page, email: string, password: string) {
  // Demo users have the Vietnamese profile locale; this device picks English.
  await page.addInitScript(() => {
    if (window.localStorage.getItem('cellhive.language') === null) {
      window.localStorage.setItem('cellhive.language', 'en');
    }
  });
  await apiSignIn(page, email, password);
  await page.goto('/');
  await expect(page).toHaveURL(/\/o\//u);
}

/** Text of the hidden accessibility table glide keeps for the visible cells. */
function gridCells(page: Page) {
  return page.locator('table[role="grid"] td[role="gridcell"]');
}

/** RGBA of one canvas pixel (CSS px), to see the theme reach the canvas. */
async function canvasPixel(page: Page, x: number, y: number): Promise<number[]> {
  return page.evaluate(
    ([px, py]) => {
      const canvas = document.querySelector<HTMLCanvasElement>(
        '.ob-grid [data-testid="data-grid-canvas"]',
      );
      const context = canvas?.getContext('2d') ?? null;
      if (canvas === null || context === null) return [];
      const ratio = canvas.width / canvas.getBoundingClientRect().width;
      return [...context.getImageData(px * ratio, py * ratio, 1, 1).data];
    },
    [x, y] as const,
  );
}

test.describe('T202 grid', () => {
  // Wide enough for every Tickets column (the accessibility table lists visible columns only).
  test.use({ viewport: { width: 1920, height: 1000 } });

  test('Tickets: select chips, users, header labels, count, themes, a11y', async ({ page }) => {
    const cspViolations = collectCspViolations(page);
    await signIn(page, WORKER_ORG.email('admin'), DEMO_PASSWORD);

    await test.step('the base opens its first table; the tabs switch to Tickets', async () => {
      await page.getByRole('link', { name: DEMO_BASE }).first().click();
      // … and its view (T310: the last one used on this device, else the first).
      await expect(page).toHaveURL(
        /\/b\/bse_[0-9A-Za-z]{16}\/t\/tbl_[0-9A-Za-z]{16}\/v\/viw_[0-9A-Za-z]{16}$/u,
      );
      await page
        .getByRole('navigation', { name: 'Tables' })
        .getByRole('link', { name: 'Tickets' })
        .click();
      await expect(page.getByRole('heading', { level: 1, name: 'Tickets' })).toBeVisible();
      await expect(page).toHaveTitle(/^Tất cả phiếu · Tickets · Cellhive$/u);
    });

    await test.step('rows arrive with the exact count in the footer', async () => {
      await expect(page.getByRole('status').filter({ hasText: 'records' })).toHaveText(
        '2,000 records',
      );
      await expect(page.locator('table[role="grid"]')).toHaveAttribute('aria-rowcount', '2001');
    });

    await test.step('select values and users are in the cells', async () => {
      const texts = await gridCells(page).allTextContents();
      expect(texts.some((text) => TICKET_STATUSES.includes(text))).toBe(true);
      expect(texts.some((text) => /^TK-\d{8}-\d{4}$/u.test(text))).toBe(true);
    });

    await test.step('headers are announced with their field type', async () => {
      const headers = page.locator('table[role="grid"] th[role="columnheader"]');
      await expect(headers.filter({ hasText: 'Trạng thái' })).toHaveAttribute(
        'aria-label',
        'Trạng thái, single select',
      );
      await expect(headers.filter({ hasText: 'Tiêu đề' })).toHaveAttribute(
        'aria-label',
        'Tiêu đề, text, primary field',
      );
      await expect(headers.filter({ hasText: 'Phụ trách' })).toHaveAttribute(
        'aria-label',
        'Phụ trách, user',
      );
    });

    await test.step('assigned users are drawn with their names', async () => {
      const column = await page
        .locator('table[role="grid"] th[role="columnheader"]', { hasText: 'Phụ trách' })
        .getAttribute('aria-colindex');
      const names = await page
        .locator(`table[role="grid"] td[aria-colindex="${String(column)}"]`)
        .allTextContents();
      expect(names.filter((name) => name !== '').length).toBeGreaterThan(0);
    });

    await test.step('the canvas follows the dark theme', async () => {
      await expect(page.locator('.ob-grid [data-testid="data-grid-canvas"]')).toBeVisible();
      // A body cell away from text: the right half of the last visible column.
      const box = await page.locator('.ob-grid').boundingBox();
      if (box === null) throw new Error('grid not laid out');
      const x = Math.round(box.width - 12);
      const y = 36 + 34 * 3 + 4;
      const light = await canvasPixel(page, x, y);
      await page.getByRole('button', { name: /Account menu/u }).click();
      await page.getByRole('menuitemradio', { name: 'Dark' }).click();
      await page.keyboard.press('Escape');
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await expect.poll(() => canvasPixel(page, x, y)).not.toEqual(light);
      const dark = await canvasPixel(page, x, y);
      // Dark surface #181B1E is darker than the light surface #FFFFFF.
      expect((dark[0] ?? 255) < (light[0] ?? 0)).toBe(true);
      await page.screenshot({ path: test.info().outputPath('tickets-dark.png') });
      await page.getByRole('button', { name: /Account menu/u }).click();
      await page.getByRole('menuitemradio', { name: 'Light' }).click();
      await page.keyboard.press('Escape');
      await page.screenshot({ path: test.info().outputPath('tickets-light.png') });
    });

    await test.step('Vietnamese UI, no serious axe violation, no CSP violation', async () => {
      await expectNoSeriousA11yViolations(page, 'grid');
      await page.getByRole('button', { name: /Account menu/u }).click();
      await page.getByRole('menuitemradio', { name: 'Tiếng Việt' }).click();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('status').filter({ hasText: 'bản ghi' })).toHaveText(
        '2.000 bản ghi',
      );
      await expect(
        page.locator('table[role="grid"] th[role="columnheader"]', { hasText: 'Trạng thái' }),
      ).toHaveAttribute('aria-label', 'Trạng thái, chọn một');
      await page.getByRole('button', { name: /Menu tài khoản/u }).click();
      await page.getByRole('menuitemradio', { name: 'English' }).click();
      await page.keyboard.press('Escape');
      expect(cspViolations).toEqual([]);
    });
  });

  test('an unknown table of a base shows the not-found screen', async ({ page }) => {
    await signIn(page, WORKER_ORG.email('admin'), DEMO_PASSWORD);
    await page.getByRole('link', { name: DEMO_BASE }).first().click();
    await expect(page).toHaveURL(/\/t\/tbl_/u);
    const url = new URL(page.url());
    const baseId = url.pathname.split('/')[2] ?? '';
    await page.goto(`/b/${baseId}/t/tbl_0000000000000000`);
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  });
});
