import { type BrowserContext, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import {
  api,
  apiSignIn,
  collectCspViolations,
  expectNoSeriousA11yViolations,
  ok,
  signInFirstAdmin,
} from './support';

/**
 * T207: field configuration from the grid. Self-contained like t208: the
 * first administrator (created by t011 when it runs first, else here), its
 * own workspace/base/table, and an editor invited for the P05 check.
 */
const ADMIN = {
  name: 'Nguyễn Văn Ánh',
  email: WORKER_ORG.ownerEmail,
  password: 'E2E-Setup-Password-2026',
};
const EDITOR = {
  name: 'Trần Thị Sửa',
  // Unique per run: a retried worker runs the setup again.
  email: `editor-t207-${String(Date.now())}@cellhive.test`,
  password: 'E2E-Editor-Password-2026',
};
const TABLE_NAME = 'Công việc';

/** One field of every S1 type, with the type name its column header announces. */
const NEW_FIELDS = [
  { name: 'Ghi chú', type: 'text', header: 'text' },
  { name: 'Số tiền', type: 'number', header: 'number' },
  { name: 'Trạng thái', type: 'select', header: 'single select' },
  { name: 'Hạn', type: 'datetime', header: 'date' },
  { name: 'Đã duyệt', type: 'checkbox', header: 'checkbox' },
  { name: 'Phụ trách', type: 'user', header: 'user' },
  { name: 'Tạo lúc', type: 'created_at', header: 'created time' },
  { name: 'Sửa lúc', type: 'updated_at', header: 'last modified time' },
  { name: 'Người tạo', type: 'created_by', header: 'created by' },
  { name: 'Người sửa', type: 'updated_by', header: 'last modified by' },
  { name: 'Mã', type: 'auto_number', header: 'auto number' },
] as const;

/** Signs in with the shared `apiSignIn` (waits out the per-IP limit). */
async function signIn(page: Page, email: string, password: string): Promise<void> {
  // This device picks English whatever the profile says.
  await page.addInitScript(() => {
    window.localStorage.setItem('cellhive.language', 'en');
  });
  await page.goto('/login');
  await apiSignIn(page, email, password);
}

/** Reuses a session signed in earlier: one sign-in less against the per-IP limit (T319). */
async function reuseSession(page: Page, cookies: Parameters<BrowserContext['addCookies']>[0]) {
  await page.addInitScript(() => {
    window.localStorage.setItem('cellhive.language', 'en');
  });
  await page.context().addCookies(cookies);
}

/** The column header of glide's accessibility table (lists the visible columns). */
function header(page: Page, name: string) {
  return page.locator('table[role="grid"] th[role="columnheader"]', { hasText: name });
}

/** Text of a cell of the accessibility table, by row (1-based) and column name. */
async function cellText(page: Page, row: number, column: string): Promise<string> {
  const index = await header(page, column).getAttribute('aria-colindex');
  const cell = page.locator(
    `table[role="grid"] tr[aria-rowindex="${String(row + 1)}"] td[aria-colindex="${String(index)}"]`,
  );
  return (await cell.textContent()) ?? '';
}

test.describe('T207 field configuration', () => {
  // Wide enough for every column of the table in the accessibility table.
  test.use({ viewport: { width: 2600, height: 1000 } });
  // T319: an action that cannot happen (a click held by an overlay) fails
  // here with its locator, instead of using up the whole test budget.
  test.use({ actionTimeout: 15_000 });

  const ids = { baseId: '', tableId: '', recordIds: [] as string[], orgId: '' };
  let adminCookies: Parameters<BrowserContext['addCookies']>[0] = [];

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto('/login');
    // Any order of the specs (T470/T527): set up, signed in, or invited by the demo admin.
    await signInFirstAdmin(page, ADMIN);
    const me = await ok<{ orgs: { id: string }[] }>(page, 'GET', '/me');
    ids.orgId = me.orgs[0]?.id ?? '';
    const workspace = await ok<{ id: string }>(page, 'POST', `/orgs/${ids.orgId}/workspaces`, {
      name: 'Trường E2E',
    });
    const base = await ok<{ id: string }>(page, 'POST', `/workspaces/${workspace.id}/bases`, {
      name: 'Dự án',
    });
    ids.baseId = base.id;
    const table = await ok<{ id: string }>(page, 'POST', `/bases/${base.id}/tables`, {
      name: TABLE_NAME,
    });
    ids.tableId = table.id;
    const created = await ok<{ records: { id: string }[] }>(
      page,
      'POST',
      `/tables/${table.id}/records?field_key_type=name`,
      { records: ['Việc 1', 'Việc 2', 'Việc 3'].map((name) => ({ fields: { Name: name } })) },
    );
    ids.recordIds = created.records.map((record) => record.id);

    // An editor of the base (P05: no schema rights).
    const invitation = await ok<{ invite_url: string }>(
      page,
      'POST',
      `/orgs/${ids.orgId}/invitations`,
      { email: EDITOR.email, role: 'member' },
    );
    const token = new URL(invitation.invite_url).pathname.split('/').pop() ?? '';
    const guest = await browser.newContext();
    const guestPage = await guest.newPage();
    await guestPage.goto('/login');
    const accepted = await ok<{ user: { id: string } }>(
      guestPage,
      'POST',
      `/invitations/${token}/accept`,
      { display_name: EDITOR.name, password: EDITOR.password },
    );
    await guest.close();
    const roles = await ok<{ items: { id: string; kind: string }[] }>(
      page,
      'GET',
      `/bases/${base.id}/roles`,
    );
    await ok(page, 'PUT', `/bases/${base.id}/role-assignments`, {
      principal_type: 'user',
      principal_id: accepted.user.id,
      role_id: roles.items.find((role) => role.kind === 'system_editor')?.id,
    });
    adminCookies = (await page.context().storageState()).cookies;
    await page.close();
  });

  test('create every S1 type, rename, delete a select option', async ({ page }) => {
    test.setTimeout(180_000);
    const cspViolations = collectCspViolations(page);
    await reuseSession(page, adminCookies);
    await page.goto(`/b/${ids.baseId}/t/${ids.tableId}`);
    await expect(page.getByRole('heading', { level: 1, name: TABLE_NAME })).toBeVisible();

    await test.step('create one field of each S1 type from the toolbar', async () => {
      for (const field of NEW_FIELDS) {
        // T320b: "Add field" is in the toolbar's "≡" menu.
        await page.getByRole('button', { name: 'More actions' }).click();
        await page.getByRole('menuitem', { name: 'Add field' }).click();
        const dialog = page.getByRole('dialog', { name: 'New field' });
        await dialog.getByLabel('Name', { exact: true }).fill(field.name);
        await dialog.getByLabel('Field type').selectOption(field.type);
        if (field.type === 'select') {
          for (const option of ['Mới', 'Xong']) {
            await dialog.getByRole('button', { name: 'Add option' }).click();
            await dialog
              .getByRole('textbox', { name: /^Name of option \d+$/u })
              .last()
              .fill(option);
          }
          await expect(dialog.getByRole('region', { name: 'Preview' })).toContainText('Xong');
          await expectNoSeriousA11yViolations(page, 'field dialog (select)');
        }
        if (field.type === 'auto_number') {
          await expect(dialog.getByText('NO.001, NO.002, NO.003')).toBeVisible();
        }
        await dialog.getByRole('button', { name: 'Create field' }).click();
        await expect(dialog).toBeHidden();
        await expect(header(page, field.name)).toHaveAttribute(
          'aria-label',
          `${field.name}, ${field.header}`,
        );
      }
    });

    await test.step('cells use the renderer of their type', async () => {
      const [first] = ids.recordIds;
      await ok(page, 'PATCH', `/tables/${ids.tableId}/records?field_key_type=name`, {
        records: [
          {
            id: first,
            fields: {
              'Ghi chú': 'Gọi lại khách',
              'Số tiền': 1234,
              'Trạng thái': 'Xong',
              Hạn: '2026-09-25',
              'Đã duyệt': true,
            },
          },
        ],
      });
      await page.reload();
      await expect.poll(() => cellText(page, 1, 'Trạng thái')).toBe('Xong');
      expect(await cellText(page, 1, 'Ghi chú')).toBe('Gọi lại khách');
      expect(await cellText(page, 1, 'Số tiền')).toBe('1234');
      expect(await cellText(page, 1, 'Hạn')).toBe('2026-09-25');
      expect(await cellText(page, 1, 'Đã duyệt')).toBe('true');
      expect(await cellText(page, 1, 'Người tạo')).toBe(ADMIN.name);
      expect(await cellText(page, 1, 'Mã')).toMatch(/^NO\.\d{3}$/u);
      await page.screenshot({ path: test.info().outputPath('t207-grid.png') });
    });

    await test.step('rename from the header menu', async () => {
      // Keyboard: a cell of the column, then Shift+F10 opens its menu (FRONTEND §9.2).
      // Right after the reload the click may land before the grid takes focus: try again.
      await expect(async () => {
        await clickCell(page, 'Ghi chú', 1);
        // Glide focuses the grid on the next animation frame: keys pressed before go nowhere.
        await expect
          .poll(() => page.evaluate(() => document.activeElement?.closest('.ob-grid') != null))
          .toBe(true);
        // The click also queued glide's own `focus()` for the next animation frame; on a
        // busy machine that frame came after Shift+F10 and its focus closed the new menu
        // (focus outside). A frame requested now runs after it: the focus is settled.
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => {
                resolve();
              });
            }),
        );
        await page.keyboard.press('Shift+F10');
        await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeVisible({
          timeout: 2000,
        });
      }).toPass({ timeout: 20_000 });
      await page.getByRole('menuitem', { name: 'Rename' }).click();
      const dialog = page.getByRole('dialog', { name: 'Rename field' });
      await dialog.getByLabel('Name', { exact: true }).fill('Số tiền');
      await dialog.getByRole('button', { name: 'Rename' }).click();
      await expect(
        dialog.getByText('Another field of this table already has this name.'),
      ).toBeVisible();
      await dialog.getByLabel('Name', { exact: true }).fill('Nhận xét');
      await dialog.getByRole('button', { name: 'Rename' }).click();
      await expect(dialog).toBeHidden();
      await expect(header(page, 'Nhận xét')).toHaveAttribute('aria-label', 'Nhận xét, text');
    });

    await test.step('delete a select option: its cells are cleared after the job', async () => {
      const [first] = ids.recordIds;
      const before = await ok<{ version: number }>(
        page,
        'GET',
        `/tables/${ids.tableId}/records/${String(first)}`,
      );
      await rightClickHeader(page, 'Trạng thái');
      await page.getByRole('menuitem', { name: 'Edit field' }).click();
      const dialog = page.getByRole('dialog', { name: 'Edit field' });
      await dialog.getByRole('button', { name: 'Delete Xong' }).click();
      await expect(dialog.getByText(/1 option will be deleted/u)).toBeVisible();
      await expectNoSeriousA11yViolations(page, 'field dialog (option deleted)');
      await dialog.getByRole('button', { name: 'Save' }).click();
      await expect(dialog).toBeHidden();
      // PATCH names the job (T204): its toast ends with the outcome.
      await expect(page.getByText('The deleted option was removed from the records.')).toBeVisible({
        timeout: 30_000,
      });
      // The worker's job rewrites the record (new version) without the option.
      await expect
        .poll(
          async () =>
            (
              await ok<{ version: number }>(
                page,
                'GET',
                `/tables/${ids.tableId}/records/${String(first)}`,
              )
            ).version,
          { timeout: 30_000 },
        )
        .toBeGreaterThan(before.version);
      await page.reload();
      await expect(header(page, 'Trạng thái')).toBeAttached();
      await expect.poll(() => cellText(page, 1, 'Trạng thái')).toBe('');
    });

    expect(cspViolations, 'Content-Security-Policy violations').toEqual([]);
  });

  test('an editor (P05) sees no schema action; the API refuses anyway', async ({ page }) => {
    await signIn(page, EDITOR.email, EDITOR.password);
    await page.goto(`/b/${ids.baseId}/t/${ids.tableId}`);
    await expect(page.getByRole('heading', { level: 1, name: TABLE_NAME })).toBeVisible();
    await expect(header(page, 'Name')).toBeAttached();
    await page.getByRole('button', { name: 'More actions' }).click();
    await expect(page.getByRole('menuitem', { name: 'Keyboard shortcuts' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Add field' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await rightClickHeader(page, 'Name');
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem')).toHaveText([
      'Sort ascending',
      'Sort descending',
      'Freeze up to this field',
    ]);
    await expectNoSeriousA11yViolations(page, 'header menu (editor)');
    await page.keyboard.press('Escape');
    const refused = await api(page, 'POST', `/tables/${ids.tableId}/fields`, {
      name: 'Không được',
      type: 'text',
    });
    expect(refused.status).toBe(403);
  });
});

