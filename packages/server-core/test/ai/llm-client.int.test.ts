import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  startFakeOpenAiServer,
  type FakeOpenAiServer,
} from '../../src/ai/testing/fake-openai-server.js';
import {
  AppError,
  createDeadline,
  LlmClient,
  SCHEMA_INSTRUCTION_LEAD,
  type AiChatMessage,
  type AiKeySource,
  type AiProviderSettings,
  type AiUsage,
  type LlmClientOptions,
} from '../../src/index.js';

import type { Id } from '@cellhive/contracts';

const ORG = 'org_AiClientOrg00001' as Id<'org'>;
const SECRET = 'sec_AiClientKey00001' as Id<'sec'>;
const KEY = 'sk-test-not-a-real-key';

const formulaAnswer = z.strictObject({ formula: z.string(), explanation: z.string() });
const severity = z.enum(['Cao', 'Trung bình', 'Thấp']);

const MESSAGES: readonly AiChatMessage[] = [
  { role: 'system', content: 'You write formulas.' },
  { role: 'user', content: 'Tổng doanh thu' },
];

/** A key source recording what was asked: hosts first, the value only after the host check. */
function keySource(allowedHosts: readonly string[]): AiKeySource & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    hosts: (_org, id) => {
      calls.push(`hosts:${id}`);
      return Promise.resolve({ allowedHosts, legacyHostsUntil: null });
    },
    value: (_org, id) => {
      calls.push(`value:${id}`);
      return Promise.resolve(KEY);
    },
  };
}

/** What may appear in an error (log or client): never the key, a path or a body. */
function expectNothingSecret(error: unknown) {
  const text = JSON.stringify({
    message: (error as Error).message,
    params: (error as AppError).params,
    errors: (error as AppError).errors,
  });
  expect(text).not.toContain(KEY);
  expect(text).not.toContain('/chat/completions');
  expect(text).not.toContain('Tổng doanh thu');
}

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expectNothingSecret(error);
    return error as AppError;
  }
  throw new Error('expected a failure');
}

/**
 * BACKLOG T905 (CONTRACTS §29.7, ADR-39): the Chat Completions client
 * against the fake OpenAI-compatible provider on a loopback port, through
 * the real SSRF core (exact allowlist entry `localhost:<port>`): every rung
 * of the ladder, `400` → one rung down, two repair rounds then
 * `AI_INVALID_OUTPUT`, the deadline, SSRF and key-host refusals before any
 * connection, no redirect, the 1 MiB cap, `refusal`, `finish_reason = length`.
 */
