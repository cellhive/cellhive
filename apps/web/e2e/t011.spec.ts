import { expect, test, type Page } from '@playwright/test';

import { collectCspViolations, expectNoSeriousA11yViolations, uiTexts } from './support';

const ADMIN = {
  name: 'Nguyễn Văn Ánh',
  initials: 'NÁ',
  email: 'owner@cellhive.test',
  password: 'E2E-Setup-Password-2026',
};
const ORG_NAME = 'Công ty Đông Á';
const WORKSPACE_NAME = 'Kinh doanh';
const BASE_NAME = 'Khách hàng';

/** Texts that are the same in every language: user data, brand, language names. */
const LANGUAGE_NEUTRAL = new Set([
  'Cellhive',
  'English',
  'Tiếng Việt',
  ADMIN.name,
  ADMIN.initials,
  ADMIN.email,
  ORG_NAME,
  WORKSPACE_NAME,
  BASE_NAME,
  `${ORG_NAME} · Cellhive`,
  `${BASE_NAME} · Cellhive`,
]);

/**
 * Numbers (counts such as the automations of a base in the sidebar, T520)
 * are data formatted for the language with `Intl` (FRONTEND §9.1), not UI
 * strings: "0" or "12" reads the same in both languages.
 */
const NUMBER = /^[\d\s.,]+$/u;

function untranslated(vietnamese: readonly string[], english: readonly string[]): string[] {
  return vietnamese.filter(
    (text) => english.includes(text) && !LANGUAGE_NEUTRAL.has(text) && !NUMBER.test(text),
  );
}

async function openUserMenu(page: Page, name: RegExp) {
  await page.getByRole('button', { name }).click();
  await expect(page.getByRole('menu')).toBeVisible();
}

async function closeMenu(page: Page) {
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();
}

