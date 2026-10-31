import { z } from 'zod';

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

export interface AiCompleteRequest {
  readonly organizationId: Id<'org'>;
  readonly settings: AiProviderSettings;
  readonly messages: readonly AiChatMessage[];
  readonly output: AiOutput;
  readonly maxOutputTokens: number;
  readonly deadline: AiDeadline;
  /**
   * Usage of every answer read — refused or truncated ones too — for the
   * quota ledger, before the outcome is known.
   */
  readonly onUsage?: (usage: AiUsage) => void | Promise<void>;
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

export interface LlmClientOptions {
  readonly allowlist: OutboundAllowlistSource;
  readonly privateAllowlist: PrivateAllowlistMode;
  readonly keys: AiKeySource;
  /** DNS; the system resolver by default (tests inject one). */
  readonly lookup?: HostLookup;
  readonly now?: () => Date;
}

export const AI_USER_AGENT = 'Cellhive/0.1';

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
  usage: z
    .object({
      prompt_tokens: z.int().nonnegative(),
      completion_tokens: z.int().nonnegative(),
    })
    .nullish()
    .catch(null),
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
 * time limited by `min(request_timeout, deadline left)`. No `temperature`,
 * `top_p`, `seed`, `n` or `stream_options` is ever sent. Nothing is logged:
 * errors name the provider host only.
 */
export class LlmClient {
  private readonly now: () => Date;

  constructor(private readonly options: LlmClientOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * One answer. A JSON output starts at `settings.outputMode` and steps one
   * rung down when the provider answers `400` to a `response_format`; the
   * rung that answered is returned. Throws `AI_PROVIDER_ERROR`
   * (`params.reason`) or `AI_TIMEOUT`.
   */
  async complete(request: AiCompleteRequest): Promise<AiCompletion> {
    const { settings, organizationId } = request;
    let url: OutboundUrl;
    try {
      url = parseOutboundUrl(`${settings.baseUrl.replace(/\/+$/u, '')}/chat/completions`);
    } catch (error) {
      throw providerFailure(error, '');
    }
    const host = hostOf(url);
    remainingOrTimeout(request.deadline, host);

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
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': AI_USER_AGENT,
    };
    if (settings.apiKeySecretId !== null) {
      const key = await this.options.keys.value(organizationId, settings.apiKeySecretId);
      if (key === null) throw aiProviderError('secret_unavailable', { host });
      headers['authorization'] = `Bearer ${key}`;
    }

    const output = request.output;
    const schema = output.kind === 'json' ? llmJsonSchemaOf(output.schema) : null;
    let mode: AiOutputMode | null = output.kind === 'json' ? settings.outputMode : null;
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
        [settings.tokenParam]: request.maxOutputTokens,
        ...(responseFormat === undefined ? {} : { response_format: responseFormat }),
      });
      let response: GuardedResponse;
      try {
        response = await guardedRequest(target, {
          method: 'POST',
          headers,
          body,
          timeoutMs: Math.min(
            settings.requestTimeoutSeconds * 1000,
            remainingOrTimeout(request.deadline, host),
          ),
        });
      } catch (error) {
        throw providerFailure(error, host);
      }
      const lower = mode === null ? null : lowerOutputMode(mode);
      if (response.status === 400 && responseFormat !== undefined && lower !== null) {
        // `response_format` not supported: one rung down, same deadline.
        mode = lower;
        continue;
      }
      return this.read(response, request, messages, mode, host);
    }
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

  private async read(
    response: GuardedResponse,
    request: AiCompleteRequest,
    sent: readonly AiChatMessage[],
    mode: AiOutputMode | null,
    host: string,
  ): Promise<AiCompletion> {
    if (response.status < 200 || response.status > 299) {
      // A 3xx is never followed: the provider URL must be the final one.
      throw aiProviderError('http_status', { host, status: response.status });
    }
    let parsed: z.infer<typeof chatResponseSchema>;
    try {
      parsed = chatResponseSchema.parse(JSON.parse(response.body.toString('utf8')));
    } catch {
      throw aiProviderError('invalid_response', { host });
    }
    const [choice] = parsed.choices;
    const content = choice?.message.content ?? null;
    const refusal = choice?.message.refusal ?? null;
    const usage: AiUsage =
      parsed.usage === null || parsed.usage === undefined
        ? {
            promptTokens: estimateTokens(sent.map((message) => message.content).join('\n')),
            completionTokens: estimateTokens(content ?? refusal ?? ''),
            estimated: true,
          }
        : {
            promptTokens: parsed.usage.prompt_tokens,
            completionTokens: parsed.usage.completion_tokens,
            estimated: false,
          };
    await request.onUsage?.(usage);
    if (refusal !== null && refusal !== '') throw aiProviderError('refused', { host });
    if (choice?.finish_reason === 'length') throw aiProviderError('truncated', { host });
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
