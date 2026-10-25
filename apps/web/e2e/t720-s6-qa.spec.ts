import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { type Browser, type BrowserContext, type Page } from '@playwright/test';

import { FAKE_OIDC_NAME } from './fake-oidc';
import { expect, test, WORKER_ORG } from './fixtures';
import { DEMO_PASSWORD } from './seed';
import { animationsSettled, api, apiSignIn, collectCspViolations, ok } from './support';

/**
 * T720 (QA S6): every S6 screen, in the states the demo organization
 * reaches, audited the same way — axe (WCAG 2.2 AA tags) with no
 * serious/critical violation, no horizontal scrolling, no CSP violation —
 * at 1440 px light (Vietnamese), 1440 px dark (English), 375 px light
 * (Vietnamese) and 375 px dark (English):
 *
 * - base settings: index, members, the access panel of u_sales1, roles, the
 *   role editor (Sales) and its Orders detail, the delete confirmation of a
 *   custom role, the base audit viewer and its drawer;
 * - organization: audit viewer, API tokens (mine, organization, policy), the
 *   create dialog and the shown-once token, the revoke confirmation,
 *   integrations (HTTP secrets with their allowed hosts, a legacy secret);
 * - account: connected accounts; signed out: the sign-in page with the SSO
 *   providers and an OIDC error.
 *
 * Plus the roles (u_editor, u_reader, u_sales1, u_out — a plain member):
 * every base-admin and org-admin S6 page is the "not found" screen (and the
 * API agrees), while "My tokens" stays theirs; and a token value never ends
 * up in a URL (the page that shows it once sends no Referer to other origins).
 *
 * Runs on the shared stack with the demo seed. Set `T720_SHOTS=<dir>` to save
 * a JPEG of each audited screen (the design audit of `docs/reviews/S6-QA.md`).
 */

const SHOTS = process.env['T720_SHOTS'];
const RUN = Date.now().toString(36);
const users = {
  admin: WORKER_ORG.email('admin'),
  editor: WORKER_ORG.email('editor'),
  reader: WORKER_ORG.email('reader'),
  sales1: WORKER_ORG.email('sales1'),
  out: WORKER_ORG.email('out'),
} as const;
const SALES1_NAME = 'Phạm Ngọc Lan';

interface Variant {
  readonly name: string;
  readonly viewport: { width: number; height: number };
  readonly language: 'en' | 'vi';
  readonly colorScheme: 'light' | 'dark';
}

const VARIANTS: readonly Variant[] = [
  {
    name: '1440-light-vi',
    viewport: { width: 1440, height: 900 },
    language: 'vi',
    colorScheme: 'light',
  },
  {
    name: '1440-dark-en',
    viewport: { width: 1440, height: 900 },
    language: 'en',
    colorScheme: 'dark',
  },
  {
    name: '375-light-vi',
    viewport: { width: 375, height: 812 },
    language: 'vi',
    colorScheme: 'light',
  },
  {
    name: '375-dark-en',
    viewport: { width: 375, height: 812 },
    language: 'en',
    colorScheme: 'dark',
  },
];
const DESKTOP = VARIANTS[1] as Variant;

const sessions = new Map<string, Awaited<ReturnType<BrowserContext['storageState']>>>();

async function openAs(
  browser: Browser,
  email: string | null,
  variant: Variant = DESKTOP,
): Promise<{ context: BrowserContext; page: Page }> {
  const known = email === null ? undefined : sessions.get(email);
  const context = await browser.newContext({
    viewport: variant.viewport,
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: variant.colorScheme,
    ...(known === undefined ? {} : { storageState: known }),
  });
  await context.addInitScript((value) => {
    window.localStorage.setItem('cellhive.language', value);
  }, variant.language);
  const page = await context.newPage();
  await page.goto('/login');
  if (email !== null && known === undefined) {
    await apiSignIn(page, email, DEMO_PASSWORD);
    sessions.set(email, await context.storageState());
  }
  return { context, page };
}

