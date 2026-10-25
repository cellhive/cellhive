import { type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { DEMO_PASSWORD } from './seed';
import { apiSignIn } from './support';

/**
 * S3 QA regression: temporary view changes (drafts) belong to the user who
 * made them. They are kept per user in localStorage and deleted on sign-out,
 * so the next person signing in on the same browser sees the saved view.
 */

const DEMO_BASE = 'Chăm sóc khách hàng';
const EDITOR_EMAIL = WORKER_ORG.email('editor');
const READER_EMAIL = WORKER_ORG.email('reader');

function toolbar(page: Page) {
  return page.getByRole('toolbar', { name: 'View options' });
}

function unsaved(page: Page) {
  return page.getByRole('group', { name: 'Unsaved changes' });
}

/** Opens Orders; returns the path of its view. */
async function openOrders(page: Page): Promise<string> {
  await page.goto('/');
  await page.getByRole('link', { name: DEMO_BASE }).first().click();
  await expect(page).toHaveURL(/\/t\/tbl_/u);
  await page
    .getByRole('navigation', { name: 'Tables' })
    .getByRole('link', { name: 'Orders' })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Orders' })).toBeVisible();
  await expect(page).toHaveURL(/\/v\/viw_/u);
  await expect(page.getByRole('status').filter({ hasText: /records?$/u })).toBeVisible();
  return new URL(page.url()).pathname;
}

function draftKeys(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Object.keys(window.localStorage).filter((key) => key.startsWith('cellhive.viewDraft.')),
  );
}

test('an editor’s unsaved sort is gone after sign-out: the reader sees the saved view', async ({
  page,
}) => {
  await page.addInitScript(() => {
    if (window.localStorage.getItem('cellhive.language') === null) {
      window.localStorage.setItem('cellhive.language', 'en');
    }
  });
  await page.goto('/login');
  await apiSignIn(page, EDITOR_EMAIL, DEMO_PASSWORD);
  const viewPath = await openOrders(page);
  const viewId = viewPath.split('/').at(-1) ?? '';

  await test.step('editor: a temporary sort, kept under the editor’s id', async () => {
    await toolbar(page).getByTestId('sort-button').click();
    await page
      .getByRole('dialog', { name: 'Sort' })
      .getByRole('combobox', { name: 'Add a sort field' })
      .selectOption({ index: 1 });
    await page.keyboard.press('Escape');
    await expect(toolbar(page).getByRole('button', { name: /^Sort: /u })).toBeVisible();
    await expect(unsaved(page)).toBeVisible();
    const keys = await draftKeys(page);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(new RegExp(`^cellhive\\.viewDraft\\.usr_[^.]+\\.${viewId}$`, 'u'));
    // A draft from before drafts were per user: nobody's, deleted at the next sign-in.
    await page.evaluate((id) => {
      window.localStorage.setItem(
        `cellhive.viewDraft.${id}`,
        JSON.stringify({ row_height: 'extra_tall' }),
      );
    }, viewId);
  });

  await test.step('sign out deletes the editor’s drafts', async () => {
    await page.getByRole('button', { name: /Account menu/u }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/u);
    expect(await draftKeys(page)).toEqual([`cellhive.viewDraft.${viewId}`]);
  });

  await test.step('reader on the same browser: the saved view, nothing unsaved', async () => {
    await apiSignIn(page, READER_EMAIL, DEMO_PASSWORD);
    await page.goto(viewPath);
    await expect(page.getByRole('status').filter({ hasText: /records?$/u })).toBeVisible();
    await expect(toolbar(page).getByRole('button', { name: 'Sort', exact: true })).toBeVisible();
    await expect(unsaved(page)).toHaveCount(0);
    expect(await draftKeys(page)).toEqual([]);
  });
});
