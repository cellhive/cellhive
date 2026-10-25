import { mkdirSync } from 'node:fs';

import { type Browser, type BrowserContext, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { DEMO_PASSWORD } from './seed';
import { animationsSettled, api, apiSignIn, expectNoSeriousA11yViolations, ok } from './support';

/**
 * T414 (type change dialog, conversion banners, undo) and T415 (link
 * config: two-way on and off, several records → one) on a table of their
 * own in the demo base (CONTRACTS §9): a text column with 12 values that
 * are not numbers among many rows (so the background job takes a moment:
 * a second tab sees it running), a single select, two link fields to
 * Customers.
 */

const DEMO_BASE = 'Chăm sóc khách hàng';
const RUN = String(Date.now()).slice(-6);
/**
 * Rows of the table: a full batch of the job (5 000 rows), long enough for a
 * second tab to see it run. Many more rows queue that many `events.dispatch`
 * jobs first (one per record created), and the conversion waits behind them.
 */
const ROWS = Number(process.env['T414_ROWS'] ?? 5_000);
const INVALID = 12;
const AREAS = ['Hà Nội', 'Đà Nẵng', 'TP. Hồ Chí Minh', 'Cần Thơ'];
const HEADER_HEIGHT = 36;
const ROW_HEIGHT = 34;
/** Screenshots compared with the design boards (T414 report); saved only when `T414_SHOTS=<dir>` is set. */
const SHOTS = process.env['T414_SHOTS'];

const ids = {
  baseId: '',
  customers: '',
  table: '',
  viewId: '',
  primary: '',
  amount: '',
  status: '',
  customer: '',
  buyers: '',
  area: '',
  records: [] as string[],
  customerIds: [] as string[],
};
const reverseName = `T414 đơn ${RUN}`;

async function openAs(
  browser: Browser,
  viewport = { width: 1440, height: 900 },
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport, locale: 'en-US' });
  await context.addInitScript(() => {
    window.localStorage.setItem('cellhive.language', 'en');
  });
  const page = await context.newPage();
  await page.goto('/login');
  await apiSignIn(page, WORKER_ORG.email('admin'), DEMO_PASSWORD);
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
      return {
        baseId: base.id,
        customers: tables.items.find((table) => table.name === 'Customers')?.id ?? '',
      };
    }
  }
  throw new Error('demo base not found');
}

/** Text written into the Amount column of row `index`: 12 of them are no number. */
function amountOf(index: number): string {
  return index < INVALID ? `n/a ${String(index)}` : String(index * 10);
}

async function openGrid(page: Page) {
  await page.goto(`/b/${ids.baseId}/t/${ids.table}/v/${ids.viewId}`);
  await expect(page.locator('.ob-grid canvas').first()).toBeVisible();
  await expect(page.getByTestId('glide-cell-1-0')).toHaveText('R00000');
}

function cell(page: Page, column: number, row: number) {
  return page.getByTestId(`glide-cell-${String(column)}-${String(row)}`);
}

function markerWidth(rows: number): number {
  return Math.max(40, String(rows).length * 8 + 16);
}

/** Selects the primary cell of `row`, then moves right `right` columns with the keyboard. */
async function selectCell(page: Page, row: number, right: number) {
  const canvas = page.locator('.ob-grid [data-testid="data-grid-canvas"]');
  const box = await canvas.boundingBox();
  if (box === null) throw new Error('grid not laid out');
  await page.mouse.click(
    box.x + markerWidth(ROWS) + 24,
    box.y + HEADER_HEIGHT + ROW_HEIGHT * row + ROW_HEIGHT / 2,
  );
  await expect(cell(page, 1, row)).toHaveAttribute('aria-selected', 'true');
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.closest('.ob-grid') != null))
    .toBe(true);
  for (let step = 0; step < right; step += 1) await page.keyboard.press('ArrowRight');
  await expect(cell(page, 1 + right, row)).toHaveAttribute('aria-selected', 'true');
}

