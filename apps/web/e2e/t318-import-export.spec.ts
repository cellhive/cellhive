import { readFile } from 'node:fs/promises';

import { type Browser, type Locator, type Page } from '@playwright/test';

import { buildXlsx, encodeCp1258 } from './files';
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
 * T318: import wizard and export button. Self-contained like t314: the first
 * administrator (created by t011 when it runs first, else here), a base
 * with an "Orders" table exported through a Sales view, a "Products" table
 * to append to, and two members — Sales (may download, reads only their
 * orders, not the cost) and a reader whose role may not download.
 */
const ADMIN = {
  name: 'Nguyễn Văn Ánh',
  email: WORKER_ORG.ownerEmail,
  password: 'E2E-Setup-Password-2026',
};
const RUN = String(Date.now());
const SALES = {
  name: 'Phạm Văn Bán',
  email: `sales-t318-${RUN}@cellhive.test`,
  password: 'E2E-Sales-Password-2026',
};
const READER = {
  name: 'Lê Thị Đọc',
  email: `reader-t318-${RUN}@cellhive.test`,
  password: 'E2E-Reader-Password-2026',
};

/** Signs in with the shared `apiSignIn` (waits out the per-IP limit). */
async function signIn(page: Page, email: string, password: string, language = 'en') {
  await page.addInitScript((lng) => {
    window.localStorage.setItem('cellhive.language', lng);
  }, language);
  await page.goto('/login');
  // Sign-ins are limited per IP: the shared helper waits out a 429.
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
  type: string;
}

const ids = {
  orgId: '',
  baseId: '',
  ordersId: '',
  salesViewId: '',
  productsId: '',
  fields: {} as Record<string, string>,
};
const tablePath = (tableId: string) => `/b/${ids.baseId}/t/${tableId}`;
const salesViewPath = () => `${tablePath(ids.ordersId)}/v/${ids.salesViewId}`;

function wizard(page: Page): Locator {
  return page.getByTestId('import-wizard');
}

/** Invites a member, sets their password and gives them `roleId` on the base. */
async function addMember(
  page: Page,
  browser: Browser,
  member: { name: string; email: string; password: string },
  roleId: string,
): Promise<string> {
  const invitation = await ok<{ invite_url: string }>(
    page,
    'POST',
    `/orgs/${ids.orgId}/invitations`,
    { email: member.email, role: 'member' },
  );
  const token = new URL(invitation.invite_url).pathname.split('/').pop() ?? '';
  const guest = await browser.newContext();
  const guestPage = await guest.newPage();
  await guestPage.goto('/login');
  const acceptedAnswer = await api<{ user: { id: string } }>(
    guestPage,
    'POST',
    `/invitations/${token}/accept`,
    {
      display_name: member.name,
      password: member.password,
    },
  );
  expect(acceptedAnswer.status, 'accept invitation').toBeLessThan(300);
  const accepted = acceptedAnswer.body;
  await guest.close();
  await ok(page, 'PUT', `/bases/${ids.baseId}/role-assignments`, {
    principal_type: 'user',
    principal_id: accepted.user.id,
    role_id: roleId,
  });
  return accepted.user.id;
}

const SURNAMES = ['Nguyễn', 'Trần', 'Lê', 'Phạm', 'Hoàng', 'Vũ', 'Đặng', 'Bùi'];
const MIDDLE = ['Văn', 'Thị', 'Hữu', 'Minh'];
const GIVEN = ['Ánh', 'Bình', 'Cường', 'Dũng', 'Hương', 'Lan', 'Phương', 'Quỳnh', 'Sơn', 'Tuấn'];
const STATUSES = ['Mới', 'Đang giao', 'Hoàn tất'];

/** 1,000 customers as Excel on Vietnamese Windows saves them: Windows-1258, `;`. */
function customersCp1258(): Buffer {
  const lines = ['Họ tên;Số tiền;Ngày đặt;Trạng thái;Đã giao'];
  for (let i = 0; i < 1000; i += 1) {
    const name =
      i === 0
        ? 'Nguyễn Văn Ánh'
        : `${SURNAMES[i % 8] ?? ''} ${MIDDLE[i % 4] ?? ''} ${GIVEN[i % 10] ?? ''}`;
    const day = String((i % 28) + 1).padStart(2, '0');
    lines.push(
      [
        name,
        String(1000 * (i + 1)),
        `2026-09-${day}`,
        STATUSES[i % 3],
        i % 2 === 0 ? 'true' : 'false',
      ].join(';'),
    );
  }
  return encodeCp1258(`${lines.join('\r\n')}\r\n`);
}

