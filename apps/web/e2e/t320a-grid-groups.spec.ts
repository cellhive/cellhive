import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { type Browser, type BrowserContext, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import {
  apiSignIn,
  collectCspViolations,
  expectNoSeriousA11yViolations,
  ok,
  signInFirstAdmin,
} from './support';

/**
 * T320a: the grouped grid redesigned after Lark Base — every group is a
 * card (spacer rows between them, a "+" row at its end), a header as high
 * as a row with the value chip at its natural width and "N records", row
 * numbers restarting in every group, the group menu (right click, Shift+F10)
 * instead of a second toolbar line, the sticky group path and
 * "N records · M groups" in the footer. Self-contained (own base).
 *
 * `T320A_SHOTS=<dir>` (and `T320A_PREFIX`) also write the report's screenshots there.
 */
const ADMIN = {
  name: 'Nguyễn Văn Ánh',
  email: WORKER_ORG.ownerEmail,
  password: 'E2E-Setup-Password-2026',
};
const SHOTS = process.env['T320A_SHOTS'];
const PREFIX = process.env['T320A_PREFIX'] ?? '';

/** Name, status, priority, owner (three group levels). */
const ROWS: [string, string, string, string][] = [
  ['Khảo sát khách hàng miền Bắc', 'Đang thực hiện', 'Cao', 'Phạm Thị Hương'],
  ['Chuẩn bị hợp đồng khung', 'Đang thực hiện', 'Cao', 'Phạm Thị Hương'],
  ['Rà soát công nợ quý 3', 'Đang thực hiện', 'Cao', 'Nguyễn Văn Nam'],
  ['Cập nhật bảng giá', 'Đang thực hiện', 'Trung bình', 'Trần Minh Anh'],
  ['Đào tạo nhân viên mới', 'Chờ duyệt', 'Cao', 'Nguyễn Văn Nam'],
  ['Kế hoạch marketing Tết', 'Chờ duyệt', 'Thấp', 'Phạm Thị Hương'],
  ['Báo cáo doanh thu tháng 9', 'Đã xong', 'Trung bình', 'Trần Minh Anh'],
  ['Kiểm kê kho Hải Phòng', 'Đã xong', 'Trung bình', 'Trần Minh Anh'],
];

/** Grid geometry (compact rows): column header, rows, spacers, gutter (3 levels). */
const HEADER_HEIGHT = 36;
const ROW_HEIGHT = 34;
const GAP = 16;
const NESTED_GAP = 8;
const GUTTER = 6 + 2 * 16 + 40;

const header = (field: string, value: string, count: number, collapsed = false) =>
  `${field} ${value}: ${String(count)} record${count === 1 ? '' : 's'}, ${collapsed ? 'collapsed' : 'expanded'}`;
const add = (group: string) => `Add a record to ${group}`;

/**
 * Display rows of the view, all expanded (primary column text in glide's
 * accessibility table; spacers are empty): `_0` / `_1` mark the spacers.
 */
const LAYOUT: string[] = [
  '_0',
  header('Trạng thái', 'Đang thực hiện', 4),
  header('Ưu tiên', 'Cao', 3),
  header('Phụ trách', 'Phạm Thị Hương', 2),
  'Khảo sát khách hàng miền Bắc',
  'Chuẩn bị hợp đồng khung',
  add('Phạm Thị Hương'),
  '_1',
  header('Phụ trách', 'Nguyễn Văn Nam', 1),
  'Rà soát công nợ quý 3',
  add('Nguyễn Văn Nam'),
  '_1',
  '_1',
  header('Ưu tiên', 'Trung bình', 1),
  header('Phụ trách', 'Trần Minh Anh', 1),
  'Cập nhật bảng giá',
  add('Trần Minh Anh'),
  '_1',
  '_1',
  '_0',
  header('Trạng thái', 'Chờ duyệt', 2),
];
const expectedTexts = LAYOUT.map((text) => (text.startsWith('_') ? '' : text));

/** Top of a display row in the canvas (rows above it summed). */
function rowTop(display: number, layout: readonly string[] = LAYOUT): number {
  let top = HEADER_HEIGHT;
  for (let row = 0; row < display; row += 1) {
    const kind = layout[row] ?? '';
    top += kind === '_0' ? GAP : kind.startsWith('_') ? NESTED_GAP : ROW_HEIGHT;
  }
  return top;
}

type Session = Awaited<ReturnType<BrowserContext['storageState']>>;
let session: Session | undefined;

async function openAdmin(
  browser: Browser,
  options: { language?: 'en' | 'vi'; height?: number } = {},
): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: 1440, height: options.height ?? 900 },
    ...(session === undefined ? {} : { storageState: session }),
  });
  await context.addInitScript((language) => {
    window.localStorage.setItem('cellhive.language', language);
  }, options.language ?? 'en');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await context.newPage();
  await page.goto('/login');
  if (session === undefined) {
    await apiSignIn(page, ADMIN.email, ADMIN.password);
    session = await context.storageState();
  }
  return page;
}

