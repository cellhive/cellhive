import { mkdirSync } from 'node:fs';

import { type APIRequestContext, type Browser, type Page } from '@playwright/test';

import { expect, test, WORKER_ORG, type DemoUserKey } from './fixtures';
import {
  animationsSettled,
  apiSignIn,
  collectCspViolations,
  expectNoSeriousA11yViolations,
  ok,
} from './support';

/**
 * T1015: the MCP tool `draft_automation` and its builder link (CONTRACTS
 * §30.8, FRONTEND §13.2) in the worker's demo organization. u_admin's token
 * (`schema:read` + `automations:read`) drafts the S8 milestone plus a
 * Telegram step to a chat written in the draft; the tool answers an
 * `open_url`. Opened with u_admin's session, the builder shows the draft
 * unsaved and off, the "Draft from an MCP client" band and the chat warning;
 * saving creates it turned off. Another user — u_editor, made an
 * organization admin for the spec so that they can open the builder — gets
 * "This draft does not exist" and `404` from the API. `afterAll` deletes the
 * automation, revokes the token, turns MCP off and gives u_editor their
 * role back. Screenshots for the design report only with `T1015_SHOTS=<dir>`.
 */

const SHOTS = process.env['T1015_SHOTS'];
const RUN = String(Date.now()).slice(-6);
const NAME = `E2E MCP draft ${RUN}`;
const CHAT = '-1001234567890';
const BOT = 'Bot CSKH (demo)';
const OFF = { enabled: false, allow_writes: false, allow_schema_writes: false };

const demo = { orgId: '', baseId: '', tickets: '', editorId: '' };
let token = '';
let openPath = '';
let draftId = '';
let savedId = '';

async function openAs(
  browser: Browser,
  user: DemoUserKey,
  options: { viewport?: { width: number; height: number }; language?: 'en' | 'vi' } = {},
) {
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1440, height: 900 },
    locale: 'en-US',
  });
  await context.addInitScript((language) => {
    window.localStorage.setItem('cellhive.language', language);
  }, options.language ?? 'en');
  const page = await context.newPage();
  await page.goto('/login');
  await apiSignIn(page, WORKER_ORG.email(user), WORKER_ORG.password);
  return { context, page };
}

/** `tools/call draft_automation` with only the Bearer token, like an MCP client (2025 era). */
async function draftAutomation(request: APIRequestContext, args: unknown) {
  const response = await request.post('/api/v1/mcp', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': '2025-06-18',
    },
    data: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'draft_automation', arguments: args },
    },
  });
  expect(response.status(), await response.text()).toBe(200);
  const body = (await response.json()) as {
    result: { isError?: boolean; structuredContent: Record<string, unknown> };
  };
  return body.result;
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
      await page.getByTestId('ai-draft-banner').scrollIntoViewIfNeeded();
      await shot(page, `${name}-${String(width)}-${colorScheme}`);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  const { context, page } = await openAs(browser, 'admin');
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
  const members = await ok<{ items: { user: { id: string; email: string } }[] }>(
    page,
    'GET',
    `/orgs/${demo.orgId}/members?limit=100`,
  );
  demo.editorId =
    members.items.find((member) => member.user.email === WORKER_ORG.email('editor'))?.user.id ?? '';
  expect(demo.editorId).not.toBe('');
  await ok(page, 'PATCH', `/orgs/${demo.orgId}`, { settings: { mcp: { ...OFF, enabled: true } } });
  const created = await ok<{ token: string }>(page, 'POST', `/orgs/${demo.orgId}/me/api-tokens`, {
    name: `E2E draft ${RUN}`,
    scopes: ['schema:read', 'automations:read'],
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  token = created.token;
  await context.close();
});

test.afterAll(async ({ browser }) => {
  const { context, page } = await openAs(browser, 'admin');
  if (savedId !== '') await ok(page, 'DELETE', `/automations/${savedId}`);
  const mine = await ok<{ items: { id: string; name: string; revoked_at: string | null }[] }>(
    page,
    'GET',
    `/orgs/${demo.orgId}/me/api-tokens?limit=100`,
  );
  for (const item of mine.items.filter(
    (row) => row.revoked_at === null && row.name.startsWith('E2E draft'),
  )) {
    await ok(page, 'DELETE', `/api-tokens/${item.id}`);
  }
  await ok(page, 'PATCH', `/orgs/${demo.orgId}`, { settings: { mcp: OFF } });
  await ok(page, 'PATCH', `/orgs/${demo.orgId}/members/${demo.editorId}`, { role: 'member' });
  await context.close();
});

