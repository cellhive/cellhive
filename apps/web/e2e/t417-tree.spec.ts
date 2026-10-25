import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { type Browser, type BrowserContext, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { DEMO_PASSWORD } from './seed';
import {
  apiSignIn,
  collectCspViolations,
  expectNoSeriousA11yViolations,
  ok,
  signInFirstAdmin,
} from './support';

/**
 * T417: sub-records as a tree in the grid (board "Sub-records dạng cây"):
 * turning sub-records and the tree on, expanding branches, "+ Sub-record",
 * drag ⋮⋮ to change the parent, Ctrl/⌘+] / [ to indent and outdent, the
 * cycle and 10-level refusals, deleting a parent (children promoted or the
 * whole branch) and restoring the branch from the trash, a filter showing
 * the matches' ancestors dimmed, u_sales1's locked ancestors, and a move
 * seen in a second tab. Self-contained base (plus the demo base for u_sales1).
 *
 * `T417_SHOTS=<dir>` also writes the report's screenshots there.
 */
const ADMIN = {
  name: 'Nguyễn Văn Ánh',
  email: WORKER_ORG.ownerEmail,
  password: 'E2E-Setup-Password-2026',
};
const SHOTS = process.env['T417_SHOTS'];

const HEADER_HEIGHT = 36;
const ROW_HEIGHT = 34;
/** Row gutter of a grid with fewer than 1 000 rows. */
const GUTTER = 40;
const PRIMARY_WIDTH = 360;

type Session = Awaited<ReturnType<BrowserContext['storageState']>>;
let session: Session | undefined;

async function openAdmin(
  browser: Browser,
  options: { language?: 'en' | 'vi'; width?: number } = {},
): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: options.width ?? 1440, height: 900 },
    ...(session === undefined ? {} : { storageState: session }),
  });
  await context.addInitScript((language) => {
    window.localStorage.setItem('cellhive.language', language);
  }, options.language ?? 'en');
  const page = await context.newPage();
  await page.goto('/login');
  if (session === undefined) {
    await apiSignIn(page, ADMIN.email, ADMIN.password);
    session = await context.storageState();
  }
  return page;
}

/** Text of the primary cell of a row (glide's accessibility table; column 0 is the gutter). */
function cell(page: Page, row: number, column = 1) {
  return page.getByTestId(`glide-cell-${String(column)}-${String(row)}`);
}

/**
 * Primary texts of the rows, read in one go: glide rebuilds its accessibility
 * table (debounced) after the rows change. Reading the row count, then each
 * cell with its own call, can straddle a rebuild: a row deleted meanwhile
 * leaves a cell that never comes, and the poll times out on that one read.
 */
async function primaryTexts(page: Page): Promise<string[]> {
  return page
    .locator('.ob-grid table')
    .first()
    .evaluate((table) => {
      const count = Number(table.getAttribute('aria-rowcount') ?? '1');
      const texts: string[] = [];
      for (let row = 0; row < count - 1; row += 1) {
        const primary = table.querySelector(`[data-testid="glide-cell-1-${String(row)}"]`);
        texts.push((primary?.textContent ?? '').trim());
      }
      return texts;
    });
}

async function canvasBox(page: Page) {
  const box = await page.locator('.ob-grid [data-testid="data-grid-canvas"]').boundingBox();
  if (box === null) throw new Error('grid not laid out');
  return box;
}

/** A point in a row: `x` px into the primary column, `fraction` down the row. */
async function rowPoint(page: Page, row: number, x = 120, fraction = 0.5) {
  const box = await canvasBox(page);
  return {
    x: box.x + GUTTER + x,
    y: box.y + HEADER_HEIGHT + row * ROW_HEIGHT + ROW_HEIGHT * fraction,
  };
}

async function clickCaret(page: Page, row: number, depth = 0) {
  const point = await rowPoint(page, row, 4 + depth * 20 + 10);
  await page.mouse.click(point.x, point.y);
}

async function selectRow(page: Page, row: number) {
  const point = await rowPoint(page, row, PRIMARY_WIDTH - 60);
  await page.mouse.click(point.x, point.y);
  // Glide focuses the grid on the next animation frame; on a busy machine keys
  // pressed before it went to the search box and the selection never moved.
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.closest('.ob-grid') != null))
    .toBe(true);
  // A frame requested now runs after glide's queued `focus()`: the focus is settled.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          resolve();
        });
      }),
  );
}

