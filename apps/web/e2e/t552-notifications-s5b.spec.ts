import { createRequire } from 'node:module';

import { type Browser, type BrowserContext, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { E2E_STACK_ENV } from './ports';
import { DEMO_PASSWORD } from './seed';
import { apiSignIn, collectCspViolations, expectNoSeriousA11yViolations, ok } from './support';

/**
 * T552: the S5b notification types in the notification center and the S5b
 * notification settings (CONTRACTS §22, FRONTEND §14) on the demo
 * organization (CONTRACTS §9), every notification produced by the real
 * pipeline of the E2E stack (API + worker, MODE=all):
 *
 * - `record.assigned`: an editor pastes the admin into 200 rows of a person
 *   field with `notify_on_assign` (one bulk PATCH from the grid) → the
 *   admin's other tab: the bell goes +1 once; the item "… 200 records …"
 *   lists 20 of them (keyboard); a single assignment links the record.
 * - `record.followed_changed`: the editor edits a record the admin follows
 *   (the 60 s debounce of `notifications.flush` moved to now, like t553);
 *   turning the type off in-app on the settings page is saved and holds.
 * - `date.reminder`: three reminders (overdue, upcoming, date-only today)
 *   from the real scanner. There is no endpoint to inject the server clock
 *   (no test-only route exists, adding one would change the contract):
 *   the reminder cursors are moved back with SQL and the scan job is
 *   queued at once — the same scanner, fan-out and permission checks run.
 *   Times read in the viewer's zone (`users.timezone`), the zone named.
 * - `import.finished`: a real CSV import with a bad row → "Download the
 *   error report" downloads it; failed/cancelled come through
 *   `notifications.fanout` (as t524 does for producers).
 * - `automation.batch_overflow` with `skipped` (QA S5 L6) read from a run.
 * - Settings: the four S5b types, the Telegram column when the API lists
 *   it (the stack has no Telegram: the answer is stubbed), the two
 *   auto-follow switches and their effect.
 *
 * Plus keyboard, axe, light/dark, 1440 px and 375 px, en/vi.
 */

const RUN = String(Date.now()).slice(-6);
const DEMO_BASE = 'Chăm sóc khách hàng';
const EDITOR_EMAIL = WORKER_ORG.email('editor');
const TABLE_NAME = `Giao việc T552 ${RUN}`;
const OWNER = 'Phụ trách';
const NOTE = 'Ghi chú';
const STATUS = 'Trạng thái';
const QUANTITY = 'Số lượng';
const DUE = 'Hạn';
const DUE_EARLY = 'Hạn sớm';
const DAY = 'Ngày giao';
const SINGLE = `Đơn lẻ ${RUN}`;
const ROWS = 200;
const ZONE = 'Asia/Ho_Chi_Minh';
/** Grid geometry (GridView: row marker max(40, digits × 8 + 16), header 36, rows 34). */
const ROW_MARKER_WIDTH = 40;
const HEADER_HEIGHT = 36;
const ROW_HEIGHT = 34;
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function fakeId(prefix: string): string {
  let id = '';
  for (let index = 0; index < 16; index += 1) {
    id += BASE62[Math.floor(Math.random() * BASE62.length)] ?? '0';
  }
  return `${prefix}_${id}`;
}

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

interface OpenOptions {
  viewport?: { width: number; height: number };
  language?: 'en' | 'vi';
  colorScheme?: 'light' | 'dark';
}

async function signedIn(
  browser: Browser,
  email: string,
  options: OpenOptions = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const known = sessions.get(email);
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1440, height: 900 },
    locale: 'en-US',
    colorScheme: options.colorScheme ?? 'light',
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
  orgSlug: string;
  baseId: string;
  tableId: string;
  adminId: string;
  editorName: string;
  fields: Record<string, string>;
  single: string;
}

const ids: Ids = {
  orgId: '',
  orgSlug: '',
  baseId: '',
  tableId: '',
  adminId: '',
  editorName: '',
  fields: {},
  single: '',
};

function field(name: string): string {
  const id = ids.fields[name];
  if (id === undefined) throw new Error(`no field ${name}`);
  return id;
}

interface Notification {
  id: string;
  type: string;
  table_id: string | null;
  entity: { type: string; id: string; title: string | null };
  data: Record<string, unknown>;
  read_at: string | null;
}

async function notifications(page: Page, type: string): Promise<Notification[]> {
  const list = await ok<{ items: Notification[] }>(
    page,
    'GET',
    `/orgs/${ids.orgId}/me/notifications?limit=200`,
  );
  return list.items.filter((item) => item.type === type);
}

/** The bell's badge as a number (0 without a badge) — read now, never waited for (T527). */
async function badge(page: Page): Promise<number> {
  const texts = await page
    .getByTestId('notification-badge')
    .filter({ visible: true })
    .allInnerTexts();
  const text = texts[0];
  return text === undefined ? 0 : Number(text.replace(/\D/gu, ''));
}

