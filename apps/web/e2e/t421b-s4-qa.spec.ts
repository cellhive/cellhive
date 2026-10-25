import { type Browser, type BrowserContext, type Page } from '@playwright/test';

import { pdfBytes, pngBytes } from './attachments';
import { expect, test, WORKER_ORG } from './fixtures';
import { DEMO_ORDER_CUSTOMER, DEMO_PASSWORD } from './seed';
import { api, apiSignIn, expectNoSeriousA11yViolations, ok } from './support';

/**
 * T421b: S4 QA fixes on the demo base (CONTRACTS §9) — phone and email
 * cells as plain text inside clickable sub-table cells and mobile cards
 * (axe `nested-interactive`, `target-size`), picker lists that scroll with
 * the keyboard (`scrollable-region-focusable`) in the popover and the phone
 * sheet, a just uploaded image shown at once from its local copy (and after
 * a reload from the API), the lightbox strip contrast, and the anonymous
 * share page never asking for the session.
 */

const DEMO_BASE = 'Chăm sóc khách hàng';
const RUN = String(Date.now() % 100_000);
const HEADER_HEIGHT = 36;
const ROW_HEIGHT = 34;

type Session = Awaited<ReturnType<BrowserContext['storageState']>>;
let session: Session | undefined;

const ids = {
  baseId: '',
  orders: '',
  customers: '',
  tickets: '',
  ordersAll: '',
  orderId: '',
  ticketId: '',
  single: '',
  view: '',
  files: '',
};

async function openAs(
  browser: Browser,
  viewport = { width: 1440, height: 900 },
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport,
    locale: 'en-US',
    ...(session === undefined ? {} : { storageState: session }),
  });
  await context.addInitScript(() => {
    window.localStorage.setItem('cellhive.language', 'en');
  });
  const page = await context.newPage();
  await page.goto('/login');
  if (session === undefined) {
    await apiSignIn(page, WORKER_ORG.email('admin'), DEMO_PASSWORD);
    session = await context.storageState();
  }
  return { context, page };
}

interface Listed {
  items: { id: string; name: string }[];
}

