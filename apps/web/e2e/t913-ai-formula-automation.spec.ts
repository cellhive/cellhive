import { mkdirSync } from 'node:fs';

import { type Browser, type BrowserContext, type Page } from '@playwright/test';

import { FAKE_LLM_MODEL, fakeLlmBaseUrl, startOwnFakeLlm, type FakeLlm } from './fake-llm';
import { expect, test, WORKER_ORG } from './fixtures';
import { DEMO_PASSWORD } from './seed';
import {
  animationsSettled,
  apiSignIn,
  collectCspViolations,
  expectNoSeriousA11yViolations,
  ok,
} from './support';

/**
 * T913: "Describe the formula" in the formula editor and "Create with AI" in
 * the automation list (CONTRACTS §29.2–§29.3) against a fake provider of this
 * spec's own (`startOwnFakeLlm`: the shared one's script queue is shared by
 * both workers), the worker's demo organization pointed at it while the spec
 * runs:
 *
 * - a formula wrong on the first try → the correct suggestion after one
 *   repair round ("Written in 2 tries") → "Use" → the editor's preview;
 * - the S8 milestone sentence (BACKLOG S8 decision #6) → the builder, unsaved,
 *   "When a record is updated" · Trạng thái → Đã xong and "Send notification"
 *   · Phụ trách, the switch off → "Create" → the list shows it off;
 * - the dialog's wait ("Cancel") and error; Vietnamese, dark, 375 px.
 *
 * axe on every state. AI off hides every entry: `t912-ai-settings.spec.ts`
 * (the walk of the screens). Screenshots for the design report only with
 * `T913_SHOTS=<dir>`.
 */

const RUN = String(Date.now()).slice(-6);
const SHOTS = process.env['T913_SHOTS'];
const ADMIN_EMAIL = WORKER_ORG.email('admin');
const MILESTONE = 'Khi ticket chuyển DONE thì gửi Telegram cho người phụ trách';
const EXPLANATION = 'Gửi qua kênh thông báo của người nhận (Telegram nếu đã liên kết).';

/** The milestone draft as the model writes it: by name, flat (CONTRACTS §29.3). */
function milestoneDraft(name: string) {
  const unused = {
    table: null,
    fields: null,
    recipients: null,
    title: null,
    text: null,
    bot: null,
    chat_id: null,
    chat_field: null,
    minutes: null,
  };
  return {
    name,
    trigger: {
      type: 'record.updated',
      table: 'Tickets',
      watch_fields: ['Trạng thái'],
      changed_to: 'Đã xong',
      form: null,
      cron: null,
      date_field: null,
      offset_minutes: null,
    },
    condition: null,
    actions: [
      {
        ...unused,
        type: 'send_notification',
        recipients: ['Phụ trách'],
        title: 'Ticket {{ [Tiêu đề] }} đã xong',
        text: '',
      },
    ],
    explanation: EXPLANATION,
    warnings: [
      { code: 'ambiguous', message: '"DONE" được hiểu là lựa chọn "Đã xong" của Trạng thái.' },
    ],
  };
}

let fake: FakeLlm;
const demo = { orgId: '', baseId: '', tickets: '', allowlistId: '' };

async function openAs(
  browser: Browser,
  options: {
    viewport?: { width: number; height: number };
    language?: 'en' | 'vi';
    colorScheme?: 'light' | 'dark';
    /** A directory: the context is filmed (frames of the design report). */
    video?: string;
  } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const viewport = options.viewport ?? { width: 1440, height: 900 };
  const context = await browser.newContext({
    viewport,
    locale: 'en-US',
    colorScheme: options.colorScheme ?? 'light',
    ...(options.video === undefined ? {} : { recordVideo: { dir: options.video, size: viewport } }),
  });
  await context.addInitScript((language) => {
    window.localStorage.setItem('cellhive.language', language);
  }, options.language ?? 'en');
  const page = await context.newPage();
  await page.goto('/login');
  await apiSignIn(page, ADMIN_EMAIL, DEMO_PASSWORD);
  return { context, page };
}

