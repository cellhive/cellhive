import { type Browser, type BrowserContext, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { DEMO_ORDER_TITLE, DEMO_PASSWORD } from './seed';
import { apiSignIn, collectCspViolations, expectNoSeriousA11yViolations, ok } from './support';

/**
 * T525: button fields (boards "S5 · Button field", "… - cấu hình",
 * "… - 375 px"; ADR-32 §2, CONTRACTS §2, §21) on the demo Orders table with
 * the real API and worker:
 * - the admin creates the button "Duyệt nhanh" with a confirmation, opens
 *   the builder from the field dialog (trigger prefilled), adds
 *   `enabled_when` status = A and a step status → B, turns it on;
 * - in the grid, Enter on the cell asks to confirm (Escape sends nothing),
 *   confirming runs it: the status changes and a toast says so
 *   (`automation.run.finished`); the button is then disabled by its
 *   condition;
 * - u_reader sees the `edit` button disabled for permission;
 * - a share link shows it disabled and never calls the click route;
 * - phones (375 px): a 44 px button, the confirmation is a bottom sheet.
 */

const RUN = String(Date.now()).slice(-6);
const DEMO_BASE = 'Chăm sóc khách hàng';
const READER_EMAIL = WORKER_ORG.email('reader');
const BUTTON_NAME = `Duyệt nhanh ${RUN}`;
const ROW_MARKER_WIDTH = 48;
const HEADER_HEIGHT = 36;
const ROW_HEIGHT = 34;

interface Field {
  id: string;
  name: string;
  type: string;
  options: { options?: { id: string; name: string }[] };
}

interface Demo {
  baseId: string;
  orders: string;
  viewId: string;
  status: Field;
  /** `enabled_when` holds on A; the automation sets B. */
  optionA: string;
  optionB: string;
  /** The first rows of the default view: [id, title]. */
  rows: { id: string; title: string }[];
}

/** A `cell_format=text` value (a string, or nothing). */
function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

async function openAs(
  browser: Browser,
  email: string,
  viewport = { width: 1440, height: 900 },
  language: 'en' | 'vi' = 'en',
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport,
    locale: language === 'vi' ? 'vi-VN' : 'en-US',
  });
  await context.addInitScript((lang) => {
    window.localStorage.setItem('cellhive.language', lang);
  }, language);
  const page = await context.newPage();
  await page.goto('/login');
  await apiSignIn(page, email, DEMO_PASSWORD);
  return { context, page };
}

async function findDemo(page: Page): Promise<Demo> {
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
      if (base === undefined) continue;
      const tables = await ok<{ items: { id: string; name: string }[] }>(
        page,
        'GET',
        `/bases/${base.id}/tables`,
      );
      const orders = tables.items.find((table) => table.name === 'Orders')?.id ?? '';
      const fields = await ok<{ items: Field[] }>(page, 'GET', `/tables/${orders}/fields`);
      const status = fields.items.find((field) => field.name === 'status');
      if (status === undefined) throw new Error('Orders has no status field');
      const options = status.options.options ?? [];
      const views = await ok<{ items: { id: string; type: string }[] }>(
        page,
        'GET',
        `/tables/${orders}/views`,
      );
      const viewId = views.items.find((view) => view.type === 'grid')?.id ?? '';
      const first = await ok<{ records: { id: string; fields: Record<string, unknown> }[] }>(
        page,
        'POST',
        `/tables/${orders}/records/query?field_key_type=name&cell_format=text`,
        { view_id: viewId, offset: 0, limit: 3 },
      );
      return {
        baseId: base.id,
        orders,
        viewId,
        status,
        optionA: options[0]?.name ?? '',
        optionB: options.find((option) => option.name === 'Xong')?.name ?? options[1]?.name ?? '',
        rows: first.records.map((item) => ({
          id: item.id,
          title: textOf(item.fields[DEMO_ORDER_TITLE]),
        })),
      };
    }
  }
  throw new Error('demo base not found');
}

