import { Buffer } from 'node:buffer';

import { z } from 'zod';

import { AppError } from '../errors/app-error.js';
import { isOutboundHttpError } from '../net/errors.js';
import { guardedRequest, type GuardedResponse } from '../net/guarded-request.js';
import { isLookupQueueTimeout, type HostLookup } from '../net/lookup.js';
import {
  resolveOutboundTarget,
  type OutboundAllowlistSource,
  type OutboundTarget,
  type PrivateAllowlistMode,
} from '../net/resolve-target.js';
import { DEFAULT_OUTBOUND_PORTS, parseOutboundUrl, type OutboundUrl } from '../net/url-policy.js';
import { secretHostDecision, type SecretHostPolicy } from '../secrets/allowed-hosts.js';

import { remainingOrTimeout, type AiDeadline } from './deadline.js';
import { aiInvalidOutput, aiProviderError, aiTimeout } from './errors.js';
import { dropNullOptionals, llmJsonSchema, type LlmJsonSchema } from './json-schema.js';
import { recordAiUsageClamped } from './metrics.js';
import {
  extractJsonObject,
  lowerOutputMode,
  responseFormatOf,
  schemaInstruction,
  type AiOutputMode,
} from './output.js';
import {
  AI_MAX_REPAIR_ROUNDS,
  NOT_JSON_PROBLEM,
  repairMessage,
  zodProblems,
  type AiValidation,
} from './repair.js';

import type { Id } from '@cellhive/contracts';

/** The provider part of an organization's AI settings (`meta.ai_settings`). */
export interface AiProviderSettings {
  /** `provider_base_url`, e.g. `https://api.openai.com/v1` or `http://ollama:11434/v1`. */
  readonly baseUrl: string;
  readonly model: string;
  /** Secret of kind `ai_api_key`; `null` for a provider without a key (local Ollama). */
  readonly apiKeySecretId: Id<'sec'> | null;
  /** Name of the output-token limit: `max_completion_tokens` (OpenAI) or `max_tokens`. */
  readonly tokenParam: 'max_tokens' | 'max_completion_tokens';
  /** Longest single call, under the request's deadline. */
  readonly requestTimeoutSeconds: number;
  /** Rung tried first: the configured one, or the one "Test connection" detected. */
  readonly outputMode: AiOutputMode;
}

export interface AiChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

/** A JSON answer: `name` is `response_format.json_schema.name`. */
export interface AiJsonOutput<T> {
  readonly kind: 'json';
  readonly schema: z.ZodType<T>;
  readonly name: string;
}

export type AiOutput = { readonly kind: 'text' } | AiJsonOutput<unknown>;

/** Tokens of one call or of a whole request; `estimated` when a provider gave no `usage`. */
export interface AiUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly estimated: boolean;
}

/** What a caller hooks into every provider call of one request (CONTRACTS §29.7). */
export interface AiCallHooks {
  /**
   * Usage of every answer read — refused or truncated ones too, and error
   * answers that report it — for the quota ledger, before the outcome is
   * known.
   */
  readonly onUsage?: (usage: AiUsage) => void | Promise<void>;
  /**
   * Runs before **every** HTTP call to the provider (each rung, the resend
   * of a reasoning model, each repair round, `GET /models`): the quota
   * check. Throwing stops the request before anything is sent.
   */
  readonly beforeCall?: () => void | Promise<void>;
  /** The caller gave up (the client closed its request): the call in flight is aborted. */
  readonly signal?: AbortSignal;
}

export interface AiCompleteRequest extends AiCallHooks {
  readonly organizationId: Id<'org'>;
  readonly settings: AiProviderSettings;
  readonly messages: readonly AiChatMessage[];
  readonly output: AiOutput;
  readonly maxOutputTokens: number;
  readonly deadline: AiDeadline;
}

export interface AiCompletion {
  readonly content: string;
  readonly usage: AiUsage;
  /** Rung that answered (`null` for text): settings store it as the detected rung. */
  readonly outputMode: AiOutputMode | null;
}

export interface AiStructuredRequest<T> extends Omit<AiCompleteRequest, 'output'> {
  readonly output: AiJsonOutput<T>;
}

export interface AiStructuredResult<R> {
  readonly value: R;
  /** Calls made: 1 + repair rounds. */
  readonly attempts: number;
  readonly usage: AiUsage;
  readonly outputMode: AiOutputMode;
}

