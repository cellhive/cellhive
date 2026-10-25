import { createRequire } from 'node:module';

import { type Browser, type BrowserContext, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { E2E_STACK_ENV } from './ports';
import { DEMO_PASSWORD } from './seed';
import { apiSignIn, collectCspViolations, expectNoSeriousA11yViolations, ok } from './support';

/**
 * T553: following a record from the UI (CONTRACTS §22.5, FRONTEND §10.1) on
 * the demo organization (CONTRACTS §9): the panel's "Follow" toggle (by
 * keyboard) → another member's edit → `record.followed_changed` (T545, the
 * real worker: the 60 s debounce of its `notifications.flush` job is moved
 * to now, as t519 does for delays) reaches the bell; "Unfollow" from the
 * grid cell menu → the next edit notifies nobody; a reader follows a record
 * they can read from the kanban card menu (keyboard); 375 px in Vietnamese:
 * a bell-only 44 px button in the full-screen panel; the public share page
 * has no follow control and asks nothing about follows.
 */

const RUN = String(Date.now()).slice(-6);
const DEMO_BASE = 'Chăm sóc khách hàng';
const EDITOR_EMAIL = WORKER_ORG.email('editor');
const READER_EMAIL = WORKER_ORG.email('reader');
const TABLE_NAME = `Theo dõi T553 ${RUN}`;
const NOTE = 'Ghi chú';
const STATUS = 'Trạng thái';
const RECORD_NAMES = ['Máy in kẹt giấy', 'Máy quét lỗi', 'Router mất mạng'] as const;
/** Grid geometry of a table with fewer than 10 rows (GridView: max(40, digits × 8 + 16)). */
const ROW_MARKER_WIDTH = 40;
const HEADER_HEIGHT = 36;
const ROW_HEIGHT = 34;

interface Pg {
  Client: new (options: { connectionString: string }) => {
    connect: () => Promise<void>;
    query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
    end: () => Promise<void>;
  };
}

async function sql(text: string, values: unknown[] = []): Promise<Record<string, unknown>[]> {
  const raw = process.env[E2E_STACK_ENV];
  if (raw === undefined) throw new Error('The E2E global setup did not publish the stack env.');
  const { DATABASE_URL } = JSON.parse(raw) as { DATABASE_URL: string };
  const pg = createRequire(new URL('../../api/package.json', import.meta.url))('pg') as Pg;
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return (await client.query(text, values)).rows;
  } finally {
    await client.end();
  }
}

type Session = Awaited<ReturnType<BrowserContext['storageState']>>;
/** One sign-in per user for the whole spec (`POST /auth/login`: 20 a minute per IP). */
const sessions = new Map<string, Session>();

async function signedIn(
  browser: Browser,
  email: string,
  options: { viewport?: { width: number; height: number }; language?: 'en' | 'vi' } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const known = sessions.get(email);
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1920, height: 1000 },
    locale: 'en-US',
    ...(known === undefined ? {} : { storageState: known }),
  });
  await context.addInitScript((value) => {
    window.localStorage.setItem('cellhive.language', value);
  }, options.language ?? 'en');
  const page = await context.newPage();
  await page.goto('/login');
  if (known === undefined) {
    await apiSignIn(page, email, DEMO_PASSWORD);
    sessions.set(email, await context.storageState());
  }
  return { context, page };
}

interface Ids {
  orgId: string;
  baseId: string;
  tableId: string;
  noteId: string;
  kanbanViewId: string;
  shareToken: string;
  records: string[];
}

const ids: Ids = {
  orgId: '',
  baseId: '',
  tableId: '',
  noteId: '',
  kanbanViewId: '',
  shareToken: '',
  records: [],
};

interface Notification {
  type: string;
  entity: { type: string; id: string };
  data: Record<string, unknown>;
}

async function followedNotifications(page: Page, recordId: string): Promise<Notification[]> {
  const list = await ok<{ items: Notification[] }>(
    page,
    'GET',
    `/orgs/${ids.orgId}/me/notifications?limit=200`,
  );
  return list.items.filter(
    (item) => item.type === 'record.followed_changed' && item.entity.id === recordId,
  );
}

/** The `notifications.flush` job of the follow buffer of a record (`followed:<record id>`). */
async function flushJob(recordId: string): Promise<boolean> {
  const rows = await sql(`SELECT 1 FROM graphile_worker._private_jobs WHERE key = $1`, [
    `followed:${recordId}`,
  ]);
  return rows.length > 0;
}