/** Queues `notifications.fanout` like a producer does (CONTRACTS §22.2), ahead of the backlog. */
async function fanout(input: {
  type: string;
  tableId: string | null;
  entity: { type: string; id: string };
  data: Record<string, unknown>;
}): Promise<void> {
  const payload = {
    organization_id: ids.orgId,
    type: input.type,
    base_id: ids.baseId,
    table_id: input.tableId,
    entity_type: input.entity.type,
    entity_id: input.entity.id,
    actor: null,
    group_key: fakeId('key'),
    recipients: { user_ids: [ids.adminId], base_admins: false },
    requires: { record_id: null, field_ids: [] },
    skip_actor: input.type !== 'import.finished',
    data: input.data,
  };
  await sql(`SELECT graphile_worker.add_job('notifications.fanout', $1::json, priority => -100)`, [
    JSON.stringify(payload),
  ]);
}

/** The `notifications.flush` job of the follow buffer of a record (`followed:<record id>`). */
async function flushJob(recordId: string): Promise<boolean> {
  const rows = await sql(`SELECT 1 FROM graphile_worker._private_jobs WHERE key = $1`, [
    `followed:${recordId}`,
  ]);
  return rows.length > 0;
}

/** Runs the debounced follow flush now instead of in 60 s (the t519/t553 way). */
async function flushNow(recordId: string): Promise<void> {
  await expect.poll(() => flushJob(recordId), { timeout: 60_000 }).toBe(true);
  await sql(`UPDATE graphile_worker._private_jobs SET run_at = now() WHERE key = $1`, [
    `followed:${recordId}`,
  ]);
  await expect.poll(() => flushJob(recordId), { timeout: 60_000 }).toBe(false);
}

/**
 * The admin's `record.followed_changed` about SINGLE only: since T557 the
 * admin also follows two demo tickets (`seed:demo`), which other specs on
 * the shared stack may change.
 */
async function followedOfSingle(page: Page): Promise<Notification[]> {
  return (await notifications(page, 'record.followed_changed')).filter(
    (item) => item.entity.id === ids.single,
  );
}

async function patchRecord(page: Page, recordId: string, fields: Record<string, unknown>) {
  await ok(page, 'PATCH', `/tables/${ids.tableId}/records?field_key_type=id`, {
    records: [{ id: recordId, fields }],
  });
}