async function shot(page: Page, name: string) {
  if (SHOTS === undefined) return;
  await animationsSettled(page);
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/** The same state at 1440 and 375 px, light and dark (the design report). */
async function shots(page: Page, name: string) {
  if (SHOTS === undefined) return;
  for (const [width, height] of [
    [1440, 900],
    [375, 812],
  ] as const) {
    await page.setViewportSize({ width, height });
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await shot(page, `${name}-${String(width)}-${colorScheme}`);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
}

async function noHorizontalScroll(page: Page, width: number) {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(width);
}

async function openFormulaEditor(page: Page) {
  await page.goto(`/b/${demo.baseId}/t/${demo.tickets}`);
  await expect(page.locator('.ob-grid canvas').first()).toBeVisible();
  await page.getByTestId('grid-toolbar-more').click();
  await page.getByRole('menuitem', { name: 'Add field' }).click();
  const dialog = page.getByRole('dialog', { name: 'New field' });
  await dialog.getByLabel('Name').fill(`AI ${RUN}`);
  await dialog.getByLabel('Type').selectOption('formula');
  await dialog.getByTestId('formula-open-editor').click();
  const editor = page.getByTestId('formula-editor');
  await expect(editor.getByTestId('formula-ai')).toBeVisible();
  return editor;
}

async function openDraftDialog(page: Page, title = 'Create an automation with AI') {
  await page.goto(`/b/${demo.baseId}/automations`);
  await page.getByTestId('create-automation-ai').click();
  const dialog = page.getByRole('dialog', { name: title });
  await expect(dialog.getByTestId('ai-draft-example')).toHaveCount(3);
  await dialog.getByTestId('ai-draft-table').selectOption({ label: 'Tickets' });
  return dialog;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  fake = await startOwnFakeLlm();
  const { context, page } = await openAs(browser);
  const me = await ok<{ orgs: { id: string; name: string }[] }>(page, 'GET', '/me');
  demo.orgId = me.orgs.find((org) => org.name === WORKER_ORG.orgName)?.id ?? '';
  const workspaces = await ok<{ items: { id: string }[] }>(
    page,
    'GET',
    `/orgs/${demo.orgId}/workspaces`,
  );
  for (const workspace of workspaces.items) {
    const bases = await ok<{ items: { id: string; name: string }[] }>(
      page,
      'GET',
      `/workspaces/${workspace.id}/bases`,
    );
    demo.baseId =
      bases.items.find((base) => base.name === 'Chăm sóc khách hàng')?.id ?? demo.baseId;
  }
  const tables = await ok<{ items: { id: string; name: string }[] }>(
    page,
    'GET',
    `/bases/${demo.baseId}/tables`,
  );
  demo.tickets = tables.items.find((table) => table.name === 'Tickets')?.id ?? '';
  // This spec's provider: a loopback host opens with its exact `host:port` entry only.
  const entry = await ok<{ id: string }>(page, 'POST', `/orgs/${demo.orgId}/http-allowlist`, {
    pattern: new URL(fake.baseUrl).host,
    note: 'T913 fake AI provider',
  });
  demo.allowlistId = entry.id;
  await ok(page, 'PUT', `/orgs/${demo.orgId}/ai-settings`, {
    enabled: true,
    provider_base_url: fake.baseUrl,
    model: FAKE_LLM_MODEL,
    api_key: null,
  });
  await context.close();
});

test.afterAll(async ({ browser }) => {
  // Back to the stack's provider (the worker fixture's setting) for the next specs.
  const { context, page } = await openAs(browser);
  await ok(page, 'PUT', `/orgs/${demo.orgId}/ai-settings`, {
    enabled: true,
    provider_base_url: fakeLlmBaseUrl(),
    model: FAKE_LLM_MODEL,
    api_key: null,
  });
  if (demo.allowlistId !== '') await ok(page, 'DELETE', `/http-allowlist/${demo.allowlistId}`);
  await context.close();
  await fake.close();
});

test('formula: wrong on the first try, the correct suggestion, "Use", the preview', async ({
  browser,
}) => {
  const { context, page } = await openAs(browser);
  const csp = collectCspViolations(page);
  const editor = await openFormulaEditor(page);
  const box = editor.getByTestId('formula-ai');
  await expect(box.locator('svg.lucide-sparkles').first()).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'formula editor with AI');

  const before = fake.chatRequests().length;
  fake.script(
    { content: JSON.stringify({ formula: 'UPPER([Không có])', explanation: 'Sai tên trường.' }) },
    {
      content: JSON.stringify({
        formula: 'UPPER([Tiêu đề])',
        explanation: 'Viết hoa tiêu đề của ticket.',
      }),
    },
  );
  await box.getByRole('textbox', { name: 'Describe the formula' }).fill('Tiêu đề viết hoa');
  const sent = page.waitForRequest((request) => request.url().endsWith('/ai/formula'));
  await box.getByRole('textbox', { name: 'Describe the formula' }).press('Enter');
  expect((await sent).postDataJSON()).toEqual({
    description: 'Tiêu đề viết hoa',
    current: null,
    field_id: null,
  });
  const card = editor.getByTestId('formula-ai-suggestion');
  await expect(card.getByTestId('formula-ai-attempts')).toHaveText('Written in 2 tries');
  await expect(card.getByTestId('formula-ai-formula')).toContainText('UPPER(');
  await expect(card.getByTestId('formula-ai-formula')).toContainText('Tiêu đề');
  await expect(card.getByTestId('formula-ai-explanation')).toHaveText(
    'Viết hoa tiêu đề của ticket.',
  );
  // One repair round: the provider was told why the first answer failed.
  expect(fake.chatRequests().length - before).toBe(2);
  expect(JSON.stringify(fake.chatRequests().at(-1)?.body)).toContain('Không có');
  await expectNoSeriousA11yViolations(page, 'formula suggestion');
  await shots(page, 'formula-ai-suggestion');

  await card.getByRole('button', { name: 'Use' }).click();
  await expect(card).toHaveCount(0);
  await expect(editor.getByTestId('formula-input')).toContainText('UPPER(');
  // The preview of the editor runs on the formula (same row: in the browser).
  const row = await editor.getByTestId('formula-preview-row').textContent();
  const title = (row ?? '').split(' · ').slice(1).join(' · ');
  expect(title).not.toBe('');
  await expect(editor.getByTestId('formula-preview-value')).toContainText(title.toUpperCase());
  await expect(editor.getByTestId('formula-result-type')).toHaveText('Text');
  expect(csp).toEqual([]);
  await context.close();
});

