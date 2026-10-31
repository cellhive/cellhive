import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { apiSignIn, collectCspViolations, expectNoSeriousA11yViolations, ok } from './support';

/**
 * T924: MCP on the API tokens page (FRONTEND §15.6, CONTRACTS §30.1) in the
 * worker's demo organization, as u_admin (organization owner):
 *
 * - MCP off (the default): no MCP preset in the create form and no "Connect
 *   via MCP" on a token that could connect — nothing about MCP renders on
 *   "Mine"; the policy tab shows the switch off;
 * - MCP on after the confirmation → a token from the "MCP — read only"
 *   preset (no "read & write" while writes are off): the "shown once" dialog
 *   holds the endpoint URL and the Claude Code, Cursor and VS Code
 *   configurations with the token, and the endpoint answers `tools/list`
 *   with that token (read tools only); from the list, the box carries the
 *   masked token;
 * - writes allowed after their confirmation → "MCP — read & write" offered;
 * - Vietnamese at 375 px: no horizontal scroll; axe on every state.
 *
 * `afterAll` revokes the tokens of the spec and turns MCP off again.
 */

const ADMIN_EMAIL = WORKER_ORG.email('admin');
const READ_TOOLS = [
  'list_bases',
  'list_tables',
  'describe_table',
  'query_records',
  'get_records',
  'aggregate_records',
];

interface Org {
  id: string;
  slug: string;
}

let org: Org;
let cookies: Awaited<ReturnType<BrowserContext['cookies']>> | null = null;

async function openAsAdmin(
  browser: Browser,
  options: { viewport?: { width: number; height: number }; language?: 'en' | 'vi' } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1440, height: 900 },
    locale: 'en-US',
  });
  await context.addInitScript((value) => {
    window.localStorage.setItem('cellhive.language', value);
  }, options.language ?? 'en');
  const page = await context.newPage();
  await page.goto('/login');
  if (cookies === null) {
    await apiSignIn(page, ADMIN_EMAIL, WORKER_ORG.password);
    cookies = await context.cookies();
  } else {
    await context.addCookies(cookies);
  }
  return { context, page };
}

async function setMcp(page: Page, mcp: { enabled?: boolean; allow_writes?: boolean }) {
  await ok(page, 'PATCH', `/orgs/${org.id}`, { settings: { mcp } });
}

/** Revokes the tokens of this spec (named `E2E …`; the seed's sample token stays). */
async function revokeOurs(page: Page): Promise<void> {
  const mine = await ok<{ items: { id: string; name: string; revoked_at: string | null }[] }>(
    page,
    'GET',
    `/orgs/${org.id}/me/api-tokens?limit=100`,
  );
  for (const item of mine.items.filter(
    (token) => token.revoked_at === null && token.name.startsWith('E2E '),
  )) {
    await ok(page, 'DELETE', `/api-tokens/${item.id}`);
  }
}

/** `tools/list` with only the Bearer token, like an MCP client (no cookie, no `Origin`). */
async function listTools(request: APIRequestContext, token: string): Promise<string[]> {
  const response = await request.post('/api/v1/mcp', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  });
  expect(response.status(), await response.text()).toBe(200);
  const body = (await response.json()) as { result: { tools: { name: string }[] } };
  return body.result.tools.map((tool) => tool.name);
}

function noHorizontalScroll(page: Page, width: number) {
  return expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(width);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  const { context, page } = await openAsAdmin(browser);
  const me = await ok<{ orgs: (Org & { name: string })[] }>(page, 'GET', '/me');
  const found = me.orgs.find((item) => item.name === WORKER_ORG.orgName);
  if (found === undefined) throw new Error(`The organization ${WORKER_ORG.orgName} is missing.`);
  org = found;
  await setMcp(page, { enabled: false, allow_writes: false });
  await revokeOurs(page);
  // A token that could connect (it reads structure), to show no MCP entry while MCP is off.
  await ok(page, 'POST', `/orgs/${org.id}/me/api-tokens`, {
    name: 'E2E reader',
    scopes: ['records:read', 'schema:read'],
    base_ids: null,
    expires_at: null,
  });
  await context.close();
});

