import { describe, expect, it } from 'vitest';

import {
  allowlistPatternOf,
  changesOf,
  draftErrors,
  draftOf,
  keyHostMismatch,
  keyHostOf,
  parseCount,
  presetOf,
  quotaShare,
  testRequestOf,
  testViewOf,
  usageByFeature,
} from '../model';

import type { AiSettingsDto, AiSettingsTestResult } from '@cellhive/contracts';

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

const OPENAI: AiSettingsDto = {
  ...NOT_SET,
  enabled: true,
  provider_base_url: 'https://api.openai.com/v1',
  model: 'gpt-5-mini',
  api_key: {
    secret_id: 'sec_0000000000000001',
    name: 'AI provider key',
    allowed_hosts: ['api.openai.com'],
  },
  token_param: 'max_completion_tokens',
  available: true,
  updated_at: '2026-10-31T09:00:00.000Z',
};

describe('host patterns (CONTRACTS §24, §25.4)', () => {
  it.each([
    ['http://localhost:11434/v1', 'localhost:11434', 'localhost:11434'],
    ['https://api.openai.com/v1', 'api.openai.com:443', 'api.openai.com'],
    ['http://ollama/v1', 'ollama:80', 'ollama:80'],
    ['https://LLM.Corp.Example:8443/v1/', 'llm.corp.example:8443', 'llm.corp.example:8443'],
    ['http://192.168.1.10:11434/v1', null, null],
    ['http://[::1]:11434/v1', null, null],
    ['ftp://example.com/v1', null, null],
    ['https://user:pw@example.com/v1', null, null],
    ['https://example.com/v1?key=1', null, null],
    ['not a url', null, null],
  ])('%s → allowlist %s, key host %s', (url, allowlist, key) => {
    expect(allowlistPatternOf(url)).toBe(allowlist);
    expect(keyHostOf(url)).toBe(key);
  });

  it.each([
    ['https://api.openai.com/v1', 'openai'],
    ['https://api.anthropic.com/v1/', 'anthropic'],
    ['http://localhost:11434/v1', 'ollama'],
    ['http://localhost:8000/v1', 'vllm'],
    ['http://localhost:4000', 'litellm'],
    ['http://ollama:11434/v1', null],
    ['', null],
  ])('preset of %s is %s', (url, preset) => {
    expect(presetOf(url)).toBe(preset);
  });
});

describe('the draft', () => {
  it('starts from the saved settings: an empty key input without a key, "keep" with one', () => {
    expect(draftOf(NOT_SET)).toMatchObject({
      baseUrl: '',
      model: '',
      key: { mode: 'replace', value: '' },
      unlimited: false,
      limit: '1000000',
      timeout: '60',
    });
    expect(draftOf(OPENAI).key).toEqual({ mode: 'keep' });
    expect(draftOf({ ...OPENAI, daily_token_limit: null })).toMatchObject({ unlimited: true });
    expect(changesOf(OPENAI, draftOf(OPENAI))).toBeNull();
  });

  it.each([
    ['en', '1,000,000'],
    ['vi', '1.000.000'],
  ])('shows the quota grouped in %s, and the same quota is no change', (locale, shown) => {
    const draft = draftOf(OPENAI, (value) => new Intl.NumberFormat(locale).format(value));
    expect(draft.limit).toBe(shown);
    expect(changesOf(OPENAI, draft)).toBeNull();
  });

  it.each([
    [
      'a provider for the first time, without a key',
      NOT_SET,
      { baseUrl: ' http://localhost:11434/v1 ', model: 'llama3.1:8b' },
      { provider_base_url: 'http://localhost:11434/v1', model: 'llama3.1:8b' },
    ],
    [
      'a typed key',
      NOT_SET,
      {
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5-mini',
        key: { mode: 'replace', value: 'sk-test-not-real' },
      },
      {
        provider_base_url: 'https://api.openai.com/v1',
        model: 'gpt-5-mini',
        api_key: { value: 'sk-test-not-real' },
      },
    ],
    [
      '"Replace key" with nothing typed keeps it',
      OPENAI,
      { key: { mode: 'replace', value: '' } },
      null,
    ],
    ['"Don\'t use a key"', OPENAI, { key: { mode: 'none' } }, { api_key: null }],
    ['no limit', OPENAI, { unlimited: true }, { daily_token_limit: null }],
    ['a limit with separators', OPENAI, { limit: '2,500,000' }, { daily_token_limit: 2_500_000 }],
    [
      'advanced settings',
      OPENAI,
      { structuredOutput: 'prompt', tokenParam: 'max_tokens', timeout: '120' },
      { structured_output: 'prompt', token_param: 'max_tokens', request_timeout_seconds: 120 },
    ],
    ['clearing the model', OPENAI, { model: '  ' }, { model: null }],
  ] as const)('%s', (_name, settings, patch, expected) => {
    expect(changesOf(settings, { ...draftOf(settings), ...patch })).toEqual(expected);
  });

  it('tests the unsaved provider changes only (never the quota)', () => {
    const draft = { ...draftOf(OPENAI), model: 'gpt-5', unlimited: true };
    expect(testRequestOf(OPENAI, draft)).toEqual({ settings: { model: 'gpt-5' } });
    expect(testRequestOf(OPENAI, draftOf(OPENAI))).toEqual({});
  });

  it.each([
    [{ baseUrl: 'localhost:11434' }, { baseUrl: 'url' }],
    [{ baseUrl: `https://example.com/${'a'.repeat(2048)}` }, { baseUrl: 'urlTooLong' }],
    [{ model: 'm'.repeat(201) }, { model: 'modelTooLong' }],
    [{ key: { mode: 'replace', value: 'line\nbreak' } }, { key: 'keyFormat' }],
    [
      { baseUrl: 'http://10.0.0.5:8000/v1', key: { mode: 'replace', value: 'sk-test-not-real' } },
      { key: 'keyIp' },
    ],
    [{ limit: '9999' }, { limit: 'limit' }],
    [{ limit: 'many' }, { limit: 'limit' }],
    [{ unlimited: true, limit: 'many' }, {}],
    [{ timeout: '5' }, { timeout: 'timeout' }],
    [{ timeout: '121' }, { timeout: 'timeout' }],
    [{ baseUrl: 'http://10.0.0.5:8000/v1' }, {}],
  ] as const)('checks %j', (patch, expected) => {
    expect(draftErrors({ ...draftOf(NOT_SET), ...patch })).toEqual(expected);
  });

  it.each([
    ['1,000,000', 1_000_000],
    ['1.000.000', 1_000_000],
    ['10 000', 10_000],
    ['', null],
    ['-5', null],
    ['1e6', null],
  ])('parses %j as %s', (text, value) => {
    expect(parseCount(text)).toBe(value);
  });

  it('warns when the saved key would not follow a new host', () => {
    const draft = { ...draftOf(OPENAI), baseUrl: 'https://llm.example.com/v1' };
    expect(keyHostMismatch(OPENAI, draft)).toEqual({
      saved: 'api.openai.com',
      next: 'llm.example.com',
    });
    expect(keyHostMismatch(OPENAI, draftOf(OPENAI))).toBeNull();
    expect(
      keyHostMismatch(OPENAI, { ...draft, key: { mode: 'replace', value: 'sk-x' } }),
    ).toBeNull();
    expect(keyHostMismatch(NOT_SET, draftOf(NOT_SET))).toBeNull();
  });
});

