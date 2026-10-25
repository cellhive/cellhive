import { type Browser, type Page } from '@playwright/test';

import { pdfBytes } from './attachments';
import { expect, test, WORKER_ORG } from './fixtures';
import { apiSignIn, expectNoSeriousA11yViolations, ok, signInFirstAdmin } from './support';

/**
 * T410 — link and attachment questions of forms: a member fills in the form
 * view (link picker of T402, upload of T406), an `org` form link offers the
 * linked records as `{ id, title }` only, and a public form link hides the
 * link question but takes anonymous uploads bound to its submit token.
 * Self-contained: the first administrator and a base of its own.
 */
const ADMIN = {
  name: 'Nguyễn Văn Ánh',
  email: WORKER_ORG.ownerEmail,
  password: 'E2E-Setup-Password-2026',
};
const RUN = String(Date.now());
const CUSTOMERS = ['Công ty An Phát', 'Công ty Bình Minh'] as const;
const PDF_NAME = 'Hồ sơ T410.pdf';

interface RecordDto {
  id: string;
  fields: Record<string, unknown>;
}

const ids = {
  baseId: '',
  ordersId: '',
  formViewId: '',
  primaryId: '',
  customerId: '',
  docsId: '',
  publicToken: '',
  orgToken: '',
};

async function english(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem('cellhive.language', 'en');
  });
}

async function signedIn(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await english(page);
  await page.goto('/login');
  await apiSignIn(page, ADMIN.email, ADMIN.password);
  return page;
}

function question(page: Page, name: string) {
  return page.getByTestId('form-question').filter({ hasText: name });
}

/** The record of the orders table with this title, read by the administrator. */
async function orderTitled(page: Page, title: string): Promise<RecordDto | undefined> {
  const result = await ok<{ records: RecordDto[] }>(
    page,
    'POST',
    `/tables/${ids.ordersId}/records/query?field_key_type=id`,
    { filter: { op: 'and', items: [{ field: ids.primaryId, operator: 'eq', value: title }] } },
  );
  return result.records[0];
}

async function attach(page: Page, name: string): Promise<void> {
  await question(page, 'Hồ sơ')
    .locator('input[type="file"]')
    .setInputFiles({ name, mimeType: 'application/pdf', buffer: pdfBytes('T410') });
  await expect(question(page, 'Hồ sơ').getByTestId('form-file')).toContainText(name);
}