/** Runs the debounced flush now instead of in 60 s (the t519 way for delays). */
async function flushNow(recordId: string): Promise<void> {
  await expect.poll(() => flushJob(recordId), { timeout: 60_000 }).toBe(true);
  await sql(`UPDATE graphile_worker._private_jobs SET run_at = now() WHERE key = $1`, [
    `followed:${recordId}`,
  ]);
}

/** Another member edits the note of a record: one record, not a bulk change (ADR-26 §2). */
async function editNote(page: Page, recordId: string, value: string): Promise<void> {
  await ok(page, 'PATCH', `/tables/${ids.tableId}/records?field_key_type=name`, {
    records: [{ id: recordId, fields: { [NOTE]: value } }],
  });
}

function recordPanel(page: Page, title: string) {
  return page.getByRole('dialog', { name: title });
}

test.describe.serial('T553 follow a record', () => {
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    const { context, page } = await signedIn(browser, WORKER_ORG.email('admin'));
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
        if (base !== undefined) {
          ids.orgId = org.id;
          ids.baseId = base.id;
        }
      }
    }
    if (ids.baseId === '') throw new Error('The demo base is missing.');

    // A table of its own (editors edit it, readers read it: base roles of the demo).
    const table = await ok<{ id: string }>(page, 'POST', `/bases/${ids.baseId}/tables`, {
      name: TABLE_NAME,
    });
    ids.tableId = table.id;
    const note = await ok<{ id: string }>(page, 'POST', `/tables/${table.id}/fields`, {
      name: NOTE,
      type: 'text',
    });
    ids.noteId = note.id;
    const status = await ok<{ id: string }>(page, 'POST', `/tables/${table.id}/fields`, {
      name: STATUS,
      type: 'select',
      options: { options: [{ name: 'Mới' }, { name: 'Xong' }] },
    });
    // Three records in one call: a bulk create, so nobody follows them yet (C§22.5).
    const created = await ok<{ records: { id: string }[] }>(
      page,
      'POST',
      `/tables/${table.id}/records?field_key_type=name`,
      { records: RECORD_NAMES.map((name) => ({ fields: { Name: name, [STATUS]: 'Mới' } })) },
    );
    ids.records = created.records.map((record) => record.id);
    const kanban = await ok<{ id: string }>(page, 'POST', `/tables/${table.id}/views`, {
      name: 'Bảng',
      type: 'kanban',
      config: { kanban: { group_field: status.id } },
    });
    ids.kanbanViewId = kanban.id;
    const views = await ok<{ items: { id: string; type: string }[] }>(
      page,
      'GET',
      `/tables/${table.id}/views`,
    );
    const grid = views.items.find((view) => view.type === 'grid');
    if (grid === undefined) throw new Error('no grid view');
    const link = await ok<{ token: string }>(page, 'POST', `/views/${grid.id}/share-links`, {
      audience: 'public',
    });
    ids.shareToken = link.token;
    // A clean slate: nothing unread for the admin.
    await ok(page, 'POST', `/orgs/${ids.orgId}/me/notifications/read`, { all: true });
    await context.close();
  });

  test('follow from the panel by keyboard; an edit by someone else notifies; unfollow from the grid menu', async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const [r1] = ids.records;
    if (r1 === undefined) throw new Error('no record');
    const admin = await signedIn(browser, WORKER_ORG.email('admin'));
    const csp = collectCspViolations(admin.page);
    const editor = await signedIn(browser, EDITOR_EMAIL);

    // The editor's page opened last: the admin's page gets the window focus back (keyboard below).
    await admin.page.bringToFront();
    await admin.page.goto(`/b/${ids.baseId}/t/${ids.tableId}?record=${r1}`);
    const panel = recordPanel(admin.page, RECORD_NAMES[0]);
    await expect(panel).toBeVisible();
    const follow = panel.getByTestId('record-follow');
    await expect(follow).toHaveAccessibleName('Follow');
    await expect(follow).toHaveAttribute('aria-pressed', 'false');
    await expect(follow).toHaveAccessibleDescription(
      'Get notified when someone else changes this record.',
    );
    await expectNoSeriousA11yViolations(admin.page, 'record panel with the follow button');

    // Keyboard: Tab from the panel reaches the button (after ↑ ↓), Space follows. A deep link
    // may leave the focus on the grid behind, so the panel gets it first (as when opened by Space).
    await panel.focus();
    await expect(panel).toBeFocused();
    for (let step = 0; step < 6; step += 1) {
      if (await follow.evaluate((element) => element === document.activeElement)) break;
      await admin.page.keyboard.press('Tab');
    }
    await expect(follow).toBeFocused();
    // The tooltip shows on keyboard focus (FRONTEND §9.2).
    await expect(
      admin.page.getByText('Get notified when someone else changes this record.').first(),
    ).toBeVisible();
    const put = admin.page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' && response.url().endsWith(`/records/${r1}/follow`),
    );
    await admin.page.keyboard.press('Space');
    await expect(follow).toHaveAttribute('aria-pressed', 'true');
    await expect(follow).toHaveAccessibleName('Following');
    expect((await put).status()).toBe(204);
    await expect(follow).toHaveAccessibleDescription('You follow this record. Select to unfollow.');
    expect(await ok(admin.page, 'GET', `/tables/${ids.tableId}/records/${r1}/follow`)).toEqual({
      following: true,
      source: 'manual',
    });
    await expectNoSeriousA11yViolations(admin.page, 'record panel, following');

    // Another member edits r1 → one `record.followed_changed` for the admin (T545).
    await editNote(editor.page, r1, `Sửa lần 1 ${RUN}`);
    await flushNow(r1);
    await expect
      .poll(async () => (await followedNotifications(admin.page, r1)).length, { timeout: 60_000 })
      .toBe(1);
    const [notified] = await followedNotifications(admin.page, r1);
    expect(notified?.data['field_ids']).toEqual([ids.noteId]);
    // The bell counts it (realtime `notification.created`).
    await expect(
      admin.page.getByTestId('notification-badge').filter({ visible: true }),
    ).toBeVisible();

    // Unfollow from the grid cell menu (right click on the row of r1).
    await admin.page.keyboard.press('Escape');
    await expect(admin.page.getByRole('dialog')).toHaveCount(0);
    const canvas = admin.page.locator('.ob-grid [data-testid="data-grid-canvas"]');
    await expect(
      admin.page.locator('table[role="grid"] td[role="gridcell"]').first(),
    ).toBeAttached();
    const box = await canvas.boundingBox();
    if (box === null) throw new Error('grid not laid out');
    await admin.page.mouse.click(
      box.x + ROW_MARKER_WIDTH + 24,
      box.y + HEADER_HEIGHT + ROW_HEIGHT / 2,
      { button: 'right' },
    );
    const unfollow = admin.page.getByRole('menuitem', { name: 'Unfollow record' });
    await expect(unfollow).toBeEnabled();
    await expectNoSeriousA11yViolations(admin.page, 'grid cell menu with the follow item');
    const remove = admin.page.waitForResponse(
      (response) =>
        response.request().method() === 'DELETE' &&
        response.url().endsWith(`/records/${r1}/follow`),
    );
    await unfollow.click();
    expect((await remove).status()).toBe(204);
    const toasts = admin.page.getByRole('region', { name: 'Notifications' });
    await expect(toasts.getByText(`You no longer follow “${RECORD_NAMES[0]}”.`)).toBeVisible();
    expect(await ok(admin.page, 'GET', `/tables/${ids.tableId}/records/${r1}/follow`)).toEqual({
      following: false,
      source: null,
    });

    // The next edit notifies nobody: no follower, so no flush job, and no new notification.
    await editNote(editor.page, r1, `Sửa lần 2 ${RUN}`);
    await admin.page.waitForTimeout(3_000);
    expect(await flushJob(r1)).toBe(false);
    expect(await followedNotifications(admin.page, r1)).toHaveLength(1);

    // The menu now offers "Follow record" again (the state is shared with the panel).
    await admin.page.mouse.click(
      box.x + ROW_MARKER_WIDTH + 24,
      box.y + HEADER_HEIGHT + ROW_HEIGHT / 2,
      { button: 'right' },
    );
    await expect(admin.page.getByRole('menuitem', { name: 'Follow record' })).toBeEnabled();
    await admin.page.keyboard.press('Escape');

    expect(csp).toEqual([]);
    await editor.context.close();
    await admin.context.close();
  });

  test('a reader follows a record they can read from the kanban card menu (keyboard)', async ({
    browser,
  }) => {
    const r2 = ids.records[1];
    if (r2 === undefined) throw new Error('no record');
    const reader = await signedIn(browser, READER_EMAIL, {
      viewport: { width: 1600, height: 900 },
    });
    await reader.page.goto(`/b/${ids.baseId}/t/${ids.tableId}/v/${ids.kanbanViewId}`);
    const card = reader.page.getByTestId('kanban-card').filter({ hasText: RECORD_NAMES[1] });
    await expect(card).toBeVisible();
    await card.focus();
    await reader.page.keyboard.press('Shift+F10');
    const menu = reader.page.getByTestId('kanban-card-menu');
    await expect(menu).toBeVisible();
    const follow = menu.getByRole('menuitem', { name: 'Follow record' });
    await expect(follow).toBeEnabled();
    await expectNoSeriousA11yViolations(reader.page, 'kanban card menu with the follow item');
    // Arrow keys move through the menu: "Open record" → "Follow record".
    await reader.page.keyboard.press('ArrowDown');
    if (!(await follow.evaluate((element) => element === document.activeElement))) {
      await reader.page.keyboard.press('ArrowDown');
    }
    await expect(follow).toBeFocused();
    const put = reader.page.waitForResponse(
      (response) =>
        response.request().method() === 'PUT' && response.url().endsWith(`/records/${r2}/follow`),
    );
    await reader.page.keyboard.press('Enter');
    expect((await put).status()).toBe(204);
    await expect(
      reader.page
        .getByRole('region', { name: 'Notifications' })
        .getByText(`You follow “${RECORD_NAMES[1]}”.`, { exact: false }),
    ).toBeVisible();
    expect(await ok(reader.page, 'GET', `/tables/${ids.tableId}/records/${r2}/follow`)).toEqual({
      following: true,
      source: 'manual',
    });

    // The panel shows the same state.
    await card.click();
    const panel = recordPanel(reader.page, RECORD_NAMES[1]);
    await expect(panel.getByTestId('record-follow')).toHaveAttribute('aria-pressed', 'true');
    await expectNoSeriousA11yViolations(reader.page, 'kanban record panel, following');
    await reader.context.close();
  });

  test('375 px in Vietnamese: a bell-only 44 px button; the share page has no follow control', async ({
    browser,
  }) => {
    const r3 = ids.records[2];
    if (r3 === undefined) throw new Error('no record');
    const admin = await signedIn(browser, WORKER_ORG.email('admin'), {
      viewport: { width: 375, height: 812 },
      language: 'vi',
    });
    await admin.page.goto(`/b/${ids.baseId}/t/${ids.tableId}?record=${r3}`);
    const panel = recordPanel(admin.page, RECORD_NAMES[2]);
    await expect(panel).toBeVisible();
    const follow = panel.getByTestId('record-follow');
    await expect(follow).toHaveAccessibleName('Theo dõi');
    await expect(follow).toHaveAccessibleDescription(
      'Nhận thông báo khi người khác sửa bản ghi này.',
    );
    const box = await follow.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
    // Only the bell shows.
    expect(
      await follow
        .locator('span.grid')
        .evaluate((element) => element.getBoundingClientRect().width),
    ).toBeLessThanOrEqual(1);
    expect(
      await admin.page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(375);
    await follow.click();
    await expect(follow).toHaveAccessibleName('Đang theo dõi');
    await expect(follow).toHaveAttribute('aria-pressed', 'true');
    await expect(follow).toHaveAccessibleDescription(
      'Bạn đang theo dõi bản ghi này. Chọn để bỏ theo dõi.',
    );
    expect(
      await admin.page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(375);
    await expectNoSeriousA11yViolations(admin.page, 'record panel at 375 px (vi)');
    await admin.context.close();

    // The public share page: no follow control, no follow request.
    const visitorContext = await browser.newContext({
      viewport: { width: 375, height: 812 },
      locale: 'en-US',
    });
    const visitor = await visitorContext.newPage();
    const followCalls: string[] = [];
    visitor.on('request', (request) => {
      if (request.url().includes('/follow')) followCalls.push(request.url());
    });
    await visitor.goto(`/s/${ids.shareToken}`);
    const cards = visitor.getByTestId('share-card-list');
    await expect(cards).toBeVisible();
    await cards.getByText(RECORD_NAMES[2]).click();
    const shared = visitor.getByRole('dialog', { name: RECORD_NAMES[2] });
    await expect(shared).toBeVisible();
    await expect(visitor.getByTestId('record-follow')).toHaveCount(0);
    await expect(visitor.getByRole('button', { name: /^(Follow|Following)$/u })).toHaveCount(0);
    expect(followCalls).toEqual([]);
    await visitorContext.close();
  });
});
