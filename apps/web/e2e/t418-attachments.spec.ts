import { truncate, writeFile } from 'node:fs/promises';

import { type Browser, type Page } from '@playwright/test';

import { brokenPdfBytes, pdfBytes, pngBytes, uploadFile } from './attachments';
import { expect, test, WORKER_ORG } from './fixtures';
import {
  animationsSettled,
  apiSignIn,
  collectCspViolations,
  expectNoSeriousA11yViolations,
  ok,
  signInFirstAdmin,
  trackApiCalls,
} from './support';

/**
 * T418 (FE attachments, boards S4 "Ô tệp đính kèm và tải lên", "Xem ảnh
 * đính kèm", "Xem PDF và tệp khác", "Tệp trong chi tiết record", "Tệp trên
 * mobile"): files dropped on a grid cell upload with progress and show in
 * another tab, the panel uploads, reorders and removes (with undo), client
 * checks refuse files before any upload, a 50 MB upload shows progress and
 * can be cancelled, the viewer is driven by the keyboard, PDFs show in the
 * viewer with PDF.js (T407; never embedded, a new tab when they cannot be
 * shown), the kanban shows cover images, readers cannot upload and roles
 * without `file_download_fields` see thumbnails (T407) but get no download.
 * Self-contained: the first administrator, a base of its own, local storage.
 */
const ADMIN = {
  name: WORKER_ORG.ownerName,
  email: WORKER_ORG.ownerEmail,
  password: 'E2E-Setup-Password-2026',
};
const RUN = String(Date.now());
const READER = {
  name: 'Lê Thu Hà',
  email: `reader-t418-${RUN}@cellhive.test`,
  password: 'Reader-Password-2026',
};
const SALES = {
  name: 'Võ Đức Huy',
  email: `sales-t418-${RUN}@cellhive.test`,
  password: 'Sales-Password-2026',
};

/** Layout of the grid (view `column_widths`): row numbers, then the columns. */
const MARKER = 40;
const WIDTH = { name: 240, images: 180, docs: 190 };
const HEADER_HEIGHT = 36;
const ROW_HEIGHT = 34;

const ids = {
  orgId: '',
  baseId: '',
  tableId: '',
  viewId: '',
  kanbanId: '',
  records: {} as Record<string, string>,
  fields: { name: '', images: '', docs: '', status: '' },
};
const PRODUCTS = ['Máy in nhiệt 80mm', 'Giấy in K80', 'Két tiền 5 ngăn', 'Màn hình khách'];
const gridPath = () => `/b/${ids.baseId}/t/${ids.tableId}/v/${ids.viewId}`;
const recordPath = (name: string) => `${gridPath()}?record=${ids.records[name] ?? ''}`;

interface CellFileDto {
  id: string;
  name: string;
  mime: string;
  size: number;
  url: string;
}

async function openAs(
  browser: Browser,
  user: { email: string; password: string },
  viewport = { width: 1440, height: 900 },
) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.localStorage.setItem('cellhive.language', 'en');
  });
  await page.goto('/login');
  await apiSignIn(page, user.email, user.password);
  return page;
}

async function filesOf(page: Page, record: string, field: 'images' | 'docs') {
  const body = await ok<{ fields: Record<string, CellFileDto[] | null> }>(
    page,
    'GET',
    `/tables/${ids.tableId}/records/${ids.records[record] ?? ''}?field_key_type=id`,
  );
  return body.fields[ids.fields[field]] ?? [];
}

async function gridReady(page: Page) {
  await page.goto(gridPath());
  await expect(page.locator('.ob-grid canvas').first()).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: /records?$/u })).toBeVisible();
}

/** Screen point in the middle of a cell of data row `row` (0-based). */
async function cellPoint(page: Page, column: 'name' | 'images' | 'docs', row: number) {
  const box = await page.locator('.ob-grid canvas').first().boundingBox();
  if (box === null) throw new Error('no grid canvas');
  const left =
    column === 'name'
      ? MARKER
      : column === 'images'
        ? MARKER + WIDTH.name
        : MARKER + WIDTH.name + WIDTH.images;
  const width = WIDTH[column];
  return {
    x: box.x + left + width / 2,
    y: box.y + HEADER_HEIGHT + ROW_HEIGHT * row + ROW_HEIGHT / 2,
  };
}

