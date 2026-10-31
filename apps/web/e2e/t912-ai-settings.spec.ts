import { type Browser, type BrowserContext, type Page } from '@playwright/test';

import { FAKE_LLM_MODEL, fakeLlmBaseUrl, fakeLlmHost } from './fake-llm';
import { expect, test, WORKER_ORG } from './fixtures';
import { DEMO_PASSWORD } from './seed';
import {
  apiSignIn,
  collectCspViolations,
  expectNoSeriousA11yViolations,
  ok,
  signInFirstAdmin,
} from './support';

/**
 * T912: the organization AI settings page (FRONTEND §15.8, CONTRACTS §29.1)
 * against the fake provider of the stack (`fake-llm.ts`, T905):
 *
 * - in the worker administrator's own organization (no AI yet): not set up
 *   → provider URL and model saved → "Test connection" is blocked (a
 *   loopback port without an allowlist entry, `ssrf_blocked`) → "Allow
 *   localhost:<port>" prefilled → added → the test runs again, green →
 *   AI on (`ai.available`) → record values after the confirmation naming
 *   the host (`ai.record_data`) → the test counted in the usage table;
 * - Vietnamese, dark, 375 px: no horizontal scroll, the test still green;
 * - `ai.available = false` (the demo organization, AI off for the test): no
 *   AI entry renders on the screens that carry one from T913–T915 — the
 *   "AI" item of the settings nav is the positive control of the check;
 * - `ai.available = true` (the demo organization): the same screens show their
 *   entry (T913: formula editor, automation list; T914–T915 add theirs).
 *
 * axe on every state. `beforeAll` resets the AI settings and the allowlist
 * entry of the administrator's organization (retries); the demo
 * organization gets AI back on at the end (the worker fixture's setting).
 */

const ADMIN = {
  name: WORKER_ORG.ownerName,
  email: WORKER_ORG.ownerEmail,
  password: 'E2E-Setup-Password-2026',
};

/** A sparkle icon: the one sign of every AI entry point (research §5.2). */
const SPARKLES = 'svg.lucide-sparkles';

interface Org {
  id: string;
  slug: string;
  name: string;
}

let owner: Org;
let ownerCookies: Awaited<ReturnType<BrowserContext['cookies']>> | null = null;

async function openAsOwner(
  browser: Browser,
  options: {
    viewport?: { width: number; height: number };
    language?: 'en' | 'vi';
    colorScheme?: 'light' | 'dark';
  } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1440, height: 900 },
    locale: 'en-US',
    colorScheme: options.colorScheme ?? 'light',
  });
  await context.addInitScript((value) => {
    window.localStorage.setItem('cellhive.language', value);
  }, options.language ?? 'en');
  const page = await context.newPage();
  await page.goto('/login');
  if (ownerCookies === null) {
    await signInFirstAdmin(page, ADMIN);
    ownerCookies = await context.cookies();
  } else {
    await context.addCookies(ownerCookies);
  }
  return { context, page };
}

async function aiOf(page: Page, orgId: string): Promise<unknown> {
  return (await ok<{ ai: unknown }>(page, 'GET', `/orgs/${orgId}`)).ai;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  const { context, page } = await openAsOwner(browser);
  const me = await ok<{ orgs: Org[] }>(page, 'GET', '/me');
  const found = me.orgs.find((org) => org.name === WORKER_ORG.ownerOrgName);
  if (found === undefined)
    throw new Error(`The organization ${WORKER_ORG.ownerOrgName} is missing.`);
  owner = found;
  await ok(page, 'PUT', `/orgs/${owner.id}/ai-settings`, {
    enabled: false,
    provider_base_url: null,
    model: null,
    api_key: null,
    allow_record_data: false,
    log_prompts: false,
  });
  const allowlist = await ok<{ items: { id: string; pattern: string }[] }>(
    page,
    'GET',
    `/orgs/${owner.id}/http-allowlist`,
  );
  for (const entry of allowlist.items.filter((item) => item.pattern === fakeLlmHost())) {
    await ok(page, 'DELETE', `/http-allowlist/${entry.id}`);
  }
  await context.close();
});

