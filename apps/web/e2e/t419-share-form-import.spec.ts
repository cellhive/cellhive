import { type Browser, type Locator, type Page } from '@playwright/test';

import { pngBytes, uploadFile } from './attachments';
import { expect, test, WORKER_ORG } from './fixtures';
import {
  apiSignIn,
  collectCspViolations,
  expectNoSeriousA11yViolations,
  ok,
  signInFirstAdmin,
} from './support';

/**
 * T419 — share dialog, form builder and import wizard with links and
 * attachments: turning attachment downloads on in the Share dialog (the
 * warning lists the downloadable file fields), the files of a shared grid
 * cell open in the viewer even when the link hides the record detail (grid
 * and cards at 375 px), a form cover image uploaded in the builder shows on
 * the public form, a refused upload says why, and the import wizard explains
 * link columns and reports unmatched titles. Self-contained: the first
 * administrator and a base of its own.
 */
const ADMIN = {
  name: 'Nguyễn Văn Ánh',
  email: WORKER_ORG.ownerEmail,
  password: 'E2E-Setup-Password-2026',
};
const RUN = String(Date.now());
const ORDER = 'Đơn có ảnh T419';
const PNG_NAME = 'Ảnh T419.png';

/** Layout of the shared grid (view `column_widths`): row numbers, then the columns. */
const MARKER = 40;
const WIDTH = { name: 240, images: 200 };
const HEADER_HEIGHT = 36;
const ROW_HEIGHT = 34;

const ids = {
  baseId: '',
  ordersId: '',
  customersId: '',
  gridViewId: '',
  formViewId: '',
  primaryId: '',
  imagesId: '',
  linkId: '',
  gridUrl: '',
};

async function english(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem('cellhive.language', 'en');
  });
}

async function signedIn(browser: Browser, viewport = { width: 1280, height: 900 }): Promise<Page> {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await english(page);
  await page.goto('/login');
  await apiSignIn(page, ADMIN.email, ADMIN.password);
  return page;
}

async function anonymous(browser: Browser, viewport = { width: 1280, height: 900 }): Promise<Page> {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await english(page);
  return page;
}

/** The natural width of an image once loaded (0 while loading or broken). */
async function loadedWidth(image: Locator): Promise<number> {
  return image.evaluate((element) => (element as HTMLImageElement).naturalWidth);
}

