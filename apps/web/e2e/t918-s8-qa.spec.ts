import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';

import { FAKE_LLM_MODEL, fakeLlmBaseUrl, startOwnFakeLlm, type FakeLlm } from './fake-llm';
import { expect, test, WORKER_ORG } from './fixtures';
import { DEMO_PASSWORD } from './seed';
import { animationsSettled, apiSignIn, collectCspViolations, ok } from './support';

/**
 * T918 (QA S8): every S8 screen, audited the way T819 audited S7 — axe
 * (WCAG 2.2 AA tags) without a serious or critical violation, no horizontal
 * scrolling, no CSP violation — in two passes: Vietnamese and light, English
 * and dark, each screen at 1440 px then 375 px:
 *
 * - the organization's AI settings and the MCP card of the token policy,
 *   with the confirmation of "Allow MCP clients" (cancelled);
 * - a table of the spec's own base with an AI field (values and a failed
 *   cell), "Ask AI" with a line chart, its interpretation and the narrative;
 * - "New field" as an AI field with the preview of 5 rows, then "Generate
 *   values for … existing rows?" (later);
 * - the formula editor with the AI suggestion;
 * - "Create an automation with AI" (≥ 768 px) and the draft in the builder;
 * - the builder's "Classify with AI" step (≥ 768 px: the builder is
 *   read-only on a phone).
 *
 * A fake provider of the spec's own answers by marker (the plan, the
 * narrative, the formula, the draft, the AI field values), so retries never
 * shift its answers; the worker's organization points at it while the spec
 * runs and goes back to the stack's provider afterwards. Each pass asks the
 * AI four times as u_admin: under the 10 requests a minute per person.
 *
 * Set `T918_SHOTS=<dir>` to save a JPEG of each audited screen (the design
 * audit of the QA report).
 */

const SHOTS = process.env['T918_SHOTS'];
const RUN = Date.now().toString(36);
const ADMIN_EMAIL = WORKER_ORG.email('admin');
const MARK = `QA918${RUN}`;
const QUESTION = 'Doanh thu theo tháng';
const SUMMARY = 'Khách báo máy in hoá đơn ở quầy không chạy.';

interface Variant {
  readonly name: string;
  readonly language: 'en' | 'vi';
  readonly colorScheme: 'light' | 'dark';
}

const PASSES: readonly Variant[] = [
  { name: 'light-vi', language: 'vi', colorScheme: 'light' },
  { name: 'dark-en', language: 'en', colorScheme: 'dark' },
];
const WIDE = { width: 1440, height: 900 };
const PHONE = { width: 375, height: 812 };

let fake: FakeLlm;
const fx = {
  orgId: '',
  orgSlug: '',
  baseId: '',
  table: '',
  allowlistId: '',
  aiField: '',
  severity: '',
};
let cookies: Awaited<ReturnType<BrowserContext['cookies']>> | null = null;

async function openAs(
  browser: Browser,
  variant: Variant,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: WIDE,
    locale: 'en-US',
    timezoneId: 'Asia/Ho_Chi_Minh',
    colorScheme: variant.colorScheme,
  });
  await context.addInitScript((value) => {
    window.localStorage.setItem('cellhive.language', value);
  }, variant.language);
  const page = await context.newPage();
  await page.goto('/login');
  if (cookies === null) {
    await apiSignIn(page, ADMIN_EMAIL, DEMO_PASSWORD);
    cookies = await context.cookies();
  } else {
    await context.addCookies(cookies);
  }
  return { context, page };
}

/** axe (no serious/critical), no horizontal scroll; a JPEG with `T918_SHOTS`. */
async function audit(page: Page, label: string): Promise<void> {
  await animationsSettled(page);
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const serious = results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => ({
      id: violation.id,
      targets: violation.nodes.map((node) => node.target.join(' ')),
    }));
  expect(serious, `axe violations on ${label}`).toEqual([]);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), {
      message: `horizontal scroll on ${label}`,
    })
    .toBeLessThanOrEqual(0);
  if (SHOTS !== undefined) {
    await mkdir(SHOTS, { recursive: true });
    await page.screenshot({
      path: join(SHOTS, `${label.replace(/[^a-z0-9-]+/giu, '-')}.jpg`),
      type: 'jpeg',
      quality: 60,
    });
  }
}