describe('LlmClient with the fake provider (T905)', () => {
  let fake: FakeOpenAiServer;
  let other: FakeOpenAiServer;

  const client = (options: Partial<LlmClientOptions> = {}) =>
    new LlmClient({
      allowlist: [{ host: 'localhost', wildcard: false, port: fake.port }],
      privateAllowlist: 'org',
      keys: keySource([]),
      lookup: () => Promise.resolve(['127.0.0.1']),
      ...options,
    });

  const settings = (patch: Partial<AiProviderSettings> = {}): AiProviderSettings => ({
    baseUrl: fake.baseUrl,
    model: 'fake-model',
    apiKeySecretId: null,
    tokenParam: 'max_tokens',
    requestTimeoutSeconds: 60,
    outputMode: 'json_schema',
    ...patch,
  });

  const structured = (
    llm: LlmClient,
    patch: Partial<AiProviderSettings> = {},
    extra: { deadlineMs?: number; onUsage?: (usage: AiUsage) => void } = {},
  ) =>
    llm.completeStructured({
      organizationId: ORG,
      settings: settings(patch),
      messages: MESSAGES,
      output: { kind: 'json', schema: formulaAnswer, name: 'formula' },
      maxOutputTokens: 300,
      deadline: createDeadline(extra.deadlineMs),
      ...(extra.onUsage === undefined ? {} : { onUsage: extra.onUsage }),
    });

  beforeAll(async () => {
    fake = await startFakeOpenAiServer();
    other = await startFakeOpenAiServer();
  });

  afterAll(async () => {
    await fake.close();
    await other.close();
  });

  beforeEach(() => {
    fake.requests.length = 0;
    other.requests.length = 0;
    Object.assign(fake.capabilities, {
      jsonSchema: true,
      jsonObject: true,
      usage: true,
      failWith: null,
      delayMs: 0,
      apiKey: null,
    });
  });

  describe('the ladder', () => {
    it('json_schema: the strict schema in response_format, nothing else in the body', async () => {
      fake.script({ content: '{"formula":"SUM({Doanh thu})","explanation":"Cộng"}' });
      const result = await structured(client());
      expect(result).toMatchObject({
        value: { formula: 'SUM({Doanh thu})', explanation: 'Cộng' },
        attempts: 1,
        outputMode: 'json_schema',
        usage: { estimated: false },
      });
      const [request] = fake.chatRequests();
      expect(request?.path).toBe('/v1/chat/completions');
      expect(request?.headers['authorization']).toBeUndefined();
      expect(Object.keys(request?.body ?? {}).sort()).toEqual(
        ['max_tokens', 'messages', 'model', 'response_format', 'stream'].sort(),
      );
      expect(request?.body).toMatchObject({
        model: 'fake-model',
        stream: false,
        max_tokens: 300,
        messages: MESSAGES,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'formula',
            strict: true,
            schema: {
              type: 'object',
              required: ['formula', 'explanation'],
              additionalProperties: false,
            },
          },
        },
      });
    });

    it('json_object: JSON mode, the schema in the system prompt; max_completion_tokens when set', async () => {
      const result = await structured(client(), {
        outputMode: 'json_object',
        tokenParam: 'max_completion_tokens',
      });
      // Deterministic answer: the minimal instance of the schema quoted in the prompt.
      expect(result).toMatchObject({
        value: { formula: 'fake', explanation: 'fake' },
        outputMode: 'json_object',
      });
      const body = fake.chatRequests()[0]?.body ?? {};
      expect(body['response_format']).toEqual({ type: 'json_object' });
      expect(body['max_completion_tokens']).toBe(300);
      expect(body).not.toHaveProperty('max_tokens');
      const system = (body['messages'] as AiChatMessage[])[0]?.content ?? '';
      expect(system).toMatch(/^You write formulas\.\n\n/u);
      expect(system).toContain(SCHEMA_INSTRUCTION_LEAD);
      expect(system).toContain('JSON');
    });

    it('prompt: no response_format, the first JSON object of a chatty answer', async () => {
      fake.script({
        content:
          'Đây là công thức:\n```json\n{"formula":"COUNTA({Ngày})","explanation":"Đếm"}\n```',
      });
      const result = await structured(client(), { outputMode: 'prompt' });
      expect(result).toMatchObject({ value: { formula: 'COUNTA({Ngày})' }, outputMode: 'prompt' });
      expect(fake.chatRequests()[0]?.body).not.toHaveProperty('response_format');
    });

    it('400 to response_format: one rung down per refusal, the rung found is returned and kept', async () => {
      fake.capabilities.jsonSchema = false;
      fake.capabilities.jsonObject = false;
      // The first answer of the prompt rung is invalid: the repair round starts at that rung.
      fake.script({ content: 'no JSON here' });
      const result = await structured(client());
      expect(result).toMatchObject({ outputMode: 'prompt', attempts: 2 });
      expect(
        fake.chatRequests().map((request) => {
          const format = request.body?.['response_format'] as { type?: string } | undefined;
          return format?.type ?? 'none';
        }),
      ).toEqual(['json_schema', 'json_object', 'none', 'none']);
    });

    it('400 on the bottom rung (or for text) is an http_status error', async () => {
      fake.capabilities.failWith = 400;
      const error = await failure(structured(client(), { outputMode: 'prompt' }));
      expect(error).toMatchObject({
        code: 'AI_PROVIDER_ERROR',
        status: 502,
        params: {
          reason: 'http_status',
          status: 400,
          temporary: false,
          host: `localhost:${String(fake.port)}`,
        },
      });
      expect(fake.chatRequests()).toHaveLength(1);
    });

    it('an enum root is asked as { result } and answered with the first option', async () => {
      const result = await client().completeStructured({
        organizationId: ORG,
        settings: settings(),
        messages: MESSAGES,
        output: { kind: 'json', schema: severity, name: 'classify' },
        maxOutputTokens: 50,
        deadline: createDeadline(),
      });
      expect(result.value).toBe('Cao');
    });

    it('text output: no response_format, the deterministic text', async () => {
      const result = await client().complete({
        organizationId: ORG,
        settings: settings(),
        messages: MESSAGES,
        output: { kind: 'text' },
        maxOutputTokens: 400,
        deadline: createDeadline(),
      });
      expect(result.content).toMatch(/^fake: [0-9a-f]{12}$/u);
      expect(result.outputMode).toBeNull();
      expect(fake.chatRequests()[0]?.body).not.toHaveProperty('response_format');
    });
  });

  describe('repair rounds', () => {
    it('sends the problems back, twice at most, then AI_INVALID_OUTPUT with the attempts', async () => {
      fake.script(
        { content: '{"formula": 42}' },
        { content: 'Sorry, here: {"formula":"A"}' },
        { content: 'still nothing' },
      );
      const usages: AiUsage[] = [];
      const error = await failure(
        structured(client(), {}, { onUsage: (usage) => usages.push(usage) }),
      );
      expect(error).toMatchObject({
        code: 'AI_INVALID_OUTPUT',
        status: 422,
        params: { attempts: 3 },
        errors: [{ path: '', code: 'AI_INVALID_OUTPUT', params: { attempts: 3 } }],
      });
      expect(usages).toHaveLength(3);
      const requests = fake.chatRequests();
      expect(requests).toHaveLength(3);
      const second = requests[1]?.body?.['messages'] as AiChatMessage[];
      expect(second.at(-2)).toEqual({ role: 'assistant', content: '{"formula": 42}' });
      expect(second.at(-1)?.role).toBe('user');
      expect(second.at(-1)?.content).toContain('"path":"formula","code":"EXPECTED_STRING"');
      expect(second.at(-1)?.content).toContain('"path":"explanation","code":"REQUIRED"');
      const third = requests[2]?.body?.['messages'] as AiChatMessage[];
      expect(third).toHaveLength(MESSAGES.length + 4);
    });

    it("the feature's engine judges too: its problems are sent back, its value returned", async () => {
      fake.script(
        { content: '{"formula":"SUMM({Doanh thu})","explanation":"x"}' },
        { content: '{"formula":"SUM({Doanh thu})","explanation":"x"}' },
      );
      const result = await client().completeStructured(
        {
          organizationId: ORG,
          settings: settings(),
          messages: MESSAGES,
          output: { kind: 'json', schema: formulaAnswer, name: 'formula' },
          maxOutputTokens: 300,
          deadline: createDeadline(),
        },
        (value) =>
          value.formula.startsWith('SUMM')
            ? {
                ok: false,
                problems: [
                  { path: 'formula', code: 'UNKNOWN_FUNCTION', message: 'Unknown function SUMM' },
                ],
              }
            : { ok: true, value: { compiled: value.formula.length } },
      );
      expect(result).toMatchObject({ value: { compiled: 16 }, attempts: 2 });
      expect(result.usage.promptTokens).toBeGreaterThan(0);
      const repair = (fake.chatRequests()[1]?.body?.['messages'] as AiChatMessage[]).at(-1);
      expect(repair?.content).toContain('UNKNOWN_FUNCTION');
    });
  });

  describe('time', () => {
    it('a slow provider runs out the deadline: AI_TIMEOUT', async () => {
      fake.capabilities.delayMs = 1_000;
      const started = Date.now();
      const error = await failure(structured(client(), {}, { deadlineMs: 200 }));
      expect(error).toMatchObject({ code: 'AI_TIMEOUT', status: 504, params: { temporary: true } });
      expect(Date.now() - started).toBeLessThan(900);
    });

    it('request_timeout bounds one call below the deadline', async () => {
      fake.capabilities.delayMs = 1_500;
      const error = await failure(structured(client(), { requestTimeoutSeconds: 1 }));
      expect(error.code).toBe('AI_TIMEOUT');
    });

    it('a spent deadline sends nothing', async () => {
      const before = fake.connections();
      const error = await failure(structured(client(), {}, { deadlineMs: 0 }));
      expect(error.code).toBe('AI_TIMEOUT');
      expect(fake.connections()).toBe(before);
    });

    it('the repair rounds share the deadline', async () => {
      fake.script(
        { content: 'nope', delayMs: 150 },
        { content: 'nope', delayMs: 150 },
        { content: '{"formula":"A","explanation":"B"}', delayMs: 150 },
      );
      // Each call alone fits a 60 s request timeout; together they pass the 400 ms budget.
      const error = await failure(structured(client(), {}, { deadlineMs: 400 }));
      expect(error.code).toBe('AI_TIMEOUT');
      expect(fake.chatRequests().length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('the way out', () => {
    it('a loopback host without an allowlist entry: ssrf_blocked, no connection', async () => {
      const before = fake.connections();
      const error = await failure(structured(client({ allowlist: [] })));
      expect(error).toMatchObject({
        code: 'AI_PROVIDER_ERROR',
        params: { reason: 'ssrf_blocked', ssrf_reason: 'port_not_allowed' },
        errors: [{ params: { reason: 'ssrf_blocked' } }],
      });
      // On a default port the address itself is refused.
      const internal = await failure(
        structured(client({ allowlist: [] }), { baseUrl: 'http://ollama.internal/v1' }),
      );
      expect(internal.params).toMatchObject({
        reason: 'ssrf_blocked',
        ssrf_reason: 'private_address',
        host: 'ollama.internal',
      });
      expect(fake.connections()).toBe(before);
    });

    it('HTTP_PRIVATE_ALLOWLIST=off: even an exact entry does not open loopback', async () => {
      const error = await failure(structured(client({ privateAllowlist: 'off' })));
      expect(error.params).toMatchObject({ reason: 'ssrf_blocked' });
      expect(fake.chatRequests()).toHaveLength(0);
    });

    it('the key goes only to its allowed hosts, checked before it is unsealed', async () => {
      const elsewhere = keySource(['api.openai.com']);
      const before = fake.connections();
      const error = await failure(
        structured(client({ keys: elsewhere }), { apiKeySecretId: SECRET }),
      );
      expect(error.params).toMatchObject({
        reason: 'secret_host_not_allowed',
        secret_reason: 'not_listed',
      });
      expect(elsewhere.calls).toEqual([`hosts:${SECRET}`]);
      expect(fake.connections()).toBe(before);

      const here = keySource([`localhost:${String(fake.port)}`]);
      await structured(client({ keys: here }), { apiKeySecretId: SECRET });
      expect(here.calls).toEqual([`hosts:${SECRET}`, `value:${SECRET}`]);
      expect(fake.chatRequests()[0]?.headers['authorization']).toBe(`Bearer ${KEY}`);
    });

    it('a key gone from the secrets: secret_unavailable, nothing sent', async () => {
      const gone: AiKeySource = {
        hosts: () => Promise.resolve(null),
        value: () => Promise.resolve(null),
      };
      const error = await failure(structured(client({ keys: gone }), { apiKeySecretId: SECRET }));
      expect(error.params).toMatchObject({ reason: 'secret_unavailable' });
      expect(fake.chatRequests()).toHaveLength(0);
    });

    it('a 3xx is never followed', async () => {
      fake.script({
        status: 307,
        headers: { location: `${other.baseUrl}/chat/completions` },
        raw: '',
      });
      const error = await failure(structured(client()));
      expect(error.params).toMatchObject({ reason: 'http_status', status: 307 });
      expect(other.requests).toHaveLength(0);
    });

    it('an answer over 1 MiB: response_too_large', async () => {
      fake.script({ raw: `{"choices":[{"message":{"content":"${'x'.repeat(1_100_000)}"}}]}` });
      const error = await failure(structured(client()));
      expect(error.params).toMatchObject({ reason: 'response_too_large' });
    });

    it('a closed port: network, temporary', async () => {
      const closed = await startFakeOpenAiServer();
      const { port } = closed;
      await closed.close();
      const error = await failure(
        structured(client({ allowlist: [{ host: 'localhost', wildcard: false, port }] }), {
          baseUrl: `http://localhost:${String(port)}/v1`,
        }),
      );
      expect(error.params).toMatchObject({ reason: 'network', temporary: true });
    });
  });

  describe('the answer', () => {
    it.each([
      [429, true],
      [500, true],
      [401, false],
    ])('HTTP %i: http_status, temporary %s', async (status, temporary) => {
      fake.capabilities.failWith = status;
      const error = await failure(structured(client()));
      expect(error.params).toMatchObject({ reason: 'http_status', status, temporary });
      expect(error.errors).toEqual([
        expect.objectContaining({ params: { reason: 'http_status', status } }),
      ]);
    });

    it('a refusal: refused, its usage still reported', async () => {
      fake.script({ content: null, refusal: 'I cannot help with that.' });
      const usages: AiUsage[] = [];
      const error = await failure(
        structured(client(), {}, { onUsage: (usage) => usages.push(usage) }),
      );
      expect(error.params).toMatchObject({ reason: 'refused' });
      expect(usages).toHaveLength(1);
      expect(fake.chatRequests()).toHaveLength(1);
    });

    it('finish_reason = length: truncated', async () => {
      fake.script({ content: '{"formula":"SUM(', finishReason: 'length' });
      const error = await failure(structured(client()));
      expect(error.params).toMatchObject({ reason: 'truncated' });
      expect(fake.chatRequests()).toHaveLength(1);
    });

    it.each([
      ['not JSON', 'Internal error'],
      ['no choices', '{"choices":[]}'],
      ['no message', '{"choices":[{"finish_reason":"stop"}]}'],
      ['null content', '{"choices":[{"message":{"content":null}}]}'],
    ])('%s: invalid_response', async (_name, raw) => {
      fake.script({ raw });
      const error = await failure(structured(client()));
      expect(error.params).toMatchObject({ reason: 'invalid_response' });
    });

    it('no usage from the provider: ~3 characters a token, flagged estimated', async () => {
      fake.capabilities.usage = false;
      fake.script({ content: '{"formula":"SUM({Doanh thu})","explanation":"Cộng"}' });
      const result = await structured(client());
      expect(result.usage).toEqual({
        promptTokens: expect.any(Number) as number,
        completionTokens: Math.ceil(
          '{"formula":"SUM({Doanh thu})","explanation":"Cộng"}'.length / 3,
        ),
        estimated: true,
      });
      expect(result.usage.promptTokens).toBeGreaterThan(0);
    });

    it('a marker in the last message picks a scripted answer; /__script queues over HTTP', async () => {
      fake.whenLastMessageContains('MARK-T905', {
        content: '{"formula":"MARKED","explanation":""}',
      });
      const marked = await client().completeStructured({
        organizationId: ORG,
        settings: settings(),
        messages: [{ role: 'user', content: 'please MARK-T905' }],
        output: { kind: 'json', schema: formulaAnswer, name: 'formula' },
        maxOutputTokens: 300,
        deadline: createDeadline(),
      });
      expect(marked.value.formula).toBe('MARKED');

      const response = await fetch(`http://127.0.0.1:${String(fake.port)}/__script`, {
        method: 'POST',
        body: JSON.stringify([{ content: '{"formula":"QUEUED","explanation":""}' }]),
      });
      expect(response.status).toBe(204);
      expect((await structured(client())).value.formula).toBe('QUEUED');
    });
  });
});
