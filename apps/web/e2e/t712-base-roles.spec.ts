import { type Browser, type BrowserContext, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { DEMO_PASSWORD } from './seed';
import { api, apiSignIn, collectCspViolations, expectNoSeriousA11yViolations, ok } from './support';

/**
 * T712: base settings (FRONTEND §17) on the demo data of CONTRACTS §9 —
 * the "Base settings" layout, the roles page and the members page:
 *
 * - u_admin creates the role "Kho" (its config is set through the API: the
 *   permissions editor is T713) and gives it to u_reader; u_reader's open tab
 *   shows the base by the new role after `permission.changed` (no reload),
 *   and a second tab of u_admin on the members page shows the new role too;
 * - renaming "Kho" to a taken name ("sales", case-insensitive) → inline error;
 * - deleting "Kho" while assigned → the list of who holds it;
 * - the group "Sales" gets a role with the keyboard; "No role" asks first
 *   (`alertdialog`), confirmed with the keyboard;
 * - u_editor opening `/b/B/settings/roles` gets the 404 screen;
 * - axe on every state; Vietnamese at 375 px: cards, no horizontal scroll.
 *
 * The demo data is shared with other specs: `afterAll` gives u_reader back
 * the Reader role and the group Sales back the Sales role, and deletes "Kho".
 */

const READER_EMAIL = WORKER_ORG.email('reader');
const EDITOR_EMAIL = WORKER_ORG.email('editor');
const READER_NAME = 'Lê Quốc Bảo';
const ROLE = 'Kho';

interface Demo {
  baseId: string;
  baseName: string;
  customers: string;
  readerId: string;
  salesGroupId: string;
  readerRoleId: string;
  salesRoleId: string;
}

interface RoleRow {
  id: string;
  name: string;
  kind: string;
}

type Cookies = Awaited<ReturnType<BrowserContext['cookies']>>;
const cookies: Record<string, Cookies> = {};

/**
 * A new context signed in as `email` (sign-in once per user and spec: the
 * login endpoint allows 20 a minute per IP for the whole suite).
 */
async function openAs(
  browser: Browser,
  email: string,
  options: { viewport?: { width: number; height: number }; language?: 'en' | 'vi' } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1440, height: 900 },
    locale: 'en-US',
  });
  const language = options.language ?? 'en';
  await context.addInitScript((value) => {
    window.localStorage.setItem('cellhive.language', value);
  }, language);
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
  const me = await ok<{ orgs: { id: string }[] }>(page, 'GET', '/me');
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
      const roles = await ok<{ items: RoleRow[] }>(page, 'GET', `/bases/${base.id}/roles`);
      const principals = await ok<{
        items: {
          principal_type: string;
          principal_id: string;
          name: string;
          email: string | null;
        }[];
      }>(page, 'GET', `/bases/${base.id}/principals?limit=200`);
      return {
        baseId: base.id,
        baseName: base.name,
        customers: tables.items.find((table) => table.name === 'Customers')?.id ?? '',
        readerId: principals.items.find((item) => item.email === READER_EMAIL)?.principal_id ?? '',
        salesGroupId:
          principals.items.find((item) => item.principal_type === 'group' && item.name === 'Sales')
            ?.principal_id ?? '',
        readerRoleId: roles.items.find((role) => role.kind === 'system_reader')?.id ?? '',
        salesRoleId:
          roles.items.find((role) => role.kind === 'custom' && role.name === 'Sales')?.id ?? '',
      };
    }
  }
  throw new Error('The demo base is missing.');
}

/** Puts the demo assignments back and deletes "Kho" (also left over by an earlier run). */
async function restore(page: Page, demo: Demo): Promise<void> {
  await ok(page, 'PUT', `/bases/${demo.baseId}/role-assignments`, {
    principal_type: 'user',
    principal_id: demo.readerId,
    role_id: demo.readerRoleId,
  });
  await ok(page, 'PUT', `/bases/${demo.baseId}/role-assignments`, {
    principal_type: 'group',
    principal_id: demo.salesGroupId,
    role_id: demo.salesRoleId,
  });
  const roles = await ok<{ items: RoleRow[] }>(page, 'GET', `/bases/${demo.baseId}/roles`);
  for (const role of roles.items.filter((item) => item.name.toLowerCase().startsWith('kho'))) {
    await ok(page, 'DELETE', `/bases/${demo.baseId}/roles/${role.id}`);
  }
}