/** The state at 1440 px, then at 375 px (`phone: false`: desktop-only screens), back to 1440. */
async function auditBoth(
  page: Page,
  variant: Variant,
  name: string,
  options: { phone?: boolean; scroll?: Locator } = {},
): Promise<void> {
  await page.setViewportSize(WIDE);
  await options.scroll?.scrollIntoViewIfNeeded().catch(() => undefined);
  await audit(page, `${name}-1440-${variant.name}`);
  if (options.phone === false) return;
  await page.setViewportSize(PHONE);
  await options.scroll?.scrollIntoViewIfNeeded().catch(() => undefined);
  await audit(page, `${name}-375-${variant.name}`);
  await page.setViewportSize(WIDE);
}

/** A plan of the model, by name (CONTRACTS §29.4). */
const PLAN = {
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
};

/** The draft of "when an order is created, tell its owner", by name (CONTRACTS §29.3). */
function draft(name: string) {
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
      type: 'record.created',
      table: 'Đơn hàng',
      watch_fields: null,
      changed_to: null,
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
        recipients: ['owner'],
        title: 'Đơn mới: {{ [title] }}',
        text: '',
      },
    ],
    explanation: 'Báo cho người phụ trách đơn qua kênh thông báo của họ.',
    warnings: [],
  };
}

async function buildFixture(page: Page): Promise<void> {
  const me = await ok<{ orgs: { id: string; name: string; slug: string }[] }>(page, 'GET', '/me');
  const org = me.orgs.find((item) => item.name === WORKER_ORG.orgName);
  fx.orgId = org?.id ?? '';
  fx.orgSlug = org?.slug ?? '';
  const workspace = await ok<{ id: string }>(page, 'POST', `/orgs/${fx.orgId}/workspaces`, {
    name: `T918 ${RUN}`,
  });
  const base = await ok<{ id: string }>(page, 'POST', `/workspaces/${workspace.id}/bases`, {
    name: `QA S8 T918 ${RUN}`,
  });
  fx.baseId = base.id;
  const table = await ok<{ id: string; primary_field_id: string }>(
    page,
    'POST',
    `/bases/${base.id}/tables`,
    { name: 'Đơn hàng', primary_field_name: 'title' },
  );
  fx.table = table.id;
  const add = async (name: string, type: string, options: unknown = {}) =>
    await ok<{ id: string; options: { options?: { id: string; name: string }[] } }>(
      page,
      'POST',
      `/tables/${table.id}/fields`,
      { name, type, options },
    );
  await add('owner', 'user', { multiple: false });
  const amount = (await add('amount', 'number')).id;
  const date = (await add('ngày', 'datetime', { style: { format: 'yyyy-MM-dd HH:mm' } })).id;
  const text = (await add('Mô tả', 'text')).id;
  fx.severity = (
    await add('Mức độ', 'select', {
      options: [{ name: 'Thấp' }, { name: 'Cao' }],
      multiple: false,
    })
  ).id;
  const rows = [
    ['ĐH-1 Cty Dương', 120, '2026-08-12T03:00:00Z', `${MARK} Máy in hoá đơn không chạy`],
    ['ĐH-2 Công ty Đặng', 240, '2026-09-03T03:00:00Z', `${MARK} Đổi địa chỉ giao hàng`],
    ['ĐH-3 Chi nhánh Đào', 90, '2026-09-21T03:00:00Z', `${MARK}-FAIL Yêu cầu xuất hoá đơn`],
    ['ĐH-4 Trung tâm Tăng', 310, '2026-10-02T03:00:00Z', `${MARK} Khiếu nại giao trễ`],
  ] as const;
  await ok(page, 'POST', `/tables/${table.id}/records?field_key_type=id`, {
    records: rows.map(([title, value, at, body]) => ({
      fields: { [table.primary_field_id]: title, [amount]: value, [date]: at, [text]: body },
    })),
  });
  // An AI field with values and one failed cell (a 400 for the "-FAIL" record).
  const field = await add('Tóm tắt AI', 'text', {
    ai: { task: 'summarize', prompt: 'Tóm tắt: {{ [Mô tả] }}', auto_update: false },
  });
  fx.aiField = field.id;
  await ok(page, 'POST', `/fields/${field.id}/ai/generate`, { scope: 'all' });
  await expect
    .poll(
      async () => {
        const job = await ok<{ ai_state?: { queued: number; failed: number } }>(
          page,
          'GET',
          `/fields/${field.id}`,
        );
        return job.ai_state;
      },
      { timeout: 60_000 },
    )
    .toMatchObject({ queued: 0, failed: 1 });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  fake = await startOwnFakeLlm();
  // Answers by marker of the last message (first match wins): never shifted by a retry.
  fake.when(`${MARK}-FAIL`, { status: 400 });
  fake.when(MARK, { content: SUMMARY });
  fake.when('Result (JSON)', {
    content: 'Doanh thu cao nhất vào tháng 9 (330). Tháng 8 và tháng 10 thấp hơn.',
  });
  fake.when('The table and the fields the plan may use', { content: JSON.stringify(PLAN) });
  fake.when('Description of the formula to write', {
    content: JSON.stringify({ formula: '[amount] * 2', explanation: 'Gấp đôi amount.' }),
  });
  fake.when('Sentence:', { content: JSON.stringify(draft(`Báo đơn mới ${RUN}`)) });
  const { context, page } = await openAs(browser, PASSES[0] as Variant);
  const me = await ok<{ orgs: { id: string; name: string }[] }>(page, 'GET', '/me');
  const orgId = me.orgs.find((item) => item.name === WORKER_ORG.orgName)?.id ?? '';
  const entry = await ok<{ id: string }>(page, 'POST', `/orgs/${orgId}/http-allowlist`, {
    pattern: new URL(fake.baseUrl).host,
    note: 'T918 fake AI provider',
  });
  fx.allowlistId = entry.id;
  await ok(page, 'PUT', `/orgs/${orgId}/ai-settings`, {
    enabled: true,
    provider_base_url: fake.baseUrl,
    model: FAKE_LLM_MODEL,
    api_key: null,
    allow_record_data: true,
    confirm: true,
  });
  await buildFixture(page);
  await context.close();
});