test('the creator opens open_url: the draft unsaved and off, the MCP band and the chat warning; saved off', async ({
  browser,
  request,
}) => {
  await test.step('an MCP client drafts the milestone and a Telegram step', async () => {
    const result = await draftAutomation(request, {
      base_id: demo.baseId,
      table_id: demo.tickets,
      draft: {
        name: NAME,
        trigger: { type: 'record.updated', watch_fields: ['Trạng thái'], changed_to: 'Đã xong' },
        actions: [
          {
            type: 'send_notification',
            recipients: ['Phụ trách'],
            title: 'Ticket {{ [Tiêu đề] }} đã xong',
          },
          { type: 'send_telegram', bot: BOT, chat_id: CHAT, text: '{{ [Tiêu đề] }} đã xong' },
        ],
        explanation: 'Báo người phụ trách và nhóm CSKH khi ticket xong.',
      },
    });
    expect(result.isError ?? false, JSON.stringify(result.structuredContent)).toBe(false);
    const data = result.structuredContent as {
      open_url: string;
      warnings: { code: string; action_id?: string }[];
    };
    expect(data.warnings).toEqual([
      expect.objectContaining({ code: 'literal_chat_id', action_id: 'act_2' }),
    ]);
    const url = new URL(data.open_url);
    expect(url.pathname).toBe(`/b/${demo.baseId}/automations/new`);
    draftId = url.searchParams.get('draft') ?? '';
    expect(draftId).toMatch(/^mdr_[0-9A-Za-z]{16}$/u);
    openPath = `${url.pathname}${url.search}`;
  });

  const { context, page } = await openAs(browser, 'admin');
  const csp = collectCspViolations(page);
  await test.step('the builder shows the draft with its band and the chat warning', async () => {
    await page.goto(openPath);
    const banner = page.getByTestId('ai-draft-banner');
    await expect(banner).toBeVisible();
    await expect(banner.getByRole('heading')).toHaveText(
      'Draft from an MCP client — check before saving',
    );
    await expect(banner.getByTestId('ai-draft-explanation')).toHaveText(
      'Báo người phụ trách và nhóm CSKH khi ticket xong.',
    );
    await expect(banner.getByTestId('ai-draft-warning-literal_chat_id')).toHaveText(
      `Telegram chat written in the draft: step 2 posts to ${CHAT}, written into the draft ` +
        'rather than taken from a field. Save it only if this group or channel is yours.',
    );
    await expect(page.getByTestId('builder-title')).toHaveText(NAME);
    await expect(page.getByTestId('step-trigger')).toContainText('When a record is updated');
    await expect(page.getByTestId('step-act_1')).toContainText('Phụ trách');
    await expect(page.getByTestId('step-act_2')).toContainText('Telegram');
    const enabled = page.getByTestId('builder-enabled');
    await expect(enabled).not.toBeChecked();
    await expect(enabled).toBeDisabled();
    await expectNoSeriousA11yViolations(page, 'MCP draft in the builder');
    await shots(page, 'mcp-draft-en');
  });

  await test.step('saving creates the automation turned off', async () => {
    await page.getByTestId('builder-save').click();
    await expect(page).toHaveURL(/\/automations\/aut_[^/]+$/u);
    savedId = new URL(page.url()).pathname.split('/').at(-1) ?? '';
    await expect(page.getByTestId('ai-draft-banner')).toHaveCount(0);
    const saved = await ok<{ name: string; enabled: boolean; definition: { actions: unknown[] } }>(
      page,
      'GET',
      `/automations/${savedId}`,
    );
    expect(saved).toMatchObject({ name: NAME, enabled: false });
    expect(saved.definition.actions).toHaveLength(2);
    await page.goto(`/b/${demo.baseId}/automations`);
    await expect(page.getByRole('switch', { name: `Turn on ${NAME}` })).not.toBeChecked();
  });
  expect(csp).toEqual([]);
  await context.close();
});

test('Vietnamese: the same band and warning, light and dark, 1440 and 375 px', async ({
  browser,
}) => {
  const { context, page } = await openAs(browser, 'admin', { language: 'vi' });
  await page.goto(openPath);
  const banner = page.getByTestId('ai-draft-banner');
  await expect(banner.getByRole('heading')).toHaveText(
    'Bản nháp từ client MCP — kiểm tra trước khi lưu',
  );
  await expect(banner.getByTestId('ai-draft-warning-literal_chat_id')).toHaveText(
    `Chat Telegram ghi sẵn trong bản nháp: bước 2 gửi tới ${CHAT}, được ghi sẵn trong bản ` +
      'nháp thay vì lấy từ một trường. Chỉ lưu nếu nhóm hoặc kênh này là của bạn.',
  );
  await shots(page, 'mcp-draft-vi');
  await page.setViewportSize({ width: 375, height: 812 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(375);
  await expectNoSeriousA11yViolations(page, 'MCP draft at 375 px (vi)');
  await context.close();
});

test('another user opening the same open_url gets 404: no draft, no builder', async ({
  browser,
}) => {
  const admin = await openAs(browser, 'admin');
  await ok(admin.page, 'PATCH', `/orgs/${demo.orgId}/members/${demo.editorId}`, { role: 'admin' });
  await admin.context.close();

  const { context, page } = await openAs(browser, 'editor');
  const response = await page.request.get(
    `/api/v1/bases/${demo.baseId}/automation-drafts/${draftId}`,
  );
  expect(response.status()).toBe(404);
  await page.goto(openPath);
  const message = page.getByTestId('builder-message');
  await expect(message).toContainText('This draft does not exist or has expired');
  await expect(page.getByTestId('ai-draft-banner')).toHaveCount(0);
  await expect(page.getByTestId('builder-save')).toHaveCount(0);
  await expectNoSeriousA11yViolations(page, 'MCP draft of someone else');
  await shot(page, 'mcp-draft-other-user-404');
  await context.close();
});
