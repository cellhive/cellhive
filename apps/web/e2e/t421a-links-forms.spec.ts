import AxeBuilder from '@axe-core/playwright';
import { type Browser, type BrowserContext, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { DEMO_PASSWORD } from './seed';
import { api, apiSignIn, expectNoSeriousA11yViolations, ok } from './support';

/**
 * T421a: S4 QA findings on link cells and forms. A single-link cell never
 * writes a record without an explicit choice (popover → open record → Esc
 * → Enter again).
 */

const DEMO_BASE = 'Chăm sóc khách hàng';
const RUN = String(Date.now()).slice(-6);
const HEADER_HEIGHT = 36;
const ROW_HEIGHT = 34;
const PRIMARY_WIDTH = 200;

const ids = {
  baseId: '',
  orders: '',
  customers: '',
  single: '',
  viewId: '',
  formViewId: '',
  orgToken: '',
  primary: '',
  orderIds: [] as string[],
};

const singleName = `Khách chính ${RUN}`;

async function openAs(
  browser: Browser,
  email: string,
  viewport = { width: 1440, height: 900 },
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport, locale: 'en-US' });
  await context.addInitScript(() => {
    window.localStorage.setItem('cellhive.language', 'en');
  });
  const page = await context.newPage();
  await page.goto('/login');
  await apiSignIn(page, email, DEMO_PASSWORD);
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
      const base = bases.items.find((item) => item.name === DEMO_BASE);
      if (base === undefined) continue;
      const tables = await ok<{ items: { id: string; name: string }[] }>(
        page,
        'GET',
        `/bases/${base.id}/tables`,
      );
      const id = (name: string) => tables.items.find((table) => table.name === name)?.id ?? '';
      return { baseId: base.id, orders: id('Orders'), customers: id('Customers') };
    }
  }
  throw new Error('demo base not found');
}

function cell(page: Page, column: number, row: number) {
  return page.getByTestId(`glide-cell-${String(column)}-${String(row)}`);
}

function markerWidth(rows: number): number {
  return Math.max(40, String(rows).length * 8 + 16);
}

async function canvasBox(page: Page) {
  const box = await page.locator('.ob-grid [data-testid="data-grid-canvas"]').boundingBox();
  if (box === null) throw new Error('grid not laid out');
  return box;
}

async function openGrid(page: Page, viewId: string) {
  await page.goto(`/b/${ids.baseId}/t/${ids.orders}/v/${viewId}`);
  await expect(page.locator('.ob-grid canvas').first()).toBeVisible();
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: /records?$/u })
      .first(),
  ).toBeVisible();
}

async function linksOf(page: Page, recordId: string, fieldId: string) {
  const record = await ok<{ fields: Record<string, { id: string }[] | null> }>(
    page,
    'GET',
    `/tables/${ids.orders}/records/${recordId}?field_key_type=id`,
  );
  return record.fields[fieldId] ?? [];
}