/**
 * Where the API key comes from (`meta.secrets`, kind `ai_api_key`). The
 * client asks for the hosts first and unseals only once the URL passed
 * them (T701, ADR-36 §4). `null`: the secret is gone or unreadable.
 */
export interface AiKeySource {
  hosts(organizationId: Id<'org'>, secretId: Id<'sec'>): Promise<SecretHostPolicy | null>;
  value(organizationId: Id<'org'>, secretId: Id<'sec'>): Promise<string | null>;
}

/** Where the client warns (pino-compatible); it never logs anything else. */
export interface AiClientLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface LlmClientOptions {
  readonly allowlist: OutboundAllowlistSource;
  readonly privateAllowlist: PrivateAllowlistMode;
  readonly keys: AiKeySource;
  /** DNS; the system resolver by default (tests inject one). */
  readonly lookup?: HostLookup;
  readonly now?: () => Date;
  /** Warnings about provider answers (a `usage` out of bounds), without any value. */
  readonly logger?: AiClientLogger;
}

export const AI_USER_AGENT = 'Cellhive/0.1';

/**
 * Output tokens added for a model that reasons before it answers (QA S8):
 * its reasoning counts against `max_tokens`, so a fixed cap of a feature
 * (the Q&A narrative's 400, a plan's 600, an AI field's 300) can be spent
 * before a word of the answer. A call cut off while the model reasoned is
 * sent again once with this allowance, and later calls to that model start
 * with it.
 */
export const AI_REASONING_ALLOWANCE_TOKENS = 2_048;
/** Models remembered as reasoning, per API or worker process. */
const REASONING_MODELS_MAX = 1_000;

/** Rough token count where a provider reports none (research §2.4: ~3 characters a token, safe for Vietnamese). */
export function estimateTokens(text: string): number {
  return Math.ceil(Array.from(text).length / 3);
}

const chatResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullish(),
          refusal: z.string().nullish(),
        }),
        finish_reason: z.string().nullish(),
      }),
    )
    .min(1),
});

/** A token count as a provider may write it; anything else counts as no `usage`. */
const tokenCountSchema = z.number().nonnegative();
const usageSchema = z.object({
  prompt_tokens: tokenCountSchema,
  completion_tokens: tokenCountSchema,
});

/** The body as JSON, `undefined` when it is not. */
function jsonOf(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Bytes of a `400` read for {@link mentionsResponseFormat}: provider error
 * messages are short, the rest of a large body is never looked at.
 */
const ERROR_SCAN_BYTES = 16_384;

/**
 * Whether a `400` is about `response_format` (the rung is not supported):
 * its body names `response_format` or `json_schema`. Only read here, never
 * copied into an error or a log.
 */
function mentionsResponseFormat(body: Buffer): boolean {
  const text = body.subarray(0, ERROR_SCAN_BYTES).toString('utf8').toLowerCase();
  return text.includes('response_format') || text.includes('json_schema');
}

const isRecordValue = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Whether an answer shows the model reasoned before answering: reasoning
 * tokens in `usage.completion_tokens_details` (OpenAI, DeepSeek) or a
 * reasoning text beside the content (`reasoning_content`: DeepSeek, vLLM;
 * `reasoning`: Ollama, OpenRouter). Read from the raw JSON: a provider that
 * shapes these differently only loses the allowance.
 */
function showsReasoning(json: unknown): boolean {
  if (!isRecordValue(json)) return false;
  const usage = json['usage'];
  const details = isRecordValue(usage) ? usage['completion_tokens_details'] : undefined;
  const tokens = isRecordValue(details) ? details['reasoning_tokens'] : undefined;
  if (typeof tokens === 'number' && tokens > 0) return true;
  const choices = json['choices'];
  const first: unknown = Array.isArray(choices) ? choices[0] : undefined;
  const message = isRecordValue(first) ? first['message'] : undefined;
  if (!isRecordValue(message)) return false;
  return ['reasoning_content', 'reasoning'].some((key) => {
    const text = message[key];
    return typeof text === 'string' && text.trim() !== '';
  });
}

/** `AI_PROVIDER_ERROR truncated` of an answer cut off while the model reasoned. */
function isReasoningCutOff(error: unknown): boolean {
  return (
    error instanceof AppError &&
    error.params?.['reason'] === 'truncated' &&
    error.params['reasoning'] === 1
  );
}

/** `GET /models` of OpenAI-compatible servers (OpenAI, Ollama, vLLM, llama.cpp, LiteLLM). */
const modelsResponseSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1).max(500) })),
});