/**
 * Right click in the middle of a column header on the canvas. Glide exposes
 * no header geometry in the DOM, so the x position is summed from the
 * widths of the columns before it (default widths, nothing resized yet).
 */
async function rightClickHeader(page: Page, name: string): Promise<void> {
  const box = await page.locator('.ob-grid [data-testid="data-grid-canvas"]').boundingBox();
  if (box === null) throw new Error('grid not laid out');
  // Glide's scroller sits above the canvas and forwards pointer events to it.
  await page.mouse.click(box.x + (await columnCenter(page, name)), box.y + 18, { button: 'right' });
}

/** Left click on a body cell (row 1-based) of a column. */
async function clickCell(page: Page, name: string, row: number): Promise<void> {
  const box = await page.locator('.ob-grid [data-testid="data-grid-canvas"]').boundingBox();
  if (box === null) throw new Error('grid not laid out');
  const x = await columnCenter(page, name);
  // Header 36 px, compact rows 34 px.
  await page.mouse.click(box.x + x, box.y + 36 + 34 * (row - 1) + 17);
}

async function columnCenter(page: Page, name: string): Promise<number> {
  const index = await page.evaluate((column) => {
    const headers = [...document.querySelectorAll('table[role="grid"] th[role="columnheader"]')];
    return headers.findIndex((th) => th.textContent === column);
  }, name);
  expect(index, `column ${name}`).toBeGreaterThanOrEqual(0);
  const offsets = await columnOffsets(page);
  const left = offsets[index];
  const right = offsets[index + 1];
  if (left === undefined || right === undefined) throw new Error(`no geometry for ${name}`);
  return (left + right) / 2;
}

/** Left edges of the columns on the canvas (row markers first), from the header labels. */
async function columnOffsets(page: Page): Promise<number[]> {
  const labels = await page
    .locator('table[role="grid"] th[role="columnheader"]')
    .evaluateAll((headers) => headers.map((th) => th.getAttribute('aria-label') ?? ''));
  // Row markers (3 rows → 40 px), then the default width of each type (grid/columns.ts).
  const widthOf = (label: string) => {
    if (label.endsWith('primary field')) return 240;
    const type = label.slice(label.lastIndexOf(', ') + 2);
    switch (type) {
      case 'checkbox':
        return 96;
      case 'number':
      case 'auto number':
        return 140;
      case 'date':
      case 'created time':
      case 'last modified time':
        return 160;
      case 'single select':
      case 'user':
      case 'created by':
      case 'last modified by':
        return 180;
      default:
        return 200;
    }
  };
  const offsets = [40];
  for (const label of labels) offsets.push((offsets.at(-1) ?? 0) + widthOf(label));
  return offsets;
}