async function openPanel(page: Page) {
  const bell = page.getByTestId('notification-bell').filter({ visible: true });
  await bell.click();
  const panel = page.getByTestId('notification-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('notification-list')).toBeVisible();
  return panel;
}

/** `Intl` output of the browser (same ICU as the app) for an instant in the viewer zone. */
async function dateTimeIn(page: Page, iso: string, language: string): Promise<string> {
  return page.evaluate(
    ({ value, zone, locale }) =>
      new Intl.DateTimeFormat(locale, {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: zone,
      }).format(new Date(value)),
    { value: iso, zone: ZONE, locale: language },
  );
}

/** Uploads a CSV for an import of the base like the import dialog (multipart + CSRF). */
async function uploadCsv(page: Page, name: string, text: string): Promise<string> {
  const id = await page.evaluate(
    async ({ baseId, filename, body }) => {
      const csrf = document.cookie
        .split('; ')
        .find((cookie) => cookie.startsWith('ob_csrf='))
        ?.slice('ob_csrf='.length);
      const form = new FormData();
      form.append('file', new File([body], filename, { type: 'text/csv' }));
      const response = await fetch(`/api/v1/bases/${baseId}/imports/uploads`, {
        method: 'POST',
        credentials: 'include',
        headers: csrf === undefined ? {} : { 'X-CSRF-Token': decodeURIComponent(csrf) },
        body: form,
      });
      if (response.status !== 201) throw new Error(`upload: ${String(response.status)}`);
      return ((await response.json()) as { id: string }).id;
    },
    { baseId: ids.baseId, filename: name, body: text },
  );
  return id;
}

test.describe.serial('T552 S5b notifications in the center and settings', () => {
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    const { context, page } = await signedIn(browser, WORKER_ORG.email('admin'));
    const me = await ok<{ user: { id: string }; orgs: { id: string; slug: string }[] }>(
      page,
      'GET',
      '/me',
    );
    ids.adminId = me.user.id;
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
          ids.orgSlug = org.slug;
          ids.baseId = base.id;
        }
      }
    }
    if (ids.baseId === '') throw new Error('The demo base is missing.');

    const table = await ok<{ id: string }>(page, 'POST', `/bases/${ids.baseId}/tables`, {
      name: TABLE_NAME,
    });
    ids.tableId = table.id;
    const definitions: { name: string; type: string; options?: Record<string, unknown> }[] = [
      { name: OWNER, type: 'user', options: { multiple: true, notify_on_assign: true } },
      { name: NOTE, type: 'text' },
      { name: STATUS, type: 'select', options: { options: [{ name: 'Mới' }, { name: 'Xong' }] } },
      { name: QUANTITY, type: 'number' },
      { name: DUE, type: 'datetime', options: { style: { format: 'yyyy-MM-dd HH:mm' } } },
      { name: DUE_EARLY, type: 'datetime', options: { style: { format: 'yyyy-MM-dd HH:mm' } } },
      {
        name: DAY,
        type: 'datetime',
        options: { style: { format: 'yyyy-MM-dd' }, timezone: ZONE },
      },
    ];
    for (const definition of definitions) {
      const created = await ok<{ id: string }>(
        page,
        'POST',
        `/tables/${table.id}/fields`,
        definition,
      );
      ids.fields[definition.name] = created.id;
    }
    const fields = await ok<{ items: { id: string; name: string; is_primary: boolean }[] }>(
      page,
      'GET',
      `/tables/${table.id}/fields`,
    );
    const primary = fields.items.find((item) => item.is_primary);
    if (primary === undefined) throw new Error('no primary field');
    ids.fields['primary'] = primary.id;
    // 200 rows in one call (a bulk create: nobody follows them, nobody is assigned).
    await ok(page, 'POST', `/tables/${table.id}/records?field_key_type=id`, {
      records: Array.from({ length: ROWS }, (_, index) => ({
        fields: { [primary.id]: `Việc ${String(index + 1).padStart(3, '0')}` },
      })),
    });
    // One record the admin creates by hand: followed (`created`), assigned later.
    const single = await ok<{ id: string }>(
      page,
      'POST',
      `/tables/${table.id}/records?field_key_type=id`,
      { fields: { [primary.id]: SINGLE } },
    );
    ids.single = single.id;
    // The viewer's time zone (`users.timezone`): reminders read in GMT+7.
    await sql(`UPDATE meta.users SET timezone = $2 WHERE id = $1`, [ids.adminId, ZONE]);
    await ok(page, 'POST', `/orgs/${ids.orgId}/me/notifications/read`, { all: true });
    await context.close();

    const editor = await signedIn(browser, EDITOR_EMAIL);
    const editorMe = await ok<{ user: { display_name: string } }>(editor.page, 'GET', '/me');
    ids.editorName = editorMe.user.display_name;
    await editor.context.close();
  });

  test('a paste of 200 rows assigns the admin: the other tab rings once, the item lists the records', async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const admin = await signedIn(browser, WORKER_ORG.email('admin'));
    const csp = collectCspViolations(admin.page);
    await admin.page.goto(`/o/${ids.orgSlug}`);
    await expect(
      admin.page.getByTestId('notification-bell').filter({ visible: true }),
    ).toBeVisible();
    expect(await badge(admin.page)).toBe(0);
    // Every badge change of tab B, to prove it rang once (never 2, never back and forth).
    const seen: number[] = [];
    const watch = setInterval(() => {
      void badge(admin.page)
        .then((value) => {
          if (seen.at(-1) !== value) seen.push(value);
        })
        .catch(() => undefined);
    }, 100);

    // Tab A: the editor pastes the admin's email into 200 rows of the person field.
    const editor = await signedIn(browser, EDITOR_EMAIL, {
      viewport: { width: 1920, height: 1000 },
    });
    await editor.context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await editor.page.goto(`/b/${ids.baseId}/t/${ids.tableId}`);
    const canvas = editor.page.locator('.ob-grid [data-testid="data-grid-canvas"]');
    await expect(
      editor.page.locator('table[role="grid"] td[role="gridcell"]').first(),
    ).toBeAttached();
    const header = editor.page
      .locator('table[role="grid"] th[role="columnheader"]')
      .filter({ hasText: new RegExp(`^${OWNER}$`, 'u') });
    const column = Number(await header.getAttribute('aria-colindex'));
    const box = await canvas.boundingBox();
    if (box === null) throw new Error('grid not laid out');
    await editor.page.mouse.click(
      box.x + ROW_MARKER_WIDTH + 24,
      box.y + HEADER_HEIGHT + ROW_HEIGHT / 2,
    );
    await expect
      .poll(() => editor.page.evaluate(() => document.activeElement?.closest('.ob-grid') != null))
      .toBe(true);
    for (let step = 1; step < column; step += 1) await editor.page.keyboard.press('ArrowRight');
    await expect(editor.page.getByTestId(`glide-cell-${String(column)}-0`)).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await editor.page.evaluate(
      (value) => navigator.clipboard.writeText(value),
      `${Array.from({ length: ROWS }, () => WORKER_ORG.email('admin')).join('\r\n')}\r\n`,
    );
    const written = editor.page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' &&
        /\/api\/v1\/tables\/tbl_[^/]+\/records\?/u.test(response.url()) &&
        response.status() === 200,
    );
    await editor.page.keyboard.press('ControlOrMeta+v');
    const patch = await written;
    expect((patch.request().postDataJSON() as { records: unknown[] }).records).toHaveLength(ROWS);

    // Tab B: +1, once (the batch is flushed as one notification per person, T544).
    await expect.poll(() => badge(admin.page), { timeout: 60_000 }).toBe(1);
    await admin.page.waitForTimeout(3_000);
    clearInterval(watch);
    expect(seen).toEqual([0, 1]);
    const assigned = (await notifications(admin.page, 'record.assigned')).filter(
      (item) => item.entity.type === 'table' && item.entity.id === ids.tableId,
    );
    expect(assigned).toHaveLength(1);
    expect(assigned[0]?.data['count']).toBe(ROWS);
    expect(assigned[0]?.data['record_ids']).toHaveLength(20);

    const panel = await openPanel(admin.page);
    const item = panel.getByTestId(`notification-${assigned[0]?.id ?? ''}`);
    await expect(
      item.getByRole('link', {
        name: `${ids.editorName} assigned you 200 records in «${TABLE_NAME}»`,
      }),
    ).toHaveAttribute('href', `/b/${ids.baseId}/t/${ids.tableId}`);
    await expect(item).toContainText(`Through ${OWNER}`);

    // Keyboard: the disclosure opens the list of 20 records, "And 180 more records".
    const show = item.getByRole('button', { name: 'Show the records' });
    await show.focus();
    await expect(show).toHaveAttribute('aria-expanded', 'false');
    await admin.page.keyboard.press('Enter');
    await expect(show).toHaveAttribute('aria-expanded', 'true');
    const list = item.getByRole('list', { name: 'Records assigned to you' });
    await expect(list.getByRole('link')).toHaveCount(20);
    // In the notification's order (`record_ids`), titled by the primary field.
    const recordIds = assigned[0]?.data['record_ids'] as string[];
    const titles = await ok<{ records: { id: string; fields: Record<string, string> }[] }>(
      admin.page,
      'POST',
      `/tables/${ids.tableId}/records/query?field_key_type=id&cell_format=text`,
      { ids: recordIds, fields: [field('primary')], limit: 20 },
    );
    const titleOf = new Map(
      titles.records.map((record) => [record.id, record.fields[field('primary')]]),
    );
    await expect(list.getByRole('link')).toHaveText(recordIds.map((id) => titleOf.get(id) ?? ''));
    await expect(item.getByText('And 180 more records')).toBeVisible();
    await expect(item.getByRole('link', { name: 'Open the table' })).toHaveAttribute(
      'href',
      `/b/${ids.baseId}/t/${ids.tableId}`,
    );
    await expectNoSeriousA11yViolations(admin.page, 'panel: bulk assignment expanded (1440 px)');
    await admin.page.keyboard.press('Tab');
    await expect(list.getByRole('link').first()).toBeFocused();
    const firstId = (assigned[0]?.data['record_ids'] as string[])[0] ?? '';
    await admin.page.keyboard.press('Enter');
    await expect(admin.page).toHaveURL(
      new RegExp(`/b/${ids.baseId}/t/${ids.tableId}.*record=${firstId}`, 'u'),
    );
    await expect(panel).toHaveCount(0);
    await expect.poll(() => badge(admin.page)).toBe(0);

    expect(csp).toEqual([]);
    await editor.context.close();
    await admin.context.close();
  });

  test('a single assignment and changes to a followed record; followed changes off in-app hold', async ({
    browser,
  }) => {
    test.setTimeout(300_000);
    const admin = await signedIn(browser, WORKER_ORG.email('admin'));
    const editor = await signedIn(browser, EDITOR_EMAIL);
    await admin.page.bringToFront();
    await admin.page.goto(`/o/${ids.orgSlug}`);
    // The admin created SINGLE by hand: following it (`created`, T543).
    expect(
      await ok(admin.page, 'GET', `/tables/${ids.tableId}/records/${ids.single}/follow`),
    ).toEqual({ following: true, source: 'created' });

    // One record assigned by the editor → `record.assigned` about the record.
    await patchRecord(editor.page, ids.single, { [field(OWNER)]: [{ id: ids.adminId }] });
    await expect
      .poll(
        async () =>
          (await notifications(admin.page, 'record.assigned')).filter(
            (item) => item.entity.id === ids.single,
          ).length,
        { timeout: 60_000 },
      )
      .toBe(1);
    // Two more edits: three changes on three fields by the editor, grouped per record.
    await patchRecord(editor.page, ids.single, {
      [field(NOTE)]: `Sửa 1 ${RUN}`,
      [field(STATUS)]: 'Xong',
    });
    await patchRecord(editor.page, ids.single, { [field(NOTE)]: `Sửa 2 ${RUN}` });
    await flushNow(ids.single);
    await expect
      .poll(async () => (await followedOfSingle(admin.page)).length, {
        timeout: 60_000,
      })
      .toBe(1);
    const [followed] = await followedOfSingle(admin.page);
    expect(followed?.data['field_ids']).toEqual([field(OWNER), field(NOTE), field(STATUS)]);
    expect(followed?.data['change_count']).toBe(3);

    const panel = await openPanel(admin.page);
    await expect(
      panel.getByRole('link', {
        name: `${ids.editorName} assigned you to «${SINGLE}» · ${OWNER}`,
      }),
    ).toHaveAttribute('href', `/b/${ids.baseId}/t/${ids.tableId}?record=${ids.single}`);
    const changed = panel.getByTestId(`notification-${followed?.id ?? ''}`);
    const fieldsText = await admin.page.evaluate(
      (names) => new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(names),
      [OWNER, NOTE, STATUS],
    );
    await expect(
      changed.getByRole('link', { name: `${ids.editorName} changed ${fieldsText} on «${SINGLE}»` }),
    ).toHaveAttribute('href', `/b/${ids.baseId}/t/${ids.tableId}?record=${ids.single}`);
    await expect(changed).toContainText('3 changes');
    await expectNoSeriousA11yViolations(admin.page, 'panel: single assignment + followed changes');
    await admin.page.keyboard.press('Escape');

    // Settings: "Changes to records you follow" off in-app — saved, and it holds.
    await admin.page.goto(`/o/${ids.orgSlug}/settings/notifications`);
    const row = admin.page.getByTestId('pref-record.followed_changed');
    await expect(row).toContainText('Changes to records you follow');
    const inApp = admin.page.getByTestId('pref-record.followed_changed-in_app');
    await expect(inApp).toBeChecked();
    await inApp.click();
    await expect(admin.page.getByTestId('settings-saved')).toContainText(
      'Saved: Changes to records you follow — In app off.',
    );
    await admin.page.reload();
    await expect(admin.page.getByTestId('pref-record.followed_changed-in_app')).not.toBeChecked();
    // The next change is not listed in-app (no row is written for in-app).
    await patchRecord(editor.page, ids.single, { [field(NOTE)]: `Sửa 3 ${RUN}` });
    await flushNow(ids.single);
    await admin.page.waitForTimeout(2_000);
    expect(await followedOfSingle(admin.page)).toHaveLength(1);

    // Back to the default for the other tests.
    await ok(admin.page, 'PUT', `/orgs/${ids.orgId}/me/notification-preferences`, {
      items: [{ type: 'record.followed_changed', channel: 'in_app', enabled: true }],
    });
    await ok(admin.page, 'POST', `/orgs/${ids.orgId}/me/notifications/read`, { all: true });
    await editor.context.close();
    await admin.context.close();
  });

  test('date reminders: overdue, upcoming, due today — in the viewer time zone (dark theme)', async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const admin = await signedIn(browser, WORKER_ORG.email('admin'), { colorScheme: 'dark' });
    const csp = collectCspViolations(admin.page);
    await admin.page.goto(`/o/${ids.orgSlug}`);
    await expect(admin.page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const recipients = { recipients: 'users', user_ids: [ids.adminId] };
    await ok(admin.page, 'PATCH', `/fields/${field(DUE)}`, {
      options: {
        style: { format: 'yyyy-MM-dd HH:mm' },
        reminder: { ...recipients, offset_minutes: 0 },
      },
    });
    await ok(admin.page, 'PATCH', `/fields/${field(DUE_EARLY)}`, {
      options: {
        style: { format: 'yyyy-MM-dd HH:mm' },
        reminder: { ...recipients, offset_minutes: -1440 },
      },
    });
    await ok(admin.page, 'PATCH', `/fields/${field(DAY)}`, {
      options: {
        style: { format: 'yyyy-MM-dd' },
        timezone: ZONE,
        reminder: { ...recipients, offset_minutes: 0, time_of_day: '00:00' },
      },
    });
    const minute = Math.floor(Date.now() / 60_000) * 60_000;
    const overdue = new Date(minute - 2 * 60_000).toISOString();
    const upcoming = new Date(minute + 24 * 60 * 60_000 - 2 * 60_000).toISOString();
    const upcomingSent = new Date(minute - 2 * 60_000).toISOString();
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    await patchRecord(admin.page, ids.single, {
      [field(DUE)]: overdue,
      [field(DUE_EARLY)]: upcoming,
      [field(DAY)]: today,
    });
    // The server clock cannot be injected: the cursors go back 25 hours (the
    // date-only reminder fell due at 00:00 today, GMT+7), then the scan runs now.
    await sql(
      `UPDATE meta.date_reminder_cursors
          SET armed_at = now() - interval '25 hours', scanned_until = now() - interval '25 hours'
        WHERE field_id = ANY($1::text[])`,
      [[field(DUE), field(DUE_EARLY), field(DAY)]],
    );
    await sql(
      `SELECT graphile_worker.add_job('notifications.date_reminder_scan', '{}'::json, priority => -100)`,
    );
    await expect
      .poll(async () => (await notifications(admin.page, 'date.reminder')).length, {
        timeout: 60_000,
      })
      .toBe(3);
    const reminders = await notifications(admin.page, 'date.reminder');
    const byField = (name: string) =>
      reminders.find((item) => item.data['field_id'] === field(name))?.id ?? '';

    const panel = await openPanel(admin.page);
    const late = panel.getByTestId(`notification-${byField(DUE)}`);
    await expect(late).toContainText(
      `«${SINGLE}»: «${DUE}» was due at ${await dateTimeIn(admin.page, overdue, 'en')}`,
    );
    await expect(late.getByTestId('status-pill')).toHaveText('Overdue');
    const soon = panel.getByTestId(`notification-${byField(DUE_EARLY)}`);
    await expect(soon).toContainText(
      `«${SINGLE}»: «${DUE_EARLY}» is due at ${await dateTimeIn(admin.page, upcoming, 'en')}`,
    );
    await expect(soon).toContainText(
      `Reminder of ${await dateTimeIn(admin.page, upcomingSent, 'en')} (GMT+7)`,
    );
    await expect(soon.getByTestId('status-pill')).toHaveText('Upcoming');
    const day = panel.getByTestId(`notification-${byField(DAY)}`);
    await expect(day).toContainText(`«${SINGLE}»: «${DAY}» is due today`);
    await expect(day.getByTestId('status-pill')).toHaveText('Due today');
    // The record opens from each reminder.
    await expect(day.getByRole('link').first()).toHaveAttribute(
      'href',
      `/b/${ids.baseId}/t/${ids.tableId}?record=${ids.single}`,
    );
    await expectNoSeriousA11yViolations(admin.page, 'panel: date reminders (dark)');
    expect(csp).toEqual([]);
    await admin.context.close();
  });

  test('import finished with a report, failed and cancelled imports, a batch overflow with skipped', async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const admin = await signedIn(browser, WORKER_ORG.email('admin'));
    const csp = collectCspViolations(admin.page);
    await admin.page.goto(`/o/${ids.orgSlug}`);
    await ok(admin.page, 'POST', `/orgs/${ids.orgId}/me/notifications/read`, { all: true });

    // A real import: two rows, one with a bad number (a failed row, a report).
    const upload = await uploadCsv(
      admin.page,
      'nhap.csv',
      `Tên,Số lượng\nNhập 1 ${RUN},5\nNhập 2 ${RUN},abc\nNhập 3 ${RUN},7\n`,
    );
    const started = await ok<{ job_id: string }>(
      admin.page,
      'POST',
      `/bases/${ids.baseId}/imports`,
      {
        upload_id: upload,
        mode: 'append',
        table_id: ids.tableId,
        mapping: [
          { column: 0, field_id: field('primary') },
          { column: 1, field_id: field(QUANTITY) },
        ],
      },
    );
    await expect
      .poll(
        async () =>
          (await ok<{ status: string }>(admin.page, 'GET', `/jobs/${started.job_id}`)).status,
        { timeout: 90_000 },
      )
      .toBe('succeeded');
    await expect
      .poll(
        async () =>
          (await notifications(admin.page, 'import.finished')).filter(
            (item) => item.data['job_id'] === started.job_id,
          ).length,
        { timeout: 60_000 },
      )
      .toBe(1);

    // A failed import and an import cancelled while queued (no table), a batch overflow.
    await fanout({
      type: 'import.finished',
      tableId: ids.tableId,
      entity: { type: 'job', id: fakeId('job') },
      data: { job_id: fakeId('job'), status: 'failed', created: 0, updated: 0, failed_rows: 4 },
    });
    await fanout({
      type: 'import.finished',
      tableId: null,
      entity: { type: 'job', id: fakeId('job') },
      data: { job_id: fakeId('job'), status: 'cancelled', created: 0, updated: 0, failed_rows: 0 },
    });
    const automationName = `E2E overflow ${RUN}`;
    const automation = await ok<{ id: string; definition: unknown }>(
      admin.page,
      'POST',
      `/bases/${ids.baseId}/automations`,
      {
        name: automationName,
        definition: {
          trigger: { type: 'record.created', table_id: ids.tableId },
          actions: [
            {
              id: 'act_1',
              type: 'update_record',
              config: {
                table_id: ids.tableId,
                record_id: null,
                fields: { [field(NOTE)]: { literal: 'e2e' } },
              },
            },
          ],
        },
      },
    );
    const runId = fakeId('run');
    await sql(
      `INSERT INTO meta.automation_runs
         (id, organization_id, automation_id, automation_version, trigger_unit, status, error,
          input, started_at, finished_at, created_at)
       VALUES ($1, $2, $3, 1, $1, 'skipped', $4::jsonb, $5::jsonb, now(), now(), now())`,
      [
        runId,
        ids.orgId,
        automation.id,
        JSON.stringify({ code: 'batch_overflow', limit: 1000, skipped: 4000 }),
        JSON.stringify({
          automation_version: 1,
          definition: automation.definition,
          trigger: {
            event_id: null,
            type: 'record.created',
            table_id: ids.tableId,
            record_id: null,
            bulk: true,
            batch: null,
          },
        }),
      ],
    );
    await fanout({
      type: 'automation.batch_overflow',
      tableId: null,
      entity: { type: 'automation', id: automation.id },
      data: { automation_id: automation.id, run_id: runId, batch_id: fakeId('bat'), limit: 1000 },
    });
    await expect
      .poll(async () => (await notifications(admin.page, 'import.finished')).length, {
        timeout: 60_000,
      })
      .toBeGreaterThanOrEqual(3);
    await expect
      .poll(
        async () =>
          (await notifications(admin.page, 'automation.batch_overflow')).filter(
            (item) => item.data['run_id'] === runId,
          ).length,
        { timeout: 60_000 },
      )
      .toBe(1);

    const panel = await openPanel(admin.page);
    const done = panel.locator('li', { hasText: `Import into «${TABLE_NAME}» finished` });
    await expect(done).toContainText('2 created · 0 updated · 1 row failed');
    await expect(
      done.getByRole('link', { name: `Import into «${TABLE_NAME}» finished` }),
    ).toHaveAttribute('href', `/b/${ids.baseId}/t/${ids.tableId}`);
    const failed = panel.locator('li', { hasText: `Import into «${TABLE_NAME}» failed` });
    await expect(failed).toContainText('0 created · 0 updated · 4 rows failed');
    await expect(failed.getByRole('button', { name: 'Download the error report' })).toHaveCount(0);
    const cancelled = panel.locator('li', { hasText: 'Import cancelled' });
    await expect(cancelled).toContainText('0 created · 0 updated');
    await expect(cancelled.getByRole('link')).toHaveCount(0);
    const overflow = panel.locator('li', {
      hasText: `Automation «${automationName}» skipped records of a bulk change`,
    });
    await expect(overflow).toContainText(
      '4,000 records of the batch got no run. It runs at most 1,000 times for one batch of changes.',
    );
    await expectNoSeriousA11yViolations(admin.page, 'panel: imports and batch overflow');

    // The report of the real import downloads (GET /jobs/:id → download_url).
    const report = done.getByRole('button', { name: 'Download the error report' });
    await report.focus();
    const download = admin.page.waitForEvent('download');
    await admin.page.keyboard.press('Enter');
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.csv$/u);
    expect(csp).toEqual([]);
    await admin.context.close();
  });

  test('settings: the S5b types, the Telegram column when listed, auto-follow switches', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const admin = await signedIn(browser, WORKER_ORG.email('admin'));
    const settingsPath = `/o/${ids.orgSlug}/settings/notifications`;
    await admin.page.goto(settingsPath);
    await expect(
      admin.page.getByRole('heading', { name: 'Notifications', level: 1 }),
    ).toBeVisible();
    for (const [type, name] of [
      ['record.assigned', 'Assigned to records'],
      ['record.followed_changed', 'Changes to records you follow'],
      ['date.reminder', 'Date reminders'],
      ['import.finished', 'Import finished'],
    ] as const) {
      const row = admin.page.getByTestId(`pref-${type}`);
      await expect(row).toContainText(name);
      await expect(admin.page.getByTestId(`pref-${type}-in_app`)).toHaveAccessibleName(
        `${name}: In app`,
      );
    }
    // No notification bot in the stack: no Telegram column.
    await expect(admin.page.getByRole('columnheader', { name: 'Telegram' })).toHaveCount(0);

    // Auto-follow: both on by default; turning "records I create" off is saved and holds.
    const created = admin.page.getByTestId('follow-created');
    const assigned = admin.page.getByTestId('follow-assigned');
    await expect(created).toBeChecked();
    await expect(assigned).toBeChecked();
    await expect(created).toHaveAccessibleName('Follow records I create');
    await expect(created).toHaveAccessibleDescription(
      'When you create one record by hand. Not pastes, imports, forms or automations.',
    );
    await created.focus();
    await admin.page.keyboard.press('Space');
    await expect(admin.page.getByTestId('settings-saved')).toContainText(
      'Saved: Follow records I create — off.',
    );
    await expectNoSeriousA11yViolations(admin.page, 'settings: S5b (light, 1440 px)');
    await admin.page.reload();
    await expect(admin.page.getByTestId('follow-created')).not.toBeChecked();
    expect(
      await ok<{ auto_follow_created: boolean; auto_follow_assigned: boolean }>(
        admin.page,
        'GET',
        `/orgs/${ids.orgId}/me/notification-settings`,
      ),
    ).toMatchObject({ auto_follow_created: false, auto_follow_assigned: true });
    // Its effect: a record created by hand now is not followed.
    const fresh = await ok<{ id: string }>(
      admin.page,
      'POST',
      `/tables/${ids.tableId}/records?field_key_type=id`,
      { fields: { [field('primary')]: `Không theo dõi ${RUN}` } },
    );
    expect(
      await ok(admin.page, 'GET', `/tables/${ids.tableId}/records/${fresh.id}/follow`),
    ).toEqual({ following: false, source: null });
    await admin.page.getByTestId('follow-created').click();
    await expect(admin.page.getByTestId('settings-saved')).toContainText(
      'Saved: Follow records I create — on.',
    );
    await expect(admin.page.getByTestId('follow-created')).toBeChecked();

    // With a notification bot the API lists Telegram (T550): stubbed, the stack has no Telegram.
    const withTelegram = (items: { type: string; channel: string; enabled: boolean }[]) => [
      ...items,
      ...items
        .filter((item) => item.channel === 'in_app')
        .map((item) => ({
          type: item.type,
          channel: 'telegram',
          enabled: item.type !== 'import.finished',
          locked: false,
        })),
    ];
    let telegramPut: unknown = null;
    // A linked channel (T555 keeps the column's switches locked until then).
    await admin.page.route('**/api/v1/orgs/*/me/channels', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      await route.fulfill({
        json: {
          items: [
            {
              kind: 'telegram',
              status: 'linked',
              error_reason: null,
              linked_at: '2026-10-17T01:00:00.000Z',
              bot_username: 'cellhive_e2e_bot',
            },
          ],
          available_kinds: ['telegram'],
        },
      });
    });
    await admin.page.route('**/api/v1/orgs/*/me/notification-preferences', async (route) => {
      if (route.request().method() === 'PUT') telegramPut = route.request().postDataJSON();
      const response = await route.fetch();
      const body = (await response.json()) as {
        items: { type: string; channel: string; enabled: boolean }[];
      };
      await route.fulfill({ response, json: { items: withTelegram(body.items) } });
    });
    await admin.page.reload();
    await expect(admin.page.getByRole('columnheader', { name: 'Telegram' })).toBeVisible();
    const telegram = admin.page.getByTestId('pref-date.reminder-telegram');
    await expect(telegram).toHaveAccessibleName('Date reminders: Telegram');
    await expect(telegram).toBeChecked();
    await telegram.click();
    await expect(admin.page.getByTestId('settings-saved')).toContainText(
      'Saved: Date reminders — Telegram off.',
    );
    expect(telegramPut).toEqual({
      items: [{ type: 'date.reminder', channel: 'telegram', enabled: false }],
    });
    expect(
      await admin.page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(1440);
    await expectNoSeriousA11yViolations(admin.page, 'settings with the Telegram column');
    await admin.page.unroute('**/api/v1/orgs/*/me/notification-preferences');
    await admin.page.unroute('**/api/v1/orgs/*/me/channels');
    await ok(admin.page, 'PUT', `/orgs/${ids.orgId}/me/notification-preferences`, {
      items: [{ type: 'date.reminder', channel: 'telegram', enabled: true }],
    });
    await admin.context.close();

    // Dark theme of the same page.
    const dark = await signedIn(browser, WORKER_ORG.email('admin'), { colorScheme: 'dark' });
    await dark.page.goto(settingsPath);
    await expect(dark.page.getByTestId('follow-settings')).toBeVisible();
    await expectNoSeriousA11yViolations(dark.page, 'settings: S5b (dark)');
    await dark.context.close();
  });

  test('375 px in Vietnamese: S5b items in the full-screen panel, the settings page', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const admin = await signedIn(browser, WORKER_ORG.email('admin'), {
      viewport: { width: 375, height: 812 },
      language: 'vi',
    });
    await admin.page.goto(`/o/${ids.orgSlug}`);
    const assigned = (await notifications(admin.page, 'record.assigned')).find(
      (item) => item.entity.type === 'table',
    );
    const panel = await openPanel(admin.page);
    const box = await panel.boundingBox();
    expect(box).toMatchObject({ x: 0, y: 0, width: 375, height: 812 });
    const item = panel.getByTestId(`notification-${assigned?.id ?? ''}`);
    await expect(
      item.getByRole('link', {
        name: `${ids.editorName} đã giao cho bạn 200 bản ghi trong «${TABLE_NAME}»`,
      }),
    ).toBeVisible();
    const show = item.getByRole('button', { name: 'Xem các bản ghi' });
    expect((await show.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    await show.click();
    await expect(
      item.getByRole('list', { name: 'Bản ghi được giao cho bạn' }).getByRole('link'),
    ).toHaveCount(20);
    await expect(item.getByText('Và 180 bản ghi khác')).toBeVisible();
    await expect(panel.getByText(`«${SINGLE}» đã quá hạn «${DUE}» lúc`)).toBeVisible();
    await expect(panel.getByText('Quá hạn', { exact: true })).toBeVisible();
    await expect(panel.getByText(`Nhập dữ liệu vào «${TABLE_NAME}» đã xong`)).toBeVisible();
    await expect(panel.getByText('2 tạo mới · 0 cập nhật · 1 dòng lỗi')).toBeVisible();
    expect(
      await admin.page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(375);
    await expectNoSeriousA11yViolations(admin.page, 'panel: S5b items at 375 px (vi)');
    await panel.getByRole('button', { name: 'Đóng thông báo' }).click();
    await expect(panel).toHaveCount(0);

    await admin.page.goto(`/o/${ids.orgSlug}/settings/notifications`);
    await expect(admin.page.getByRole('heading', { name: 'Thông báo', level: 1 })).toBeVisible();
    await expect(admin.page.getByTestId('pref-record.assigned')).toContainText('Được giao bản ghi');
    const follow = admin.page.getByTestId('follow-settings');
    await expect(follow).toContainText('Theo dõi bản ghi');
    await expect(admin.page.getByTestId('follow-assigned')).toHaveAccessibleName(
      'Tự theo dõi bản ghi tôi được giao',
    );
    expect(
      await admin.page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(375);
    await expectNoSeriousA11yViolations(admin.page, 'settings: S5b at 375 px (vi)');
    await admin.context.close();
  });
});
