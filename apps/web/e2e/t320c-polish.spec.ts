import { type Browser, type Locator, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import {
  apiSignIn,
  collectCspViolations,
  expectNoSeriousA11yViolations,
  ok,
  signInFirstAdmin,
  trackApiCalls,
} from './support';

/**
 * T320c: kanban, form, share and filter polish (design alignment and S3 QA
 * findings). Self-contained like t314/t315: the first administrator, a
 * table of tickets, a "Reader" member of the base and an "Outsider" who is
 * a member of the organization without access to the base.
 */
const ADMIN = {
  name: 'Nguyễn Văn Ánh',
  email: WORKER_ORG.ownerEmail,
  password: 'E2E-Setup-Password-2026',
};
const RUN = String(Date.now());
const READER = {
  name: 'Lê Thị Đọc',
  email: `reader-t320c-${RUN}@cellhive.test`,
  password: 'E2E-Reader-Password-2026',
};
const OUTSIDER = {
  name: 'Phạm Văn Ngoài',
  email: `outsider-t320c-${RUN}@cellhive.test`,
  password: 'E2E-Outsider-Password-2026',
};
const TABLE_NAME = 'Phiếu T320';
const STATUSES = ['Mới', 'Đang xử lý', 'Xong'] as const;

/** Signs in with the shared `apiSignIn` (waits out the per-IP limit). */
async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem('cellhive.language', 'en');
  });
  await page.goto('/login');
  await apiSignIn(page, email, password);
}

async function openAs(browser: Browser, email: string, password: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();
  await signIn(page, email, password);
  return page;
}

interface Field {
  id: string;
  name: string;
  options: { options?: { id: string; name: string }[] };
}

const ids = {
  orgId: '',
  baseId: '',
  tableId: '',
  gridViewId: '',
  boardViewId: '',
  formViewId: '',
  fields: {} as Record<string, string>,
  options: {} as Record<string, string>,
};
const viewPath = (viewId: string) => `/b/${ids.baseId}/t/${ids.tableId}/v/${viewId}`;

