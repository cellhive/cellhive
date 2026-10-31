import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { json, ME, ORG, renderApp, stubApi } from '../../../../../test/app-harness';
import { axeViolations } from '../../../../../test/axe';
import { createTestI18n } from '../../../../../test/i18n';
import { clearToasts } from '../../../../lib/toast/toast';

import type { ApiTokenDto, ApiTokenPolicy, McpPolicy, OrgApiTokenDto } from '@cellhive/contracts';

/** T714: the API tokens page — mine (create, shown once, rename, revoke), all tokens, policy. */

const PATH = `/o/${ORG.slug}/settings/api-tokens`;
const DAY = 86_400_000;
const VALUE = `cht_${'A'.repeat(30)}BCDEFG`;
const STAMP = '2026-10-01T00:00:00.000Z';
const WORKSPACE = {
  id: 'wsp_0000000000000001',
  organization_id: ORG.id,
  name: 'W',
  slug: 'w',
  role: null,
  created_at: STAMP,
  updated_at: STAMP,
};
const BASE = {
  id: 'bse_0000000000000001' as const,
  organization_id: ORG.id,
  workspace_id: WORKSPACE.id,
  owner_id: ME.user.id,
  name: 'CSKH',
  icon: null,
  description: null,
  permission_version: 1,
  settings: { strict_computed_permissions: false },
  created_at: STAMP,
  updated_at: STAMP,
  deleted_at: null,
};

const inDays = (days: number) => new Date(Date.now() + days * DAY).toISOString();

const MINE: ApiTokenDto = {
  id: 'tok_0000000000000001',
  name: 'Old export',
  token_prefix: 'ZyXwVuTs',
  scopes: ['records:read'],
  base_ids: [BASE.id],
  expires_at: inDays(3),
  last_used_at: null,
  revoked_at: null,
  created_at: '2026-10-01T00:00:00.000Z',
};

const EXPIRED: ApiTokenDto = {
  ...MINE,
  id: 'tok_0000000000000002',
  name: 'Expired one',
  expires_at: inDays(-2),
};

const OTHER: OrgApiTokenDto = {
  ...MINE,
  id: 'tok_0000000000000003',
  name: 'Editor sync',
  token_prefix: 'EdItOr00',
  expires_at: inDays(60),
  user: { id: 'usr_EDITOR0000000001', display_name: 'Editor Le' },
};

interface Call {
  readonly route: string;
  readonly body: unknown;
}