test.describe('T318 import and export', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ viewport: { width: 1600, height: 900 } });

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto('/login');
    // Any order of the specs (T470/T527): set up, signed in, or invited by the demo admin.
    await signInFirstAdmin(page, ADMIN);
    const me = await ok<{ user: { id: string }; orgs: { id: string }[] }>(page, 'GET', '/me');
    ids.orgId = me.orgs[0]?.id ?? '';
    const workspace = await ok<{ id: string }>(page, 'POST', `/orgs/${ids.orgId}/workspaces`, {
      name: `Nhập xuất ${RUN}`,
    });
    const base = await ok<{ id: string }>(page, 'POST', `/workspaces/${workspace.id}/bases`, {
      name: 'Bán hàng',
    });
    ids.baseId = base.id;

    // Orders: exported through the Sales view.
    const orders = await ok<{ id: string }>(page, 'POST', `/bases/${base.id}/tables`, {
      name: 'Đơn hàng',
    });
    ids.ordersId = orders.id;
    for (const [name, type] of [
      ['Số tiền', 'number'],
      ['Giá vốn', 'number'],
      ['Phụ trách', 'user'],
      ['Ghi chú', 'text'],
    ] as const) {
      const created = await ok<Field>(page, 'POST', `/tables/${orders.id}/fields`, {
        name,
        type,
        ...(type === 'user' ? { options: { multiple: false } } : {}),
      });
      ids.fields[name] = created.id;
    }
    const view = await ok<{ id: string }>(page, 'POST', `/tables/${orders.id}/views`, {
      name: 'Đơn của tôi',
      type: 'grid',
      config: { hidden_fields: [ids.fields['Ghi chú']] },
    });
    ids.salesViewId = view.id;

    // Products: appended to from an XLSX file.
    const products = await ok<{ id: string }>(page, 'POST', `/bases/${base.id}/tables`, {
      name: 'Sản phẩm',
    });
    ids.productsId = products.id;
    for (const [name, type] of [
      ['Giá', 'number'],
      ['Mô tả', 'text'],
    ] as const) {
      const created = await ok<Field>(page, 'POST', `/tables/${products.id}/fields`, {
        name,
        type,
      });
      ids.fields[name] = created.id;
    }

    // Sales (P-matrix shape): edits their own orders only, never sees the cost, may download.
    const owner = ids.fields['Phụ trách'] ?? '';
    const salesRole = await ok<{ id: string }>(page, 'POST', `/bases/${base.id}/roles`, {
      name: `Sales ${RUN}`,
      config: {
        base_rule: { copy: true, download: true, share_link: false },
        tables: {
          [orders.id]: {
            perm: 'edit',
            view_rule: { allow_edit: false, visible_views: null },
            record_rule: {
              operations: ['add'],
              edit_filter: {
                op: 'and',
                items: [
                  { field: owner, operator: 'has_any_of', value: [{ $var: 'current_user' }] },
                ],
              },
              read_scope: 'editable',
              read_filter: null,
            },
            field_rule: {
              mode: 'specify',
              fields: { [ids.fields['Giá vốn'] ?? '']: 'no_perm' },
              option_edit_fields: [],
              file_download_fields: [],
            },
          },
        },
      },
    });
    // A reader of Orders whose role may not download (base_rule omitted = deny).
    const readerRole = await ok<{ id: string }>(page, 'POST', `/bases/${base.id}/roles`, {
      name: `Reader ${RUN}`,
      config: {
        tables: { [orders.id]: { perm: 'read_only' } },
      },
    });
    const salesId = await addMember(page, browser, SALES, salesRole.id);
    await addMember(page, browser, READER, readerRole.id);

    await ok(page, 'POST', `/tables/${orders.id}/records?field_key_type=name`, {
      records: [
        {
          fields: {
            Name: 'Đơn r1',
            'Số tiền': 1200,
            'Giá vốn': 800,
            'Phụ trách': [{ id: salesId }],
            'Ghi chú': 'ghi chú r1',
          },
        },
        {
          fields: {
            Name: 'Đơn r2',
            'Số tiền': 900,
            'Giá vốn': 500,
            'Phụ trách': [{ id: me.user.id }],
            'Ghi chú': 'ghi chú r2',
          },
        },
        { fields: { Name: 'Đơn r3', 'Số tiền': 300, 'Giá vốn': 100 } },
      ],
    });
    await page.close();
  });

  test('imports a Windows-1258 CSV of 1,000 rows as a new table', async ({ page }) => {
    const cspViolations = collectCspViolations(page);
    await signIn(page, ADMIN.email, ADMIN.password);
    await page.goto(tablePath(ids.ordersId));
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Import as a new table…' }).click();
    await expect(page.getByRole('dialog', { name: 'Import as a new table' })).toBeVisible();

    await page.getByTestId('import-file-input').setInputFiles({
      name: 'khach-hang.csv',
      mimeType: 'text/csv',
      buffer: customersCp1258(),
    });
    await expect(
      wizard(page).getByRole('heading', { name: 'Check how the file is read' }),
    ).toBeVisible();
    await expect(wizard(page).getByLabel('Encoding')).toHaveValue('windows-1258');
    await expect(wizard(page).getByLabel('Encoding').locator('option:checked')).toHaveText(
      'Windows-1258 (Vietnamese) (detected)',
    );
    await expect(wizard(page).getByLabel('Delimiter')).toHaveValue(';');
    await expect(wizard(page).getByText('First 200 of 1,000 rows').first()).toBeVisible();
    // The accents come out right.
    await expect(wizard(page).getByRole('cell', { name: 'Nguyễn Văn Ánh' }).first()).toBeVisible();
    await expect(wizard(page).getByRole('columnheader', { name: 'Trạng thái' })).toBeVisible();
    await expectNoSeriousA11yViolations(page, 'import preview');

    await wizard(page).getByRole('button', { name: 'Next' }).click();
    await expect(wizard(page).getByLabel('Field type for column Số tiền')).toHaveValue('number');
    await expect(wizard(page).getByLabel('Field type for column Ngày đặt')).toHaveValue('datetime');
    await expect(wizard(page).getByLabel('Field type for column Trạng thái')).toHaveValue('select');
    await expect(wizard(page).getByLabel('Field type for column Đã giao')).toHaveValue('checkbox');
    await wizard(page).getByLabel('Table name').fill('Khách hàng 1258');
    await expectNoSeriousA11yViolations(page, 'import mapping');
    await wizard(page).getByRole('button', { name: 'Import 1,000 rows' }).click();

    await expect(wizard(page).getByRole('heading', { name: 'Import finished' })).toBeVisible({
      timeout: 60_000,
    });
    await expect(wizard(page).getByTestId('import-result-imported')).toHaveText('1,000');
    await expect(wizard(page).getByTestId('import-result-skipped')).toHaveText('0');
    await expectNoSeriousA11yViolations(page, 'import result');
    await wizard(page).getByRole('button', { name: 'Open the table' }).click();

    await expect(page.getByRole('heading', { level: 1, name: 'Khách hàng 1258' })).toBeVisible();
    await expect(
      page.locator('table[role="grid"] td[role="gridcell"]', { hasText: 'Nguyễn Văn Ánh' }).first(),
    ).toBeAttached();
    const tableId = new URL(page.url()).pathname.split('/')[4] ?? '';
    const fields = await ok<{ items: Field[] }>(page, 'GET', `/tables/${tableId}/fields`);
    expect(fields.items.map((field) => [field.name, field.type])).toEqual([
      ['Họ tên', 'text'],
      ['Số tiền', 'number'],
      ['Ngày đặt', 'datetime'],
      ['Trạng thái', 'select'],
      ['Đã giao', 'checkbox'],
    ]);
    const records = await ok<{ total: number; records: { fields: Record<string, unknown> }[] }>(
      page,
      'POST',
      `/tables/${tableId}/records/query?field_key_type=name&cell_format=text`,
      { limit: 2 },
    );
    expect(records.total).toBe(1000);
    expect(records.records[0]?.fields['Họ tên']).toBe('Nguyễn Văn Ánh');
    expect(records.records[1]?.fields['Trạng thái']).toBe('Đang giao');
    expect(cspViolations).toEqual([]);
  });

  test('appends an XLSX with a mapping; invalid rows go to a downloadable report', async ({
    page,
  }) => {
    await signIn(page, ADMIN.email, ADMIN.password);
    await page.goto(tablePath(ids.productsId));
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Import into Sản phẩm…' }).click();
    await page.getByTestId('import-file-input').setInputFiles({
      name: 'san-pham.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: buildXlsx('Trang 1', [
        ['Tên sản phẩm', 'Giá', 'Mô tả', 'Mã kho'],
        ['Bàn gỗ', 1500000, 'Gỗ sồi', 'K1'],
        ['Ghế xoay', 'không rõ', 'Lưới', 'K2'],
        ['Tủ sách', 2300000, null, 'K1'],
        ['Kệ tivi', 'liên hệ', 'Gỗ óc chó', 'K3'],
        ['Đèn bàn', 350000, 'LED', 'K2'],
      ]),
    });
    await expect(wizard(page).getByLabel('Sheet')).toHaveValue('Trang 1');
    await expect(wizard(page).getByRole('cell', { name: 'Ghế xoay' })).toBeVisible();
    await wizard(page).getByRole('button', { name: 'Next' }).click();

    // "Giá" and "Mô tả" match fields; the name column is mapped by hand; "Mã kho" has no field.
    await expect(wizard(page).getByLabel('Field for column Giá')).toHaveValue(
      ids.fields['Giá'] ?? '',
    );
    await expect(wizard(page).getByLabel('Field for column Mô tả')).toHaveValue(
      ids.fields['Mô tả'] ?? '',
    );
    await expect(wizard(page).getByText('Not imported: no field with this name')).toHaveCount(2);
    await wizard(page).getByLabel('Field for column Tên sản phẩm').selectOption({ label: 'Name' });
    await expect(wizard(page).getByText('Not imported: no field with this name')).toHaveCount(1);
    await expectNoSeriousA11yViolations(page, 'import append mapping');
    await wizard(page).getByRole('button', { name: 'Import 5 rows' }).click();

    await expect(wizard(page).getByRole('heading', { name: 'Import finished' })).toBeVisible({
      timeout: 60_000,
    });
    await expect(wizard(page).getByTestId('import-result-imported')).toHaveText('3');
    await expect(wizard(page).getByTestId('import-result-skipped')).toHaveText('2');
    const errorRows = wizard(page).getByTestId('import-error-row');
    await expect(errorRows).toHaveCount(2);
    await expect(errorRows.nth(0)).toContainText('3');
    await expect(errorRows.nth(0)).toContainText('Giá');
    await expect(errorRows.nth(1)).toContainText('5');

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      wizard(page).getByRole('link', { name: 'Download the error report (CSV)' }).click(),
    ]);
    const report = (await readFile(await download.path())).toString('utf8').replace(/^\uFEFF/u, '');
    const lines = report.trim().split(/\r?\n/u);
    expect(lines[0]).toBe('row,column,column_name,field_id,code,data_row,value');
    expect(lines.slice(1).map((line) => line.split(',')[0])).toEqual(['3', '5']);
    // The rejected value, and the data row as the preview numbers it (T320).
    expect(lines.slice(1).map((line) => line.split(',').slice(4))).toEqual([
      ['EXPECTED_NUMBER', '2', 'không rõ'],
      ['EXPECTED_NUMBER', '4', 'liên hệ'],
    ]);

    // The grid behind shows the new rows (realtime `record.batch`, or the refresh on close).
    await wizard(page).getByRole('button', { name: 'Done' }).click();
    await expect(
      page.locator('table[role="grid"] td[role="gridcell"]', { hasText: 'Đèn bàn' }).first(),
    ).toBeAttached();
  });

  test('cancels a running import after confirmation; the new table goes to the trash', async ({
    page,
  }) => {
    await signIn(page, ADMIN.email, ADMIN.password);
    await page.goto(tablePath(ids.ordersId));
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Import as a new table…' }).click();
    const lines = ['Mã;Tên;Số lượng'];
    for (let i = 0; i < 50_000; i += 1) lines.push(`M${String(i)};Hàng ${String(i)};${String(i)}`);
    await page.getByTestId('import-file-input').setInputFiles({
      name: 'lon.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(lines.join('\n'), 'utf8'),
    });
    await wizard(page).getByRole('button', { name: 'Next' }).click();
    await wizard(page).getByLabel('Table name').fill(`Huỷ ${RUN}`);
    await wizard(page).getByRole('button', { name: 'Import 50,000 rows' }).click();
    await expect(wizard(page).getByRole('heading', { name: 'Importing' })).toBeVisible();

    await wizard(page).getByRole('button', { name: 'Cancel import' }).click();
    const confirm = wizard(page).getByRole('alertdialog', { name: 'Cancel this import?' });
    await expect(confirm).toContainText('go to the trash');
    await expect(confirm.getByRole('button', { name: 'Keep importing' })).toBeFocused();
    await confirm.getByRole('button', { name: 'Cancel import' }).click();

    await expect(wizard(page).getByText('The import was cancelled.')).toBeVisible();
    await expect(wizard(page).getByText(/moved to the trash/u)).toBeVisible();
    // Once the worker stopped, the table it created is in the trash.
    await expect
      .poll(
        async () => {
          const tables = await api<{ items: { name: string }[] }>(
            page,
            'GET',
            `/bases/${ids.baseId}/tables`,
          );
          if (tables.status !== 200) return 'unknown';
          return tables.body.items.some((table) => table.name === `Huỷ ${RUN}`);
        },
        { timeout: 30_000, intervals: [1000, 2000] },
      )
      .toBe(false);
  });

  test('Sales exports their view as CSV: only their rows and the columns of the view', async ({
    browser,
  }) => {
    const page = await openAs(browser, SALES.email, SALES.password);
    const cspViolations = collectCspViolations(page);
    await page.goto(salesViewPath());
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await expect(page.getByText(/with its saved filter, sort and hidden fields/u)).toBeVisible();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('menuitem', { name: 'CSV (.csv)' }).click(),
    ]);
    await expect(page.getByText(/Exporting Đơn của tôi as CSV/u)).toBeVisible();
    expect(download.suggestedFilename()).toMatch(/\.csv$/u);
    const csv = (await readFile(await download.path())).toString('utf8');
    expect(csv.startsWith('\uFEFF')).toBe(true);
    const rows = csv.slice(1).trim().split('\r\n');
    // No cost (no_perm), no note (hidden in the view); only r1 (read_scope editable).
    expect(rows[0]).toBe('Name,Số tiền,Phụ trách');
    expect(rows.slice(1)).toEqual([`Đơn r1,1200,${SALES.name}`]);

    // Refusals before the first byte come back as problem+json in the hidden frame: a toast,
    // the page stays. (Answered by the test: a real 429/422 needs a concurrent or huge export.)
    const refusals = [
      {
        status: 429,
        body: { code: 'RATE_LIMITED', status: 429, title: 'Too Many Requests' },
        message: 'Another export of yours is still running. Try again when it has finished.',
      },
      {
        status: 422,
        body: {
          code: 'VALIDATION_FAILED',
          status: 422,
          title: 'Unprocessable',
          errors: [{ path: '', code: 'EXPORT_TOO_LARGE', message: '', params: { limit: 1000000 } }],
        },
        message: 'Too many records to export: at most 1000000.',
      },
    ];
    for (const refusal of refusals) {
      await page.route('**/api/v1/tables/*/export?*', (route) =>
        route.fulfill({
          status: refusal.status,
          contentType: 'application/problem+json',
          body: JSON.stringify(refusal.body),
        }),
      );
      const button = page.getByRole('button', { name: 'Export', exact: true });
      await expect(button).toBeEnabled({ timeout: 10_000 });
      await button.click();
      await page.getByRole('menuitem', { name: 'Excel (.xlsx)' }).click();
      await expect(page.getByText(refusal.message).first()).toBeVisible();
      await page.unroute('**/api/v1/tables/*/export?*');
    }
    expect(new URL(page.url()).pathname).toBe(salesViewPath());

    // Sales may append to Orders (edit + add) but not create tables.
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: /Import as a new table/u })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await page.keyboard.press('Escape');
    expect(cspViolations).toEqual([]);
    await page.context().close();
  });

  test('a reader whose role may not download sees a disabled export with the reason', async ({
    browser,
  }) => {
    const page = await openAs(browser, READER.email, READER.password);
    await page.goto(salesViewPath());
    const exportButton = page.getByRole('button', { name: 'Export', exact: true });
    await expect(exportButton).toBeVisible();
    await expect(exportButton).toBeDisabled();
    await expect(exportButton).toHaveAccessibleDescription(
      'Your role does not allow downloading data from this base.',
    );
    // Still reachable from the keyboard: activating it repeats the reason, opens nothing.
    await exportButton.focus();
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('status').filter({ hasText: 'Your role does not allow downloading' }),
    ).toBeVisible();
    await expect(page.getByRole('menu')).toHaveCount(0);
    // Readers cannot import either: no import button.
    await expect(page.getByRole('button', { name: 'Import', exact: true })).toHaveCount(0);
    // Forced, the server refuses (P18).
    const refused = await api(page, 'GET', `/tables/${ids.ordersId}/export?format=csv`);
    expect(refused.status).toBe(403);
    await expectNoSeriousA11yViolations(page, 'view without download');
    await page.context().close();
  });

  test('the wizard speaks Vietnamese', async ({ page }) => {
    await signIn(page, ADMIN.email, ADMIN.password, 'vi');
    await page.goto(tablePath(ids.productsId));
    await page.getByRole('button', { name: 'Nhập', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Nhập vào Sản phẩm…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Nhập vào Sản phẩm' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Chọn tệp' })).toBeVisible();
    await expect(dialog.getByRole('list', { name: 'Các bước nhập dữ liệu' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Xuất', exact: true })).toBeVisible();
    await expectNoSeriousA11yViolations(page, 'import wizard (vi)');
  });
});