/** Sets the status of a record by option name (`typecast`). */
async function setStatus(page: Page, demo: Demo, recordId: string, option: string) {
  const current = await ok<{ version: number }>(
    page,
    'GET',
    `/tables/${demo.orders}/records/${recordId}`,
  );
  await ok(page, 'PATCH', `/tables/${demo.orders}/records?typecast=true&field_key_type=id`, {
    records: [{ id: recordId, version: current.version, fields: { [demo.status.id]: option } }],
  });
}

async function statusOf(page: Page, demo: Demo, recordId: string): Promise<string> {
  const answer = await ok<{ fields: Record<string, unknown> }>(
    page,
    'GET',
    `/tables/${demo.orders}/records/${recordId}?cell_format=text&field_key_type=id`,
  );
  return textOf(answer.fields[demo.status.id]);
}

function header(page: Page, name: string) {
  return page.locator('table[role="grid"] th[role="columnheader"]', { hasText: name });
}

function cell(page: Page, column: number, row = 0) {
  return page.getByTestId(`glide-cell-${String(column)}-${String(row)}`);
}

async function openGrid(page: Page, demo: Demo, search = '') {
  await page.goto(`/b/${demo.baseId}/t/${demo.orders}/v/${demo.viewId}${search}`);
  await expect(page.locator('table[role="grid"] td[role="gridcell"]').first()).toBeAttached();
}

/** Selects the cell of `name` in data row `row` with the keyboard; returns its a11y column. */
async function selectCell(page: Page, name: string, row = 0): Promise<number> {
  const canvas = page.locator('.ob-grid [data-testid="data-grid-canvas"]');
  const box = await canvas.boundingBox();
  if (box === null) throw new Error('grid not laid out');
  await page.mouse.click(
    box.x + ROW_MARKER_WIDTH + 24,
    box.y + HEADER_HEIGHT + ROW_HEIGHT * row + ROW_HEIGHT / 2,
  );
  await expect(cell(page, 1, row)).toHaveAttribute('aria-selected', 'true');
  const selectedColumn = async () =>
    Number(
      (await page
        .locator('table[role="grid"] td[role="gridcell"][aria-selected="true"]')
        .first()
        .getAttribute('aria-colindex')) ?? '0',
    );
  for (let step = 0; step < 120; step += 1) {
    const found = await header(page, name).count();
    const target =
      found === 0 ? null : Number(await header(page, name).getAttribute('aria-colindex'));
    const current = await selectedColumn();
    if (target !== null && current === target) return target;
    const key = target !== null && current > target ? 'ArrowLeft' : 'ArrowRight';
    await page.keyboard.press(key);
    await expect.poll(selectedColumn).not.toBe(current);
  }
  throw new Error(`column ${name} not reached`);
}

test.describe.configure({ mode: 'serial' });

let demo: Demo;
let buttonId = '';

test.beforeAll(async ({ browser }) => {
  const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
  demo = await findDemo(page);
  for (const row of demo.rows) await setStatus(page, demo, row.id, demo.optionA);
  await context.close();
});