/** axe (no serious/critical), no horizontal scroll; a JPEG with `T720_SHOTS`. */
async function audit(page: Page, label: string): Promise<void> {
  await animationsSettled(page);
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const serious = results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => ({
      id: violation.id,
      targets: violation.nodes.map((node) => node.target.join(' ')),
    }));
  expect(serious, `axe violations on ${label}`).toEqual([]);
  const { scroll, width } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    width: window.innerWidth,
  }));
  expect(scroll, `horizontal scroll on ${label}`).toBeLessThanOrEqual(width);
  if (SHOTS !== undefined) {
    await mkdir(SHOTS, { recursive: true });
    await page.screenshot({
      path: join(SHOTS, `${label.replace(/[^a-z0-9-]+/giu, '-')}.jpg`),
      type: 'jpeg',
      quality: 60,
      fullPage: true,
    });
  }
}

/** No label of the role editor's level controls is cut off (T720: "No ac…" at 1440 px). */
async function noTruncatedLevels(page: Page, label: string): Promise<void> {
  const cut = await page
    .locator('[role="radiogroup"] [role="radio"] span')
    .evaluateAll((spans) =>
      spans.filter((span) => span.scrollWidth > span.clientWidth).map((span) => span.textContent),
    );
  expect(cut, `truncated level labels on ${label}`).toEqual([]);
}

const notFound = (page: Page, language: 'en' | 'vi' = 'en') =>
  page.getByRole('heading', {
    name: language === 'vi' ? 'Không tìm thấy trang' : 'Page not found',
  });

interface Fixture {
  orgId: string;
  orgSlug: string;
  baseId: string;
  orders: string;
  salesRole: string;
  spareRole: string;
  sales1: string;
}
const fx = {} as Fixture;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  const { context, page } = await openAs(browser, users.admin);
  const me = await ok<{ orgs: { id: string; slug: string }[] }>(page, 'GET', '/me');
  fx.orgId = me.orgs[0]?.id ?? '';
  fx.orgSlug = me.orgs[0]?.slug ?? '';
  const workspaces = await ok<{ items: { id: string }[] }>(
    page,
    'GET',
    `/orgs/${fx.orgId}/workspaces`,
  );
  for (const workspace of workspaces.items) {
    const bases = await ok<{ items: { id: string; name: string }[] }>(
      page,
      'GET',
      `/workspaces/${workspace.id}/bases`,
    );
    const demo = bases.items.find((item) => item.name === 'Chăm sóc khách hàng');
    if (demo !== undefined) fx.baseId = demo.id;
  }
  const tables = await ok<{ items: { id: string; name: string }[] }>(
    page,
    'GET',
    `/bases/${fx.baseId}/tables`,
  );
  fx.orders = tables.items.find((table) => table.name === 'Orders')?.id ?? '';
  const roles = await ok<{ items: { id: string; name: string; kind: string }[] }>(
    page,
    'GET',
    `/bases/${fx.baseId}/roles`,
  );
  fx.salesRole = roles.items.find((role) => role.name === 'Sales')?.id ?? '';
  // A custom role nobody holds: its delete confirmation is audited, never confirmed.
  fx.spareRole = (
    await ok<{ id: string }>(page, 'POST', `/bases/${fx.baseId}/roles`, {
      name: `QA T720 ${RUN}`,
      config: { tables: {} },
    })
  ).id;
  const principals = await ok<{ items: { principal_id: string; email: string | null }[] }>(
    page,
    'GET',
    `/bases/${fx.baseId}/principals`,
  );
  fx.sales1 = principals.items.find((item) => item.email === users.sales1)?.principal_id ?? '';
  expect(fx.orders && fx.salesRole && fx.sales1, 'demo fixture').toBeTruthy();
  // One audited change by u_admin so both audit viewers have a recent row.
  await ok(page, 'PATCH', `/bases/${fx.baseId}/roles/${fx.spareRole}`, {
    name: `QA T720 ${RUN} (renamed)`,
  });
  await context.close();
});

