import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { json, ME, ORG, renderApp, stubApi } from '../../../../../test/app-harness';
import { axeViolations } from '../../../../../test/axe';
import { clearToasts } from '../../../../lib/toast/toast';

import type {
  AiSettingsDto,
  AiSettingsTestResult,
  AiUsageDto,
  HttpAllowlistEntryDto,
} from '@cellhive/contracts';

/** T912: the organization AI settings page (FRONTEND §15.8, CONTRACTS §29.1). */

const PATH = `/o/${ORG.slug}/settings/ai`;
const NOW = '2026-10-31T09:00:00.000Z';
/** Obviously fake: never a real provider key. */
const FAKE_KEY = 'sk-test-not-a-real-key';
const LOCAL_URL = 'http://localhost:11434/v1';

const NOT_SET: AiSettingsDto = {
  enabled: false,
  provider_base_url: null,
  model: null,
  api_key: null,
  allow_record_data: false,
  log_prompts: false,
  daily_token_limit: 1_000_000,
  structured_output: 'auto',
  detected_output: null,
  token_param: 'max_tokens',
  request_timeout_seconds: 60,
  available: false,
  updated_at: null,
};

const LOCAL: AiSettingsDto = {
  ...NOT_SET,
  provider_base_url: LOCAL_URL,
  model: 'llama3.1:8b',
  updated_at: NOW,
};

const OPENAI: AiSettingsDto = {
  ...LOCAL,
  enabled: true,
  available: true,
  provider_base_url: 'https://api.openai.com/v1',
  model: 'gpt-5-mini',
  api_key: {
    secret_id: 'sec_0000000000000001',
    name: 'AI provider key',
    allowed_hosts: ['api.openai.com'],
  },
  detected_output: 'json_schema',
  token_param: 'max_completion_tokens',
};

const OK: AiSettingsTestResult = {
  ok: true,
  models: ['llama3.1:8b', 'qwen2.5:7b'],
  structured_output: 'json_schema',
  token_param: 'max_tokens',
  latency_ms: 642,
  error: null,
};

const BLOCKED: AiSettingsTestResult = {
  ok: false,
  models: null,
  structured_output: null,
  token_param: 'max_tokens',
  latency_ms: 3,
  error: { code: 'AI_PROVIDER_ERROR', reason: 'ssrf_blocked', status: null },
};

const USAGE: AiUsageDto = {
  from: '2026-10-02',
  to: '2026-10-31',
  time_zone: 'UTC',
  items: [
    {
      day: '2026-10-31',
      feature: 'test',
      requests: 2,
      prompt_tokens: 120,
      completion_tokens: 20,
      estimated_requests: 0,
    },
    {
      day: '2026-10-30',
      feature: 'formula',
      requests: 5,
      prompt_tokens: 4000,
      completion_tokens: 900,
      estimated_requests: 1,
    },
  ],
  quota: {
    daily_token_limit: 1_000_000,
    used_today: 250_000,
    reset_at: '2026-11-01T00:00:00.000Z',
  },
};

interface Call {
  readonly route: string;
  readonly body: unknown;
}

