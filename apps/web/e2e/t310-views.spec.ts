import { type Browser, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import {
  api,
  apiSignIn,
  collectCspViolations,
  expectNoSeriousA11yViolations,
  ok,
  signInFirstAdmin,
} from './support';

/**
 * T310: saved views in the web client. Self-contained like t207/t208: the
 * first administrator (created by t011 when it runs first, else here), its
 * own workspace/base/table, a reader and a "Sales" member whose role only
 * shows the Sales view.
 */
const ADMIN = {
  name: 'Nguyễn Văn Ánh',
  email: WORKER_ORG.ownerEmail,
  password: 'E2E-Setup-Password-2026',
};
const RUN = String(Date.now());
const READER = {
  name: 'Lê Thị Đọc',
  email: `reader-t310-${RUN}@cellhive.test`,
  password: 'E2E-Reader-Password-2026',
};
const SALES = {
  name: 'Phạm Văn Bán',
  email: `sales-t310-${RUN}@cellhive.test`,
  password: 'E2E-Sales-Password-2026',
};
const TABLE_NAME = 'Đơn hàng';

interface View {
  id: string;
  name: string;
  is_personal: boolean;
  locked: boolean;
  config: { hidden_fields: string[]; column_widths: Record<string, number> };
}

/** Signs in with the shared `apiSignIn` (waits out the per-IP limit). */
async function signIn(page: Page, email: string, password: string): Promise<void> {
  // This device picks English whatever the profile says.
  await page.addInitScript(() => {
    window.localStorage.setItem('cellhive.language', 'en');
  });
  await page.goto('/login');
  await apiSignIn(page, email, password);
}

/** A new signed-in page of its own browser context (a second tab of another device). */
async function openAs(browser: Browser, email: string, password: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();
  await signIn(page, email, password);
  return page;
}

/** The column headers of glide's accessibility table (the visible columns). */
function headers(page: Page) {
  return page.locator('table[role="grid"] th[role="columnheader"]');
}

function header(page: Page, name: string) {
  return headers(page).filter({ hasText: name });
}

function viewBar(page: Page) {
  return page.getByRole('navigation', { name: `Views of ${TABLE_NAME}` });
}

function unsaved(page: Page) {
  return page.getByRole('group', { name: 'Unsaved changes' });
}

async function viewOptions(page: Page, name: string) {
  await viewBar(page)
    .getByRole('button', { name: `Options of view ${name}` })
    .click();
  return page.getByRole('menu');
}

/** Hides or shows a field with its switch in the toolbar's "Hide fields" panel (T322b). */
async function toggleField(page: Page, name: string): Promise<void> {
  await page
    .getByRole('toolbar', { name: 'View options' })
    .getByRole('button', { name: /^(Hide fields|\d+ hidden fields?)$/u })
    .click();
  await page
    .getByRole('dialog', { name: 'Shown fields' })
    .getByRole('switch', { name: `Show ${name}` })
    .click();
  await page.keyboard.press('Escape');
}

test.describe('T310 saved views', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ viewport: { width: 1600, height: 900 } });

  const ids = {
    baseId: '',
    tableId: '',
    mainViewId: '',
    salesViewId: '',
    notesId: '',
    amountId: '',
  };
  const tablePath = () => `/b/${ids.baseId}/t/${ids.tableId}`;
  const viewPath = (viewId: string) => `${tablePath()}/v/${viewId}`;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto('/login');
    // Any order of the specs (T470/T527): set up, signed in, or invited by the demo admin.
    await signInFirstAdmin(page, ADMIN);
    const me = await ok<{ orgs: { id: string }[] }>(page, 'GET', '/me');
    const orgId = me.orgs[0]?.id ?? '';
    const workspace = await ok<{ id: string }>(page, 'POST', `/orgs/${orgId}/workspaces`, {
      name: 'Views E2E',
    });
    const base = await ok<{ id: string }>(page, 'POST', `/workspaces/${workspace.id}/bases`, {
      name: 'Bán hàng',
    });
    ids.baseId = base.id;
    const table = await ok<{ id: string }>(page, 'POST', `/bases/${base.id}/tables`, {
      name: TABLE_NAME,
    });
    ids.tableId = table.id;
    const notes = await ok<{ id: string }>(page, 'POST', `/tables/${table.id}/fields`, {
      name: 'Ghi chú',
      type: 'text',
    });
    const amount = await ok<{ id: string }>(page, 'POST', `/tables/${table.id}/fields`, {
      name: 'Số tiền',
      type: 'number',
    });
    ids.notesId = notes.id;
    ids.amountId = amount.id;
    await ok(page, 'POST', `/tables/${table.id}/records?field_key_type=name`, {
      records: ['Đơn 1', 'Đơn 2', 'Đơn 3'].map((name) => ({ fields: { Name: name } })),
    });
    const views = await ok<{ items: View[] }>(page, 'GET', `/tables/${table.id}/views`);
    ids.mainViewId = views.items[0]?.id ?? '';
    const sales = await ok<View>(page, 'POST', `/tables/${table.id}/views`, {
      name: 'Sales',
      type: 'grid',
    });
    ids.salesViewId = sales.id;

    // Members: a reader of the base, and a "Sales" role seeing only the Sales view.
    const roles = await ok<{ items: { id: string; kind: string }[] }>(
      page,
      'GET',
      `/bases/${base.id}/roles`,
    );
    const salesRole = await ok<{ id: string }>(page, 'POST', `/bases/${base.id}/roles`, {
      name: `Sales ${RUN}`,
      config: {
        tables: {
          [table.id]: {
            perm: 'read_only',
            view_rule: { allow_edit: false, visible_views: [sales.id] },
          },
        },
      },
    });
    for (const [member, roleId] of [
      [READER, roles.items.find((role) => role.kind === 'system_reader')?.id],
      [SALES, salesRole.id],
    ] as const) {
      const invitation = await ok<{ invite_url: string }>(
        page,
        'POST',
        `/orgs/${orgId}/invitations`,
        { email: member.email, role: 'member' },
      );
      const token = new URL(invitation.invite_url).pathname.split('/').pop() ?? '';
      const guest = await browser.newContext();
      const guestPage = await guest.newPage();
      await guestPage.goto('/login');
      const accepted = await ok<{ user: { id: string } }>(
        guestPage,
        'POST',
        `/invitations/${token}/accept`,
        { display_name: member.name, password: member.password },
      );
      await guest.close();
      await ok(page, 'PUT', `/bases/${base.id}/role-assignments`, {
        principal_type: 'user',
        principal_id: accepted.user.id,
        role_id: roleId,
      });
    }
    await page.close();
  });

  test('admin creates, renames, duplicates, reorders and deletes views', async ({ page }) => {
    const cspViolations = collectCspViolations(page);
    await signIn(page, ADMIN.email, ADMIN.password);
    await page.goto(tablePath());
    await expect(page).toHaveURL(new RegExp(`/v/${ids.mainViewId}$`, 'u'));
    await expect(viewBar(page).getByRole('link', { name: 'Grid view' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expectNoSeriousA11yViolations(page, 'view bar');

    await test.step('create a shared grid view: default name, opened', async () => {
      await viewBar(page).getByRole('button', { name: 'New view' }).click();
      await page.getByTestId('create-view-shared-grid').click();
      await expect(viewBar(page).getByRole('link', { name: 'Grid view 2' })).toHaveAttribute(
        'aria-current',
        'page',
      );
      await expect(page).toHaveTitle(/^Grid view 2 · Đơn hàng · Cellhive$/u);
    });

    await test.step('rename it', async () => {
      await (
        await viewOptions(page, 'Grid view 2')
      )
        .getByRole('menuitem', { name: 'Rename' })
        .click();
      const dialog = page.getByRole('dialog', { name: 'Rename view' });
      await expectNoSeriousA11yViolations(page, 'rename view dialog');
      await dialog.getByLabel('Name').fill('Theo tuần');
      await dialog.getByRole('button', { name: 'Rename' }).click();
      await expect(dialog).toBeHidden();
      await expect(viewBar(page).getByRole('link', { name: 'Theo tuần' })).toBeVisible();
    });

    await test.step('duplicate it: the copy opens', async () => {
      await (
        await viewOptions(page, 'Theo tuần')
      )
        .getByRole('menuitem', { name: 'Duplicate' })
        .click();
      await expect(viewBar(page).getByRole('link', { name: 'Theo tuần copy' })).toHaveAttribute(
        'aria-current',
        'page',
      );
    });

    await test.step('move the copy left (keyboard path of drag-and-drop), kept after reload', async () => {
      const shared = viewBar(page).getByRole('list', { name: 'Shared views' });
      await expect(shared.getByRole('link')).toHaveText([
        'Grid view',
        'Sales',
        'Theo tuần',
        'Theo tuần copy',
      ]);
      // Saved before reloading (a reload would abort the PATCH still in flight).
      const saved = page.waitForResponse(
        (response) =>
          response.request().method() === 'PATCH' && response.url().includes('/api/v1/views/'),
      );
      await (
        await viewOptions(page, 'Theo tuần copy')
      )
        .getByRole('menuitem', { name: 'Move left' })
        .click();
      expect((await saved).ok()).toBe(true);
      await expect(shared.getByRole('link')).toHaveText([
        'Grid view',
        'Sales',
        'Theo tuần copy',
        'Theo tuần',
      ]);
      await page.reload();
      await expect(shared.getByRole('link')).toHaveText([
        'Grid view',
        'Sales',
        'Theo tuần copy',
        'Theo tuần',
      ]);
    });

    await test.step('drag a tab to reorder', async () => {
      const shared = viewBar(page).getByRole('list', { name: 'Shared views' });
      const from = await shared.getByRole('link', { name: 'Theo tuần', exact: true }).boundingBox();
      const to = await shared.getByRole('link', { name: 'Sales' }).boundingBox();
      if (from === null || to === null) throw new Error('tabs not laid out');
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
      await page.mouse.down();
      await page.mouse.move(from.x + from.width / 2 - 10, from.y + from.height / 2, { steps: 3 });
      await page.mouse.move(to.x + 4, to.y + to.height / 2, { steps: 10 });
      await page.mouse.up();
      await expect(shared.getByRole('link')).toHaveText([
        'Grid view',
        'Theo tuần',
        'Sales',
        'Theo tuần copy',
      ]);
    });

    await test.step('delete the open view after confirming: another view opens', async () => {
      await page.goto(tablePath());
      await viewBar(page).getByRole('link', { name: 'Theo tuần copy' }).click();
      await (
        await viewOptions(page, 'Theo tuần copy')
      )
        .getByRole('menuitem', { name: 'Delete view' })
        .click();
      const dialog = page.getByRole('dialog', { name: 'Delete view Theo tuần copy?' });
      await expectNoSeriousA11yViolations(page, 'delete view dialog');
      await dialog.getByRole('button', { name: 'Delete view' }).click();
      await expect(page.getByText('View Theo tuần copy deleted.')).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/v/${ids.mainViewId}$`, 'u'));
      await expect(viewBar(page).getByRole('link', { name: 'Theo tuần copy' })).toHaveCount(0);
    });

    expect(cspViolations, 'Content-Security-Policy violations').toEqual([]);
  });

  test('layout is saved in the view: second tab live, reload and other users', async ({
    page,
    browser,
  }) => {
    await signIn(page, ADMIN.email, ADMIN.password);
    await page.goto(viewPath(ids.salesViewId));
    await expect(header(page, 'Số tiền')).toBeAttached();
    const second = await openAs(browser, ADMIN.email, ADMIN.password);
    await second.goto(viewPath(ids.salesViewId));
    await expect(header(second, 'Số tiền')).toBeAttached();

    await test.step('hide a column: the other tab follows without reloading', async () => {
      await toggleField(page, 'Số tiền');
      await expect(header(page, 'Số tiền')).toHaveCount(0);
      await expect(header(second, 'Số tiền')).toHaveCount(0, { timeout: 10_000 });
      await expect(unsaved(page)).toHaveCount(0);
    });

    await test.step('resize a column: saved into column_widths', async () => {
      const canvas = page.locator('.ob-grid [data-testid="data-grid-canvas"]');
      const box = await canvas.boundingBox();
      if (box === null) throw new Error('grid not laid out');
      // Row markers (40 px) + Name (240 px): the right edge of the primary column.
      const edge = box.x + 40 + 240 - 1;
      await page.mouse.move(edge, box.y + 18);
      await page.mouse.down();
      await page.mouse.move(edge + 60, box.y + 18, { steps: 6 });
      await page.mouse.up();
      const primary = await primaryFieldId(page);
      await expect
        .poll(
          async () =>
            Object.keys(
              (await ok<View>(page, 'GET', `/views/${ids.salesViewId}`)).config.column_widths,
            ),
          { timeout: 10_000 },
        )
        .toContain(primary);
    });

    await test.step('the layout stays after a reload and applies to other users', async () => {
      await page.reload();
      await expect(header(page, 'Name')).toBeAttached();
      await expect(header(page, 'Số tiền')).toHaveCount(0);
      const sales = await openAs(browser, SALES.email, SALES.password);
      await sales.goto(tablePath());
      await expect(sales).toHaveURL(new RegExp(`/v/${ids.salesViewId}$`, 'u'));
      await expect(header(sales, 'Name')).toBeAttached();
      await expect(header(sales, 'Số tiền')).toHaveCount(0);
      await sales.context().close();
    });

    await test.step('a view deleted in another tab: back to the default view with a notice', async () => {
      const doomed = await ok<View>(page, 'POST', `/tables/${ids.tableId}/views`, {
        name: 'Tạm thời',
        type: 'grid',
      });
      await second.goto(viewPath(doomed.id));
      await expect(viewBar(second).getByRole('link', { name: 'Tạm thời' })).toHaveAttribute(
        'aria-current',
        'page',
      );
      await ok(page, 'DELETE', `/views/${doomed.id}`);
      await expect(
        second.getByText(
          'The view you were looking at was deleted or is no longer available to you.',
        ),
      ).toBeVisible({ timeout: 10_000 });
      await expect(second).toHaveURL(new RegExp(`/v/${ids.mainViewId}$`, 'u'));
    });

    // Back to the saved default for the other tests.
    await ok(page, 'PATCH', `/views/${ids.salesViewId}`, {
      config: { hidden_fields: [], column_widths: {} },
    });
    await second.context().close();
  });

  test('a reader changes the layout on this device only and saves it as a personal view', async ({
    page,
  }) => {
    await signIn(page, READER.email, READER.password);
    await page.goto(viewPath(ids.mainViewId));
    await expect(header(page, 'Ghi chú')).toBeAttached();
    // No shared view actions for a reader.
    await viewBar(page).getByRole('button', { name: 'New view' }).click();
    await expect(page.getByTestId('create-view-shared-grid')).toHaveCount(0);
    await expect(page.getByTestId('create-view-personal-grid')).toBeVisible();
    await page.keyboard.press('Escape');

    await toggleField(page, 'Ghi chú');
    await expect(header(page, 'Ghi chú')).toHaveCount(0);
    await expect(unsaved(page)).toContainText('Unsaved changes');
    await expect(unsaved(page).getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
    await expectNoSeriousA11yViolations(page, 'unsaved changes');

    // Kept on this device across reloads, never sent to the shared view.
    await page.reload();
    await expect(header(page, 'Name')).toBeAttached();
    await expect(header(page, 'Ghi chú')).toHaveCount(0);
    await expect(unsaved(page)).toBeVisible();
    const shared = await ok<View>(page, 'GET', `/views/${ids.mainViewId}`);
    expect(shared.config.hidden_fields).toEqual([]);

    await unsaved(page).getByRole('button', { name: 'Save as personal view' }).click();
    await expect(page.getByText('Saved as personal view Grid view (personal).')).toBeVisible();
    const personal = viewBar(page).getByRole('list', { name: 'Personal views' });
    await expect(personal.getByRole('link', { name: /Grid view \(personal\)/u })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(personal.getByRole('img', { name: 'Personal view' })).toBeVisible();
    await expect(header(page, 'Ghi chú')).toHaveCount(0);
    await expect(unsaved(page)).toHaveCount(0);
    // The shared view is as it was.
    await viewBar(page).getByRole('link', { name: 'Grid view', exact: true }).click();
    await expect(header(page, 'Ghi chú')).toBeAttached();
  });

  test('Sales only sees its view: no shared actions, other views are 404', async ({ page }) => {
    await signIn(page, SALES.email, SALES.password);
    await page.goto(tablePath());
    await expect(page).toHaveURL(new RegExp(`/v/${ids.salesViewId}$`, 'u'));
    await expect(
      viewBar(page).getByRole('list', { name: 'Shared views' }).getByRole('link'),
    ).toHaveText(['Sales']);
    const menu = await viewOptions(page, 'Sales');
    await expect(menu.getByRole('menuitem')).toHaveText(['Duplicate as personal view']);
    await page.keyboard.press('Escape');
    await page.goto(viewPath(ids.mainViewId));
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  });

  test('a locked view keeps everybody’s changes on their device', async ({ page }) => {
    await signIn(page, ADMIN.email, ADMIN.password);
    await page.goto(viewPath(ids.salesViewId));
    await (await viewOptions(page, 'Sales')).getByRole('menuitem', { name: 'Lock view' }).click();
    await expect(viewBar(page).getByRole('img', { name: 'Locked view' })).toBeVisible();
    const menu = await viewOptions(page, 'Sales');
    await expect(
      menu.getByRole('menuitem', { name: 'Delete view (unlock it first)' }),
    ).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Escape');

    await toggleField(page, 'Ghi chú');
    await expect(header(page, 'Ghi chú')).toHaveCount(0);
    await expect(unsaved(page)).toContainText('Unsaved changes');
    await expect(unsaved(page).getByText('This view is locked.', { exact: false })).toBeAttached();
    const view = await ok<View>(page, 'GET', `/views/${ids.salesViewId}`);
    expect(view.config.hidden_fields).toEqual([]);
    // The API refuses config changes of a locked view too.
    const refused = await api(page, 'PATCH', `/views/${ids.salesViewId}`, {
      config: { hidden_fields: [ids.notesId] },
    });
    expect(refused.status).toBe(422);
    await unsaved(page).getByRole('button', { name: 'Discard' }).click();
    await expect(header(page, 'Ghi chú')).toBeAttached();
    await ok(page, 'PATCH', `/views/${ids.salesViewId}`, { locked: false });
  });

  test('the T207 device layout is moved into unsaved changes once', async ({ page }) => {
    await signIn(page, ADMIN.email, ADMIN.password);
    const key = `cellhive.gridLayout.${ids.tableId}`;
    await page.evaluate(
      ({ key, value }) => {
        window.localStorage.setItem(key, value);
      },
      { key, value: JSON.stringify({ hidden: [ids.amountId], frozen: 1, widths: {}, sort: null }) },
    );
    await page.goto(viewPath(ids.mainViewId));
    await expect(header(page, 'Name')).toBeAttached();
    await expect(header(page, 'Số tiền')).toHaveCount(0);
    expect(await page.evaluate((name) => window.localStorage.getItem(name), key)).toBeNull();
    await expect(unsaved(page)).toBeVisible();
    await unsaved(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(unsaved(page)).toHaveCount(0);
    const view = await ok<View>(page, 'GET', `/views/${ids.mainViewId}`);
    expect(view.config.hidden_fields).toEqual([ids.amountId]);
  });
});

async function primaryFieldId(page: Page): Promise<string> {
  const url = new URL(page.url());
  const tableId = url.pathname.split('/')[4] ?? '';
  const fields = await ok<{ items: { id: string; is_primary: boolean }[] }>(
    page,
    'GET',
    `/tables/${tableId}/fields`,
  );
  return fields.items.find((field) => field.is_primary)?.id ?? '';
}