/** Files dragged from the desktop over a point of the page (a `DataTransfer` of real `File`s). */
async function dragFilesOver(
  page: Page,
  point: { x: number; y: number },
  files: { name: string; mime: string; bytes: Buffer }[],
) {
  await page.evaluate(
    ({ point, files }) => {
      const transfer = new DataTransfer();
      for (const file of files) {
        const bytes = Uint8Array.from(atob(file.base64), (char) => char.charCodeAt(0));
        transfer.items.add(new File([bytes], file.name, { type: file.mime }));
      }
      (window as unknown as { __dragged: DataTransfer }).__dragged = transfer;
      const target = document.elementFromPoint(point.x, point.y);
      for (const type of ['dragenter', 'dragover']) {
        target?.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            clientX: point.x,
            clientY: point.y,
            dataTransfer: transfer,
          }),
        );
      }
    },
    {
      point,
      files: files.map((file) => ({
        name: file.name,
        mime: file.mime,
        base64: file.bytes.toString('base64'),
      })),
    },
  );
}

async function dropDragged(page: Page, point: { x: number; y: number }) {
  await page.evaluate((point) => {
    const transfer = (window as unknown as { __dragged: DataTransfer }).__dragged;
    document.elementFromPoint(point.x, point.y)?.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        clientX: point.x,
        clientY: point.y,
        dataTransfer: transfer,
      }),
    );
  }, point);
}

function section(page: Page, field: 'Photos' | 'Documents') {
  return page.getByTestId('attachment-section').filter({
    has: page.getByRole('heading', { name: field, exact: true }),
  });
}

async function invite(page: Page, browser: Browser, user: typeof READER): Promise<string> {
  const invitation = await ok<{ invite_url: string }>(
    page,
    'POST',
    `/orgs/${ids.orgId}/invitations`,
    { email: user.email, role: 'member' },
  );
  const token = new URL(invitation.invite_url).pathname.split('/').pop() ?? '';
  const guest = await browser.newContext();
  const guestPage = await guest.newPage();
  await guestPage.goto('/login');
  const accepted = await ok<{ user: { id: string } }>(
    guestPage,
    'POST',
    `/invitations/${token}/accept`,
    { display_name: user.name, password: user.password },
  );
  await guest.close();
  return accepted.user.id;
}