describe('test results', () => {
  const failed = (error: AiSettingsTestResult['error']): AiSettingsTestResult => ({
    ok: false,
    models: null,
    structured_output: null,
    token_param: 'max_tokens',
    latency_ms: 12,
    error,
  });

  it.each([
    [{ code: 'AI_PROVIDER_ERROR', reason: 'ssrf_blocked', status: null }, 'ssrf_blocked', true],
    [{ code: 'AI_PROVIDER_ERROR', reason: 'http_status', status: 401 }, 'unauthorized', false],
    [{ code: 'AI_PROVIDER_ERROR', reason: 'http_status', status: 404 }, 'notFound', false],
    [{ code: 'AI_PROVIDER_ERROR', reason: 'http_status', status: 500 }, 'http_status', false],
    [{ code: 'AI_PROVIDER_ERROR', reason: 'network', status: null }, 'network', false],
    [{ code: 'AI_PROVIDER_ERROR', reason: null, status: null }, 'unknown', false],
    [{ code: 'AI_TIMEOUT', reason: null, status: null }, 'timeout', false],
    [{ code: 'AI_INVALID_OUTPUT', reason: null, status: null }, 'invalidOutput', false],
  ] as const)('%j → %s', (error, failure, blocked) => {
    expect(testViewOf(failed(error))).toEqual({ ok: false, failure, blocked });
  });

  it('a success has no failure', () => {
    expect(
      testViewOf({
        ...failed(null),
        ok: true,
        models: ['fake-model'],
        structured_output: 'json_schema',
      }),
    ).toEqual({ ok: true, failure: null, blocked: false });
  });
});

describe('usage', () => {
  it('sums the days by feature in the contract order, leaving unused features out', () => {
    const row = (day: string, feature: 'formula' | 'test', requests: number, estimated = 0) => ({
      day,
      feature,
      requests,
      prompt_tokens: requests * 100,
      completion_tokens: requests * 10,
      estimated_requests: estimated,
    });
    expect(
      usageByFeature([
        row('2026-10-31', 'test', 2),
        row('2026-10-30', 'formula', 3, 1),
        row('2026-10-29', 'test', 1),
      ]),
    ).toEqual([
      { feature: 'formula', requests: 3, promptTokens: 300, completionTokens: 30, estimated: true },
      { feature: 'test', requests: 3, promptTokens: 300, completionTokens: 30, estimated: false },
    ]);
  });

  it.each([
    [{ daily_token_limit: 1000, used_today: 250 }, 0.25],
    [{ daily_token_limit: 1000, used_today: 5000 }, 1],
    [{ daily_token_limit: null, used_today: 5000 }, null],
  ])('quota share of %j is %s', (quota, share) => {
    expect(quotaShare({ ...quota, reset_at: '2026-11-01T00:00:00.000Z' })).toBe(share);
  });
});
