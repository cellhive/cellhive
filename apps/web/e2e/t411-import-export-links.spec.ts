import { readFile } from 'node:fs/promises';

import { type Locator, type Page } from '@playwright/test';

import { pdfBytes, uploadFile } from './attachments';
import { expect, test, WORKER_ORG } from './fixtures';
import {
  apiSignIn,
  collectCspViolations,
  expectNoSeriousA11yViolations,
  ok,
  signInFirstAdmin,
} from './support';

/**
 * T411: link, parent and attachment cells in exports and imports. The
 * first administrator (created here when t011 did not run), a base with
 * "Khách hàng" (customers, two with the same name) and "Đơn hàng" (orders)
 * holding a link to customers and a file field: the export note and file
 * (titles, quoted list, file names), then an append import through the
 * wizard (link by title, file field not offered, ambiguous/unknown titles
 * reported with their codes).
 */
const ADMIN = {
  name: 'Nguyễn Văn Ánh',
  email: WORKER_ORG.ownerEmail,
  password: 'E2E-Setup-Password-2026',
};
const RUN = String(Date.now());

interface Field {
  id: string;
  name: string;
  type: string;
}

const ids = { baseId: '', ordersId: '', customersId: '', link: '', files: '' };
const tablePath = (tableId: string) => `/b/${ids.baseId}/t/${tableId}`;

async function signIn(page: Page, language = 'en') {
  await page.addInitScript((lng) => {
    window.localStorage.setItem('cellhive.language', lng);
  }, language);
  await page.goto('/login');
  await apiSignIn(page, ADMIN.email, ADMIN.password);
}

function wizard(page: Page): Locator {
  return page.getByTestId('import-wizard');
}

