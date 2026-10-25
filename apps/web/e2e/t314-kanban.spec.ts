import { type Browser, type Locator, type Page } from '@playwright/test';

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
 * T314: kanban views. Self-contained like t310: the first administrator
 * (created by t011 when it runs first, else here), a table of tickets with
 * a single select "Trạng thái", a kanban view grouped by it, and a "Sales"
 * member whose role reads the status but may not change it (P-matrix
 * `status: read`).
 */
const ADMIN = {
  name: 'Nguyễn Văn Ánh',
  email: WORKER_ORG.ownerEmail,
  password: 'E2E-Setup-Password-2026',
};
const RUN = String(Date.now());
const SALES = {
  name: 'Phạm Văn Bán',
  email: `sales-t314-${RUN}@cellhive.test`,
  password: 'E2E-Sales-Password-2026',
};
const TABLE_NAME = 'Phiếu hỗ trợ';
const STATUSES = ['Mới', 'Đang xử lý', 'Xong'] as const;

/** Signs in with the shared `apiSignIn` (waits out the per-IP limit). */
async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.setItem('cellhive.language', 'en');
  });
  await page.goto('/login');
  await apiSignIn(page, email, password);
}

async function openAs(
  browser: Browser,
  email: string,
  password: string,
  viewport = { width: 1600, height: 900 },
): Promise<Page> {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await signIn(page, email, password);
  return page;
}

interface Field {
  id: string;
  options: { options?: { id: string; name: string }[] };
}

interface RecordDto {
  id: string;
  version: number;
  fields: Record<string, unknown>;
}

const ids = {
  baseId: '',
  tableId: '',
  viewId: '',
  statusId: '',
  options: {} as Record<string, string>,
  records: {} as Record<string, string>,
};
const boardPath = () => `/b/${ids.baseId}/t/${ids.tableId}/v/${ids.viewId}`;

function board(page: Page): Locator {
  return page.getByRole('region', { name: `${TABLE_NAME} by Trạng thái` });
}

function column(page: Page, status: (typeof STATUSES)[number]): Locator {
  return board(page).locator(
    `[data-testid="kanban-column"][data-column="${ids.options[status] ?? ''}"]`,
  );
}

function card(scope: Locator, title: string): Locator {
  return scope.getByTestId('kanban-card').filter({ hasText: title });
}

async function drag(page: Page, from: Locator, to: Locator): Promise<void> {
  const start = await from.boundingBox();
  const end = await to.boundingBox();
  if (start === null || end === null) throw new Error('not laid out');
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2 + 10, start.y + start.height / 2, { steps: 3 });
  await page.mouse.move(end.x + end.width / 2, end.y + 120, { steps: 12 });
  await page.mouse.up();
}