function serve(
  options: {
    settings?: AiSettingsDto;
    tests?: AiSettingsTestResult[];
    putProblem?: () => Response;
    role?: 'owner' | 'member';
  } = {},
) {
  let settings = options.settings ?? NOT_SET;
  const tests = [...(options.tests ?? [OK])];
  let entries: HttpAllowlistEntryDto[] = [];
  const calls: Call[] = [];
  const body = (init: RequestInit | undefined): unknown =>
    typeof init?.body === 'string' ? JSON.parse(init.body) : null;
  stubApi({
    signedIn: true,
    routes: {
      'GET /me': () => json({ ...ME, orgs: [{ ...ME.orgs[0], role: options.role ?? 'owner' }] }),
      [`GET /orgs/${ORG.id}`]: () =>
        json({ ...ORG, ai: { available: settings.available, record_data: false } }),
      [`GET /orgs/${ORG.id}/ai-settings`]: () => json(settings),
      [`PUT /orgs/${ORG.id}/ai-settings`]: (init) => {
        const sent = body(init) as Record<string, unknown>;
        calls.push({ route: 'put', body: sent });
        if (options.putProblem !== undefined) return options.putProblem();
        const next = { ...settings, ...sent, updated_at: NOW } as Record<string, unknown>;
        delete next['confirm'];
        if ('api_key' in sent) {
          next['api_key'] =
            sent['api_key'] === null
              ? null
              : {
                  secret_id: 'sec_0000000000000002',
                  name: 'AI provider key',
                  allowed_hosts: ['localhost:11434'],
                };
        }
        next['available'] =
          next['enabled'] === true && next['provider_base_url'] !== null && next['model'] !== null;
        settings = next as AiSettingsDto;
        return json(settings);
      },
      [`POST /orgs/${ORG.id}/ai-settings/test`]: (init) => {
        calls.push({ route: 'test', body: body(init) });
        return json(tests.shift() ?? OK);
      },
      [`GET /orgs/${ORG.id}/ai-usage`]: () => json(USAGE),
      [`GET /orgs/${ORG.id}/http-allowlist`]: () =>
        json({ items: entries, private_addresses: 'org' }),
      [`POST /orgs/${ORG.id}/http-allowlist`]: (init) => {
        const sent = body(init) as { pattern: string; note: string };
        calls.push({ route: 'allowlist', body: sent });
        const entry: HttpAllowlistEntryDto = {
          id: 'hal_0000000000000001',
          organization_id: ORG.id,
          pattern: sent.pattern,
          host: 'localhost',
          wildcard: false,
          port: 11434,
          note: sent.note,
          created_by: { id: ME.user.id, name: 'Me' },
          created_at: NOW,
        };
        entries = [entry];
        return json(entry, 201);
      },
    },
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

describe('AiSettingsPage (T912)', () => {
  it('not set up: the empty state, then a local provider saved without a key', async () => {
    const calls = serve();
    await renderApp(PATH);
    const status = await screen.findByTestId('ai-status');
    expect(within(status).getByTestId('ai-empty')).toBeVisible();
    expect(within(status).getByTestId('ai-status-badge')).toHaveTextContent('Not set up');
    // AI cannot be turned on before a provider and a model are saved.
    expect(
      within(status).getByRole('switch', { name: 'Use AI in this organization' }),
    ).toBeDisabled();
    expect(screen.getByTestId('ai-test')).toBeDisabled();
    expect(await screen.findByTestId('ai-usage-table')).toBeVisible();
    expect(await axeViolations(document.body)).toEqual([]);

    await userEvent.click(screen.getByTestId('ai-preset-ollama'));
    expect(screen.getByTestId('ai-base-url')).toHaveValue(LOCAL_URL);
    expect(screen.getByTestId('ai-preset-ollama')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('ai-preset-note')).toHaveTextContent(/replace localhost/u);
    await userEvent.type(screen.getByTestId('ai-model'), 'llama3.1:8b');
    const bar = screen.getByTestId('ai-settings-bar');
    expect(bar).toHaveTextContent('You have unsaved changes.');
    await userEvent.click(within(bar).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => {
      expect(calls).toEqual([
        { route: 'put', body: { provider_base_url: LOCAL_URL, model: 'llama3.1:8b' } },
      ]);
    });
    expect(await screen.findByText('AI settings saved.')).toBeVisible();
    await waitFor(() => {
      expect(screen.queryByTestId('ai-settings-bar')).toBeNull();
    });
    expect(screen.getByTestId('ai-step-provider')).toHaveAttribute('data-done', 'true');
    expect(screen.getByRole('switch', { name: 'Use AI in this organization' })).toBeEnabled();
  });

  it('a blocked internal host: allow host:port from the result, then the test runs again, green', async () => {
    const calls = serve({ settings: LOCAL, tests: [BLOCKED, OK] });
    await renderApp(PATH);
    await userEvent.click(await screen.findByTestId('ai-test'));
    const blocked = await screen.findByTestId('ai-test-blocked');
    expect(blocked).toHaveTextContent('Cellhive may not call localhost:11434');
    // One short line is announced; the card with its button is outside the live region.
    expect(screen.getByTestId('ai-test-announce')).toHaveTextContent(
      'Cellhive may not call localhost:11434',
    );
    expect(blocked.closest('[role="status"]')).toBeNull();
    await userEvent.click(
      await within(blocked).findByRole('button', { name: 'Allow localhost:11434' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Allow localhost:11434?' });
    expect(within(dialog).getByTestId('ai-allow-pattern')).toHaveValue('localhost:11434');
    expect(await axeViolations(document.body)).toEqual([]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add to allowlist' }));
    await waitFor(() => {
      expect(calls.filter((call) => call.route !== 'put')).toEqual([
        { route: 'test', body: {} },
        { route: 'allowlist', body: { pattern: 'localhost:11434', note: 'AI provider' } },
        { route: 'test', body: {} },
      ]);
    });
    const ok = await screen.findByTestId('ai-test-ok');
    expect(ok).toHaveTextContent('Connected to localhost:11434');
    expect(screen.getByTestId('ai-test-announce')).toHaveTextContent(
      'Connected to localhost:11434',
    );
    expect(ok).toHaveTextContent('llama3.1:8b');
    expect(within(ok).getByTestId('ai-test-format')).toHaveTextContent('JSON schema');
    expect(within(ok).getByTestId('ai-test-latency')).toHaveTextContent('642 ms');
    // The models the provider lists are offered in the model field.
    expect(screen.getByTestId('ai-model')).toHaveAttribute('list');
    expect(
      screen.getByText('The provider lists 2 models: start typing to pick one.'),
    ).toBeVisible();
  });

  it('tests unsaved values, and explains a refused key', async () => {
    const calls = serve({
      settings: OPENAI,
      tests: [
        { ...BLOCKED, error: { code: 'AI_PROVIDER_ERROR', reason: 'http_status', status: 401 } },
      ],
    });
    await renderApp(PATH);
    const model = await screen.findByTestId('ai-model');
    await userEvent.clear(model);
    await userEvent.type(model, 'gpt-5');
    await userEvent.click(screen.getByTestId('ai-test'));
    const failed = await screen.findByTestId('ai-test-failed');
    expect(failed).toHaveTextContent('The provider refused the key');
    expect(failed).toHaveTextContent('HTTP 401');
    expect(calls).toEqual([{ route: 'test', body: { settings: { model: 'gpt-5' } } }]);
  });

  it('the write-only key: saved, replaced, removed — never shown', async () => {
    const calls = serve({ settings: OPENAI });
    await renderApp(PATH);
    const saved = await screen.findByTestId('ai-key-saved');
    expect(saved).toHaveTextContent('Key saved');
    expect(saved).toHaveTextContent('Sent only to api.openai.com');
    // A new host: the saved key would not follow it.
    const url = screen.getByTestId('ai-base-url');
    await userEvent.clear(url);
    await userEvent.type(url, 'https://llm.example.com/v1');
    expect(screen.getByTestId('ai-key-mismatch')).toHaveTextContent(
      'The saved key is only sent to api.openai.com. Enter the key again for llm.example.com.',
    );
    await userEvent.click(within(saved).getByRole('button', { name: 'Replace key' }));
    const input = screen.getByTestId('ai-key-input');
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveValue('');
    await userEvent.type(input, FAKE_KEY);
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => {
      expect(calls).toEqual([
        {
          route: 'put',
          body: { provider_base_url: 'https://llm.example.com/v1', api_key: { value: FAKE_KEY } },
        },
      ]);
    });
    await waitFor(() => {
      expect(screen.getByTestId('ai-key-saved')).toBeVisible();
    });
    expect(screen.queryByDisplayValue(FAKE_KEY)).toBeNull();
    expect(document.body.textContent).not.toContain(FAKE_KEY);

    await userEvent.click(screen.getByRole('button', { name: "Don't use a key" }));
    expect(screen.getByTestId('ai-key-removed')).toHaveTextContent(
      'No key: the saved key is removed when you save.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => {
      expect(calls[1]).toEqual({ route: 'put', body: { api_key: null } });
    });
  });

  it("an IP address cannot hold a key: the key's own message, before and from the server", async () => {
    const calls = serve({
      putProblem: () =>
        json(
          {
            type: 'https://cellhive.io/errors/VALIDATION_FAILED',
            title: 'VALIDATION_FAILED',
            status: 422,
            code: 'VALIDATION_FAILED',
            errors: [
              {
                path: 'api_key',
                code: 'SECRET_HOST_NOT_ALLOWED',
                message: 'An API key can only be sent to a host name, not to an IP address.',
              },
            ],
          },
          422,
        ),
    });
    await renderApp(PATH);
    const message =
      "A key can only be sent to a host name, not to an IP address. Use the provider's host name, or don't use a key.";
    await userEvent.type(await screen.findByTestId('ai-base-url'), 'http://10.0.0.5:8000/v1');
    await userEvent.type(screen.getByTestId('ai-key-input'), FAKE_KEY);
    expect(screen.getByText(message)).toBeVisible();
    expect(calls).toEqual([]);
    // The server says the same (an older client, a race): under the key, not a generic alert.
    await userEvent.clear(screen.getByTestId('ai-key-input'));
    await userEvent.type(screen.getByTestId('ai-model'), 'm');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(await screen.findByText(message)).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('turning record values on asks first, naming the host and the features', async () => {
    const calls = serve({ settings: { ...LOCAL, enabled: true, available: true } });
    await renderApp(PATH);
    await userEvent.click(await screen.findByRole('switch', { name: 'Let AI see record values' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Let AI see record values?' });
    expect(dialog).toHaveTextContent('Record values will be sent to localhost:11434');
    expect(dialog).toHaveTextContent('AI fields: the fields named in the prompt, row by row');
    expect(dialog).toHaveTextContent('Never sent: attachments, record IDs, API keys');
    expect(calls).toEqual([]);
    expect(await axeViolations(document.body)).toEqual([]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Let AI see record values' }));
    await waitFor(() => {
      expect(calls).toEqual([{ route: 'put', body: { allow_record_data: true, confirm: true } }]);
    });
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'Let AI see record values' })).toBeChecked();
    });
    expect(screen.getByText(/are sent to localhost:11434/u)).toBeVisible();
    // Off needs no confirmation.
    await userEvent.click(screen.getByRole('switch', { name: 'Let AI see record values' }));
    await waitFor(() => {
      expect(calls[1]).toEqual({ route: 'put', body: { allow_record_data: false } });
    });
  });

  it('the AI switch and the prompt log apply at once', async () => {
    const calls = serve({ settings: LOCAL });
    await renderApp(PATH);
    await userEvent.click(
      await screen.findByRole('switch', { name: 'Use AI in this organization' }),
    );
    await waitFor(() => {
      expect(calls).toEqual([{ route: 'put', body: { enabled: true } }]);
    });
    expect(await screen.findByText('AI is on for Acme.')).toBeVisible();
    expect(screen.getByTestId('ai-status-badge')).toHaveTextContent('On');
    await userEvent.click(
      screen.getByRole('switch', { name: 'Keep prompts and answers in the audit log' }),
    );
    await waitFor(() => {
      expect(calls[1]).toEqual({ route: 'put', body: { log_prompts: true } });
    });
  });

  it('quota and advanced settings are part of the draft; usage of 30 days by feature', async () => {
    const calls = serve({ settings: OPENAI });
    await renderApp(PATH);
    const usage = await screen.findByTestId('ai-usage');
    expect(await within(usage).findByTestId('ai-usage-today')).toHaveTextContent(
      '250,000 of 1,000,000 tokens',
    );
    expect(within(usage).getByRole('meter', { name: "Today's AI quota" })).toHaveAttribute(
      'aria-valuenow',
      '250000',
    );
    const rows = within(usage).getAllByTestId('ai-usage-row');
    expect(rows.map((row) => row.textContent)).toEqual([
      'Formula writing5≈ estimated 4,900',
      'Connection tests2140',
    ]);
    expect(usage).toHaveTextContent('Estimated: the provider did not report tokens');

    expect(screen.getByTestId('ai-quota')).toHaveValue('1,000,000');
    await userEvent.click(screen.getByTestId('ai-quota-unlimited'));
    await userEvent.click(screen.getByText('Advanced'));
    await userEvent.selectOptions(screen.getByTestId('ai-structured-output'), 'prompt');
    const timeout = screen.getByTestId('ai-timeout');
    await userEvent.clear(timeout);
    await userEvent.type(timeout, '5');
    expect(screen.getByText('Enter 10 to 120 seconds.')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(calls).toEqual([]);
    await userEvent.type(timeout, '0');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => {
      expect(calls).toEqual([
        {
          route: 'put',
          body: {
            structured_output: 'prompt',
            request_timeout_seconds: 50,
            daily_token_limit: null,
          },
        },
      ]);
    });
  });

  it('is in the organization settings nav', async () => {
    serve();
    await renderApp(PATH);
    const nav = await screen.findByRole('navigation', { name: 'Organization settings' });
    expect(within(nav).getByRole('link', { name: 'AI' })).toHaveAttribute('aria-current', 'page');
  });

  it('gives a member who is not an owner/admin the 404 screen', async () => {
    const calls = serve({ role: 'member' });
    await renderApp(PATH);
    expect(await screen.findByText(/not found/iu)).toBeVisible();
    expect(screen.queryByRole('navigation', { name: 'Organization settings' })).toBeNull();
    expect(screen.queryByTestId('ai-status')).toBeNull();
    expect(calls).toEqual([]);
  });
});