test('creates the button and its automation, then runs it from the grid', async ({ browser }) => {
  const { context, page } = await openAs(browser, WORKER_ORG.email('admin'));
  const csp = collectCspViolations(page);
  await openGrid(page, demo);

  // The field dialog (board "S5 · Button field - cấu hình").
  await page.getByRole('button', { name: 'Add field' }).click();
  const dialog = page.getByRole('dialog', { name: 'New field' });
  await dialog.getByLabel('Name', { exact: true }).fill(BUTTON_NAME);
  await dialog.getByLabel('Field type').selectOption('button');
  const options = dialog.getByTestId('button-options');
  await options.getByRole('radio', { name: 'Jade' }).check();
  await options.getByLabel('Ask before running').check();
  await expect(options.getByLabel('Title')).toHaveValue(`${BUTTON_NAME}?`);
  await expect(dialog.getByText('No automation attached')).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'button field dialog');
  // A new button: saved first, then the builder opens on it.
  await dialog.getByTestId('button-create-automation').click();
  await expect(page).toHaveURL(/\/automations\/new\?/u);
  const fields = await ok<{ items: Field[] }>(page, 'GET', `/tables/${demo.orders}/fields`);
  buttonId = fields.items.find((field) => field.name === BUTTON_NAME)?.id ?? '';
  expect(buttonId).toMatch(/^fld_/u);

  // The builder: trigger prefilled; enabled when status = A; a step sets B.
  const trigger = page.getByTestId('button-trigger');
  await expect(trigger.getByTestId('trigger-button-field')).toHaveValue(buttonId);
  await expect(
    trigger.getByRole('radio', { name: /People who can edit the record/u }),
  ).toBeChecked();
  await trigger.getByRole('button', { name: 'Add condition' }).click();
  await trigger.getByLabel('Field').selectOption({ label: 'status' });
  await trigger.getByLabel('Value for status').selectOption({ label: demo.optionA });
  await page.getByTestId('add-step').click();
  await page.getByTestId('add-update_record').click();
  const panel = page.getByTestId('config-panel');
  await panel.getByTestId('field-map-add').selectOption({ label: 'status' });
  await panel.getByLabel('Value of status', { exact: true }).selectOption({ label: demo.optionB });
  await expectNoSeriousA11yViolations(page, 'builder with the button trigger');
  await page.keyboard.press('Control+s');
  await expect(page).toHaveURL(/\/automations\/aut_/u);
  await page.getByTestId('builder-enabled').click();
  await expect(page.getByTestId('builder-enabled')).toBeChecked();

  // The grid: Enter on the cell asks first; Escape sends nothing.
  const row = demo.rows[0];
  if (row === undefined) throw new Error('no order');
  await openGrid(page, demo);
  const column = await selectCell(page, BUTTON_NAME, 0);
  await expect(cell(page, column, 0)).toContainText(`${BUTTON_NAME}, available`);
  const clicks: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/buttons/')) clicks.push(request.url());
  });
  await page.keyboard.press('Enter');
  const confirm = page.getByRole('alertdialog', { name: `${BUTTON_NAME}?` });
  await expect(confirm).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'button confirmation');
  await page.keyboard.press('Escape');
  await expect(confirm).toBeHidden();
  expect(clicks).toHaveLength(0);

  await selectCell(page, BUTTON_NAME, 0);
  await page.keyboard.press('Enter');
  const accepted = page.waitForResponse((response) => response.url().includes('/buttons/'));
  await confirm.getByRole('button', { name: BUTTON_NAME }).click();
  const { run_id: runId } = (await (await accepted).json()) as { run_id: string };
  // The run ends (worker, behind the seed's background jobs): the status changes, then the toast.
  await expect
    .poll(
      async () => (await ok<{ status: string }>(page, 'GET', `/automation-runs/${runId}`)).status,
      { timeout: 60_000 },
    )
    .toBe('succeeded');
  expect(await statusOf(page, demo, row.id)).toBe(demo.optionB);
  await expect(page.getByText(`«${BUTTON_NAME}» finished for ${row.title}.`)).toBeVisible();
  await expect(page.getByRole('button', { name: 'View run' })).toBeVisible();
  expect(clicks).toHaveLength(1);
  // Its condition no longer holds: the cell is read again, disabled.
  await expect(cell(page, column, 0)).toContainText(`${BUTTON_NAME}, unavailable`, {
    timeout: 10_000,
  });

  // The record panel says why.
  await openGrid(page, demo, `?record=${row.id}`);
  const recordPanel = page.getByRole('dialog', { name: new RegExp(row.title, 'u') });
  // The demo seed has its own "Duyệt nhanh" button on Orders (T519): this spec's one by name.
  const disabled = recordPanel.getByTestId('record-button').filter({ hasText: BUTTON_NAME });
  await expect(disabled).toHaveAttribute('aria-disabled', 'true');
  await expect(disabled).toHaveAccessibleDescription(
    "This record does not meet the button's condition.",
  );
  expect(csp).toEqual([]);
  await context.close();
});

