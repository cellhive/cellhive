import { type Page, type Request } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { DEMO_ORDER_TITLE, DEMO_PASSWORD } from './seed';
import { api, apiSignIn, collectCspViolations, expectNoSeriousA11yViolations } from './support';

/**
 * T205: clipboard, undo, fill-down and shortcuts on the demo base
 * (CONTRACTS §9): a 500-cell paste is one bulk PATCH and one undo step, a
 * paste with a bad value writes nothing and marks the cell, the Sales role
 * (`base_rule.copy = false`) cannot copy, Ctrl/⌘+D fills down, `?` lists
 * the shortcuts.
 */

const DEMO_BASE = 'Chăm sóc khách hàng';
const SALES1_EMAIL = WORKER_ORG.email('sales1');
/** Row markers of a grid with up to 9 999 rows (GridView: 4 digits × 8 + 16). */
const ROW_MARKER_WIDTH = 48;
const HEADER_HEIGHT = 36;
const ROW_HEIGHT = 34;

interface RecordRow {
  id: string;
  version: number;
  fields: Record<string, unknown>;
}

/** Signs in with the shared `apiSignIn` (waits out the per-IP limit). */
async function signIn(page: Page, email: string) {
  await page.addInitScript(() => {
    if (window.localStorage.getItem('cellhive.language') === null) {
      window.localStorage.setItem('cellhive.language', 'en');
    }
  });
  await page.goto('/login');
  await apiSignIn(page, email, DEMO_PASSWORD);
}

/** Opens a table of the demo base from the organization home. */
async function openTable(page: Page, tableName: string) {
  await page.goto('/');
  await page.getByRole('link', { name: DEMO_BASE }).first().click();
  await expect(page).toHaveURL(/\/t\/tbl_/u);
  // A role that sees one table has no table tabs: the base opens on it.
  const heading = page.getByRole('heading', { level: 1, name: tableName });
  const tab = page
    .getByRole('navigation', { name: 'Tables' })
    .getByRole('link', { name: tableName });
  await expect(heading.or(tab).first()).toBeVisible();
  if (!(await heading.isVisible())) await tab.click();
  await expect(page.getByRole('heading', { level: 1, name: tableName })).toBeVisible();
  await expect(page.locator('table[role="grid"] td[role="gridcell"]').first()).toBeAttached();
  const tableId = /\/t\/(tbl_[^/?]+)/u.exec(page.url())?.[1];
  if (tableId === undefined) throw new Error('no table id in the URL');
  return tableId;
}

/** 1-based column of a field in glide's accessibility table. */
async function columnOf(page: Page, fieldName: string): Promise<number> {
  const header = page
    .locator('table[role="grid"] th[role="columnheader"]')
    .filter({ hasText: new RegExp(`^${fieldName}$`, 'u') });
  return Number(await header.getAttribute('aria-colindex'));
}

function cell(page: Page, column: number, row = 0) {
  return page.getByTestId(`glide-cell-${String(column)}-${String(row)}`);
}

/** Selects the cell of `fieldName` in data row `row` (0-based) with the keyboard. */
async function selectCell(page: Page, fieldName: string, row = 0) {
  const canvas = page.locator('.ob-grid [data-testid="data-grid-canvas"]');
  const box = await canvas.boundingBox();
  if (box === null) throw new Error('grid not laid out');
  await page.mouse.click(
    box.x + ROW_MARKER_WIDTH + 24,
    box.y + HEADER_HEIGHT + ROW_HEIGHT * row + ROW_HEIGHT / 2,
  );
  await expect(cell(page, 1, row)).toHaveAttribute('aria-selected', 'true');
  // Glide focuses the grid on the next animation frame: keys pressed before go nowhere.
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.closest('.ob-grid') != null))
    .toBe(true);
  const column = await columnOf(page, fieldName);
  for (let step = 1; step < column; step += 1) await page.keyboard.press('ArrowRight');
  await expect(cell(page, column, row)).toHaveAttribute('aria-selected', 'true');
}

function isRecordWrite(request: Request): boolean {
  return (
    request.method() === 'PATCH' && /\/api\/v1\/tables\/tbl_[^/]+\/records\?/u.test(request.url())
  );
}