test('automation: the milestone sentence opens the builder unsaved and off; saved, the list shows it off', async ({
  browser,
}) => {
  const { context, page } = await openAs(browser);
  const csp = collectCspViolations(page);
  const name = `Báo người phụ trách khi ticket xong ${RUN}`;
  const dialog = await openDraftDialog(page);
  await expect(dialog.getByTestId('ai-draft-example').first()).toHaveText(
    'When Trạng thái in Tickets changes to Đã xong, notify Phụ trách',
  );
  await expectNoSeriousA11yViolations(page, 'AI draft dialog');
  await shots(page, 'automation-ai-dialog-empty');

  fake.script({ content: JSON.stringify(milestoneDraft(name)), delayMs: 3_000 });
  const prompt = dialog.getByRole('textbox', { name: 'What should the automation do?' });
  await prompt.fill(MILESTONE);
  const sent = page.waitForRequest((request) => request.url().endsWith('/ai/automation-draft'));
  await prompt.press('Enter');
  expect((await sent).postDataJSON()).toEqual({ prompt: MILESTONE, table_id: demo.tickets });
  const waiting = dialog.getByTestId('ai-waiting');
  await expect(waiting.getByRole('status')).toContainText('Drafting the automation…');
  await expect(waiting.getByRole('button', { name: 'Cancel' })).toBeVisible();

  await expect(page).toHaveURL(new RegExp(`/b/${demo.baseId}/automations/new$`, 'u'));
  const banner = page.getByTestId('ai-draft-banner');
  await expect(banner).toContainText(
    'AI draft: check every step before you save it and turn it on.',
  );
  await expect(banner.getByTestId('ai-draft-request')).toHaveText(MILESTONE);
  await expect(banner.getByTestId('ai-draft-explanation')).toHaveText(EXPLANATION);
  await expect(banner.getByTestId('ai-draft-warnings')).toContainText(
    'Guessed: "DONE" được hiểu là lựa chọn "Đã xong" của Trạng thái.',
  );
  await expect(page.getByTestId('builder-title')).toHaveText(name);
  // "When a record is updated · Trạng thái → Đã xong" and "Send notification · Phụ trách".
  await expect(page.getByTestId('step-trigger')).toContainText('When a record is updated');
  await expect(page.getByTestId('step-trigger')).toContainText('Trạng thái');
  await expect(page.getByTestId('step-condition')).toContainText('Trạng thái');
  await expect(page.getByTestId('step-condition')).toContainText('Đã xong');
  const step = page.getByTestId('step-act_1');
  await expect(step).toContainText('Send notification');
  await expect(step).toContainText('Phụ trách');
  await expect(step.getByTestId('notify-channels-hint')).toHaveText(
    "Sent through each recipient's channels — Telegram when linked.",
  );
  const enabled = page.getByTestId('builder-enabled');
  await expect(enabled).not.toBeChecked();
  await expect(enabled).toBeDisabled();
  await expectNoSeriousA11yViolations(page, 'builder with the AI draft');
  await shots(page, 'automation-ai-builder');

  await page.getByTestId('builder-save').click();
  await expect(page).toHaveURL(/\/automations\/aut_[^/]+$/u);
  const automationId = new URL(page.url()).pathname.split('/').at(-1) ?? '';
  try {
    await expect(page.getByTestId('ai-draft-banner')).toHaveCount(0);
    const saved = await ok<{
      enabled: boolean;
      description: string;
      definition: { trigger: { type: string } };
    }>(page, 'GET', `/automations/${automationId}`);
    expect(saved.enabled).toBe(false);
    expect(saved.description).toBe(MILESTONE);
    expect(saved.definition.trigger.type).toBe('record.updated');

    await page.goto(`/b/${demo.baseId}/automations`);
    await expect(page.getByRole('switch', { name: `Turn on ${name}` })).not.toBeChecked();
    await page.getByTestId('status-off').click();
    await expect(page.getByTestId(`automation-row-${automationId}`)).toBeVisible();
    expect(csp).toEqual([]);
  } finally {
    await ok(page, 'DELETE', `/automations/${automationId}`);
    await context.close();
  }
});