test.afterAll(async ({ browser }) => {
  const { context, page } = await openAsAdmin(browser);
  await revokeOurs(page);
  await setMcp(page, { enabled: false, allow_writes: false });
  await context.close();
});

test('MCP off: no MCP entry renders on the tokens page', async ({ browser }) => {
  const { context, page } = await openAsAdmin(browser);
  await page.goto(`/o/${org.slug}/settings/api-tokens`);
  const row = page.getByTestId('token-row').filter({ hasText: 'E2E reader' });
  await expect(row).toBeVisible();
  await expect(row.getByTestId('token-revoke')).toBeVisible();
  await expect(page.getByTestId('token-connect-mcp')).toHaveCount(0);
  await page.getByTestId('token-create').click();
  const form = page.getByTestId('token-create-form');
  await expect(form.getByTestId('token-preset-read')).toBeVisible();
  await expect(form.getByTestId('token-preset-mcpRead')).toHaveCount(0);
  await expect(form.getByTestId('token-preset-mcpReadWrite')).toHaveCount(0);
  await expect(page.getByTestId('my-tokens').getByText('MCP')).toHaveCount(0);
  await expect(page.getByRole('dialog').getByText('MCP')).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.getByTestId('api-tokens-tab-policy').click();
  await expect(page.getByRole('switch', { name: 'Allow MCP clients' })).not.toBeChecked();
  await expect(
    page.getByRole('switch', { name: 'Let MCP clients create and update records' }),
  ).toBeDisabled();
  await expectNoSeriousA11yViolations(page, 'MCP off');
  await context.close();
});

test('an admin turns MCP on, creates an "MCP — read only" token and gets the connect box', async ({
  browser,
  request,
}) => {
  const { context, page } = await openAsAdmin(browser);
  const csp = collectCspViolations(page);
  await page.goto(`/o/${org.slug}/settings/api-tokens?tab=policy`);

  await test.step('turn MCP on after the confirmation', async () => {
    const enabled = page.getByRole('switch', { name: 'Allow MCP clients' });
    await enabled.click();
    const dialog = page.getByRole('alertdialog', { name: 'Allow MCP clients?' });
    await expect(dialog).toContainText('to the AI model that their MCP client uses');
    await expectNoSeriousA11yViolations(page, 'MCP confirmation');
    await dialog.getByTestId('mcp-confirm').click();
    await expect(page.getByText('MCP clients allowed.')).toBeVisible();
    await expect(enabled).toBeChecked();
    expect(
      (await ok<{ settings: { mcp: unknown } }>(page, 'GET', `/orgs/${org.id}`)).settings.mcp,
    ).toEqual({ enabled: true, allow_writes: false });
  });

  let token = '';
  await test.step('create a token from the "MCP — read only" preset', async () => {
    await page.getByTestId('api-tokens-tab-mine').click();
    await page.getByTestId('token-create').click();
    const form = page.getByTestId('token-create-form');
    await expect(form.getByTestId('token-preset-mcpReadWrite')).toHaveCount(0);
    await form.getByText('MCP — read only', { exact: true }).click();
    await expect(form.getByTestId('token-preset-mcpRead')).toBeChecked();
    await form.getByTestId('token-name-input').fill('E2E Claude Code');
    await expectNoSeriousA11yViolations(page, 'MCP presets');
    await form.getByTestId('token-create-submit').click();

    const reveal = page.getByTestId('token-reveal');
    token = await reveal.getByTestId('token-value').inputValue();
    expect(token).toMatch(/^cht_[0-9A-Za-z]{36}$/u);
    const url = `${new URL(page.url()).origin}/api/v1/mcp`;
    await expect(reveal.getByTestId('mcp-url')).toHaveValue(url);
    await expect(reveal.getByTestId('token-curl')).toHaveCount(0);
    await expect(reveal.getByTestId('mcp-snippet')).toHaveValue(
      `claude mcp add --transport http cellhive ${url} --header "Authorization: Bearer ${token}"`,
    );
    await reveal.getByText('Cursor', { exact: true }).click();
    expect(JSON.parse(await reveal.getByTestId('mcp-snippet').inputValue())).toEqual({
      mcpServers: { cellhive: { url, headers: { Authorization: `Bearer ${token}` } } },
    });
    await reveal.getByText('VS Code', { exact: true }).click();
    const vscode = JSON.parse(await reveal.getByTestId('mcp-snippet').inputValue()) as {
      servers: { cellhive: { type: string; url: string } };
    };
    expect(vscode.servers.cellhive).toMatchObject({ type: 'http', url });
    await expectNoSeriousA11yViolations(page, 'MCP connect box (new token)');
    await reveal.getByTestId('token-reveal-confirm').check();
    await reveal.getByTestId('token-reveal-done').click();
    await expect(reveal).toHaveCount(0);
  });

  await test.step('the endpoint of the box lists the read tools for that token', async () => {
    expect(await listTools(request, token)).toEqual(READ_TOOLS);
  });

  await test.step('"Connect via MCP" from the list carries the masked token', async () => {
    const row = page.getByTestId('token-row').filter({ hasText: 'E2E Claude Code' });
    await row.getByRole('button', { name: 'Connect E2E Claude Code via MCP' }).click();
    const dialog = page.getByRole('dialog', { name: 'Connect via MCP' });
    const masked = `${token.slice(0, 12)}…`;
    await expect(dialog.getByTestId('mcp-snippet')).toHaveValue(
      new RegExp(`Bearer ${masked}"$`, 'u'),
    );
    await expect(dialog.getByTestId('mcp-placeholder')).toContainText(`Replace ${masked}`);
    await expect(dialog).not.toContainText(token);
    await expectNoSeriousA11yViolations(page, 'MCP connect box (list)');
    await dialog.getByRole('button', { name: 'Close' }).last().click();
    await expect(dialog).toHaveCount(0);
  });
  expect(csp).toEqual([]);
  await context.close();
});