async function fieldId(page: Page, tableId: string, name: string): Promise<string> {
  const answer = await api<{ items: { id: string; name: string }[] }>(
    page,
    'GET',
    `/tables/${tableId}/fields`,
  );
  const found = answer.body.items.find((item) => item.name === name);
  if (found === undefined) throw new Error(`no field ${name}`);
  return found.id;
}

/** The first `limit` records in grid order (no sort: creation order). */
async function firstRecords(page: Page, tableId: string, limit: number): Promise<RecordRow[]> {
  const answer = await api<{ records: RecordRow[] }>(
    page,
    'POST',
    `/tables/${tableId}/records/query?field_key_type=id`,
    { offset: 0, limit },
  );
  expect(answer.status).toBe(200);
  return answer.body.records;
}

/** A text field's value as the grid shows it (empty cell: ''). */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

async function writeClipboard(page: Page, text: string) {
  await page.evaluate((value) => navigator.clipboard.writeText(value), text);
}

async function readClipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

test.describe.serial('T205 clipboard, undo, fill-down, shortcuts', () => {
  test.use({ viewport: { width: 1920, height: 1000 } });

  test.beforeEach(async ({ context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  });

  test('pasting 500 cells is one PATCH and one undo step; undo restores them', async ({ page }) => {
    const cspViolations = collectCspViolations(page);
    await signIn(page, WORKER_ORG.email('admin'));
    const tableId = await openTable(page, 'Tickets');
    const description = await fieldId(page, tableId, 'Mô tả');
    const before = await firstRecords(page, tableId, 500);
    expect(before).toHaveLength(500);

    const writes: Request[] = [];
    page.on('request', (request) => {
      if (isRecordWrite(request)) writes.push(request);
    });
    const suffix = String(Date.now());
    const pasted = before.map((_, index) => `Dán ${suffix} #${String(index)}`);
    await writeClipboard(page, `${pasted.join('\r\n')}\r\n`);
    await selectCell(page, 'Mô tả');
    const answered = page.waitForResponse(
      (response) => isRecordWrite(response.request()) && response.status() === 200,
    );
    await page.keyboard.press('ControlOrMeta+v');
    await answered;
    const column = await columnOf(page, 'Mô tả');
    await expect(cell(page, column, 0)).toHaveText(pasted[0] ?? '');
    await expect(cell(page, column, 3)).toHaveText(pasted[3] ?? '');

    expect(writes).toHaveLength(1);
    const body = writes[0]?.postDataJSON() as { records: RecordRow[] };
    expect(body.records).toHaveLength(500);
    expect(writes[0]?.url()).toContain('typecast=true');
    const after = await firstRecords(page, tableId, 500);
    expect(after.map((record) => record.fields[description])).toEqual(pasted);

    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    const redo = page.getByRole('button', { name: 'Redo', exact: true });
    await expect(undo).toBeEnabled();
    await expect(redo).toBeDisabled();
    await page.screenshot({ path: test.info().outputPath('after-paste.png') });

    const undone = page.waitForResponse(
      (response) => isRecordWrite(response.request()) && response.status() === 200,
    );
    await page.keyboard.press('ControlOrMeta+z');
    await undone;
    // One step: the paste is undone as a whole, nothing is left to undo.
    await expect(undo).toBeDisabled();
    await expect(redo).toBeEnabled();
    expect(writes).toHaveLength(2);
    const restored = await firstRecords(page, tableId, 500);
    expect(restored.map((record) => record.fields[description] ?? null)).toEqual(
      before.map((record) => record.fields[description] ?? null),
    );
    await expect(cell(page, column, 0)).toHaveText(textOf(before[0]?.fields[description]));
    await expectNoSeriousA11yViolations(page, 'grid after undo');
    expect(cspViolations).toEqual([]);
  });

  test('a paste with a value the server refuses writes nothing and marks the cell', async ({
    page,
  }) => {
    await signIn(page, WORKER_ORG.email('admin'));
    const tableId = await openTable(page, 'Tickets');
    const amount = await fieldId(page, tableId, 'Số tiền');
    const before = await firstRecords(page, tableId, 3);

    await writeClipboard(page, '100\nabc\n200');
    await selectCell(page, 'Số tiền');
    const refused = page.waitForResponse(
      (response) => isRecordWrite(response.request()) && response.status() === 422,
    );
    await page.keyboard.press('ControlOrMeta+v');
    await refused;
    await expect(
      page.getByText('Nothing was saved: 1 cell has a value that is not accepted.'),
    ).toBeVisible();

    const after = await firstRecords(page, tableId, 3);
    expect(after.map((record) => record.fields[amount] ?? null)).toEqual(
      before.map((record) => record.fields[amount] ?? null),
    );
    expect(after.map((record) => record.version)).toEqual(before.map((record) => record.version));
    // The refused cell explains itself when selected (FRONTEND §4.1).
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.ob-grid [role="status"]')).toHaveText('Expected a number.');
    await page.screenshot({ path: test.info().outputPath('invalid-paste.png') });
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  });

  test('copy writes TSV; Ctrl/⌘+D fills down with one PATCH', async ({ page }) => {
    await signIn(page, WORKER_ORG.email('admin'));
    const tableId = await openTable(page, 'Tickets');
    const title = await fieldId(page, tableId, 'Tiêu đề');
    const before = await firstRecords(page, tableId, 3);

    await selectCell(page, 'Tiêu đề');
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('ControlOrMeta+c');
    await expect
      .poll(() => readClipboard(page))
      .toBe(before.map((record) => textOf(record.fields[title])).join('\n'));

    const writes: Request[] = [];
    page.on('request', (request) => {
      if (isRecordWrite(request)) writes.push(request);
    });
    const filled = page.waitForResponse(
      (response) => isRecordWrite(response.request()) && response.status() === 200,
    );
    await page.keyboard.press('ControlOrMeta+d');
    await filled;
    expect(writes).toHaveLength(1);
    const after = await firstRecords(page, tableId, 3);
    expect(after.map((record) => record.fields[title])).toEqual([
      before[0]?.fields[title],
      before[0]?.fields[title],
      before[0]?.fields[title],
    ]);
    // Undo puts the two filled cells back.
    const undone = page.waitForResponse(
      (response) => isRecordWrite(response.request()) && response.status() === 200,
    );
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await undone;
    const restored = await firstRecords(page, tableId, 3);
    expect(restored.map((record) => record.fields[title])).toEqual(
      before.map((record) => record.fields[title]),
    );
  });

  test('a role without copy (base_rule.copy = false) leaves the clipboard unchanged', async ({
    page,
  }) => {
    await signIn(page, SALES1_EMAIL);
    await openTable(page, 'Orders');
    await writeClipboard(page, 'sentinel');
    await selectCell(page, DEMO_ORDER_TITLE);
    await page.keyboard.press('ControlOrMeta+c');
    await expect(page.getByText('Copying is turned off for your role in this base.')).toBeVisible();
    expect(await readClipboard(page)).toBe('sentinel');
    await page.keyboard.press('ControlOrMeta+x');
    expect(await readClipboard(page)).toBe('sentinel');
  });

  test('? lists the keyboard shortcuts', async ({ page }) => {
    await signIn(page, WORKER_ORG.email('admin'));
    await openTable(page, 'Tickets');
    await selectCell(page, 'Tiêu đề');
    await page.keyboard.press('?');
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('rowheader', { name: 'Undo', exact: true })).toBeVisible();
    await expect(
      dialog.getByRole('rowheader', { name: 'Fill down from the first cell of the selection' }),
    ).toBeVisible();
    await expectNoSeriousA11yViolations(page, 'shortcuts dialog');
    await page.screenshot({ path: test.info().outputPath('shortcuts.png') });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    // "?" did not start editing the cell.
    await expect(page.locator('#portal').getByRole('textbox')).toHaveCount(0);

    // Space opens the record panel (T206) instead of the editor.
    await selectCell(page, 'Tiêu đề', 1);
    await page.keyboard.press('Space');
    await expect(page).toHaveURL(/[?&]record=rec_/u);
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.locator('#portal').getByRole('textbox')).toHaveCount(0);
  });
});