test.afterAll(async ({ browser }) => {
  // Back to the stack's provider, record values off (the worker fixture's setting).
  const { context, page } = await openAs(browser, PASSES[0] as Variant);
  await ok(page, 'PUT', `/orgs/${fx.orgId}/ai-settings`, {
    enabled: true,
    provider_base_url: fakeLlmBaseUrl(),
    model: FAKE_LLM_MODEL,
    api_key: null,
    allow_record_data: false,
  });
  if (fx.allowlistId !== '') await ok(page, 'DELETE', `/http-allowlist/${fx.allowlistId}`);
  await context.close();
  await fake.close();
});

for (const variant of PASSES) {
  test(`every S8 screen, ${variant.name}, at 1440 and 375 px`, async ({ browser }) => {
    test.setTimeout(240_000);
    const { context, page } = await openAs(browser, variant);
    const csp = collectCspViolations(page);

    await test.step('settings: AI, then the MCP card and its confirmation', async () => {
      await page.goto(`/o/${fx.orgSlug}/settings/ai`);
      await expect(page.getByTestId('ai-settings-form')).toBeVisible();
      await auditBoth(page, variant, 'settings-ai');
      await page.goto(`/o/${fx.orgSlug}/settings/api-tokens?tab=policy`);
      const policy = page.getByTestId('mcp-policy');
      await expect(policy).toBeVisible();
      await auditBoth(page, variant, 'settings-mcp', { scroll: policy });
      const enabled = policy.getByTestId('mcp-enabled');
      if (!(await enabled.isChecked())) {
        await enabled.click();
        const confirm = page.getByTestId('mcp-confirm-enabled');
        await expect(confirm).toBeVisible();
        await auditBoth(page, variant, 'settings-mcp-confirm');
        await page.keyboard.press('Escape');
        await expect(confirm).toHaveCount(0);
        await expect(enabled).not.toBeChecked();
      }
    });

    await test.step('the grid with an AI field, "Ask AI" with chart and narrative', async () => {
      await page.goto(`/b/${fx.baseId}/t/${fx.table}`);
      await expect(page.locator('table[role="grid"] td[role="gridcell"]').first()).toBeAttached();
      await expect(page.locator('table[role="grid"]')).toContainText(SUMMARY);
      await auditBoth(page, variant, 'grid-ai-field');
      await page.getByTestId('ask-ai-button').click();
      const panel = page.getByRole('dialog', { name: /Ask AI|Hỏi AI/u });
      await panel.getByTestId('ask-input').fill(QUESTION);
      await panel.getByTestId('ask-input').press('Enter');
      const answer = panel.getByTestId('ask-answer');
      await expect(answer.getByTestId('widget-chart')).toBeVisible({ timeout: 20_000 });
      await expect(answer.getByTestId('ask-narrative')).toContainText('tháng 9');
      await auditBoth(page, variant, 'ask-ai-answer');
      await page.keyboard.press('Escape');
    });

    await test.step('"New field" as an AI field: the preview of 5 rows, then the generate dialog', async () => {
      await page.getByTestId('grid-toolbar-more').click();
      await page.getByRole('menuitem', { name: /Add field|Thêm trường/u }).click();
      const dialog = page.getByRole('dialog', { name: /New field|Trường mới/u });
      await dialog.getByLabel(/^(Name|Tên)$/u).fill(`AI ${variant.name} ${RUN}`);
      await dialog.getByLabel(/Field type|Kiểu trường/u).selectOption('ai');
      await expect(dialog.getByTestId('ai-field-section')).toBeVisible();
      await dialog.getByTestId('ai-preview-run').click();
      await expect(dialog.getByTestId('ai-preview-row')).toHaveCount(4);
      await auditBoth(page, variant, 'ai-field-preview', {
        scroll: dialog.getByTestId('ai-preview'),
      });
      await dialog.getByRole('button', { name: /Create field|Tạo trường/u }).click();
      const generate = page.getByRole('dialog', {
        name: /Generate values for|Sinh giá trị cho/u,
      });
      await expect(generate.getByTestId('ai-generate-later')).toBeVisible();
      await auditBoth(page, variant, 'ai-generate-dialog');
      await generate.getByTestId('ai-generate-later').click();
      await expect(generate).toHaveCount(0);
    });

    await test.step('the formula editor with the AI suggestion', async () => {
      await page.getByTestId('grid-toolbar-more').click();
      await page.getByRole('menuitem', { name: /Add field|Thêm trường/u }).click();
      const dialog = page.getByRole('dialog', { name: /New field|Trường mới/u });
      await dialog.getByLabel(/^(Name|Tên)$/u).fill(`Fx ${variant.name} ${RUN}`);
      await dialog.getByLabel(/Field type|Kiểu trường/u).selectOption('formula');
      await dialog.getByTestId('formula-open-editor').click();
      const editor = page.getByTestId('formula-editor');
      const box = editor.getByTestId('formula-ai');
      const describe = box.getByRole('textbox', { name: /Describe the formula|Mô tả công thức/u });
      await describe.fill('amount gấp đôi');
      await describe.press('Enter');
      await expect(editor.getByTestId('formula-ai-suggestion')).toBeVisible({ timeout: 20_000 });
      await auditBoth(page, variant, 'formula-ai-suggestion', {
        scroll: editor.getByTestId('formula-ai-suggestion'),
      });
      await page.keyboard.press('Escape');
    });

    await test.step('"Create an automation with AI" and the draft in the builder', async () => {
      await page.goto(`/b/${fx.baseId}/automations`);
      await page.getByTestId('create-automation-ai').first().click();
      const dialog = page.getByRole('dialog', {
        name: /Create an automation with AI|Tạo automation bằng AI/u,
      });
      await expect(dialog.getByTestId('ai-draft-example')).toHaveCount(3);
      await auditBoth(page, variant, 'automation-ai-dialog', { phone: false });
      const prompt = dialog.getByRole('textbox', {
        name: /What should the automation do\?|Automation cần làm gì\?/u,
      });
      await prompt.fill('Khi có đơn mới thì báo cho người phụ trách');
      await prompt.press('Enter');
      const banner = page.getByTestId('ai-draft-banner');
      await expect(banner).toBeVisible({ timeout: 20_000 });
      await auditBoth(page, variant, 'automation-ai-draft');
    });

    await test.step('the builder: "Classify with AI"', async () => {
      await page.goto(`/b/${fx.baseId}/automations/new?name=T918&trigger=record.created`);
      await page.getByTestId('add-step').click();
      await page.getByTestId('add-step-menu').getByTestId('add-ai_classify').click();
      const panel = page.getByTestId('config-panel');
      await expect(panel.getByTestId('ai-classify-panel')).toBeVisible();
      await auditBoth(page, variant, 'automation-ai-classify', { phone: false });
    });

    expect(csp).toEqual([]);
    await context.close();
  });
}