test.describe('T410 form questions: links and attachments', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto('/login');
    // Any order of the specs (T470/T527): set up, signed in, or invited by the demo admin.
    await signInFirstAdmin(page, ADMIN);
    const me = await ok<{ orgs: { id: string }[] }>(page, 'GET', '/me');
    const orgId = me.orgs[0]?.id ?? '';
    await ok(page, 'PATCH', `/orgs/${orgId}`, { settings: { public_sharing: 'allowed' } });
    const workspace = await ok<{ id: string }>(page, 'POST', `/orgs/${orgId}/workspaces`, {
      name: `Form files ${RUN}`,
    });
    const base = await ok<{ id: string }>(page, 'POST', `/workspaces/${workspace.id}/bases`, {
      name: 'Đơn đặt hàng',
    });
    ids.baseId = base.id;
    const orders = await ok<{ id: string }>(page, 'POST', `/bases/${base.id}/tables`, {
      name: 'Đơn hàng T410',
    });
    ids.ordersId = orders.id;
    const customers = await ok<{ id: string }>(page, 'POST', `/bases/${base.id}/tables`, {
      name: 'Khách hàng T410',
    });
    await ok(page, 'POST', `/tables/${customers.id}/records?field_key_type=name`, {
      records: CUSTOMERS.map((name) => ({ fields: { Name: name } })),
    });
    const field = (body: object) =>
      ok<{ id: string }>(page, 'POST', `/tables/${orders.id}/fields`, body);
    ids.customerId = (
      await field({
        name: 'Khách hàng',
        type: 'link',
        options: { link_table: customers.id, allow_multiple: false },
      })
    ).id;
    ids.docsId = (await field({ name: 'Hồ sơ', type: 'attachment' })).id;
    ids.primaryId =
      (
        await ok<{ items: { id: string; is_primary: boolean }[] }>(
          page,
          'GET',
          `/tables/${orders.id}/fields`,
        )
      ).items.find((item) => item.is_primary)?.id ?? '';
    const form = await ok<{ id: string }>(page, 'POST', `/tables/${orders.id}/views`, {
      name: 'Đặt hàng',
      type: 'form',
      config: {
        form: {
          title: 'Đặt hàng',
          fields: [
            { field: ids.primaryId, required: true },
            { field: ids.customerId },
            { field: ids.docsId },
          ],
        },
      },
    });
    ids.formViewId = form.id;
    const publicForm = await ok<{ id: string }>(page, 'POST', `/tables/${orders.id}/views`, {
      name: 'Đặt hàng (công khai)',
      type: 'form',
      config: {
        form: {
          title: 'Đặt hàng công khai',
          fields: [
            { field: ids.primaryId, required: true },
            { field: ids.customerId },
            { field: ids.docsId },
          ],
        },
      },
    });
    ids.publicToken = (
      await ok<{ token: string }>(page, 'POST', `/views/${publicForm.id}/share-links`, {
        audience: 'public',
      })
    ).token;
    const orgForm = await ok<{ id: string }>(page, 'POST', `/tables/${orders.id}/views`, {
      name: 'Đặt hàng (nội bộ)',
      type: 'form',
      config: {
        form: {
          title: 'Đặt hàng nội bộ',
          fields: [{ field: ids.primaryId, required: true }, { field: ids.customerId }],
        },
      },
    });
    ids.orgToken = (
      await ok<{ token: string }>(page, 'POST', `/views/${orgForm.id}/share-links`, {
        audience: 'org',
      })
    ).token;
    await page.close();
  });

  test('builder notes that link questions are hidden outside the organization', async ({
    browser,
  }) => {
    const page = await signedIn(browser);
    await page.goto(`/b/${ids.baseId}/t/${ids.ordersId}/v/${ids.formViewId}?form=build`);
    const card = page.getByTestId('form-builder-user-note');
    await expect(card).toHaveCount(1);
    await expect(card).toHaveText('Hidden from people outside the organization');
  });

  test('a member answers a link and a file question', async ({ browser }) => {
    const page = await signedIn(browser);
    await page.goto(`/b/${ids.baseId}/t/${ids.ordersId}/v/${ids.formViewId}?form=fill`);
    await expect(page.getByRole('heading', { level: 2, name: 'Đặt hàng' })).toBeVisible();
    await question(page, 'Name').getByRole('textbox').fill('Đơn thành viên');
    const customer = question(page, 'Khách hàng');
    await customer.getByRole('combobox').fill('Bình');
    await customer.getByRole('option').filter({ hasText: CUSTOMERS[1] }).click();
    await expect(customer.getByRole('list', { name: 'Picked records' })).toContainText(
      CUSTOMERS[1],
    );
    await attach(page, PDF_NAME);
    await expectNoSeriousA11yViolations(page, 'member form with link and file');
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByRole('heading', { name: 'Response sent' })).toBeVisible();

    const record = await orderTitled(page, 'Đơn thành viên');
    expect(record?.fields[ids.customerId]).toEqual([
      expect.objectContaining({ title: CUSTOMERS[1] }),
    ]);
    expect(record?.fields[ids.docsId]).toEqual([expect.objectContaining({ name: PDF_NAME })]);
  });

  test('an org form link offers the linked records by title', async ({ browser }) => {
    const page = await signedIn(browser);
    const candidates: string[] = [];
    page.on('response', (response) => {
      if (response.url().includes('/link-candidates/')) candidates.push(response.url());
    });
    await page.goto(`/s/${ids.orgToken}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Đặt hàng nội bộ' })).toBeVisible();
    await question(page, 'Name').getByRole('textbox').fill('Đơn nội bộ');
    const customer = question(page, 'Khách hàng');
    await customer.getByRole('combobox').click();
    await expect(customer.getByTestId('form-link-options').getByRole('option')).toHaveText([
      ...CUSTOMERS,
    ]);
    await customer.getByRole('option', { name: CUSTOMERS[0] }).click();
    expect(candidates.some((url) => url.includes(`/shares/${ids.orgToken}/`))).toBe(true);
    await page.getByRole('button', { name: 'Submit' }).click();
    await expect(page.getByRole('heading', { name: 'Response sent' })).toBeVisible();
    const record = await orderTitled(page, 'Đơn nội bộ');
    expect(record?.fields[ids.customerId]).toEqual([
      expect.objectContaining({ title: CUSTOMERS[0] }),
    ]);
  });

  test('a public form link hides the link question and takes an anonymous upload', async ({
    browser,
  }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const visitor = await context.newPage();
    await english(visitor);
    const paths: string[] = [];
    visitor.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname.startsWith('/api/')) paths.push(url.pathname);
    });
    await visitor.goto(`/s/${ids.publicToken}`);
    await expect(
      visitor.getByRole('heading', { level: 1, name: 'Đặt hàng công khai' }),
    ).toBeVisible();
    await expect(question(visitor, 'Hồ sơ')).toBeVisible();
    await expect(question(visitor, 'Khách hàng')).toHaveCount(0);
    await question(visitor, 'Name').getByRole('textbox').fill('Đơn công khai');
    await attach(visitor, PDF_NAME);
    await expectNoSeriousA11yViolations(visitor, 'public form with a file');
    await visitor.getByRole('button', { name: 'Submit' }).click();
    await expect(visitor.getByRole('heading', { name: 'Response sent' })).toBeVisible();
    expect(paths.filter((path) => path.startsWith('/api/v1/files'))).toEqual([]);
    expect(paths).toContain(`/api/v1/shares/${ids.publicToken}/uploads`);
    expect(paths.some((path) => path.includes('link-candidates'))).toBe(false);
    await context.close();

    const admin = await signedIn(browser);
    const record = await orderTitled(admin, 'Đơn công khai');
    expect(record?.fields[ids.docsId]).toEqual([expect.objectContaining({ name: PDF_NAME })]);
    expect(record?.fields[ids.customerId] ?? null).toBeNull();
  });
});
