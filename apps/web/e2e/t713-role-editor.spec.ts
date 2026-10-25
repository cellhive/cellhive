import { type Browser, type BrowserContext, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { DEMO_PASSWORD } from './seed';
import { api, apiSignIn, collectCspViolations, expectNoSeriousA11yViolations, ok } from './support';

/**
 * T713: the role editor and the member access panel (FRONTEND §17.4) on a
 * base with the CONTRACTS §5 fixture, made through the API in a workspace
 * of its own (the demo users and the demo group "Sales" = {u_sales1,
 * u_sales2}); the role "Sales" of §5 is given to the group there.
 *
 * - u_admin builds "Sales 2" through the UI (keyboard on the levels and the
 *   field grid) = the Sales config of C§5, gives it to u_sales2 → u_sales2
 *   reads only r2, has no `cost`, may not edit `status`; their access
 *   equals u_sales1's (Sales through the group);
 * - `status` set to None while a condition uses it → raised to Create only
 *   with the reason beside it; `total_formula` set to Edit → lowered to Read;
 * - the access panel of u_sales1: Orders read 1 / edit 1 through the group;
 * - a link rule (T710) built through the UI is saved as ids, with the
 *   warning of negative link conditions;
 * - leaving with unsaved changes asks first; system role ceilings;
 * - axe on every state; Vietnamese at 375 px (matrix → list → detail page).
 */

const RUN = Date.now().toString(36);
const SALES1_EMAIL = WORKER_ORG.email('sales1');
const SALES2_EMAIL = WORKER_ORG.email('sales2');
const SALES1_NAME = 'Phạm Ngọc Lan';
const SALES2_NAME = 'Võ Đức Huy';

interface Fixture {
  baseId: string;
  orders: string;
  customers: string;
  fld: Record<'title' | 'amount' | 'cost' | 'status' | 'owner' | 'total' | 'customer', string>;
  records: Record<'r1' | 'r2' | 'r3' | 'c1' | 'c2', string>;
  sales1: string;
  sales2: string;
  group: string;
  salesRole: string;
}

const fx = {} as Fixture;

type Cookies = Awaited<ReturnType<BrowserContext['cookies']>>;
const cookies: Record<string, Cookies> = {};

/** A new context signed in as `email` (once per user and spec: 20 sign-ins a minute per IP). */
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

/** The §5 fixture in a new workspace and base of the demo organization. */
async function buildFixture(page: Page): Promise<void> {
  const me = await ok<{ orgs: { id: string }[] }>(page, 'GET', '/me');
  const orgId = me.orgs[0]?.id ?? '';
  const workspace = await ok<{ id: string }>(page, 'POST', `/orgs/${orgId}/workspaces`, {
    name: `T713 ${RUN}`,
  });
  const base = await ok<{ id: string }>(page, 'POST', `/workspaces/${workspace.id}/bases`, {
    name: `Phân quyền T713 ${RUN}`,
  });
  fx.baseId = base.id;
  const table = async (name: string, primary: string) =>
    ok<{ id: string; primary_field_id: string }>(page, 'POST', `/bases/${base.id}/tables`, {
      name,
      primary_field_name: primary,
    });
  const orders = await table('Orders', 'title');
  const customers = await table('Customers', 'name');
  fx.orders = orders.id;
  fx.customers = customers.id;
  const add = async (tableId: string, name: string, type: string, options: unknown = {}) =>
    (await ok<{ id: string }>(page, 'POST', `/tables/${tableId}/fields`, { name, type, options }))
      .id;
  fx.fld = {
    title: orders.primary_field_id,
    amount: await add(orders.id, 'amount', 'number'),
    cost: await add(orders.id, 'cost', 'number'),
    status: await add(orders.id, 'status', 'select', {
      options: [{ name: 'Mới' }, { name: 'Xong' }],
    }),
    owner: await add(orders.id, 'owner', 'user', { multiple: false }),
    total: await add(orders.id, 'total_formula', 'formula', { expression: '[amount] + [cost]' }),
    customer: await add(orders.id, 'customer', 'link', { link_table: customers.id }),
  };
  await add(customers.id, 'phone', 'text');

  const principals = await ok<{
    items: { principal_type: string; principal_id: string; name: string; email: string | null }[];
  }>(page, 'GET', `/bases/${base.id}/principals?limit=200`);
  const user = (email: string) =>
    principals.items.find((item) => item.email === email)?.principal_id ?? '';
  fx.sales1 = user(SALES1_EMAIL);
  fx.sales2 = user(SALES2_EMAIL);
  fx.group =
    principals.items.find((item) => item.principal_type === 'group' && item.name === 'Sales')
      ?.principal_id ?? '';

  const created = await ok<{ records: { id: string; fields: { name: string } }[] }>(
    page,
    'POST',
    `/tables/${customers.id}/records?field_key_type=name`,
    { records: [{ fields: { name: 'c1' } }, { fields: { name: 'c2' } }] },
  );
  const c1 = created.records[0]?.id ?? '';
  const c2 = created.records[1]?.id ?? '';
  const rows = await ok<{ records: { id: string }[] }>(
    page,
    'POST',
    `/tables/${orders.id}/records?field_key_type=id`,
    {
      records: [
        {
          fields: {
            [fx.fld.title]: 'r1',
            [fx.fld.owner]: [{ id: fx.sales1 }],
            [fx.fld.customer]: [c1],
            [fx.fld.amount]: 100,
            [fx.fld.cost]: 40,
          },
        },
        {
          fields: {
            [fx.fld.title]: 'r2',
            [fx.fld.owner]: [{ id: fx.sales2 }],
            [fx.fld.customer]: [c2],
            [fx.fld.amount]: 200,
            [fx.fld.cost]: 80,
          },
        },
        { fields: { [fx.fld.title]: 'r3' } },
      ],
    },
  );
  fx.records = {
    r1: rows.records[0]?.id ?? '',
    r2: rows.records[1]?.id ?? '',
    r3: rows.records[2]?.id ?? '',
    c1,
    c2,
  };

  // The role "Sales" of C§5, given to the group Sales.
  const sales = await ok<{ id: string }>(page, 'POST', `/bases/${base.id}/roles`, {
    name: 'Sales',
    config: salesConfig(),
  });
  fx.salesRole = sales.id;
  await ok(page, 'PUT', `/bases/${base.id}/role-assignments`, {
    principal_type: 'group',
    principal_id: fx.group,
    role_id: sales.id,
  });
}

function ownerIsMe() {
  return {
    op: 'and',
    items: [{ field: fx.fld.owner, operator: 'has_any_of', value: [{ $var: 'current_user' }] }],
  };
}

function salesConfig() {
  return {
    base_rule: { copy: false, download: false, share_link: false },
    tables: {
      [fx.orders]: {
        perm: 'edit',
        view_rule: { allow_edit: false, visible_views: null },
        record_rule: {
          operations: ['add'],
          edit_filter: ownerIsMe(),
          read_scope: 'editable',
          read_filter: null,
        },
        field_rule: {
          mode: 'specify',
          fields: { [fx.fld.cost]: 'no_perm', [fx.fld.status]: 'read' },
          option_edit_fields: [],
          file_download_fields: [],
        },
      },
    },
    dashboards: {},
  };
}

function noHorizontalScroll(page: Page, width: number) {
  return expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(width);
}

/** The level `radiogroup` of a table in the matrix (or a field in the grid). */
const group = (page: Page, name: string) => page.getByRole('radiogroup', { name });

async function roleIdByName(page: Page, name: string): Promise<string> {
  const roles = await ok<{ items: { id: string; name: string }[] }>(
    page,
    'GET',
    `/bases/${fx.baseId}/roles`,
  );
  return roles.items.find((item) => item.name === name)?.id ?? '';
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
  await buildFixture(page);
  await context.close();
});