test.describe.serial('T421a link cells', () => {
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
    Object.assign(ids, await findDemo(page));
    const single = await ok<{ id: string }>(page, 'POST', `/tables/${ids.orders}/fields`, {
      name: singleName,
      type: 'link',
      options: { link_table: ids.customers, allow_multiple: false },
    });
    ids.single = single.id;
    const fields = await ok<{ items: { id: string; is_primary: boolean }[] }>(
      page,
      'GET',
      `/tables/${ids.orders}/fields`,
    );
    const primary = fields.items.find((field) => field.is_primary)?.id ?? '';
    ids.primary = primary;
    const view = await ok<{ id: string }>(page, 'POST', `/tables/${ids.orders}/views`, {
      name: `T421a ${RUN}`,
      type: 'grid',
      is_personal: true,
      config: {
        hidden_fields: fields.items
          .filter((field) => !field.is_primary && field.id !== single.id)
          .map((field) => field.id),
        field_order: [single.id],
        column_widths: { [primary]: PRIMARY_WIDTH, [single.id]: 240 },
      },
    });
    ids.viewId = view.id;
    const orders = await ok<{ records: { id: string }[] }>(
      page,
      'POST',
      `/tables/${ids.orders}/records/query?field_key_type=id`,
      { view_id: ids.viewId, offset: 0, limit: 3, include_total: false },
    );
    ids.orderIds = orders.records.map((record) => record.id);
    const form = await ok<{ id: string }>(page, 'POST', `/tables/${ids.orders}/views`, {
      name: `T421a form ${RUN}`,
      type: 'form',
      config: {
        form: {
          title: `Đơn T421a ${RUN}`,
          fields: [{ field: primary, required: true }, { field: single.id }],
        },
      },
    });
    ids.formViewId = form.id;
    ids.orgToken = (
      await ok<{ token: string }>(page, 'POST', `/views/${form.id}/share-links`, {
        audience: 'org',
      })
    ).token;
    await context.close();
  });

  test.afterAll(async ({ browser }) => {
    const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
    await api(page, 'DELETE', `/views/${ids.formViewId}`);
    await api(page, 'DELETE', `/fields/${ids.single}`);
    await context.close();
  });

  test('a single-link cell never writes without a choice (popover → open record → Esc → Enter)', async ({
    browser,
  }) => {
    const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
    await openGrid(page, ids.viewId);
    const patches: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'PATCH') patches.push(request.url());
    });
    const box = await canvasBox(page);
    const rowY = box.y + HEADER_HEIGHT + ROW_HEIGHT * 0 + ROW_HEIGHT / 2;
    const linkX = box.x + markerWidth(5000) + PRIMARY_WIDTH + 60;
    await page.mouse.click(linkX, rowY);
    await expect(cell(page, 2, 0)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');
    const popover = page.getByTestId('link-picker-popover');
    await expect(popover).toBeVisible();
    await expect(popover.getByRole('option').first()).toBeVisible();

    // The ↗ of the primary cell opens the record panel (the popover goes).
    await page.mouse.move(box.x + markerWidth(5000) + 40, rowY);
    const expand = page.getByRole('button', { name: 'Expand record' });
    await expect(expand).toBeVisible();
    await expand.click();
    await expect(popover).toBeHidden();
    await expect(page).toHaveURL(/record=/u);
    await expect(page.getByTestId('record-panel')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page).not.toHaveURL(/record=/u);
    // The focus goes back to the grid, not to the ↗ shortcut.
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.closest('.ob-grid') != null))
      .toBe(true);

    await page.mouse.click(linkX, rowY);
    await expect(cell(page, 2, 0)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Enter');
    await expect(popover).toBeVisible();
    await expect(popover.getByRole('option').first()).toBeVisible();
    // Enter again with no record chosen writes nothing.
    await page.keyboard.press('Enter');
    await expect(popover).toBeVisible();
    await page.waitForTimeout(300);
    expect(patches).toEqual([]);
    expect(await linksOf(page, ids.orderIds[0] ?? '', ids.single)).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();

    // "Expand" → the dialog; Escape gives the focus back to the grid cell, not <body>.
    await page.keyboard.press('Enter');
    await expect(popover).toBeVisible();
    await popover.getByTestId('link-expand').click();
    const dialog = page.getByTestId('link-picker-dialog');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.closest('.ob-grid') != null))
      .toBe(true);
    expect(patches).toEqual([]);
    await context.close();
  });

  for (const where of ['member form', 'org form link'] as const) {
    test(`a link question of a ${where} is a combobox: ↑/↓, Enter picks, never submits`, async ({
      browser,
    }) => {
      const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
      const submits: string[] = [];
      page.on('request', (request) => {
        if (request.method() === 'POST' && /\/submit$/u.test(request.url())) {
          submits.push(request.url());
        }
      });
      await page.goto(
        where === 'member form'
          ? `/b/${ids.baseId}/t/${ids.orders}/v/${ids.formViewId}?form=fill`
          : `/s/${ids.orgToken}`,
      );
      const question = (name: string) =>
        page.getByTestId('form-question').filter({ hasText: name });
      await question('Tên đơn hàng').getByRole('textbox').fill(`T421a ${where}`);
      const box = question(singleName).getByRole('combobox');
      await box.click();
      await expect(box).toHaveAttribute('aria-expanded', 'true');
      const options = question(singleName).getByRole('option');
      await expect(options.first()).toBeVisible();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      const second = await options.nth(1).getAttribute('id');
      await expect(box).toHaveAttribute('aria-activedescendant', second ?? '');
      if (where === 'member form') {
        // The picker's display values tell records with the same title apart.
        await expect(options.first().locator('span span').nth(1)).not.toBeEmpty();
      }
      await expectNoSeriousA11yViolations(page, `${where} link combobox`);
      const title = (await options.nth(1).locator('span span').first().textContent()) ?? '';
      await page.keyboard.press('Enter');
      await expect(
        question(singleName).getByRole('list', { name: 'Picked records' }),
      ).toContainText(title);
      await expect(box).toHaveAttribute('aria-expanded', 'false');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
      expect(submits).toEqual([]);
      await expect(page.getByRole('heading', { name: 'Response sent' })).toHaveCount(0);
      await context.close();
    });
  }

  test('a trashed source table leaves its partner field read-only, explained; restore brings it back', async ({
    browser,
  }) => {
    const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
    const tasks = await ok<{ id: string }>(page, 'POST', `/bases/${ids.baseId}/tables`, {
      name: `T421a Tasks ${RUN}`,
    });
    const reverseName = `T421a việc ${RUN}`;
    const link = await ok<{ id: string; options: { symmetric_field_id: string } }>(
      page,
      'POST',
      `/tables/${tasks.id}/fields`,
      {
        name: 'Khách',
        type: 'link',
        options: {
          link_table: ids.customers,
          bidirectional: true,
          bidirectional_link_field_name: reverseName,
        },
      },
    );
    const customers = await ok<{ records: { id: string }[] }>(
      page,
      'POST',
      `/tables/${ids.customers}/records/query?field_key_type=id`,
      { offset: 0, limit: 1, include_total: false },
    );
    const customerId = customers.records[0]?.id ?? '';
    try {
      expect((await api(page, 'DELETE', `/tables/${tasks.id}`)).status).toBe(204);
      const fieldCalls: string[] = [];
      page.on('request', (request) => {
        if (request.url().includes(`/tables/${tasks.id}/`)) fieldCalls.push(request.url());
      });
      await page.goto(`/b/${ids.baseId}/t/${ids.customers}?record=${customerId}`);
      const panel = page.getByTestId('record-panel');
      const gone = panel.getByTestId('subtable-target-deleted');
      await expect(gone).toContainText(reverseName);
      await expect(gone).toContainText('The linked table is in the trash.');
      await expect(panel.getByRole('button', { name: 'Link existing' })).toHaveCount(0);
      // Only the new row: the Customers panel's tel:/mailto: links are T421b's.
      const axe = await new AxeBuilder({ page })
        .include('[data-testid="subtable-target-deleted"]')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(axe.violations).toEqual([]);
      // Nothing asks the trashed table for its fields (was a 404).
      expect(fieldCalls).toEqual([]);

      await ok(page, 'POST', `/tables/${tasks.id}/restore`);
      await page.reload();
      await expect(panel.getByTestId('subtable').filter({ hasText: reverseName })).toBeVisible();
      await expect(gone).toHaveCount(0);
    } finally {
      await api(page, 'POST', `/tables/${tasks.id}/restore`);
      await api(page, 'DELETE', `/fields/${link.options.symmetric_field_id}`);
      await api(page, 'DELETE', `/tables/${tasks.id}`);
      await context.close();
    }
  });

  test('pasting a title two customers share says the title is ambiguous', async ({ browser }) => {
    const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const title = `Trùng T421a ${RUN}`;
    const twins = await ok<{ records: { id: string }[] }>(
      page,
      'POST',
      `/tables/${ids.customers}/records?field_key_type=name`,
      { records: [{ fields: { Tên: title } }, { fields: { Tên: title } }] },
    );
    try {
      await openGrid(page, ids.viewId);
      const box = await canvasBox(page);
      await page.mouse.click(
        box.x + markerWidth(5000) + PRIMARY_WIDTH + 60,
        box.y + HEADER_HEIGHT + ROW_HEIGHT * 2 + ROW_HEIGHT / 2,
      );
      await expect(cell(page, 2, 2)).toHaveAttribute('aria-selected', 'true');
      await page.evaluate((text) => navigator.clipboard.writeText(text), title);
      await page.keyboard.press('ControlOrMeta+v');
      await expect(
        page.getByText(
          'Nothing was saved: 1 cell has a value that is not accepted. Several records you can see have this title.',
        ),
      ).toBeVisible();
      expect(await linksOf(page, ids.orderIds[2] ?? '', ids.single)).toEqual([]);
    } finally {
      await api(page, 'DELETE', `/tables/${ids.customers}/records`, {
        ids: twins.records.map((record) => record.id),
      });
      await context.close();
    }
  });
});
