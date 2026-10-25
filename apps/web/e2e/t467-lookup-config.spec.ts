import { type Browser, type BrowserContext, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { DEMO_ORDER_CUSTOMER, DEMO_ORDER_TITLE, DEMO_PASSWORD } from './seed';
import { api, apiSignIn, expectNoSeriousA11yViolations, ok } from './support';

/**
 * T467: the lookup dialog (board "S4b · Cấu hình tra cứu") on the demo
 * base. Customers gets "Tổng tiền đơn đã hoàn thành": the sum of the
 * amounts of its orders whose status is "Xong", through the shortcut "via
 * a link field" (Orders.customer is a one-way link pointing at Customers)
 * with a VND currency result — `1.500.000 ₫` for a customer with two done
 * orders (1 000 000 + 500 000) and one new order. A second lookup compares
 * without any link (`field_ref`: order title = customer name), made with
 * the keyboard only. A manager of Customers alone never sees Orders in the
 * list of source tables. Phone (375 px): the dialog fills the screen.
 */

const RUN = String(Date.now()).slice(-6);
const names = {
  customer: `Khách T467 ${RUN}`,
  lookup: `Tổng tiền đơn đã hoàn thành ${RUN}`,
  byName: `Tổng theo tên ${RUN}`,
  role: `T467 chỉ Khách hàng ${RUN}`,
};
const MANAGER = {
  email: `t467-${RUN}@example.com`,
  name: 'Quản lý T467',
  password: 'T467-manager-2026!',
};
const ids = {
  orgId: '',
  baseId: '',
  orders: '',
  customers: '',
  customerLink: '',
  amount: '',
  status: '',
  name: '',
  customer: '',
  lookup: '',
  byName: '',
  viaOwn: '',
  order: '',
  role: '',
  manager: '',
};

async function openAs(
  browser: Browser,
  email: string,
  password = DEMO_PASSWORD,
  viewport = { width: 1440, height: 900 },
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport, locale: 'en-US' });
  await context.addInitScript(() => {
    window.localStorage.setItem('cellhive.language', 'en');
  });
  const page = await context.newPage();
  await page.goto('/login');
  await apiSignIn(page, email, password);
  return { context, page };
}

async function findDemo(page: Page) {
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
      const id = (name: string) => tables.items.find((table) => table.name === name)?.id ?? '';
      return { orgId: org.id, baseId: base.id, orders: id('Orders'), customers: id('Customers') };
    }
  }
  throw new Error('demo base not found');
}

async function openNewFieldDialog(page: Page) {
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Add field' }).click();
  return page.getByRole('dialog', { name: 'New field' });
}

/**
 * The value the saved lookup computes for the test customer, through the
 * server preview (`record_ids`); grid cells of computed fields are T468.
 */
async function computedFor(page: Page, fieldId: string): Promise<unknown> {
  const field = await ok<{ options: Record<string, unknown> }>(page, 'GET', `/fields/${fieldId}`);
  const preview = await ok<{ records: { id: string; value: unknown }[]; style: unknown }>(
    page,
    'POST',
    `/tables/${ids.customers}/computed-preview`,
    { type: 'lookup', options: field.options, field_id: fieldId, record_ids: [ids.customer] },
  );
  return { value: preview.records[0]?.value, style: preview.style };
}

/** The column's value for the test customer as `cell_format=text` reads it (T457), once computed. */
async function cellText(page: Page, fieldId: string): Promise<unknown> {
  const answer = await ok<{ fields: Record<string, unknown> }>(
    page,
    'GET',
    `/tables/${ids.customers}/records/${ids.customer}?cell_format=text&field_key_type=id`,
  );
  return answer.fields[fieldId];
}

