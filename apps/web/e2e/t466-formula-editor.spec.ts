import { mkdirSync } from 'node:fs';

import { type Browser, type BrowserContext, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { DEMO_PASSWORD } from './seed';
import {
  animationsSettled,
  api,
  apiSignIn,
  collectCspViolations,
  expectNoSeriousA11yViolations,
  ok,
} from './support';

/**
 * T466: the formula editor (SPEC §9.6) on the demo base (CONTRACTS §9).
 * Tickets has `Trạng thái` (select) and `Số tiền` (VND): the SPEC §9.2
 * example `IF([Trạng thái] = "Đã xong", [Số tiền] * 0.1, 0)` is written
 * with the keyboard only, the preview shows the 5 first rows computed in
 * the browser; `SUM(` is underlined at the end; a formula through Orders'
 * link to its lines is previewed by the server in under a second; a user
 * without schema rights cannot open it; the formula reads on a phone.
 */

const EDITOR_EMAIL = WORKER_ORG.email('editor');
const RUN = String(Date.now()).slice(-6);
/** Screenshots for the design report; saved only when `T466_SHOTS=<dir>` is set. */
const SHOTS = process.env['T466_SHOTS'];

const ids = {
  baseId: '',
  tickets: '',
  orders: '',
  ticketView: '',
  status: '',
  amount: '',
  title: '',
  done: '',
  open: '',
};
const FIELD = `Hoa hồng ${RUN}`;

interface FieldItem {
  id: string;
  name: string;
  type: string;
  is_primary: boolean;
  options: Record<string, unknown>;
}

async function openAs(
  browser: Browser,
  email = WORKER_ORG.email('admin'),
  viewport = { width: 1440, height: 900 },
  colorScheme: 'light' | 'dark' = 'light',
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport, locale: 'en-US', colorScheme });
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
      const base = bases.items.find((item) => item.name === 'Chăm sóc khách hàng');
      if (base === undefined) continue;
      const tables = await ok<{ items: { id: string; name: string }[] }>(
        page,
        'GET',
        `/bases/${base.id}/tables`,
      );
      const id = (name: string) => tables.items.find((table) => table.name === name)?.id ?? '';
      return { baseId: base.id, tickets: id('Tickets'), orders: id('Orders') };
    }
  }
  throw new Error('demo base not found');
}

