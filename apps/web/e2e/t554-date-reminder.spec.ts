import { createRequire } from 'node:module';

import { type Browser, type BrowserContext, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { E2E_STACK_ENV } from './ports';
import { DEMO_PASSWORD } from './seed';
import { api, apiSignIn, collectCspViolations, expectNoSeriousA11yViolations, ok } from './support';

/**
 * T554: the date reminder of a `datetime` field in the field dialog
 * (CONTRACTS §2 / §22.6, FRONTEND §4.3; the board "S5b · Date reminder" is
 * not on the canvas yet — built from the dialog's controls and F§9.3
 * tokens) on a table of the demo base (CONTRACTS §9):
 * - the admin turns on "1 day before, 09:00" for `Due` (date only) by
 *   keyboard, to the people of `Owner`; the zone of the field is named, the
 *   next reminder of an example value is previewed; saved, reopened as it
 *   was; the header says what it does (accessible name + hover tip);
 * - `422` details land at their control: a member outside the organization
 *   (`user_ids[i]` USER_NOT_FOUND), `user_field_id` INVALID_FIELD_TYPE and
 *   UNKNOWN_FIELD, `time_of_day` on a field with a time;
 * - an editor (and a reader) cannot configure it (no "Edit field", `403`)
 *   but read it on the header;
 * - the recipient field deleted: schema managers are warned on the header
 *   and in the dialog, others are told nothing more;
 * - a phone (375 px) in Vietnamese: a new date field with a reminder to
 *   members, no horizontal scroll, 44 px targets, axe.
 */

const RUN = String(Date.now()).slice(-6);
const DEMO_BASE = 'Chăm sóc khách hàng';
const EDITOR_EMAIL = WORKER_ORG.email('editor');
const READER_EMAIL = WORKER_ORG.email('reader');
const TABLE_NAME = `Nhắc hạn T554 ${RUN}`;
const OUTSIDER = {
  id: 'usr_Outside554000001',
  email: 'outsider-t554@elsewhere.example',
  name: 'Người Ngoài T554',
};
/** Columns of the table, in order, with their default widths (grid/columns.ts). */
const COLUMNS = [
  ['Name', 240],
  ['Due', 160],
  ['Meeting', 160],
  ['Owner', 180],
  ['Reviewer', 180],
  ['Note', 200],
] as const;
/** Row markers of a table with fewer than 10 rows (GridView: max(40, digits × 8 + 16)). */
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
    viewport: options.viewport ?? { width: 1600, height: 1000 },
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

interface FieldDto {
  id: string;
  name: string;
  type: string;
  options: Record<string, unknown>;
}

const ids = {
  orgId: '',
  orgZone: '',
  adminId: '',
  baseId: '',
  tableId: '',
  due: '',
  meeting: '',
  owner: '',
  reviewer: '',
  note: '',
  otherTableField: '',
};

/** Center of a column on the canvas, from the left of the canvas. */
function columnCenter(name: (typeof COLUMNS)[number][0]): number {
  let left = ROW_MARKER_WIDTH;
  for (const [column, width] of COLUMNS) {
    if (column === name) return left + width / 2;
    left += width;
  }
  throw new Error(`no column ${name}`);
}

async function canvasBox(page: Page) {
  const box = await page.locator('.ob-grid [data-testid="data-grid-canvas"]').boundingBox();
  if (box === null) throw new Error('grid not laid out');
  return box;
}

/** The column header of glide's accessibility table. */
function header(page: Page, name: string) {
  return page.locator('table[role="grid"] th[role="columnheader"]', { hasText: name });
}

async function openGrid(page: Page): Promise<void> {
  await page.goto(`/b/${ids.baseId}/t/${ids.tableId}`);
  await expect(header(page, 'Due')).toBeAttached();
}

/** Opens the header menu of a column from a cell of it by keyboard (Shift+F10, FRONTEND §9.2). */
async function headerMenuByKeyboard(page: Page, name: (typeof COLUMNS)[number][0]) {
  await expect(async () => {
    const box = await canvasBox(page);
    await page.mouse.click(box.x + columnCenter(name), box.y + HEADER_HEIGHT + ROW_HEIGHT / 2);
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.closest('.ob-grid') != null))
      .toBe(true);
    await page.keyboard.press('Shift+F10');
    await expect(page.getByRole('menuitem', { name: 'Sort ascending' })).toBeVisible({
      timeout: 2000,
    });
  }).toPass({ timeout: 20_000 });
}

