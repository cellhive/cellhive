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
 * T312: group in the grid — group levels from the toolbar, virtual headers
 * with counts from `records/group-counts`, collapse kept per user on this
 * device, a paste across a header, "+" in a header, realtime moves between
 * groups. Self-contained: the first administrator and a base of its own.
 */
const ADMIN = {
  name: 'Nguyễn Văn Ánh',
  email: WORKER_ORG.ownerEmail,
  password: 'E2E-Setup-Password-2026',
};
const TABLE_NAME = 'Phiếu hỗ trợ';
/** Name, status, region. */
const ROWS: [string, string, string][] = [
  ['An Phát', 'Mới', 'Bắc'],
  ['Bình Minh', 'Mới', 'Nam'],
  ['Cao Nguyên', 'Mới', 'Bắc'],
  ['Đông Á', 'Xong', 'Bắc'],
  ['Hải Vân', 'Đang xử lý', 'Nam'],
];

/**
 * Grid geometry (compact rows): header row, row height, row gutter (two
 * group levels, T320a), primary column width, spacers between group cards.
 */
const HEADER_HEIGHT = 36;
const ROW_HEIGHT = 34;
const MARKER_WIDTH = 6 + 16 + 40;
const PRIMARY_WIDTH = 260;
const GAP = 16;
const NESTED_GAP = 8;

type Session = Awaited<ReturnType<BrowserContext['storageState']>>;
let session: Session | undefined;

