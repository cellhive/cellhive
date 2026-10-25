import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { DEMO_PASSWORD } from './seed';
import { api, apiSignIn, collectCspViolations, expectNoSeriousA11yViolations, ok } from './support';

/**
 * T714: API tokens (FRONTEND §15.6, CONTRACTS §26) on the demo data of
 * CONTRACTS §9:
 *
 * - u_editor (a member) creates a "Read data" token with the keyboard; it is
 *   shown once (gone after reload), never in localStorage, sessionStorage or
 *   IndexedDB; with it `GET /tables/:id/records` → 200, `PATCH` a record →
 *   403 INSUFFICIENT_SCOPE; "last used" updates; revoking → 401;
 * - u_editor has no "All tokens" / "Policy" tabs;
 * - u_admin (org owner) sees u_editor's token (no value) and revokes it → 401;
 * - a 30-day policy disables longer expirations with the reason;
 * - axe on every state; Vietnamese at 375 px without horizontal scroll.
 *
 * `afterAll` revokes every token of u_editor and restores the default policy.
 */

const EDITOR_EMAIL = WORKER_ORG.email('editor');

interface Demo {
  orgId: string;
  orgSlug: string;
  editorId: string;
  customers: string;
  recordId: string;
}

type Cookies = Awaited<ReturnType<BrowserContext['cookies']>>;
const cookies: Record<string, Cookies> = {};

/** A new context signed in as `email` (one sign-in per user and spec: 20/min per IP). */
async function openAs(
  browser: Browser,
  email: string,
  options: { viewport?: { width: number; height: number }; language?: 'en' | 'vi' } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1440, height: 900 },
    locale: 'en-US',
  });
  await context.addInitScript((value) => {
    window.localStorage.setItem('cellhive.language', value);
  }, options.language ?? 'en');
  const page = await context.newPage();
  await page.goto('/login');
  const saved = cookies[email];
  if (saved === undefined) {
    await apiSignIn(page, email, DEMO_PASSWORD);
    cookies[email] = await context.cookies();
  } else {
    await context.addCookies(saved);
  }
  return { context, page };
}

async function findDemo(page: Page): Promise<Demo> {
  const me = await ok<{ user: { id: string }; orgs: { id: string; slug: string }[] }>(
    page,
    'GET',
    '/me',
  );
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
      const base = bases.items.find((item) => item.name === 'Chăm sóc khách hàng');
      if (base === undefined) continue;
      const tables = await ok<{ items: { id: string; name: string }[] }>(
        page,
        'GET',
        `/bases/${base.id}/tables`,
      );
      const customers = tables.items.find((table) => table.name === 'Customers')?.id ?? '';
      const records = await ok<{ records: { id: string }[] }>(
        page,
        'GET',
        `/tables/${customers}/records?limit=1`,
      );
      return {
        orgId: org.id,
        orgSlug: org.slug,
        editorId: me.user.id,
        customers,
        recordId: records.records[0]?.id ?? '',
      };
    }
  }
  throw new Error('The demo base is missing.');
}

interface BearerBody {
  code?: string;
  errors?: { params?: unknown }[];
}

