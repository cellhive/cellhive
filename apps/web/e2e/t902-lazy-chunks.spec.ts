import { expect, test, WORKER_ORG } from './fixtures';
import { apiSignIn, expectNoSeriousA11yViolations, ok } from './support';

import type { Page } from '@playwright/test';

/**
 * T902 (FRONTEND §8.2): a lazy chunk that fails to load is fetched once more
 * after 500 ms; when that fails too, a route shows "Couldn't load this page"
 * inside the app shell and a panel shows its message over the page, each
 * with "Try again" — never a blank page.
 *
 * Google Chrome, not the bundled Chromium: Chromium before 154 keeps a module
 * fetch that failed for the life of the page (whatwg/html#6768), so a retry
 * there fails at once, without a request. Chrome stable fetches it again, as
 * the browsers people use do; GitHub's Ubuntu runners have it installed.
 */
test.use({ channel: 'chrome' });

const ACCOUNT_CHUNK = /\/assets\/AccountPage-[\w-]+\.js$/u;
const RECORD_PANEL_CHUNK = /\/assets\/RecordPanel-[\w-]+\.js$/u;
const DEMO_BASE = 'Chăm sóc khách hàng';

async function signIn(page: Page, language: 'en' | 'vi' = 'en') {
  await page.addInitScript((value) => {
    window.localStorage.setItem('cellhive.language', value);
  }, language);
  await apiSignIn(page, WORKER_ORG.email('admin'), WORKER_ORG.password);
}

/** Fails every request for `chunk` until the returned function is called; counts them. */
async function blockChunk(page: Page, chunk: RegExp, times = Infinity) {
  const state = { requests: 0 };
  await page.route(chunk, async (route) => {
    state.requests += 1;
    if (state.requests <= times) await route.abort('internetdisconnected');
    else await route.continue();
  });
  return state;
}

test.describe('T902 lazy chunks that fail to load', () => {
  test('a route opens after the automatic retry when its chunk fails once', async ({ page }) => {
    await signIn(page);
    const chunk = await blockChunk(page, ACCOUNT_CHUNK, 1);
    await page.goto('/account');
    await expect(page.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();
    expect(chunk.requests).toBe(2);
  });

  test('a route whose chunk keeps failing shows the error in the shell; "Try again" opens it', async ({
    page,
  }) => {
    await signIn(page);
    const chunk = await blockChunk(page, ACCOUNT_CHUNK);
    await page.goto('/account');
    await expect(
      page.getByRole('heading', { level: 1, name: "Couldn't load this page" }),
    ).toBeVisible();
    expect(chunk.requests).toBe(2);
    // Not a blank page: the app shell and its navigation stay.
    await expect(page.getByRole('button', { name: /Account menu/u })).toBeVisible();
    await expect(page).toHaveTitle("Couldn't load this page · Cellhive");
    await expect(page.getByRole('button', { name: 'Reload page' })).toBeVisible();
    await expectNoSeriousA11yViolations(page, 'route chunk error');

    await page.unroute(ACCOUNT_CHUNK);
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Account' })).toBeVisible();
    await expect(page.getByRole('heading', { name: "Couldn't load this page" })).toHaveCount(0);
  });

  test.describe('on a phone', () => {
    test.use({ viewport: { width: 375, height: 812 } });

    test('the error fits 375 px, in Vietnamese', async ({ page }) => {
      await signIn(page, 'vi');
      await blockChunk(page, ACCOUNT_CHUNK);
      await page.goto('/account');
      await expect(
        page.getByRole('heading', { level: 1, name: 'Không tải được trang' }),
      ).toBeVisible();
      const buttons = [
        page.getByRole('button', { name: 'Thử lại' }),
        page.getByRole('button', { name: 'Tải lại trang' }),
      ];
      for (const button of buttons) {
        await expect(button).toBeInViewport({ ratio: 1 });
        // Touch-sized controls below 1024 px (FRONTEND §9.3).
        expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      }
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBe(0);
      await expectNoSeriousA11yViolations(page, 'route chunk error at 375 px');
    });
  });

  test('a panel whose chunk keeps failing shows its error over the page, which keeps working', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto('/');
    await page.getByRole('link', { name: DEMO_BASE }).first().click();
    await page
      .getByRole('navigation', { name: 'Tables' })
      .getByRole('link', { name: 'Orders' })
      .click();
    await expect(page.getByRole('heading', { level: 1, name: 'Orders' })).toBeVisible();
    const tableId = /\/t\/(tbl_[^/?]+)/u.exec(page.url())?.[1] ?? '';
    const { records } = await ok<{ records: { id: string }[] }>(
      page,
      'GET',
      `/tables/${tableId}/records?limit=1`,
    );
    const chunk = await blockChunk(page, RECORD_PANEL_CHUNK);

    await page.goto(`${page.url().split('?')[0] ?? ''}?record=${records[0]?.id ?? ''}`);
    const alert = page.getByRole('alert').filter({ hasText: "Couldn't load this part" });
    await expect(alert).toBeVisible();
    expect(chunk.requests).toBe(2);
    // The page keeps working: the table is there and its toolbar answers.
    await expect(page.getByRole('heading', { level: 1, name: 'Orders' })).toBeVisible();
    await expect(page.getByRole('heading', { name: "Couldn't load this page" })).toHaveCount(0);
    await expectNoSeriousA11yViolations(page, 'panel chunk error');

    await page.unroute(RECORD_PANEL_CHUNK);
    await alert.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(alert).toHaveCount(0);
  });
});