test('the dialog: the wait cancelled, an answer that stays invalid, Vietnamese dark 375 px', async ({
  browser,
}) => {
  const { context, page } = await openAs(browser);
  const dialog = await openDraftDialog(page);
  const prompt = dialog.getByTestId('ai-draft-prompt');

  await test.step('the wait says what happens and "Cancel" ends it', async () => {
    fake.script({ content: JSON.stringify(milestoneDraft('Late')), delayMs: 20_000 });
    await prompt.fill(MILESTONE);
    await dialog.getByTestId('ai-draft-submit').click();
    const waiting = dialog.getByTestId('ai-waiting');
    await expect(waiting.getByRole('status')).toContainText('Drafting the automation…');
    await expect(waiting).toHaveAttribute('aria-busy', 'true');
    await expectNoSeriousA11yViolations(page, 'AI draft waiting');
    await shots(page, 'automation-ai-dialog-waiting');
    await waiting.getByRole('button', { name: 'Cancel' }).click();
    await expect(waiting).toHaveCount(0);
    await expect(prompt).toHaveValue(MILESTONE);
    await expect(prompt).toBeFocused();
    await expect(page).toHaveURL(new RegExp(`/b/${demo.baseId}/automations$`, 'u'));
  });

  await test.step('three invalid answers: its own sentence, the sentence kept', async () => {
    fake.script({ content: 'not json' }, { content: 'not json' }, { content: 'not json' });
    await dialog.getByTestId('ai-draft-submit').click();
    await expect(dialog.getByTestId('ai-draft-error')).toContainText(
      'The AI could not make a valid draft in 3 tries. Rephrase the sentence, or name the table and fields.',
    );
    await expect(prompt).toHaveValue(MILESTONE);
    await expectNoSeriousA11yViolations(page, 'AI draft error');
    await shots(page, 'automation-ai-dialog-error');
  });
  await context.close();

  await test.step('Vietnamese, dark, 375 px', async () => {
    const phone = await openAs(browser, {
      viewport: { width: 375, height: 812 },
      language: 'vi',
      colorScheme: 'dark',
    });
    // Phones look and turn on/off only (FRONTEND §13.1): no "Create", no "Create with AI".
    await phone.page.goto(`/b/${demo.baseId}/automations`);
    await expect(phone.page.getByText('Sửa automation trên màn hình rộng ≥ 768 px.')).toBeVisible();
    await expect(phone.page.getByTestId('create-automation-ai')).toHaveCount(0);
    await noHorizontalScroll(phone.page, 375);
    // A dialog opened on a wider screen becomes a bottom sheet.
    await phone.page.setViewportSize({ width: 1024, height: 812 });
    const sheet = await openDraftDialog(phone.page, 'Tạo automation bằng AI');
    await expect(sheet.getByTestId('ai-draft-example').first()).toHaveText(
      'Khi Trạng thái của Tickets chuyển sang Đã xong thì gửi thông báo cho Phụ trách',
    );
    await phone.page.setViewportSize({ width: 375, height: 812 });
    await noHorizontalScroll(phone.page, 375);
    await expect(sheet.getByRole('button', { name: 'Tạo bản nháp' })).toBeVisible();
    await expectNoSeriousA11yViolations(phone.page, 'AI draft dialog, vi, dark, 375 px');
    await phone.context.close();
  });
});