async function openFieldDialog(page: Page, name: 'Due' | 'Meeting') {
  const box = await canvasBox(page);
  await page.mouse.click(box.x + columnCenter(name), box.y + HEADER_HEIGHT / 2, {
    button: 'right',
  });
  await page.getByRole('menuitem', { name: 'Edit field' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit field' });
  await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue(name);
  return dialog;
}

async function reminderOf(page: Page, fieldId: string): Promise<unknown> {
  const field = await ok<FieldDto>(page, 'GET', `/fields/${fieldId}`);
  return field.options['reminder'] ?? null;
}

test.describe.serial('T554 date reminder of a date field', () => {
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    const { context, page } = await signedIn(browser, WORKER_ORG.email('admin'));
    const me = await ok<{ user: { id: string }; orgs: { id: string }[] }>(page, 'GET', '/me');
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
          ids.baseId = base.id;
        }
      }
    }
    if (ids.baseId === '') throw new Error('The demo base is missing.');
    const org = await ok<{ settings: { timezone: string } }>(page, 'GET', `/orgs/${ids.orgId}`);
    ids.orgZone = org.settings.timezone;

    // Any field of another table (UNKNOWN_FIELD: "of another table" is the same as missing).
    const tables = await ok<{ items: { id: string }[] }>(
      page,
      'GET',
      `/bases/${ids.baseId}/tables`,
    );
    const other = tables.items[0];
    if (other === undefined) throw new Error('The demo base has no table.');
    const otherFields = await ok<{ items: FieldDto[] }>(page, 'GET', `/tables/${other.id}/fields`);
    ids.otherTableField = otherFields.items[0]?.id ?? '';

    const table = await ok<{ id: string }>(page, 'POST', `/bases/${ids.baseId}/tables`, {
      name: TABLE_NAME,
    });
    ids.tableId = table.id;
    const create = (body: Record<string, unknown>) =>
      ok<FieldDto>(page, 'POST', `/tables/${table.id}/fields`, body);
    ids.due = (
      await create({ name: 'Due', type: 'datetime', options: { style: { format: 'dd/MM/yyyy' } } })
    ).id;
    ids.meeting = (
      await create({
        name: 'Meeting',
        type: 'datetime',
        options: { style: { format: 'yyyy-MM-dd HH:mm' }, timezone: 'Asia/Tokyo' },
      })
    ).id;
    ids.owner = (await create({ name: 'Owner', type: 'user' })).id;
    ids.reviewer = (await create({ name: 'Reviewer', type: 'user' })).id;
    ids.note = (await create({ name: 'Note', type: 'text' })).id;
    await ok(page, 'POST', `/tables/${table.id}/records?field_key_type=name`, {
      records: [{ fields: { Name: 'Hợp đồng A', Due: '2026-12-01' } }],
    });

    // A real account that is not a member of the demo organization.
    await sql(
      `INSERT INTO meta.users (id, email, display_name, password_hash)
       VALUES ($1, $2, $3, NULL) ON CONFLICT (id) DO NOTHING`,
      [OUTSIDER.id, OUTSIDER.email, OUTSIDER.name],
    );
    await context.close();
  });

  test('the admin sets "1 day before, 09:00" to Owner by keyboard; saved and reopened as it was', async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const { context, page } = await signedIn(browser, WORKER_ORG.email('admin'));
    const csp = collectCspViolations(page);
    await openGrid(page);
    await expect(header(page, 'Due')).toHaveAttribute('aria-label', 'Due, date');

    // Keyboard: a cell of Due, Shift+F10, the header menu's "Edit field".
    await headerMenuByKeyboard(page, 'Due');
    const edit = page.getByRole('menuitem', { name: 'Edit field' });
    await edit.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Edit field' });
    const section = dialog.getByTestId('reminder-section');
    await expect(section.getByRole('heading', { name: 'Reminder' })).toBeVisible();

    const enable = section.getByLabel('Remind people of this date');
    await enable.focus();
    await page.keyboard.press('Space');
    await expect(enable).toBeChecked();
    // Defaults: 1 day before; 09:00 in the field's zone (the organization's); the first person field.
    await expect(section.getByLabel('When to remind')).toHaveValue('before');
    await expect(section.getByLabel('How long')).toHaveValue('1');
    await expect(section.getByLabel('Unit')).toHaveValue('days');
    await expect(section.getByLabel('Time of day')).toHaveValue('09:00');
    await expect(section.getByLabel('Person field')).toHaveValue(ids.owner);
    await expect(
      section.getByText(`In the field's time zone: ${ids.orgZone} (the organization's)`),
    ).toBeVisible();
    await expect(section.getByTestId('reminder-preview')).toContainText(
      new RegExp(
        `A value of .+ is reminded on .+, 9:00\\sAM \\(${ids.orgZone.replace('/', '\\/')}\\)\\.`,
        'u',
      ),
    );
    await expect(section.getByTestId('reminder-note')).toHaveText(
      'Only people who can read the record, this field and, when it goes to a person field, that field too receive it. Reminders start when you turn this on: dates already passed are not reminded.',
    );

    // Tab order: checkbox → direction → amount → unit → time → radios.
    await page.keyboard.press('Tab');
    await expect(section.getByLabel('When to remind')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(section.getByLabel('How long')).toBeFocused();
    // Tab selects the text: typing replaces it; an empty amount is refused on save only.
    await page.keyboard.type('2');
    await expect(section.getByLabel('How long')).toHaveValue('2');
    await page.keyboard.press('Backspace');
    await page.keyboard.type('1');
    await expect(section.getByLabel('How long')).toHaveValue('1');
    await page.keyboard.press('Tab');
    await expect(section.getByLabel('Unit')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(section.getByLabel('Time of day')).toBeFocused();
    // An explicit 09:00 (the default is null = 09:00 too).
    await section.getByLabel('Time of day').selectOption('09:00');
    // Radios move with the arrow keys: members, then back to the field.
    await section.getByLabel('The people in a field').focus();
    await page.keyboard.press('ArrowDown');
    await expect(section.getByLabel(/Specific members/u)).toBeChecked();
    await page.keyboard.press('ArrowUp');
    await expect(section.getByLabel('The people in a field')).toBeChecked();
    await expect(section.getByLabel('Person field')).toHaveValue(ids.owner);
    await expectNoSeriousA11yViolations(page, 'field dialog with a reminder');
    await page.screenshot({ path: test.info().outputPath('t554-dialog.png') });

    // Enter in the amount saves the dialog (the form's submit).
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' && response.url().endsWith(`/fields/${ids.due}`),
    );
    await section.getByLabel('How long').focus();
    await page.keyboard.press('Enter');
    expect((await saved).status()).toBe(200);
    await expect(dialog).toBeHidden();
    expect(await reminderOf(page, ids.due)).toEqual({
      offset_minutes: -1440,
      time_of_day: '09:00',
      recipients: 'field_user',
      user_field_id: ids.owner,
    });

    // The header says it (accessible name; tip on hover).
    const label = 'Due, date, Reminder: 1 day before, at 09:00 · to the people in Owner';
    await expect(header(page, 'Due')).toHaveAttribute('aria-label', label);
    const box = await canvasBox(page);
    await page.mouse.move(box.x + columnCenter('Due') - 30, box.y + HEADER_HEIGHT / 2);
    await expect(
      page.getByRole('status').filter({ hasText: 'Reminder: 1 day before, at 09:00' }),
    ).toBeVisible();

    // Reopened as it was.
    await page.mouse.move(box.x + 10, box.y + 200);
    const again = await openFieldDialog(page, 'Due');
    const reopened = again.getByTestId('reminder-section');
    await expect(reopened.getByLabel('Remind people of this date')).toBeChecked();
    await expect(reopened.getByLabel('When to remind')).toHaveValue('before');
    await expect(reopened.getByLabel('How long')).toHaveValue('1');
    await expect(reopened.getByLabel('Unit')).toHaveValue('days');
    await expect(reopened.getByLabel('Time of day')).toHaveValue('09:00');
    await expect(reopened.getByLabel('Person field')).toHaveValue(ids.owner);
    // Nothing changed: Save sends nothing.
    let patched = false;
    page.on('request', (request) => {
      if (request.method() === 'PATCH' && request.url().endsWith(`/fields/${ids.due}`)) {
        patched = true;
      }
    });
    await again.getByRole('button', { name: 'Save' }).click();
    await expect(again).toBeHidden();
    expect(patched).toBe(false);
    expect(csp).toEqual([]);
    await context.close();
  });

  test('422 details land at their control (user_ids[i], user_field_id, time_of_day)', async ({
    browser,
  }) => {
    test.setTimeout(240_000);
    const { context, page } = await signedIn(browser, WORKER_ORG.email('admin'));
    // The member list offers someone outside the organization (as a stale list would).
    await page.route(`**/api/v1/orgs/${ids.orgId}/members**`, async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { items: unknown[]; total: number };
      body.items.push({
        user: {
          id: OUTSIDER.id,
          email: OUTSIDER.email,
          display_name: OUTSIDER.name,
          avatar_url: null,
        },
        role: 'member',
        joined_at: '2026-10-17T00:00:00.000Z',
      });
      body.total += 1;
      await route.fulfill({ response, json: body });
    });
    await openGrid(page);
    const dialog = await openFieldDialog(page, 'Meeting');
    const section = dialog.getByTestId('reminder-section');
    await section.getByLabel('Remind people of this date').check();
    // A field with a time: no time of day, counted from each value; the preview in its zone.
    await expect(section.getByLabel('Time of day')).toHaveCount(0);
    await expect(section.getByText('Counted from the time of each value.')).toBeVisible();
    await expect(section.getByTestId('reminder-preview')).toContainText('(Asia/Tokyo)');
    await section.getByLabel('When to remind').selectOption('before');
    await section.getByLabel('How long').fill('15');
    await section.getByLabel('Unit').selectOption('minutes');

    // user_ids[0]: not a member → named on its chip.
    await section.getByLabel(/Specific members/u).check();
    const select = section.getByLabel('Choose a member');
    await expect(select.locator(`option[value="${OUTSIDER.id}"]`)).toBeAttached();
    await select.selectOption(OUTSIDER.id);
    await select.press('Enter');
    await expect(section.getByTestId('reminder-member')).toHaveText(new RegExp(OUTSIDER.name, 'u'));
    const refused = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' &&
        response.url().endsWith(`/fields/${ids.meeting}`),
    );
    await dialog.getByRole('button', { name: 'Save' }).click();
    const answer = await refused;
    expect(answer.status()).toBe(422);
    expect(((await answer.json()) as { errors: { path: string; code: string }[] }).errors).toEqual([
      expect.objectContaining({ path: 'options.reminder.user_ids[0]', code: 'USER_NOT_FOUND' }),
    ]);
    await expect(
      section.getByText(`${OUTSIDER.name} is not a member of this organization.`),
    ).toBeVisible();
    await expect(section.getByTestId('reminder-member')).toHaveAttribute('data-invalid', 'true');
    await expect(dialog.getByText('Some settings need your attention.')).toBeVisible();
    await expect(dialog).toBeVisible();
    await expectNoSeriousA11yViolations(page, 'reminder with a refused member');
    expect(await reminderOf(page, ids.meeting)).toBeNull();
    await section.getByRole('button', { name: `Remove ${OUTSIDER.name}` }).click();
    await expect(section.getByText(/is not a member/u)).toHaveCount(0);

    // user_field_id: what the server is sent is rewritten (a stale client): a text field…
    await section.getByLabel('The people in a field').check();
    await expect(section.getByLabel('Person field')).toHaveValue(ids.owner);
    let rewrite: (reminder: Record<string, unknown>) => void = () => undefined;
    await page.route(`**/api/v1/fields/${ids.meeting}`, async (route) => {
      if (route.request().method() !== 'PATCH') {
        await route.fallback();
        return;
      }
      const body = route.request().postDataJSON() as {
        options: { reminder: Record<string, unknown> };
      };
      rewrite(body.options.reminder);
      await route.fallback({ postData: JSON.stringify(body) });
    });
    const save = async (status: number) => {
      const response = page.waitForResponse(
        (candidate) =>
          candidate.request().method() === 'PATCH' &&
          candidate.url().endsWith(`/fields/${ids.meeting}`),
      );
      await dialog.getByRole('button', { name: 'Save' }).click();
      expect((await response).status()).toBe(status);
    };
    rewrite = (reminder) => {
      reminder['user_field_id'] = ids.note;
    };
    await save(422);
    await expect(
      section.getByText(
        'This field is no longer a person field. Choose a User or Created by field.',
      ),
    ).toBeVisible();
    await expect(section.getByLabel('Person field')).toHaveAttribute('aria-invalid', 'true');

    // … then a field of another table (UNKNOWN_FIELD). Any change clears the old message.
    await section.getByLabel('Person field').selectOption(ids.reviewer);
    await expect(section.getByText(/no longer a person field/u)).toHaveCount(0);
    rewrite = (reminder) => {
      reminder['user_field_id'] = ids.otherTableField;
    };
    await save(422);
    await expect(
      section.getByText('This field no longer exists in the table. Choose another one.'),
    ).toBeVisible();

    // time_of_day on a field with a time.
    await section.getByLabel('Person field').selectOption(ids.owner);
    rewrite = (reminder) => {
      reminder['time_of_day'] = '09:00';
    };
    await save(422);
    const timeError = section.locator('p.text-danger').first();
    await expect(timeError).toBeVisible();
    expect((await timeError.textContent())?.trim()).not.toBe('');
    expect(await reminderOf(page, ids.meeting)).toBeNull();

    // Untouched by the route: saved.
    rewrite = () => undefined;
    await section.getByLabel('How long').fill('30');
    await save(200);
    await expect(dialog).toBeHidden();
    expect(await reminderOf(page, ids.meeting)).toEqual({
      offset_minutes: -30,
      time_of_day: null,
      recipients: 'field_user',
      user_field_id: ids.owner,
    });
    await context.close();
  });

  test('an editor and a reader cannot configure it, but read it on the header', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    for (const email of [EDITOR_EMAIL, READER_EMAIL]) {
      const { context, page } = await signedIn(browser, email);
      await openGrid(page);
      await expect(header(page, 'Due')).toHaveAttribute(
        'aria-label',
        /^Due, date(, read-only)?, Reminder: 1 day before, at 09:00 · to the people in Owner$/u,
      );
      const box = await canvasBox(page);
      await page.mouse.move(box.x + columnCenter('Due') - 30, box.y + HEADER_HEIGHT / 2);
      await expect(
        page.getByRole('status').filter({ hasText: 'Reminder: 1 day before, at 09:00' }),
      ).toBeVisible();
      // The header menu has no "Edit field" (FRONTEND §7), and the API refuses.
      await page.mouse.click(box.x + columnCenter('Due'), box.y + HEADER_HEIGHT / 2, {
        button: 'right',
      });
      await expect(page.getByRole('menuitem').first()).toBeVisible();
      await expect(page.getByRole('menuitem', { name: 'Edit field' })).toHaveCount(0);
      await page.keyboard.press('Escape');
      const refused = await api(page, 'PATCH', `/fields/${ids.due}`, {
        options: { reminder: null },
      });
      expect(refused.status).toBe(403);
      await expectNoSeriousA11yViolations(page, `grid of ${email} with a reminder header`);
      await context.close();
    }
  });

  test('the recipient field deleted: managers are warned, others learn nothing more', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const admin = await signedIn(browser, WORKER_ORG.email('admin'));
    await openGrid(admin.page);
    await ok(admin.page, 'DELETE', `/fields/${ids.owner}`);
    await expect(header(admin.page, 'Due')).toHaveAttribute(
      'aria-label',
      'Due, date, Reminder not sent: its recipient field was deleted or changed type. Edit the field to choose another one.',
    );
    const box = await canvasBox(admin.page);
    await admin.page.mouse.move(box.x + columnCenter('Due') - 30, box.y + HEADER_HEIGHT / 2);
    await expect(
      admin.page.getByRole('status').filter({ hasText: 'Reminder not sent' }),
    ).toBeVisible();
    await admin.page.mouse.move(box.x + 10, box.y + 200);
    const dialog = await openFieldDialog(admin.page, 'Due');
    const section = dialog.getByTestId('reminder-section');
    await expect(section.getByTestId('reminder-recipient-broken')).toHaveText(
      'The recipient field was deleted: this reminder is not sent. Choose another field.',
    );
    await expect(section.getByLabel('Person field')).toHaveValue(ids.owner);
    await expectNoSeriousA11yViolations(admin.page, 'reminder with a deleted recipient field');
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    const editor = await signedIn(browser, EDITOR_EMAIL);
    await openGrid(editor.page);
    await expect(header(editor.page, 'Due')).toHaveAttribute(
      'aria-label',
      /^Due, date(, read-only)?, Reminder: 1 day before, at 09:00 · to the people in a field$/u,
    );
    await editor.context.close();

    // Restored from the trash: the warning goes away.
    await ok(admin.page, 'POST', `/fields/${ids.owner}/restore`);
    await expect(header(admin.page, 'Due')).toHaveAttribute(
      'aria-label',
      'Due, date, Reminder: 1 day before, at 09:00 · to the people in Owner',
    );
    await admin.context.close();
  });

  test('phone (375 px) in Vietnamese: a new date field reminding members', async ({ browser }) => {
    test.setTimeout(180_000);
    const { context, page } = await signedIn(browser, WORKER_ORG.email('admin'), {
      viewport: { width: 375, height: 812 },
      language: 'vi',
    });
    await page.goto(`/b/${ids.baseId}/t/${ids.tableId}`);
    await page.getByRole('button', { name: 'Thêm thao tác' }).click();
    await page.getByRole('menuitem', { name: 'Thêm trường' }).click();
    const dialog = page.getByRole('dialog', { name: 'Trường mới' });
    await dialog.getByLabel('Tên', { exact: true }).fill(`Hạn chót ${RUN}`);
    await dialog.getByLabel('Kiểu trường').selectOption('datetime');
    const section = dialog.getByTestId('reminder-section');
    await expect(section.getByRole('heading', { name: 'Nhắc hạn' })).toBeVisible();
    await section.getByLabel('Nhắc mọi người về ngày này').check();
    await expect(
      section.getByText(`Theo múi giờ của trường: ${ids.orgZone} (của tổ chức)`),
    ).toBeVisible();
    await expect(section.getByTestId('reminder-note')).toHaveText(
      'Chỉ người đọc được bản ghi, trường này và (khi gửi người trong một trường) cả trường đó mới nhận. Nhắc từ lúc bật, không nhắc cho ngày đã qua.',
    );
    await section.getByLabel('Thời điểm nhắc').selectOption('at');
    await expect(section.getByLabel('Bao lâu')).toHaveCount(0);
    await section.getByLabel('Giờ trong ngày').selectOption('17:30');
    await section.getByLabel(/Thành viên cụ thể/u).check();
    await section.getByLabel('Chọn thành viên').selectOption(ids.adminId);
    const add = section.getByRole('button', { name: 'Thêm' });
    expect((await add.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await add.click();
    await expect(section.getByTestId('reminder-member')).toHaveCount(1);
    const remove = section.getByTestId('reminder-member').getByRole('button');
    expect((await remove.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    for (const radio of ['Người trong một trường', /Thành viên cụ thể/u] as const) {
      const label = section.locator('label').filter({ hasText: radio });
      expect((await label.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    }
    await expect(section.getByTestId('reminder-preview')).toContainText('17:30');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    const dialogOverflow = await dialog.evaluate(
      (element) => element.scrollWidth - element.clientWidth,
    );
    expect(dialogOverflow).toBeLessThanOrEqual(0);
    await expectNoSeriousA11yViolations(page, 'reminder at 375 px (vi)');
    await page.screenshot({ path: test.info().outputPath('t554-mobile-vi.png'), fullPage: true });

    const created = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().endsWith(`/tables/${ids.tableId}/fields`),
    );
    await dialog.getByRole('button', { name: 'Tạo trường' }).click();
    const response = await created;
    expect(response.status()).toBe(201);
    const field = (await response.json()) as FieldDto;
    expect(field.options['reminder']).toEqual({
      offset_minutes: 0,
      time_of_day: '17:30',
      recipients: 'users',
      user_ids: [ids.adminId],
    });
    await context.close();
  });
});