test.describe('T314 kanban', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ viewport: { width: 1600, height: 900 } });

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto('/login');
    // Any order of the specs (T470/T527): set up, signed in, or invited by the demo admin.
    await signInFirstAdmin(page, ADMIN);
    const me = await ok<{ orgs: { id: string }[] }>(page, 'GET', '/me');
    const orgId = me.orgs[0]?.id ?? '';
    const workspace = await ok<{ id: string }>(page, 'POST', `/orgs/${orgId}/workspaces`, {
      name: 'Kanban E2E',
    });
    const base = await ok<{ id: string }>(page, 'POST', `/workspaces/${workspace.id}/bases`, {
      name: 'Hỗ trợ',
    });
    ids.baseId = base.id;
    const table = await ok<{ id: string }>(page, 'POST', `/bases/${base.id}/tables`, {
      name: TABLE_NAME,
    });
    ids.tableId = table.id;
    const status = await ok<Field>(page, 'POST', `/tables/${table.id}/fields`, {
      name: 'Trạng thái',
      type: 'select',
      options: { options: STATUSES.map((name) => ({ name })) },
    });
    ids.statusId = status.id;
    for (const option of status.options.options ?? []) ids.options[option.name] = option.id;
    const created = await ok<{ records: RecordDto[] }>(
      page,
      'POST',
      `/tables/${table.id}/records?field_key_type=name`,
      {
        records: [
          { fields: { Name: 'Máy in kẹt giấy', 'Trạng thái': 'Mới' } },
          { fields: { Name: 'Máy quét lỗi', 'Trạng thái': 'Mới' } },
          { fields: { Name: 'Router mất mạng', 'Trạng thái': 'Đang xử lý' } },
        ],
      },
    );
    for (const record of created.records) {
      ids.records[String(record.fields['Name'])] = record.id;
    }
    const view = await ok<{ id: string }>(page, 'POST', `/tables/${table.id}/views`, {
      name: 'Bảng',
      type: 'kanban',
      config: { kanban: { group_field: status.id } },
    });
    ids.viewId = view.id;

    // "Sales": edits the table but only reads the status (cannot move cards).
    const sales = await ok<{ id: string }>(page, 'POST', `/bases/${base.id}/roles`, {
      name: `Sales ${RUN}`,
      config: {
        tables: {
          [table.id]: {
            perm: 'edit',
            view_rule: { allow_edit: false, visible_views: null },
            field_rule: {
              mode: 'specify',
              fields: { [status.id]: 'read' },
              option_edit_fields: [],
              file_download_fields: [],
            },
          },
        },
      },
    });
    const invitation = await ok<{ invite_url: string }>(
      page,
      'POST',
      `/orgs/${orgId}/invitations`,
      {
        email: SALES.email,
        role: 'member',
      },
    );
    const token = new URL(invitation.invite_url).pathname.split('/').pop() ?? '';
    const guest = await browser.newContext();
    const guestPage = await guest.newPage();
    await guestPage.goto('/login');
    const accepted = await ok<{ user: { id: string } }>(
      guestPage,
      'POST',
      `/invitations/${token}/accept`,
      { display_name: SALES.name, password: SALES.password },
    );
    await guest.close();
    await ok(page, 'PUT', `/bases/${base.id}/role-assignments`, {
      principal_type: 'user',
      principal_id: accepted.user.id,
      role_id: sales.id,
    });
    await page.close();
  });

  test('the board shows a column per status with its count; no axe violations', async ({
    page,
  }) => {
    const cspViolations = collectCspViolations(page);
    await signIn(page, ADMIN.email, ADMIN.password);
    await page.goto(boardPath());
    await expect(board(page)).toBeVisible();
    await expect(page.getByTestId('kanban-column').getByRole('heading')).toHaveText([
      /^Uncategorized\s*Records:\s*0$/u,
      /^Mới\s*Records:\s*2$/u,
      /^Đang xử lý\s*Records:\s*1$/u,
      /^Xong\s*Records:\s*0$/u,
    ]);
    await expect(card(column(page, 'Mới'), 'Máy in kẹt giấy')).toBeVisible();
    await expect(card(column(page, 'Đang xử lý'), 'Router mất mạng')).toBeVisible();
    await expectNoSeriousA11yViolations(page, 'kanban board');
    expect(cspViolations).toEqual([]);
  });

  test('dragging a card moves it, persists, and another tab sees it move', async ({ browser }) => {
    const page = await openAs(browser, ADMIN.email, ADMIN.password);
    const other = await openAs(browser, ADMIN.email, ADMIN.password);
    await Promise.all([page.goto(boardPath()), other.goto(boardPath())]);
    await expect(card(column(other, 'Mới'), 'Máy in kẹt giấy')).toBeVisible();
    // The other tab listens on the table channel before the move.
    await other.waitForTimeout(500);

    await drag(page, card(column(page, 'Mới'), 'Máy in kẹt giấy'), column(page, 'Đang xử lý'));
    await expect(card(column(page, 'Đang xử lý'), 'Máy in kẹt giấy')).toBeVisible();
    await expect(card(column(page, 'Mới'), 'Máy in kẹt giấy')).toHaveCount(0);
    const moved = Date.now();
    await expect(card(column(other, 'Đang xử lý'), 'Máy in kẹt giấy')).toBeVisible({
      timeout: 5000,
    });
    expect(Date.now() - moved, 'realtime move in the other tab').toBeLessThan(3000);
    await expect(column(other, 'Đang xử lý').getByTestId('kanban-column-count')).toHaveText(/2$/u);

    await page.reload();
    await expect(card(column(page, 'Đang xử lý'), 'Máy in kẹt giấy')).toBeVisible();
    const record = await ok<RecordDto>(
      page,
      'GET',
      `/tables/${ids.tableId}/records/${ids.records['Máy in kẹt giấy'] ?? ''}?field_key_type=name`,
    );
    expect(record.fields['Trạng thái']).toBe('Đang xử lý');
    await page.context().close();
    await other.context().close();
  });

  test('a card moves with the keyboard, and Ctrl+Z moves it back', async ({ page }) => {
    await signIn(page, ADMIN.email, ADMIN.password);
    await page.goto(boardPath());
    const scanner = card(column(page, 'Mới'), 'Máy quét lỗi');
    await expect(scanner).toBeVisible();
    await scanner.focus();
    await expect(scanner).toHaveAttribute('aria-roledescription', 'draggable card');
    // Each step is announced (and laid out) before the next key, as a screen reader user would.
    const announced = (text: string) =>
      expect(page.getByRole('status').filter({ hasText: text })).toHaveCount(1);
    await page.keyboard.press('Space');
    await announced('Card Máy quét lỗi is over column Mới.');
    // dnd-kit's keyboard sensor listens for keys from a `setTimeout` queued when the drag starts
    // (KeyboardSensor.attach): a key sent before that task runs is dropped. Timers of equal delay
    // run in order, so this one resolves once the sensor listens (T700; rects were measured right).
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve)));
    await page.keyboard.press('ArrowRight');
    await announced('Card Máy quét lỗi is over column Đang xử lý.');
    await page.keyboard.press('ArrowRight');
    await announced('Card Máy quét lỗi is over column Xong.');
    await page.keyboard.press('Space');
    await expect(card(column(page, 'Xong'), 'Máy quét lỗi')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled();
    await page.keyboard.press('Control+z');
    await expect(card(column(page, 'Mới'), 'Máy quét lỗi')).toBeVisible();

    // The "Move to" menu (Shift+F10) is the other keyboard path.
    await card(column(page, 'Mới'), 'Máy quét lỗi').focus();
    await page.keyboard.press('Shift+F10');
    await page.getByRole('menuitemradio', { name: 'Xong' }).click();
    await expect(card(column(page, 'Xong'), 'Máy quét lỗi')).toBeVisible();
    await expect(column(page, 'Xong').getByTestId('kanban-column-count')).toHaveText(/1$/u);
  });

  test('a member who only reads the status cannot move cards; the API refuses it', async ({
    browser,
  }) => {
    const page = await openAs(browser, SALES.email, SALES.password);
    await page.goto(boardPath());
    const router = card(column(page, 'Đang xử lý'), 'Router mất mạng');
    await expect(router).toBeVisible();
    await expect(router).not.toHaveAttribute('aria-roledescription');
    await drag(page, router, column(page, 'Xong'));
    await expect(card(column(page, 'Đang xử lý'), 'Router mất mạng')).toBeVisible();
    await expect(card(column(page, 'Xong'), 'Router mất mạng')).toHaveCount(0);
    // Its menu opens the record and says why cards cannot move (T320c).
    await router.focus();
    await page.keyboard.press('Shift+F10');
    await expect(page.getByRole('menuitemradio', { name: 'Xong' })).toHaveCount(0);
    await expect(page.getByTestId('kanban-move-blocked')).toBeVisible();
    await page.keyboard.press('Escape');

    const recordId = ids.records['Router mất mạng'] ?? '';
    const current = await ok<RecordDto>(page, 'GET', `/tables/${ids.tableId}/records/${recordId}`);
    const forced = await api(page, 'PATCH', `/tables/${ids.tableId}/records?field_key_type=id`, {
      records: [
        { id: recordId, version: current.version, fields: { [ids.statusId]: ids.options['Xong'] } },
      ],
    });
    expect(forced.status).toBe(403);
    await page.context().close();
  });

  test('below 768 px the board is read-only and scrolls sideways', async ({ browser }) => {
    const page = await openAs(browser, ADMIN.email, ADMIN.password, { width: 375, height: 800 });
    await page.goto(boardPath());
    await expect(board(page)).toBeVisible();
    const router = card(column(page, 'Đang xử lý'), 'Router mất mạng');
    await router.scrollIntoViewIfNeeded();
    await expect(router).toBeVisible();
    await expect(router).not.toHaveAttribute('aria-roledescription');
    await expect(page.getByRole('button', { name: /^Add a record to/u })).toHaveCount(0);
    const scrolls = await board(page).evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    );
    expect(scrolls, 'columns scroll sideways').toBe(true);
    await expectNoSeriousA11yViolations(page, 'kanban board, narrow');
    // A card opens the record full screen.
    await router.click();
    await expect(page).toHaveURL(/record=rec_/u);
    await page.context().close();
  });
});