/** A request with only the Bearer token (no cookie, no CSRF), like an integration. */
async function bearer(
  request: APIRequestContext,
  method: 'GET' | 'PATCH',
  path: string,
  token: string,
): Promise<{ status: number; body: BearerBody | null }> {
  const response = await request.fetch(`/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(method === 'PATCH' ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(method === 'PATCH' ? { data: { fields: {} } } : {}),
  });
  const text = await response.text();
  return { status: response.status(), body: text === '' ? null : (JSON.parse(text) as BearerBody) };
}

/** Everything the page stored: localStorage, sessionStorage, and every IndexedDB record. */
async function storedText(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const parts: string[] = [];
    for (const storage of [window.localStorage, window.sessionStorage]) {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index) ?? '';
        parts.push(key, storage.getItem(key) ?? '');
      }
    }
    const databases = await indexedDB.databases();
    for (const info of databases) {
      if (info.name === undefined) continue;
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(info.name ?? '');
        request.onsuccess = () => {
          resolve(request.result);
        };
        request.onerror = () => {
          reject(request.error ?? new Error('indexedDB.open failed'));
        };
      });
      for (const store of Array.from(db.objectStoreNames)) {
        const values = await new Promise<unknown[]>((resolve, reject) => {
          const request = db.transaction(store, 'readonly').objectStore(store).getAll();
          request.onsuccess = () => {
            resolve(request.result);
          };
          request.onerror = () => {
            reject(request.error ?? new Error('getAll failed'));
          };
        });
        parts.push(JSON.stringify(values));
      }
      db.close();
    }
    return parts.join('\n');
  });
}

function noHorizontalScroll(page: Page, width: number) {
  return expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(width);
}

test.describe.configure({ mode: 'serial' });

let demo: Demo;
const tokens = { first: '', second: '', secondId: '' };

async function cleanUp(browser: Browser): Promise<void> {
  const editor = await openAs(browser, EDITOR_EMAIL);
  const mine = await ok<{ items: { id: string; revoked_at: string | null }[] }>(
    editor.page,
    'GET',
    `/orgs/${demo.orgId}/me/api-tokens?limit=100`,
  );
  for (const item of mine.items.filter((token) => token.revoked_at === null)) {
    await ok(editor.page, 'DELETE', `/api-tokens/${item.id}`);
  }
  await editor.context.close();
  const admin = await openAs(browser, WORKER_ORG.email('admin'));
  await ok(admin.page, 'PATCH', `/orgs/${demo.orgId}`, {
    settings: { api_tokens: { enabled: true, max_lifetime_days: null } },
  });
  await admin.context.close();
}

test.beforeAll(async ({ browser }) => {
  const { context, page } = await openAs(browser, EDITOR_EMAIL);
  demo = await findDemo(page);
  await context.close();
  await cleanUp(browser);
});

test.afterAll(async ({ browser }) => {
  await cleanUp(browser);
});

test('u_editor creates a "Read data" token, shown once; it reads, cannot write, and stops when revoked', async ({
  browser,
  request,
}) => {
  const { context, page } = await openAs(browser, EDITOR_EMAIL);
  const csp = collectCspViolations(page);
  // The entry: the account menu of the sidebar.
  await page.goto(`/o/${demo.orgSlug}`);
  await page.getByRole('button', { name: /^Account menu for/u }).click();
  await page.getByRole('menuitem', { name: 'API tokens' }).click();
  await expect(page).toHaveURL(new RegExp(`/o/${demo.orgSlug}/settings/api-tokens$`, 'u'));
  await expect(page.getByRole('heading', { name: 'API tokens', level: 1 })).toBeVisible();
  // A member: no "All tokens" / "Policy", even when asked for.
  await expect(page.getByRole('tablist')).toHaveCount(0);
  await expect(page.getByTestId('tokens-empty')).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'my tokens: empty');

  // Keyboard only: open, name, Enter.
  await page.getByTestId('token-create').focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'New API token' });
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('token-name-input').focus();
  await page.keyboard.type('CI read');
  await expect(dialog.getByTestId('token-preset-read')).toBeChecked();
  await expect(dialog.getByTestId('token-expiry-90')).toBeChecked();
  await expectNoSeriousA11yViolations(page, 'create token dialog');
  await page.keyboard.press('Enter');

  const reveal = page.getByRole('dialog', { name: 'Copy your new token' });
  await expect(reveal).toBeVisible();
  const value = await reveal.getByTestId('token-value').inputValue();
  expect(value).toMatch(/^cht_[0-9A-Za-z]{36}$/u);
  tokens.first = value;
  await expect(reveal.getByTestId('token-curl')).toHaveValue(
    new RegExp(`^curl -H "Authorization: Bearer ${value}" `, 'u'),
  );
  await expectNoSeriousA11yViolations(page, 'token shown once');
  // Escape does not close it before "I've saved it".
  await page.keyboard.press('Escape');
  await expect(reveal.getByRole('alert')).toContainText("Confirm that you've saved the token");
  await expect(reveal.getByTestId('token-reveal-confirm')).toBeFocused();
  await page.keyboard.press('Space');
  await reveal.getByTestId('token-reveal-done').focus();
  await page.keyboard.press('Enter');
  await expect(reveal).toBeHidden();
  expect(await page.content()).not.toContain(value);
  expect(await storedText(page)).not.toContain(value);

  const row = page.getByTestId('token-row').filter({ hasText: 'CI read' });
  await expect(row).toContainText(`cht_${value.slice(4, 12)}…`);
  await expect(row).toContainText('Read records');
  await expect(row).toContainText('Read structure');
  await expect(row.getByTestId('token-last-used')).toHaveText('Last used: Never');

  // Real requests with the token only.
  const read = await bearer(request, 'GET', `/tables/${demo.customers}/records?limit=1`, value);
  expect(read.status).toBe(200);
  const write = await bearer(
    request,
    'PATCH',
    `/tables/${demo.customers}/records/${demo.recordId}`,
    value,
  );
  expect(write.status).toBe(403);
  expect(write.body?.code).toBe('INSUFFICIENT_SCOPE');
  expect(write.body?.errors?.[0]?.params).toEqual({ required: ['records:write'] });

  // Reload: the value is gone for good; "last used" was written.
  await page.reload();
  await expect(page.getByTestId('token-row').filter({ hasText: 'CI read' })).toBeVisible();
  expect(await page.content()).not.toContain(value);
  expect(await storedText(page)).not.toContain(value);
  await expect(
    page.getByTestId('token-row').filter({ hasText: 'CI read' }).getByTestId('token-last-used'),
  ).not.toHaveText('Last used: Never');
  await expectNoSeriousA11yViolations(page, 'my tokens: one token');

  // Revoke (alertdialog) → the token gets 401.
  await page.getByRole('button', { name: 'Revoke CI read' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Revoke “CI read”?' });
  await expect(confirm).toContainText('stop working immediately');
  await expectNoSeriousA11yViolations(page, 'revoke token');
  await confirm.getByTestId('token-revoke-confirm').click();
  await expect(confirm).toBeHidden();
  await expect(
    page.getByTestId('token-row').filter({ hasText: 'CI read' }).getByTestId('token-status'),
  ).toHaveText('Revoked');
  const after = await bearer(request, 'GET', `/tables/${demo.customers}/records?limit=1`, value);
  expect(after.status).toBe(401);

  // Asking for an admin tab still shows "Mine".
  await page.goto(`/o/${demo.orgSlug}/settings/api-tokens?tab=policy`);
  await expect(page.getByTestId('my-tokens')).toBeVisible();
  await expect(page.getByTestId('token-policy')).toHaveCount(0);
  expect(csp).toEqual([]);
  await context.close();
});

test("u_admin sees u_editor's token without its value and revokes it", async ({
  browser,
  request,
}) => {
  const editor = await openAs(browser, EDITOR_EMAIL);
  const created = await ok<{ id: string; token: string }>(
    editor.page,
    'POST',
    `/orgs/${demo.orgId}/me/api-tokens`,
    { name: 'Editor sync', scopes: ['records:read'], base_ids: null, expires_at: null },
  );
  tokens.second = created.token;
  tokens.secondId = created.id;
  await editor.context.close();
  expect(
    (await bearer(request, 'GET', `/tables/${demo.customers}/records?limit=1`, created.token))
      .status,
  ).toBe(200);

  const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
  await page.goto(`/o/${demo.orgSlug}/settings/api-tokens`);
  const tabs = page.getByRole('tablist', { name: 'API token sections' });
  await expect(tabs.getByRole('tab')).toHaveText(['Mine', 'All tokens', 'Policy']);
  // Arrow keys move between tabs.
  await tabs.getByRole('tab', { name: 'Mine' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(tabs.getByRole('tab', { name: 'All tokens' })).toBeFocused();
  await expect(tabs.getByRole('tab', { name: 'All tokens' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page).toHaveURL(/\?tab=all$/u);
  const section = page.getByTestId('org-tokens');
  await section.getByTestId('org-tokens-member').selectOption(demo.editorId);
  await section.getByTestId('org-tokens-status').selectOption('active');
  const row = section.getByTestId('token-row').filter({ hasText: 'Editor sync' });
  await expect(row).toContainText(`cht_${created.token.slice(4, 12)}…`);
  await expect(row.getByTestId('token-owner')).toBeVisible();
  expect(await page.content()).not.toContain(created.token);
  await expectNoSeriousA11yViolations(page, 'all tokens');
  await row.getByTestId('token-revoke').click();
  const confirm = page.getByRole('alertdialog', { name: 'Revoke “Editor sync”?' });
  await expect(confirm).toContainText('stop working immediately');
  await confirm.getByTestId('token-revoke-confirm').click();
  await expect(confirm).toBeHidden();
  await expect(section.getByTestId('token-row').filter({ hasText: 'Editor sync' })).toHaveCount(0);
  expect(
    (await bearer(request, 'GET', `/tables/${demo.customers}/records?limit=1`, created.token))
      .status,
  ).toBe(401);
  await context.close();
});

test('a 30-day policy disables longer expirations, with the reason', async ({ browser }) => {
  const admin = await openAs(browser, WORKER_ORG.email('admin'));
  await admin.page.goto(`/o/${demo.orgSlug}/settings/api-tokens?tab=policy`);
  const policy = admin.page.getByTestId('token-policy');
  await policy.getByTestId('token-policy-limit').check();
  await policy.getByTestId('token-policy-days').fill('30');
  await expectNoSeriousA11yViolations(admin.page, 'policy');
  await policy.getByTestId('token-policy-save').click();
  await expect(admin.page.getByText('Policy saved.')).toBeVisible();
  // Turning tokens off warns before saving (not saved here).
  await policy.getByTestId('token-policy-enabled').uncheck();
  await expect(policy.getByTestId('token-policy-off-warning')).toContainText('stop immediately');
  await admin.context.close();

  const { context, page } = await openAs(browser, EDITOR_EMAIL);
  await page.goto(`/o/${demo.orgSlug}/settings/api-tokens`);
  await page.getByTestId('token-create').click();
  const dialog = page.getByRole('dialog', { name: 'New API token' });
  await expect(dialog.getByTestId('token-expiry-30')).toBeChecked();
  for (const choice of ['90', '365']) {
    await expect(dialog.getByTestId(`token-expiry-${choice}`)).toBeDisabled();
  }
  await expect(dialog.getByTestId('token-expiry-none')).toBeDisabled();
  await expect(
    dialog.getByText('Not allowed: this organization limits tokens to 30 days.'),
  ).toHaveCount(2);
  await expect(
    dialog.getByText('Not allowed: this organization requires tokens to expire.'),
  ).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'create token under a 30-day policy');
  await context.close();
});

test('Vietnamese at 375 px: no horizontal scroll', async ({ browser }) => {
  const { context, page } = await openAs(browser, EDITOR_EMAIL, {
    viewport: { width: 375, height: 812 },
    language: 'vi',
  });
  await page.goto(`/o/${demo.orgSlug}/settings/api-tokens`);
  await expect(page.getByRole('heading', { name: 'API token', level: 1 })).toBeVisible();
  await expect(page.getByTestId('token-row').first()).toBeVisible();
  await expect(page.getByTestId('token-row').first()).toContainText('Đã thu hồi');
  await noHorizontalScroll(page, 375);
  await expectNoSeriousA11yViolations(page, 'my tokens at 375 px (vi)');
  await page.getByTestId('token-create').click();
  const dialog = page.getByRole('dialog', { name: 'API token mới' });
  await expect(dialog.getByText('Đọc dữ liệu', { exact: true })).toBeVisible();
  await noHorizontalScroll(page, 375);
  await expectNoSeriousA11yViolations(page, 'create token at 375 px (vi)');
  // Session-only management: the admin API refuses a member.
  expect((await api(page, 'GET', `/orgs/${demo.orgId}/api-tokens`)).status).toBe(403);
  await context.close();
});
