import { type Browser, type BrowserContext, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import {
  apiSignIn,
  collectCspViolations,
  expectNoSeriousA11yViolations,
  ok,
  signInFirstAdmin,
} from './support';

/**
 * T311: the view toolbar — filter builder, sort, search, Ctrl/⌘+F, temporary
 * (Lark-style) changes saved with Ctrl/⌘+S, conditions on fields a member
 * cannot read, Shift+Enter. Self-contained like t310: the first
 * administrator, its own base and members (an editor, a reader, a "Sales"
 * role without `cost`, a "Curator" role that may edit views but not read
 * `cost`, and a role that cannot read the primary field).
 */
const ADMIN = {
  name: 'Nguyễn Văn Ánh',
  email: WORKER_ORG.ownerEmail,
  password: 'E2E-Setup-Password-2026',
};
const RUN = String(Date.now());
const member = (key: string, name: string) => ({
  name,
  email: `${key}-t311-${RUN}@cellhive.test`,
  password: `E2E-${key}-Password-2026`,
});
const EDITOR = member('editor', 'Trần Thu Hà');
const READER = member('reader', 'Lê Quốc Bảo');
const SALES = member('sales', 'Phạm Ngọc Lan');
const CURATOR = member('curator', 'Võ Đức Huy');
const BLIND = member('blind', 'Đặng Thanh Tùng');
const TABLE_NAME = 'Đơn hàng';

/** Name, status, amount, cost. */
const ROWS: [string, string, number, number][] = [
  ['Cửa hàng An Phát', 'Mới', 300, 900],
  ['An Phú', 'Mới', 100, 50],
  ['Bình Minh', 'Xong', 200, 700],
  ['Cao Nguyên', 'Mới', 300, 20],
  ['Đông Á', 'Đang xử lý', 500, 800],
  ['Hải Vân', 'Mới', 400, 600],
];

interface View {
  id: string;
  name: string;
  is_personal: boolean;
  config: { filter: unknown; sort: unknown[] };
}

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem('cellhive.language', 'en');
  });
  await page.goto('/login');
  await apiSignIn(page, email, password);
}

type Session = Awaited<ReturnType<BrowserContext['storageState']>>;

/**
 * Each person signs in once for the whole file (sign-in is limited to 20 a
 * minute per IP, and the specs before this one sign in too): later pages
 * reuse the session cookies.
 */
const sessions = new Map<string, Session>();

/** A new page of its own browser context, signed in as `person`. */
async function openAs(
  browser: Browser,
  person: { email: string; password: string },
): Promise<Page> {
  const saved = sessions.get(person.email);
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    ...(saved === undefined ? {} : { storageState: saved }),
  });
  const page = await context.newPage();
  if (saved === undefined) {
    await signIn(page, person.email, person.password);
    sessions.set(person.email, await context.storageState());
  } else {
    await page.addInitScript(() => {
      window.localStorage.setItem('cellhive.language', 'en');
    });
    // On the app's origin, so that API calls from the page work at once.
    await page.goto('/login');
  }
  return page;
}

/** Texts of a column of glide's accessibility table, in row order. */
async function column(page: Page, name: string): Promise<string[]> {
  const header = page.locator('table[role="grid"] th[role="columnheader"]', { hasText: name });
  const index = await header.first().getAttribute('aria-colindex');
  return page.locator(`table[role="grid"] td[aria-colindex="${String(index)}"]`).allTextContents();
}

function footer(page: Page) {
  return page.getByRole('status').filter({ hasText: /records?$/u });
}

function toolbar(page: Page) {
  return page.getByRole('toolbar', { name: 'View options' });
}

function unsaved(page: Page) {
  return page.getByRole('group', { name: 'Unsaved changes' });
}

async function openFilter(page: Page) {
  const button = page.getByTestId('filter-button');
  await button.focus();
  await page.keyboard.press('Enter');
  const panel = page.getByRole('dialog', { name: 'Filter' });
  await expect(panel).toBeVisible();
  return panel;
}