test.describe.serial('T421b S4 QA fixes', () => {
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    const { context, page } = await openAs(browser);
    const me = await ok<{ orgs: { id: string }[] }>(page, 'GET', '/me');
    for (const org of me.orgs) {
      const workspaces = await ok<Listed>(page, 'GET', `/orgs/${org.id}/workspaces`);
      for (const workspace of workspaces.items) {
        const bases = await ok<Listed>(page, 'GET', `/workspaces/${workspace.id}/bases`);
        const base = bases.items.find((item) => item.name === DEMO_BASE);
        if (base !== undefined) ids.baseId = base.id;
      }
    }
    const tables = await ok<Listed>(page, 'GET', `/bases/${ids.baseId}/tables`);
    const table = (name: string) => tables.items.find((item) => item.name === name)?.id ?? '';
    ids.orders = table('Orders');
    ids.customers = table('Customers');
    ids.tickets = table('Tickets');
    const views = await ok<Listed>(page, 'GET', `/tables/${ids.orders}/views`);
    ids.ordersAll = views.items.find((view) => view.name === 'Tất cả đơn hàng')?.id ?? '';
    const orders = await ok<{ records: { id: string }[] }>(
      page,
      'POST',
      `/tables/${ids.orders}/records/query`,
      { limit: 1 },
    );
    ids.orderId = orders.records[0]?.id ?? '';
    const ticketFields = await ok<Listed>(page, 'GET', `/tables/${ids.tickets}/fields`);
    ids.files = ticketFields.items.find((field) => field.name === 'Tệp đính kèm')?.id ?? '';
    const tickets = await ok<{ records: { id: string }[] }>(
      page,
      'POST',
      `/tables/${ids.tickets}/records/query`,
      { limit: 1, offset: 1500 },
    );
    ids.ticketId = tickets.records[0]?.id ?? '';
    // A single link to Customers (the popover) in a personal view with the primary field.
    ids.single = (
      await ok<{ id: string }>(page, 'POST', `/tables/${ids.orders}/fields`, {
        name: `Khách chính ${RUN}`,
        type: 'link',
        options: { link_table: ids.customers, allow_multiple: false },
      })
    ).id;
    const fields = await ok<{ items: { id: string; is_primary: boolean }[] }>(
      page,
      'GET',
      `/tables/${ids.orders}/fields`,
    );
    ids.view = (
      await ok<{ id: string }>(page, 'POST', `/tables/${ids.orders}/views`, {
        name: `T421b ${RUN}`,
        type: 'grid',
        is_personal: true,
        config: {
          hidden_fields: fields.items
            .filter((field) => !field.is_primary && field.id !== ids.single)
            .map((field) => field.id),
          field_order: [ids.single],
        },
      })
    ).id;
    await context.close();
  });

  test.afterAll(async ({ browser }) => {
    const { context, page } = await openAs(browser);
    await api(page, 'DELETE', `/views/${ids.view}`);
    await api(page, 'DELETE', `/fields/${ids.single}`);
    await context.close();
  });

  test('an order: the customers sub-table shows phone and email as text in its cells', async ({
    browser,
  }) => {
    const { context, page } = await openAs(browser);
    await page.goto(`/b/${ids.baseId}/t/${ids.orders}/v/${ids.ordersAll}?record=${ids.orderId}`);
    const subtable = page.getByTestId('subtable').filter({ hasText: DEMO_ORDER_CUSTOMER });
    await expect(subtable.getByTestId('subtable-row').first()).toBeVisible();
    await expect(subtable.getByRole('columnheader', { name: 'Điện thoại' })).toBeVisible();
    // Editable cells are buttons: nothing interactive inside them.
    await expect(subtable.locator('button a')).toHaveCount(0);
    await expect(subtable.locator('a[href^="tel:"], a[href^="mailto:"]')).toHaveCount(0);
    await expectNoSeriousA11yViolations(page, 'order panel with the customers sub-table');
    await context.close();
  });

  test('customers at 390 px: cards without links inside them', async ({ browser }) => {
    const { context, page } = await openAs(browser, { width: 390, height: 844 });
    await page.goto(`/b/${ids.baseId}/t/${ids.customers}`);
    const list = page.getByRole('list', { name: 'Records of Customers' });
    await expect(list.getByRole('button').first()).toBeVisible();
    await expect(list.locator('button a')).toHaveCount(0);
    await expectNoSeriousA11yViolations(page, 'customer cards (mobile)');
    await context.close();
  });

  test('the single-link popover over 200 customers scrolls with the keyboard', async ({
    browser,
  }) => {
    const { context, page } = await openAs(browser);
    await page.goto(`/b/${ids.baseId}/t/${ids.orders}/v/${ids.view}`);
    const canvas = page.locator('.ob-grid [data-testid="data-grid-canvas"]');
    await expect(page.getByTestId('glide-cell-2-0')).toBeAttached();
    const box = await canvas.boundingBox();
    if (box === null) throw new Error('grid not laid out');
    // 5 000 rows: a 48 px gutter; the primary column, then the link.
    await page.mouse.click(box.x + 48 + 24, box.y + HEADER_HEIGHT + ROW_HEIGHT / 2);
    await expect(page.getByTestId('glide-cell-1-0')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    const popover = page.getByRole('dialog', { name: 'Choose customers' });
    await expect(popover).toBeVisible();
    await expect(popover.getByRole('option')).not.toHaveCount(0);
    const scroller = popover.getByRole('listbox').locator('xpath=..');
    await expect(scroller).toHaveAttribute('tabindex', '0');
    expect(await scroller.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
      true,
    );
    await expectNoSeriousA11yViolations(page, 'link popover with many customers');
    await page.keyboard.press('Escape');
    await context.close();
  });

  test('the phone picker sheet over 200 customers scrolls with the keyboard', async ({
    browser,
  }) => {
    const { context, page } = await openAs(browser, { width: 390, height: 844 });
    await page.goto(`/b/${ids.baseId}/t/${ids.orders}/v/${ids.ordersAll}?record=${ids.orderId}`);
    const subtable = page.getByTestId('subtable').filter({ hasText: DEMO_ORDER_CUSTOMER });
    await subtable.getByRole('button', { name: 'Link existing' }).click();
    const sheet = page.getByTestId('link-picker-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('option')).not.toHaveCount(0);
    await expect(sheet.getByRole('listbox').locator('xpath=..')).toHaveAttribute('tabindex', '0');
    await expectNoSeriousA11yViolations(page, 'link picker sheet with many customers');
    await context.close();
  });

  test('a just uploaded image shows at once, then from the API after a reload; the strip reads', async ({
    browser,
  }) => {
    const { context, page } = await openAs(browser);
    const path = `/b/${ids.baseId}/t/${ids.tickets}?record=${ids.ticketId}`;
    await page.goto(path);
    const files = page.getByTestId('attachment-section').filter({
      has: page.getByRole('heading', { name: 'Tệp đính kèm', exact: true }),
    });
    await expect(files).toBeVisible();
    await files
      .getByTestId('attachment-file-input')
      .first()
      .setInputFiles([
        {
          name: `anh-${RUN}.png`,
          mimeType: 'image/png',
          buffer: pngBytes([15, 118, 110], 320, 240),
        },
        { name: `bien-ban-${RUN}.pdf`, mimeType: 'application/pdf', buffer: pdfBytes() },
      ]);
    const image = files.getByTestId('attachment-tile').filter({ hasText: `anh-${RUN}.png` });
    await expect(image.locator('img')).toHaveAttribute('src', /^blob:/u);
    await expect
      .poll(() =>
        image.locator('img').evaluate((element) => (element as HTMLImageElement).naturalWidth),
      )
      .toBe(320);
    await expect
      .poll(async () => {
        const record = await ok<{ fields: Record<string, { name: string }[] | null> }>(
          page,
          'GET',
          `/tables/${ids.tickets}/records/${ids.ticketId}?field_key_type=id`,
        );
        return (record.fields[ids.files] ?? []).map((file) => file.name).sort();
      })
      .toEqual([`anh-${RUN}.png`, `bien-ban-${RUN}.pdf`]);

    // Another page load: no local copy any more, the image comes through `thumbnail_url`.
    await page.reload();
    const reloaded = files.getByTestId('attachment-tile').filter({ hasText: `anh-${RUN}.png` });
    await expect(reloaded.locator('img')).toHaveAttribute(
      'src',
      /\/api\/v1\/files\/att_\w+\/thumbnail/u,
    );
    await expect
      .poll(() =>
        reloaded.locator('img').evaluate((element) => (element as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0);

    // The lightbox strip: type labels at full contrast.
    await reloaded.getByRole('button', { name: `View anh-${RUN}.png` }).click();
    await expect(page.getByTestId('attachment-lightbox')).toBeVisible();
    await expectNoSeriousA11yViolations(page, 'lightbox with its strip');
    await page.keyboard.press('Escape');
    await context.close();
  });
});
