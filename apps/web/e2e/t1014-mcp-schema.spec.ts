import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';

import { expect, test, WORKER_ORG } from './fixtures';
import { apiSignIn, collectCspViolations, expectNoSeriousA11yViolations, ok } from './support';

/**
 * T1014: MCP schema changes on the API tokens page (FRONTEND §15.6,
 * CONTRACTS §30.1, §30.7) in the worker's demo organization, as u_admin
 * (organization owner): with MCP on, the third switch "Allow schema
 * changes" asks first (bulk schema from an LLM client, prompt injection),
 * then the "MCP — schema" preset (`schema:read` + `schema:write`) appears;
 * a token from it lists the schema tools and no record tool; record writes
 * stay off. Vietnamese at 375 px: no horizontal scroll. `afterAll` revokes
 * the spec's tokens and turns MCP off again.
 */

const ADMIN_EMAIL = WORKER_ORG.email('admin');
const SCHEMA_TOOLS = [
  'list_bases',
  'list_tables',
  'describe_table',
  'create_table',
  'create_field',
  'update_field',
];
const OFF = { enabled: false, allow_writes: false, allow_schema_writes: false };

interface Org {
  id: string;
  slug: string;
}

let org: Org;
let cookies: Awaited<ReturnType<BrowserContext['cookies']>> | null = null;

async function openAsAdmin(
  browser: Browser,
  options: { viewport?: { width: number; height: number }; language?: 'en' | 'vi' } = {},
) {
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

async function setMcp(page: Page, mcp: Partial<typeof OFF>) {
  await ok(page, 'PATCH', `/orgs/${org.id}`, { settings: { mcp } });
}

/** Revokes the tokens of this spec (named `E2E schema …`). */
async function revokeOurs(page: Page): Promise<void> {
  const mine = await ok<{ items: { id: string; name: string; revoked_at: string | null }[] }>(
    page,
    'GET',
    `/orgs/${org.id}/me/api-tokens?limit=100`,
  );
  for (const item of mine.items.filter(
    (token) => token.revoked_at === null && token.name.startsWith('E2E schema'),
  )) {
    await ok(page, 'DELETE', `/api-tokens/${item.id}`);
  }
}

/** `tools/list` with only the Bearer token, like an MCP client. */
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

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  const { context, page } = await openAsAdmin(browser);
  const me = await ok<{ orgs: (Org & { name: string })[] }>(page, 'GET', '/me');
  const found = me.orgs.find((item) => item.name === WORKER_ORG.orgName);
  if (found === undefined) throw new Error(`The organization ${WORKER_ORG.orgName} is missing.`);
  org = found;
  await setMcp(page, { ...OFF, enabled: true });
  await revokeOurs(page);
  await context.close();
});

test.afterAll(async ({ browser }) => {
  const { context, page } = await openAsAdmin(browser);
  await revokeOurs(page);
  await setMcp(page, OFF);
  await context.close();
});

test('schema changes: the switch asks first, then a token from "MCP — schema" lists the schema tools', async ({
  browser,
  request,
}) => {
  const { context, page } = await openAsAdmin(browser);
  const csp = collectCspViolations(page);
  await page.goto(`/o/${org.slug}/settings/api-tokens?tab=policy`);

  await test.step('no "MCP — schema" preset while schema changes are off', async () => {
    await page.getByTestId('api-tokens-tab-mine').click();
    await page.getByTestId('token-create').click();
    const form = page.getByTestId('token-create-form');
    await expect(form.getByTestId('token-preset-mcpRead')).toBeVisible();
    await expect(form.getByTestId('token-preset-mcpSchema')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.getByTestId('api-tokens-tab-policy').click();
  });

  await test.step('turn schema changes on after the confirmation', async () => {
    const schema = page.getByRole('switch', {
      name: 'Allow schema changes (create tables/fields)',
    });
    await expect(schema).toBeEnabled();
    await expect(schema).not.toBeChecked();
    await schema.click();
    const dialog = page.getByRole('alertdialog', { name: 'Let MCP clients change the structure?' });
    await expect(dialog).toContainText('create many tables and fields in little time');
    await expect(dialog).toContainText('take it for instructions');
    await expectNoSeriousA11yViolations(page, 'schema changes confirmation');
    await dialog.getByTestId('mcp-confirm').click();
    await expect(page.getByText('MCP clients can now create tables and fields.')).toBeVisible();
    await expect(schema).toBeChecked();
    await expect(
      page.getByRole('switch', { name: 'Let MCP clients create and update records' }),
    ).not.toBeChecked();
    expect(
      (await ok<{ settings: { mcp: unknown } }>(page, 'GET', `/orgs/${org.id}`)).settings.mcp,
    ).toEqual({ enabled: true, allow_writes: false, allow_schema_writes: true });
  });

  let token = '';
  await test.step('create a token from the "MCP — schema" preset', async () => {
    await page.getByTestId('api-tokens-tab-mine').click();
    await page.getByTestId('token-create').click();
    const form = page.getByTestId('token-create-form');
    await expect(form.getByTestId('token-preset-mcpReadWrite')).toHaveCount(0);
    await form.getByText('MCP — schema', { exact: true }).click();
    await expect(form.getByTestId('token-preset-mcpSchema')).toBeChecked();
    await expect(form.getByTestId('token-scope-schema:write')).toBeChecked();
    await expect(form.getByTestId('token-scope-records:read')).not.toBeChecked();
    await form.getByTestId('token-name-input').fill('E2E schema agent');
    await expectNoSeriousA11yViolations(page, 'MCP schema preset');
    await form.getByTestId('token-create-submit').click();

    const reveal = page.getByTestId('token-reveal');
    token = await reveal.getByTestId('token-value').inputValue();
    expect(token).toMatch(/^cht_[0-9A-Za-z]{36}$/u);
    await expect(reveal.getByTestId('mcp-url')).toHaveValue(
      `${new URL(page.url()).origin}/api/v1/mcp`,
    );
    await reveal.getByTestId('token-reveal-confirm').check();
    await reveal.getByTestId('token-reveal-done').click();
    await expect(reveal).toHaveCount(0);
  });

  await test.step('the endpoint lists the schema tools for that token, no record tool', async () => {
    expect(await listTools(request, token)).toEqual(SCHEMA_TOOLS);
  });
  expect(csp).toEqual([]);
  await context.close();
});

test('Vietnamese at 375 px: the third switch without horizontal scroll', async ({ browser }) => {
  const { context, page } = await openAsAdmin(browser, {
    viewport: { width: 375, height: 812 },
    language: 'vi',
  });
  await page.goto(`/o/${org.slug}/settings/api-tokens?tab=policy`);
  await expect(
    page.getByRole('switch', { name: 'Cho phép sửa cấu trúc (tạo bảng/trường)', exact: true }),
  ).toBeChecked();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(375);
  await expectNoSeriousA11yViolations(page, 'MCP schema switch at 375 px (vi)');
  await context.close();
});