/** Drags the row's ⋮⋮ handle to a place in another row. */
async function drag(page: Page, from: number, to: number, fraction: number) {
  const start = await rowPoint(page, from);
  await page.mouse.move(start.x, start.y);
  const handle = page.getByTestId('tree-drag-handle');
  await expect(handle).toBeVisible();
  const box = await handle.boundingBox();
  if (box === null) throw new Error('no drag handle');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  const end = await rowPoint(page, to, 120, fraction);
  await page.mouse.move(end.x, end.y, { steps: 8 });
}

async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
  if (SHOTS !== undefined) {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  }
}

interface TreeRecord {
  id: string;
  fields: Record<string, unknown>;
}

test.describe.serial('T417 sub-records tree', () => {
  const ids = { baseId: '', tableId: '', viewId: '', primaryId: '', statusId: '', parentId: '' };
  const byName = new Map<string, string>();
  const viewPath = () => `/b/${ids.baseId}/t/${ids.tableId}/v/${ids.viewId}`;

  const create = async (page: Page, name: string, parent: string | null, status = 'Đang làm') => {
    const answer = await ok<{ records: TreeRecord[] }>(
      page,
      'POST',
      `/tables/${ids.tableId}/records?field_key_type=id`,
      {
        records: [
          {
            fields: { [ids.primaryId]: name, [ids.statusId]: status },
            ...(parent === null ? {} : { parent_id: byName.get(parent) }),
          },
        ],
      },
    );
    const id = answer.records[0]?.id ?? '';
    byName.set(name, id);
    return id;
  };
  const parentOf = async (page: Page, name: string): Promise<string | null> => {
    const record = await ok<TreeRecord>(
      page,
      'GET',
      `/tables/${ids.tableId}/records/${byName.get(name) ?? ''}?field_key_type=id`,
    );
    const value = record.fields[ids.parentId] as { title?: string } | null;
    return value?.title ?? null;
  };
  const openGrid = async (page: Page, expected: string[]) => {
    await page.goto(viewPath());
    await expect.poll(() => primaryTexts(page)).toEqual(expected);
  };

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    const page = await browser.newPage();
    await page.goto('/login');
    // Any order of the specs (T470/T527): set up, signed in, or invited by the demo admin.
    await signInFirstAdmin(page, ADMIN);
    await page.close();
    const admin = await openAdmin(browser);
    const me = await ok<{ orgs: { id: string }[] }>(admin, 'GET', '/me');
    const orgId = me.orgs[0]?.id ?? '';
    const workspace = await ok<{ id: string }>(admin, 'POST', `/orgs/${orgId}/workspaces`, {
      name: 'Nhóm T417',
    });
    const base = await ok<{ id: string }>(admin, 'POST', `/workspaces/${workspace.id}/bases`, {
      name: 'Dự án cửa hàng',
    });
    ids.baseId = base.id;
    const table = await ok<{ id: string; primary_field_id: string }>(
      admin,
      'POST',
      `/bases/${base.id}/tables`,
      { name: 'Công việc' },
    );
    ids.tableId = table.id;
    ids.primaryId = table.primary_field_id;
    ids.statusId = (
      await ok<{ id: string }>(admin, 'POST', `/tables/${table.id}/fields`, {
        name: 'Trạng thái',
        type: 'select',
        options: {
          options: [{ name: 'Đang làm' }, { name: 'Xong' }, { name: 'Chưa làm' }],
        },
      })
    ).id;
    const views = await ok<{ items: { id: string }[] }>(admin, 'GET', `/tables/${table.id}/views`);
    ids.viewId = views.items[0]?.id ?? '';
    await ok(admin, 'PATCH', `/views/${ids.viewId}`, {
      config: { row_height: 'short', column_widths: { [ids.primaryId]: PRIMARY_WIDTH } },
    });
    await admin.context().close();
  });

  test('turns sub-records and the tree on, then opens branches (caret, →)', async ({ browser }) => {
    const page = await openAdmin(browser);
    const csp = collectCspViolations(page);
    await page.goto(viewPath());
    await page.getByTestId('tree-button').click();
    await page.getByTestId('tree-enable').click();
    await expect(page.getByTestId('tree-toggle')).toBeChecked();
    const fields = await ok<{ items: { id: string; type: string }[] }>(
      page,
      'GET',
      `/tables/${ids.tableId}/fields`,
    );
    ids.parentId = fields.items.find((field) => field.type === 'parent')?.id ?? '';
    expect(ids.parentId).not.toBe('');
    await page.keyboard.press('Escape');
    // Save the tree on the view (the change was temporary, like a group).
    await ok(page, 'PATCH', `/views/${ids.viewId}`, {
      config: { tree: { enabled: true, show_ancestors: true } },
    });

    await create(page, 'Mở cửa hàng Đà Nẵng', null);
    await create(page, 'Khảo sát mặt bằng', 'Mở cửa hàng Đà Nẵng', 'Xong');
    await create(page, 'Thi công', 'Mở cửa hàng Đà Nẵng');
    await create(page, 'Điện và chiếu sáng', 'Thi công');
    await create(page, 'Đi dây quầy thu ngân', 'Điện và chiếu sáng', 'Xong');
    await create(page, 'Lắp đèn biển hiệu', 'Điện và chiếu sáng', 'Chưa làm');
    await create(page, 'Tuyển nhân sự', 'Mở cửa hàng Đà Nẵng');
    await create(page, 'Kiểm kê quý 3', null);
    await create(page, 'Chuẩn bị khai trương', null, 'Chưa làm');

    await openGrid(page, ['Mở cửa hàng Đà Nẵng', 'Kiểm kê quý 3', 'Chuẩn bị khai trương']);
    // T421b: at the top of the grid no parent path covers the first rows.
    await expect(page.getByTestId('tree-sticky-path')).toHaveCount(0);
    // treegrid: levels and open state on the rows.
    const firstRow = page.locator('.ob-grid table[role="treegrid"] tbody tr').first();
    await expect(firstRow).toHaveAttribute('aria-level', '1');
    await expect(firstRow).toHaveAttribute('aria-expanded', 'false');
    // T421b: one level = only the roots, every branch closed.
    await expect(page.getByTestId('tree-button')).toHaveAccessibleName('Tree: collapsed');
    // The footer counts every record, then the rows the open branches show.
    await expect(page.locator('footer p[role="status"]')).toHaveText('9 records');
    await expect(page.getByTestId('footer-shown')).toHaveText('3 shown');

    await clickCaret(page, 0);
    await expect
      .poll(() => primaryTexts(page))
      .toEqual([
        'Mở cửa hàng Đà Nẵng',
        'Khảo sát mặt bằng',
        'Thi công',
        'Tuyển nhân sự',
        'Kiểm kê quý 3',
        'Chuẩn bị khai trương',
      ]);
    await expect(firstRow).toHaveAttribute('aria-expanded', 'true');
    // The open root is still on screen: no path over it, its row stays clickable.
    await expect(page.getByTestId('tree-sticky-path')).toHaveCount(0);
    // → on the first column opens a closed branch.
    await selectRow(page, 2);
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => primaryTexts(page)).toContain('Điện và chiếu sáng');
    await expect(
      page.locator('.ob-grid table[role="treegrid"] tbody tr[aria-level="3"]'),
    ).toHaveCount(1);
    await shoot(page, 'tree-grid');
    // The row menu (right click).
    const menuPoint = await rowPoint(page, 2);
    await page.mouse.click(menuPoint.x, menuPoint.y, { button: 'right' });
    await expect(page.getByTestId('tree-row-menu')).toBeVisible();
    await shoot(page, 'tree-row-menu');
    await page.keyboard.press('Escape');
    await expectNoSeriousA11yViolations(page, 'tree grid');
    expect(csp).toEqual([]);
    await page.context().close();
  });

  test('"+ Sub-record" on the hovered row adds a child and selects it', async ({ browser }) => {
    const page = await openAdmin(browser);
    await openGrid(page, ['Mở cửa hàng Đà Nẵng', 'Kiểm kê quý 3', 'Chuẩn bị khai trương']);
    const point = await rowPoint(page, 1);
    await page.mouse.move(point.x, point.y);
    await page.getByTestId('tree-add-child').click();
    await expect
      .poll(() => primaryTexts(page))
      .toEqual(['Mở cửa hàng Đà Nẵng', 'Kiểm kê quý 3', '', 'Chuẩn bị khai trương']);
    // Selected: typing names it.
    await expect(cell(page, 2)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.type('Tổng hợp tồn kho');
    await page.keyboard.press('Enter');
    await expect.poll(() => primaryTexts(page)).toContain('Tổng hợp tồn kho');
    const all = await ok<{ records: TreeRecord[] }>(
      page,
      'POST',
      `/tables/${ids.tableId}/records/query?field_key_type=id`,
      { search: 'Tổng hợp', limit: 5 },
    );
    byName.set('Tổng hợp tồn kho', all.records[0]?.id ?? '');
    expect(await parentOf(page, 'Tổng hợp tồn kho')).toBe('Kiểm kê quý 3');
    await page.context().close();
  });

  test('Ctrl/⌘+] indents under the row above, Ctrl/⌘+[ outdents; Tab still moves', async ({
    browser,
  }) => {
    const page = await openAdmin(browser);
    await openGrid(page, ['Mở cửa hàng Đà Nẵng', 'Kiểm kê quý 3', 'Chuẩn bị khai trương']);
    await selectRow(page, 2);
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
    await page.keyboard.press(`${mod}+BracketRight`);
    await expect.poll(() => parentOf(page, 'Chuẩn bị khai trương')).toBe('Kiểm kê quý 3');
    // T421b: the toast names the record on the first move too (its new branch was not loaded).
    await expect(
      page.getByText('“Chuẩn bị khai trương” moved under “Kiểm kê quý 3”.'),
    ).toBeVisible();
    // The new parent opens and the record stays selected.
    await expect
      .poll(() => primaryTexts(page))
      .toEqual([
        'Mở cửa hàng Đà Nẵng',
        'Kiểm kê quý 3',
        'Chuẩn bị khai trương',
        'Tổng hợp tồn kho',
      ]);
    await expect(page).toHaveURL(new RegExp(viewPath()));
    await expect(cell(page, 2)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press(`${mod}+BracketLeft`);
    await expect.poll(() => parentOf(page, 'Chuẩn bị khai trương')).toBeNull();
    // The fallback keys do the same.
    await expect
      .poll(() => primaryTexts(page))
      .toEqual([
        'Mở cửa hàng Đà Nẵng',
        'Kiểm kê quý 3',
        'Tổng hợp tồn kho',
        'Chuẩn bị khai trương',
      ]);
    await selectRow(page, 3);
    await page.keyboard.press('Alt+Shift+ArrowRight');
    await expect.poll(() => parentOf(page, 'Chuẩn bị khai trương')).toBe('Kiểm kê quý 3');
    // The moved record is selected again (in its new place) before the next key.
    await expect(cell(page, 2)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Alt+Shift+ArrowLeft');
    await expect.poll(() => parentOf(page, 'Chuẩn bị khai trương')).toBeNull();
    // ⌘+[ kept the page (no browser Back while the grid had the focus).
    await expect(page).toHaveURL(new RegExp(viewPath()));
    await page.context().close();
  });

  test('drag ⋮⋮ onto a row makes a sub-record; a second tab sees the move', async ({ browser }) => {
    const page = await openAdmin(browser);
    const other = await openAdmin(browser);
    await openGrid(page, ['Mở cửa hàng Đà Nẵng', 'Kiểm kê quý 3', 'Chuẩn bị khai trương']);
    await openGrid(other, ['Mở cửa hàng Đà Nẵng', 'Kiểm kê quý 3', 'Chuẩn bị khai trương']);
    await clickCaret(other, 0);
    await expect.poll(() => primaryTexts(other)).toContain('Thi công');

    await drag(page, 2, 0, 0.5);
    await expect(page.getByTestId('tree-drop-indicator')).toHaveAttribute(
      'data-placement',
      'child',
    );
    await shoot(page, 'tree-drag');
    await page.mouse.up();
    await expect.poll(() => parentOf(page, 'Chuẩn bị khai trương')).toBe('Mở cửa hàng Đà Nẵng');
    // The other tab: the record moved under the expanded root, within a second or so.
    await expect
      .poll(() => primaryTexts(other), { timeout: 5_000 })
      .toEqual([
        'Mở cửa hàng Đà Nẵng',
        'Khảo sát mặt bằng',
        'Thi công',
        'Tuyển nhân sự',
        'Chuẩn bị khai trương',
        'Kiểm kê quý 3',
      ]);
    // Between rows: a sibling of that row (back to the top level).
    await drag(page, 4, 5, 0.2);
    await expect(page.getByTestId('tree-drop-indicator')).toHaveAttribute(
      'data-placement',
      'before',
    );
    await page.mouse.up();
    await expect.poll(() => parentOf(page, 'Chuẩn bị khai trương')).toBeNull();
    await other.context().close();
    await page.context().close();
  });

  test('a record cannot go into its own branch (cycle)', async ({ browser }) => {
    const page = await openAdmin(browser);
    await openGrid(page, ['Mở cửa hàng Đà Nẵng', 'Kiểm kê quý 3', 'Chuẩn bị khai trương']);
    await clickCaret(page, 0);
    await expect.poll(() => primaryTexts(page)).toContain('Thi công');
    await drag(page, 0, 2, 0.5);
    const indicator = page.getByTestId('tree-drop-indicator');
    await expect(indicator).toHaveAttribute('data-refused', 'true');
    await expect(page.getByTestId('tree-drag-label')).toHaveText(
      'A record cannot go under itself or one of its sub-records.',
    );
    await shoot(page, 'tree-cycle');
    await page.mouse.up();
    await expect(
      page.getByText('A record cannot go under itself or one of its sub-records.'),
    ).toBeVisible();
    expect(await parentOf(page, 'Mở cửa hàng Đà Nẵng')).toBeNull();
    await page.context().close();
  });

  test('ten levels at most: no sub-record at level 10, indent refused', async ({ browser }) => {
    const page = await openAdmin(browser);
    let parent: string | null = null;
    for (let level = 1; level <= 9; level += 1) {
      const name = `Cấp ${String(level)}`;
      await create(page, name, parent);
      parent = name;
    }
    await create(page, 'Cấp 10 A', 'Cấp 9');
    await create(page, 'Cấp 10 B', 'Cấp 9');
    await page.setViewportSize({ width: 1440, height: 480 });
    await page.goto(viewPath());
    await page.getByTestId('tree-button').click();
    await page.getByTestId('tree-levels').selectOption('10');
    await page.keyboard.press('Escape');
    await page.getByRole('searchbox').fill('Cấp');
    // Nine levels and two leaves at level 10, every level open.
    await expect(page.locator('.ob-grid table').first()).toHaveAttribute('aria-rowcount', '12');
    await expect(cell(page, 0)).toHaveText('Cấp 1');
    // Down to "Cấp 10 B" (row 10) with the keyboard: the grid scrolls inside the branch.
    await selectRow(page, 0);
    for (let step = 0; step < 10; step += 1) await page.keyboard.press('ArrowDown');
    // Sticky parent path while scrolling inside the deep branch: "… › Cấp 9   Level 9 / 10".
    const sticky = page.getByTestId('tree-sticky-path');
    await expect(sticky).toBeVisible();
    await expect(sticky.getByTestId('tree-level')).toHaveText(/Level \d+ \/ 10/u);
    // Every row matches: nothing is dimmed, no legend.
    await expect(page.getByTestId('tree-ancestors-legend')).toHaveCount(0);
    await shoot(page, 'tree-depth');
    // Level 10: no sub-record under the row above (it is at level 10 already).
    await page.keyboard.press('Alt+Shift+ArrowRight');
    await expect(page.getByText('Reached the maximum depth of 10 levels.')).toBeVisible();
    expect(await parentOf(page, 'Cấp 10 B')).toBe('Cấp 9');
    await page.context().close();
  });

  test('a filter shows the matches with their ancestors dimmed', async ({ browser }) => {
    const page = await openAdmin(browser, { language: 'vi' });
    await page.goto(viewPath());
    await page.getByRole('searchbox').fill('Lắp đèn');
    await expect
      .poll(() => primaryTexts(page))
      .toEqual(['Mở cửa hàng Đà Nẵng', 'Thi công', 'Điện và chiếu sáng', 'Lắp đèn biển hiệu']);
    await expect(page.getByTestId('tree-sticky-path')).toHaveCount(0);
    await expect(page.getByTestId('tree-ancestors-legend')).toHaveText(
      'Dòng mờ là cấp trên không khớp bộ lọc, hiện để giữ ngữ cảnh.',
    );
    await shoot(page, 'tree-filter-vi');
    await expectNoSeriousA11yViolations(page, 'tree grid filtered');
    await page.context().close();
  });

  test('deleting a parent: children promoted, or the whole branch, restored together', async ({
    browser,
  }) => {
    const page = await openAdmin(browser);
    await create(page, 'Nhánh xoá', null);
    await create(page, 'Con 1', 'Nhánh xoá');
    await create(page, 'Con 2', 'Nhánh xoá');
    await create(page, 'Cha tạm', null);
    await create(page, 'Con giữ lại', 'Cha tạm');
    await page.goto(viewPath());
    await expect.poll(() => primaryTexts(page)).toContain('Cha tạm');

    // Promote (default): the child becomes a root.
    let row = (await primaryTexts(page)).indexOf('Cha tạm');
    let point = await rowPoint(page, row);
    await page.mouse.click(point.x, point.y, { button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete record' }).click();
    await expect(page.getByTestId('tree-delete-choice')).toBeVisible();
    await shoot(page, 'tree-delete-dialog');
    await page.getByRole('button', { name: 'Delete record' }).click();
    await expect.poll(() => primaryTexts(page)).toContain('Con giữ lại');
    expect(await parentOf(page, 'Con giữ lại')).toBeNull();

    // The whole branch.
    row = (await primaryTexts(page)).indexOf('Nhánh xoá');
    point = await rowPoint(page, row);
    await page.mouse.click(point.x, point.y, { button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete record' }).click();
    await page.getByRole('radio', { name: /Delete the whole branch/u }).check();
    await page.getByRole('button', { name: 'Delete branch' }).click();
    await expect.poll(() => primaryTexts(page)).not.toContain('Nhánh xoá');

    await page.goto(`/b/${ids.baseId}/t/${ids.tableId}/trash`);
    const trashRow = page.getByRole('row', { name: /Nhánh xoá/u });
    await expect(trashRow).toContainText('+2 sub-records');
    await trashRow.getByTestId('restore-branch').click();
    await expect(page.getByText('3 records restored.')).toBeVisible();
    await page.goto(viewPath());
    await expect.poll(() => primaryTexts(page)).toContain('Nhánh xoá');
    const branchRow = (await primaryTexts(page)).indexOf('Nhánh xoá');
    await clickCaret(page, branchRow);
    await expect.poll(() => primaryTexts(page)).toContain('Con 2');
    await page.context().close();
  });

  test('record panel: parent path, sub-records, and the card list below 768 px', async ({
    browser,
  }) => {
    const page = await openAdmin(browser, { language: 'vi', width: 390 });
    await page.goto(`${viewPath()}?record=${byName.get('Lắp đèn biển hiệu') ?? ''}`);
    const panel = page.getByRole('dialog', { name: 'Lắp đèn biển hiệu' });
    const path = panel.getByRole('navigation', { name: 'Bản ghi cha' });
    await expect(path.getByRole('button')).toHaveText([
      'Mở cửa hàng Đà Nẵng',
      'Thi công',
      'Điện và chiếu sáng',
    ]);
    await expect(panel.getByRole('button', { name: 'Thêm sub-record' })).toBeVisible();
    await shoot(page, 'tree-panel-mobile-vi');
    await path.getByRole('button', { name: 'Thi công' }).click();
    await expect(page.getByRole('dialog', { name: 'Thi công' })).toBeVisible();
    await expect(
      page.getByRole('dialog', { name: 'Thi công' }).getByRole('list', { name: /Sub-records/u }),
    ).toContainText('Điện và chiếu sáng');
    await expectNoSeriousA11yViolations(page, 'record panel with sub-records');
    // The card list (< 768 px): a card of a sub-record shows its parent path.
    await page.goto(viewPath());
    await page.getByRole('searchbox').fill('Lắp đèn');
    await expect(page.getByTestId('card-parent-path').last()).toHaveText(
      'Mở cửa hàng Đà Nẵng › Thi công › Điện và chiếu sáng',
    );
    await shoot(page, 'tree-cards-mobile-vi');
    await page.context().close();
  });
});

test.describe.serial('T417 u_sales1: ancestors out of reach', () => {
  test('a parent u_sales1 cannot read is a locked placeholder; the record shows as a root', async ({
    browser,
  }) => {
    test.setTimeout(300_000);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const admin = await context.newPage();
    await admin.goto('/login');
    await apiSignIn(admin, WORKER_ORG.email('admin'), DEMO_PASSWORD);
    // The demo Orders table: sales1 owns r1, sales2 owns r2 (CONTRACTS §5, §9).
    await admin.goto('/');
    await admin.getByRole('link', { name: 'Chăm sóc khách hàng' }).first().click();
    await admin.getByRole('link', { name: 'Orders', exact: true }).first().click();
    await expect(admin.getByRole('heading', { level: 1, name: 'Orders' })).toBeVisible();
    const match = /\/b\/(bse_[^/]+)\/t\/(tbl_[^/?]+)/u.exec(admin.url());
    const [baseId, tableId] = [match?.[1] ?? '', match?.[2] ?? ''];
    const fields = await ok<{ items: { id: string; name: string; type: string }[] }>(
      admin,
      'GET',
      `/tables/${tableId}/fields`,
    );
    const owner = fields.items.find((field) => field.name === 'owner')?.id ?? '';
    const users = await ok<{ items: { id: string; email: string }[] }>(
      admin,
      'GET',
      `/bases/${baseId}/members`,
    );
    const userId = (email: string) => users.items.find((user) => user.email === email)?.id;
    const recordOf = async (email: string) =>
      (
        await ok<{ records: { id: string }[] }>(
          admin,
          'POST',
          `/tables/${tableId}/records/query?field_key_type=id`,
          {
            filter: {
              op: 'and',
              items: [{ field: owner, operator: 'has_any_of', value: [userId(email)] }],
            },
            limit: 1,
          },
        )
      ).records[0]?.id ?? '';
    const mine = await recordOf(WORKER_ORG.email('sales1'));
    const theirs = await recordOf(WORKER_ORG.email('sales2'));
    const parentField = await ok<{ id: string }>(admin, 'POST', `/tables/${tableId}/fields`, {
      name: 'Đơn cha',
      type: 'parent',
    });
    try {
      await ok(admin, 'PATCH', `/tables/${tableId}/records/${mine}`, {
        fields: {},
        parent_id: theirs,
      });
      const sales = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await sales.newPage();
      await page.addInitScript(() => {
        window.localStorage.setItem('cellhive.language', 'en');
      });
      await page.goto('/login');
      await apiSignIn(page, WORKER_ORG.email('sales1'), DEMO_PASSWORD);
      const ancestors = await ok<{ items: { id: string | null; locked: boolean }[] }>(
        page,
        'GET',
        `/tables/${tableId}/records/${mine}/ancestors`,
      );
      expect(ancestors.items).toEqual([{ id: null, title: null, locked: true }]);
      await page.goto(`/b/${baseId}/t/${tableId}?record=${mine}`);
      const path = page.getByRole('navigation', { name: 'Parent records' });
      await expect(path.getByText('A record you cannot see')).toBeAttached();
      await expect(path.getByRole('button')).toHaveCount(0);
      await shoot(page, 'tree-locked-ancestor');
      // As a tree the record is a root for u_sales1 (its parent is out of reach).
      await page.getByTestId('record-panel').getByRole('button', { name: 'Close' }).click();
      await page.getByTestId('tree-button').click({ timeout: 10_000 });
      await page.getByTestId('tree-toggle').click({ timeout: 10_000 });
      await expect(page.getByTestId('tree-toggle')).toBeChecked();
      await page.keyboard.press('Escape');
      await expect
        .poll(async () => {
          const node = page.locator('.ob-grid table[role="treegrid"] tbody tr').first();
          return node.getAttribute('aria-level');
        })
        .toBe('1');
      await sales.close();
    } finally {
      // Other specs use the demo Orders table as it was.
      await ok(admin, 'DELETE', `/fields/${parentField.id}`);
      await context.close();
    }
  });
});