test.describe('T411 export/import of link and attachment cells', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ viewport: { width: 1600, height: 900 } });

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto('/login');
    // Any order of the specs (T470/T527): set up, signed in, or invited by the demo admin.
    // Signed in as them: no second sign-in. It would rotate the session while the
    // login page still boots with the first one, and the `401` of such a request
    // clears the new session cookie (the next call answers `401`).
    await signInFirstAdmin(page, ADMIN);
    const me = await ok<{ orgs: { id: string }[] }>(page, 'GET', '/me');
    const orgId = me.orgs[0]?.id ?? '';
    const workspace = await ok<{ id: string }>(page, 'POST', `/orgs/${orgId}/workspaces`, {
      name: `Liên kết ${RUN}`,
    });
    const base = await ok<{ id: string }>(page, 'POST', `/workspaces/${workspace.id}/bases`, {
      name: 'Bán hàng T411',
    });
    ids.baseId = base.id;
    const customers = await ok<{ id: string }>(page, 'POST', `/bases/${base.id}/tables`, {
      name: 'Khách hàng',
    });
    ids.customersId = customers.id;
    const orders = await ok<{ id: string }>(page, 'POST', `/bases/${base.id}/tables`, {
      name: 'Đơn hàng',
    });
    ids.ordersId = orders.id;
    const link = await ok<Field>(page, 'POST', `/tables/${orders.id}/fields`, {
      name: 'Khách',
      type: 'link',
      options: { link_table: customers.id },
    });
    ids.link = link.id;
    const files = await ok<Field>(page, 'POST', `/tables/${orders.id}/fields`, {
      name: 'Tệp',
      type: 'attachment',
    });
    ids.files = files.id;

    const created = await ok<{ records: { id: string; fields: { Name: string } }[] }>(
      page,
      'POST',
      `/tables/${customers.id}/records?field_key_type=name`,
      {
        records: ['An Phát', 'Nguyễn, An', 'Trùng tên', 'Trùng tên'].map((name) => ({
          fields: { Name: name },
        })),
      },
    );
    const customer = (name: string) =>
      created.records.find((record) => record.fields.Name === name)?.id ?? '';
    const file = await uploadFile(
      page,
      { tableId: orders.id, fieldId: files.id },
      { name: 'báo giá.pdf', mime: 'application/pdf', bytes: pdfBytes() },
    );
    await ok(page, 'POST', `/tables/${orders.id}/records?field_key_type=name`, {
      records: [
        {
          fields: {
            Name: 'Đơn 1',
            Khách: [customer('An Phát'), customer('Nguyễn, An')],
            Tệp: [{ id: file.id }],
          },
        },
      ],
    });
    await page.close();
  });

  test('exports link titles as a quoted list and files by name, and says so', async ({ page }) => {
    const cspViolations = collectCspViolations(page);
    await signIn(page);
    await page.goto(tablePath(ids.ordersId));
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await expect(page.getByTestId('export-relations-note')).toHaveText(
      'Linked records are written as the titles you can see, attachments as file names.',
    );
    await expectNoSeriousA11yViolations(page, 'export menu with relations note');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('menuitem', { name: 'CSV (.csv)' }).click(),
    ]);
    const csv = (await readFile(await download.path())).toString('utf8').replace(/^\uFEFF/u, '');
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('Name,Khách,Tệp');
    // The list `An Phát, "Nguyễn, An"` as one RFC 4180 cell.
    expect(lines[1]).toBe('Đơn 1,"An Phát, ""Nguyễn, An""",báo giá.pdf');
    expect(cspViolations).toEqual([]);
  });

  test('appends by title through the wizard; files are not offered; codes in the result', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto(tablePath(ids.ordersId));
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Import into Đơn hàng…' }).click();
    const rows = [
      'Name,Khách,Tệp',
      'Đơn 2,"An Phát, ""Nguyễn, An""",x.pdf',
      'Đơn 3,"Nguyễn, An",',
      'Đơn 4,Trùng tên,',
      'Đơn 5,Không có,',
    ];
    await page.getByTestId('import-file-input').setInputFiles({
      name: 'don-hang.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(`${rows.join('\r\n')}\r\n`, 'utf8'),
    });
    await wizard(page).getByRole('button', { name: 'Next' }).click();

    const linkSelect = wizard(page).getByLabel('Field for column Khách');
    await expect(linkSelect).toHaveValue(ids.link);
    await expect(
      wizard(page).getByText(
        'Fills Khách by record title; separate several titles with commas, quote a title that has a comma',
      ),
    ).toBeVisible();
    const filesSelect = wizard(page).getByLabel('Field for column Tệp');
    await expect(filesSelect).toHaveValue('');
    // T419: listed, disabled, with the reason — never selectable.
    await expect(filesSelect.locator('option', { hasText: 'Tệp' })).toHaveText(
      'Tệp (files cannot be imported)',
    );
    await expect(filesSelect.locator('option', { hasText: 'Tệp' })).toBeDisabled();
    await expect(
      wizard(page).getByText('Not imported: Tệp holds files, which cannot be imported'),
    ).toBeVisible();
    await expectNoSeriousA11yViolations(page, 'import mapping with link and file columns');
    await wizard(page).getByRole('button', { name: 'Import 4 rows' }).click();

    await expect(wizard(page).getByRole('heading', { name: 'Import finished' })).toBeVisible({
      timeout: 60_000,
    });
    await expect(wizard(page).getByTestId('import-result-imported')).toHaveText('2');
    await expect(wizard(page).getByTestId('import-result-skipped')).toHaveText('2');
    const errorRows = wizard(page).getByTestId('import-error-row');
    await expect(errorRows).toHaveCount(2);
    // T419: unmatched titles stand out with what to do about them.
    await expect(errorRows.nth(0)).toContainText('Several records have this title');
    await expect(errorRows.nth(1)).toContainText('No record with this title');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      wizard(page).getByRole('link', { name: 'Download the error report (CSV)' }).click(),
    ]);
    const report = (await readFile(await download.path())).toString('utf8').replace(/^\uFEFF/u, '');
    const lines = report.trim().split(/\r?\n/u);
    expect(lines.slice(1).map((line) => line.split(',').slice(4))).toEqual([
      ['LINK_TARGET_AMBIGUOUS', '3', 'Trùng tên'],
      ['LINK_TARGET_NOT_FOUND', '4', 'Không có'],
    ]);

    const listed = await ok<{ records: { fields: Record<string, string> }[] }>(
      page,
      'POST',
      `/tables/${ids.ordersId}/records/query?field_key_type=name&cell_format=text`,
      { limit: 10 },
    );
    const linksOf = (name: string) =>
      listed.records.find((record) => record.fields['Name'] === name)?.fields['Khách'];
    expect(linksOf('Đơn 2')).toBe('An Phát, "Nguyễn, An"');
    expect(linksOf('Đơn 3')).toBe('"Nguyễn, An"');
  });

  test('the new texts speak Vietnamese', async ({ page }) => {
    await signIn(page, 'vi');
    await page.goto(tablePath(ids.ordersId));
    await page.getByRole('button', { name: 'Xuất', exact: true }).click();
    await expect(page.getByTestId('export-relations-note')).toHaveText(
      'Bản ghi liên kết được ghi bằng tiêu đề bạn xem được, tệp đính kèm bằng tên tệp.',
    );
  });
});