async function shot(page: Page, name: string) {
  await animationsSettled(page);
  if (SHOTS === undefined) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

async function openTable(page: Page, tableId: string) {
  // Tickets: its unfiltered demo view by id — earlier specs may reorder the views (T470).
  const view = tableId === ids.tickets && ids.ticketView !== '' ? `/v/${ids.ticketView}` : '';
  await page.goto(`/b/${ids.baseId}/t/${tableId}${view}`);
  await expect(page.locator('.ob-grid canvas').first()).toBeVisible();
  await expect(page.getByTestId('glide-cell-1-0')).not.toHaveText('');
}

/** "⋯" → "Add field", name, type "Formula": the formula part of the dialog. */
async function newFormulaField(page: Page, name: string) {
  await page.getByTestId('grid-toolbar-more').click();
  await page.getByRole('menuitem', { name: 'Add field' }).click();
  const dialog = page.getByRole('dialog', { name: 'New field' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Name').fill(name);
  await dialog.getByLabel('Type').selectOption('formula');
  await expect(dialog.getByTestId('formula-field')).toBeVisible();
  return dialog;
}

/** Opens the editor from the field dialog with the keyboard (Tab to the button, Enter). */
async function openEditor(page: Page, dialog: ReturnType<Page['getByRole']>) {
  const button = dialog.getByTestId('formula-open-editor');
  await expect(button).toBeEnabled();
  await button.focus();
  await page.keyboard.press('Enter');
  const editor = page.getByTestId('formula-editor');
  await expect(editor).toBeVisible();
  const input = editor.getByRole('textbox', { name: 'Formula' });
  await expect(input).toBeFocused();
  return { editor, input };
}

function suggestions(page: Page) {
  return page.getByRole('listbox', { name: 'Suggestions' });
}

test.describe.serial('T466 formula editor', () => {
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(240_000);
    const { context, page } = await openAs(browser);
    Object.assign(ids, await findDemo(page));
    const fields = await ok<{ items: FieldItem[] }>(page, 'GET', `/tables/${ids.tickets}/fields`);
    const status = fields.items.find((field) => field.name === 'Trạng thái');
    ids.status = status?.id ?? '';
    const options = (status?.options['options'] ?? []) as { id: string; name: string }[];
    ids.done = options.find((option) => option.name === 'Đã xong')?.id ?? '';
    ids.open = options.find((option) => option.name === 'Mới')?.id ?? '';
    ids.amount = fields.items.find((field) => field.name === 'Số tiền')?.id ?? '';
    ids.title = fields.items.find((field) => field.is_primary)?.id ?? '';
    const views = await ok<{ items: { id: string; name: string }[] }>(
      page,
      'GET',
      `/tables/${ids.tickets}/views`,
    );
    // The unfiltered "Tất cả phiếu" (CONTRACTS §9), whatever order earlier specs left (T470).
    ids.ticketView = views.items.find((view) => view.name === 'Tất cả phiếu')?.id ?? '';
    // The first two rows of the view: one done, one not, with known amounts.
    const first = await ok<{ records: { id: string; version: number }[] }>(
      page,
      'POST',
      `/tables/${ids.tickets}/records/query?field_key_type=id`,
      { view_id: ids.ticketView, offset: 0, limit: 2, include_total: false },
    );
    const [a, b] = first.records;
    if (a === undefined || b === undefined) throw new Error('no tickets');
    await ok(page, 'PATCH', `/tables/${ids.tickets}/records?field_key_type=id`, {
      records: [
        {
          id: a.id,
          version: a.version,
          fields: { [ids.status]: ids.done, [ids.amount]: 1_500_000 },
        },
        { id: b.id, version: b.version, fields: { [ids.status]: ids.open, [ids.amount]: 200_000 } },
      ],
    });
    await context.close();
  });

  test('writes the SPEC §9.2 example with the keyboard; preview of the 5 first rows', async ({
    browser,
  }) => {
    const { context, page } = await openAs(browser);
    const csp = collectCspViolations(page);
    await openTable(page, ids.tickets);
    const dialog = await newFormulaField(page, FIELD);
    await shot(page, 'field-dialog-empty');
    await expectNoSeriousA11yViolations(page, 'field dialog, formula type');
    const { editor, input } = await openEditor(page, dialog);

    // T470: `[` alone lists every field and table — one page at a time, never a
    // scrolling list the keyboard cannot reach (axe scrollable-region-focusable).
    // T527: typed while the dialog still animates (a transformed ancestor),
    // CodeMirror places the suggestions "absolute" for good; they must not
    // turn the box around the editor into a scroll region either.
    await editor.evaluate((element) => {
      element.style.transform = 'translateZ(0)';
    });
    await page.keyboard.type('[');
    await expect(suggestions(page).getByRole('option')).toHaveCount(8);
    await expectNoSeriousA11yViolations(page, 'formula editor, all suggestions');
    await page.keyboard.press('Escape');
    await editor.evaluate((element) => {
      element.style.transform = '';
    });
    await page.keyboard.press('Backspace');

    // `IF([Tr` → the field "Trạng thái" first (decision #3), Tab inserts it as a chip.
    await page.keyboard.type('IF([Tr');
    const list = suggestions(page);
    await expect(list).toBeVisible();
    await expect(list.getByRole('option').first()).toContainText('Trạng thái');
    await expect(list.getByRole('option', { selected: true })).toContainText('Trạng thái');
    await shot(page, 'autocomplete');
    await expectNoSeriousA11yViolations(page, 'formula editor, suggestions');
    await page.keyboard.press('Tab');
    await expect(list).toBeHidden();
    await expect(input.locator('[data-chip="field"]')).toHaveText('Trạng thái');

    await page.keyboard.type(' = "Đã xong", [Số');
    await expect(list.getByRole('option', { selected: true })).toContainText('Số tiền');
    // CodeMirror ignores Enter/Tab for 75 ms after the list changes (no accidental accept
    // while typing); a person reading the list takes longer than that.
    await page.waitForTimeout(150);
    await page.keyboard.press('Enter');
    await page.keyboard.type(' * 0.1, 0)');
    // Names show as chips: the text reads without brackets.
    await expect
      // (the browser keeps typed spaces next to chips as no-break spaces in the DOM)
      .poll(() => input.evaluate((element) => element.textContent.replace(/\u00a0/gu, ' ')))
      .toBe('IF(Trạng thái = "Đã xong", Số tiền * 0.1, 0)');

    // No error; a stored number carrying the currency of "Số tiền".
    await expect(editor.getByTestId('formula-errors')).toHaveCount(0);
    await expect(editor.getByTestId('formula-result-type')).toHaveText('Number');
    await expect(editor.getByTestId('formula-compute-mode')).toContainText(
      'Stored, computed again when its data changes.',
    );
    await expect(editor.getByRole('group', { name: 'Number format' })).toBeVisible();

    // The preview: 5 rows of the grid, computed in the browser, no server preview.
    const previews: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/computed-preview')) previews.push(request.url());
    });
    const rows = await ok<{ records: { id: string; fields: Record<string, unknown> }[] }>(
      page,
      'POST',
      `/tables/${ids.tickets}/records/query?field_key_type=id`,
      { view_id: ids.ticketView, offset: 0, limit: 5, include_total: false },
    );
    const value = editor.getByTestId('formula-preview-value');
    const row = editor.getByTestId('formula-preview-row');
    for (const [index, record] of rows.records.entries()) {
      const raw = record.fields[ids.title];
      const title = typeof raw === 'string' ? raw : '';
      await expect(row).toHaveText(
        `Record ${String(index + 1)} / 5 · ${title === '' ? 'Untitled' : title}`,
      );
      const amount = Number(record.fields[ids.amount] ?? 0);
      // A select reads as its option name in JSON (CONTRACTS §2).
      const expected = record.fields[ids.status] === 'Đã xong' ? Math.round(amount * 0.1) : 0;
      await expect
        .poll(async () => (await value.textContent())?.replace(/\D/gu, ''))
        .toBe(String(expected));
      if (index < 4) await editor.getByRole('button', { name: 'Next record' }).click();
    }
    await expect(editor.getByRole('button', { name: 'Next record' })).toBeDisabled();
    expect(previews).toEqual([]);
    await shot(page, 'dialog-light');
    await expectNoSeriousA11yViolations(page, 'formula editor');

    // Ctrl/⌘+Enter confirms: the field is saved and its values computed in the background.
    await input.click();
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(editor).toBeHidden();
    await expect(dialog).toBeHidden();
    const fields = await ok<{ items: FieldItem[] }>(page, 'GET', `/tables/${ids.tickets}/fields`);
    const saved = fields.items.find((field) => field.name === FIELD);
    expect(saved?.type).toBe('formula');
    expect(saved?.options['expression']).toBe('IF([Trạng thái] = "Đã xong", [Số tiền] * 0.1, 0)');
    expect(csp).toEqual([]);
    await context.close();
  });

  test('SUM( is underlined where it ends; Confirm stays blocked; Esc closes the list first', async ({
    browser,
  }) => {
    const { context, page } = await openAs(browser);
    await openTable(page, ids.tickets);
    const dialog = await newFormulaField(page, `Lỗi ${RUN}`);
    const { editor, input } = await openEditor(page, dialog);
    await page.keyboard.type('SUM(');
    const errors = editor.getByTestId('formula-errors');
    await expect(errors).toBeVisible();
    await expect(errors.getByRole('listitem')).toHaveCount(1);
    await expect(errors).toContainText('Missing ) to close SUM(.');
    await expect(errors).toContainText('1:5');
    const errorsId = await errors.getAttribute('id');
    await expect(input).toHaveAttribute('aria-describedby', errorsId ?? '');
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    // The mark sits right after "SUM(" (a zero-width error at offset 4).
    const mark = input.locator('.cm-fx-error-point');
    await expect(mark).toHaveCount(1);
    const text = await input.evaluate((element) => {
      const point = element.querySelector('.cm-fx-error-point');
      const range = document.createRange();
      range.setStart(element, 0);
      if (point !== null) range.setEndBefore(point);
      return range.toString();
    });
    expect(text).toBe('SUM(');
    const confirm = editor.getByTestId('formula-confirm');
    await expect(confirm).toHaveAttribute('aria-disabled', 'true');
    await expect(editor.getByText('Fix 1 error to confirm')).toBeVisible();
    await shot(page, 'errors');
    await expectNoSeriousA11yViolations(page, 'formula editor, errors');
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(editor).toBeVisible();

    // Esc closes the suggestions, then asks before dropping the changes.
    await page.keyboard.type('[');
    await expect(suggestions(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(suggestions(page)).toBeHidden();
    await expect(editor).toBeVisible();
    await page.keyboard.press('Escape');
    const ask = editor.getByRole('alertdialog', { name: 'Discard the changes to this formula?' });
    await expect(ask).toBeVisible();
    await ask.getByRole('button', { name: 'Discard' }).click();
    await expect(editor).toBeHidden();
    await expect(dialog).toBeVisible();
    await context.close();
  });

  test('cross-table formula: server preview in under a second; slow patterns warned', async ({
    browser,
  }) => {
    const { context, page } = await openAs(browser);
    await openTable(page, ids.orders);
    const dialog = await newFormulaField(page, `Tổng dòng ${RUN}`);
    const { editor } = await openEditor(page, dialog);
    const requests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/computed-preview')) requests.push(request.url());
    });
    await page.keyboard.type('[Chi tiết đơn hàng].[Đơn giá].SUM()');
    const typed = Date.now();
    const value = editor.getByTestId('formula-preview-value');
    await expect(value).toHaveText(/\d/u, { timeout: 5_000 });
    const elapsed = Date.now() - typed;
    expect(elapsed, `preview after ${String(elapsed)} ms`).toBeLessThan(1_000);
    // Typing fast: the debounce sends one request (older ones would be aborted).
    expect(requests.length).toBeLessThanOrEqual(2);
    await expect(editor.getByTestId('formula-preview-row')).toContainText('/ 5');
    await expect(editor.getByTestId('formula-result-type')).toHaveText('Number');

    // Another table without a link, computed on read (TODAY()): the static warning.
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type(
      '[Customers].FILTER(CurrentValue.[Ngày tham gia] < TODAY()).[Tên].ARRAYJOIN(", ")',
    );
    await expect(editor.getByTestId('formula-perf-warning')).toBeVisible();
    await expect(editor.getByTestId('formula-compute-mode')).toContainText('because TODAY()');
    await shot(page, 'perf-warning');
    await context.close();
  });

  test('dark theme and the catalogue', async ({ browser }) => {
    const { context, page } = await openAs(
      browser,
      WORKER_ORG.email('admin'),
      { width: 1440, height: 900 },
      'dark',
    );
    await openTable(page, ids.tickets);
    const dialog = await newFormulaField(page, `Tối ${RUN}`);
    const { editor } = await openEditor(page, dialog);
    await page.keyboard.type('[Trạng thái].');
    await expect(suggestions(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(suggestions(page)).toBeHidden();
    const list = editor.getByTestId('formula-catalogue-list');
    await editor.getByRole('tab', { name: /^List/u }).click();
    await list.getByRole('option', { name: /FILTER/u }).click();
    await expect(editor.getByTestId('formula-docs')).toContainText('Syntax');
    await expect(editor.getByTestId('formula-docs')).toContainText('FILTER(range, condition)');
    await editor.getByRole('searchbox', { name: 'Search functions or fields' }).fill('trang');
    await expect(list.getByRole('option').first()).toContainText('Trạng thái');
    await shot(page, 'dialog-dark');
    await expectNoSeriousA11yViolations(page, 'formula editor, dark');
    await context.close();
  });

  test('a user without schema rights cannot open it', async ({ browser }) => {
    const { context, page } = await openAs(browser, EDITOR_EMAIL);
    await openTable(page, ids.tickets);
    await page.getByTestId('grid-toolbar-more').click();
    await expect(page.getByRole('menuitem', { name: 'Add field' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    const answer = await api(page, 'POST', `/tables/${ids.tickets}/computed-preview`, {
      type: 'formula',
      options: { expression: '[Số tiền] * 2' },
    });
    expect(answer.status).toBe(403);
    await context.close();
  });

  test('reads on a phone: formula with chips, no editor, copy', async ({ browser }) => {
    const { context, page } = await openAs(browser);
    await openTable(page, ids.tickets);
    const fields = await ok<{ items: FieldItem[] }>(page, 'GET', `/tables/${ids.tickets}/fields`);
    const saved = fields.items.find((field) => field.name === FIELD);
    expect(saved).toBeDefined();
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    // Open the saved field's dialog on the desktop layout (the last column: End, then
    // Shift+F10 for its header menu), then narrow the window to a phone.
    const canvas = page.locator('.ob-grid [data-testid="data-grid-canvas"]');
    const box = await canvas.boundingBox();
    if (box === null) throw new Error('grid not laid out');
    // Primary cell of the first row: past the row numbers (48 px for 4 digits), under the header.
    await page.mouse.click(box.x + 48 + 24, box.y + 36 + 34 / 2);
    await expect(page.getByTestId('glide-cell-1-0')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('End');
    await page.keyboard.press('Shift+F10');
    await page.getByRole('menuitem', { name: 'Edit field' }).click();
    const dialog = page.getByRole('dialog', { name: /Edit field/u });
    await expect(dialog.getByLabel('Name')).toHaveValue(FIELD);
    await shot(page, 'field-dialog-saved');
    await expect(dialog.getByTestId('formula-field-text')).toContainText('Trạng thái');
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(dialog.getByTestId('formula-open-editor')).toBeHidden();
    await expect(dialog.getByText('Edit on a screen of 768 px or more')).toBeVisible();
    const copy = dialog.getByRole('button', { name: 'Copy formula' });
    await expect(copy).toBeVisible();
    expect((await copy.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await copy.click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe('IF([Trạng thái] = "Đã xong", [Số tiền] * 0.1, 0)');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await shot(page, 'mobile');
    await expectNoSeriousA11yViolations(page, 'formula field, 375 px');
    await context.close();
  });
});