test('a reader sees an edit button disabled for permission', async ({ browser }) => {
  const { context, page } = await openAs(browser, READER_EMAIL);
  const row = demo.rows[1];
  if (row === undefined) throw new Error('no order');
  await openGrid(page, demo, `?record=${row.id}`);
  const button = page
    .getByRole('dialog', { name: new RegExp(row.title, 'u') })
    .getByTestId('record-button')
    .filter({ hasText: BUTTON_NAME });
  await expect(button).toHaveAttribute('aria-disabled', 'true');
  await expect(button).toHaveAccessibleDescription(
    'You need permission to edit this record to use this button.',
  );
  let clicked = false;
  page.on('request', (request) => {
    if (request.url().includes('/buttons/')) clicked = true;
  });
  // `aria-disabled` keeps it focusable for its reason; a click does nothing.
  await button.click({ force: true });
  expect(clicked).toBe(false);
  await expectNoSeriousA11yViolations(page, 'record panel with a disabled button');
  await context.close();
});

test('a share link shows the button disabled and never runs it', async ({ browser }) => {
  const admin = await openAs(browser, WORKER_ORG.email('admin'));
  // The title and the button only (the grid's accessible table holds the columns in sight).
  const fields = await ok<{ items: (Field & { is_primary: boolean })[] }>(
    admin.page,
    'GET',
    `/tables/${demo.orders}/fields`,
  );
  const view = await ok<{ id: string }>(admin.page, 'POST', `/tables/${demo.orders}/views`, {
    name: `Nút ${RUN}`,
    type: 'grid',
    config: {
      hidden_fields: fields.items
        .filter((field) => !field.is_primary && field.id !== buttonId)
        .map((field) => field.id),
    },
  });
  const link = await ok<{ token: string }>(admin.page, 'POST', `/views/${view.id}/share-links`, {
    audience: 'public',
  });
  await admin.context.close();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const clicks: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/buttons/')) clicks.push(request.url());
  });
  await page.goto(`/s/${link.token}`);
  await expect(page.locator('table[role="grid"] td[role="gridcell"]').first()).toBeAttached();
  await expect(
    page.locator('table[role="grid"] td[role="gridcell"]', {
      hasText: `${BUTTON_NAME}, unavailable`,
    }),
  ).not.toHaveCount(0);
  await expect(
    page.locator('table[role="grid"] td[role="gridcell"]', {
      hasText: `${BUTTON_NAME}, available`,
    }),
  ).toHaveCount(0);
  // Enter on the cell says where buttons run; nothing is sent.
  await selectCell(page, BUTTON_NAME, 0);
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('status').filter({ hasText: 'Open this record in Cellhive to use the button.' }),
  ).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'share page with a button');
  expect(clicks).toEqual([]);
  await context.close();
});

test('phones (vi): a 44 px button, the confirmation is a bottom sheet', async ({ browser }) => {
  const { context, page } = await openAs(
    browser,
    WORKER_ORG.email('admin'),
    { width: 375, height: 812 },
    'vi',
  );
  const row = demo.rows[2];
  if (row === undefined) throw new Error('no order');
  // Below 768 px the records are a card list; the record opens full screen.
  await page.goto(`/b/${demo.baseId}/t/${demo.orders}/v/${demo.viewId}?record=${row.id}`);
  const button = page.getByTestId('record-button').filter({ hasText: BUTTON_NAME });
  await expect(button).toHaveAttribute('data-state', 'ready');
  await expect(button).toHaveAccessibleName(BUTTON_NAME);
  const box = await button.boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(44);
  await button.click();
  const sheet = page.getByRole('alertdialog', { name: `${BUTTON_NAME}?` });
  await expect(sheet).toBeVisible();
  await expect
    .poll(async () => {
      const rect = await sheet.boundingBox();
      return rect === null ? null : [Math.round(rect.width), Math.round(rect.y + rect.height)];
    })
    .toEqual([375, 812]);
  const run = sheet.getByRole('button', { name: BUTTON_NAME });
  expect((await run.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await expectNoSeriousA11yViolations(page, 'button confirmation on a phone');
  await sheet.getByRole('button', { name: 'Huỷ' }).click();
  await expect(sheet).toBeHidden();
  await expect(button).toHaveAttribute('data-state', 'ready');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await context.close();
});