const schemaCache = new WeakMap<z.ZodType, LlmJsonSchema>();

function llmJsonSchemaOf(schema: z.ZodType): LlmJsonSchema {
  let converted = schemaCache.get(schema);
  if (converted === undefined) {
    converted = llmJsonSchema(schema);
    schemaCache.set(schema, converted);
  }
  return converted;
}

/** Host (and a non-default port) of the provider: what logs and errors may name. */
function hostOf(url: OutboundUrl): string {
  return DEFAULT_OUTBOUND_PORTS.has(url.port) ? url.host : `${url.host}:${String(url.port)}`;
}

/** Outbound failures as AI errors (no URL, address or body in any of them). */
function providerFailure(error: unknown, host: string): unknown {
  if (isLookupQueueTimeout(error)) return aiProviderError('network', { host, cause: error });
  if (!isOutboundHttpError(error)) return error;
  switch (error.code) {
    case 'ssrf_blocked':
      return aiProviderError('ssrf_blocked', {
        host,
        params: { ssrf_reason: String(error.params['reason'] ?? '') },
      });
    case 'http_timeout':
      return aiTimeout(host);
    case 'http_response_too_large':
      return aiProviderError('response_too_large', { host });
    case 'http_network':
      return aiProviderError('network', { host, cause: error });
  }
}

/** The schema instruction of the lower rungs, appended to the (first) system message. */
function withInstruction(
  messages: readonly AiChatMessage[],
  instruction: string,
): readonly AiChatMessage[] {
  const index = messages.findIndex((message) => message.role === 'system');
  if (index === -1) return [{ role: 'system', content: instruction }, ...messages];
  return messages.map((message, at) =>
    at === index ? { ...message, content: `${message.content}\n\n${instruction}` } : message,
  );
}

/**
 * The one way to an LLM (CONTRACTS §29.7, ADR-39): OpenAI-compatible Chat
 * Completions, non-streaming, over `guardedRequest` — no SDK. Every call:
 * the URL vetted by the SSRF core (organization allowlist,
 * `HTTP_PRIVATE_ALLOWLIST`), the key sent only to its allowed hosts (checked
 * before it is unsealed), no redirect followed, a 1 MiB answer cap, the
 * time limited by `min(request_timeout, deadline left)`, the caller's
 * `beforeCall` (the quota) first and its abort signal through. No
 * `temperature`, `top_p`, `seed`, `n` or `stream_options` is ever sent.
 * Nothing is logged but a warning without values for a `usage` out of
 * bounds: errors name the provider host only.
 */
export class LlmClient {
  private readonly now: () => Date;
  /** `organization, base URL, model` of models seen reasoning (QA S8). */
  private readonly reasoningModels = new Set<string>();

  constructor(private readonly options: LlmClientOptions) {
    this.now = options.now ?? (() => new Date());
  }

  private static modelKey(request: AiCompleteRequest): string {
    const { settings } = request;
    return `${request.organizationId}\n${settings.baseUrl}\n${settings.model}`;
  }

  private rememberReasoning(key: string): void {
    if (this.reasoningModels.has(key)) return;
    if (this.reasoningModels.size >= REASONING_MODELS_MAX) this.reasoningModels.clear();
    this.reasoningModels.add(key);
  }