test('allowing writes after their confirmation offers "MCP — read & write"', async ({
  browser,
}) => {
  const { context, page } = await openAsAdmin(browser);
  await page.goto(`/o/${org.slug}/settings/api-tokens?tab=policy`);
  const writes = page.getByRole('switch', { name: 'Let MCP clients create and update records' });
  await expect(writes).toBeEnabled();
  await writes.click();
  const dialog = page.getByRole('alertdialog', { name: 'Let MCP clients change records?' });
  await expect(dialog).toContainText('can create the same records twice');
  await expectNoSeriousA11yViolations(page, 'writes confirmation');
  await dialog.getByTestId('mcp-confirm').click();
  await expect(writes).toBeChecked();

  await page.getByTestId('api-tokens-tab-mine').click();
  await page.getByTestId('token-create').click();
  const form = page.getByTestId('token-create-form');
  await form.getByText('MCP — read & write', { exact: true }).click();
  await expect(form.getByTestId('token-scope-records:write')).toBeChecked();
  await context.close();
});

test('Vietnamese at 375 px: no horizontal scroll', async ({ browser }) => {
  const { context, page } = await openAsAdmin(browser, {
    viewport: { width: 375, height: 812 },
    language: 'vi',
  });
  await page.goto(`/o/${org.slug}/settings/api-tokens?tab=policy`);
  await expect(
    page.getByRole('switch', { name: 'Cho phép client MCP', exact: true }),
  ).toBeChecked();
  await noHorizontalScroll(page, 375);
  await expectNoSeriousA11yViolations(page, 'MCP policy at 375 px (vi)');

  await page.getByTestId('api-tokens-tab-mine').click();
  await page.getByTestId('token-create').click();
  await expect(page.getByTestId('token-preset-mcpRead')).toHaveAccessibleName('MCP — chỉ đọc');
  await noHorizontalScroll(page, 375);
  await page.keyboard.press('Escape');

  const row = page.getByTestId('token-row').filter({ hasText: 'E2E Claude Code' });
  await row.getByRole('button', { name: 'Kết nối E2E Claude Code qua MCP' }).click();
  const dialog = page.getByRole('dialog', { name: 'Kết nối MCP' });
  await expect(dialog.getByTestId('mcp-url')).toBeVisible();
  await noHorizontalScroll(page, 375);
  await expectNoSeriousA11yViolations(page, 'MCP connect box at 375 px (vi)');
  await context.close();
});