test.describe('T419 share, form and import with links and attachments', () => {
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
      name: `T419 ${RUN}`,
    });
    const base = await ok<{ id: string }>(page, 'POST', `/workspaces/${workspace.id}/bases`, {
      name: 'Hồ sơ T419',
    });
    ids.baseId = base.id;
    const orders = await ok<{ id: string }>(page, 'POST', `/bases/${base.id}/tables`, {
      name: 'Đơn hàng T419',
    });
    ids.ordersId = orders.id;
    const customers = await ok<{ id: string }>(page, 'POST', `/bases/${base.id}/tables`, {
      name: 'Khách hàng T419',
    });
    ids.customersId = customers.id;
    await ok(page, 'POST', `/tables/${customers.id}/records?field_key_type=name`, {
      records: [{ fields: { Name: 'Công ty An Phát' } }],
    });
    const field = (body: object) =>
      ok<{ id: string }>(page, 'POST', `/tables/${orders.id}/fields`, body);
    ids.imagesId = (await field({ name: 'Ảnh', type: 'attachment', options: { max_files: 3 } })).id;
    ids.linkId = (
      await field({ name: 'Khách', type: 'link', options: { link_table: customers.id } })
    ).id;
    ids.primaryId =
      (
        await ok<{ items: { id: string; is_primary: boolean }[] }>(
          page,
          'GET',
          `/tables/${orders.id}/fields`,
        )
      ).items.find((item) => item.is_primary)?.id ?? '';
    const png = await uploadFile(
      page,
      { tableId: orders.id, fieldId: ids.imagesId },
      { name: PNG_NAME, mime: 'image/png', bytes: pngBytes([30, 140, 90], 320, 200) },
    );
    await ok(page, 'POST', `/tables/${orders.id}/records?field_key_type=id`, {
      records: [{ fields: { [ids.primaryId]: ORDER, [ids.imagesId]: [{ id: png.id }] } }],
    });
    ids.gridViewId = (
      await ok<{ id: string }>(page, 'POST', `/tables/${orders.id}/views`, {
        name: 'Ảnh T419',
        type: 'grid',
        config: {
          field_order: [ids.primaryId, ids.imagesId, ids.linkId],
          hidden_fields: [ids.linkId],
          column_widths: { [ids.primaryId]: WIDTH.name, [ids.imagesId]: WIDTH.images },
        },
      })
    ).id;
    ids.formViewId = (
      await ok<{ id: string }>(page, 'POST', `/tables/${orders.id}/views`, {
        name: 'Gửi ảnh T419',
        type: 'form',
        config: {
          form: {
            title: 'Gửi ảnh sản phẩm',
            fields: [{ field: ids.primaryId, required: true }, { field: ids.imagesId }],
          },
        },
      })
    ).id;
    await page.close();
  });

  test('share dialog: downloads on, the file fields are listed; the grid cell opens the viewer without the record detail', async ({
    browser,
  }) => {
    const page = await signedIn(browser);
    const csp = collectCspViolations(page);
    await page.goto(`/b/${ids.baseId}/t/${ids.ordersId}/v/${ids.gridViewId}`);
    await page.getByRole('button', { name: 'Share view Ảnh T419' }).click();
    const dialog = page.getByRole('dialog', { name: 'Share “Ảnh T419”' });
    const warning = dialog.getByTestId('share-scope-warning');
    await expect(warning.getByTestId('share-scope-downloads')).toContainText(
      'The file field shows thumbnails only',
    );
    await dialog.getByRole('radio', { name: 'Anyone with the link' }).check();
    const options = dialog.getByTestId('share-options');
    await options.getByRole('checkbox', { name: 'Open a record to see all its fields' }).uncheck();
    await options.getByRole('checkbox', { name: 'Download attachments' }).check();
    const downloads = warning.getByTestId('share-scope-downloads');
    await expect(downloads).toContainText('Files anyone with the link can download:');
    await expect(downloads.getByRole('listitem')).toHaveText(['Ảnh']);
    await expectNoSeriousA11yViolations(page, 'share dialog with downloads');
    await dialog
      .getByRole('checkbox', { name: 'I understand who will be able to see this data' })
      .check();
    await dialog.getByRole('button', { name: 'Create link' }).click();
    const address = dialog.getByRole('textbox', { name: 'Link address' });
    await expect(address).toHaveValue(/\/s\/[\w-]{20,}$/u);
    ids.gridUrl = new URL(await address.inputValue()).pathname;
    // The link exists: downloads are a switch now.
    await expect(options.getByRole('switch', { name: 'Download attachments' })).toBeChecked();
    expect(csp).toEqual([]);
    await page.context().close();

    const visitor = await anonymous(browser);
    await visitor.goto(ids.gridUrl);
    const canvas = visitor.locator('.ob-grid canvas').first();
    await expect(canvas).toBeVisible();
    await expect(visitor.getByText('1 record', { exact: true })).toBeVisible();
    const box = await canvas.boundingBox();
    if (box === null) throw new Error('no grid canvas');
    await visitor.mouse.click(
      box.x + MARKER + WIDTH.name + WIDTH.images / 2,
      box.y + HEADER_HEIGHT + ROW_HEIGHT / 2,
    );
    await visitor.keyboard.press('Enter');
    const viewer = visitor.getByTestId('attachment-lightbox');
    await expect(viewer).toBeVisible();
    await expect(viewer).toContainText(PNG_NAME);
    const download = visitor.getByTestId('attachment-lightbox-download');
    await expect(download).toHaveAttribute('href', /^\/api\/v1\/shares\/[\w-]+\/files\/att_/u);
    await expectNoSeriousA11yViolations(visitor, 'shared grid viewer');
    await visitor.keyboard.press('Escape');
    await expect(viewer).toBeHidden();
    // No record detail through this link.
    await expect(visitor.getByRole('dialog')).toHaveCount(0);
    await visitor.context().close();
  });

  test('on a phone, the files of a card open the viewer', async ({ browser }) => {
    const visitor = await anonymous(browser, { width: 375, height: 800 });
    await visitor.goto(ids.gridUrl);
    const files = visitor.getByRole('button', { name: 'Ảnh: view 1 file' });
    await expect(files).toBeVisible();
    await expectNoSeriousA11yViolations(visitor, 'shared cards with files');
    await files.click();
    await expect(visitor.getByTestId('attachment-lightbox')).toBeVisible();
    await expect(visitor.getByTestId('attachment-lightbox-download')).toBeVisible();
    await visitor.context().close();
  });

  test('form builder: a cover image and what the file question takes; the public form shows the cover', async ({
    browser,
  }) => {
    const page = await signedIn(browser);
    const csp = collectCspViolations(page);
    await page.goto(`/b/${ids.baseId}/t/${ids.ordersId}/v/${ids.formViewId}?form=build`);
    const settings = page
      .getByTestId('form-builder-question')
      .filter({ hasText: 'Ảnh' })
      .getByTestId('form-question-settings');
    await expect(settings).toContainText('At most 3 files (through a link: 3)');
    await expect(settings).toContainText('100 MB per file');
    await page.getByTestId('form-cover-input').setInputFiles({
      name: 'bìa.png',
      mimeType: 'image/png',
      buffer: pngBytes([200, 120, 40], 800, 200),
    });
    const cover = page.getByTestId('form-builder-cover');
    await expect(cover).toBeVisible();
    await expect.poll(() => loadedWidth(cover)).toBeGreaterThan(0);
    await expect(page.getByTestId('form-save-state')).toHaveText('All changes saved');
    await expect(page.getByRole('button', { name: 'Change image' })).toBeVisible();
    await expectNoSeriousA11yViolations(page, 'form builder with cover and file settings');
    expect(csp).toEqual([]);
    const link = await ok<{ token: string }>(page, 'POST', `/views/${ids.formViewId}/share-links`, {
      audience: 'public',
    });
    await page.context().close();

    const visitor = await anonymous(browser, { width: 375, height: 800 });
    const visitorCsp = collectCspViolations(visitor);
    await visitor.goto(`/s/${link.token}`);
    await expect(
      visitor.getByRole('heading', { level: 1, name: 'Gửi ảnh sản phẩm' }),
    ).toBeVisible();
    const shown = visitor.getByTestId('form-cover');
    await expect(shown).toBeVisible();
    await expect.poll(() => loadedWidth(shown)).toBeGreaterThan(0);
    // The file question says what it takes, with the link's limits.
    await expect(visitor.getByTestId('form-question').filter({ hasText: 'Ảnh' })).toContainText(
      'At most 3 files · up to 100 MB per file · 100 MB in all per submission',
    );
    await expectNoSeriousA11yViolations(visitor, 'public form with cover');

    // A refused upload says why (here: the files of the submission are too large together).
    await visitor.route('**/api/v1/shares/*/uploads', (route) =>
      route.fulfill({
        status: 422,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'https://cellhive.io/errors/VALIDATION_FAILED',
          title: 'Validation failed',
          status: 422,
          code: 'VALIDATION_FAILED',
          errors: [
            {
              path: 'size',
              code: 'UPLOAD_LIMIT_EXCEEDED',
              message: 'Too large together',
              params: { limit: 100 * 1024 * 1024 },
            },
          ],
          request_id: 'req_0123456789ABCDEF',
        }),
      }),
    );
    await visitor
      .getByTestId('form-question')
      .filter({ hasText: 'Ảnh' })
      .locator('input[type="file"]')
      .setInputFiles({ name: 'lớn.png', mimeType: 'image/png', buffer: pngBytes([1, 2, 3]) });
    await expect(visitor.getByTestId('form-upload-issue')).toHaveText(
      'The files of this submission go over 100 MB in all. Remove some files, then try again.',
    );
    await visitor.unroute('**/api/v1/shares/*/uploads');
    await visitor.getByRole('button', { name: 'Dismiss lớn.png' }).click();

    // An anonymous submission with a photo reaches the administrator's grid live.
    const admin = await signedIn(browser);
    const subscribed = admin.waitForEvent('websocket').then(
      (socket) =>
        new Promise<void>((resolve) => {
          socket.on('framereceived', (frame) => {
            const payload = typeof frame.payload === 'string' ? frame.payload : '';
            if (payload.includes('"subscribed"') && payload.includes(`table:${ids.ordersId}`)) {
              resolve();
            }
          });
        }),
    );
    await admin.goto(`/b/${ids.baseId}/t/${ids.ordersId}/v/${ids.gridViewId}`);
    const count = admin.getByRole('status').filter({ hasText: /records?$/u });
    await expect(count).toHaveText(/^1 record$/u);
    await subscribed;
    const photo = visitor.getByTestId('form-question').filter({ hasText: 'Ảnh' });
    await visitor
      .getByTestId('form-question')
      .filter({ hasText: 'Name' })
      .getByRole('textbox')
      .fill('Đơn ẩn danh T419');
    await photo.locator('input[type="file"]').setInputFiles({
      name: 'sản phẩm.png',
      mimeType: 'image/png',
      buffer: pngBytes([90, 60, 200], 400, 300),
    });
    await expect(photo.getByTestId('form-file')).toContainText('sản phẩm.png');
    await visitor.getByRole('button', { name: 'Submit' }).click();
    await expect(visitor.getByRole('heading', { name: 'Response sent' })).toBeVisible();
    // Realtime: the new row is announced in the open grid, then shown.
    const pill = admin.getByTestId('new-rows-pill');
    await expect(pill).toHaveText('1 new row');
    await pill.click();
    await expect(count).toHaveText(/^2 records$/u);
    const created = await ok<{ records: { fields: Record<string, unknown> }[] }>(
      admin,
      'POST',
      `/tables/${ids.ordersId}/records/query?field_key_type=id`,
      {
        filter: {
          op: 'and',
          items: [{ field: ids.primaryId, operator: 'eq', value: 'Đơn ẩn danh T419' }],
        },
      },
    );
    expect(created.records[0]?.fields[ids.imagesId]).toEqual([
      expect.objectContaining({ name: 'sản phẩm.png', mime: 'image/png' }),
    ]);
    expect(visitorCsp).toEqual([]);
    await admin.context().close();
    await visitor.context().close();
  });

  test('import wizard: link columns explained, files listed as not importable, unmatched titles reported', async ({
    browser,
  }) => {
    const page = await signedIn(browser, { width: 1600, height: 900 });
    await page.goto(`/b/${ids.baseId}/t/${ids.ordersId}`);
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Import into Đơn hàng T419…' }).click();
    const rows = ['Name,Khách,Ảnh', 'Đơn 1,Công ty An Phát,a.png', 'Đơn 2,Không có ai,'];
    await page.getByTestId('import-file-input').setInputFiles({
      name: 'don-hang.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(`${rows.join('\r\n')}\r\n`, 'utf8'),
    });
    const wizard = page.getByTestId('import-wizard');
    await wizard.getByRole('button', { name: 'Next' }).click();
    const hint = wizard.getByTestId('import-title-hint');
    await expect(hint).toContainText('Khách → Khách: titles of records of Khách hàng T419');
    await expect(hint).toContainText('separate the titles with commas');
    const photos = wizard.getByLabel('Field for column Ảnh').locator('option', { hasText: 'Ảnh' });
    await expect(photos).toBeDisabled();
    await expect(wizard.getByTestId('import-files-note')).toContainText('Ảnh holds files');
    await expectNoSeriousA11yViolations(page, 'import mapping with link hints');
    await wizard.getByRole('button', { name: 'Import 2 rows' }).click();
    await expect(wizard.getByRole('heading', { name: 'Import finished' })).toBeVisible({
      timeout: 60_000,
    });
    // T421b: only the counts that are not zero.
    await expect(wizard.getByTestId('import-link-summary')).toHaveText(
      '1 linked record not found.',
    );
    const error = wizard.getByTestId('import-error-row');
    await expect(error).toHaveCount(1);
    await expect(error).toContainText('No record with this title');
    await expect(error).toContainText('Check the spelling');
    await expectNoSeriousA11yViolations(page, 'import result with unmatched titles');
    await page.context().close();
  });

  test('the new texts speak Vietnamese', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.localStorage.setItem('cellhive.language', 'vi');
    });
    await page.goto('/login');
    await apiSignIn(page, ADMIN.email, ADMIN.password);
    await page.goto(`/b/${ids.baseId}/t/${ids.ordersId}/v/${ids.formViewId}?form=build`);
    await expect(page.getByRole('button', { name: 'Đổi ảnh' })).toBeVisible();
    await expect(
      page
        .getByTestId('form-builder-question')
        .filter({ hasText: 'Ảnh' })
        .getByTestId('form-question-settings'),
    ).toContainText('Tối đa 3 tệp (qua link: 3)');
    await context.close();
  });
});