/** Accessible text of a cell of a display row (glide's a11y table; column 0 = row gutter). */
function cell(page: Page, row: number, column = 1) {
  return page.getByTestId(`glide-cell-${String(column)}-${String(row)}`);
}

async function columnTexts(page: Page, count: number, index = 1): Promise<string[]> {
  const texts: string[] = [];
  for (let row = 0; row < count; row += 1) {
    texts.push(((await cell(page, row, index).textContent()) ?? '').trim());
  }
  return texts;
}

async function canvasBox(page: Page) {
  const box = await page.locator('.ob-grid [data-testid="data-grid-canvas"]').boundingBox();
  if (box === null) throw new Error('grid not laid out');
  return box;
}

/** Clicks display row `row` at `x` px from the canvas' left edge. */
async function clickRow(
  page: Page,
  row: number,
  x = GUTTER + 60,
  options: { button?: 'left' | 'right'; layout?: readonly string[] } = {},
) {
  const box = await canvasBox(page);
  await page.mouse.click(box.x + x, box.y + rowTop(row, options.layout) + ROW_HEIGHT / 2, {
    button: options.button ?? 'left',
  });
}

async function shoot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
  if (SHOTS !== undefined) {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, `${PREFIX}${name}.png`) });
  }
}

function footer(page: Page) {
  return page.getByRole('status').filter({ hasText: /records? · \d+ groups?$/u });
}

