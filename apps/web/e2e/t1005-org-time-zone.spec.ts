import { type Browser, type BrowserContext, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import {
  collectCspViolations,
  expectNoSeriousA11yViolations,
  ok,
  signInFirstAdmin,
} from './support';

/**
 * T1005 (FRONTEND §15.0, CONTRACTS §1.1, §29.1): Organization settings ›
 * General sets the organization time zone (`PATCH /orgs/:id`) from the IANA
 * names, says what it decides, and the AI quota day of `GET …/ai-usage`
 * (`to`, `quota.reset_at`) follows the new zone at once. In the worker
 * administrator's own organization (stack default `UTC`), put back after.
 */

const ADMIN = {
  name: WORKER_ORG.ownerName,
  email: WORKER_ORG.ownerEmail,
  password: 'E2E-Setup-Password-2026',
};
const DAY = 86_400_000;

interface Org {
  id: string;
  slug: string;
  name: string;
}

interface AiUsage {
  to: string;
  time_zone: string;
  quota: { reset_at: string };
}

let owner: Org;
let originalZone = 'UTC';
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
    timezoneId: 'Asia/Ho_Chi_Minh',
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

/** Today's date in `zone` (`YYYY-MM-DD`). */
function todayIn(zone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date());
}

/** The instant of 00:00 after `day` in a zone `offsetHours` ahead of UTC (no daylight saving time). */
function midnightAfter(day: string, offsetHours: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + DAY - offsetHours * 3_600_000).toISOString();
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  const { context, page } = await openAsOwner(browser);
  const me = await ok<{ orgs: Org[] }>(page, 'GET', '/me');
  const found = me.orgs.find((org) => org.name === WORKER_ORG.ownerOrgName);
  if (found === undefined)
    throw new Error(`The organization ${WORKER_ORG.ownerOrgName} is missing.`);
  owner = found;
  const org = await ok<{ settings: { timezone: string } }>(page, 'GET', `/orgs/${owner.id}`);
  originalZone = org.settings.timezone;
  // A retry starts from the stack default.
  await ok(page, 'PATCH', `/orgs/${owner.id}`, { settings: { timezone: 'UTC' } });
  await context.close();
});

test.afterAll(async ({ browser }) => {
  const { context, page } = await openAsOwner(browser);
  await ok(page, 'PATCH', `/orgs/${owner.id}`, { settings: { timezone: originalZone } });
  await context.close();
});

test('General: the organization time zone is saved, and the AI quota day follows it', async ({
  browser,
}, testInfo) => {
  const { context, page } = await openAsOwner(browser);
  const csp = collectCspViolations(page);
  const usage = () => ok<AiUsage>(page, 'GET', `/orgs/${owner.id}/ai-usage`);
  await page.goto(`/o/${owner.slug}/settings`);
  const form = page.getByTestId('org-info-form');
  const zone = form.getByLabel('Time zone');
  const save = form.getByRole('button', { name: 'Save changes' });
  await expect(zone).toHaveValue('UTC');
  await expect(zone).toHaveAccessibleDescription(
    /day of the AI quota \(which resets at midnight here\) and when automation schedules/u,
  );
  await expect(save).toBeDisabled();
  expect(await usage()).toMatchObject({
    time_zone: 'UTC',
    quota: { reset_at: midnightAfter(todayIn('UTC'), 0) },
  });
  await expectNoSeriousA11yViolations(page, 'General, time zone UTC');

  for (const [name, offsetHours] of [
    // UTC+14: often a day ahead of UTC.
    ['Pacific/Kiritimati', 14],
    // UTC−5 all year.
    ['America/Lima', -5],
  ] as const) {
    await test.step(`${name}: saved, shown again after a reload, the quota day in it`, async () => {
      await zone.selectOption(name);
      await expect(save).toBeEnabled();
      await save.click();
      await expect(page.getByText('Saved.')).toBeVisible();
      await expect(save).toBeDisabled();
      await page.reload();
      await expect(page.getByTestId('org-info-form').getByLabel('Time zone')).toHaveValue(name);
      const answer = await usage();
      expect(answer).toMatchObject({ time_zone: name, to: todayIn(name) });
      expect(answer.quota.reset_at).toBe(midnightAfter(answer.to, offsetHours));
    });
  }
  await page.screenshot({ path: testInfo.outputPath('general-en-light-1440.png'), fullPage: true });
  await expectNoSeriousA11yViolations(page, 'General, time zone changed');
  expect(csp).toEqual([]);
  await context.close();
});

test('Vietnamese, dark, 375 px: the time zone picker fits, no horizontal scroll', async ({
  browser,
}, testInfo) => {
  const { context, page } = await openAsOwner(browser, {
    viewport: { width: 375, height: 812 },
    language: 'vi',
    colorScheme: 'dark',
  });
  await page.goto(`/o/${owner.slug}/settings`);
  const zone = page.getByTestId('org-info-form').getByLabel('Múi giờ');
  await expect(zone).toHaveValue('America/Lima');
  await expect(zone).toHaveAccessibleDescription(/ngày tính quota AI/u);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(375);
  await page.screenshot({ path: testInfo.outputPath('general-vi-dark-375.png'), fullPage: true });
  await expectNoSeriousA11yViolations(page, 'General, vi, dark, 375 px');
  await context.close();
});
