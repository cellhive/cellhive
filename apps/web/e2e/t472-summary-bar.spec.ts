import { type Browser, type BrowserContext, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { apiSignIn, expectNoSeriousA11yViolations, ok, signInFirstAdmin } from './support';

/**
 * T472: the summary bar under the grid and the summaries of group headers
 * (board "S4b · Thanh thống kê"). Self-contained: the first administrator,
 * a base of its own and an editor. The admin sets `Sum` on the amount
 * column (a temporary change), the search narrows it, a write from another
 * tab updates it in under 2 s, "Save" shares it with the editor; the group
 * headers get their own summaries; axe; 375 px (bottom sheet).
 */
const ADMIN = {
  name: 'Nguyễn Văn Ánh',
  email: WORKER_ORG.ownerEmail,
  password: 'E2E-Setup-Password-2026',
};
const RUN = String(Date.now());
const EDITOR = {
  name: 'Trần Thu Hà',
  email: `editor-t472-${RUN}@cellhive.test`,
  password: 'E2E-editor-Password-2026',
};

/** Name, status, amount. */
const ROWS: [string, string, number][] = [
  ['Cửa hàng An Phát', 'Mới', 300],
  ['An Phú', 'Mới', 100],
  ['Bình Minh', 'Xong', 200],
  ['Cao Nguyên', 'Mới', 350],
  ['Đông Á', 'Xong', 500],
  ['Hải Vân', 'Mới', 400],
];

type Session = Awaited<ReturnType<BrowserContext['storageState']>>;
const sessions = new Map<string, Session>();

async function openAs(
  browser: Browser,
  person: { email: string; password: string },
  viewport = { width: 1600, height: 900 },
): Promise<Page> {
  const saved = sessions.get(person.email);
  const context = await browser.newContext({
    viewport,
    ...(saved === undefined ? {} : { storageState: saved }),
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.localStorage.setItem('cellhive.language', 'en');
  });
  await page.goto('/login');
  if (saved === undefined) {
    await apiSignIn(page, person.email, person.password);
    sessions.set(person.email, await context.storageState());
  }
  return page;
}

test.describe('T472 summary bar', () => {
  test.describe.configure({ mode: 'serial' });

  let admin: Page | undefined;
  const adminPage = (): Page => {
    if (admin === undefined) throw new Error('the set-up did not sign the admin in');
    return admin;
  };
  const ids = { baseId: '', tableId: '', viewId: '', amountId: '', statusId: '' };
  const viewPath = () => `/b/${ids.baseId}/t/${ids.tableId}/v/${ids.viewId}`;
  const amountCell = (page: Page) => page.getByTestId(`summary-cell-${ids.amountId}`);
  const count = (page: Page) =>
    page.getByRole('status').filter({ hasText: /records?( · \d+ groups?)?$/u });

  async function openView(page: Page, records: number, suffix = ''): Promise<void> {
    await page.goto(viewPath());
    await expect(count(page)).toHaveText(`${String(records)} records${suffix}`);
  }

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    const page = await browser.newPage();
    await page.goto('/login');
    await page.addInitScript(() => {
      window.localStorage.setItem('cellhive.language', 'en');
    });
    // T470: whichever spec (or the demo seed) set the stack up before this one.
    await signInFirstAdmin(page, ADMIN);
    sessions.set(ADMIN.email, await page.context().storageState());
    admin = page;
    const me = await ok<{ orgs: { id: string }[] }>(page, 'GET', '/me');
    const orgId = me.orgs[0]?.id ?? '';
    const workspace = await ok<{ id: string }>(page, 'POST', `/orgs/${orgId}/workspaces`, {
      name: `Summary E2E ${RUN}`,
    });
    const base = await ok<{ id: string }>(page, 'POST', `/workspaces/${workspace.id}/bases`, {
      name: 'Bán hàng T472',
    });
    ids.baseId = base.id;
    const table = await ok<{ id: string }>(page, 'POST', `/bases/${base.id}/tables`, {
      name: 'Đơn hàng',
    });
    ids.tableId = table.id;
    ids.statusId = (
      await ok<{ id: string }>(page, 'POST', `/tables/${table.id}/fields`, {
        name: 'Trạng thái',
        type: 'select',
        options: { options: [{ name: 'Mới' }, { name: 'Xong' }] },
      })
    ).id;
    ids.amountId = (
      await ok<{ id: string }>(page, 'POST', `/tables/${table.id}/fields`, {
        name: 'Số tiền',
        type: 'number',
      })
    ).id;
    await ok(page, 'POST', `/tables/${table.id}/records?field_key_type=name`, {
      records: ROWS.map(([name, status, amount]) => ({
        fields: { Name: name, 'Trạng thái': status, 'Số tiền': amount },
      })),
    });
    const views = await ok<{ items: { id: string }[] }>(page, 'GET', `/tables/${table.id}/views`);
    ids.viewId = views.items[0]?.id ?? '';

    const roles = await ok<{ items: { id: string; kind: string }[] }>(
      page,
      'GET',
      `/bases/${base.id}/roles`,
    );
    const invitation = await ok<{ invite_url: string }>(
      page,
      'POST',
      `/orgs/${orgId}/invitations`,
      {
        email: EDITOR.email,
        role: 'member',
      },
    );
    const token = new URL(invitation.invite_url).pathname.split('/').pop() ?? '';
    const guest = await browser.newContext();
    const guestPage = await guest.newPage();
    await guestPage.goto('/login');
    const accepted = await ok<{ user: { id: string } }>(
      guestPage,
      'POST',
      `/invitations/${token}/accept`,
      { display_name: EDITOR.name, password: EDITOR.password },
    );
    await guest.close();
    await ok(page, 'PUT', `/bases/${base.id}/role-assignments`, {
      principal_type: 'user',
      principal_id: accepted.user.id,
      role_id: roles.items.find((role) => role.kind === 'system_editor')?.id,
    });
  });

  test.afterAll(async () => {
    await admin?.close();
  });

  test('Sum on the amount column; search narrows it; another tab updates it in < 2 s; Save shares it', async ({
    browser,
  }) => {
    const page = await openAs(browser, ADMIN);
    await openView(page, 6);
    await expect(page.getByTestId('summary-count')).toHaveAccessibleName('6 records');
    await amountCell(page).click();
    const menu = page.getByRole('menu');
    // No preview values in the menu (S4b decision 8).
    await expect(menu.getByRole('menuitemradio', { name: 'Sum' })).toBeVisible();
    await expect(menu).not.toContainText('1850');
    await menu.getByRole('menuitemradio', { name: 'Sum' }).click();
    await expect(amountCell(page)).toHaveText('Sum1850');
    // A temporary change: the view's Save bar says so.
    const unsaved = page.getByRole('group', { name: 'Unsaved changes' });
    await expect(unsaved).toBeVisible();

    // The search narrows the records: the number follows.
    const search = page.getByRole('searchbox', { name: 'Search records' });
    await search.fill('An Ph');
    await expect(amountCell(page)).toHaveText('Sum400');
    await search.fill('');
    await expect(amountCell(page)).toHaveText('Sum1850');

    // Another tab (the API as the admin) changes a cell: the sum follows in < 2 s.
    const found = await ok<{ records: { id: string; fields: { Name?: string } }[] }>(
      adminPage(),
      'POST',
      `/tables/${ids.tableId}/records/query?field_key_type=name`,
      { search: 'Hải Vân', limit: 5 },
    );
    const target = found.records.find((record) => record.fields.Name === 'Hải Vân');
    await ok(
      adminPage(),
      'PATCH',
      `/tables/${ids.tableId}/records/${target?.id ?? ''}?field_key_type=name`,
      {
        fields: { 'Số tiền': 1400 },
      },
    );
    await expect(amountCell(page)).toHaveText('Sum2850', { timeout: 2_000 });

    // Save: the editor sees the saved summary.
    await unsaved.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(unsaved).toBeHidden();
    const editor = await openAs(browser, EDITOR);
    await openView(editor, 6);
    await expect(amountCell(editor)).toHaveText('Sum2850');
    await expectNoSeriousA11yViolations(page, 'grid with the summary bar');
    await editor.context().close();
    await page.context().close();
  });

  test('group headers carry the summaries of their group', async ({ browser }) => {
    await ok(adminPage(), 'PATCH', `/views/${ids.viewId}`, {
      config: { group: [{ field: ids.statusId, direction: 'asc' }] },
    });
    const page = await openAs(browser, ADMIN);
    const answered = page.waitForResponse(
      (response) =>
        response.url().includes('/records/summaries') && response.request().method() === 'POST',
    );
    await openView(page, 6, ' · 2 groups');
    const body = (await (await answered).json()) as {
      groups: { values: unknown[]; summaries: Record<string, { value: unknown }> }[];
    };
    expect(
      body.groups.map((group) => [group.values, group.summaries[ids.amountId]?.value]),
    ).toEqual([
      [['Mới'], 2150],
      [['Xong'], 700],
    ]);
    await expect(amountCell(page)).toHaveText('Sum2850');
    await ok(adminPage(), 'PATCH', `/views/${ids.viewId}`, { config: { group: [] } });
    await page.context().close();
  });

  test('375 px: a tap opens a bottom sheet; the page never scrolls sideways', async ({
    browser,
  }) => {
    const page = await openAs(browser, EDITOR, { width: 375, height: 812 });
    await openView(page, 6);
    const bar = page.getByTestId('summary-bar');
    await expect(bar).toBeVisible();
    await amountCell(page).click();
    const sheet = page.getByRole('dialog', { name: 'Summary of Số tiền' });
    await expect(sheet).toBeVisible();
    await sheet.getByRole('radio', { name: 'Average' }).click();
    await expect(amountCell(page)).toHaveText(/^Average/u);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await expectNoSeriousA11yViolations(page, 'summary bar at 375 px');
    await page.context().close();
  });
});