test.afterAll(async ({ browser }) => {
  const { context, page } = await openAs(browser, users.admin);
  await api(page, 'DELETE', `/bases/${fx.baseId}/roles/${fx.spareRole}`);
  const mine = await ok<{ items: { id: string; name: string; revoked_at: string | null }[] }>(
    page,
    'GET',
    `/orgs/${fx.orgId}/me/api-tokens`,
  );
  for (const token of mine.items) {
    if (token.name.startsWith('QA T720') && token.revoked_at === null) {
      await api(page, 'DELETE', `/api-tokens/${token.id}`);
    }
  }
  await context.close();
});

for (const variant of VARIANTS) {
  test(`every S6 screen, ${variant.name}: axe, no horizontal scroll, no CSP violation`, async ({
    browser,
  }) => {
    test.setTimeout(300_000);
    const { context, page } = await openAs(browser, users.admin, variant);
    const csp = collectCspViolations(page);
    const tag = (screen: string) => `t720 ${variant.name} ${screen}`;
    const base = (path = '') => `/b/${fx.baseId}/settings${path}`;
    const org = (path = '') => `/o/${fx.orgSlug}/settings${path}`;

    // Base settings: index, members, access panel of u_sales1.
    await page.goto(base());
    await expect(page.getByTestId('base-settings-entries')).toBeVisible();
    await audit(page, tag('base settings index'));
    await page.goto(base('/members'));
    const salesRow = page
      .getByTestId(variant.viewport.width < 768 ? 'member-cards' : 'member-table')
      .getByText(SALES1_NAME)
      .first();
    await expect(salesRow).toBeVisible();
    await audit(page, tag('members'));
    await page
      .getByRole('button', {
        name:
          variant.language === 'vi'
            ? `Xem quyền của ${SALES1_NAME}`
            : `View the access of ${SALES1_NAME}`,
      })
      .first()
      .click();
    const panel = page.getByTestId('access-panel');
    await expect(panel.getByTestId('access-source')).toBeVisible();
    await expect(panel.getByTestId('access-table').first()).toBeVisible();
    await audit(page, tag('member access panel'));
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);

    // Roles: list, delete confirmation of a custom role (cancelled), editor, table detail.
    await page.goto(base('/roles'));
    const spare = page.getByTestId(`role-delete-${fx.spareRole}`).first();
    await expect(spare).toBeVisible();
    await audit(page, tag('roles'));
    await spare.click();
    const confirm = page.getByTestId('role-delete');
    await expect(confirm).toBeVisible();
    await audit(page, tag('role delete confirmation'));
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    await page.goto(base(`/roles/${fx.salesRole}`));
    await expect(page.getByTestId('role-editor')).toBeVisible();
    await expect(
      page.getByTestId(variant.viewport.width < 768 ? 'table-cards' : 'table-matrix'),
    ).toBeVisible();
    await audit(page, tag('role editor'));
    await noTruncatedLevels(page, tag('role editor'));
    await page.goto(base(`/roles/${fx.salesRole}?table=${fx.orders}`));
    await expect(page.getByTestId('table-detail')).toBeVisible();
    await expect(page.getByTestId('field-grid')).toBeVisible();
    await audit(page, tag('role editor Orders detail'));
    await noTruncatedLevels(page, tag('role editor Orders detail'));
    // The labels fit without the field grid scrolling sideways in its frame either.
    const frame = await page.getByTestId('field-grid').evaluate((table) => ({
      scroll: table.parentElement?.scrollWidth ?? 0,
      width: table.parentElement?.clientWidth ?? 0,
    }));
    expect(frame.scroll, 'field grid scrolls sideways').toBeLessThanOrEqual(frame.width);

    // Base audit viewer and its drawer.
    await page.goto(base('/audit'));
    const rows = page.getByTestId('audit-row');
    await expect(rows.first()).toBeVisible();
    await audit(page, tag('base audit'));
    // The time (table) or the whole card (375 px) opens the details.
    await rows.first().locator('[data-audit-open]').click();
    await expect(page.getByTestId('audit-drawer')).toBeVisible();
    await audit(page, tag('base audit drawer'));
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('audit-drawer')).toHaveCount(0);

    // Organization audit viewer.
    await page.goto(org('/audit'));
    await expect(page.getByTestId('audit-row').first()).toBeVisible();
    await audit(page, tag('org audit'));

    // API tokens: mine, organization, policy; create → shown once; revoke confirmation.
    await page.goto(org('/api-tokens'));
    await expect(page.getByTestId('my-tokens')).toBeVisible();
    await audit(page, tag('my tokens'));
    await page.getByTestId('token-create').click();
    const form = page.getByTestId('token-create-form');
    await expect(form).toBeVisible();
    await audit(page, tag('create token dialog'));
    // The "Access" legend sits above its hint (T720: they overlapped).
    const legend = await form.locator('legend').first().boundingBox();
    const hint = await form.locator('legend + p').first().boundingBox();
    expect(
      legend !== null && hint !== null && legend.y + legend.height <= hint.y + 0.5,
      'legend above hint',
    ).toBe(true);
    await form.getByTestId('token-name-input').fill(`QA T720 ${RUN} ${variant.name}`);
    await page.getByTestId('token-create-submit').click();
    const reveal = page.getByTestId('token-reveal');
    await expect(reveal.getByTestId('token-value')).toBeVisible();
    const value = await reveal.getByTestId('token-value').inputValue();
    expect(value).toMatch(/^cht_[A-Za-z0-9]{36}$/u);
    // Never in the address bar or the history (the dialog is client state only).
    expect(page.url()).not.toContain(value);
    await audit(page, tag('token shown once'));
    await reveal.getByTestId('token-reveal-confirm').check();
    await page.getByTestId('token-reveal-done').click();
    await expect(reveal).toHaveCount(0);
    const created = page
      .getByTestId('token-row')
      .filter({ hasText: `QA T720 ${RUN} ${variant.name}` });
    await created.getByTestId('token-revoke').click();
    await expect(page.getByTestId('token-revoke-dialog')).toBeVisible();
    await audit(page, tag('token revoke confirmation'));
    await page.getByTestId('token-revoke-confirm').click();
    await expect(page.getByTestId('token-revoke-dialog')).toHaveCount(0);
    await page.goto(org('/api-tokens?tab=all'));
    await expect(page.getByTestId('org-tokens')).toBeVisible();
    await audit(page, tag('org tokens'));
    await page.goto(org('/api-tokens?tab=policy'));
    await expect(page.getByTestId('token-policy')).toBeVisible();
    await audit(page, tag('token policy'));

    // Integrations: HTTP secrets with allowed hosts.
    await page.goto(org('/integrations'));
    await expect(page.getByTestId('http-secrets-section')).toBeVisible();
    await expect(page.getByTestId('http-secret-row').first()).toBeVisible();
    await audit(page, tag('integrations secret hosts'));

    // Account: connected accounts.
    await page.goto('/account/connections');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await audit(page, tag('connected accounts'));
    expect(csp).toEqual([]);
    await context.close();

    // Signed out: the sign-in page with its providers, and an OIDC error.
    const signedOut = await openAs(browser, null, variant);
    const outCsp = collectCspViolations(signedOut.page);
    await signedOut.page.goto('/login');
    await expect(
      signedOut.page.getByRole('link', { name: new RegExp(FAKE_OIDC_NAME, 'u') }),
    ).toBeVisible();
    await audit(signedOut.page, tag('login with SSO'));
    await signedOut.page.goto('/login?error=OIDC_EMAIL_UNVERIFIED');
    await expect(signedOut.page.getByTestId('login-sso-error')).toBeVisible();
    await audit(signedOut.page, tag('login OIDC error'));
    expect(outCsp).toEqual([]);
    await signedOut.context.close();
  });
}