test.describe.serial('T467 lookup configuration', () => {
  test.use({ actionTimeout: 15_000 });

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
    Object.assign(ids, await findDemo(page));
    const orderFields = await ok<{ items: { id: string; name: string }[] }>(
      page,
      'GET',
      `/tables/${ids.orders}/fields`,
    );
    const orderField = (name: string) =>
      orderFields.items.find((item) => item.name === name)?.id ?? '';
    ids.customerLink = orderField(DEMO_ORDER_CUSTOMER);
    ids.amount = orderField('amount');
    ids.status = orderField('status');
    const customerFields = await ok<{ items: { id: string; name: string }[] }>(
      page,
      'GET',
      `/tables/${ids.customers}/fields`,
    );
    ids.name = customerFields.items.find((item) => item.name === 'Tên')?.id ?? '';

    const created = await ok<{ records: { id: string }[] }>(
      page,
      'POST',
      `/tables/${ids.customers}/records?field_key_type=name`,
      { records: [{ fields: { Tên: names.customer } }] },
    );
    ids.customer = created.records[0]?.id ?? '';
    const orders = await ok<{ records: { id: string }[] }>(
      page,
      'POST',
      `/tables/${ids.orders}/records?field_key_type=name`,
      {
        records: [
          { amount: 1_000_000, status: 'Xong', title: `Đơn A ${RUN}` },
          { amount: 500_000, status: 'Xong', title: `Đơn B ${RUN}` },
          { amount: 300_000, status: 'Mới', title: `Đơn C ${RUN}` },
          // Same title as the customer's name: the lookup without link counts it.
          { amount: 700_000, status: 'Mới', title: names.customer, linked: false },
        ].map((order) => ({
          fields: {
            [DEMO_ORDER_TITLE]: order.title,
            amount: order.amount,
            status: order.status,
            ...(order.linked === false ? {} : { [DEMO_ORDER_CUSTOMER]: [{ id: ids.customer }] }),
          },
        })),
      },
    );
    ids.order = orders.records[0]?.id ?? '';

    // A person who manages Customers and reads nothing else of the base.
    const invitation = await ok<{ invite_url: string }>(
      page,
      'POST',
      `/orgs/${ids.orgId}/invitations`,
      { email: MANAGER.email, role: 'member' },
    );
    const token = new URL(invitation.invite_url).pathname.split('/').pop() ?? '';
    const guest = await browser.newContext();
    const guestPage = await guest.newPage();
    await guestPage.goto('/login');
    const accepted = await ok<{ user: { id: string } }>(
      guestPage,
      'POST',
      `/invitations/${token}/accept`,
      { display_name: MANAGER.name, password: MANAGER.password },
    );
    await guest.close();
    ids.manager = accepted.user.id;
    const role = await ok<{ id: string }>(page, 'POST', `/bases/${ids.baseId}/roles`, {
      name: names.role,
      config: { tables: { [ids.customers]: { perm: 'manage' } } },
    });
    ids.role = role.id;
    await ok(page, 'PUT', `/bases/${ids.baseId}/role-assignments`, {
      principal_type: 'user',
      principal_id: ids.manager,
      role_id: ids.role,
    });
    await context.close();
  });

  test.afterAll(async ({ browser }) => {
    const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
    // The demo base goes back to its fields and roles (the next specs count on them).
    for (const id of [ids.lookup, ids.byName, ids.viaOwn]) {
      if (id !== '') await api(page, 'DELETE', `/fields/${id}`);
    }
    await api(page, 'DELETE', `/bases/${ids.baseId}/role-assignments`, {
      principal_type: 'user',
      principal_id: ids.manager,
    });
    if (ids.role !== '') await api(page, 'DELETE', `/bases/${ids.baseId}/roles/${ids.role}`);
    await context.close();
  });

  test('sum of done orders through a link field, VND currency, live preview', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
    await page.goto(`/b/${ids.baseId}/t/${ids.customers}`);
    const dialog = await openNewFieldDialog(page);
    await dialog.getByLabel('Name', { exact: true }).fill(names.lookup);
    await dialog.getByLabel('Field type').selectOption('lookup');
    const editor = page.getByTestId('lookup-editor');

    await editor
      .getByLabel('Shortcut: through a link field')
      .selectOption(`in:${ids.customerLink}`);
    await expect(editor.getByTestId('lookup-shortcut')).toContainText(DEMO_ORDER_CUSTOMER);
    await expect(editor.getByLabel('Source table')).toHaveValue(ids.orders);
    const first = editor.getByTestId('lookup-condition').first();
    await expect(first.getByLabel(`Operator for ${DEMO_ORDER_CUSTOMER}`)).toHaveValue('has_any_of');
    await expect(first.getByText('auto')).toBeVisible();

    await editor.getByLabel('Field to get').selectOption(ids.amount);
    await editor.getByLabel('Show as').selectOption('sum');
    await expect(editor.getByLabel('Format')).toContainText('Currency VND (as the source)');

    await editor.getByRole('button', { name: 'Add condition' }).click();
    const second = editor.getByTestId('lookup-condition').nth(1);
    await second.getByLabel('Field of condition 2').selectOption(ids.status);
    await second.getByLabel('Value for status').selectOption({ label: 'Xong' });

    // Five records of the server preview, formatted as the column will be.
    const preview = editor.getByTestId('lookup-preview');
    await expect(preview.getByRole('row')).toHaveCount(6);
    await expect(editor.getByTestId('lookup-preview-value').first()).toContainText('₫');
    await expect(editor.getByTestId('lookup-compute-mode')).toContainText('stored');
    await expectNoSeriousA11yViolations(page, 'lookup dialog');
    await page.screenshot({ path: test.info().outputPath('lookup-dialog.png') });

    const response = page.waitForResponse(
      (answer) =>
        answer.url().endsWith(`/tables/${ids.customers}/fields`) &&
        answer.request().method() === 'POST',
    );
    await editor.getByTestId('lookup-save').click();
    const saved = (await (await response).json()) as { id: string; options: unknown };
    ids.lookup = saved.id;
    expect(saved.options).toMatchObject({
      from: ids.orders,
      select: ids.amount,
      aggregate: 'sum',
      style: { type: 'currency', currency_code: 'VND' },
    });
    await expect(page.getByRole('dialog', { name: 'New field' })).toHaveCount(0);
    // The milestone: 1 500 000 as a VND currency for the test customer.
    expect(await computedFor(page, ids.lookup)).toEqual({
      value: 1_500_000,
      style: { type: 'currency', currency_code: 'VND' },
    });
    // …and the column reads `1.500.000 ₫` once the background fill is done.
    await expect
      .poll(() => cellText(page, ids.lookup), { timeout: 90_000, intervals: [1000] })
      .toMatch(/^1\.500\.000\s₫$/u);
    await context.close();
  });

  test('lookup without link (field_ref), keyboard only', async ({ browser }) => {
    test.setTimeout(120_000);
    const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
    await page.goto(`/b/${ids.baseId}/t/${ids.customers}`);
    const dialog = await openNewFieldDialog(page);
    const name = dialog.getByLabel('Name', { exact: true });
    await expect(name).toBeFocused();
    await page.keyboard.type(names.byName);
    await page.keyboard.press('Tab');
    await expect(dialog.getByLabel('Field type')).toBeFocused();
    await dialog.getByLabel('Field type').press('l');
    await dialog.getByLabel('Field type').press('o');
    const editor = page.getByTestId('lookup-editor');
    // The lookup dialog replaced the plain one: focus its type control again.
    await editor.getByLabel('Field type').focus();
    await expect(editor.getByLabel('Field type')).toHaveValue('lookup');

    const tabTo = async (label: string) => {
      for (let step = 0; step < 12; step += 1) {
        await page.keyboard.press('Tab');
        const focused = await page.evaluate(() => {
          const element = document.activeElement;
          if (element === null) return '';
          const labelled = element.getAttribute('aria-label');
          if (labelled !== null) return labelled;
          const id = element.getAttribute('id');
          const label = id === null ? null : document.querySelector(`label[for="${id}"]`);
          return label?.textContent ?? (element.tagName === 'BUTTON' ? element.textContent : '');
        });
        if (focused.trim() === label) return;
      }
      throw new Error(`${label} not reached with Tab`);
    };
    await tabTo('Source table');
    await page.keyboard.type('Orders');
    await expect(editor.getByLabel('Source table')).toHaveValue(ids.orders);
    // The fields of Orders load once it is chosen.
    await expect(
      editor.getByLabel('Field to get').locator('option', { hasText: 'amount' }),
    ).toHaveCount(1);
    await tabTo('Field to get');
    await page.keyboard.type('amount');
    await expect(editor.getByLabel('Field to get')).toHaveValue(ids.amount);
    await tabTo('Add condition');
    await page.keyboard.press('Enter');
    const condition = editor.getByTestId('lookup-condition').first();
    await expect(condition.getByLabel('Field of condition 1')).toBeFocused();
    // The focused select, chosen by its label: the native type-ahead of a select
    // resets after ~1 s between keys, so typing a long name on a busy machine could
    // land on another field ("total_formula") (T470).
    await condition.getByLabel('Field of condition 1').selectOption({ label: DEMO_ORDER_TITLE });
    await expect(condition.getByLabel('Field of condition 1')).toBeFocused();
    await expect(condition.getByLabel('Field of condition 1')).toHaveValue(/fld_/u);
    // The operator select stays disabled until the field's state lands; a Tab
    // pressed before that skips it (the row re-renders around the type-ahead).
    await expect(condition.getByLabel(`Operator for ${DEMO_ORDER_TITLE}`)).toBeEnabled();
    await tabTo(`Operator for ${DEMO_ORDER_TITLE}`);
    await expect(condition.getByLabel(`Operator for ${DEMO_ORDER_TITLE}`)).toHaveValue('eq');
    await tabTo(`Compare ${DEMO_ORDER_TITLE} with`);
    // Type-ahead: "T" again goes to the next option starting with T ("This record", "Tên").
    await page.keyboard.press('T');
    await page.keyboard.press('T');
    await expect(condition.getByLabel(`Compare ${DEMO_ORDER_TITLE} with`)).toHaveValue(ids.name);
    await tabTo('Show as');
    await page.keyboard.type('Sum');
    await expect(editor.getByLabel('Show as')).toHaveValue('sum');
    await expect(editor.getByTestId('lookup-preview')).toBeVisible();

    const response = page.waitForResponse(
      (answer) =>
        answer.url().endsWith(`/tables/${ids.customers}/fields`) &&
        answer.request().method() === 'POST',
    );
    await editor.getByTestId('lookup-save').focus();
    await page.keyboard.press('Enter');
    const saved = (await (await response).json()) as { id: string; options: unknown };
    ids.byName = saved.id;
    expect(saved.options).toMatchObject({
      where: {
        op: 'and',
        items: [{ operator: 'eq', value: { field_ref: ids.name } }],
      },
    });
    expect(await computedFor(page, ids.byName)).toMatchObject({ value: 700_000 });
    await context.close();
  });

  test('through the one-way link of this table: Orders gets its customer name', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
    await page.goto(`/b/${ids.baseId}/t/${ids.orders}`);
    const dialog = await openNewFieldDialog(page);
    await dialog.getByLabel('Name', { exact: true }).fill(`Tên khách ${RUN}`);
    await dialog.getByLabel('Field type').selectOption('lookup');
    const editor = page.getByTestId('lookup-editor');
    // Orders.customer is one-way: selectable, it makes a record ID condition.
    await editor
      .getByLabel('Shortcut: through a link field')
      .selectOption(`out:${ids.customerLink}`);
    await expect(editor.getByLabel('Source table')).toHaveValue(ids.customers);
    const first = editor.getByTestId('lookup-condition').first();
    await expect(first.getByLabel('Field of condition 1')).toHaveValue('__id');
    await expect(first.getByLabel('Field of condition 1')).toContainText('Record of Customers');
    await expect(first.getByLabel('Operator for Record of Customers')).toHaveValue('is_any_of');
    await expect(first.getByLabel('Compare Record of Customers with')).toHaveValue(
      ids.customerLink,
    );
    await expect(first.getByText('auto')).toBeVisible();
    await editor.getByLabel('Field to get').selectOption(ids.name);
    await expect(editor.getByTestId('lookup-preview')).toBeVisible();
    await expectNoSeriousA11yViolations(page, 'lookup through a one-way link');
    const response = page.waitForResponse(
      (answer) =>
        answer.url().endsWith(`/tables/${ids.orders}/fields`) &&
        answer.request().method() === 'POST',
    );
    await editor.getByTestId('lookup-save').click();
    const saved = (await (await response).json()) as { id: string; options: unknown };
    ids.viaOwn = saved.id;
    expect(saved.options).toMatchObject({
      from: ids.customers,
      select: ids.name,
      where: {
        op: 'and',
        items: [{ field: '__id', operator: 'is_any_of', value: { field_ref: ids.customerLink } }],
      },
    });
    // The column of the test order reads its customer's name (T457 reads).
    await expect
      .poll(
        async () =>
          (
            await ok<{ fields: Record<string, unknown> }>(
              page,
              'GET',
              `/tables/${ids.orders}/records/${ids.order}?cell_format=text&field_key_type=id`,
            )
          ).fields[ids.viaOwn],
        { timeout: 90_000, intervals: [1000] },
      )
      .toBe(names.customer);
    await context.close();
  });

  test('a manager of Customers alone only lists what they read', async ({ browser }) => {
    const { context, page } = await openAs(browser, MANAGER.email, MANAGER.password);
    await page.goto(`/b/${ids.baseId}/t/${ids.customers}`);
    const dialog = await openNewFieldDialog(page);
    await dialog.getByLabel('Field type').selectOption('lookup');
    const editor = page.getByTestId('lookup-editor');
    const tables = editor.getByLabel('Source table').locator('option:not([disabled])');
    await expect(tables).toHaveText(['Customers (this table)']);
    // Orders.customer points here, but Orders cannot be read: no shortcut.
    await expect(editor.getByLabel('Shortcut: through a link field')).toHaveCount(0);
    await context.close();
  });

  test('phone: the dialog fills the screen and keeps its footer in reach', async ({ browser }) => {
    const { context, page } = await openAs(browser, WORKER_ORG.email('admin'), DEMO_PASSWORD, {
      width: 375,
      height: 812,
    });
    await page.goto(`/b/${ids.baseId}/t/${ids.customers}`);
    const dialog = await openNewFieldDialog(page);
    await dialog.getByLabel('Field type').selectOption('lookup');
    const editor = page.getByTestId('lookup-editor');
    await editor
      .getByLabel('Shortcut: through a link field')
      .selectOption(`in:${ids.customerLink}`);
    await editor.getByLabel('Field to get').selectOption(ids.amount);
    const box = await page.getByRole('dialog').boundingBox();
    expect(box?.width).toBe(375);
    expect(box?.height).toBe(812);
    const overflow = await page
      .getByRole('dialog')
      .evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const save = editor.getByTestId('lookup-save');
    await expect(save).toBeInViewport();
    const saveBox = await save.boundingBox();
    expect(saveBox?.height).toBeGreaterThanOrEqual(44);
    await expectNoSeriousA11yViolations(page, 'lookup dialog (375 px)');
    await page.screenshot({ path: test.info().outputPath('lookup-dialog-mobile.png') });
    await context.close();
  });
});