function problemWith(code: string, status: number, errors: unknown[] = []): Response {
  return new Response(
    JSON.stringify({ type: 'about:blank', title: code, status, code, request_id: 'req_X', errors }),
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

function serve(
  options: {
    role?: 'owner' | 'member';
    policy?: ApiTokenPolicy;
    mcp?: McpPolicy;
    mine?: ApiTokenDto[];
    createProblem?: () => Response;
  } = {},
) {
  let mine = options.mine ?? [MINE];
  let policy = options.policy ?? { enabled: true, max_lifetime_days: null };
  let mcp = options.mcp ?? { enabled: false, allow_writes: false };
  const calls: Call[] = [];
  const body = (init: RequestInit | undefined): unknown =>
    typeof init?.body === 'string' ? JSON.parse(init.body) : null;
  const role = options.role ?? 'member';
  const org = () => ({ ...ORG, role, settings: { ...ORG.settings, api_tokens: policy, mcp } });
  stubApi({
    signedIn: true,
    routes: {
      'GET /me': () => json({ ...ME, orgs: [{ ...ME.orgs[0], role }] }),
      [`GET /orgs/${ORG.id}`]: () => json(org()),
      [`PATCH /orgs/${ORG.id}`]: (init) => {
        const sent = body(init) as {
          settings: { api_tokens?: ApiTokenPolicy; mcp?: Partial<McpPolicy> };
        };
        calls.push({ route: 'policy', body: sent });
        policy = { ...policy, ...sent.settings.api_tokens };
        mcp = { ...mcp, ...sent.settings.mcp };
        return json({ ...org(), updated_at: new Date().toISOString() });
      },
      [`GET /orgs/${ORG.id}/workspaces`]: () =>
        json({ items: [WORKSPACE], total: 1, offset: 0, limit: 1000 }),
      'GET /workspaces/wsp_0000000000000001/bases': () =>
        json({ items: [BASE], total: 1, offset: 0, limit: 1000 }),
      [`GET /orgs/${ORG.id}/members`]: () =>
        json({
          items: [
            {
              user: { ...OTHER.user, email: 'e@example.test', avatar_url: null },
              role: 'member',
              joined_at: '2026-10-01T00:00:00.000Z',
            },
          ],
          total: 1,
          offset: 0,
          limit: 1000,
        }),
      [`GET /orgs/${ORG.id}/me/api-tokens`]: () => json({ items: mine, next_cursor: null }),
      [`POST /orgs/${ORG.id}/me/api-tokens`]: (init) => {
        const sent = body(init) as Pick<ApiTokenDto, 'name' | 'scopes' | 'base_ids' | 'expires_at'>;
        calls.push({ route: 'create', body: sent });
        if (options.createProblem !== undefined) return options.createProblem();
        const created: ApiTokenDto = {
          ...MINE,
          ...sent,
          id: 'tok_0000000000000009',
          token_prefix: VALUE.slice(4, 12),
          created_at: new Date().toISOString(),
        };
        mine = [created, ...mine];
        return json({ ...created, token: VALUE }, 201);
      },
      [`PATCH /api-tokens/${MINE.id}`]: (init) => {
        const sent = body(init) as { name: string };
        calls.push({ route: 'rename', body: sent });
        mine = mine.map((item) => (item.id === MINE.id ? { ...item, name: sent.name } : item));
        return json({ ...MINE, name: sent.name });
      },
      [`DELETE /api-tokens/${MINE.id}`]: () => {
        calls.push({ route: 'revoke', body: MINE.id });
        mine = mine.map((item) =>
          item.id === MINE.id ? { ...item, revoked_at: new Date().toISOString() } : item,
        );
        return new Response(null, { status: 204 });
      },
      [`DELETE /api-tokens/${OTHER.id}`]: () => {
        calls.push({ route: 'revoke', body: OTHER.id });
        return new Response(null, { status: 204 });
      },
      [`GET /orgs/${ORG.id}/api-tokens`]: () => json({ items: [OTHER], next_cursor: null }),
    },
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

function storageText(): string {
  const all: string[] = [];
  for (const storage of [window.localStorage, window.sessionStorage]) {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index) ?? '';
      all.push(key, storage.getItem(key) ?? '');
    }
  }
  return all.join('\n');
}

describe('ApiTokensPage (T714)', () => {
  it('a member sees only their tokens, with expiry warnings', async () => {
    serve({ mine: [MINE, EXPIRED] });
    // Asking for an admin tab still shows "Mine".
    await renderApp(`${PATH}?tab=policy`);
    const section = await screen.findByTestId('my-tokens');
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByTestId('api-tokens-tab-all')).toBeNull();
    const rows = await within(section).findAllByTestId('token-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('cht_ZyXwVuTs…');
    expect(rows[0]).toHaveTextContent('Read records');
    expect(rows[0]).toHaveTextContent('CSKH');
    expect(rows[0]).toHaveTextContent('Last used: Never');
    expect(within(rows[0] as HTMLElement).getByTestId('token-warning')).toHaveTextContent(
      'Expires in less than 7 days',
    );
    expect(within(rows[1] as HTMLElement).getByTestId('token-status')).toHaveTextContent('Expired');
    expect(within(rows[1] as HTMLElement).getByTestId('token-warning')).toHaveTextContent(
      'Expired: requests with it are refused',
    );
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('creates a "Read data" token and shows it once', async () => {
    const calls = serve({ mine: [] });
    await renderApp(PATH);
    await userEvent.click(await screen.findByTestId('token-create'));
    const form = await screen.findByTestId('token-create-form');
    // Nothing typed: the name is required, nothing is sent.
    await userEvent.click(within(form).getByTestId('token-create-submit'));
    expect(within(form).getByText('Enter a name.')).toBeVisible();
    expect(calls).toEqual([]);
    await userEvent.type(within(form).getByTestId('token-name-input'), 'CI export');
    expect(within(form).getByTestId('token-preset-read')).toBeChecked();
    expect(within(form).getByTestId('token-expiry-90')).toBeChecked();
    expect(within(form).getByTestId('token-scope-records:read')).toBeChecked();
    expect(within(form).getByTestId('token-scope-records:write')).not.toBeChecked();
    expect(await axeViolations(document.body)).toEqual([]);
    const before = Date.now();
    await userEvent.click(within(form).getByTestId('token-create-submit'));

    const reveal = await screen.findByTestId('token-reveal');
    const sent = calls[0]?.body as { expires_at: string };
    expect(calls[0]).toMatchObject({
      route: 'create',
      body: { name: 'CI export', scopes: ['records:read', 'schema:read'], base_ids: null },
    });
    const at = Date.parse(sent.expires_at);
    expect(at).toBeGreaterThan(before + 89 * DAY);
    expect(at).toBeLessThanOrEqual(Date.now() + 90 * DAY);
    expect(within(reveal).getByTestId('token-value')).toHaveValue(VALUE);
    expect(within(reveal).getByTestId('token-curl')).toHaveValue(
      `curl -H "Authorization: Bearer ${VALUE}" ${window.location.origin}/api/v1/me`,
    );
    // Copy: announced in a status region.
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await userEvent.click(within(reveal).getByTestId('token-value-copy'));
    expect(writeText).toHaveBeenCalledWith(VALUE);
    expect(await within(reveal).findByTestId('token-value-status')).toHaveTextContent(
      'Token copied to the clipboard.',
    );
    expect(within(reveal).getByTestId('token-value-status')).toHaveAttribute('role', 'status');
    expect(await axeViolations(document.body)).toEqual([]);

    // Not closed before "I've saved it".
    await userEvent.click(within(reveal).getByTestId('token-reveal-done'));
    expect(within(reveal).getByRole('alert')).toHaveTextContent(
      "Confirm that you've saved the token before closing.",
    );
    expect(within(reveal).getByTestId('token-reveal-confirm')).toHaveFocus();
    await userEvent.keyboard(' ');
    await userEvent.click(within(reveal).getByTestId('token-reveal-done'));
    await waitFor(() => {
      expect(screen.queryByTestId('token-reveal')).toBeNull();
    });
    expect(document.body.innerHTML).not.toContain(VALUE);
    expect(storageText()).not.toContain(VALUE);
    // The list shows the new token by its prefix only.
    const row = await screen.findByText('CI export');
    expect(row.closest('li')).toHaveTextContent(`cht_${VALUE.slice(4, 12)}…`);
  });

  it('limits the expiry by the policy, with the reason', async () => {
    const calls = serve({ policy: { enabled: true, max_lifetime_days: 30 } });
    await renderApp(PATH);
    await userEvent.click(await screen.findByTestId('token-create'));
    const form = await screen.findByTestId('token-create-form');
    expect(within(form).getByTestId('token-expiry-30')).toBeChecked();
    expect(within(form).getByTestId('token-expiry-7')).toBeEnabled();
    for (const choice of ['90', '365']) {
      const radio = within(form).getByTestId(`token-expiry-${choice}`);
      expect(radio).toBeDisabled();
      expect(radio).toHaveAccessibleDescription(
        'Not allowed: this organization limits tokens to 30 days.',
      );
    }
    expect(within(form).getByTestId('token-expiry-none')).toHaveAccessibleDescription(
      'Not allowed: this organization requires tokens to expire.',
    );
    expect(calls).toEqual([]);
  });

  it('the "Automation" preset reads records too, and says so (T804)', async () => {
    const calls = serve({ mine: [] });
    await renderApp(PATH);
    await userEvent.click(await screen.findByTestId('token-create'));
    const form = await screen.findByTestId('token-create-form');
    const preset = within(form).getByTestId('token-preset-automation');
    expect(preset).toHaveAccessibleDescription(
      'Read and change automations; read record values (previews, test sends, run details).',
    );
    await userEvent.click(preset);
    expect(preset).toBeChecked();
    const checked = {
      'records:read': true,
      'records:write': false,
      'schema:read': true,
      'schema:write': false,
      'automations:read': true,
      'automations:write': true,
    };
    for (const [scope, on] of Object.entries(checked)) {
      const box = within(form).getByTestId(`token-scope-${scope}`);
      if (on) expect(box).toBeChecked();
      else expect(box).not.toBeChecked();
    }
    // Unticking `records:read` leaves the preset: the form shows custom scopes.
    await userEvent.click(within(form).getByTestId('token-scope-records:read'));
    expect(preset).not.toBeChecked();
    expect(calls).toEqual([]);

    const vi18n = await createTestI18n('vi');
    expect(vi18n.t('apiTokens:create.preset.automationHint')).toBe(
      'Đọc và sửa automation; đọc được giá trị bản ghi (xem trước, gửi thử, chi tiết lần chạy).',
    );
  });

  it('warns before a token that never expires, and translates server errors', async () => {
    serve({
      createProblem: () =>
        problemWith('VALIDATION_FAILED', 422, [
          { path: '', code: 'TOO_MANY_TOKENS', message: 'x', params: { maximum: 50 } },
        ]),
    });
    await renderApp(PATH);
    await userEvent.click(await screen.findByTestId('token-create'));
    const form = await screen.findByTestId('token-create-form');
    await userEvent.type(within(form).getByTestId('token-name-input'), 'Forever');
    await userEvent.click(within(form).getByTestId('token-expiry-none'));
    expect(within(form).getByTestId('token-expiry-none-warning')).toHaveTextContent(
      'keeps working until someone revokes it',
    );
    await userEvent.click(within(form).getByTestId('token-create-submit'));
    expect(
      await within(form).findByText(
        'You already have 50 API tokens in this organization. Revoke one first.',
      ),
    ).toBeVisible();
    expect(screen.queryByTestId('token-reveal')).toBeNull();
  });

  it('says when the organization turned tokens off', async () => {
    serve({ policy: { enabled: false, max_lifetime_days: null } });
    await renderApp(PATH);
    expect(await screen.findByTestId('tokens-disabled')).toHaveTextContent(
      'API tokens are turned off',
    );
    expect(screen.getByTestId('token-create')).toBeDisabled();
  });

  it('renames and revokes (alertdialog) a token', async () => {
    const calls = serve();
    await renderApp(PATH);
    await userEvent.click(await screen.findByRole('button', { name: 'Rename Old export' }));
    const rename = await screen.findByTestId('token-rename-form');
    await userEvent.clear(within(rename).getByTestId('token-rename-name'));
    await userEvent.type(within(rename).getByTestId('token-rename-name'), 'Nightly export{Enter}');
    await waitFor(() => {
      expect(calls).toContainEqual({ route: 'rename', body: { name: 'Nightly export' } });
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Revoke Nightly export' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Revoke “Nightly export”?' });
    expect(dialog).toHaveAccessibleDescription(
      'Integrations and scripts using this token stop working immediately. This cannot be undone.',
    );
    expect(await axeViolations(document.body)).toEqual([]);
    await userEvent.click(within(dialog).getByTestId('token-revoke-confirm'));
    await waitFor(() => {
      expect(calls).toContainEqual({ route: 'revoke', body: MINE.id });
    });
    expect(await screen.findByText('Revoked')).toBeVisible();
  });

  it('an admin sees all tokens and revokes one of another member', async () => {
    const calls = serve({ role: 'owner' });
    await renderApp(`${PATH}?tab=all`);
    const tabs = await screen.findByRole('tablist', { name: 'API token sections' });
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual(['Mine', 'All tokens', 'Policy']);
    const section = await screen.findByTestId('org-tokens');
    const row = await within(section).findByTestId('token-row');
    expect(row).toHaveTextContent('Owner: Editor Le');
    expect(row).toHaveTextContent('cht_EdItOr00…');
    expect(within(row).queryByTestId('token-rename')).toBeNull();
    expect(await axeViolations(document.body)).toEqual([]);
    await userEvent.click(within(row).getByTestId('token-revoke'));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveAccessibleDescription(
      'Integrations and scripts of Editor Le using this token stop working immediately. This cannot be undone.',
    );
    await userEvent.click(within(dialog).getByTestId('token-revoke-confirm'));
    await waitFor(() => {
      expect(calls).toContainEqual({ route: 'revoke', body: OTHER.id });
    });
  });

  it('tabs move with the arrow keys; the policy saves with a warning when turned off', async () => {
    const calls = serve({ role: 'owner' });
    await renderApp(PATH);
    const mine = await screen.findByTestId('api-tokens-tab-mine');
    mine.focus();
    await userEvent.keyboard('{ArrowLeft}');
    const policyTab = screen.getByTestId('api-tokens-tab-policy');
    expect(policyTab).toHaveFocus();
    // The selected tab follows `?tab=`, which the router updates asynchronously.
    await waitFor(() => {
      expect(policyTab).toHaveAttribute('aria-selected', 'true');
    });
    const section = await screen.findByTestId('token-policy');
    await userEvent.click(within(section).getByTestId('token-policy-enabled'));
    expect(within(section).getByTestId('token-policy-off-warning')).toHaveTextContent(
      'integrations using them stop immediately',
    );
    await userEvent.click(within(section).getByTestId('token-policy-limit'));
    await userEvent.clear(within(section).getByTestId('token-policy-days'));
    await userEvent.type(within(section).getByTestId('token-policy-days'), '0');
    await userEvent.click(within(section).getByTestId('token-policy-save'));
    expect(within(section).getByRole('alert')).toHaveTextContent('from 1 to 3650');
    await userEvent.clear(within(section).getByTestId('token-policy-days'));
    await userEvent.type(within(section).getByTestId('token-policy-days'), '30');
    expect(await axeViolations(document.body)).toEqual([]);
    await userEvent.click(within(section).getByTestId('token-policy-save'));
    await waitFor(() => {
      expect(calls).toContainEqual({
        route: 'policy',
        body: { settings: { api_tokens: { enabled: false, max_lifetime_days: 30 } } },
      });
    });
  });
});

describe('MCP on the API tokens page (T924)', () => {
  const MCP_ON = { enabled: true, allow_writes: false };

  it('MCP off: no MCP preset, no "Connect via MCP"; the writes switch waits for MCP', async () => {
    const calls = serve({
      role: 'owner',
      mine: [{ ...MINE, scopes: ['records:read', 'schema:read'] }],
    });
    await renderApp(PATH);
    const row = await screen.findByTestId('token-row');
    expect(within(row).queryByTestId('token-connect-mcp')).toBeNull();
    await userEvent.click(screen.getByTestId('token-create'));
    const form = await screen.findByTestId('token-create-form');
    expect(within(form).queryByTestId('token-preset-mcpRead')).toBeNull();
    expect(within(form).queryByTestId('token-preset-mcpReadWrite')).toBeNull();
    expect(form).not.toHaveTextContent('MCP');
    await userEvent.click(within(form).getByRole('button', { name: 'Cancel' }));

    await userEvent.click(screen.getByTestId('api-tokens-tab-policy'));
    const section = await screen.findByTestId('mcp-policy');
    const enabled = within(section).getByRole('switch', { name: 'Allow MCP clients' });
    expect(enabled).not.toBeChecked();
    expect(enabled).toHaveAccessibleDescription('Off: the MCP endpoint refuses every token.');
    const writes = within(section).getByRole('switch', {
      name: 'Let MCP clients create and update records',
    });
    expect(writes).toBeDisabled();
    expect(writes).toHaveAccessibleDescription('Turn on MCP clients first.');
    expect(await axeViolations(document.body)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('an admin turns MCP and writes on after a confirmation each, and off without one', async () => {
    const calls = serve({ role: 'owner' });
    await renderApp(`${PATH}?tab=policy`);
    const section = await screen.findByTestId('mcp-policy');
    // A draft of the token policy survives the MCP switches (saved at once).
    const policy = screen.getByTestId('token-policy');
    await userEvent.click(within(policy).getByTestId('token-policy-limit'));
    await userEvent.clear(within(policy).getByTestId('token-policy-days'));
    await userEvent.type(within(policy).getByTestId('token-policy-days'), '30');

    const enabled = within(section).getByTestId('mcp-enabled');
    await userEvent.click(enabled);
    const dialog = await screen.findByRole('alertdialog', { name: 'Allow MCP clients?' });
    expect(dialog).toHaveTextContent(
      'Members will be able to send the records they can read to the AI model that their MCP client uses.',
    );
    expect(dialog).toHaveTextContent('even when the AI settings keep record values away from AI');
    expect(enabled).not.toBeChecked();
    expect(await axeViolations(document.body)).toEqual([]);
    await userEvent.click(within(dialog).getByTestId('mcp-confirm'));
    await waitFor(() => {
      expect(calls).toContainEqual({
        route: 'policy',
        body: { settings: { mcp: { enabled: true } } },
      });
    });
    expect(await screen.findByText('MCP clients allowed.')).toBeVisible();
    await waitFor(() => {
      expect(within(section).getByTestId('mcp-enabled')).toBeChecked();
    });
    expect(within(policy).getByTestId('token-policy-days')).toHaveValue(30);

    // Writes: "Cancel" keeps them off and sends nothing.
    const writes = within(section).getByTestId('mcp-allow-writes');
    expect(writes).toBeEnabled();
    await userEvent.click(writes);
    const ask = await screen.findByRole('alertdialog', { name: 'Let MCP clients change records?' });
    expect(ask).toHaveTextContent('can create the same records twice');
    expect(ask).toHaveTextContent('take it for instructions');
    await userEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });
    expect(writes).not.toBeChecked();
    expect(calls).toHaveLength(1);
    await userEvent.click(writes);
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByTestId('mcp-confirm'),
    );
    await waitFor(() => {
      expect(calls).toContainEqual({
        route: 'policy',
        body: { settings: { mcp: { allow_writes: true } } },
      });
    });

    // Off: at once, no question.
    await userEvent.click(within(section).getByTestId('mcp-enabled'));
    await waitFor(() => {
      expect(calls).toContainEqual({
        route: 'policy',
        body: { settings: { mcp: { enabled: false } } },
      });
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('creates an "MCP — read only" token and shows how to connect, with the value only once', async () => {
    const calls = serve({ mine: [], mcp: MCP_ON });
    await renderApp(PATH);
    await userEvent.click(await screen.findByTestId('token-create'));
    const form = await screen.findByTestId('token-create-form');
    // Writes are not allowed: no "read & write" MCP preset.
    expect(within(form).queryByTestId('token-preset-mcpReadWrite')).toBeNull();
    const preset = within(form).getByTestId('token-preset-mcpRead');
    expect(preset).toHaveAccessibleName('MCP — read only');
    await userEvent.click(preset);
    expect(preset).toBeChecked();
    // Same scopes as "Read data", but the MCP preset stays the chosen one.
    expect(within(form).getByTestId('token-preset-read')).not.toBeChecked();
    await userEvent.type(within(form).getByTestId('token-name-input'), 'Claude Code');
    await userEvent.click(within(form).getByTestId('token-create-submit'));

    const reveal = await screen.findByTestId('token-reveal');
    expect(calls[0]).toMatchObject({
      route: 'create',
      body: { name: 'Claude Code', scopes: ['records:read', 'schema:read'] },
    });
    expect(within(reveal).queryByTestId('token-curl')).toBeNull();
    const url = `${window.location.origin}/api/v1/mcp`;
    expect(within(reveal).getByTestId('mcp-url')).toHaveValue(url);
    expect(within(reveal).getByTestId('mcp-client-claudeCode')).toBeChecked();
    expect(within(reveal).getByTestId('mcp-snippet')).toHaveValue(
      `claude mcp add --transport http cellhive ${url} --header "Authorization: Bearer ${VALUE}"`,
    );
    expect(within(reveal).queryByTestId('mcp-placeholder')).toBeNull();
    // The clients form one radio group: arrow keys move between them.
    within(reveal).getByTestId('mcp-client-claudeCode').focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(within(reveal).getByTestId('mcp-client-cursor')).toBeChecked();
    const snippet = () => within(reveal).getByTestId<HTMLTextAreaElement>('mcp-snippet').value;
    expect(snippet()).toContain(`"Authorization": "Bearer ${VALUE}"`);
    await userEvent.click(within(reveal).getByText('VS Code'));
    expect(snippet()).not.toContain(VALUE);
    expect(within(reveal).getByTestId('mcp-snippet')).toHaveAccessibleDescription(
      expect.stringContaining('VS Code asks for the token'),
    );
    expect(await axeViolations(document.body)).toEqual([]);
    await userEvent.click(within(reveal).getByTestId('token-reveal-confirm'));
    await userEvent.click(within(reveal).getByTestId('token-reveal-done'));
    await waitFor(() => {
      expect(screen.queryByTestId('token-reveal')).toBeNull();
    });
    expect(document.body.innerHTML).not.toContain(VALUE);
    expect(storageText()).not.toContain(VALUE);

    // From the list: the masked token stands in for the value.
    const row = (await screen.findByText('Claude Code')).closest('li') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Connect Claude Code via MCP' }));
    const dialog = await screen.findByRole('dialog', { name: 'Connect via MCP' });
    const masked = `cht_${VALUE.slice(4, 12)}…`;
    expect(within(dialog).getByTestId('mcp-snippet')).toHaveValue(
      `claude mcp add --transport http cellhive ${url} --header "Authorization: Bearer ${masked}"`,
    );
    expect(within(dialog).getByTestId('mcp-placeholder')).toHaveTextContent(
      `Replace ${masked} with the full token.`,
    );
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('offers "MCP — read & write" when writes are allowed; tokens without schema:read cannot connect', async () => {
    const calls = serve({ mcp: { enabled: true, allow_writes: true } });
    await renderApp(PATH);
    // `MINE` has only `records:read`: the endpoint would refuse it.
    const row = await screen.findByTestId('token-row');
    expect(within(row).queryByTestId('token-connect-mcp')).toBeNull();
    await userEvent.click(screen.getByTestId('token-create'));
    const form = await screen.findByTestId('token-create-form');
    await userEvent.click(within(form).getByTestId('token-preset-mcpReadWrite'));
    expect(within(form).getByTestId('token-scope-records:write')).toBeChecked();
    await userEvent.type(within(form).getByTestId('token-name-input'), 'Cursor');
    await userEvent.click(within(form).getByTestId('token-create-submit'));
    expect(await screen.findByTestId('mcp-connect')).toBeVisible();
    expect(calls[0]).toMatchObject({
      body: { scopes: ['records:read', 'records:write', 'schema:read'] },
    });

    const vi18n = await createTestI18n('vi');
    expect(vi18n.t('apiTokens:create.preset.mcpRead')).toBe('MCP — chỉ đọc');
    expect(vi18n.t('apiTokens:mcp.connect.action')).toBe('Kết nối MCP');
  });
});
