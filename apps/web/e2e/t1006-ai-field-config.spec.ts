import { mkdirSync } from 'node:fs';

import { type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';

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
 * T1006 (CONTRACTS §29.5, FRONTEND §4.10): the configuration of an AI field
 * is for table managers who read every field of its prompt. In a base of
 * its own (Tickets: Tiêu đề, Mô tả, Ghi chú nội bộ; "Summary" reads the last
 * two, with instructions):
 *
 * - u_editor (base editor, no schema rights) opens the AI field — the grid,
 *   its column menu, Enter on a cell, the record panel: the cells are
 *   read-only, no prompt or instructions anywhere (page or API answers),
 *   no error;
 * - u_editor as a table manager who cannot read "Ghi chú nội bộ" opens
 *   "Edit field": "Configured by a table manager", none of the settings, no
 *   error; Vietnamese, dark, 375 px;
 * - u_admin still edits the whole configuration (the manager flow of t915).
 *
 * Screenshots for the review only with `T1006_SHOTS=<dir>`.
 */

test.use({ timezoneId: 'Asia/Ho_Chi_Minh' });

const RUN = Date.now().toString(36);
const SHOTS = process.env['T1006_SHOTS'];
const ADMIN_EMAIL = WORKER_ORG.email('admin');
const EDITOR_EMAIL = WORKER_ORG.email('editor');
/** Words of the prompt and instructions: never on a page or in an answer of u_editor. */
const PROMPT_MARK = 'PROMPTMARK1006';
const INSTRUCTIONS_MARK = 'INSTRMARK1006';
const PROMPT = `${PROMPT_MARK} tóm tắt: {{ [Mô tả] }} — {{ [Ghi chú nội bộ] }}`;
const INSTRUCTIONS = `${INSTRUCTIONS_MARK}: một câu, không nêu tên khách.`;

const fx = {
  orgId: '',
  baseId: '',
  tickets: '',
  secret: '',
  summary: '',
  editorId: '',
  records: [] as string[],
};

type Cookies = Awaited<ReturnType<BrowserContext['cookies']>>;
const cookies: Record<string, Cookies> = {};

/** A context signed in as `email` (once per user and spec: 20 sign-ins a minute per IP). */
async function openAs(
  browser: Browser,
  email: string,
  options: {
    viewport?: { width: number; height: number };
    language?: 'en' | 'vi';
    colorScheme?: 'light' | 'dark';
  } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'Asia/Ho_Chi_Minh',
    colorScheme: options.colorScheme ?? 'light',
  });
  await context.addInitScript((language) => {
    window.localStorage.setItem('cellhive.language', language);
  }, options.language ?? 'en');
  const page = await context.newPage();
  await page.goto('/login');
  const saved = cookies[email];
  if (saved === undefined) {
    await apiSignIn(page, email, DEMO_PASSWORD);
    cookies[email] = await context.cookies();
  } else {
    await context.addCookies(saved);
  }
  return { context, page };
}

/** The same state at 1440 and 375 px, light and dark (the review only). */
async function shots(page: Page, name: string) {
  if (SHOTS === undefined) return;
  mkdirSync(SHOTS, { recursive: true });
  for (const [width, height] of [
    [1440, 900],
    [375, 812],
  ] as const) {
    await page.setViewportSize({ width, height });
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await animationsSettled(page);
      await page.screenshot({ path: `${SHOTS}/${name}-${String(width)}-${colorScheme}.png` });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
}

function cells(page: Page) {
  return page.locator('table[role="grid"] td[role="gridcell"]');
}

function header(page: Page, name: string) {
  return page.locator('table[role="grid"] th[role="columnheader"]', { hasText: name });
}

async function openGrid(page: Page) {
  await page.goto(`/b/${fx.baseId}/t/${fx.tickets}`);
  await expect(cells(page).first()).toBeAttached();
}

const ROW_MARKER_WIDTH = 48;
const HEADER_HEIGHT = 36;
const ROW_HEIGHT = 34;

function selectedColumn(page: Page): Promise<number> {
  return page
    .locator('table[role="grid"] td[role="gridcell"][aria-selected="true"]')
    .first()
    .getAttribute('aria-colindex')
    .then((value) => Number(value ?? '0'));
}

/** Selects the cell of column `name` in the first data row with the keyboard (as t915). */
async function selectCell(page: Page, name: string): Promise<void> {
  const canvas = page.locator('.ob-grid [data-testid="data-grid-canvas"]');
  const box = await canvas.boundingBox();
  if (box === null) throw new Error('grid not laid out');
  await page.mouse.click(box.x + ROW_MARKER_WIDTH + 24, box.y + HEADER_HEIGHT + ROW_HEIGHT / 2);
  await expect.poll(() => selectedColumn(page), { timeout: 5_000 }).toBe(1);
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.closest('.ob-grid') != null), {
      timeout: 5_000,
    })
    .toBe(true);
  for (let step = 0; step < 20; step += 1) {
    const target = Number(await header(page, name).getAttribute('aria-colindex'));
    const current = await selectedColumn(page);
    if (current === target) return;
    await page.keyboard.press(current > target ? 'ArrowLeft' : 'ArrowRight');
    await expect.poll(() => selectedColumn(page), { timeout: 5_000 }).not.toBe(current);
  }
  throw new Error(`column ${name} not reached`);
}