function tablesNav(page: Page) {
  return page.getByRole('navigation', { name: 'Tables' });
}

function noHorizontalScroll(page: Page, width: number) {
  return expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(width);
}

test.describe.configure({ mode: 'serial' });

let demo: Demo;
const kho = { id: '' };

test.beforeAll(async ({ browser }) => {
  const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
  demo = await findDemo(page);
  await restore(page, demo);
  await context.close();
});

test.afterAll(async ({ browser }) => {
  const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
  await restore(page, demo);
  await context.close();
});

test('u_admin creates "Kho" and gives it to u_reader; other tabs follow permission.changed', async ({
  browser,
}) => {
  const admin = await openAs(browser, WORKER_ORG.email('admin'));
  const csp = collectCspViolations(admin.page);
  const reader = await openAs(browser, READER_EMAIL);
  // u_reader has the Reader role: every table of the base.
  await reader.page.goto(`/b/${demo.baseId}/t/${demo.customers}`);
  await expect(tablesNav(reader.page).getByRole('link', { name: /^Tickets/u })).toBeVisible();
  await expect(tablesNav(reader.page).getByRole('link', { name: /^Customers/u })).toBeVisible();

  // The entry: "Base settings" in the sidebar → General → Roles.
  await admin.page.goto(`/b/${demo.baseId}/t/${demo.customers}`);
  await admin.page.getByTestId('base-settings-link').click();
  await expect(admin.page).toHaveURL(new RegExp(`/b/${demo.baseId}/settings$`, 'u'));
  const nav = admin.page.getByRole('navigation', { name: 'Base settings' });
  await expect(nav.getByRole('link', { name: 'General' })).toHaveAttribute('aria-current', 'page');
  await expectNoSeriousA11yViolations(admin.page, 'base settings: general');
  await nav.getByRole('link', { name: 'Roles' }).click();
  await expect(admin.page).toHaveURL(new RegExp(`/b/${demo.baseId}/settings/roles$`, 'u'));
  const rows = admin.page.getByTestId('role-row');
  await expect(rows.first()).toContainText('Admin');
  await expect(rows.first()).toContainText('Built-in');
  await expect(admin.page.getByTestId('role-table')).toContainText('Sales');
  await expectNoSeriousA11yViolations(admin.page, 'roles page');

  // Create "Kho" (keyboard: the dialog starts in the name input, Enter submits).
  await admin.page.getByTestId('role-create').click();
  const dialog = admin.page.getByRole('dialog', { name: 'New role' });
  await expect(dialog.getByLabel('Name')).toBeFocused();
  await expectNoSeriousA11yViolations(admin.page, 'new role dialog');
  await admin.page.keyboard.type(ROLE);
  await admin.page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(admin.page.getByText(`Role “${ROLE}” created.`)).toBeVisible();
  const created = rows.filter({ hasText: ROLE });
  await expect(created).toBeFocused();
  await expect(created).toContainText('Not assigned');
  kho.id = (await created.getAttribute('data-role-id')) ?? '';
  expect(kho.id).toMatch(/^rol_/u);
  // The permissions editor is T713: "Kho" reads Customers only.
  await ok(admin.page, 'PATCH', `/bases/${demo.baseId}/roles/${kho.id}`, {
    config: { tables: { [demo.customers]: { perm: 'read_only' } } },
  });

  // A second admin tab on the members page.
  const watcher = await admin.context.newPage();
  await watcher.goto(`/b/${demo.baseId}/settings/members`);
  const watched = watcher.getByRole('combobox', { name: `Role of ${READER_NAME}` });
  await expect(watched).toHaveValue(demo.readerRoleId);

  await nav.getByRole('link', { name: 'Members' }).click();
  await expect(admin.page.getByTestId('members-rules')).toContainText(
    'A role given to a person directly wins over the roles of their groups.',
  );
  await expect(admin.page.getByText('Full access · organization owner').first()).toBeVisible();
  await expectNoSeriousA11yViolations(admin.page, 'members page');
  const select = admin.page.getByRole('combobox', { name: `Role of ${READER_NAME}` });
  await select.selectOption({ label: ROLE });
  await expect(admin.page.getByText(`${READER_NAME} now has the role ${ROLE}.`)).toBeVisible();
  await expect(select).toHaveValue(kho.id);

  // u_reader's tab: only Customers now, without a reload.
  await expect(tablesNav(reader.page).getByRole('link', { name: /^Tickets/u })).toHaveCount(0, {
    timeout: 10_000,
  });
  await expect(tablesNav(reader.page).getByRole('link', { name: /^Customers/u })).toBeVisible();
  // The other admin tab refetched the members on permission.changed.
  await expect(watched).toHaveValue(kho.id, { timeout: 10_000 });
  expect(csp).toEqual([]);
  await reader.context.close();
  await admin.context.close();
});