/** A page of its own context signed in as the administrator (one sign-in for the file). */
async function openAdmin(browser: Browser): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    ...(session === undefined ? {} : { storageState: session }),
  });
  await context.addInitScript(() => {
    window.localStorage.setItem('cellhive.language', 'en');
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await context.newPage();
  await page.goto('/login');
  if (session === undefined) {
    await apiSignIn(page, ADMIN.email, ADMIN.password);
    session = await context.storageState();
  }
  return page;
}

/** Text of the primary column cell of a display row (glide's accessibility table). */
function cell(page: Page, row: number) {
  return page.getByTestId(`glide-cell-1-${String(row)}`);
}

/** Texts of the primary column for display rows 0…count-1. */
async function primaryColumn(page: Page, count: number): Promise<string[]> {
  const texts: string[] = [];
  for (let row = 0; row < count; row += 1) texts.push((await cell(page, row).textContent()) ?? '');
  return texts;
}

async function canvasBox(page: Page) {
  const canvas = page.locator('.ob-grid [data-testid="data-grid-canvas"]');
  const box = await canvas.boundingBox();
  if (box === null) throw new Error('grid not laid out');
  return box;
}

/** Top of display row `row`: spacer rows (`''` in `layout`, see `GROUPED`) are shorter. */
function rowTop(row: number, layout: readonly string[]): number {
  let top = HEADER_HEIGHT;
  for (let index = 0; index < row; index += 1) {
    const text = layout[index];
    top += text === SPACER ? GAP : text === NESTED_SPACER ? NESTED_GAP : ROW_HEIGHT;
  }
  return top;
}

/** Clicks display row `row` in the primary column at `x` px from its left edge. */
async function clickRow(page: Page, row: number, layout: readonly string[], x = 60) {
  const box = await canvasBox(page);
  await page.mouse.click(box.x + MARKER_WIDTH + x, box.y + rowTop(row, layout) + ROW_HEIGHT / 2);
}

function footer(page: Page) {
  return page.getByRole('status').filter({ hasText: /records?( · \d+ groups?)?$/u });
}

const header = (field: string, value: string, count: number, collapsed = false) =>
  `${field} ${value}: ${String(count)} record${count === 1 ? '' : 's'}, ${collapsed ? 'collapsed' : 'expanded'}`;
/** The "+" row closing a group (T320a). */
const add = (value: string) => `Add a record to ${value}`;
/** Spacers between group cards (T320a): empty in the accessibility table. */
const SPACER = '';
const NESTED_SPACER = ' ';
const texts = (layout: readonly string[]) => layout.map((text) => text.trim());

test.describe('T312 grid group', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ viewport: { width: 1600, height: 900 } });

  const ids = {
    baseId: '',
    tableId: '',
    groupedViewId: '',
    plainViewId: '',
    statusId: '',
    regionId: '',
    primaryId: '',
  };
  const viewPath = (viewId: string) => `/b/${ids.baseId}/t/${ids.tableId}/v/${viewId}`;
  const recordsByName = async (page: Page) => {
    const answer = await ok<{ records: { id: string; fields: Record<string, unknown> }[] }>(
      page,
      'POST',
      `/tables/${ids.tableId}/records/query?field_key_type=id`,
      { offset: 0, limit: 100 },
    );
    return new Map(answer.records.map((record) => [String(record.fields[ids.primaryId]), record]));
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
      name: 'Group E2E',
    });
    const base = await ok<{ id: string }>(admin, 'POST', `/workspaces/${workspace.id}/bases`, {
      name: 'Hỗ trợ T312',
    });
    ids.baseId = base.id;
    const table = await ok<{ id: string; primary_field_id: string }>(
      admin,
      'POST',
      `/bases/${base.id}/tables`,
      { name: TABLE_NAME },
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
    ids.statusId = await select('Trạng thái', ['Mới', 'Đang xử lý', 'Xong']);
    ids.regionId = await select('Khu vực', ['Bắc', 'Nam']);
    await ok(admin, 'POST', `/tables/${table.id}/records?field_key_type=name`, {
      records: ROWS.map(([name, status, region]) => ({
        fields: { Name: name, 'Trạng thái': status, 'Khu vực': region },
      })),
    });
    const views = await ok<{ items: { id: string }[] }>(admin, 'GET', `/tables/${table.id}/views`);
    ids.groupedViewId = views.items[0]?.id ?? '';
    await ok(admin, 'PATCH', `/views/${ids.groupedViewId}`, {
      config: {
        group: [
          { field: ids.statusId, direction: 'asc' },
          { field: ids.regionId, direction: 'asc' },
        ],
        column_widths: { [ids.primaryId]: PRIMARY_WIDTH },
      },
    });
    ids.plainViewId = (
      await ok<{ id: string }>(admin, 'POST', `/tables/${table.id}/views`, {
        name: 'Không nhóm',
        type: 'grid',
        config: {},
      })
    ).id;
    await admin.context().close();
  });

  /**
   * Display rows of the grouped view (Trạng thái → Khu vực), all expanded:
   * every group a card (T320a) — spacers, headers, rows, "+" rows.
   */
  const GROUPED = [
    SPACER,
    header('Trạng thái', 'Mới', 3),
    header('Khu vực', 'Bắc', 2),
    'An Phát',
    'Cao Nguyên',
    add('Bắc'),
    NESTED_SPACER,
    header('Khu vực', 'Nam', 1),
    'Bình Minh',
    add('Nam'),
    NESTED_SPACER,
    SPACER,
    header('Trạng thái', 'Đang xử lý', 1),
    header('Khu vực', 'Nam', 1),
    'Hải Vân',
    add('Nam'),
    NESTED_SPACER,
    SPACER,
    header('Trạng thái', 'Xong', 1),
    header('Khu vực', 'Bắc', 1),
    'Đông Á',
    add('Bắc'),
    NESTED_SPACER,
    SPACER,
  ];

  test('group by status then region from the toolbar: headers in order with counts', async ({
    browser,
  }) => {
    const page = await openAdmin(browser);
    const csp = collectCspViolations(page);
    await page.goto(viewPath(ids.plainViewId));
    await expect(footer(page)).toHaveText('5 records');
    await page.getByTestId('group-button').click();
    const panel = page.getByRole('dialog', { name: 'Group' });
    await panel.getByRole('combobox', { name: 'Add a group field' }).selectOption({
      label: 'Trạng thái',
    });
    await panel.getByRole('combobox', { name: 'Add a group field' }).selectOption({
      label: 'Khu vực',
    });
    await expectNoSeriousA11yViolations(page, 'group panel');
    await page.keyboard.press('Escape');
    await expect(cell(page, 1)).toHaveText(GROUPED[1] ?? '');
    await expect.poll(() => primaryColumn(page, GROUPED.length)).toEqual(texts(GROUPED));
    // Counts are those of the API for the same query.
    const counts = await ok<{ groups: { values: string[]; count: number }[] }>(
      page,
      'POST',
      `/tables/${ids.tableId}/records/group-counts?field_key_type=id`,
      {
        view_id: ids.plainViewId,
        group: [
          { field: ids.statusId, direction: 'asc' },
          { field: ids.regionId, direction: 'asc' },
        ],
      },
    );
    expect(counts.groups).toEqual([
      { values: ['Mới', 'Bắc'], count: 2 },
      { values: ['Mới', 'Nam'], count: 1 },
      { values: ['Đang xử lý', 'Nam'], count: 1 },
      { values: ['Xong', 'Bắc'], count: 1 },
    ]);
    await expect(footer(page)).toHaveText('5 records · 3 groups');
    // Temporary until saved (T311): the view bar says so.
    await expect(page.getByRole('group', { name: 'Unsaved changes' })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('grouped.png') });
    await expectNoSeriousA11yViolations(page, 'grouped grid');
    expect(csp).toEqual([]);
    await page.context().close();
  });

  test('a collapsed group stays collapsed after a reload (this user, this device)', async ({
    browser,
  }) => {
    const page = await openAdmin(browser);
    await page.goto(viewPath(ids.groupedViewId));
    await expect(cell(page, 1)).toHaveText(GROUPED[1] ?? '');
    await clickRow(page, 1, GROUPED);
    await expect(cell(page, 1)).toHaveText(header('Trạng thái', 'Mới', 3, true));
    await expect(cell(page, 3)).toHaveText(header('Trạng thái', 'Đang xử lý', 1));
    // Collapse is not part of the view.
    const view = await ok<{ config: Record<string, unknown> }>(
      page,
      'GET',
      `/views/${ids.groupedViewId}`,
    );
    expect(JSON.stringify(view.config)).not.toContain('collapse');
    await page.reload();
    await expect(cell(page, 1)).toHaveText(header('Trạng thái', 'Mới', 3, true));
    await expect(cell(page, 3)).toHaveText(header('Trạng thái', 'Đang xử lý', 1));
    // Expand all from the group panel (T320a: no toolbar line for it).
    await page.getByTestId('group-button').click();
    await page
      .getByRole('dialog', { name: 'Group' })
      .getByRole('button', { name: 'Expand all' })
      .click();
    await page.keyboard.press('Escape');
    await expect.poll(() => primaryColumn(page, GROUPED.length)).toEqual(texts(GROUPED));
    await page.context().close();
  });

  test('a paste across a header writes the data rows only', async ({ browser }) => {
    const page = await openAdmin(browser);
    await page.goto(viewPath(ids.groupedViewId));
    await expect.poll(() => primaryColumn(page, GROUPED.length)).toEqual(texts(GROUPED));
    const before = await recordsByName(page);
    // "Cao Nguyên" (display row 4) is the last row of Mới / Bắc; then its "+" row, a spacer
    // and Mới / Nam's header.
    await clickRow(page, 4, GROUPED, 24);
    await expect(cell(page, 4)).toHaveAttribute('aria-selected', 'true');
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.closest('.ob-grid') != null))
      .toBe(true);
    await page.evaluate(() => navigator.clipboard.writeText('Cao Nguyên 2\r\nBình Minh 2\r\n'));
    const written = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' &&
        response.url().includes(`/tables/${ids.tableId}/records`),
    );
    await page.keyboard.press('ControlOrMeta+v');
    const request = (await written).request();
    const body = request.postDataJSON() as { records: { id: string; fields: object }[] };
    expect(body.records.map((record) => [record.id, record.fields])).toEqual([
      [before.get('Cao Nguyên')?.id, { [ids.primaryId]: 'Cao Nguyên 2' }],
      [before.get('Bình Minh')?.id, { [ids.primaryId]: 'Bình Minh 2' }],
    ]);
    await expect(cell(page, 4)).toHaveText('Cao Nguyên 2');
    await expect(cell(page, 7)).toHaveText(header('Khu vực', 'Nam', 1));
    await expect(cell(page, 8)).toHaveText('Bình Minh 2');
    // Back to the names of the fixture.
    const after = await recordsByName(page);
    await ok(page, 'PATCH', `/tables/${ids.tableId}/records?field_key_type=id`, {
      records: [
        { id: after.get('Cao Nguyên 2')?.id, fields: { [ids.primaryId]: 'Cao Nguyên' } },
        { id: after.get('Bình Minh 2')?.id, fields: { [ids.primaryId]: 'Bình Minh' } },
      ],
    });
    await page.context().close();
  });

  test('the "+" row of a group adds a record with the group values filled in', async ({
    browser,
  }) => {
    const page = await openAdmin(browser);
    await page.goto(viewPath(ids.groupedViewId));
    await expect.poll(() => primaryColumn(page, GROUPED.length)).toEqual(texts(GROUPED));
    const created = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === `/api/v1/tables/${ids.tableId}/records`,
    );
    // The "+" row of Xong / Bắc (display row 21), in the row gutter like Lark.
    await clickRow(page, 21, GROUPED, -30);
    const response = await created;
    expect(response.request().postDataJSON()).toEqual({
      records: [{ fields: { [ids.statusId]: 'Xong', [ids.regionId]: 'Bắc' } }],
    });
    const record = ((await response.json()) as { records: { id: string }[] }).records[0];
    await expect(cell(page, 19)).toHaveText(header('Khu vực', 'Bắc', 2));
    await expect(cell(page, 18)).toHaveText(header('Trạng thái', 'Xong', 2));
    await expect(footer(page)).toHaveText('6 records · 3 groups');
    await ok(page, 'DELETE', `/tables/${ids.tableId}/records`, { ids: [record?.id] });
    await expect(cell(page, 18)).toHaveText(header('Trạng thái', 'Xong', 1));
    await page.context().close();
  });

  test('a record moved to another group elsewhere updates headers and counts', async ({
    browser,
  }) => {
    const page = await openAdmin(browser);
    await page.goto(viewPath(ids.groupedViewId));
    await expect.poll(() => primaryColumn(page, GROUPED.length)).toEqual(texts(GROUPED));
    const other = await openAdmin(browser);
    const records = await recordsByName(other);
    // Hải Vân: Đang xử lý → Mới (another tab).
    await ok(other, 'PATCH', `/tables/${ids.tableId}/records?field_key_type=id`, {
      records: [{ id: records.get('Hải Vân')?.id, fields: { [ids.statusId]: 'Mới' } }],
    });
    await expect(cell(page, 1)).toHaveText(header('Trạng thái', 'Mới', 4));
    await expect
      .poll(() => primaryColumn(page, 16))
      .toEqual(
        texts([
          SPACER,
          header('Trạng thái', 'Mới', 4),
          header('Khu vực', 'Bắc', 2),
          'An Phát',
          'Cao Nguyên',
          add('Bắc'),
          NESTED_SPACER,
          header('Khu vực', 'Nam', 2),
          'Bình Minh',
          'Hải Vân',
          add('Nam'),
          NESTED_SPACER,
          SPACER,
          header('Trạng thái', 'Xong', 1),
          header('Khu vực', 'Bắc', 1),
          'Đông Á',
        ]),
      );
    await expect(footer(page)).toHaveText('5 records · 2 groups');
    await other.context().close();
    await page.context().close();
  });
});