  /**
   * One answer. A JSON output starts at `settings.outputMode` and steps one
   * rung down when the provider answers `400` about `response_format`
   * (its body names `response_format` or `json_schema`; any other `400` is
   * an error); the rung that answered is returned. Every HTTP call —
   * each rung, the resend of a reasoning model — runs `beforeCall` first.
   * Throws `AI_PROVIDER_ERROR` (`params.reason`), `AI_TIMEOUT`, what
   * `beforeCall` throws, or the abort reason of `signal`.
   */
  async complete(request: AiCompleteRequest): Promise<AiCompletion> {
    const { settings } = request;
    const { target, headers, host } = await this.connect(
      request.organizationId,
      settings,
      '/chat/completions',
      request.deadline,
    );

    const output = request.output;
    const schema = output.kind === 'json' ? llmJsonSchemaOf(output.schema) : null;
    let mode: AiOutputMode | null = output.kind === 'json' ? settings.outputMode : null;
    const key = LlmClient.modelKey(request);
    // A reasoning model gets room for its reasoning; one cut off while reasoning, once more.
    let allowance = this.reasoningModels.has(key) ? AI_REASONING_ALLOWANCE_TOKENS : 0;
    for (;;) {
      let messages = request.messages;
      let responseFormat: Record<string, unknown> | undefined;
      if (mode !== null && schema !== null && output.kind === 'json') {
        const instruction = schemaInstruction(mode, schema);
        if (instruction !== null) messages = withInstruction(messages, instruction);
        responseFormat = responseFormatOf(mode, output.name, schema);
      }
      const body = JSON.stringify({
        model: settings.model,
        messages,
        stream: false,
        [settings.tokenParam]: request.maxOutputTokens + allowance,
        ...(responseFormat === undefined ? {} : { response_format: responseFormat }),
      });
      const response = await this.send(target, request, host, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body,
      });
      const json = jsonOf(response.body);
      const sent = { messages, bytes: Buffer.byteLength(body) };
      const lower = mode === null ? null : lowerOutputMode(mode);
      if (
        response.status === 400 &&
        responseFormat !== undefined &&
        lower !== null &&
        mentionsResponseFormat(response.body)
      ) {
        // `response_format` not supported: one rung down, same deadline.
        await this.reportErrorUsage(json, request, sent, host);
        mode = lower;
        continue;
      }
      try {
        return await this.read(response, json, request, sent, mode, host, key);
      } catch (error) {
        if (allowance === 0 && isReasoningCutOff(error)) {
          allowance = AI_REASONING_ALLOWANCE_TOKENS;
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * The model ids of `GET {base}/models` ("Test connection", T906), at most
   * `max`, in the provider's order — through the same door as `complete`
   * (allowlist, key host check, `beforeCall`, no redirect, 1 MiB). Throws
   * `AI_PROVIDER_ERROR` (`http_status` for a provider without the route)
   * or `AI_TIMEOUT`.
   */
  async listModels(
    request: {
      readonly organizationId: Id<'org'>;
      readonly settings: AiProviderSettings;
      readonly deadline: AiDeadline;
      readonly max: number;
    } & Pick<AiCallHooks, 'beforeCall' | 'signal'>,
  ): Promise<string[]> {
    const { target, headers, host } = await this.connect(
      request.organizationId,
      request.settings,
      '/models',
      request.deadline,
    );
    const response = await this.send(target, request, host, { method: 'GET', headers });
    if (response.status < 200 || response.status > 299) {
      throw aiProviderError('http_status', { host, status: response.status });
    }
    try {
      const parsed = modelsResponseSchema.parse(JSON.parse(response.body.toString('utf8')));
      return parsed.data.slice(0, request.max).map((model) => model.id);
    } catch {
      throw aiProviderError('invalid_response', { host });
    }
  }

  /**
   * One HTTP call: `beforeCall` first (the quota — it may refuse), then
   * the request with the time left and the caller's abort signal. A caller
   * that gave up gets its own abort reason back, never a provider error.
   */
  private async send(
    target: OutboundTarget,
    request: Pick<AiCompleteRequest, 'settings' | 'deadline'> &
      Pick<AiCallHooks, 'beforeCall' | 'signal'>,
    host: string,
    options: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<GuardedResponse> {
    request.signal?.throwIfAborted();
    await request.beforeCall?.();
    request.signal?.throwIfAborted();
    try {
      return await guardedRequest(target, {
        ...options,
        timeoutMs: Math.min(
          request.settings.requestTimeoutSeconds * 1000,
          remainingOrTimeout(request.deadline, host),
        ),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } catch (error) {
      if (request.signal?.aborted === true) throw request.signal.reason;
      throw providerFailure(error, host);
    }
  }

  /**
   * `usage` of an answer within what the call could have used: prompt
   * tokens at most the UTF-8 bytes sent (a token is at least a byte),
   * answer tokens at most `max_output_tokens` plus the reasoning allowance.
   * A count past either bound is a provider bug or a hostile answer: it is
   * cut to the bound, with a warning (no value) and `ai_usage_clamped_total`.
   */
  private clamped(
    usage: AiUsage,
    request: AiCompleteRequest,
    bytes: number,
    host: string,
  ): AiUsage {
    const maxCompletion = request.maxOutputTokens + AI_REASONING_ALLOWANCE_TOKENS;
    const prompt = Math.ceil(usage.promptTokens);
    const completion = Math.ceil(usage.completionTokens);
    const kinds: ('prompt' | 'completion')[] = [];
    if (prompt > bytes) kinds.push('prompt');
    if (completion > maxCompletion) kinds.push('completion');
    for (const kind of kinds) {
      recordAiUsageClamped(kind);
      this.options.logger?.warn(
        { provider_host: host, kind },
        'ai usage out of bounds: counted at its bound',
      );
    }
    return {
      promptTokens: Math.min(prompt, bytes),
      completionTokens: Math.min(completion, maxCompletion),
      estimated: usage.estimated,
    };
  }

  /** The `usage` an answer reports (clamped), `null` without a readable one. */
  private reportedUsage(
    json: unknown,
    request: AiCompleteRequest,
    bytes: number,
    host: string,
  ): AiUsage | null {
    const usage = usageSchema.safeParse(isRecordValue(json) ? json['usage'] : undefined);
    if (!usage.success) return null;
    return this.clamped(
      {
        promptTokens: usage.data.prompt_tokens,
        completionTokens: usage.data.completion_tokens,
        estimated: false,
      },
      request,
      bytes,
      host,
    );
  }

  /** An error answer that reports `usage` (it was billed): into the ledger before the error. */
  private async reportErrorUsage(
    json: unknown,
    request: AiCompleteRequest,
    sent: { readonly bytes: number },
    host: string,
  ): Promise<void> {
    const usage = this.reportedUsage(json, request, sent.bytes, host);
    if (usage !== null) await request.onUsage?.(usage);
  }

  /**
   * `{base}{path}` vetted for `organizationId`: the URL parsed, the key's
   * allowed hosts checked **before** it is unsealed, the address resolved
   * and pinned by the SSRF core, then the headers (with the key).
   */
  private async connect(
    organizationId: Id<'org'>,
    settings: AiProviderSettings,
    path: string,
    deadline: AiDeadline,
  ): Promise<{ target: OutboundTarget; headers: Record<string, string>; host: string }> {
    let url: OutboundUrl;
    try {
      url = parseOutboundUrl(`${settings.baseUrl.replace(/\/+$/u, '')}${path}`);
    } catch (error) {
      throw providerFailure(error, '');
    }
    const host = hostOf(url);
    remainingOrTimeout(deadline, host);

    if (settings.apiKeySecretId !== null) {
      const policy = await this.options.keys.hosts(organizationId, settings.apiKeySecretId);
      if (policy === null) throw aiProviderError('secret_unavailable', { host });
      const decision = secretHostDecision(policy, url, this.now());
      if (!decision.allowed) {
        throw aiProviderError('secret_host_not_allowed', {
          host,
          params: { secret_reason: decision.reason },
        });
      }
    }
    let target: OutboundTarget;
    try {
      target = await resolveOutboundTarget(url, {
        organizationId,
        allowlist: this.options.allowlist,
        privateAllowlist: this.options.privateAllowlist,
        ...(this.options.lookup === undefined ? {} : { lookup: this.options.lookup }),
      });
    } catch (error) {
      throw providerFailure(error, host);
    }
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': AI_USER_AGENT,
    };
    if (settings.apiKeySecretId !== null) {
      const key = await this.options.keys.value(organizationId, settings.apiKeySecretId);
      if (key === null) throw aiProviderError('secret_unavailable', { host });
      headers['authorization'] = `Bearer ${key}`;
    }
    return { target, headers, host };
  }

  /**
   * A JSON answer judged by zod then by the feature's `validate` (its
   * engine: formula typecheck, automation validation, widget config…), with
   * at most {@link AI_MAX_REPAIR_ROUNDS} repair rounds sending the problems
   * back; then `422 AI_INVALID_OUTPUT` (`params.attempts`). Every call
   * shares `request.deadline`; a rung found on the way is kept.
   */
  async completeStructured<T, R = T>(
    request: AiStructuredRequest<T>,
    validate?: (value: T) => AiValidation<R> | Promise<AiValidation<R>>,
  ): Promise<AiStructuredResult<R>> {
    const schema = llmJsonSchemaOf(request.output.schema);
    const answerSchema: z.ZodType = schema.wrapped
      ? z.object({ result: request.output.schema })
      : request.output.schema;
    let messages = request.messages;
    let mode = request.settings.outputMode;
    let usage: AiUsage = { promptTokens: 0, completionTokens: 0, estimated: false };
    for (let attempt = 1; ; attempt += 1) {
      const completion = await this.complete({
        ...request,
        settings: { ...request.settings, outputMode: mode },
        messages,
      });
      mode = completion.outputMode ?? mode;
      usage = {
        promptTokens: usage.promptTokens + completion.usage.promptTokens,
        completionTokens: usage.completionTokens + completion.usage.completionTokens,
        estimated: usage.estimated || completion.usage.estimated,
      };
      const parsed = parseAnswer(completion.content, schema, answerSchema);
      const verdict: AiValidation<R> = !parsed.ok
        ? parsed
        : validate === undefined
          ? { ok: true, value: parsed.value as R }
          : await validate(parsed.value as T);
      if (verdict.ok) return { value: verdict.value, attempts: attempt, usage, outputMode: mode };
      if (attempt > AI_MAX_REPAIR_ROUNDS) throw aiInvalidOutput(attempt);
      messages = [
        ...messages,
        { role: 'assistant', content: completion.content },
        { role: 'user', content: repairMessage(verdict.problems) },
      ];
    }
  }

  /**
   * An answer: its `usage` is read **first** — before the status and the
   * shape of `choices` are judged — so every billed answer reaches the
   * ledger (clamped, see {@link clamped}); without one, a readable answer
   * is estimated.
   */
  private async read(
    response: GuardedResponse,
    json: unknown,
    request: AiCompleteRequest,
    sent: { readonly messages: readonly AiChatMessage[]; readonly bytes: number },
    mode: AiOutputMode | null,
    host: string,
    modelKey: string,
  ): Promise<AiCompletion> {
    if (response.status < 200 || response.status > 299) {
      await this.reportErrorUsage(json, request, sent, host);
      // A 3xx is never followed: the provider URL must be the final one.
      const retryAfter = response.headers['retry-after'];
      throw aiProviderError('http_status', {
        host,
        status: response.status,
        retryAfter: typeof retryAfter === 'string' ? retryAfter : (retryAfter?.[0] ?? null),
      });
    }
    const reported = this.reportedUsage(json, request, sent.bytes, host);
    const parsed = chatResponseSchema.safeParse(json);
    if (!parsed.success) {
      if (reported !== null) await request.onUsage?.(reported);
      throw aiProviderError('invalid_response', { host });
    }
    const reasoned = showsReasoning(json);
    if (reasoned) this.rememberReasoning(modelKey);
    const [choice] = parsed.data.choices;
    const content = choice?.message.content ?? null;
    const refusal = choice?.message.refusal ?? null;
    const usage: AiUsage =
      reported ??
      this.clamped(
        {
          promptTokens: estimateTokens(sent.messages.map((message) => message.content).join('\n')),
          completionTokens: estimateTokens(content ?? refusal ?? ''),
          estimated: true,
        },
        request,
        sent.bytes,
        host,
      );
    await request.onUsage?.(usage);
    if (refusal !== null && refusal !== '') throw aiProviderError('refused', { host });
    if (choice?.finish_reason === 'length') {
      throw aiProviderError('truncated', {
        host,
        ...(reasoned ? { params: { reasoning: 1 } } : {}),
      });
    }
    if (content === null) throw aiProviderError('invalid_response', { host });
    return { content, usage, outputMode: mode };
  }
}

/** The answer as JSON, null optionals dropped, checked by zod (not yet by the feature). */
function parseAnswer(
  content: string,
  schema: LlmJsonSchema,
  answerSchema: z.ZodType,
): AiValidation<unknown> {
  const found = extractJsonObject(content);
  if (found === undefined) return { ok: false, problems: [NOT_JSON_PROBLEM] };
  // `reportInput` only tells a missing key (`REQUIRED`) from a wrong type; the value is never copied.
  const parsed = answerSchema.safeParse(dropNullOptionals(found, schema.source), {
    reportInput: true,
  });
  if (!parsed.success) return { ok: false, problems: zodProblems(parsed.error) };
  return {
    ok: true,
    value: schema.wrapped ? (parsed.data as { result: unknown }).result : parsed.data,
  };
}