test('renaming to a taken name is an inline error; a role still assigned lists its holders', async ({
  browser,
}) => {
  const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
  await page.goto(`/b/${demo.baseId}/settings/roles`);
  await page.getByRole('button', { name: `Rename ${ROLE}` }).click();
  const dialog = page.getByRole('dialog', { name: 'Rename role' });
  const input = dialog.getByLabel('Name');
  await expect(input).toHaveValue(ROLE);
  await input.fill('sales');
  await input.press('Enter');
  await expect(dialog.getByText('A role of this base already has this name.')).toBeVisible();
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await expectNoSeriousA11yViolations(page, 'rename: name taken');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  await page.getByRole('button', { name: `Delete ${ROLE}` }).click();
  const inUse = page.getByRole('alertdialog', { name: `“${ROLE}” is still assigned` });
  await expect(inUse.getByTestId('role-in-use-list')).toContainText(READER_NAME);
  await expect(inUse.getByRole('button', { name: 'Delete role' })).toHaveCount(0);
  await expectNoSeriousA11yViolations(page, 'delete: role in use');
  // The server agrees: still assigned.
  const refused = await api(page, 'DELETE', `/bases/${demo.baseId}/roles/${kho.id}`);
  expect(refused.status).toBe(422);
  expect(JSON.stringify(refused.body)).toContain('ROLE_IN_USE');
  await page.keyboard.press('Escape');
  await context.close();
});

test('the group Sales gets a role with the keyboard; "No role" is confirmed first', async ({
  browser,
}) => {
  const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
  await page.goto(`/b/${demo.baseId}/settings/members`);
  // Group: from Sales to Kho, the select reached and changed with the keyboard.
  const search = page.getByLabel('Search people and groups');
  await search.fill('Sales');
  const group = page.getByRole('combobox', { name: 'Role of Sales' });
  await expect(group).toHaveValue(demo.salesRoleId);
  await expect(page.getByTestId('member-row').filter({ hasText: 'Group' })).toHaveCount(1);
  // `q` also matches the emails of u_sales1/u_sales2: Tab through the rows (role select and,
  // T713, "View access" of each person) to the group's select.
  await search.focus();
  for (let step = 0; step < 10; step += 1) {
    await page.keyboard.press('Tab');
    if (await group.evaluate((element) => element === document.activeElement)) break;
  }
  await expect(group).toBeFocused();
  // Type-ahead on the focused (closed) native select picks "Kho".
  await page.keyboard.type('Kho');
  await expect(page.getByText(`Sales now has the role ${ROLE}.`)).toBeVisible();
  await expect(group).toHaveValue(kho.id);
  await expect(group).toBeFocused();
  const assignment = await ok<{ items: { principal_id: string; role_id: string | null }[] }>(
    page,
    'GET',
    `/bases/${demo.baseId}/principals?q=Sales`,
  );
  expect(assignment.items.find((item) => item.principal_id === demo.salesGroupId)?.role_id).toBe(
    kho.id,
  );

  // u_reader: "No role" → alertdialog → confirmed with the keyboard.
  await search.fill(READER_NAME);
  const reader = page.getByRole('combobox', { name: `Role of ${READER_NAME}` });
  await expect(reader).toHaveValue(kho.id);
  await reader.focus();
  await reader.selectOption({ label: 'No role' });
  const confirm = page.getByRole('alertdialog', { name: `Remove the access of ${READER_NAME}?` });
  await expect(confirm).toContainText(`${READER_NAME} can no longer open ${demo.baseName}`);
  await expectNoSeriousA11yViolations(page, 'remove access: alertdialog');
  // Escape cancels: nothing changes.
  await page.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await expect(reader).toHaveValue(kho.id);
  // The focus is back on the select (WCAG 2.4.3), after a cancel as after a confirmation.
  await expect(reader).toBeFocused();
  await reader.selectOption({ label: 'No role' });
  const button = confirm.getByRole('button', { name: 'Remove access' });
  for (let step = 0; step < 5; step += 1) {
    if (await button.evaluate((element) => element === document.activeElement)) break;
    await page.keyboard.press('Tab');
  }
  await expect(button).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByText(`${READER_NAME} no longer has a role in this base.`)).toBeVisible();
  await expect(reader).toHaveValue('');
  await expect(reader).toBeFocused();
  await context.close();
});