test('the automation flow on film (design report only)', async ({ browser }) => {
  test.skip(SHOTS === undefined, 'only with T913_SHOTS');
  const { context, page } = await openAs(browser, { video: `${SHOTS ?? ''}/flow-video` });
  const name = `Báo người phụ trách khi ticket xong (phim) ${RUN}`;
  const dialog = await openDraftDialog(page);
  fake.script({ content: JSON.stringify(milestoneDraft(name)), delayMs: 2_500 });
  await dialog
    .getByRole('textbox', { name: 'What should the automation do?' })
    .pressSequentially(MILESTONE, { delay: 15 });
  await dialog.getByTestId('ai-draft-submit').click();
  await expect(page.getByTestId('ai-draft-banner')).toBeVisible({ timeout: 15_000 });
  await animationsSettled(page);
  await page.waitForTimeout(800);
  await page.getByTestId('step-act_1').getByRole('button').first().click();
  await page.waitForTimeout(800);
  await page.getByTestId('builder-save').click();
  await expect(page).toHaveURL(/\/automations\/aut_[^/]+$/u);
  const automationId = new URL(page.url()).pathname.split('/').at(-1) ?? '';
  await page.goto(`/b/${demo.baseId}/automations`);
  await expect(page.getByRole('switch', { name: `Turn on ${name}` })).not.toBeChecked();
  await page.waitForTimeout(800);
  await ok(page, 'DELETE', `/automations/${automationId}`);
  await context.close();
});