test('set up AI: a blocked internal host is allowed from the test, then AI and record values go on', async ({
  browser,
}) => {
  const host = fakeLlmHost();
  const { context, page } = await openAsOwner(browser);
  const csp = collectCspViolations(page);
  await page.goto(`/o/${owner.slug}/settings/ai`);
  await expect(page.getByRole('heading', { level: 1, name: 'AI' })).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Organization settings' });
  await expect(nav.getByRole('link', { name: 'AI', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const badge = page.getByTestId('ai-status-badge');
  await expect(badge).toHaveText('Not set up');
  await expect(page.getByTestId('ai-empty')).toBeVisible();
  const aiSwitch = page.getByRole('switch', { name: 'Use AI in this organization' });
  await expect(aiSwitch).toBeDisabled();
  await expect(page.getByTestId('ai-test')).toBeDisabled();
  await expect(page.getByTestId('ai-usage-empty')).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'AI not set up');

  await test.step('save a provider and a model', async () => {
    // A preset fills the URL; the stack's fake provider replaces it.
    await page.getByTestId('ai-preset-ollama').click();
    await expect(page.getByTestId('ai-base-url')).toHaveValue('http://localhost:11434/v1');
    await expect(page.getByTestId('ai-preset-note')).toContainText('replace localhost');
    await page.getByTestId('ai-base-url').fill(fakeLlmBaseUrl());
    await page.getByTestId('ai-model').fill(FAKE_LLM_MODEL);
    await expect(page.getByTestId('ai-settings-bar')).toContainText('You have unsaved changes.');
    await page.getByTestId('ai-settings-save').click();
    await expect(page.getByText('AI settings saved.')).toBeVisible();
    await expect(page.getByTestId('ai-settings-bar')).toHaveCount(0);
    await expect(badge).toHaveText('Off');
    await expect(page.getByTestId('ai-step-provider')).toHaveAttribute('data-done', 'true');
    await expect(aiSwitch).toBeEnabled();
  });

  await test.step('test: the loopback port is blocked; allow it from the result', async () => {
    await page.getByTestId('ai-test').click();
    const blocked = page.getByTestId('ai-test-blocked');
    await expect(blocked).toContainText(`Cellhive may not call ${host}`);
    await expectNoSeriousA11yViolations(page, 'AI test blocked');
    await blocked.getByRole('button', { name: `Allow ${host}` }).click();
    const dialog = page.getByRole('dialog', { name: `Allow ${host}?` });
    await expect(dialog.getByTestId('ai-allow-pattern')).toHaveValue(host);
    await expectNoSeriousA11yViolations(page, 'allowlist entry dialog');
    await dialog.getByRole('button', { name: 'Add to allowlist' }).click();
    await expect(dialog).toHaveCount(0);
  });

  await test.step('the test runs again, green', async () => {
    const green = page.getByTestId('ai-test-ok');
    await expect(green).toContainText(`Connected to ${host}`);
    await expect(green).toContainText(FAKE_LLM_MODEL);
    await expect(green.getByTestId('ai-test-format')).toHaveText('JSON schema');
    await expect(green.getByTestId('ai-test-latency')).toContainText('ms');
    // `auto` with the saved URL and model: the detected format is stored.
    await expect(page.getByTestId('ai-step-test')).toHaveAttribute('data-done', 'true');
    const allowlist = await ok<{ items: { pattern: string }[] }>(
      page,
      'GET',
      `/orgs/${owner.id}/http-allowlist`,
    );
    expect(allowlist.items.map((entry) => entry.pattern)).toContain(host);
    await expectNoSeriousA11yViolations(page, 'AI test green');
  });

  await test.step('AI on: entry points may render for members', async () => {
    expect(await aiOf(page, owner.id)).toEqual({ available: false, record_data: false });
    await aiSwitch.click();
    await expect(page.getByText(`AI is on for ${owner.name}.`)).toBeVisible();
    await expect(badge).toHaveText('On');
    await expect(aiSwitch).toBeChecked();
    expect(await aiOf(page, owner.id)).toEqual({ available: true, record_data: false });
  });

  await test.step('record values: asks first, naming the host and the features', async () => {
    const recordData = page.getByRole('switch', { name: 'Let AI see record values' });
    await recordData.click();
    const confirm = page.getByRole('alertdialog', { name: 'Let AI see record values?' });
    await expect(confirm).toContainText(`Record values will be sent to ${host}`);
    await expect(confirm).toContainText('AI fields');
    await expect(confirm).toContainText('Ask AI');
    expect(await aiOf(page, owner.id)).toEqual({ available: true, record_data: false });
    await expectNoSeriousA11yViolations(page, 'record values confirmation');
    await confirm.getByRole('button', { name: 'Let AI see record values' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(recordData).toBeChecked();
    expect(await aiOf(page, owner.id)).toEqual({ available: true, record_data: true });
  });

  await test.step('usage: the connection test is counted', async () => {
    const usage = page.getByTestId('ai-usage');
    await expect(
      usage.getByTestId('ai-usage-row').filter({ hasText: 'Connection tests' }),
    ).toBeVisible();
    await expect(usage.getByTestId('ai-usage-today')).toContainText('of 1,000,000 tokens');
    await expectNoSeriousA11yViolations(page, 'AI on');
  });
  expect(csp).toEqual([]);
  await context.close();
});

test('Vietnamese, dark, 375 px: no horizontal scroll, the test still green', async ({
  browser,
}) => {
  const { context, page } = await openAsOwner(browser, {
    viewport: { width: 375, height: 812 },
    language: 'vi',
    colorScheme: 'dark',
  });
  await page.goto(`/o/${owner.slug}/settings/ai`);
  await expect(page.getByTestId('ai-status-badge')).toHaveText('Đang bật');
  await page.getByRole('button', { name: 'Kiểm tra kết nối' }).click();
  await expect(page.getByTestId('ai-test-ok')).toContainText(`Đã kết nối tới ${fakeLlmHost()}`);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(375);
  // Touch size below 1024 px (F§9.3).
  expect((await page.getByTestId('ai-test').boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  await expectNoSeriousA11yViolations(page, 'AI settings, vi, dark, 375 px');
  await context.close();
});

/** The demo organization of the worker, its base "Chăm sóc khách hàng", Tickets and an automation. */
async function demoBase(page: Page) {
  const me = await ok<{ orgs: Org[] }>(page, 'GET', '/me');
  const demo = me.orgs.find((org) => org.name === WORKER_ORG.orgName);
  if (demo === undefined) throw new Error(`The organization ${WORKER_ORG.orgName} is missing.`);
  const workspaces = await ok<{ items: { id: string }[] }>(
    page,
    'GET',
    `/orgs/${demo.id}/workspaces`,
  );
  let baseId = '';
  for (const workspace of workspaces.items) {
    const bases = await ok<{ items: { id: string; name: string }[] }>(
      page,
      'GET',
      `/workspaces/${workspace.id}/bases`,
    );
    baseId = bases.items.find((base) => base.name === 'Chăm sóc khách hàng')?.id ?? baseId;
  }
  const tables = await ok<{ items: { id: string; name: string }[] }>(
    page,
    'GET',
    `/bases/${baseId}/tables`,
  );
  const ticketsId = tables.items.find((table) => table.name === 'Tickets')?.id ?? '';
  const automations = await ok<{ items: { id: string }[] }>(
    page,
    'GET',
    `/bases/${baseId}/automations`,
  );
  const automationId = automations.items[0]?.id ?? '';
  expect(automationId, 'a demo automation').not.toBe('');
  return { demo, baseId, ticketsId, automationId };
}

/** The demo administrator (AI on: the worker fixture's setting). */
async function openAsDemoAdmin(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    window.localStorage.setItem('cellhive.language', 'en');
  });
  const page = await context.newPage();
  await page.goto('/login');
  await apiSignIn(page, WORKER_ORG.email('admin'), DEMO_PASSWORD);
  return { context, page };
}

/** "⋯" → "Add field" → "Formula" → the editor, on Tickets. */
async function openFormulaEditor(page: Page, baseId: string, ticketsId: string, name: string) {
  await page.goto(`/b/${baseId}/t/${ticketsId}`);
  await expect(page.locator('.ob-grid canvas').first()).toBeVisible();
  await page.getByTestId('grid-toolbar-more').click();
  await page.getByRole('menuitem', { name: 'Add field' }).click();
  const dialog = page.getByRole('dialog', { name: 'New field' });
  const type = dialog.getByLabel('Type');
  await expect(type.locator('option').first()).toBeAttached();
  await dialog.getByLabel('Name').fill(name);
  await type.selectOption('formula');
  await dialog.getByTestId('formula-open-editor').click();
  await expect(page.getByTestId('formula-editor')).toBeVisible();
  return { dialog, type };
}

test('ai.available = false: no AI entry renders on the screens that carry one', async ({
  browser,
}) => {
  const { context, page } = await openAsDemoAdmin(browser);
  const { demo, baseId, ticketsId, automationId } = await demoBase(page);

  await ok(page, 'PUT', `/orgs/${demo.id}/ai-settings`, { enabled: false });
  try {
    expect(await aiOf(page, demo.id)).toEqual({ available: false, record_data: false });
    const noAiEntry = async (label: string) => {
      await expect(page.locator(SPARKLES), `no AI entry: ${label}`).toHaveCount(0);
    };

    // Positive control: owners/admins keep the settings page to turn AI back on.
    await page.goto(`/o/${demo.slug}/settings`);
    const nav = page.getByRole('navigation', { name: 'Organization settings' });
    await expect(nav.getByRole('link', { name: 'AI', exact: true }).locator(SPARKLES)).toHaveCount(
      1,
    );

    await page.goto(`/o/${demo.slug}`);
    await expect(page.getByRole('heading', { level: 1, name: demo.name })).toBeVisible();
    await noAiEntry('organization home');

    // Grid toolbar ("Ask AI", T914), field types ("AI", T915), formula editor (T913).
    await page.goto(`/b/${baseId}/t/${ticketsId}`);
    await expect(page.locator('.ob-grid canvas').first()).toBeVisible();
    await noAiEntry('grid and its toolbar');
    const { type } = await openFormulaEditor(page, baseId, ticketsId, 'T912 no AI');
    await expect(type.locator('option, optgroup').filter({ hasText: /\bAI\b/u })).toHaveCount(0);
    await expect(type.locator('optgroup[label="AI"]')).toHaveCount(0);
    await noAiEntry('formula editor');
    await page.keyboard.press('Escape');

    // Automation list ("Create with AI", T913) and the step picker (AI actions, T915).
    await page.goto(`/b/${baseId}/automations`);
    await expect(page.getByTestId('create-automation')).toBeVisible();
    await noAiEntry('automation list');
    await page.goto(`/b/${baseId}/automations/${automationId}`);
    await page.getByTestId('add-step').click();
    await expect(page.getByTestId('add-update_records')).toBeVisible();
    await expect(page.locator('[data-testid^="add-ai"]')).toHaveCount(0);
    await noAiEntry('step picker of the builder');
  } finally {
    await ok(page, 'PUT', `/orgs/${demo.id}/ai-settings`, { enabled: true });
    await context.close();
  }
});

test('ai.available = true: the AI entries render on the screens that carry one', async ({
  browser,
}) => {
  const { context, page } = await openAsDemoAdmin(browser);
  const { demo, baseId, ticketsId } = await demoBase(page);
  expect(await aiOf(page, demo.id)).toEqual({ available: true, record_data: false });

  // Grid toolbar: "Ask AI" (T914) opens its panel.
  await page.goto(`/b/${baseId}/t/${ticketsId}`);
  const askAi = page.getByTestId('ask-ai-button');
  await expect(askAi).toHaveAccessibleName('Ask AI');
  await expect(askAi.locator(SPARKLES)).toHaveCount(1);
  await askAi.click();
  const askPanel = page.getByRole('dialog', { name: 'Ask AI' });
  await expect(askPanel.getByRole('textbox', { name: 'Your question' })).toBeFocused();
  await expectNoSeriousA11yViolations(page, 'Ask AI panel, AI on');
  await page.keyboard.press('Escape');
  await expect(askPanel).toHaveCount(0);

  // Formula editor: "Describe the formula" (T913).
  await openFormulaEditor(page, baseId, ticketsId, 'T912 AI on');
  const formulaAi = page.getByTestId('formula-editor').getByTestId('formula-ai');
  await expect(formulaAi.locator(SPARKLES).first()).toBeVisible();
  await expect(formulaAi.getByRole('textbox', { name: 'Describe the formula' })).toBeVisible();
  await expectNoSeriousA11yViolations(page, 'formula editor, AI on');
  await page.keyboard.press('Escape');

  // Automation list: "Create with AI" (T913). Field types and the step picker (T915) add
  // theirs.
  await page.goto(`/b/${baseId}/automations`);
  const create = page.getByTestId('create-automation-ai');
  await expect(create).toHaveText('Create with AI');
  await expect(create.locator(SPARKLES)).toHaveCount(1);
  await expectNoSeriousA11yViolations(page, 'automation list, AI on');
  await context.close();
});
