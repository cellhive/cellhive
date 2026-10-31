import { mkdirSync } from 'node:fs';

import { type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';

import { FAKE_LLM_MODEL, fakeLlmBaseUrl, startOwnFakeLlm, type FakeLlm } from './fake-llm';
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
 * T914: "Ask AI" of a table (FRONTEND §20, CONTRACTS §29.4) against a fake
 * provider of this spec's own (`startOwnFakeLlm`: its answers are scripted —
 * the shared provider's deterministic answer to a plan is `unanswerable`),
 * the worker's demo organization pointed at it while the spec runs, in a
 * base of its own: Orders (title, owner, amount, ngày) with r1 (u_sales1,
 * 100, 30/09 23:30 UTC = October in Ho Chi Minh City), r2 (u_sales2, 200,
 * August), r3 (no owner, 300, September); the role "Sales" reads the orders
 * it owns.
 *
 * - "Doanh thu theo tháng" (plan: sum of amount by month of ngày): u_sales1's
 *   chart has r1's month only, u_admin's all three; the browser's zone goes
 *   with the question; with `record_data` off, no narrative but the
 *   interpretation; the grid route loads no ECharts until a chart answer;
 * - `record_data` on: the narrative under the chart, plain text;
 * - a KPI, "Couldn't answer this yet", an error; Enter, Shift+Enter, Escape;
 * - Vietnamese, dark, 375 px: a bottom sheet, no horizontal scroll.
 *
 * axe on every state. Screenshots and a short film for the design report
 * only with `T914_SHOTS=<dir>`.
 */

test.use({ timezoneId: 'Asia/Ho_Chi_Minh' });

const RUN = Date.now().toString(36);
const SHOTS = process.env['T914_SHOTS'];
const ADMIN_EMAIL = WORKER_ORG.email('admin');
const SALES1_EMAIL = WORKER_ORG.email('sales1');
const SALES2_EMAIL = WORKER_ORG.email('sales2');
const QUESTION = 'Doanh thu theo tháng';
const NARRATIVE = 'Tháng 9 có doanh thu cao nhất (300).\nTháng 10 thấp nhất.';

/** A plan of the model, by name, every key (CONTRACTS §29.4). */
function plan(extra: Record<string, unknown> = {}) {
  return {
    content: JSON.stringify({
      answerable: true,
      chart: 'line',
      title: QUESTION,
      metric: { aggregation: 'sum', field: 'amount' },
      dimension: { field: 'ngày', date_bucket: 'month' },
      series: null,
      filter: null,
      sort: null,
      limit: null,
      compare: null,
      ...extra,
    }),
  };
}

let fake: FakeLlm;
const fx = { orgId: '', baseId: '', orders: '', allowlistId: '' };

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
    video?: string;
  } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const viewport = options.viewport ?? { width: 1440, height: 900 };
  const context = await browser.newContext({
    viewport,
    locale: 'en-US',
    timezoneId: 'Asia/Ho_Chi_Minh',
    colorScheme: options.colorScheme ?? 'light',
    ...(options.video === undefined ? {} : { recordVideo: { dir: options.video, size: viewport } }),
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
    // The newest question at the top of the panel, as after it was asked.
    await page.evaluate(() => {
      [...document.querySelectorAll('[data-testid="ask-entry"]')].at(-1)?.scrollIntoView({
        block: 'start',
      });
    });
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

/** The grid of Orders, then "Ask AI": the panel with the box focused. */
async function openPanel(page: Page, name = 'Ask AI'): Promise<Locator> {
  await page.goto(`/b/${fx.baseId}/t/${fx.orders}`);
  await page.getByTestId('ask-ai-button').click();
  const panel = page.getByRole('dialog', { name });
  await expect(panel.getByTestId('ask-input')).toBeFocused();
  return panel;
}

/** Types the question and Enter; resolves with the request body. */
async function ask(page: Page, panel: Locator, question = QUESTION) {
  const sent = page.waitForRequest((request) => request.url().endsWith('/ai/ask'));
  await panel.getByTestId('ask-input').fill(question);
  await panel.getByTestId('ask-input').press('Enter');
  return (await sent).postDataJSON() as Record<string, unknown>;
}

/** "View as table" of the last answer: its rows as "group: value". */
async function answerRows(answer: Locator): Promise<string[]> {
  await answer.getByRole('button', { name: /View as table|Xem dạng bảng/u }).click();
  const rows = answer.getByTestId('widget-data-table').locator('tbody tr');
  return rows.evaluateAll((items) =>
    items.map((row) => [...row.children].map((cell) => cell.textContent.trim()).join(': ')),
  );
}

async function buildFixture(page: Page): Promise<void> {
  const me = await ok<{ orgs: { id: string; name: string }[] }>(page, 'GET', '/me');
  fx.orgId = me.orgs.find((org) => org.name === WORKER_ORG.orgName)?.id ?? '';
  const workspace = await ok<{ id: string }>(page, 'POST', `/orgs/${fx.orgId}/workspaces`, {
    name: `T914 ${RUN}`,
  });
  const base = await ok<{ id: string }>(page, 'POST', `/workspaces/${workspace.id}/bases`, {
    name: `Hỏi AI T914 ${RUN}`,
  });
  fx.baseId = base.id;
  const orders = await ok<{ id: string; primary_field_id: string }>(
    page,
    'POST',
    `/bases/${base.id}/tables`,
    { name: 'Orders', primary_field_name: 'title' },
  );
  fx.orders = orders.id;
  const add = async (name: string, type: string, options: unknown = {}) =>
    (await ok<{ id: string }>(page, 'POST', `/tables/${orders.id}/fields`, { name, type, options }))
      .id;
  const owner = await add('owner', 'user', { multiple: false });
  const amount = await add('amount', 'number');
  const date = await add('ngày', 'datetime', { style: { format: 'yyyy-MM-dd HH:mm' } });
  const principals = await ok<{ items: { principal_id: string; email: string | null }[] }>(
    page,
    'GET',
    `/bases/${base.id}/principals?limit=200`,
  );
  const user = (email: string) =>
    principals.items.find((item) => item.email === email)?.principal_id ?? '';
  const sales1 = user(SALES1_EMAIL);
  await ok(page, 'POST', `/tables/${orders.id}/records?field_key_type=id`, {
    records: [
      {
        fields: {
          [orders.primary_field_id]: 'r1',
          [owner]: [{ id: sales1 }],
          [amount]: 100,
          // 23:30 UTC on the last day of September: October in Ho Chi Minh City.
          [date]: '2026-09-30T23:30:00.000Z',
        },
      },
      {
        fields: {
          [orders.primary_field_id]: 'r2',
          [owner]: [{ id: user(SALES2_EMAIL) }],
          [amount]: 200,
          [date]: '2026-08-15T03:00:00.000Z',
        },
      },
      {
        fields: {
          [orders.primary_field_id]: 'r3',
          [amount]: 300,
          [date]: '2026-09-10T03:00:00.000Z',
        },
      },
    ],
  });
  const role = await ok<{ id: string }>(page, 'POST', `/bases/${base.id}/roles`, {
    name: `Sales ${RUN}`,
    config: {
      base_rule: { copy: false, download: false, share_link: false },
      tables: {
        [orders.id]: {
          perm: 'read_only',
          view_rule: { allow_edit: false, visible_views: null },
          record_rule: {
            operations: [],
            edit_filter: null,
            read_scope: 'filter',
            read_filter: {
              op: 'and',
              items: [{ field: owner, operator: 'has_any_of', value: [{ $var: 'current_user' }] }],
            },
          },
        },
      },
      dashboards: {},
    },
  });
  await ok(page, 'PUT', `/bases/${base.id}/role-assignments`, {
    principal_type: 'user',
    principal_id: sales1,
    role_id: role.id,
  });
}

async function setRecordData(page: Page, on: boolean) {
  await ok(page, 'PUT', `/orgs/${fx.orgId}/ai-settings`, {
    allow_record_data: on,
    ...(on ? { confirm: true } : {}),
  });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  fake = await startOwnFakeLlm();
  const { context, page } = await openAs(browser, ADMIN_EMAIL);
  await buildFixture(page);
  // This spec's provider: a loopback host opens with its exact `host:port` entry only.
  const entry = await ok<{ id: string }>(page, 'POST', `/orgs/${fx.orgId}/http-allowlist`, {
    pattern: new URL(fake.baseUrl).host,
    note: 'T914 fake AI provider',
  });
  fx.allowlistId = entry.id;
  await ok(page, 'PUT', `/orgs/${fx.orgId}/ai-settings`, {
    enabled: true,
    provider_base_url: fake.baseUrl,
    model: FAKE_LLM_MODEL,
    api_key: null,
    allow_record_data: false,
  });
  await context.close();
});

test.afterAll(async ({ browser }) => {
  // Back to the stack's provider (the worker fixture's setting) for the next specs.
  const { context, page } = await openAs(browser, ADMIN_EMAIL);
  await ok(page, 'PUT', `/orgs/${fx.orgId}/ai-settings`, {
    enabled: true,
    provider_base_url: fakeLlmBaseUrl(),
    model: FAKE_LLM_MODEL,
    api_key: null,
    allow_record_data: false,
  });
  if (fx.allowlistId !== '') await ok(page, 'DELETE', `/http-allowlist/${fx.allowlistId}`);
  if (fx.baseId !== '') await api(page, 'DELETE', `/bases/${fx.baseId}`);
  await context.close();
  await fake.close();
});

test('revenue by month: u_sales1 sees r1 only, u_admin all three; no ECharts before a chart', async ({
  browser,
}) => {
  const sales = await openAs(browser, SALES1_EMAIL);
  const csp = collectCspViolations(sales.page);
  const charts: string[] = [];
  sales.page.on('request', (request) => {
    if (/\/assets\/EChart-[^/]*\.js$/u.test(request.url())) charts.push(request.url());
  });
  const panel = await openPanel(sales.page);
  await expect(panel.getByTestId('ask-suggestion')).toHaveCount(3);
  await expect(panel.getByTestId('ask-suggestion').first()).toHaveText('Total amount by month');
  await expect(sales.page.locator('.ob-grid canvas').first()).toBeVisible();
  // The grid and the open panel: no ECharts yet.
  expect(charts).toEqual([]);
  await expectNoSeriousA11yViolations(sales.page, 'Ask AI, empty');
  await shots(sales.page, 'empty');

  const before = fake.chatRequests().length;
  fake.script(plan());
  expect(await ask(sales.page, panel)).toEqual({
    question: QUESTION,
    timezone: 'Asia/Ho_Chi_Minh',
  });
  const answer = panel.getByTestId('ask-answer');
  await expect(answer.getByRole('heading', { level: 3 })).toHaveText(QUESTION);
  await expect(answer.getByTestId('ask-interpretation').getByRole('listitem')).toHaveText([
    'Sum of amount',
    'By ngày, per month',
  ]);
  await expect(answer.getByTestId('widget-chart')).toHaveAccessibleName(/Line chart/u);
  expect(charts.length).toBeGreaterThan(0);
  // `record_data` off: one call (the plan), no narrative.
  expect(fake.chatRequests().length - before).toBe(1);
  await expect(answer.getByTestId('ask-narrative')).toHaveCount(0);
  await expectNoSeriousA11yViolations(sales.page, 'Ask AI, a chart answer');
  // P79 through the UI: the numbers of the records u_sales1 reads — r1, in October.
  expect(await answerRows(answer)).toEqual(['Oct 2026: 100']);
  expect(csp).toEqual([]);
  await sales.context.close();

  const admin = await openAs(browser, ADMIN_EMAIL);
  const adminPanel = await openPanel(admin.page);
  fake.script(plan());
  await ask(admin.page, adminPanel);
  const adminAnswer = adminPanel.getByTestId('ask-answer');
  await expect(adminAnswer.getByTestId('widget-chart')).toBeVisible();
  expect(await answerRows(adminAnswer)).toEqual([
    'Aug 2026: 200',
    'Sep 2026: 300',
    'Oct 2026: 100',
  ]);
  await admin.context.close();
});

test('record data on: the narrative in plain text under the chart', async ({ browser }) => {
  const { context, page } = await openAs(browser, ADMIN_EMAIL);
  await setRecordData(page, true);
  try {
    const panel = await openPanel(page);
    await expect(panel.getByTestId('ask-privacy')).toContainText('to write a short summary');
    const before = fake.chatRequests().length;
    fake.script(plan(), { content: NARRATIVE });
    await ask(page, panel);
    const answer = panel.getByTestId('ask-answer');
    const narrative = answer.getByTestId('ask-narrative');
    await expect(narrative).toContainText('Tháng 9 có doanh thu cao nhất (300).');
    await expect(answer.getByTestId('ask-interpretation')).toContainText('Sum of amount');
    // The narrative call had aggregated numbers only, never a record id.
    expect(fake.chatRequests().length - before).toBe(2);
    expect(JSON.stringify(fake.chatRequests().at(-1)?.body)).not.toContain('rec_');
    await expectNoSeriousA11yViolations(page, 'Ask AI, chart with a narrative');
    await shots(page, 'chart-narrative');
  } finally {
    await setRecordData(page, false);
    await context.close();
  }
});

test('a KPI, "Couldn\'t answer this yet", an error; Enter, Shift+Enter, Escape', async ({
  browser,
}) => {
  const { context, page } = await openAs(browser, ADMIN_EMAIL);
  const panel = await openPanel(page);
  const input = panel.getByTestId('ask-input');

  await test.step('Shift+Enter is a new line, Enter asks', async () => {
    await input.pressSequentially('Tổng');
    await input.press('Shift+Enter');
    await input.pressSequentially('doanh thu');
    await expect(input).toHaveValue('Tổng\ndoanh thu');
    fake.script(plan({ chart: 'kpi', title: 'Tổng doanh thu', dimension: null }));
    const sent = page.waitForRequest((request) => request.url().endsWith('/ai/ask'));
    await input.press('Enter');
    expect((await sent).postDataJSON()).toMatchObject({ question: 'Tổng\ndoanh thu' });
    const kpi = panel.getByTestId('ask-answer').last();
    await expect(kpi.getByTestId('kpi-value')).toHaveText('600');
    await expectNoSeriousA11yViolations(page, 'Ask AI, a KPI');
    await shots(page, 'kpi');
  });

  await test.step('the wait says what happens; "Cancel" gives the question back', async () => {
    fake.script({ ...plan(), delayMs: 20_000 });
    await ask(page, panel, 'Doanh thu theo quý');
    const waiting = panel.getByTestId('ai-waiting');
    await expect(waiting.getByRole('status')).toContainText('Understanding the question…');
    await expectNoSeriousA11yViolations(page, 'Ask AI, waiting');
    await shots(page, 'waiting');
    await waiting.getByRole('button', { name: 'Cancel' }).click();
    await expect(waiting).toHaveCount(0);
    await expect(input).toHaveValue('Doanh thu theo quý');
    await expect(input).toBeFocused();
  });

  await test.step('"Couldn\'t answer this yet" names no field', async () => {
    fake.script(plan({ answerable: false }));
    await ask(page, panel, 'Ai bán nhiều nhất năm ngoái?');
    const card = panel.getByTestId('ask-unanswerable');
    await expect(card).toContainText("Couldn't answer this yet");
    await expect(card).not.toContainText('amount');
    await expect(card).not.toContainText('ngày');
    await expectNoSeriousA11yViolations(page, 'Ask AI, unanswerable');
    await shots(page, 'unanswerable');
  });

  await test.step('an error of the provider, with "Try again"', async () => {
    fake.script({ status: 500 });
    await ask(page, panel, QUESTION);
    const error = panel.getByTestId('ask-error');
    await expect(error.getByTestId('ask-error-message')).toHaveText(
      'The AI provider could not be reached or answered with an error.',
    );
    await expect(error.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expectNoSeriousA11yViolations(page, 'Ask AI, error');
    await shots(page, 'error');
  });

  await test.step('Escape closes and gives the focus back to "Ask AI"', async () => {
    await input.focus();
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(page.getByTestId('ask-ai-button')).toBeFocused();
    // The session's questions are still there when it opens again.
    await page.getByTestId('ask-ai-button').click();
    await expect(page.getByRole('dialog', { name: 'Ask AI' }).getByTestId('ask-entry')).toHaveCount(
      3,
    );
  });
  await context.close();
});

test('Vietnamese, dark, 375 px: a bottom sheet without horizontal scroll', async ({ browser }) => {
  const { context, page } = await openAs(browser, SALES1_EMAIL, {
    viewport: { width: 375, height: 812 },
    language: 'vi',
    colorScheme: 'dark',
  });
  const panel = await openPanel(page, 'Hỏi AI');
  // Measured once the sheet has slid in (24 px, `animate-sheet-in`).
  await animationsSettled(page);
  const box = await panel.boundingBox();
  // A sheet from the bottom edge, the full width.
  expect(box?.width).toBe(375);
  expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBe(812);
  await expect(panel.getByTestId('ask-suggestion').first()).toHaveText('Tổng amount theo tháng');
  fake.script(plan());
  await ask(page, panel);
  const answer = panel.getByTestId('ask-answer');
  await expect(answer.getByText('Cách hiểu')).toBeVisible();
  await expect(answer.getByTestId('ask-interpretation')).toContainText('Theo ngày, từng tháng');
  await noHorizontalScroll(page, 375);
  await expectNoSeriousA11yViolations(page, 'Hỏi AI, vi, dark, 375 px');
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await context.close();
});

test('the flow on film (design report only)', async ({ browser }) => {
  test.skip(SHOTS === undefined, 'only with T914_SHOTS');
  const { context, page } = await openAs(browser, ADMIN_EMAIL, {
    video: `${SHOTS ?? ''}/flow-video`,
  });
  await page.goto(`/b/${fx.baseId}/t/${fx.orders}`);
  await page.waitForTimeout(600);
  await page.getByTestId('ask-ai-button').click();
  const panel = page.getByRole('dialog', { name: 'Ask AI' });
  await page.waitForTimeout(800);
  fake.script({ ...plan(), delayMs: 2_500 });
  await panel.getByTestId('ask-input').pressSequentially(QUESTION, { delay: 40 });
  await panel.getByTestId('ask-input').press('Enter');
  await expect(panel.getByTestId('widget-chart')).toBeVisible({ timeout: 15_000 });
  await animationsSettled(page);
  await page.waitForTimeout(1_200);
  await panel.getByRole('button', { name: 'View as table' }).click();
  await page.waitForTimeout(1_200);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  await context.close();
});