test.describe('T320a grouped grid (Lark style)', () => {
  test.describe.configure({ mode: 'serial' });

  const ids = {
    baseId: '',
    tableId: '',
    viewId: '',
    primaryId: '',
    statusId: '',
    priorityId: '',
    ownerId: '',
  };
  const viewPath = () => `/b/${ids.baseId}/t/${ids.tableId}/v/${ids.viewId}`;
  /** The view's config: compact rows, grouped by status → priority → owner. */
  const viewConfig = () => ({
    row_height: 'short',
    group: [
      { field: ids.statusId, direction: 'asc' },
      { field: ids.priorityId, direction: 'asc' },
      { field: ids.ownerId, direction: 'asc' },
    ],
  });
  const recordsByName = async (page: Page) => {
    const answer = await ok<{ records: { id: string; fields: Record<string, unknown> }[] }>(
      page,
      'POST',
      `/tables/${ids.tableId}/records/query?field_key_type=id`,
      { offset: 0, limit: 100 },
    );
    return new Map(answer.records.map((record) => [String(record.fields[ids.primaryId]), record]));
  };
  const openGrid = async (page: Page) => {
    await page.goto(viewPath());
    await expect.poll(() => columnTexts(page, LAYOUT.length)).toEqual(expectedTexts);
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
      name: 'Nhóm T320a',
    });
    const base = await ok<{ id: string }>(admin, 'POST', `/workspaces/${workspace.id}/bases`, {
      name: 'Dự án T320a',
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
    const select = async (name: string, options: string[]) =>
      (
        await ok<{ id: string }>(admin, 'POST', `/tables/${table.id}/fields`, {
          name,
          type: 'select',
          options: { options: options.map((option) => ({ name: option })) },
        })
      ).id;
    ids.statusId = await select('Trạng thái', ['Đang thực hiện', 'Chờ duyệt', 'Đã xong']);
    ids.priorityId = await select('Ưu tiên', ['Cao', 'Trung bình', 'Thấp']);
    ids.ownerId = await select('Phụ trách', ['Phạm Thị Hương', 'Nguyễn Văn Nam', 'Trần Minh Anh']);
    await ok(admin, 'POST', `/tables/${table.id}/fields`, { name: 'Ghi chú', type: 'text' });
    await ok(admin, 'POST', `/tables/${table.id}/records?field_key_type=name`, {
      records: ROWS.map(([name, status, priority, owner]) => ({
        fields: { Name: name, 'Trạng thái': status, 'Ưu tiên': priority, 'Phụ trách': owner },
      })),
    });
    const views = await ok<{ items: { id: string }[] }>(admin, 'GET', `/tables/${table.id}/views`);
    ids.viewId = views.items[0]?.id ?? '';
    await ok(admin, 'PATCH', `/views/${ids.viewId}`, { config: viewConfig() });
    await admin.context().close();
  });

  test('three levels as cards: full header labels and counts, "+" rows, spacers', async ({
    browser,
  }) => {
    const page = await openAdmin(browser);
    const csp = collectCspViolations(page);
    await openGrid(page);
    await expect(footer(page)).toHaveText('8 records · 3 groups');
    // One toolbar line: collapse / expand all live in the header menu and the group panel.
    await expect(page.getByRole('button', { name: 'Collapse all groups' })).toHaveCount(0);
    const toolbar = page.getByRole('toolbar');
    const box = await toolbar.boundingBox();
    expect(box?.height ?? 0).toBeLessThan(56);
    await shoot(page, 'grouped-en');
    await expectNoSeriousA11yViolations(page, 'grouped grid');
    expect(csp).toEqual([]);
    await page.context().close();

    const vi = await openAdmin(browser, { language: 'vi' });
    await vi.goto(viewPath());
    await expect(vi.getByRole('status').filter({ hasText: /bản ghi · \d+ nhóm$/u })).toHaveText(
      '8 bản ghi · 3 nhóm',
    );
    await expect(cell(vi, 1)).toHaveText('Trạng thái Đang thực hiện: 4 bản ghi, đang mở');
    await shoot(vi, 'grouped-vi');
    await vi.context().close();
  });

  test('row numbers restart at 1 in every group', async ({ browser }) => {
    const page = await openAdmin(browser);
    await openGrid(page);
    await page.mouse.move(0, 0);
    // The row gutter is not in glide's accessibility table: compare the pixels of the
    // number area of rows (innermost cards: x 38–78). Glide's own numbers would be 5, 6, 10, 16.
    const numbers = await page.evaluate(
      ({ rows, left, width }) => {
        const canvas = document.querySelector<HTMLCanvasElement>(
          '.ob-grid [data-testid="data-grid-canvas"]',
        );
        const context = canvas?.getContext('2d');
        if (canvas === null || context === null || context === undefined) return [];
        const scale = canvas.width / canvas.clientWidth;
        return rows.map(([top, height]) => {
          const data = context.getImageData(
            Math.round((left + 2) * scale),
            Math.round((top + 4) * scale),
            Math.round((width - 4) * scale),
            Math.round((height - 8) * scale),
          ).data;
          let hash = 0;
          for (let index = 0; index < data.length; index += 4) {
            hash = (hash * 31 + (data[index] ?? 0) + (data[index + 1] ?? 0) * 3) >>> 0;
          }
          return hash;
        });
      },
      {
        rows: [4, 5, 9, 15].map((row) => [rowTop(row), ROW_HEIGHT] as const),
        left: GUTTER - 40,
        width: 40,
      },
    );
    const [first, second, nextGroup, lastGroup] = numbers;
    expect(numbers).toHaveLength(4);
    // "1" in every group; the second row of the first group ("2") differs.
    expect(nextGroup).toBe(first);
    expect(lastGroup).toBe(first);
    expect(second).not.toBe(first);
    await page.context().close();
  });

  test('a paste across a "+" row, a spacer and a header writes the data rows only', async ({
    browser,
  }) => {
    const page = await openAdmin(browser);
    await openGrid(page);
    const before = await recordsByName(page);
    // "Chuẩn bị hợp đồng khung" (display 5) is the last row of its group; "Rà soát" (9) is next.
    await clickRow(page, 5);
    await expect(cell(page, 5)).toHaveAttribute('aria-selected', 'true');
    await page.evaluate(() => navigator.clipboard.writeText('Chuẩn bị 2\r\nRà soát 2\r\n'));
    const written = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' &&
        response.url().includes(`/tables/${ids.tableId}/records`),
    );
    await page.keyboard.press('ControlOrMeta+v');
    const body = (await written).request().postDataJSON() as {
      records: { id: string; fields: object }[];
    };
    expect(body.records.map((record) => [record.id, record.fields])).toEqual([
      [before.get('Chuẩn bị hợp đồng khung')?.id, { [ids.primaryId]: 'Chuẩn bị 2' }],
      [before.get('Rà soát công nợ quý 3')?.id, { [ids.primaryId]: 'Rà soát 2' }],
    ]);
    await expect(cell(page, 5)).toHaveText('Chuẩn bị 2');
    await expect(cell(page, 6)).toHaveText(add('Phạm Thị Hương'));
    await expect(cell(page, 9)).toHaveText('Rà soát 2');
    const after = await recordsByName(page);
    await ok(page, 'PATCH', `/tables/${ids.tableId}/records?field_key_type=id`, {
      records: [
        { id: after.get('Chuẩn bị 2')?.id, fields: { [ids.primaryId]: 'Chuẩn bị hợp đồng khung' } },
        { id: after.get('Rà soát 2')?.id, fields: { [ids.primaryId]: 'Rà soát công nợ quý 3' } },
      ],
    });
    await page.context().close();
  });

  test('the "+" row adds a pre-filled record, selects it and typing names it', async ({
    browser,
  }) => {
    const page = await openAdmin(browser);
    await openGrid(page);
    const created = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === `/api/v1/tables/${ids.tableId}/records`,
    );
    // The "+" row of Đang thực hiện / Cao / Nguyễn Văn Nam (display 10).
    await clickRow(page, 10, 30);
    const response = await created;
    expect(response.request().postDataJSON()).toEqual({
      records: [
        {
          fields: {
            [ids.statusId]: 'Đang thực hiện',
            [ids.priorityId]: 'Cao',
            [ids.ownerId]: 'Nguyễn Văn Nam',
          },
        },
      ],
    });
    const record = ((await response.json()) as { records: { id: string }[] }).records[0];
    // The new record is the group's second row (display 10), selected — not the next header.
    await expect(cell(page, 8)).toHaveText(header('Phụ trách', 'Nguyễn Văn Nam', 2));
    await expect(cell(page, 10)).toHaveAttribute('aria-selected', 'true');
    await expect(cell(page, 11)).toHaveText(add('Nguyễn Văn Nam'));
    // Typing right away names the new record (its primary cell).
    const named = page.waitForResponse(
      (answer) =>
        answer.request().method() === 'PATCH' &&
        answer.url().includes(`/tables/${ids.tableId}/records`),
    );
    // At once, Enter included: keys typed before the editor is there are kept (S3 QA).
    await page.keyboard.type('Việc mới');
    await page.keyboard.press('Enter');
    await named;
    await expect(cell(page, 10)).toHaveText('Việc mới');
    await expect.poll(async () => (await recordsByName(page)).get('Việc mới')?.id).toBe(record?.id);
    await ok(page, 'DELETE', `/tables/${ids.tableId}/records`, { ids: [record?.id] });
    await expect(cell(page, 8)).toHaveText(header('Phụ trách', 'Nguyễn Văn Nam', 1));
    await page.context().close();
  });

  test('collapse from the header menu (right click, Shift+F10) and expand all', async ({
    browser,
  }) => {
    const page = await openAdmin(browser);
    await openGrid(page);
    // Right click on Đang thực hiện / Cao's header (display 2).
    await clickRow(page, 2, GUTTER + 120, { button: 'right' });
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Collapse subgroups' })).toBeVisible();
    await expectNoSeriousA11yViolations(page, 'group menu');
    await shoot(page, 'group-menu');
    await menu.getByRole('menuitem', { name: 'Collapse this group' }).click();
    await expect(cell(page, 2)).toHaveText(header('Ưu tiên', 'Cao', 3, true));
    // Its cards are gone: the next level-1 card follows its spacer.
    await expect(cell(page, 4)).toHaveText(header('Ưu tiên', 'Trung bình', 1));
    // Keyboard: from a data row up onto a header row, Shift+F10 opens its menu.
    const collapsed = ['_0', 'H0', 'H1', '_1', 'H1', 'H2', 'r'];
    await clickRow(page, 6, GUTTER + 60, { layout: collapsed });
    await expect(cell(page, 6)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowUp');
    await expect(cell(page, 5)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Shift+F10');
    await expect(page.getByRole('menu')).toBeVisible();
    await page.getByRole('menuitem', { name: 'Expand all groups' }).click();
    await expect.poll(() => columnTexts(page, LAYOUT.length)).toEqual(expectedTexts);
    // Enter on a header row toggles it.
    await page.keyboard.press('Enter');
    await expect(cell(page, 14)).toHaveText(header('Phụ trách', 'Trần Minh Anh', 1, true));
    await page.keyboard.press('Enter');
    await expect(cell(page, 14)).toHaveText(header('Phụ trách', 'Trần Minh Anh', 1));
    await page.context().close();
  });

  test('the sticky group path stays under the column header while scrolling', async ({
    browser,
  }) => {
    const page = await openAdmin(browser, { height: 520 });
    await page.goto(viewPath());
    await expect(cell(page, 1)).toHaveText(header('Trạng thái', 'Đang thực hiện', 4));
    await expect(page.getByTestId('group-sticky-path')).toHaveCount(0);
    // Scroll into Đang thực hiện / Trung bình (past its outer headers).
    await page.evaluate(
      (top) => {
        const scroller = document.querySelector<HTMLElement>('.ob-grid .dvn-scroller');
        if (scroller !== null) scroller.scrollTop = top;
      },
      rowTop(15) - HEADER_HEIGHT - 10,
    );
    const sticky = page.getByTestId('group-sticky-path');
    await expect(sticky.getByRole('button')).toHaveText([
      /Đang thực hiện\s*4 records/u,
      /Trung bình\s*1 record/u,
    ]);
    await shoot(page, 'sticky-path');
    // A click collapses that group.
    await sticky.getByRole('button', { name: header('Trạng thái', 'Đang thực hiện', 4) }).click();
    await expect(footer(page)).toHaveText('8 records · 3 groups');
    await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('.ob-grid .dvn-scroller');
      if (scroller !== null) scroller.scrollTop = 0;
    });
    await expect(cell(page, 1)).toHaveText(header('Trạng thái', 'Đang thực hiện', 4, true));
    await page.getByTestId('group-button').click();
    const panel = page.getByRole('dialog', { name: 'Group' });
    await expect(panel.getByRole('radio', { name: 'First → Last' })).toHaveCount(3);
    await shoot(page, 'group-panel');
    await panel.getByRole('button', { name: 'Expand all' }).click();
    await expect(cell(page, 1)).toHaveText(header('Trạng thái', 'Đang thực hiện', 4));
    await page.context().close();
  });

  test('a narrow frozen column: the header goes on past the frozen divider', async ({
    browser,
  }) => {
    const page = await openAdmin(browser, { language: 'vi' });
    await page.goto('/login');
    const narrow = 120;
    await ok(page, 'PATCH', `/views/${ids.viewId}`, {
      config: { ...viewConfig(), column_widths: { [ids.primaryId]: narrow } },
    });
    try {
      await page.goto(viewPath());
      await expect(cell(page, 3)).toHaveText('Phụ trách Phạm Thị Hương: 2 bản ghi, đang mở');
      await page.mouse.move(0, 0);
      // The chip of "Phạm Thị Hương" (~110 px) and its count do not fit 120 px: pixels
      // right of the frozen divider in that header row are drawn (not an empty white row).
      const colors = await page.evaluate(
        ({ left, top, height }) => {
          const canvas = document.querySelector<HTMLCanvasElement>(
            '.ob-grid [data-testid="data-grid-canvas"]',
          );
          const context = canvas?.getContext('2d');
          if (canvas === null || context === null || context === undefined) return 0;
          const scale = canvas.width / canvas.clientWidth;
          const data = context.getImageData(
            Math.round(left * scale),
            Math.round((top + 6) * scale),
            Math.round(80 * scale),
            Math.round((height - 12) * scale),
          ).data;
          const seen = new Set<string>();
          for (let index = 0; index < data.length; index += 4) {
            seen.add(
              `${String(data[index])},${String(data[index + 1])},${String(data[index + 2])}`,
            );
          }
          return seen.size;
        },
        { left: GUTTER + narrow + 2, top: rowTop(3), height: ROW_HEIGHT },
      );
      expect(colors).toBeGreaterThan(3);
      await shoot(page, 'narrow-frozen-vi');
    } finally {
      await ok(page, 'PATCH', `/views/${ids.viewId}`, { config: viewConfig() });
      await page.context().close();
    }
  });
});