async function invite(browser: Browser, page: Page, person: typeof READER): Promise<string> {
  const invitation = await ok<{ invite_url: string }>(
    page,
    'POST',
    `/orgs/${ids.orgId}/invitations`,
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
  return accepted.user.id;
}

function board(page: Page): Locator {
  return page.getByTestId('kanban-board');
}

function column(page: Page, status: (typeof STATUSES)[number] | 'empty'): Locator {
  const key = status === 'empty' ? '__empty' : (ids.options[status] ?? '');
  return board(page).locator(`[data-testid="kanban-column"][data-column="${key}"]`);
}

function count(page: Page, status: (typeof STATUSES)[number]): Locator {
  return column(page, status).getByTestId('kanban-column-count');
}

test.describe('T320c polish', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ viewport: { width: 1600, height: 900 } });

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto('/login');
    // Any order of the specs (T470/T527): set up, signed in, or invited by the demo admin.
    await signInFirstAdmin(page, ADMIN);
    const me = await ok<{ orgs: { id: string }[] }>(page, 'GET', '/me');
    ids.orgId = me.orgs[0]?.id ?? '';
    const workspace = await ok<{ id: string }>(page, 'POST', `/orgs/${ids.orgId}/workspaces`, {
      name: `T320c ${RUN}`,
    });
    const base = await ok<{ id: string }>(page, 'POST', `/workspaces/${workspace.id}/bases`, {
      name: 'Hỗ trợ T320',
    });
    ids.baseId = base.id;
    const table = await ok<{ id: string }>(page, 'POST', `/bases/${base.id}/tables`, {
      name: TABLE_NAME,
    });
    ids.tableId = table.id;
    const fields = await ok<{ items: Field[] }>(page, 'GET', `/tables/${table.id}/fields`);
    for (const field of fields.items) ids.fields[field.name] = field.id;
    for (const body of [
      {
        name: 'Trạng thái',
        type: 'select',
        options: { options: STATUSES.map((name) => ({ name })) },
      },
      { name: 'Mã', type: 'auto_number' },
      { name: 'Số tiền', type: 'number' },
      { name: 'Hạn', type: 'datetime', options: { style: { format: 'dd/MM/yyyy' } } },
      { name: 'Phụ trách', type: 'user', options: { multiple: false } },
    ]) {
      const field = await ok<Field>(page, 'POST', `/tables/${table.id}/fields`, body);
      ids.fields[body.name] = field.id;
      for (const option of field.options.options ?? []) ids.options[option.name] = option.id;
    }
    await ok(page, 'POST', `/tables/${table.id}/records?field_key_type=name`, {
      records: [
        { fields: { Name: 'Máy in kẹt giấy', 'Trạng thái': 'Mới', 'Số tiền': 100 } },
        { fields: { Name: 'Máy quét lỗi', 'Trạng thái': 'Mới', 'Số tiền': 200 } },
        { fields: { Name: 'Router mất mạng', 'Trạng thái': 'Đang xử lý', 'Số tiền': 300 } },
      ],
    });
    const views = await ok<{ items: { id: string }[] }>(page, 'GET', `/tables/${table.id}/views`);
    ids.gridViewId = views.items[0]?.id ?? '';
    const boardView = await ok<{ id: string }>(page, 'POST', `/tables/${table.id}/views`, {
      name: 'Bảng',
      type: 'kanban',
      config: {
        kanban: {
          group_field: ids.fields['Trạng thái'],
          card_fields: [ids.fields['Mã'], ids.fields['Số tiền']],
        },
      },
    });
    ids.boardViewId = boardView.id;
    const form = await ok<{ id: string }>(page, 'POST', `/tables/${table.id}/views`, {
      name: 'Đăng ký',
      type: 'form',
      config: {
        form: {
          title: 'Đăng ký hỗ trợ',
          fields: [
            { field: ids.fields['Name'], required: true },
            { field: ids.fields['Phụ trách'] },
            { field: ids.fields['Hạn'] },
          ],
          require_login: true,
          submission_limit: 'once',
        },
      },
    });
    ids.formViewId = form.id;

    const roles = await ok<{ items: { id: string; kind: string }[] }>(
      page,
      'GET',
      `/bases/${base.id}/roles`,
    );
    const readerRole = roles.items.find((role) => role.kind === 'system_reader');
    const readerId = await invite(browser, page, READER);
    await ok(page, 'PUT', `/bases/${base.id}/role-assignments`, {
      principal_type: 'user',
      principal_id: readerId,
      role_id: readerRole?.id,
    });
    // A member of the organization without any access to the base.
    await invite(browser, page, OUTSIDER);
    await page.close();
  });

  test('kanban: counts follow a move made in another tab; "Move to" lists every column', async ({
    browser,
  }) => {
    const mover = await openAs(browser, ADMIN.email, ADMIN.password);
    const watcher = await openAs(browser, ADMIN.email, ADMIN.password);
    const cspViolations = collectCspViolations(mover);
    for (const page of [mover, watcher]) {
      await page.goto(viewPath(ids.boardViewId));
      await expect(count(page, 'Mới')).toHaveText(/2$/u);
      await expect(count(page, 'Đang xử lý')).toHaveText(/1$/u);
    }
    // Cards: the code in mono above the title, values without labels.
    const card = column(mover, 'Mới')
      .getByTestId('kanban-card')
      .filter({ hasText: 'Máy in kẹt giấy' });
    await expect(card.getByTestId('kanban-card-value')).toHaveCount(1);
    await expect(card).not.toContainText('Số tiền100');

    await card.focus();
    await mover.keyboard.press('Shift+F10');
    const menu = mover.getByTestId('kanban-card-menu');
    await expect(menu.getByRole('menuitemradio')).toHaveText([
      'Uncategorized',
      /^MớiCurrent$/u,
      'Đang xử lý',
      'Xong',
    ]);
    await expectNoSeriousA11yViolations(mover, 'kanban card menu');
    await menu.getByRole('menuitemradio', { name: 'Đang xử lý' }).click();
    // The focus stays on the board: the next card of the column.
    await expect(mover.locator(':focus')).toHaveText(/Máy quét lỗi/u);

    // The other tab: the card moves and both counts follow (T320 QA: stale after 4 s).
    await expect(
      column(watcher, 'Đang xử lý').getByTestId('kanban-card').filter({ hasText: 'Máy in' }),
    ).toBeVisible();
    await expect(count(watcher, 'Mới')).toHaveText(/1$/u, { timeout: 3000 });
    await expect(count(watcher, 'Đang xử lý')).toHaveText(/2$/u, { timeout: 3000 });
    await expect(count(mover, 'Mới')).toHaveText(/1$/u);

    // Back to "Uncategorized" from the menu.
    const moved = column(mover, 'Đang xử lý')
      .getByTestId('kanban-card')
      .filter({ hasText: 'Máy in' });
    await moved.focus();
    await mover.keyboard.press('Shift+F10');
    await mover
      .getByTestId('kanban-card-menu')
      .getByRole('menuitemradio', { name: 'Uncategorized' })
      .click();
    await expect(column(watcher, 'empty').getByTestId('kanban-column-count')).toHaveText(/1$/u, {
      timeout: 3000,
    });
    expect(cspViolations).toEqual([]);
    await mover.context().close();
    await watcher.context().close();
  });

  test('kanban: a reader gets the reason instead of an empty menu; a new board shows fields', async ({
    browser,
    page,
  }) => {
    const reader = await openAs(browser, READER.email, READER.password);
    await reader.goto(viewPath(ids.boardViewId));
    const card = column(reader, 'Đang xử lý').getByTestId('kanban-card').first();
    await card.focus();
    await reader.keyboard.press('Shift+F10');
    const menu = reader.getByTestId('kanban-card-menu');
    await expect(menu.getByTestId('kanban-move-blocked')).toHaveText(
      'You cannot change this field, so cards cannot be moved.',
    );
    await expect(menu.getByRole('menuitemradio')).toHaveCount(0);
    await reader.keyboard.press('Escape');
    await reader.context().close();

    await signIn(page, ADMIN.email, ADMIN.password);
    const fresh = await ok<{ id: string }>(page, 'POST', `/tables/${ids.tableId}/views`, {
      name: 'Bảng mới',
      type: 'kanban',
    });
    await page.goto(viewPath(fresh.id));
    await page.getByRole('combobox', { name: 'Group cards by' }).selectOption({
      label: 'Trạng thái',
    });
    await expect(board(page)).toBeVisible();
    // The first readable fields (not the title, not the group field) are on the cards.
    await expect(
      column(page, 'Đang xử lý')
        .getByTestId('kanban-card')
        .first()
        .getByTestId('kanban-card-value'),
    ).not.toHaveCount(0);
    await expect(page.getByRole('button', { name: '3 card fields' })).toBeVisible();
  });

  test('form: base people only, typed dates, the limit screen once submitted', async ({ page }) => {
    await signIn(page, ADMIN.email, ADMIN.password);
    await page.goto(`${viewPath(ids.formViewId)}?form=fill`);
    const assignee = page.getByRole('combobox', { name: 'Phụ trách' });
    await expect(assignee.getByRole('option', { name: ADMIN.name })).toHaveCount(1);
    await expect(assignee.getByRole('option', { name: READER.name })).toHaveCount(1);
    await expect(assignee.getByRole('option', { name: OUTSIDER.name })).toHaveCount(0);
    await expect(page.getByText('Made with Cellhive')).toBeVisible();
    await expectNoSeriousA11yViolations(page, 'form fill');

    await page.getByRole('textbox', { name: /^Name/u }).fill('Yêu cầu T320');
    await assignee.selectOption({ label: READER.name });
    const due = page.getByRole('textbox', { name: 'Hạn' });
    await expect(due).toHaveAttribute('placeholder', 'dd/mm/yyyy');
    await due.fill('25/09/2026');
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByRole('heading', { name: 'Response sent' })).toBeVisible();
    const created = await ok<{ records: { fields: Record<string, unknown> }[] }>(
      page,
      'POST',
      `/tables/${ids.tableId}/records/query?field_key_type=name`,
      { search: 'Yêu cầu T320', limit: 5 },
    );
    expect(created.records[0]?.fields['Hạn']).toBe('2026-09-25');

    // Opened again: the limit shows at once, nothing to fill in for nothing.
    await page.reload();
    await expect(page.getByTestId('form-limit')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Submit' })).toHaveCount(0);
  });

  test('form builder: an invalid redirect URL says so and is not saved', async ({ page }) => {
    await signIn(page, ADMIN.email, ADMIN.password);
    // T319: the builder remounts while its view is still loading, and text typed
    // before that is lost: type once the page has no API call in flight.
    const calls = trackApiCalls(page);
    await page.goto(`${viewPath(ids.formViewId)}?form=build`);
    const redirect = page.getByTestId('form-redirect-url');
    await expect(redirect).toBeEditable();
    await calls.idle();
    await redirect.pressSequentially('javascript:alert(1)', { delay: 20 });
    await expect(redirect).toHaveValue('javascript:alert(1)');
    await expect(
      page.getByText('Enter an address starting with http:// or https://.'),
    ).toBeVisible();
    await redirect.blur();
    const view = await ok<{ config: { form: { redirect_url: string | null } } }>(
      page,
      'GET',
      `/views/${ids.formViewId}`,
    );
    expect(view.config.form.redirect_url).toBeNull();
  });

  test('filter: an inverted range is flagged; removing keeps the focus; search says its field', async ({
    page,
  }) => {
    await signIn(page, ADMIN.email, ADMIN.password);
    await page.goto(viewPath(ids.gridViewId));
    await expect(page.getByRole('searchbox', { name: 'Search records' })).toHaveAttribute(
      'placeholder',
      'Search by Name',
    );
    await page.getByTestId('filter-button').click();
    const panel = page.getByRole('dialog', { name: 'Filter' });
    await panel.getByRole('button', { name: 'Add condition', exact: true }).click();
    const row = panel.getByTestId('filter-condition');
    await row.getByRole('combobox', { name: 'Field' }).selectOption({ label: 'Số tiền' });
    await row.getByRole('combobox', { name: 'Operator for Số tiền' }).selectOption('between');
    await row.getByRole('spinbutton', { name: 'Value for Số tiền, from' }).fill('500');
    await row.getByRole('spinbutton', { name: 'Value for Số tiền, to' }).fill('10');
    await expect(
      panel.getByText(
        'The first value is greater than the second, so no record can match. Swap them.',
      ),
    ).toBeVisible();
    await expect(page.getByTestId('filter-button')).toHaveAccessibleName('Filter');
    await row.getByRole('button', { name: /^Remove condition/u }).click();
    await expect(panel.getByRole('button', { name: 'Add condition', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
  });

  test('share: reopening shows the link prefix without focusing or selecting it', async ({
    page,
  }) => {
    await signIn(page, ADMIN.email, ADMIN.password);
    await ok(page, 'POST', `/views/${ids.gridViewId}/share-links`, { audience: 'org' });
    await page.goto(viewPath(ids.gridViewId));
    await page.getByRole('button', { name: 'Share view Grid view' }).click();
    const dialog = page.getByRole('dialog', { name: 'Share “Grid view”' });
    const address = dialog.getByRole('textbox', { name: 'Link address' });
    await expect(address).toHaveValue(/\/s\/[\w-]{6}…$/u);
    await expect(address).not.toBeFocused();
    await address.focus();
    expect(
      await address.evaluate(
        (input: HTMLInputElement) => input.selectionEnd === input.selectionStart,
      ),
    ).toBe(true);
    await expect(dialog.getByTestId('share-link-stats')).toHaveText('Not opened yet');
    await expect(dialog.getByRole('switch', { name: 'Search' })).toBeChecked();
    await expectNoSeriousA11yViolations(page, 'share dialog (T320)');
  });
});