test.afterAll(async ({ browser }) => {
  // The fixture base goes to the trash (its workspace keeps it out of the demo base's way).
  const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
  await api(page, 'DELETE', `/bases/${fx.baseId}`);
  await context.close();
});

test('u_admin builds "Sales 2" through the UI = Sales of C§5; u_sales2 reads only r2', async ({
  browser,
}) => {
  const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
  const csp = collectCspViolations(page);
  await page.goto(`/b/${fx.baseId}/settings/roles`);
  await page.getByTestId('role-create').click();
  await page.getByRole('dialog', { name: 'New role' }).getByLabel('Name').fill('Sales 2');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Role “Sales 2” created.')).toBeVisible();
  await page.getByRole('link', { name: 'Permissions of Sales 2' }).click();
  await expect(page).toHaveURL(/\/settings\/roles\/rol_[^/?]+$/u);
  const roleId = await roleIdByName(page, 'Sales 2');
  const nav = page.getByRole('navigation', { name: 'Base settings' });
  await expect(nav.getByRole('link', { name: 'Roles' })).toHaveAttribute('aria-current', 'page');

  // Matrix: a new role reads nothing; the Orders level with the keyboard (arrow keys).
  const orders = group(page, 'Access to Orders');
  await expect(orders.getByRole('radio', { name: 'No access' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(
    group(page, 'Access to Customers').getByRole('radio', { name: 'No access' }),
  ).toHaveAttribute('aria-checked', 'true');
  await expectNoSeriousA11yViolations(page, 'role editor: matrix');
  await orders.getByRole('radio', { name: 'No access' }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(orders.getByRole('radio', { name: 'Read only' })).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(orders.getByRole('radio', { name: 'Edit' })).toHaveAttribute('aria-checked', 'true');
  await expect(orders.getByRole('radio', { name: 'Edit' })).toBeFocused();
  await expect(page.getByTestId('unsaved-bar')).toContainText('Unsaved changes');

  // Details of Orders: records.
  await page.getByRole('link', { name: /^Details of Orders/u }).click();
  await expect(page).toHaveURL(new RegExp(`\\?table=${fx.orders}$`, 'u'));
  const detail = page.getByTestId('table-detail');
  await detail.getByRole('checkbox', { name: 'Add records' }).check();
  await detail.getByTestId('records-edit-where').check();
  const rule = detail.getByTestId('rule-filter');
  await rule.getByRole('button', { name: 'Add condition', exact: true }).click();
  await rule.getByRole('combobox', { name: 'Field' }).selectOption({ label: 'owner' });
  await expect(rule.getByRole('combobox', { name: 'Operator for owner' })).toHaveValue(
    'has_any_of',
  );
  await rule.getByRole('checkbox', { name: 'Current user (whoever views)' }).check();
  await detail.getByTestId('records-read-editable').check();
  await expect(detail.getByTestId('records-summary')).toHaveText(
    'Edits records where owner has any of Current user (whoever views). Reads only the records it can edit. Can add records, not delete them.',
  );

  // Fields: per field; `cost` None and `status` Read with the keyboard (Tab between rows).
  await detail.getByTestId('field-mode-specify').check();
  await group(page, 'Permission on title').getByRole('radio', { name: 'Edit' }).focus();
  await page.keyboard.press('Tab');
  await expect(
    group(page, 'Permission on amount').getByRole('radio', { name: 'Edit' }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  const cost = group(page, 'Permission on cost');
  await expect(cost.getByRole('radio', { name: 'Edit' })).toBeFocused();
  await page.keyboard.press('End');
  await expect(cost.getByRole('radio', { name: 'None' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Tab');
  const status = group(page, 'Permission on status');
  await expect(status.getByRole('radio', { name: 'Edit' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(status.getByRole('radio', { name: 'Read' })).toHaveAttribute('aria-checked', 'true');
  // A computed field starts at Read when choosing per field.
  await expect(
    group(page, 'Permission on total_formula').getByRole('radio', { name: 'Read' }),
  ).toHaveAttribute('aria-checked', 'true');
  await expectNoSeriousA11yViolations(page, 'role editor: table detail');

  await page.getByTestId('role-save').click();
  await expect(page.getByText('Permissions of “Sales 2” saved.')).toBeVisible();
  await expect(page.getByTestId('unsaved-bar')).toHaveCount(0);

  // Stored: the Sales config of C§5 (every field listed — the same permissions).
  const saved = await ok<{
    config: { base_rule: unknown; tables: Record<string, Record<string, unknown>> };
  }>(page, 'GET', `/bases/${fx.baseId}/roles/${roleId}`);
  expect(saved.config.base_rule).toEqual({ copy: false, download: false, share_link: false });
  expect(Object.keys(saved.config.tables)).toEqual([fx.orders]);
  const stored = saved.config.tables[fx.orders] as {
    record_rule: unknown;
    view_rule: unknown;
    perm: string;
    field_rule: { mode: string; fields: Record<string, string> };
  };
  expect(stored.perm).toBe('edit');
  expect(stored.view_rule).toEqual({ allow_edit: false, visible_views: null });
  expect(stored.record_rule).toEqual({
    operations: ['add'],
    edit_filter: ownerIsMe(),
    read_scope: 'editable',
    read_filter: null,
  });
  expect(stored.field_rule.mode).toBe('specify');
  expect(stored.field_rule.fields[fx.fld.cost]).toBe('no_perm');
  expect(stored.field_rule.fields[fx.fld.status]).toBe('read');
  expect(stored.field_rule.fields[fx.fld.amount]).toBe('edit');

  // Give it to u_sales2 (a direct role wins over the group's Sales).
  await nav.getByRole('link', { name: 'Members' }).click();
  await page.getByLabel('Search people and groups').fill(SALES2_NAME);
  await page
    .getByRole('combobox', { name: `Role of ${SALES2_NAME}` })
    .selectOption({ label: 'Sales 2' });
  await expect(page.getByText(`${SALES2_NAME} now has the role Sales 2.`)).toBeVisible();

  // Same access as Sales through the group (u_sales1), apart from the role it names.
  type Access = { access: { role: unknown } & Record<string, unknown>; source: { kind: string } };
  const two = await ok<Access>(page, 'GET', `/bases/${fx.baseId}/members/${fx.sales2}/access`);
  const one = await ok<Access>(page, 'GET', `/bases/${fx.baseId}/members/${fx.sales1}/access`);
  expect(two.source.kind).toBe('direct_role');
  expect({ ...two.access, role: null }).toEqual({ ...one.access, role: null });
  expect(csp).toEqual([]);
  await context.close();

  // u_sales2: only r2, no `cost`; editing `status` is refused.
  const sales2 = await openAs(browser, SALES2_EMAIL);
  await sales2.page.goto(`/b/${fx.baseId}/t/${fx.orders}`);
  const tables = sales2.page.getByRole('navigation', { name: 'Tables' });
  await expect(tables.getByRole('link', { name: /^Orders/u })).toBeVisible();
  await expect(tables.getByRole('link', { name: /^Customers/u })).toHaveCount(0);
  const list = await ok<{ records: { id: string; fields: Record<string, unknown> }[] }>(
    sales2.page,
    'GET',
    `/tables/${fx.orders}/records?field_key_type=id`,
  );
  expect(list.records.map((record) => record.id)).toEqual([fx.records.r2]);
  expect(Object.keys(list.records[0]?.fields ?? {})).not.toContain(fx.fld.cost);
  const fields = await ok<{ items: { id: string }[] }>(
    sales2.page,
    'GET',
    `/tables/${fx.orders}/fields`,
  );
  expect(fields.items.map((item) => item.id)).not.toContain(fx.fld.cost);
  const edit = await api(
    sales2.page,
    'PATCH',
    `/tables/${fx.orders}/records?field_key_type=id&typecast=true`,
    {
      records: [{ id: fx.records.r2, fields: { [fx.fld.status]: 'Xong' } }],
    },
  );
  expect(edit.status).toBe(403);
  const amount = await api(sales2.page, 'PATCH', `/tables/${fx.orders}/records?field_key_type=id`, {
    records: [{ id: fx.records.r2, fields: { [fx.fld.amount]: 250 } }],
  });
  expect(amount.status).toBe(200);
  await sales2.context.close();
});

test('the server adjustments show beside the field with their reason', async ({ browser }) => {
  const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
  // A copy of Sales to change.
  const role = await ok<{ id: string }>(page, 'POST', `/bases/${fx.baseId}/roles`, {
    name: 'Sales 3',
    config: salesConfig(),
  });
  await page.goto(`/b/${fx.baseId}/settings/roles/${role.id}?table=${fx.orders}`);
  const detail = page.getByTestId('table-detail');
  // `status` in the edit condition, and set to None.
  const rule = detail.getByTestId('rule-filter');
  await rule.getByRole('button', { name: 'Add condition', exact: true }).click();
  await rule.getByRole('combobox', { name: 'Field' }).last().selectOption({ label: 'status' });
  await rule.getByRole('combobox', { name: 'Value for status' }).selectOption({ label: 'Mới' });
  const status = group(page, 'Permission on status');
  await status.getByRole('radio', { name: 'None' }).click();
  await expect(detail.getByTestId('field-row').filter({ hasText: 'status' })).toContainText(
    'Used in a record condition: at least Create only when saved',
  );
  // `total_formula` set to Edit: computed, saved as Read.
  const total = group(page, 'Permission on total_formula');
  await total.getByRole('radio', { name: 'Edit' }).click();
  await page.getByTestId('role-save').click();
  await expect(page.getByText(/saved, 2 adjusted/u)).toBeVisible();

  const statusRow = detail.getByTestId('field-row').filter({ hasText: 'status' });
  await expect(statusRow.getByTestId('adjustment')).toHaveText(
    'status was raised to Create only because a record condition uses it and the role can add records (new records must still match).',
  );
  await expect(status.getByRole('radio', { name: 'Create only' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  const totalRow = detail.getByTestId('field-row').filter({ hasText: 'total_formula' });
  await expect(totalRow.getByTestId('adjustment')).toHaveText(
    'total_formula was lowered to Read: computed fields are at most Read.',
  );
  await expect(total.getByRole('radio', { name: 'Read' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('adjustments')).toContainText(
    'The server adjusted 2 permissions when saving',
  );
  await expectNoSeriousA11yViolations(page, 'role editor: adjustments');
  // Back on the matrix, the row says how many fields were adjusted.
  await detail.getByTestId('table-detail-back').click();
  await expect(page.getByTestId(`table-notes-${fx.orders}`)).toContainText(
    '2 fields adjusted when saving',
  );
  await api(page, 'DELETE', `/bases/${fx.baseId}/roles/${role.id}`);
  await context.close();
});

test('the access panel of u_sales1: Orders read 1 / edit 1 through the group Sales', async ({
  browser,
}) => {
  const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
  await page.goto(`/b/${fx.baseId}/settings/members`);
  await page.getByLabel('Search people and groups').fill(SALES1_NAME);
  await page.getByRole('button', { name: `View the access of ${SALES1_NAME}` }).click();
  const panel = page.getByRole('dialog', { name: `Access of ${SALES1_NAME}` });
  await expect(panel).toContainText('not a preview of the whole app');
  await expect(panel.getByTestId('access-source')).toHaveText('Through their groups Sales: Sales.');
  const orders = panel.getByTestId('access-table').filter({ hasText: 'Orders' });
  await expect(orders.getByTestId('access-counts')).toHaveText('Reads 1 · edits 1');
  await expect(orders).toContainText('Hidden fieldscost');
  await expect(orders).toContainText('Read-only fields');
  await expect(panel.getByTestId('access-denied-tables')).toHaveText('No access: Customers');
  await expectNoSeriousA11yViolations(page, 'member access panel');
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  // The organization owner: full access, said in place of a role select.
  await page.getByLabel('Search people and groups').fill('');
  await expect(page.getByText('Full access · organization owner').first()).toBeVisible();
  await context.close();
});

test('a link rule (T710) built through the UI is saved by record id, with the warning', async ({
  browser,
}) => {
  const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
  const role = await ok<{ id: string }>(page, 'POST', `/bases/${fx.baseId}/roles`, {
    name: 'Kho T713',
  });
  await page.goto(`/b/${fx.baseId}/settings/roles/${role.id}?table=${fx.orders}`);
  const detail = page.getByTestId('table-detail');
  await group(page, 'Access to Orders').getByRole('radio', { name: 'Read only' }).click();
  await detail.getByTestId('records-read-filter').check();
  await expect(page.getByTestId('unsaved-bar')).toContainText('1 table needs a fix before saving.');
  await expect(page.getByTestId('role-save')).toBeDisabled();
  const rule = detail.getByTestId('rule-filter');
  await rule.getByRole('button', { name: 'Add condition', exact: true }).click();
  await rule.getByRole('combobox', { name: 'Field' }).selectOption({ label: 'customer' });
  await expect(rule.getByRole('combobox', { name: 'Operator for customer' })).toHaveValue(
    'has_any_of',
  );
  await rule.getByRole('checkbox', { name: 'c1' }).check();
  await expect(detail.getByTestId('records-summary')).toContainText(
    'Reads records where customer has any of 1 record.',
  );
  await expect(detail.getByTestId('link-warning')).toHaveCount(0);
  // A negative link condition: the warning (only live linked records count).
  await rule.getByRole('combobox', { name: 'Operator for customer' }).selectOption('has_none_of');
  await expect(detail.getByTestId('link-warning')).toContainText(
    'Only linked records that are not in the trash count',
  );
  await rule.getByRole('combobox', { name: 'Operator for customer' }).selectOption('has_any_of');
  await rule.getByRole('checkbox', { name: 'c1' }).check();
  await expectNoSeriousA11yViolations(page, 'role editor: link rule');
  await page.getByTestId('role-save').click();
  await expect(page.getByText('Permissions of “Kho T713” saved.')).toBeVisible();
  const saved = await ok<{ config: { tables: Record<string, { record_rule: unknown }> } }>(
    page,
    'GET',
    `/bases/${fx.baseId}/roles/${role.id}`,
  );
  expect(saved.config.tables[fx.orders]?.record_rule).toEqual({
    operations: [],
    edit_filter: null,
    read_scope: 'filter',
    read_filter: {
      op: 'and',
      items: [{ field: fx.fld.customer, operator: 'has_any_of', value: [fx.records.c1] }],
    },
  });
  await api(page, 'DELETE', `/bases/${fx.baseId}/roles/${role.id}`);
  await context.close();
});

test('leaving with unsaved changes asks first; system roles show their ceiling', async ({
  browser,
}) => {
  const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
  await page.goto(`/b/${fx.baseId}/settings/roles/${fx.salesRole}`);
  await page.getByRole('checkbox', { name: 'Copy' }).check();
  await expect(page.getByTestId('unsaved-bar')).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Base settings' });
  await nav.getByRole('link', { name: 'Members' }).click();
  const leave = page.getByRole('alertdialog', { name: 'Leave without saving?' });
  await expect(leave).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'role editor: leave dialog');
  await page.keyboard.press('Escape');
  await expect(leave).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/roles/${fx.salesRole}$`, 'u'));
  await nav.getByRole('link', { name: 'Members' }).click();
  await leave.getByRole('button', { name: 'Leave without saving' }).click();
  await expect(page).toHaveURL(/\/settings\/members$/u);
  // Nothing was saved.
  const sales = await ok<{ config: { base_rule: { copy: boolean } } }>(
    page,
    'GET',
    `/bases/${fx.baseId}/roles/${fx.salesRole}`,
  );
  expect(sales.config.base_rule.copy).toBe(false);

  // Editor: Manage is off with its reason; Admin: read-only.
  const roles = await ok<{ items: { id: string; kind: string }[] }>(
    page,
    'GET',
    `/bases/${fx.baseId}/roles`,
  );
  const editor = roles.items.find((item) => item.kind === 'system_editor')?.id ?? '';
  const admin = roles.items.find((item) => item.kind === 'system_admin')?.id ?? '';
  await page.goto(`/b/${fx.baseId}/settings/roles/${editor}`);
  const manage = group(page, 'Access to Orders').getByRole('radio', { name: 'Manage' });
  await expect(manage).toHaveAttribute('aria-disabled', 'true');
  await expect(manage).toHaveAccessibleDescription(
    'Not for the Editor role: it never goes above Edit.',
  );
  await expect(page.getByTestId('role-ceiling')).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'role editor: editor ceiling');
  await page.goto(`/b/${fx.baseId}/settings/roles/${admin}`);
  await expect(page.getByTestId('role-read-only')).toBeVisible();
  await expect(group(page, 'Access to Orders')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByRole('checkbox', { name: 'Copy' })).toBeDisabled();
  await context.close();
});

test('Vietnamese at 375 px: the matrix is a list, the table detail a page of its own', async ({
  browser,
}) => {
  const { context, page } = await openAs(browser, WORKER_ORG.email('admin'), {
    viewport: { width: 375, height: 812 },
    language: 'vi',
  });
  await page.goto(`/b/${fx.baseId}/settings/roles/${fx.salesRole}`);
  const cards = page.getByRole('list', { name: 'Quyền của vai trò trên từng bảng' });
  await expect(cards).toBeVisible();
  await expect(page.getByTestId('table-matrix')).toHaveCount(0);
  await expect(
    group(page, 'Quyền trên Orders').getByRole('radio', { name: 'Sửa' }),
  ).toHaveAttribute('aria-checked', 'true');
  const radio = group(page, 'Quyền trên Orders').getByRole('radio', { name: 'Chỉ xem' });
  expect((await radio.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  await noHorizontalScroll(page, 375);
  await expectNoSeriousA11yViolations(page, 'role editor at 375 px (vi)');
  await page.getByRole('link', { name: /^Chi tiết của Orders/u }).click();
  const detail = page.getByTestId('table-detail');
  await expect(detail.getByRole('heading', { name: 'Orders' })).toBeVisible();
  await expect(detail.getByTestId('records-summary')).toContainText('Sửa được bản ghi có owner');
  await expect(
    group(page, 'Quyền trên cost').getByRole('radio', { name: 'Không' }),
  ).toHaveAttribute('aria-checked', 'true');
  await noHorizontalScroll(page, 375);
  await expectNoSeriousA11yViolations(page, 'table detail at 375 px (vi)');
  await detail.getByRole('link', { name: 'Mọi bảng' }).click();
  await expect(cards).toBeVisible();
  await context.close();
});