/** The column menu of `name`: Shift+F10 on one of its cells (the keyboard way). */
async function columnMenu(page: Page, name: string, label = 'Field menu'): Promise<Locator> {
  const menu = page.getByRole('menu', { name: `${label}: ${name}` });
  await expect(async () => {
    if ((await page.getByRole('menu').count()) > 0) {
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menu')).toHaveCount(0, { timeout: 2_000 });
    }
    await selectCell(page, name);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => {
            resolve();
          });
        }),
    );
    await page.keyboard.press('Shift+F10');
    await expect(menu).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  return menu;
}

/** Every answer of the API to `page`, as text (no prompt word may be in one). */
function collectApiBodies(page: Page): Promise<string>[] {
  const bodies: Promise<string>[] = [];
  page.on('response', (response) => {
    if (!response.url().includes('/api/v1/')) return;
    bodies.push(response.text().catch(() => ''));
  });
  return bodies;
}

async function expectNoConfig(page: Page, bodies: readonly Promise<string>[]) {
  const texts = await Promise.all(bodies);
  expect(texts.length).toBeGreaterThan(0);
  for (const mark of [PROMPT_MARK, INSTRUCTIONS_MARK]) {
    await expect(page.locator('body')).not.toContainText(mark);
    expect(
      texts.some((text) => text.includes(mark)),
      `an API answer holds ${mark}`,
    ).toBe(false);
  }
}

/** u_editor's role on the base: the system editor role, or one of this spec's. */
async function setEditorRole(page: Page, roleId: string) {
  await ok(page, 'PUT', `/bases/${fx.baseId}/role-assignments`, {
    principal_type: 'user',
    principal_id: fx.editorId,
    role_id: roleId,
  });
}

async function buildFixture(page: Page): Promise<void> {
  const me = await ok<{ orgs: { id: string; name: string }[] }>(page, 'GET', '/me');
  fx.orgId = me.orgs.find((org) => org.name === WORKER_ORG.orgName)?.id ?? '';
  const workspace = await ok<{ id: string }>(page, 'POST', `/orgs/${fx.orgId}/workspaces`, {
    name: `T1006 ${RUN}`,
  });
  const base = await ok<{ id: string }>(page, 'POST', `/workspaces/${workspace.id}/bases`, {
    name: `AI config T1006 ${RUN}`,
  });
  fx.baseId = base.id;
  const tickets = await ok<{ id: string; primary_field_id: string }>(
    page,
    'POST',
    `/bases/${base.id}/tables`,
    { name: 'Tickets', primary_field_name: 'Tiêu đề' },
  );
  fx.tickets = tickets.id;
  const add = async (name: string) =>
    (await ok<{ id: string }>(page, 'POST', `/tables/${tickets.id}/fields`, { name, type: 'text' }))
      .id;
  const description = await add('Mô tả');
  fx.secret = await add('Ghi chú nội bộ');
  const created = await ok<{ records: { id: string }[] }>(
    page,
    'POST',
    `/tables/${tickets.id}/records?field_key_type=id`,
    {
      records: [
        { fields: { [tickets.primary_field_id]: 'Máy in quầy 2 lỗi', [description]: 'Đèn đỏ' } },
        { fields: { [tickets.primary_field_id]: 'Wi-Fi chập chờn', [description]: 'Tầng 3' } },
      ],
    },
  );
  fx.records = created.records.map((record) => record.id);
  // An AI field needs record values allowed when saved (CONTRACTS §29.5); off again right after.
  await ok(page, 'PUT', `/orgs/${fx.orgId}/ai-settings`, {
    allow_record_data: true,
    confirm: true,
  });
  try {
    fx.summary = (
      await ok<{ id: string }>(page, 'POST', `/tables/${tickets.id}/fields`, {
        name: 'Summary',
        type: 'text',
        options: {
          ai: { task: 'summarize', prompt: PROMPT, instructions: INSTRUCTIONS, auto_update: false },
        },
      })
    ).id;
  } finally {
    await ok(page, 'PUT', `/orgs/${fx.orgId}/ai-settings`, { allow_record_data: false });
  }
  const principals = await ok<{ items: { principal_id: string; email: string | null }[] }>(
    page,
    'GET',
    `/bases/${base.id}/principals?limit=200`,
  );
  fx.editorId = principals.items.find((item) => item.email === EDITOR_EMAIL)?.principal_id ?? '';
  const roles = await ok<{ items: { id: string; kind: string }[] }>(
    page,
    'GET',
    `/bases/${base.id}/roles`,
  );
  await setEditorRole(page, roles.items.find((role) => role.kind === 'system_editor')?.id ?? '');
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  const { context, page } = await openAs(browser, ADMIN_EMAIL);
  await buildFixture(page);
  await context.close();
});