test('the roles: every base-admin and org-admin S6 page is "not found"; My tokens stays theirs', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  for (const email of [users.editor, users.reader, users.sales1, users.out]) {
    const { context, page } = await openAs(browser, email);
    for (const path of [
      `/b/${fx.baseId}/settings/members`,
      `/b/${fx.baseId}/settings/roles`,
      `/b/${fx.baseId}/settings/roles/${fx.salesRole}`,
      `/b/${fx.baseId}/settings/audit`,
      `/o/${fx.orgSlug}/settings/audit`,
      `/o/${fx.orgSlug}/settings/integrations`,
    ]) {
      await page.goto(path);
      await expect(notFound(page), `${email} at ${path}`).toBeVisible();
    }
    await audit(page, `t720 not found ${email.split('@')[0] ?? ''}`);
    // The API agrees (no 403 that would confirm a base the caller cannot read).
    for (const path of [
      `/bases/${fx.baseId}/audit-logs`,
      `/orgs/${fx.orgId}/audit-logs`,
      `/bases/${fx.baseId}/members/${fx.sales1}/access`,
    ]) {
      const answer = await api(page, 'GET', path);
      // C§5 P61: a base reader who is not admin gets 403 on the access panel; u_out
      // (cannot read the base) 404; the audit viewers are 404 for every non-admin.
      const expected = path.includes('audit-logs') || email === users.out ? 404 : 403;
      expect(answer.status, `${email} GET ${path}`).toBe(expected);
    }
    const org = await api(page, 'GET', `/orgs/${fx.orgId}/api-tokens`);
    expect(org.status, `${email} org token list`).toBe(403);
    // Their own tokens page opens, without the organization tab.
    await page.goto(`/o/${fx.orgSlug}/settings/api-tokens`);
    await expect(page.getByTestId('my-tokens')).toBeVisible();
    await expect(page.getByTestId('api-tokens-tab-all')).toHaveCount(0);
    await expect(page.getByTestId('api-tokens-tab-policy')).toHaveCount(0);
    // Asking for the admin tabs by URL falls back to "My tokens".
    for (const tab of ['all', 'policy']) {
      await page.goto(`/o/${fx.orgSlug}/settings/api-tokens?tab=${tab}`);
      await expect(page.getByTestId('my-tokens')).toBeVisible();
      await expect(page.getByTestId('org-tokens')).toHaveCount(0);
      await expect(page.getByTestId('token-policy')).toHaveCount(0);
    }
    await context.close();
  }
});