// The login page itself is under test here, so this spec signs in through the
// form, not `apiSignIn`: it runs first (files run in name order) against a
// fresh stack, so the per-IP sign-in window is still empty (T319).
test('T011: setup → sign in → workspace → base, en/vi, themes, a11y', async ({ page }) => {
  const cspViolations = collectCspViolations(page);
  let orgPath = '';

  await test.step('a new instance opens the setup screen', async () => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/setup$/u);
    await expect(page.getByRole('heading', { name: 'Set up Cellhive' })).toBeVisible();
    await expectNoSeriousA11yViolations(page, '/setup');
  });

  await test.step('validation messages are translated before anything is sent', async () => {
    await page.getByRole('button', { name: 'Create account and organization' }).click();
    await expect(page.getByText('Required.').first()).toBeVisible();
    // Focus moves to the first invalid field (react-hook-form focuses it twice:
    // now and on the next tick), so wait for it before typing elsewhere.
    await expect(page.getByLabel('Your name')).toBeFocused();
    const password = page.getByLabel('Password', { exact: true });
    await password.click();
    await expect(password).toBeFocused();
    await password.fill('short');
    await page.getByRole('button', { name: 'Create account and organization' }).click();
    await expect(page.getByText('Must be at least 10 characters.')).toBeVisible();
    await expect(page.getByLabel('Your name')).toBeFocused();
  });

  await test.step('setup creates the administrator and the organization', async () => {
    await page.getByLabel('Your name').fill(ADMIN.name);
    await page.getByLabel('Email').fill(ADMIN.email);
    await page.getByLabel('Password', { exact: true }).fill(ADMIN.password);
    await page.getByLabel('Confirm password').fill(ADMIN.password);
    await page.getByLabel('Organization name').fill(ORG_NAME);
    await page.getByRole('button', { name: 'Create account and organization' }).click();
    await expect(page).toHaveURL(/\/login$/u);
    await expect(page.getByRole('status')).toContainText('Your account and organization are ready');
    await expect(page.getByLabel('Email')).toHaveValue(ADMIN.email);
    // No SMTP in this stack: no "forgot password" link, an explanation instead.
    await expect(page.getByRole('link', { name: 'Forgot your password?' })).toHaveCount(0);
    await expect(page.getByText(/Ask an administrator/u)).toBeVisible();
    await expectNoSeriousA11yViolations(page, '/login');
  });

  await test.step('/setup is closed once set up', async () => {
    await page.goto('/setup');
    await expect(page).toHaveURL(/\/login$/u);
  });

  await test.step('a wrong password gives a translated error', async () => {
    await page.getByLabel('Email').fill(ADMIN.email);
    await page.getByLabel('Password').fill('not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toContainText('Wrong email or password.');
  });

  await test.step('sign in opens the organization', async () => {
    await page.getByLabel('Password').fill(ADMIN.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/o\/[a-z0-9-]+$/u);
    orgPath = new URL(page.url()).pathname;
    await expect(page.getByRole('heading', { level: 1, name: ORG_NAME })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'No workspaces yet' })).toBeVisible();
    await expectNoSeriousA11yViolations(page, 'organization home (empty)');
  });

  await test.step('create a workspace', async () => {
    await page.getByRole('main').getByRole('button', { name: 'New workspace' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Create workspace' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('Workspace name')).toBeFocused();
    await expectNoSeriousA11yViolations(page, 'create workspace dialog');
    await dialog.getByLabel('Workspace name').fill(WORKSPACE_NAME);
    await dialog.getByRole('button', { name: 'Create workspace' }).click();
    await expect(page).toHaveURL(/\/w\/wsp_[0-9A-Za-z]{16}$/u);
    const nav = page.getByRole('navigation', { name: 'Workspaces' });
    await expect(nav.getByRole('link', { name: WORKSPACE_NAME })).toBeVisible();
  });

  await test.step('create a base; it shows in the sidebar', async () => {
    await page.getByRole('button', { name: `New base in ${WORKSPACE_NAME}` }).click();
    const dialog = page.getByRole('dialog', { name: 'Create base' });
    await dialog.getByLabel('Base name').fill(BASE_NAME);
    await dialog.getByRole('button', { name: 'Create base' }).click();
    await expect(page).toHaveURL(/\/b\/bse_[0-9A-Za-z]{16}$/u);
    await expect(page.getByRole('heading', { level: 1, name: BASE_NAME })).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Workspaces' });
    const baseLink = nav.getByRole('link', { name: BASE_NAME });
    await expect(baseLink).toBeVisible();
    await expect(baseLink).toHaveAttribute('aria-current', 'page');
    await expectNoSeriousA11yViolations(page, 'base page');
  });

  await test.step('every UI text changes with the language, without a reload', async () => {
    const basePath = new URL(page.url()).pathname;
    const englishBase = await uiTexts(page);
    await page.goto(orgPath);
    await expect(page.getByRole('link', { name: BASE_NAME }).first()).toBeVisible();
    const englishOrg = await uiTexts(page);
    await page.goto(basePath);
    await expect(page.getByRole('heading', { level: 1, name: BASE_NAME })).toBeVisible();

    // Mark the document: a reload would drop the marker.
    await page.evaluate(() => {
      (window as unknown as { __noReload: boolean }).__noReload = true;
    });
    await openUserMenu(page, /Account menu/u);
    await page.getByRole('menuitemradio', { name: 'Tiếng Việt' }).click();
    await closeMenu(page);
    await expect(page.locator('html')).toHaveAttribute('lang', 'vi');
    await expect(page.getByRole('heading', { name: 'Chưa có bảng nào' })).toBeVisible();
    expect(
      await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload),
    ).toBe(true);

    const vietnameseBase = await uiTexts(page);
    const untranslatedBase = untranslated(vietnameseBase, englishBase);
    expect(untranslatedBase, 'texts identical in en and vi on the base page').toEqual([]);
    await expectNoSeriousA11yViolations(page, 'base page (vi)');

    await page.getByRole('link', { name: 'Cellhive' }).click();
    await expect(page.getByRole('heading', { level: 1, name: ORG_NAME })).toBeVisible();
    const vietnameseOrg = await uiTexts(page);
    const untranslatedOrg = untranslated(vietnameseOrg, englishOrg);
    expect(untranslatedOrg, 'texts identical in en and vi on the organization home').toEqual([]);
  });

  await test.step('dark theme, remembered with the language after a reload', async () => {
    await openUserMenu(page, /Menu tài khoản/u);
    await page.getByRole('menuitemradio', { name: 'Tối' }).click();
    await closeMenu(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expectNoSeriousA11yViolations(page, 'organization home (dark)');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('html')).toHaveAttribute('lang', 'vi');
    await expect(page.getByRole('heading', { level: 1, name: ORG_NAME })).toBeVisible();

    await openUserMenu(page, /Menu tài khoản/u);
    await page.getByRole('menuitemradio', { name: 'English' }).click();
    // Choosing an item closes the menu.
    await openUserMenu(page, /Account menu/u);
    await page.getByRole('menuitemradio', { name: 'Light' }).click();
    await closeMenu(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  });

  await test.step('unknown and inaccessible resources show the same 404', async () => {
    await page.goto('/o/no-such-org');
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    await page.goto('/b/bse_0000000000000000');
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    await expectNoSeriousA11yViolations(page, '404');
  });

  await test.step('sign out, then ?next= only follows internal paths', async () => {
    await page.goto(orgPath);
    await openUserMenu(page, /Account menu/u);
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/u);

    await page.goto(orgPath);
    await expect(page).toHaveURL(new RegExp(`/login\\?next=${encodeURIComponent(orgPath)}$`, 'u'));

    await page.goto(`/login?next=${encodeURIComponent('//evil.example/phish')}`);
    await page.getByLabel('Email').fill(ADMIN.email);
    await page.getByLabel('Password').fill(ADMIN.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(new RegExp(`${orgPath}$`, 'u'));
  });

  // The dev server (E2E_VITE_DEV=1) sends no CSP; the build is served with it.
  expect(cspViolations, 'Content-Security-Policy violations').toEqual([]);
});