test.afterAll(async ({ browser }) => {
  const { context, page } = await openAs(browser, ADMIN_EMAIL);
  if (fx.baseId !== '') await api(page, 'DELETE', `/bases/${fx.baseId}`);
  await context.close();
});

test('u_editor opens the AI field: read-only, no prompt anywhere, no error', async ({
  browser,
}) => {
  const { context, page } = await openAs(browser, EDITOR_EMAIL);
  const bodies = collectApiBodies(page);
  const csp = collectCspViolations(page);
  await openGrid(page);

  await test.step('the column menu has no "Edit field"', async () => {
    const menu = await columnMenu(page, 'Summary');
    await expect(menu.getByRole('menuitem', { name: 'Sort ascending' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Edit field' })).toHaveCount(0);
    await page.keyboard.press('Escape');
  });

  await test.step('Enter on a cell says AI fills it', async () => {
    await selectCell(page, 'Summary');
    await page.keyboard.press('Enter');
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: 'AI fills this field: it cannot be edited by hand.' }),
    ).toBeVisible();
    await expect(page.locator('#portal input, #portal textarea')).toHaveCount(0);
  });

  await test.step('the record panel shows the field read-only', async () => {
    await page.goto(`/b/${fx.baseId}/t/${fx.tickets}?record=${fx.records[0] ?? ''}`);
    const panel = page.getByRole('dialog');
    await expect(panel.getByText('Summary', { exact: true })).toBeVisible();
    await expectNoSeriousA11yViolations(page, 'record panel, AI field without its configuration');
    await shots(page, 'editor-record-panel');
  });

  await expectNoConfig(page, bodies);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(csp).toEqual([]);
  await context.close();
});

test('a table manager who cannot read a field of the prompt: "Configured by a table manager"', async ({
  browser,
}) => {
  const admin = await openAs(browser, ADMIN_EMAIL);
  const role = await ok<{ id: string }>(admin.page, 'POST', `/bases/${fx.baseId}/roles`, {
    name: `Manages Tickets ${RUN}`,
    config: {
      tables: {
        [fx.tickets]: {
          perm: 'manage',
          field_rule: { mode: 'specify', fields: { [fx.secret]: 'no_perm' } },
        },
      },
    },
  });
  await setEditorRole(admin.page, role.id);
  await admin.context.close();

  for (const variant of [
    {
      language: 'en',
      title: 'Configured by a table manager',
      menu: 'Field menu',
      edit: 'Edit field',
    },
    { language: 'vi', title: 'Do người quản lý cấu hình', menu: 'Menu trường', edit: 'Sửa trường' },
  ] as const) {
    // Dark in Vietnamese; the dialog opens from the 1440 px grid (below 768 px it is a list of
    // cards), then is checked at 375 px.
    const { context, page } = await openAs(browser, EDITOR_EMAIL, {
      language: variant.language,
      colorScheme: variant.language === 'vi' ? 'dark' : 'light',
    });
    const bodies = collectApiBodies(page);
    await openGrid(page);
    await test.step(`${variant.language}: "Edit field" opens no AI settings`, async () => {
      const menu = await columnMenu(page, 'Summary', variant.menu);
      await menu.getByRole('menuitem', { name: variant.edit }).click();
      const dialog = page.getByRole('dialog');
      const notice = dialog.getByTestId('ai-config-hidden');
      await expect(notice.getByRole('heading', { name: variant.title })).toBeVisible();
      for (const id of ['ai-field-section', 'ai-prompt', 'ai-preview', 'ai-remove']) {
        await expect(dialog.getByTestId(id)).toHaveCount(0);
      }
      await expect(dialog.getByTestId('type-locked')).toBeVisible();
      await expect(dialog.getByRole('alert')).toHaveCount(0);
      if (variant.language === 'vi') await page.setViewportSize({ width: 375, height: 812 });
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
        .toBeLessThanOrEqual(page.viewportSize()?.width ?? 1440);
      await expectNoSeriousA11yViolations(
        page,
        `AI field configured by a manager (${variant.language})`,
      );
      await shots(page, `manager-locked-dialog-${variant.language}`);
      await expectNoConfig(page, bodies);
    });
    await context.close();
  }

  // Back to the system editor role for the next tests.
  const back = await openAs(browser, ADMIN_EMAIL);
  const roles = await ok<{ items: { id: string; kind: string }[] }>(
    back.page,
    'GET',
    `/bases/${fx.baseId}/roles`,
  );
  await setEditorRole(
    back.page,
    roles.items.find((item) => item.kind === 'system_editor')?.id ?? '',
  );
  await back.context.close();
});

test('u_admin still edits the whole configuration', async ({ browser }) => {
  const { context, page } = await openAs(browser, ADMIN_EMAIL);
  await openGrid(page);
  const menu = await columnMenu(page, 'Summary');
  await menu.getByRole('menuitem', { name: 'Edit field' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByTestId('ai-field-section')).toBeVisible();
  await expect(dialog.getByTestId('ai-config-hidden')).toHaveCount(0);
  await expect(dialog.getByTestId('ai-prompt')).toContainText(PROMPT_MARK);
  await shots(page, 'admin-dialog');
  await context.close();
});
