import { describe, expect, it } from 'vitest';

import {
  AppError,
  aiRequestedAfter,
  DEFAULT_AI_SETTINGS,
  defaultTokenParam,
  keyHostPatternOf,
  organizationAiOf,
  parseOutboundUrl,
  providerSettingsOf,
  quotaDayOf,
  requireAi,
  truncateUtf8,
  type AiSettingsState,
} from '../../src/index.js';

import type { Id } from '@cellhive/contracts';

const ready: AiSettingsState = {
  ...DEFAULT_AI_SETTINGS,
  enabled: true,
  provider_base_url: 'https://api.openai.com/v1',
  model: 'gpt-test',
};

/** BACKLOG T906 (CONTRACTS §29.1): the pure parts of the AI settings and quota. */
describe('AI settings and quota (T906)', () => {
  it.each([
    ['UTC, mid-day', '2026-10-31T12:00:00Z', 'UTC', '2026-10-31', '2026-11-01T00:00:00.000Z'],
    [
      'Ho Chi Minh, last second',
      '2026-10-31T16:59:59Z',
      'Asia/Ho_Chi_Minh',
      '2026-10-31',
      '2026-10-31T17:00:00.000Z',
    ],
    [
      'Ho Chi Minh, next day',
      '2026-10-31T17:00:00Z',
      'Asia/Ho_Chi_Minh',
      '2026-11-01',
      '2026-11-01T17:00:00.000Z',
    ],
    [
      'New York, before DST ends',
      '2026-10-31T15:00:00Z',
      'America/New_York',
      '2026-10-31',
      '2026-11-01T04:00:00.000Z',
    ],
    [
      'New York, the day DST ends (25 hours)',
      '2026-11-01T12:00:00Z',
      'America/New_York',
      '2026-11-01',
      '2026-11-02T05:00:00.000Z',
    ],
    [
      'Santiago, midnight skipped by DST',
      '2026-09-05T12:00:00Z',
      'America/Santiago',
      '2026-09-05',
      '2026-09-06T04:00:00.000Z',
    ],
  ])('quotaDayOf: %s', (_name, now, zone, day, resetAt) => {
    const quota = quotaDayOf(new Date(now), zone);
    expect(quota.day).toBe(day);
    expect(quota.resetAt.toISOString()).toBe(resetAt);
    // The reset is the first instant of another day.
    expect(quotaDayOf(quota.resetAt, zone).day).not.toBe(day);
    expect(quotaDayOf(new Date(quota.resetAt.getTime() - 1), zone).day).toBe(day);
  });

  it.each([
    ['https on 443: the host alone', 'https://api.openai.com/v1', 'api.openai.com'],
    ['https on another port', 'https://llm.example:8443/v1', 'llm.example:8443'],
    ['plain http names its port', 'http://ollama:11434/v1', 'ollama:11434'],
    ['plain http on 80 still names it', 'http://llm.example/v1', 'llm.example:80'],
    ['IDN in punycode, lower case', 'https://LLM.Bücher.example/v1', 'llm.xn--bcher-kva.example'],
    ['no entry for an IPv4 address', 'http://192.168.1.5:11434/v1', null],
    ['no entry for an IPv6 address', 'http://[::1]:11434/v1', null],
  ])('keyHostPatternOf: %s', (_name, url, pattern) => {
    expect(keyHostPatternOf(parseOutboundUrl(url))).toBe(pattern);
  });

  it.each([
    ['https://api.openai.com/v1', 'max_completion_tokens'],
    ['https://API.OpenAI.com/v1/', 'max_completion_tokens'],
    ['https://openrouter.ai/api/v1', 'max_tokens'],
    ['http://ollama:11434/v1', 'max_tokens'],
    ['not a url', 'max_tokens'],
    [null, 'max_tokens'],
  ])('defaultTokenParam(%s) = %s', (url, param) => {
    expect(defaultTokenParam(url)).toBe(param);
  });

  it('starts the ladder at the detected rung for auto, at the configured one otherwise', () => {
    expect(providerSettingsOf(ready)).toEqual({
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-test',
      apiKeySecretId: null,
      tokenParam: 'max_completion_tokens',
      requestTimeoutSeconds: 60,
      outputMode: 'json_schema',
    });
    expect(providerSettingsOf({ ...ready, detected_output: 'json_object' })?.outputMode).toBe(
      'json_object',
    );
    expect(
      providerSettingsOf({ ...ready, structured_output: 'prompt', detected_output: 'json_schema' })
        ?.outputMode,
    ).toBe('prompt');
    expect(providerSettingsOf({ ...ready, token_param: 'max_tokens' })?.tokenParam).toBe(
      'max_tokens',
    );
    expect(providerSettingsOf({ ...ready, model: null })).toBeNull();
  });

  it.each([
    ['never saved', undefined, false, 'AI_NOT_CONFIGURED'],
    ['turned off', { ...ready, enabled: false }, false, 'AI_NOT_CONFIGURED'],
    ['no model', { ...ready, model: null }, false, 'AI_NOT_CONFIGURED'],
    ['no URL', { ...ready, provider_base_url: null }, false, 'AI_NOT_CONFIGURED'],
    ['record data off', ready, true, 'AI_RECORD_DATA_DISABLED'],
    ['schema only', ready, false, null],
    ['record data on', { ...ready, allow_record_data: true }, true, null],
  ] as const)('requireAi: %s', (_name, settings, recordData, code) => {
    const run = () => requireAi(settings, { recordData });
    if (code === null) {
      expect(run().model).toBe('gpt-test');
    } else {
      expect(run).toThrow(AppError);
      expect(() => run()).toThrow(expect.objectContaining({ code }) as Error);
    }
  });

  it('tells members whether AI is available, never more', () => {
    expect(organizationAiOf(undefined)).toEqual({ available: false, record_data: false });
    expect(organizationAiOf({ ...ready, allow_record_data: true, enabled: false })).toEqual({
      available: false,
      record_data: false,
    });
    expect(organizationAiOf({ ...ready, allow_record_data: true })).toEqual({
      available: true,
      record_data: true,
    });
  });

  it('cuts audit texts to 4 KB of UTF-8, never inside a character', () => {
    expect(truncateUtf8('abc', 2)).toBe('ab');
    expect(truncateUtf8('ệệ', 4)).toBe('ệ');
    expect(truncateUtf8('a😀b', 4)).toBe('a');
    expect(Buffer.byteLength(truncateUtf8('ệ'.repeat(5000)))).toBeLessThanOrEqual(4096);
  });

  it('keeps prompts out of the audit unless the organization logs them, never for fields or actions', () => {
    const entry = {
      organizationId: 'org_AiSettingsTest01' as Id<'org'>,
      entityType: 'table',
      entityId: null,
      feature: 'ask' as const,
      model: 'm',
      status: 'ok',
      attempts: 2,
      usage: { promptTokens: 10, completionTokens: 5, estimated: false },
      durationMs: 12.4,
      outputMode: 'json_object' as const,
      logPrompts: false,
      input: 'doanh thu theo tháng',
      output: '{"chart":"bar"}',
      context: {
        actor: { type: 'system' as const, id: null },
        via: null,
        batch_id: null,
        request_id: null,
        ip: null,
        user_agent: null,
      },
    };
    expect(aiRequestedAfter(entry)).toEqual({
      feature: 'ask',
      model: 'm',
      status: 'ok',
      attempts: 2,
      prompt_tokens: 10,
      completion_tokens: 5,
      estimated: false,
      duration_ms: 12,
      output_mode: 'json_object',
    });
    expect(aiRequestedAfter({ ...entry, logPrompts: true })).toMatchObject({
      input: 'doanh thu theo tháng',
      output: '{"chart":"bar"}',
    });
    for (const feature of ['field', 'action'] as const) {
      expect(aiRequestedAfter({ ...entry, feature, logPrompts: true })).not.toHaveProperty('input');
    }
  });
});