/** Opens the field dialog of the column `right` columns after the primary one (keyboard only). */
async function editField(page: Page, right: number) {
  await selectCell(page, 0, right);
  await page.keyboard.press('Shift+F10');
  await page.getByRole('menuitem', { name: 'Edit field' }).click();
  const dialog = page.getByRole('dialog', { name: /Edit field/u });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function shot(page: Page, name: string) {
  await animationsSettled(page);
  if (SHOTS === undefined) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

async function valueOf(page: Page, recordId: string, fieldId: string): Promise<unknown> {
  const record = await ok<{ fields: Record<string, unknown> }>(
    page,
    'GET',
    `/tables/${ids.table}/records/${recordId}?field_key_type=id`,
  );
  return record.fields[fieldId] ?? null;
}

async function fieldOf(page: Page, tableId: string, fieldId: string) {
  const fields = await ok<{
    items: { id: string; name: string; type: string; options: Record<string, unknown> }[];
  }>(page, 'GET', `/tables/${tableId}/fields`);
  return fields.items.find((field) => field.id === fieldId);
}

/** The preview panes show their latest answer (a stale one is dimmed, lowering contrast). */
async function settled(page: Page) {
  const panes = page.getByTestId('conversion-pane');
  for (const pane of await panes.all()) {
    await expect(pane).toHaveAttribute('aria-busy', 'false');
  }
}

function banner(page: Page, fieldId: string) {
  return page.locator(`[data-testid="conversion-banner"][data-field="${fieldId}"]`);
}

test.describe.serial('T414 / T415 type change and link conversions', () => {
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    const { context, page } = await openAs(browser);
    Object.assign(ids, await findDemo(page));
    const table = await ok<{ id: string; primary_field_id: string }>(
      page,
      'POST',
      `/bases/${ids.baseId}/tables`,
      { name: `T414 ${RUN}`, primary_field_name: 'Code' },
    );
    ids.table = table.id;
    ids.primary = table.primary_field_id;
    const create = (body: Record<string, unknown>) =>
      ok<{ id: string }>(page, 'POST', `/tables/${ids.table}/fields`, body);
    ids.amount = (await create({ name: 'Amount', type: 'text' })).id;
    ids.status = (
      await create({
        name: 'Status',
        type: 'select',
        options: {
          multiple: false,
          options: [
            { name: 'New', color: 1 },
            { name: 'Doing', color: 3 },
            { name: 'Done', color: 2 },
          ],
        },
      })
    ).id;
    ids.customer = (
      await create({ name: 'Customer', type: 'link', options: { link_table: ids.customers } })
    ).id;
    ids.buyers = (
      await create({ name: 'Buyers', type: 'link', options: { link_table: ids.customers } })
    ).id;
    ids.area = (await create({ name: 'Area', type: 'text' })).id;
    const views = await ok<{ items: { id: string }[] }>(page, 'GET', `/tables/${ids.table}/views`);
    ids.viewId = views.items[0]?.id ?? '';
    const customers = await ok<{ records: { id: string }[] }>(
      page,
      'POST',
      `/tables/${ids.customers}/records/query?field_key_type=id`,
      { offset: 0, limit: 3, include_total: false },
    );
    ids.customerIds = customers.records.map((record) => record.id);
    const statuses = ['New', 'Doing', 'Done'];
    for (let start = 0; start < ROWS; start += 1000) {
      const records = Array.from({ length: Math.min(1000, ROWS - start) }, (_, offset) => {
        const index = start + offset;
        const fields: Record<string, unknown> = {
          [ids.primary]: `R${String(index).padStart(5, '0')}`,
          [ids.amount]: amountOf(index),
        };
        if (index < 30) fields[ids.status] = statuses[index % 3];
        if (index < 3) fields[ids.buyers] = ids.customerIds;
        if (index < 3) fields[ids.customer] = [ids.customerIds[index]];
        if (index < 200) fields[ids.area] = AREAS[index % AREAS.length];
        return { fields };
      });
      const created = await ok<{ records: { id: string }[] }>(
        page,
        'POST',
        `/tables/${ids.table}/records?field_key_type=id`,
        { records },
      );
      if (start === 0) ids.records = created.records.slice(0, 40).map((record) => record.id);
    }
    await context.close();
  });

  test.afterAll(async ({ browser }) => {
    const { context, page } = await openAs(browser);
    await api(page, 'DELETE', `/tables/${ids.table}`);
    // The reverse field left in Customers by the two-way test.
    const fields = await ok<{ items: { id: string; name: string }[] }>(
      page,
      'GET',
      `/tables/${ids.customers}/fields`,
    );
    const reverse = fields.items.find((field) => field.name === reverseName);
    if (reverse !== undefined) await api(page, 'DELETE', `/fields/${reverse.id}`);
    await context.close();
  });

  test('text → number: preview of the invalid values, confirm, job, second tab sees progress and locked cells, undo keeps a later edit', async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const a = await openAs(browser);
    const b = await openAs(browser);
    await openGrid(a.page);
    await openGrid(b.page);

    const dialog = await editField(a.page, 1);
    const type = dialog.getByLabel('Field type');
    // Types the field can never become are listed disabled, with the reason.
    await expect(
      type.locator('option', { hasText: 'Created time — filled in automatically' }),
    ).toBeDisabled();
    await expect(
      type.locator('option', { hasText: 'Link to another table — create a new field instead' }),
    ).toBeDisabled();
    await type.selectOption('number');
    const pane = dialog.getByTestId('conversion-pane');
    await expect(pane.getByTestId('stat-lost')).toContainText('12', { timeout: 20_000 });
    await expect(pane.getByTestId('stat-affected')).toContainText(ROWS.toLocaleString('en-US'));
    const samples = pane.getByTestId('conversion-samples');
    await expect(samples.locator('tr[data-outcome="lost"]')).toHaveCount(12);
    await expect(samples).toContainText('n/a 0');
    await expect(samples).toContainText('R00000');
    const submit = dialog.getByRole('button', { name: 'Change type' });
    await expect(submit).toBeDisabled();
    await dialog.getByLabel('I understand 12 values will be removed').check();
    await expect(submit).toBeEnabled();
    await settled(a.page);
    await expectNoSeriousA11yViolations(a.page, 'type change dialog');
    await shot(a.page, 'convert-text-number');

    // 30 000 distinct values: more than the 1 000 options a select may have.
    await type.selectOption('select');
    await expect(dialog.getByTestId('conversion-refused')).toContainText(
      'It would need more than 1,000 options.',
      { timeout: 20_000 },
    );
    await expect(dialog.getByRole('button', { name: 'Change type' })).toBeDisabled();
    await type.selectOption('number');
    await expect(pane.getByTestId('stat-lost')).toContainText('12');
    await dialog.getByLabel('I understand 12 values will be removed').check();
    await dialog.getByRole('button', { name: 'Change type' }).click();
    await expect(dialog).toBeHidden();

    // Second tab (decision #8): the progress banner, the column locked while it runs.
    const running = banner(b.page, ids.amount);
    await expect(running).toHaveAttribute('data-state', 'running', { timeout: 15_000 });
    await expect(running).toContainText('Converting Amount from text to number');
    await expect(running.getByRole('progressbar')).toBeVisible();
    await expect(
      b.page.locator('table[role="grid"] th[role="columnheader"]', { hasText: 'Amount' }),
    ).toHaveAttribute('aria-label', /read-only/u);
    await shot(b.page, 'convert-running');

    // Done: both tabs, the values converted.
    await expect(banner(a.page, ids.amount)).toHaveAttribute('data-state', 'succeeded', {
      timeout: 120_000,
    });
    await expect(banner(b.page, ids.amount)).toHaveAttribute('data-state', 'succeeded', {
      timeout: 30_000,
    });
    await expect(banner(a.page, ids.amount)).toContainText('Amount was converted to number.');
    await expect(banner(a.page, ids.amount)).toContainText(
      `${(ROWS - INVALID).toLocaleString('en-US')} cells converted, 12 emptied.`,
    );
    const edited = ids.records[20] ?? '';
    expect(await valueOf(a.page, edited, ids.amount)).toBe(200);
    expect(await valueOf(a.page, ids.records[0] ?? '', ids.amount)).toBeNull();
    await expect(cell(a.page, 2, 20)).toContainText('200');
    await shot(a.page, 'convert-done');

    // T421b: after a reload the done banner is back while the undo is available;
    // closing it is remembered for this user.
    await b.page.reload();
    await expect(cell(b.page, 2, 20)).toContainText('200');
    const again = banner(b.page, ids.amount);
    await expect(again).toHaveAttribute('data-state', 'succeeded');
    await expect(again.getByRole('button', { name: 'Undo (7 days left)' })).toBeVisible();
    await again.getByRole('button', { name: 'Hide this message' }).click();
    await expect(again).toHaveCount(0);
    await b.page.reload();
    await expect(cell(b.page, 2, 20)).toContainText('200');
    await expect(banner(b.page, ids.amount)).toHaveCount(0);

    // A later edit, then undo: kept by default (decision #7).
    await ok(a.page, 'PATCH', `/tables/${ids.table}/records/${edited}?field_key_type=id`, {
      fields: { [ids.amount]: 777 },
    });
    await banner(a.page, ids.amount).getByRole('button', { name: 'Undo (7 days left)' }).click();
    const revert = a.page.getByRole('dialog', { name: /Undo the type change\?/u });
    await expect(revert.getByTestId('revert-edited')).toContainText(
      '1cell edited since the change',
    );
    await expect(revert.getByLabel('Keep the later edits (recommended)')).toBeChecked();
    // T421b: the radios are drawn with the accent token, not the browser's blue.
    expect(
      await revert
        .getByLabel('Keep the later edits (recommended)')
        .evaluate((radio) => getComputedStyle(radio).borderTopColor),
    ).toBe('rgb(15, 118, 110)');
    await expectNoSeriousA11yViolations(a.page, 'revert dialog');
    await revert.getByLabel('Overwrite the later edits').check();
    await expect(revert.getByTestId('revert-confirm')).toContainText(
      '1 cell was edited after the change.',
    );
    await shot(a.page, 'revert-dialog-overwrite');
    await revert.getByLabel('Keep the later edits (recommended)').check();
    await shot(a.page, 'revert-dialog');
    await revert.getByTestId('revert-submit').click();
    await expect(revert).toBeHidden({ timeout: 60_000 });
    await expect
      .poll(async () => (await fieldOf(a.page, ids.table, ids.amount))?.type)
      .toBe('text');
    expect(await valueOf(a.page, edited, ids.amount)).toBe('777');
    expect(await valueOf(a.page, ids.records[0] ?? '', ids.amount)).toBe('n/a 0');
    expect(await valueOf(a.page, ids.records[21] ?? '', ids.amount)).toBe('210');
    await expect(cell(b.page, 2, 0)).toContainText('n/a 0', { timeout: 15_000 });
    await a.context.close();
    await b.context.close();
  });

  test('text → select previews the options it creates (board "Đổi kiểu field")', async ({
    browser,
  }) => {
    const a = await openAs(browser);
    await openGrid(a.page);
    const dialog = await editField(a.page, 5);
    await dialog.getByLabel('Field type').selectOption('select');
    const pane = dialog.getByTestId('conversion-pane');
    await expect(pane.getByTestId('stat-new-options')).toContainText('4', { timeout: 20_000 });
    await expect(pane.getByTestId('new-options')).toContainText('Đà Nẵng');
    await expect(dialog.getByText('Create options from the values')).toBeVisible();
    await settled(a.page);
    await expectNoSeriousA11yViolations(a.page, 'text → select');
    await shot(a.page, 'convert-text-select');
    // Only keeping values that match existing options: none exist, all 200 would go.
    await dialog.getByLabel('Keep only values matching an existing option').check();
    await expect(pane.getByTestId('stat-lost')).toContainText('200', { timeout: 20_000 });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await a.context.close();
  });

  test('email style: cells in the wrong format are counted, then marked, nothing lost', async ({
    browser,
  }) => {
    const a = await openAs(browser);
    await openGrid(a.page);
    const dialog = await editField(a.page, 5);
    await dialog.getByLabel('Style').selectOption('email');
    await expect(dialog.getByTestId('stat-invalid')).toContainText('200', { timeout: 20_000 });
    await expect(dialog.getByText('No value is removed.')).toBeVisible();
    await shot(a.page, 'style-email');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
    // The value is kept (copy gives it as is); the canvas draws it marked (screenshot).
    await expect(cell(a.page, 6, 1)).toHaveText('Đà Nẵng', { timeout: 15_000 });
    expect(await valueOf(a.page, ids.records[1] ?? '', ids.area)).toBe('Đà Nẵng');
    await shot(a.page, 'style-email-grid');
    // The record panel marks it too, with the reason for screen readers.
    await a.page.goto(
      `/b/${ids.baseId}/t/${ids.table}/v/${ids.viewId}?record=${ids.records[1] ?? ''}`,
    );
    const panel = a.page.getByTestId('record-field').filter({ hasText: 'Area' });
    await expect(panel).toContainText('Đà Nẵng');
    await expect(panel.getByText('(Not a valid email)')).toBeAttached();
    await a.context.close();
  });

  test('single select → text keeps the option names', async ({ browser }) => {
    test.setTimeout(180_000);
    const a = await openAs(browser);
    await openGrid(a.page);
    const dialog = await editField(a.page, 2);
    await dialog.getByLabel('Field type').selectOption('text');
    const pane = dialog.getByTestId('conversion-pane');
    await expect(pane.getByTestId('stat-lost')).toContainText('0', { timeout: 20_000 });
    await expect(pane.getByTestId('stat-affected')).toContainText('30');
    await expect(pane.getByTestId('conversion-samples')).toContainText('Doing');
    await dialog.getByRole('button', { name: 'Change type' }).click();
    await expect(dialog).toBeHidden();
    await expect(banner(a.page, ids.status)).toHaveAttribute('data-state', 'succeeded', {
      timeout: 120_000,
    });
    expect(await valueOf(a.page, ids.records[1] ?? '', ids.status)).toBe('Doing');
    await expect(cell(a.page, 3, 2)).toContainText('Done');
    await a.context.close();
  });

  test('several records → one: preview of the cut cells, confirm, one link left', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const a = await openAs(browser);
    await openGrid(a.page);
    const dialog = await editField(a.page, 4);
    await dialog.getByRole('switch', { name: 'Allow several records' }).uncheck();
    const pane = dialog.getByTestId('conversion-pane');
    await expect(pane.getByTestId('stat-truncated')).toContainText('3', { timeout: 20_000 });
    await expect(dialog.getByTestId('conversion-confirm')).toContainText(
      '3 cells will keep only their first link.',
    );
    await settled(a.page);
    await expectNoSeriousA11yViolations(a.page, 'link several → one');
    await shot(a.page, 'link-single');
    await dialog.getByLabel('I understand 3 cells will keep only one link').check();
    await dialog.getByRole('button', { name: 'Keep one record' }).click();
    await expect(dialog).toBeHidden();
    await expect(banner(a.page, ids.buyers)).toHaveAttribute('data-state', 'succeeded', {
      timeout: 120_000,
    });
    const links = (await valueOf(a.page, ids.records[0] ?? '', ids.buyers)) as { id: string }[];
    expect(links).toHaveLength(1);
    await a.context.close();
  });

  test('turns on two-way, then off keeping the other side', async ({ browser }) => {
    test.setTimeout(180_000);
    const a = await openAs(browser);
    await openGrid(a.page);
    let dialog = await editField(a.page, 3);
    await expect(dialog.getByTestId('type-locked')).toContainText('Link to another table');
    await dialog.getByRole('switch', { name: 'Two-way link' }).check();
    const name = dialog.getByLabel('Field name in Customers');
    await name.fill(reverseName);
    const pane = dialog.getByTestId('conversion-pane');
    await expect(pane.getByTestId('stat-over-limit')).toContainText('0', { timeout: 20_000 });
    await settled(a.page);
    await expectNoSeriousA11yViolations(a.page, 'two-way on');
    await shot(a.page, 'link-two-way');
    await dialog.getByRole('button', { name: 'Turn on two-way' }).click();
    await expect(dialog).toBeHidden();
    await expect(banner(a.page, ids.customer)).toHaveAttribute('data-state', 'succeeded', {
      timeout: 120_000,
    });
    await expect(banner(a.page, ids.customer)).toContainText('The two-way link of Customer is on.');
    await expect
      .poll(async () => {
        const fields = await ok<{ items: { id: string; name: string }[] }>(
          a.page,
          'GET',
          `/tables/${ids.customers}/fields`,
        );
        return fields.items.find((field) => field.name === reverseName)?.id ?? null;
      })
      .not.toBeNull();

    // Off again: which side stays (board "Tắt liên kết hai chiều").
    await banner(a.page, ids.customer).getByRole('button', { name: 'Hide this message' }).click();
    dialog = await editField(a.page, 3);
    await expect(dialog.getByText(`Reverse field: “${reverseName}” in Customers.`)).toBeVisible();
    // A click (not uncheck): the dialog makes way for "Turn off two-way link" at once.
    await dialog.getByRole('switch', { name: 'Two-way link' }).click();
    const oneWay = a.page.getByRole('dialog', { name: /Turn off two-way link/u });
    await expect(oneWay).toBeVisible();
    await oneWay.getByLabel(`Keep “${reverseName}” in Customers`).check();
    await expect(oneWay.getByTestId('one-way-diagram')).toContainText('Customer');
    await expect(oneWay.getByTestId('stat-dependents')).toBeVisible({ timeout: 20_000 });
    await settled(a.page);
    await expectNoSeriousA11yViolations(a.page, 'two-way off');
    await shot(a.page, 'link-one-way');
    await oneWay.getByTestId('disable-two-way').click();
    await expect(oneWay).toBeHidden({ timeout: 30_000 });
    // The field of this table went to the trash; the Customers side stays, one-way.
    await expect
      .poll(async () => (await fieldOf(a.page, ids.table, ids.customer)) === undefined, {
        timeout: 60_000,
      })
      .toBe(true);
    const fields = await ok<{ items: { name: string; options: Record<string, unknown> }[] }>(
      a.page,
      'GET',
      `/tables/${ids.customers}/fields`,
    );
    expect(fields.items.find((field) => field.name === reverseName)?.options['bidirectional']).toBe(
      false,
    );
    await a.context.close();
  });
});