/** Adds "<field> is <option>" to the root group of the open filter panel (keyboard). */
async function addSelectCondition(page: Page, field: string, option: string) {
  const panel = page.getByRole('dialog', { name: 'Filter' });
  const before = await panel.getByTestId('filter-condition').count();
  await panel.getByRole('button', { name: 'Add condition', exact: true }).focus();
  await page.keyboard.press('Enter');
  const row = panel.getByTestId('filter-condition').nth(before);
  await row.getByRole('combobox', { name: 'Field' }).selectOption({ label: field });
  await row.getByRole('combobox', { name: `Value for ${field}` }).selectOption({ label: option });
}

test.describe('T311 view toolbar', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ viewport: { width: 1600, height: 900 } });

  const ids = {
    baseId: '',
    tableId: '',
    mainViewId: '',
    costlyViewId: '',
    statusId: '',
    amountId: '',
    costId: '',
    optNew: '',
  };
  const viewPath = (viewId: string) => `/b/${ids.baseId}/t/${ids.tableId}/v/${viewId}`;
  const costFilter = () => ({
    op: 'and',
    items: [{ field: ids.costId, operator: 'gte', value: 600 }],
  });

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    const page = await browser.newPage();
    await page.goto('/login');
    // Any order of the specs (T470/T527): set up, signed in, or invited by the demo admin.
    await signInFirstAdmin(page, ADMIN);
    sessions.set(ADMIN.email, await page.context().storageState());
    const me = await ok<{ orgs: { id: string }[] }>(page, 'GET', '/me');
    const orgId = me.orgs[0]?.id ?? '';
    const workspace = await ok<{ id: string }>(page, 'POST', `/orgs/${orgId}/workspaces`, {
      name: 'Toolbar E2E',
    });
    const base = await ok<{ id: string }>(page, 'POST', `/workspaces/${workspace.id}/bases`, {
      name: 'Bán hàng T311',
    });
    ids.baseId = base.id;
    const table = await ok<{ id: string; primary_field_id: string }>(
      page,
      'POST',
      `/bases/${base.id}/tables`,
      { name: TABLE_NAME },
    );
    ids.tableId = table.id;
    const status = await ok<{ id: string; options: { options: { id: string; name: string }[] } }>(
      page,
      'POST',
      `/tables/${table.id}/fields`,
      {
        name: 'Trạng thái',
        type: 'select',
        options: { options: [{ name: 'Mới' }, { name: 'Đang xử lý' }, { name: 'Xong' }] },
      },
    );
    ids.statusId = status.id;
    ids.optNew = status.options.options.find((option) => option.name === 'Mới')?.id ?? '';
    ids.amountId = (
      await ok<{ id: string }>(page, 'POST', `/tables/${table.id}/fields`, {
        name: 'Số tiền',
        type: 'number',
      })
    ).id;
    ids.costId = (
      await ok<{ id: string }>(page, 'POST', `/tables/${table.id}/fields`, {
        name: 'cost',
        type: 'number',
      })
    ).id;
    await ok(page, 'POST', `/tables/${table.id}/records?field_key_type=name`, {
      records: ROWS.map(([name, state, amount, cost]) => ({
        fields: { Name: name, 'Trạng thái': state, 'Số tiền': amount, cost },
      })),
    });
    const views = await ok<{ items: View[] }>(page, 'GET', `/tables/${table.id}/views`);
    ids.mainViewId = views.items[0]?.id ?? '';
    // The main view is sorted by amount (ascending): a temporary sort must replace it.
    await ok(page, 'PATCH', `/views/${ids.mainViewId}`, {
      config: { sort: [{ field: ids.amountId, direction: 'asc' }] },
    });
    ids.costlyViewId = (
      await ok<View>(page, 'POST', `/tables/${table.id}/views`, {
        name: 'Chi phí cao',
        type: 'grid',
        config: { filter: costFilter() },
      })
    ).id;

    const roles = await ok<{ items: { id: string; kind: string }[] }>(
      page,
      'GET',
      `/bases/${base.id}/roles`,
    );
    const custom = async (name: string, allowEdit: boolean, hidden: string) =>
      (
        await ok<{ id: string }>(page, 'POST', `/bases/${base.id}/roles`, {
          name: `${name} ${RUN}`,
          config: {
            tables: {
              [table.id]: {
                perm: 'read_only',
                view_rule: { allow_edit: allowEdit, visible_views: null },
                field_rule: { mode: 'specify', fields: { [hidden]: 'no_perm' } },
              },
            },
          },
        })
      ).id;
    const assignments: [typeof EDITOR, string | undefined][] = [
      [EDITOR, roles.items.find((role) => role.kind === 'system_editor')?.id],
      [READER, roles.items.find((role) => role.kind === 'system_reader')?.id],
      [SALES, await custom('Sales', false, ids.costId)],
      [CURATOR, await custom('Curator', true, ids.costId)],
      [BLIND, await custom('Blind', false, table.primary_field_id)],
    ];
    for (const [person, roleId] of assignments) {
      const invitation = await ok<{ invite_url: string }>(
        page,
        'POST',
        `/orgs/${orgId}/invitations`,
        { email: person.email, role: 'member' },
      );
      const token = new URL(invitation.invite_url).pathname.split('/').pop() ?? '';
      const guest = await browser.newContext();
      const guestPage = await guest.newPage();
      await guestPage.goto('/login');
      const accepted = await ok<{ user: { id: string } }>(
        guestPage,
        'POST',
        `/invitations/${token}/accept`,
        { display_name: person.name, password: person.password },
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

  test('filter + two sort keys replace the view sort; the grid matches the API', async ({
    browser,
  }) => {
    const page = await openAs(browser, EDITOR);
    const cspViolations = collectCspViolations(page);
    await page.goto(viewPath(ids.mainViewId));
    await expect(footer(page)).toHaveText('6 records');
    // The saved sort: amount ascending.
    await expect
      .poll(() => column(page, 'Name'))
      .toEqual(['An Phú', 'Bình Minh', 'Cửa hàng An Phát', 'Cao Nguyên', 'Hải Vân', 'Đông Á']);

    await test.step('build "Trạng thái is Mới" with the keyboard', async () => {
      const panel = await openFilter(page);
      await expect(panel.locator(':focus')).toHaveCount(1);
      await addSelectCondition(page, 'Trạng thái', 'Mới');
      await expectNoSeriousA11yViolations(page, 'filter builder');
      await page.keyboard.press('Escape');
      await expect(panel).toBeHidden();
      await expect(page.getByTestId('filter-button')).toBeFocused();
      await expect(
        toolbar(page).getByRole('button', { name: 'Filter: 1 condition' }),
      ).toBeVisible();
      await expect(footer(page)).toHaveText('4 records');
    });

    await test.step('sort by amount descending, then name', async () => {
      await toolbar(page).getByTestId('sort-button').click();
      const panel = page.getByRole('dialog', { name: 'Sort' });
      // The saved key is listed; flip it and add a second one.
      await panel
        .getByRole('combobox', { name: 'Direction for Số tiền' })
        .selectOption({ label: 'Descending' });
      await panel
        .getByRole('combobox', { name: 'Add a sort field' })
        .selectOption({ label: 'Name' });
      await expectNoSeriousA11yViolations(page, 'sort panel');
      await page.keyboard.press('Escape');
      await expect(toolbar(page).getByRole('button', { name: 'Sort: Số tiền +1' })).toBeVisible();
    });

    await test.step('the rows are those of the API, in its order', async () => {
      const expected = await ok<{ records: { fields: Record<string, string> }[] }>(
        page,
        'POST',
        `/tables/${ids.tableId}/records/query?field_key_type=name&cell_format=text`,
        {
          view_id: ids.mainViewId,
          filter: {
            op: 'and',
            items: [{ field: ids.statusId, operator: 'is', value: ids.optNew }],
          },
          filter_mode: 'replace',
          sort: [
            { field: 'Số tiền', direction: 'desc' },
            { field: 'Name', direction: 'asc' },
          ],
          sort_mode: 'replace',
        },
      );
      const names = expected.records.map((record) => record.fields['Name']);
      expect(names).toEqual(['Hải Vân', 'Cao Nguyên', 'Cửa hàng An Phát', 'An Phú']);
      await expect.poll(() => column(page, 'Name')).toEqual(names);
    });

    await test.step('discard: back to the saved view', async () => {
      await unsaved(page).getByRole('button', { name: 'Discard' }).click();
      await expect(footer(page)).toHaveText('6 records');
      await expect(toolbar(page).getByRole('button', { name: 'Sort: Số tiền' })).toBeVisible();
    });
    expect(cspViolations, 'Content-Security-Policy violations').toEqual([]);
  });

  test('search: Ctrl/⌘+F focuses it, unaccented match, Escape clears then leaves', async ({
    browser,
  }) => {
    const page = await openAs(browser, READER);
    await page.goto(viewPath(ids.mainViewId));
    await expect(footer(page)).toHaveText('6 records');
    const search = page.getByRole('searchbox', { name: 'Search records' });
    await page.keyboard.press('ControlOrMeta+f');
    await expect(search).toBeFocused();
    await page.keyboard.type('an phat');
    await expect(footer(page)).toHaveText('1 record');
    await expect.poll(() => column(page, 'Name')).toEqual(['Cửa hàng An Phát']);
    await page.keyboard.press('Escape');
    await expect(search).toHaveValue('');
    await expect(footer(page)).toHaveText('6 records');
    await page.keyboard.press('Escape');
    await expect(search).not.toBeFocused();
  });

  test('a role that cannot read the primary field cannot search', async ({ browser }) => {
    const page = await openAs(browser, BLIND);
    await page.goto(viewPath(ids.mainViewId));
    await expect(footer(page)).toHaveText('6 records');
    await expect(page.getByRole('searchbox', { name: 'Search records' })).toBeDisabled();
  });

  test('temporary changes: the editor saves with Ctrl/⌘+S, the reader only as a personal view', async ({
    browser,
  }) => {
    const page = await openAs(browser, EDITOR);
    await page.goto(viewPath(ids.mainViewId));
    await expect(footer(page)).toHaveText('6 records');

    await test.step('editor: a filter is temporary until Ctrl/⌘+S', async () => {
      await openFilter(page);
      await addSelectCondition(page, 'Trạng thái', 'Xong');
      await page.keyboard.press('Escape');
      await expect(footer(page)).toHaveText('1 record');
      await expect(unsaved(page).getByRole('button', { name: 'Save', exact: true })).toBeVisible();
      let saved = await ok<View>(page, 'GET', `/views/${ids.mainViewId}`);
      expect(saved.config.filter).toBeNull();
      await page.keyboard.press('ControlOrMeta+s');
      await expect(page.getByText('Changes saved to view Grid view.')).toBeVisible();
      await expect(unsaved(page)).toHaveCount(0);
      saved = await ok<View>(page, 'GET', `/views/${ids.mainViewId}`);
      expect(saved.config.filter).toMatchObject({
        op: 'and',
        items: [{ field: ids.statusId, operator: 'is' }],
      });
    });

    await test.step('reader: no Save; Ctrl/⌘+S makes a personal view', async () => {
      const reader = await openAs(browser, READER);
      await reader.goto(viewPath(ids.mainViewId));
      await expect(footer(reader)).toHaveText('1 record');
      await reader.getByTestId('sort-button').click();
      await reader
        .getByRole('dialog', { name: 'Sort' })
        .getByRole('combobox', { name: 'Add a sort field' })
        .selectOption({ label: 'Name' });
      await reader.keyboard.press('Escape');
      await expect(unsaved(reader).getByRole('button', { name: 'Save', exact: true })).toHaveCount(
        0,
      );
      await reader.keyboard.press('ControlOrMeta+s');
      // T320b: Ctrl/⌘+S first says why the shared view itself cannot be saved.
      const explain = reader.getByRole('dialog', {
        name: 'Your changes cannot be saved to this view',
      });
      await expect(explain).toContainText('You cannot change this shared view.');
      await explain.getByRole('button', { name: 'Save as personal view' }).click();
      await expect(reader.getByText(/^Saved as personal view /u)).toBeVisible();
      await expect(reader).not.toHaveURL(new RegExp(`/v/${ids.mainViewId}$`, 'u'));
      // The shared view keeps its saved sort.
      const shared = await ok<View>(page, 'GET', `/views/${ids.mainViewId}`);
      expect(shared.config.sort).toEqual([{ field: ids.amountId, direction: 'asc' }]);
      await reader.context().close();
    });

    // Leave the main view as it was for the other tests.
    await ok(page, 'PATCH', `/views/${ids.mainViewId}`, { config: { filter: null } });
  });

  test('conditions on cost stay hidden and applied for Sales and Curator, and are never dropped', async ({
    browser,
  }) => {
    const page = await openAs(browser, ADMIN);

    await test.step('sales: cost is nowhere in the toolbar; its saved condition still applies', async () => {
      const sales = await openAs(browser, SALES);
      await sales.goto(viewPath(ids.costlyViewId));
      await expect(footer(sales)).toHaveText('4 records');
      // The hidden condition is not counted nor shown.
      await expect(sales.getByRole('button', { name: 'Filter', exact: true })).toBeVisible();
      const panel = await openFilter(sales);
      await expect(panel.getByTestId('filter-condition')).toHaveCount(0);
      await panel.getByRole('button', { name: 'Add condition', exact: true }).click();
      const fields = await panel
        .getByRole('combobox', { name: 'Field' })
        .locator('option')
        .allTextContents();
      expect(fields).toEqual(['Name', 'Trạng thái', 'Số tiền']);
      await panel.getByRole('combobox', { name: 'Field' }).selectOption({ label: 'Trạng thái' });
      await panel
        .getByRole('combobox', { name: 'Value for Trạng thái' })
        .selectOption({ label: 'Mới' });
      await sales.keyboard.press('Escape');
      await sales.getByTestId('sort-button').click();
      const sortFields = await sales
        .getByRole('dialog', { name: 'Sort' })
        .getByRole('combobox', { name: 'Add a sort field' })
        .locator('option')
        .allTextContents();
      expect(sortFields.slice(1)).toEqual(['Name', 'Trạng thái', 'Số tiền']);
      await sales.keyboard.press('Escape');
      // cost ≥ 600 AND Mới: the temporary filter replaced only what Sales sees.
      await expect(footer(sales)).toHaveText('2 records');
      await expect.poll(() => column(sales, 'Name')).toEqual(['Cửa hàng An Phát', 'Hải Vân']);
      await unsaved(sales).getByRole('button', { name: 'Save as personal view' }).click();
      await expect(sales.getByText(/^Saved as personal view /u)).toBeVisible();
      await sales.context().close();
      const shared = await ok<View>(page, 'GET', `/views/${ids.costlyViewId}`);
      expect(shared.config.filter).toEqual(costFilter());
    });

    await test.step('curator: saving the filter keeps the cost condition it cannot see', async () => {
      const curator = await openAs(browser, CURATOR);
      await curator.goto(viewPath(ids.costlyViewId));
      await expect(footer(curator)).toHaveText('4 records');
      await openFilter(curator);
      await addSelectCondition(curator, 'Trạng thái', 'Mới');
      await curator.keyboard.press('Escape');
      await expect(footer(curator)).toHaveText('2 records');
      await curator.keyboard.press('ControlOrMeta+s');
      await expect(curator.getByText('Changes saved to view Chi phí cao.')).toBeVisible();
      await curator.context().close();
      const shared = await ok<View>(page, 'GET', `/views/${ids.costlyViewId}`);
      expect(shared.config.filter).toEqual({
        op: 'and',
        items: [{ field: ids.statusId, operator: 'is', value: ids.optNew }, ...costFilter().items],
      });
    });
  });

  test('shortcuts: Ctrl/⌘+F, Ctrl/⌘+S and Shift+Enter are listed; Shift+Enter adds a record', async ({
    browser,
  }) => {
    const page = await openAs(browser, EDITOR);
    await page.goto(viewPath(ids.mainViewId));
    await expect(footer(page)).toHaveText('6 records');
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Keyboard shortcuts' }).click();
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    for (const action of [
      'Search the view',
      'Save the changes of the view',
      'Add a record below the selected row',
    ]) {
      await expect(dialog.getByRole('rowheader', { name: action })).toBeVisible();
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // Select a cell of the last row, then Shift+Enter.
    const canvas = page.locator('.ob-grid [data-testid="data-grid-canvas"]');
    const box = await canvas.boundingBox();
    if (box === null) throw new Error('grid not laid out');
    // Header 36 px, compact rows 34 px: the middle of the last (6th) row, Name column.
    // Right after loading, a click may come before the rows: try again until selected.
    await expect(async () => {
      await page.mouse.click(box.x + 120, box.y + 36 + 34 * 5 + 17);
      await expect(page.getByTestId('glide-cell-1-5')).toHaveAttribute('aria-selected', 'true', {
        timeout: 2000,
      });
    }).toPass({ timeout: 20_000 });
    await page.keyboard.press('Shift+Enter');
    await expect(footer(page)).toHaveText('7 records');
  });
});