test('the page that shows a token once keeps it out of Referer and URLs', async ({ browser }) => {
  const { context, page } = await openAs(browser, users.admin);
  const response = await page.goto(`/o/${fx.orgSlug}/settings/api-tokens`);
  const policy = response?.headers()['referrer-policy'] ?? '';
  expect([
    'no-referrer',
    'same-origin',
    'strict-origin',
    'strict-origin-when-cross-origin',
  ]).toContain(policy);
  await page.getByTestId('token-create').click();
  await page.getByTestId('token-name-input').fill(`QA T720 ${RUN} referer`);
  await page.getByTestId('token-create-submit').click();
  const value = await page.getByTestId('token-value').inputValue();
  expect(value).toMatch(/^cht_/u);
  // The curl example quotes it in a header, never in a query string.
  const curl = await page.getByTestId('token-curl').inputValue();
  expect(curl).toContain('Authorization: Bearer');
  expect(curl).not.toMatch(/[?&][a-z_]*token=/iu);
  // A token in a query string is not a credential (Bearer header only).
  const asQuery = await page.evaluate(async (token) => {
    const answer = await fetch(`/api/v1/me?access_token=${encodeURIComponent(token)}`, {
      credentials: 'omit',
    });
    return answer.status;
  }, value);
  expect(asQuery).toBe(401);
  await page.getByTestId('token-reveal-confirm').check();
  await page.getByTestId('token-reveal-done').click();
  await context.close();
});