test('u_editor gets the 404 screen for the base settings', async ({ browser }) => {
  const { context, page } = await openAs(browser, EDITOR_EMAIL);
  await page.goto(`/b/${demo.baseId}/t/${demo.customers}`);
  await expect(tablesNav(page)).toBeVisible();
  await expect(page.getByTestId('base-settings-link')).toHaveCount(0);
  await page.goto(`/b/${demo.baseId}/settings/roles`);
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Base settings' })).toHaveCount(0);
  await expect(page.getByTestId('role-row')).toHaveCount(0);
  // The API: a member of the base who is not an admin sees it but may not manage roles.
  expect((await api(page, 'GET', `/bases/${demo.baseId}/roles`)).status).toBe(403);
  await expectNoSeriousA11yViolations(page, '404 for u_editor');
  await context.close();
});

test('Vietnamese at 375 px: the tables become cards, no horizontal scroll', async ({ browser }) => {
  const { context, page } = await openAs(browser, WORKER_ORG.email('admin'), {
    viewport: { width: 375, height: 812 },
    language: 'vi',
  });
  await page.goto(`/b/${demo.baseId}/settings/roles`);
  await expect(page.getByRole('heading', { name: 'Vai trò', level: 1 })).toBeVisible();
  const cards = page.getByRole('list', { name: 'Vai trò của base' });
  await expect(cards).toBeVisible();
  await expect(page.getByTestId('role-table')).toHaveCount(0);
  await expect(cards.getByTestId('role-row').first()).toContainText('Quản trị');
  await expect(cards.getByTestId('role-row').first()).toContainText('Có sẵn');
  await noHorizontalScroll(page, 375);
  await expectNoSeriousA11yViolations(page, 'roles at 375 px (vi)');
  const rename = page.getByRole('button', { name: `Đổi tên ${ROLE}` });
  expect((await rename.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);

  await page
    .getByRole('navigation', { name: 'Cài đặt base' })
    .getByRole('link', { name: 'Thành viên' })
    .click();
  const members = page.getByRole('list', { name: 'Người và nhóm cùng vai trò' });
  await expect(members).toBeVisible();
  await expect(page.getByTestId('member-table')).toHaveCount(0);
  await expect(page.getByTestId('members-rules')).toContainText(
    'Vai trò gán trực tiếp cho một người thắng vai trò của các nhóm người đó thuộc.',
  );
  await expect(page.getByRole('combobox', { name: 'Vai trò của Sales' })).toBeVisible();
  await noHorizontalScroll(page, 375);
  await expectNoSeriousA11yViolations(page, 'members at 375 px (vi)');
  await page.getByRole('combobox', { name: 'Vai trò của Sales' }).selectOption({
    label: 'Không có vai trò',
  });
  const confirm = page.getByRole('alertdialog', { name: 'Gỡ quyền của Sales?' });
  await expect(confirm).toBeVisible();
  await noHorizontalScroll(page, 375);
  await expectNoSeriousA11yViolations(page, 'remove access at 375 px (vi)');
  await confirm.getByRole('button', { name: 'Huỷ' }).click();
  await expect(confirm).toHaveCount(0);
  await context.close();
});
