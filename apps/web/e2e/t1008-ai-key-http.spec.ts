import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { type Browser, type BrowserContext, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import {
  collectCspViolations,
  expectNoSeriousA11yViolations,
  ok,
  signInFirstAdmin,
} from './support';

/**
 * T1008 (CONTRACTS §29.1, FRONTEND §15.8): Settings › AI warns that a key
 * typed for a plain `http` provider URL travels unencrypted, and the server
 * asks for the confirmation under the warning (`INSECURE_KEY_NOT_CONFIRMED`)
 * until it is ticked — in the worker administrator's own organization (as
 * T912), with a provider host no lookup resolves, so nothing is ever called.
 * English 1440 px light, then Vietnamese 375 px dark. axe on every state.
 *
 * `T1008_SHOTS=<dir>` also writes the screenshots of the review there.
 */

const ADMIN = {
  name: WORKER_ORG.ownerName,
  email: WORKER_ORG.ownerEmail,
  password: 'E2E-Setup-Password-2026',
};
/** Never resolves (`.test`, RFC 6761): no call leaves the machine. */
const HOST = 'llm.cellhive-e2e.test';
/** Obviously fake: never a real provider key. */
const FAKE_KEY = 'sk-test-not-a-real-key-t1008-e2e';
const SHOTS = process.env['T1008_SHOTS'];

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

/** The viewport with the warning in its middle (the save bar sticks to the bottom). */
async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS === undefined) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.getByTestId('ai-insecure').evaluate((element) => {
    element.scrollIntoView({ block: 'center' });
  });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** No AI settings and no AI key in the organization (as T912 leaves it before it starts). */
async function reset(page: Page): Promise<void> {
  await ok(page, 'PUT', `/orgs/${owner.id}/ai-settings`, {
    enabled: false,
    provider_base_url: null,
    model: null,
    api_key: null,
  });
  const secrets = await ok<{ items: { id: string; kind: string }[] }>(
    page,
    'GET',
    `/orgs/${owner.id}/secrets`,
  );
  for (const secret of secrets.items.filter((item) => item.kind === 'ai_api_key')) {
    await ok(page, 'DELETE', `/secrets/${secret.id}`);
  }
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  const { context, page } = await openAsOwner(browser);
  const me = await ok<{ orgs: Org[] }>(page, 'GET', '/me');
  const found = me.orgs.find((org) => org.name === WORKER_ORG.ownerOrgName);
  if (found === undefined) {
    throw new Error(`The organization ${WORKER_ORG.ownerOrgName} is missing.`);
  }
  owner = found;
  await reset(page);
  await context.close();
});

test.afterAll(async ({ browser }) => {
  const { context, page } = await openAsOwner(browser);
  await reset(page);
  await context.close();
});

test('a key for a plain http URL: the warning, then the confirmation the server asks for', async ({
  browser,
}) => {
  const { context, page } = await openAsOwner(browser);
  const csp = collectCspViolations(page);
  await page.goto(`/o/${owner.slug}/settings/ai`);
  await expect(page.getByRole('heading', { level: 1, name: 'AI' })).toBeVisible();
  const warning = page.getByTestId('ai-insecure');

  await test.step('https with a key: no warning', async () => {
    await page.getByTestId('ai-base-url').fill(`https://${HOST}/v1`);
    await page.getByTestId('ai-model').fill('gpt-5-mini');
    await page.getByTestId('ai-key-input').fill(FAKE_KEY);
    await expect(page.getByTestId('ai-settings-bar')).toBeVisible();
    await expect(warning).toHaveCount(0);
  });

  await test.step('http with a key: the key will travel unencrypted', async () => {
    await page.getByTestId('ai-base-url').fill(`http://${HOST}/v1`);
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('The key will travel unencrypted');
    await expect(warning).toContainText(HOST);
    await expect(page.getByTestId('ai-insecure-confirm')).not.toBeChecked();
    await expectNoSeriousA11yViolations(page, 'AI key over http');
    await shot(page, 'en-1440-light-warning');
  });

  await test.step('saving without the confirmation: the server asks for it under the warning', async () => {
    await page.getByTestId('ai-settings-save').click();
    const error = page.getByTestId('ai-insecure-error');
    await expect(error).toContainText(`the key would travel unencrypted to ${HOST}`);
    await expect(page.getByTestId('ai-insecure-confirm')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByTestId('ai-settings-bar')).toBeVisible();
    const saved = await ok<{ provider_base_url: string | null; api_key: unknown }>(
      page,
      'GET',
      `/orgs/${owner.id}/ai-settings`,
    );
    expect(saved).toMatchObject({ provider_base_url: null, api_key: null });
    await expectNoSeriousA11yViolations(page, 'AI key over http, not confirmed');
    await shot(page, 'en-1440-light-refused');
  });

  await test.step('confirmed: saved, the key bound to host:80', async () => {
    await page.getByTestId('ai-insecure-confirm').check();
    await expect(page.getByTestId('ai-insecure-error')).toHaveCount(0);
    await page.getByTestId('ai-settings-save').click();
    await expect(page.getByText('AI settings saved.')).toBeVisible();
    await expect(page.getByTestId('ai-settings-bar')).toHaveCount(0);
    const saved = await ok<{ api_key: { allowed_hosts: string[] } | null }>(
      page,
      'GET',
      `/orgs/${owner.id}/ai-settings`,
    );
    expect(saved.api_key?.allowed_hosts).toEqual([`${HOST}:80`]);
    // The saved key on its http host: still said, nothing more to confirm.
    await expect(warning).toBeVisible();
    await expect(page.getByTestId('ai-key-saved')).toContainText(`${HOST}:80`);
  });

  await test.step('back to https: no warning', async () => {
    await page.getByTestId('ai-key-replace').click();
    await page.getByTestId('ai-base-url').fill(`https://${HOST}/v1`);
    await page.getByTestId('ai-key-input').fill(FAKE_KEY);
    await expect(warning).toHaveCount(0);
  });
  expect(csp).toEqual([]);
  await context.close();
});

test('Vietnamese, dark, 375 px: the warning reads, no horizontal scroll', async ({ browser }) => {
  const { context, page } = await openAsOwner(browser, {
    viewport: { width: 375, height: 812 },
    language: 'vi',
    colorScheme: 'dark',
  });
  await ok(page, 'PUT', `/orgs/${owner.id}/ai-settings`, {
    provider_base_url: null,
    model: null,
    api_key: null,
  });
  await page.goto(`/o/${owner.slug}/settings/ai`);
  await page.getByTestId('ai-base-url').fill(`http://${HOST}:8080/v1`);
  await page.getByTestId('ai-model').fill('gpt-5-mini');
  await page.getByTestId('ai-key-input').fill(FAKE_KEY);
  const warning = page.getByTestId('ai-insecure');
  await expect(warning).toContainText('Key sẽ đi không mã hoá');
  await expect(warning).toContainText(`Vẫn gửi key tới ${HOST}:8080 qua http`);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(375);
  await expectNoSeriousA11yViolations(page, 'AI key over http, vi, dark, 375 px');
  await shot(page, 'vi-375-dark-warning');
  await context.close();
});