test.describe('T418 attachments', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto('/login');
    // Any order of the specs (T470/T527): set up, signed in, or invited by the demo admin.
    await signInFirstAdmin(page, ADMIN);
    const me = await ok<{ orgs: { id: string }[] }>(page, 'GET', '/me');
    ids.orgId = me.orgs[0]?.id ?? '';
    const workspace = await ok<{ id: string }>(page, 'POST', `/orgs/${ids.orgId}/workspaces`, {
      name: `T418 ${RUN}`,
    });
    const base = await ok<{ id: string }>(page, 'POST', `/workspaces/${workspace.id}/bases`, {
      name: 'Tệp T418',
    });
    ids.baseId = base.id;
    const table = await ok<{ id: string }>(page, 'POST', `/bases/${base.id}/tables`, {
      name: 'Products',
    });
    ids.tableId = table.id;
    const fields = await ok<{ items: { id: string }[] }>(page, 'GET', `/tables/${table.id}/fields`);
    ids.fields.name = fields.items[0]?.id ?? '';
    ids.fields.images = (
      await ok<{ id: string }>(page, 'POST', `/tables/${table.id}/fields`, {
        name: 'Photos',
        type: 'attachment',
        options: { accept: ['image/png', 'image/jpeg', 'image/webp'], max_files: 8 },
      })
    ).id;
    ids.fields.docs = (
      await ok<{ id: string }>(page, 'POST', `/tables/${table.id}/fields`, {
        name: 'Documents',
        type: 'attachment',
      })
    ).id;
    ids.fields.status = (
      await ok<{ id: string }>(page, 'POST', `/tables/${table.id}/fields`, {
        name: 'Status',
        type: 'select',
        options: { multiple: false, options: [{ name: 'On sale' }, { name: 'Retired' }] },
      })
    ).id;
    const created = await ok<{ records: { id: string }[] }>(
      page,
      'POST',
      `/tables/${table.id}/records?field_key_type=id`,
      {
        records: PRODUCTS.map((name) => ({
          fields: { [ids.fields.name]: name, [ids.fields.status]: 'On sale' },
        })),
      },
    );
    created.records.forEach((record, index) => {
      ids.records[PRODUCTS[index] ?? ''] = record.id;
    });
    const views = await ok<{ items: { id: string }[] }>(page, 'GET', `/tables/${table.id}/views`);
    ids.viewId = views.items[0]?.id ?? '';
    await ok(page, 'PATCH', `/views/${ids.viewId}`, {
      config: {
        column_widths: {
          [ids.fields.name]: WIDTH.name,
          [ids.fields.images]: WIDTH.images,
          [ids.fields.docs]: WIDTH.docs,
        },
      },
    });
    ids.kanbanId = (
      await ok<{ id: string }>(page, 'POST', `/tables/${table.id}/views`, {
        name: 'Gallery',
        type: 'kanban',
        config: { kanban: { group_field: ids.fields.status } },
      })
    ).id;

    // A reader (system role) and "Sales": edits the table, but may not download Photos.
    const roles = await ok<{ items: { id: string; kind: string }[] }>(
      page,
      'GET',
      `/bases/${base.id}/roles`,
    );
    const readerId = await invite(page, browser, READER);
    await ok(page, 'PUT', `/bases/${base.id}/role-assignments`, {
      principal_type: 'user',
      principal_id: readerId,
      role_id: roles.items.find((role) => role.kind === 'system_reader')?.id,
    });
    const sales = await ok<{ id: string }>(page, 'POST', `/bases/${base.id}/roles`, {
      name: `Sales ${RUN}`,
      config: {
        tables: {
          [table.id]: {
            perm: 'edit',
            view_rule: { allow_edit: false, visible_views: null },
            field_rule: {
              mode: 'specify',
              fields: {
                [ids.fields.name]: 'edit',
                [ids.fields.images]: 'edit',
                [ids.fields.docs]: 'edit',
                [ids.fields.status]: 'edit',
              },
              option_edit_fields: [],
              file_download_fields: [ids.fields.docs],
            },
          },
        },
      },
    });
    const salesId = await invite(page, browser, SALES);
    await ok(page, 'PUT', `/bases/${base.id}/role-assignments`, {
      principal_type: 'user',
      principal_id: salesId,
      role_id: sales.id,
    });
    await page.close();
  });

  test('three images dropped on a cell upload with progress and show in another tab', async ({
    browser,
  }) => {
    const page = await openAs(browser, ADMIN);
    const other = await openAs(browser, ADMIN);
    const cspViolations = collectCspViolations(page);
    await gridReady(page);
    // The other tab shows the record: the images must arrive there by realtime.
    await other.goto(recordPath(PRODUCTS[0] ?? ''));
    await expect(section(other, 'Photos')).toBeVisible();
    await expect(section(other, 'Photos').getByTestId('attachment-count')).toHaveText(
      '0 / 8 files',
    );

    const point = await cellPoint(page, 'images', 0);
    await dragFilesOver(page, point, [
      { name: 'mat-truoc.png', mime: 'image/png', bytes: pngBytes([185, 203, 199], 320, 240) },
      { name: 'canh-ben.png', mime: 'image/png', bytes: pngBytes([213, 198, 176], 320, 240) },
      { name: 'khay-giay.png', mime: 'image/png', bytes: pngBytes([188, 200, 218], 320, 240) },
    ]);
    // Board: a dashed outline over the cell, "Drop to upload 3 files".
    await expect(page.getByTestId('grid-drop-target')).toHaveText('Drop to upload 3 files');
    await dropDragged(page, point);
    await expect(page.getByTestId('grid-drop-target')).toBeHidden();

    // The popover opens on the cell with the uploads, then the files.
    const popover = page.getByTestId('attachment-popover');
    await expect(popover).toBeVisible();
    await expect(popover.getByTestId('attachment-row')).toHaveCount(3, { timeout: 15_000 });
    await expect(popover.getByTestId('attachment-count')).toHaveText('3 / 8 files');
    // T421b: the uploading tab draws its own copies at once, never a placeholder waiting
    // for a thumbnail asked before the cell write.
    await expect
      .poll(() =>
        popover
          .getByTestId('attachment-row')
          .locator('img')
          .evaluateAll((images) =>
            images.map(
              (image) =>
                `${(image.getAttribute('src') ?? '').slice(0, 5)} ${String((image as HTMLImageElement).naturalWidth)}`,
            ),
          ),
      )
      .toEqual(['blob: 320', 'blob: 320', 'blob: 320']);
    await expectNoSeriousA11yViolations(page, 'attachment popover');

    const files = await filesOf(page, PRODUCTS[0] ?? '', 'images');
    expect(files.map((file) => file.name).sort()).toEqual([
      'canh-ben.png',
      'khay-giay.png',
      'mat-truoc.png',
    ]);
    // The other tab: three cards with their images loaded through `thumbnail_url` (T407):
    // the 256 px WebP once the worker rendered it, the original (320 px) until then.
    const tiles = section(other, 'Photos').getByTestId('attachment-tile');
    await expect(tiles).toHaveCount(3, { timeout: 5000 });
    await expect
      .poll(() =>
        tiles
          .locator('img')
          .evaluateAll((images) =>
            images.every((image) => [256, 320].includes((image as HTMLImageElement).naturalWidth)),
          ),
      )
      .toBe(true);
    expect(
      (
        await tiles
          .locator('img')
          .evaluateAll((images) => images.map((image) => image.getAttribute('src') ?? ''))
      ).sort(),
    ).toEqual(files.map((file) => `/api/v1/files/${file.id}/thumbnail`).sort());
    // The worker renders the thumbnails (T407): WebP, 256 px wide.
    for (const file of files) {
      await expect
        .poll(() =>
          page.evaluate(async (url) => {
            const response = await fetch(url, { credentials: 'include', redirect: 'manual' });
            return `${String(response.status)} ${response.headers.get('content-type') ?? ''}`;
          }, `/api/v1/files/${file.id}/thumbnail`),
        )
        .toBe('200 image/webp');
    }
    expect(cspViolations).toEqual([]);
    await page.context().close();
    await other.context().close();
  });

  test('the viewer is driven by the keyboard; Escape gives the focus back', async ({ browser }) => {
    const page = await openAs(browser, ADMIN);
    await page.goto(recordPath(PRODUCTS[0] ?? ''));
    const photos = section(page, 'Photos');
    await expect(photos.getByTestId('attachment-tile')).toHaveCount(3);
    const [first] = await filesOf(page, PRODUCTS[0] ?? '', 'images');
    const opener = photos.getByRole('button', { name: `View ${first?.name ?? ''}` });
    await opener.click();
    const viewer = page.getByTestId('attachment-lightbox');
    await expect(viewer).toBeVisible();
    await expect(viewer.getByRole('img', { name: first?.name ?? '' })).toBeVisible();
    await expect(page.getByTestId('attachment-lightbox-index')).toHaveText('1 / 3');
    await expectNoSeriousA11yViolations(page, 'attachment viewer');

    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('attachment-lightbox-index')).toHaveText('2 / 3');
    await page.keyboard.press('End');
    await expect(page.getByTestId('attachment-lightbox-index')).toHaveText('3 / 3');
    // Wraps around, like the board's arrows on both sides.
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('attachment-lightbox-index')).toHaveText('1 / 3');
    // Zoom with + / −.
    const zoom = viewer.getByText(/^\d+%$/u);
    const before = await zoom.textContent();
    await page.keyboard.press('+');
    await expect(zoom).not.toHaveText(before ?? '');
    // Tab stays inside the dialog (native modal dialog).
    for (let index = 0; index < 12; index += 1) await page.keyboard.press('Tab');
    expect(
      await page.evaluate(
        () => document.activeElement?.closest('[data-testid="attachment-lightbox"]') !== null,
      ),
    ).toBe(true);
    await page.keyboard.press('Escape');
    await expect(viewer).toBeHidden();
    await expect(opener).toBeFocused();
    await page.context().close();
  });

  test('the panel uploads a PDF, shown in the viewer with PDF.js, never embedded (T407)', async ({
    browser,
  }) => {
    const page = await openAs(browser, ADMIN);
    const cspViolations = collectCspViolations(page);
    await page.goto(recordPath(PRODUCTS[1] ?? ''));
    const docs = section(page, 'Documents');
    const chooser = page.waitForEvent('filechooser');
    await docs.getByRole('button', { name: 'Upload' }).click();
    await (
      await chooser
    ).setFiles({
      name: 'huong-dan-lap-dat.pdf',
      mimeType: 'application/pdf',
      buffer: pdfBytes('guide', 2),
    });
    await expect(docs.getByTestId('attachment-row')).toHaveCount(1);
    await expect(docs.getByTestId('attachment-row')).toContainText('huong-dan-lap-dat.pdf');

    // PDF.js is a chunk of its own, requested only when a PDF is opened.
    const pdfChunks: string[] = [];
    page.on('request', (request) => {
      if (/PdfViewer|pdf\.worker/u.test(request.url())) pdfChunks.push(request.url());
    });
    await docs.getByRole('button', { name: 'View huong-dan-lap-dat.pdf' }).click();
    const viewer = page.getByTestId('attachment-pdf-viewer');
    await expect(viewer).toBeVisible();
    const position = page.getByTestId('attachment-pdf-position');
    await expect(position).toHaveText('Page 1 / 2');
    await expect(
      page.getByRole('img', { name: 'Page 1 of 2, huong-dan-lap-dat.pdf' }),
    ).toBeVisible();
    expect(pdfChunks.some((url) => url.includes('PdfViewer'))).toBe(true);
    expect(pdfChunks.some((url) => url.includes('pdf.worker'))).toBe(true);
    // Everything from the app's own origin (no CDN).
    expect(pdfChunks.every((url) => new URL(url).origin === new URL(page.url()).origin)).toBe(true);
    await page.keyboard.press('PageDown');
    await expect(position).toHaveText('Page 2 / 2');
    await page.keyboard.press('PageUp');
    await expect(position).toHaveText('Page 1 / 2');
    await page.keyboard.press('+');
    await expect(viewer.getByText('125%')).toBeVisible();
    await page.keyboard.press('0');
    await expect(viewer.getByText('100%')).toBeVisible();
    await expect(page.getByTestId('attachment-lightbox-download')).toBeVisible();
    expect(await page.locator('iframe, object, embed').count()).toBe(0);
    await expectNoSeriousA11yViolations(page, 'pdf viewer');
    await animationsSettled(page);
    await page.screenshot({ path: 'test-results/t407-pdf-viewer.png' });
    await page.keyboard.press('Escape');
    expect(cspViolations).toEqual([]);
    await page.context().close();
  });

  test('a PDF the viewer cannot show falls back to a new tab, never embedded', async ({
    browser,
  }) => {
    const page = await openAs(browser, ADMIN);
    await page.goto(recordPath(PRODUCTS[1] ?? ''));
    const docs = section(page, 'Documents');
    const chooser = page.waitForEvent('filechooser');
    await docs.getByRole('button', { name: 'Upload' }).click();
    await (
      await chooser
    ).setFiles({ name: 'hong.pdf', mimeType: 'application/pdf', buffer: brokenPdfBytes() });
    await expect(docs.getByTestId('attachment-row')).toHaveCount(2);
    await docs.getByRole('button', { name: 'View hong.pdf' }).click();
    const card = page.getByTestId('attachment-file-card');
    await expect(card).toContainText('The PDF could not be shown here.');
    expect(await page.locator('iframe, object, embed').count()).toBe(0);
    const popup = page.waitForEvent('popup');
    await card.getByRole('button', { name: 'Open in a new tab' }).click();
    const tab = await popup;
    // The new tab gets a `blob:` copy typed application/pdf: Chrome shows it in its PDF
    // viewer, headless Chromium (no viewer) downloads it — never the storage URL itself.
    const opened = await Promise.race([
      // A download aborts the navigation: only the download settles the race then.
      tab.waitForURL(/^blob:/u).then(
        () => tab.url(),
        () => new Promise<string>(() => undefined),
      ),
      tab.waitForEvent('download').then((download) => download.url()),
    ]);
    expect(opened).toMatch(/^blob:/u);
    await tab.close();
    await page.keyboard.press('Escape');
    await page.context().close();
  });

  test('files are checked before any upload: size, blocked type, accepted types', async ({
    browser,
  }, testInfo) => {
    const page = await openAs(browser, ADMIN);
    const presigns: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/v1/files/uploads') && request.method() === 'POST') {
        presigns.push(request.url());
      }
    });
    await page.goto(recordPath(PRODUCTS[2] ?? ''));
    // 101 MB, sparse on disk.
    const big = testInfo.outputPath('video-huong-dan.mp4');
    await writeFile(big, '');
    await truncate(big, 101 * 1024 * 1024);

    const docs = section(page, 'Documents');
    let chooser = page.waitForEvent('filechooser');
    await docs.getByRole('button', { name: 'Upload' }).click();
    const exe = testInfo.outputPath('setup-driver.exe');
    await writeFile(exe, 'MZ');
    await (await chooser).setFiles([big, exe]);
    const errors = docs.getByTestId('attachment-upload-error');
    await expect(errors).toHaveText([
      '101 MB, over the limit of 100 MB per file',
      '.exe files are blocked for this field',
    ]);

    const photos = section(page, 'Photos');
    chooser = page.waitForEvent('filechooser');
    await photos.getByRole('button', { name: 'Upload' }).click();
    await (
      await chooser
    ).setFiles({ name: 'bang-gia.pdf', mimeType: 'application/pdf', buffer: pdfBytes() });
    await expect(photos.getByTestId('attachment-upload-error')).toHaveText(
      'This field only accepts PNG, JPG, WEBP',
    );
    expect(presigns).toEqual([]);
    await expectNoSeriousA11yViolations(page, 'refused uploads');
    // Dismissing leaves nothing.
    await photos.getByRole('button', { name: 'Dismiss bang-gia.pdf' }).click();
    await expect(photos.getByTestId('attachment-upload')).toHaveCount(0);
    expect(await filesOf(page, PRODUCTS[2] ?? '', 'docs')).toEqual([]);
    await page.context().close();
  });

  test('a 50 MB upload shows its progress and can be cancelled: nothing is attached', async ({
    browser,
  }, testInfo) => {
    const page = await openAs(browser, ADMIN);
    await page.goto(recordPath(PRODUCTS[2] ?? ''));
    const file = testInfo.outputPath('ban-ve.bin');
    await writeFile(file, '');
    await truncate(file, 50 * 1024 * 1024);
    // Slow uplink (4 MB/s): the upload takes long enough to watch and cancel.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 20,
      downloadThroughput: -1,
      uploadThroughput: 4 * 1024 * 1024,
    });
    const docs = section(page, 'Documents');
    const chooser = page.waitForEvent('filechooser');
    await docs.getByRole('button', { name: 'Upload' }).click();
    await (await chooser).setFiles(file);
    const upload = docs.getByTestId('attachment-upload');
    await expect(upload).toHaveAttribute('data-status', 'uploading');
    await expect(upload.getByTestId('attachment-upload-progress')).toHaveText(
      /^\d+(\.\d)? \/ 50 MB$/u,
    );
    await upload.getByRole('button', { name: 'Cancel the upload of ban-ve.bin' }).click();
    await expect(upload).toHaveCount(0);
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    await page.waitForTimeout(500);
    expect(await filesOf(page, PRODUCTS[2] ?? '', 'docs')).toEqual([]);
    await page.context().close();
  });

  test('remove with undo, and reorder by keyboard in the panel', async ({ browser }) => {
    const page = await openAs(browser, ADMIN);
    const tracker = trackApiCalls(page);
    await page.goto(recordPath(PRODUCTS[0] ?? ''));
    const photos = section(page, 'Photos');
    await expect(photos.getByTestId('attachment-tile')).toHaveCount(3);
    const before = await filesOf(page, PRODUCTS[0] ?? '', 'images');
    const [first, second, third] = before.map((file) => file.name);

    await photos.getByRole('button', { name: `Delete ${second ?? ''}` }).click();
    await expect(photos.getByTestId('attachment-tile')).toHaveCount(2);
    await tracker.idle();
    expect((await filesOf(page, PRODUCTS[0] ?? '', 'images')).map((file) => file.name)).toEqual([
      first,
      third,
    ]);
    // The toast's "Undo" (the toolbar's undo button is an icon with the same name).
    await page.locator('button', { hasText: /^Undo$/u }).click();
    await expect(photos.getByTestId('attachment-tile')).toHaveCount(3);
    await tracker.idle();
    expect((await filesOf(page, PRODUCTS[0] ?? '', 'images')).map((file) => file.name)).toEqual([
      first,
      second,
      third,
    ]);

    // Keyboard drag: Space on the handle, → to the next card, Space to drop.
    const handle = photos.getByRole('button', { name: `Reorder ${first ?? ''}` });
    await handle.focus();
    await page.keyboard.press('Space');
    // dnd-kit measures the cards on the next frames.
    await page.waitForTimeout(250);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(250);
    await page.keyboard.press('Space');
    await expect
      .poll(async () => (await filesOf(page, PRODUCTS[0] ?? '', 'images')).map((file) => file.name))
      .toEqual([second, first, third]);
    await page.context().close();
  });

  test('the kanban board shows the cover image picked in its settings', async ({ browser }) => {
    const page = await openAs(browser, ADMIN);
    await page.goto(`/b/${ids.baseId}/t/${ids.tableId}/v/${ids.kanbanId}`);
    const card = page.getByTestId('kanban-card').filter({ hasText: PRODUCTS[0] ?? '' });
    await expect(card).toBeVisible();
    await expect(card.getByTestId('kanban-card-cover')).toHaveCount(0);
    await page.getByTestId('kanban-cover-menu').click();
    await page.getByRole('menuitemradio', { name: 'Photos' }).click();
    const cover = card.getByTestId('kanban-card-cover').locator('img');
    await expect(cover).toBeVisible();
    // The 256 px thumbnail of T407 (the image itself is 320 px wide).
    await expect(cover).toHaveAttribute('src', /\/thumbnail$/u);
    await expect
      .poll(() => cover.evaluate((image) => (image as HTMLImageElement).naturalWidth))
      .toBe(256);
    await expect
      .poll(
        async () =>
          (
            await ok<{ config: { kanban: { cover_field: string | null } } }>(
              page,
              'GET',
              `/views/${ids.kanbanId}`,
            )
          ).config.kanban.cover_field,
      )
      .toBe(ids.fields.images);
    await expectNoSeriousA11yViolations(page, 'kanban with covers');
    await page.context().close();
  });

  test('a reader sees the files but cannot upload; the server refuses too', async ({ browser }) => {
    const page = await openAs(browser, READER);
    await page.goto(recordPath(PRODUCTS[0] ?? ''));
    const photos = section(page, 'Photos');
    await expect(photos.getByTestId('attachment-tile')).toHaveCount(3);
    await expect(photos.getByRole('button', { name: 'Upload' })).toHaveCount(0);
    await expect(photos.getByTestId('attachment-drop-zone')).toHaveCount(0);
    await expect(photos.getByRole('button', { name: /^Delete / })).toHaveCount(0);
    // Downloads are allowed to the system reader (every file field).
    await expect(photos.getByTestId('attachment-download').first()).toBeAttached();
    const presign = await page.evaluate(
      async ({ tableId, fieldId }) => {
        const csrf = document.cookie
          .split('; ')
          .find((cookie) => cookie.startsWith('ob_csrf='))
          ?.slice('ob_csrf='.length);
        const response = await fetch('/api/v1/files/uploads', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            ...(csrf === undefined ? {} : { 'X-CSRF-Token': decodeURIComponent(csrf) }),
          },
          body: JSON.stringify({
            table_id: tableId,
            field_id: fieldId,
            filename: 'a.png',
            size: 10,
            mime: 'image/png',
          }),
        });
        return response.status;
      },
      { tableId: ids.tableId, fieldId: ids.fields.images },
    );
    expect(presign).toBe(403);
    await expectNoSeriousA11yViolations(page, 'reader panel');
    await page.context().close();
  });

  test('a role without the download right sees images through thumbnails, never a download', async ({
    browser,
  }) => {
    const page = await openAs(browser, SALES);
    await page.goto(recordPath(PRODUCTS[0] ?? ''));
    const photos = section(page, 'Photos');
    await expect(photos.getByTestId('attachment-tile')).toHaveCount(3);
    await expect(photos.getByTestId('attachment-download')).toHaveCount(0);
    // T407: the thumbnails only need read permission; the files themselves stay refused.
    await expect(photos.locator('img')).toHaveCount(3);
    await expect
      .poll(() =>
        photos
          .locator('img')
          .evaluateAll((images) =>
            images.every((image) => (image as HTMLImageElement).naturalWidth === 256),
          ),
      )
      .toBe(true);
    const [first] = await filesOf(page, PRODUCTS[0] ?? '', 'images');
    const statuses = await page.evaluate(async (id) => {
      const status = async (url: string) =>
        (await fetch(url, { credentials: 'include', redirect: 'manual' })).status;
      return [await status(`/api/v1/files/${id}`), await status(`/api/v1/files/${id}/thumbnail`)];
    }, first?.id ?? '');
    expect(statuses).toEqual([403, 200]);
    // Still allowed to add files to the field.
    await expect(photos.getByRole('button', { name: 'Upload' })).toBeEnabled();
    await photos.getByTestId('attachment-tile').first().getByRole('button').first().click();
    const image = page.getByTestId('attachment-lightbox-image');
    await expect(image).toBeVisible();
    await expect(image).toHaveAttribute('src', /\/thumbnail\?size=1280$/u);
    await expect(page.getByTestId('attachment-lightbox-download')).toHaveCount(0);
    await expect(page.getByTestId('attachment-file-card')).toHaveCount(0);
    await expect
      .poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
      .toBe(320);
    await animationsSettled(page);
    await page.screenshot({ path: 'test-results/t407-view-without-download.png' });
    await page.keyboard.press('Escape');
    await page.context().close();
  });

  test('375 px: two columns, choose a file from the device', async ({ browser }) => {
    const page = await openAs(browser, ADMIN, { width: 375, height: 812 });
    await page.goto(recordPath(PRODUCTS[3] ?? ''));
    const photos = section(page, 'Photos');
    await expect(photos.getByRole('button', { name: 'Take photo' })).toBeVisible();
    const chooser = page.waitForEvent('filechooser');
    await photos.getByRole('button', { name: 'Choose files' }).click();
    await (
      await chooser
    ).setFiles({ name: 'mat-sau.png', mimeType: 'image/png', buffer: pngBytes([207, 197, 217]) });
    await expect(photos.getByTestId('attachment-tile')).toHaveCount(1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await expectNoSeriousA11yViolations(page, 'attachments at 375 px');
    await page.context().close();
  });

  test('the history lists the files added and removed', async ({ browser }) => {
    const page = await openAs(browser, ADMIN);
    // One more file through the API, then removed: two entries of the history.
    const added = await uploadFile(
      page,
      { tableId: ids.tableId, fieldId: ids.fields.docs },
      { name: 'dieu-khoan.pdf', mime: 'application/pdf', bytes: pdfBytes('terms') },
    );
    const record = ids.records[PRODUCTS[3] ?? ''] ?? '';
    await ok(page, 'PATCH', `/tables/${ids.tableId}/records?field_key_type=id`, {
      records: [{ id: record, fields: { [ids.fields.docs]: [{ id: added.id }] } }],
    });
    await ok(page, 'PATCH', `/tables/${ids.tableId}/records?field_key_type=id`, {
      records: [{ id: record, fields: { [ids.fields.docs]: null } }],
    });
    await page.goto(recordPath(PRODUCTS[3] ?? ''));
    await page.getByRole('tab', { name: 'History' }).click();
    const changes = page.getByTestId('history-attachments');
    await expect(changes.first()).toContainText('dieu-khoan.pdf');
    await expect(changes.first().locator('s')).toHaveText('dieu-khoan.pdf');
    await page.context().close();
  });
});
