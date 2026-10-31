import {
  AI_DEFAULT_DAILY_TOKEN_LIMIT,
  AI_FEATURES,
  AI_MAX_BASE_URL_LENGTH,
  AI_MAX_DAILY_TOKEN_LIMIT,
  AI_MAX_MODEL_LENGTH,
  AI_MAX_REQUEST_TIMEOUT_SECONDS,
  AI_MIN_DAILY_TOKEN_LIMIT,
  AI_MIN_REQUEST_TIMEOUT_SECONDS,
  isValidSecretValue,
  parseAllowlistPattern,
  type AiFeature,
  type AiSettingsDto,
  type AiSettingsTestResult,
  type AiStructuredOutput,
  type AiTokenParam,
  type AiUsageDto,
  type TestAiSettingsRequest,
  type UpdateAiSettingsRequest,
} from '@cellhive/contracts';

/**
 * Pure model of the organization AI settings page (FRONTEND §15.8, T912;
 * CONTRACTS §29.1): the draft of the provider form, what `PUT` and
 * "Test connection" send, the host:port an allowlist entry needs, and the
 * usage table. Table-driven tests in `__tests__/model.test.ts`.
 */

/** Base URL suggestions (research §5.7): hosted APIs, then servers run next to Cellhive. */
export const PROVIDER_PRESETS = [
  { id: 'openai', url: 'https://api.openai.com/v1' },
  { id: 'anthropic', url: 'https://api.anthropic.com/v1' },
  { id: 'ollama', url: 'http://localhost:11434/v1' },
  { id: 'vllm', url: 'http://localhost:8000/v1' },
  { id: 'litellm', url: 'http://localhost:4000/v1' },
] as const;
export type ProviderPresetId = (typeof PROVIDER_PRESETS)[number]['id'];

/** The preset whose URL is typed (same scheme and host; the port of a local server may differ). */
export function presetOf(baseUrl: string): ProviderPresetId | null {
  const url = parseHttpUrl(baseUrl);
  if (url === null) return null;
  return (
    PROVIDER_PRESETS.find((preset) => {
      const known = new URL(preset.url);
      return known.protocol === url.protocol && known.host === url.host;
    })?.id ?? null
  );
}

/**
 * The key: kept as saved, a new value typed (empty: nothing to send yet),
 * or no key at all (`api_key: null` — a local Ollama).
 */
export type KeyDraft =
  | { readonly mode: 'keep' }
  | { readonly mode: 'replace'; readonly value: string }
  | { readonly mode: 'none' };

export interface AiDraft {
  readonly baseUrl: string;
  readonly model: string;
  readonly key: KeyDraft;
  /** `null` daily limit = "No limit". */
  readonly unlimited: boolean;
  /** As typed (digits, maybe with separators). */
  readonly limit: string;
  readonly structuredOutput: AiStructuredOutput;
  readonly tokenParam: AiTokenParam;
  readonly timeout: string;
}

/** The draft of saved settings: nothing changed yet; the quota shown with `formatCount` ("1,000,000"). */
export function draftOf(
  settings: AiSettingsDto,
  formatCount: (value: number) => string = String,
): AiDraft {
  return {
    baseUrl: settings.provider_base_url ?? '',
    model: settings.model ?? '',
    key: settings.api_key === null ? { mode: 'replace', value: '' } : { mode: 'keep' },
    unlimited: settings.daily_token_limit === null,
    limit: formatCount(settings.daily_token_limit ?? AI_DEFAULT_DAILY_TOKEN_LIMIT),
    structuredOutput: settings.structured_output,
    tokenParam: settings.token_param,
    timeout: String(settings.request_timeout_seconds),
  };
}

/** `http(s)` URL without user info, query or fragment (as the server's `parseBaseUrl`), else `null`. */
function parseHttpUrl(text: string): URL | null {
  const value = text.trim();
  if (value === '' || /[?#]/u.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '' || url.hostname === '') return null;
  return url;
}

function portOf(url: URL): number {
  return url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
}

/**
 * The allowlist entry that lets the server call `baseUrl` (CONTRACTS
 * §25.4): `host:port` always — a loopback host opens with an exact host and
 * port only, a private one with either. `null` for an IP address (entries
 * are host names) or a URL that is not one.
 */
export function allowlistPatternOf(baseUrl: string): string | null {
  const url = parseHttpUrl(baseUrl);
  if (url === null) return null;
  return parseAllowlistPattern(`${url.hostname}:${String(portOf(url))}`)?.pattern ?? null;
}

/**
 * The `allowed_hosts` entry a key saved for `baseUrl` gets (the server's
 * `keyHostPatternOf`): the host for `https` on 443, else `host:port`;
 * `null` for an IP address — a key can only go to a host name.
 */
export function keyHostOf(baseUrl: string): string | null {
  const url = parseHttpUrl(baseUrl);
  if (url === null) return null;
  const port = portOf(url);
  const text =
    url.protocol === 'https:' && port === 443 ? url.hostname : `${url.hostname}:${String(port)}`;
  return parseAllowlistPattern(text)?.pattern ?? null;
}

/** Host (and port when not the default one) shown to people: "api.openai.com", "localhost:11434". */
export function displayHostOf(baseUrl: string | null): string | null {
  const url = baseUrl === null ? null : parseHttpUrl(baseUrl);
  return url === null ? null : url.host;
}

/**
 * The saved key will not follow a new provider host (CONTRACTS §29.1): the
 * host it is bound to and the new one, when the draft keeps the key but
 * points elsewhere.
 */
export function keyHostMismatch(
  settings: AiSettingsDto,
  draft: AiDraft,
): { readonly saved: string; readonly next: string } | null {
  if (settings.api_key === null || draft.key.mode !== 'keep') return null;
  const next = keyHostOf(draft.baseUrl);
  const [saved] = settings.api_key.allowed_hosts;
  if (next === null || saved === undefined || settings.api_key.allowed_hosts.includes(next)) {
    return null;
  }
  return { saved, next };
}

/** A number typed with or without separators ("1,000,000", "1.000.000"); `null` when not one. */
export function parseCount(text: string): number | null {
  const digits = text.replace(/[\s.,_]/gu, '');
  return /^[0-9]{1,12}$/u.test(digits) ? Number(digits) : null;
}

export type DraftField = 'baseUrl' | 'model' | 'key' | 'limit' | 'timeout';
/** Reason keys of `orgAi:errors.*`. */
export type DraftError =
  'url' | 'urlTooLong' | 'modelTooLong' | 'keyFormat' | 'keyIp' | 'limit' | 'timeout';

/** `errors[].path` of `PUT …/ai-settings` (CONTRACTS §29.1) → the field it is shown under. */
export const SERVER_PATHS: Readonly<Record<string, DraftField>> = {
  provider_base_url: 'baseUrl',
  model: 'model',
  api_key: 'key',
  'api_key.value': 'key',
  'api_key.secret_id': 'key',
  daily_token_limit: 'limit',
  request_timeout_seconds: 'timeout',
};

/** Client-side checks, the same rules as the API's zod schema and service. */
export function draftErrors(draft: AiDraft): Partial<Record<DraftField, DraftError>> {
  const errors: Partial<Record<DraftField, DraftError>> = {};
  const url = draft.baseUrl.trim();
  if (url.length > AI_MAX_BASE_URL_LENGTH) errors.baseUrl = 'urlTooLong';
  else if (url !== '' && parseHttpUrl(url) === null) errors.baseUrl = 'url';
  if (draft.model.trim().length > AI_MAX_MODEL_LENGTH) errors.model = 'modelTooLong';
  const key = draft.key.mode === 'replace' ? draft.key.value.trim() : '';
  if (key !== '' && !isValidSecretValue('ai_api_key', key)) errors.key = 'keyFormat';
  // The server refuses a key for an IP address (`SECRET_HOST_NOT_ALLOWED`, T906).
  else if (key !== '' && parseHttpUrl(url) !== null && keyHostOf(url) === null) {
    errors.key = 'keyIp';
  }
  if (!draft.unlimited) {
    const limit = parseCount(draft.limit);
    if (limit === null || limit < AI_MIN_DAILY_TOKEN_LIMIT || limit > AI_MAX_DAILY_TOKEN_LIMIT) {
      errors.limit = 'limit';
    }
  }
  const timeout = parseCount(draft.timeout);
  if (
    timeout === null ||
    timeout < AI_MIN_REQUEST_TIMEOUT_SECONDS ||
    timeout > AI_MAX_REQUEST_TIMEOUT_SECONDS
  ) {
    errors.timeout = 'timeout';
  }
  return errors;
}

type ProviderChanges = NonNullable<TestAiSettingsRequest['settings']>;

/** The provider keys that differ from the saved settings (what "Test connection" tries). */
function providerChanges(settings: AiSettingsDto, draft: AiDraft): ProviderChanges {
  const body: ProviderChanges = {};
  const url = draft.baseUrl.trim();
  if (url !== (settings.provider_base_url ?? '')) body.provider_base_url = url === '' ? null : url;
  const model = draft.model.trim();
  if (model !== (settings.model ?? '')) body.model = model === '' ? null : model;
  if (draft.key.mode === 'none' && settings.api_key !== null) body.api_key = null;
  if (draft.key.mode === 'replace' && draft.key.value.trim() !== '') {
    body.api_key = { value: draft.key.value.trim() };
  }
  if (draft.structuredOutput !== settings.structured_output) {
    body.structured_output = draft.structuredOutput;
  }
  if (draft.tokenParam !== settings.token_param) body.token_param = draft.tokenParam;
  const timeout = parseCount(draft.timeout);
  if (timeout !== null && timeout !== settings.request_timeout_seconds) {
    body.request_timeout_seconds = timeout;
  }
  return body;
}

/** The `PUT` body of the form: changed keys only, `null` when nothing changed. */
export function changesOf(settings: AiSettingsDto, draft: AiDraft): UpdateAiSettingsRequest | null {
  const body: UpdateAiSettingsRequest = { ...providerChanges(settings, draft) };
  const limit = draft.unlimited ? null : parseCount(draft.limit);
  if (limit !== settings.daily_token_limit && (draft.unlimited || limit !== null)) {
    body.daily_token_limit = limit;
  }
  return Object.keys(body).length === 0 ? null : body;
}

/** The `POST …/test` body: the unsaved provider changes, if any. */
export function testRequestOf(settings: AiSettingsDto, draft: AiDraft): TestAiSettingsRequest {
  const changes = providerChanges(settings, draft);
  return Object.keys(changes).length === 0 ? {} : { settings: changes };
}

/** What a test result says: the message keys of `orgAi:test.*` and whether the allowlist helps. */
export interface TestView {
  readonly ok: boolean;
  /** `orgAi:test.failure.<key>` for a failure. */
  readonly failure: string | null;
  /** The address may not be called: an allowlist entry may open it. */
  readonly blocked: boolean;
}

export function testViewOf(result: AiSettingsTestResult): TestView {
  if (result.ok || result.error === null) return { ok: true, failure: null, blocked: false };
  const { code, reason, status } = result.error;
  if (code !== 'AI_PROVIDER_ERROR') {
    return {
      ok: false,
      failure: code === 'AI_TIMEOUT' ? 'timeout' : 'invalidOutput',
      blocked: false,
    };
  }
  if (reason === 'http_status' && (status === 401 || status === 403)) {
    return { ok: false, failure: 'unauthorized', blocked: false };
  }
  if (reason === 'http_status' && status === 404) {
    return { ok: false, failure: 'notFound', blocked: false };
  }
  return {
    ok: false,
    failure: reason ?? 'unknown',
    blocked: reason === 'ssrf_blocked',
  };
}

export interface FeatureUsage {
  readonly feature: AiFeature;
  readonly requests: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  /** Some calls had no `usage` from the provider: tokens are estimated. */
  readonly estimated: boolean;
}

/** Usage of the period by feature (in the contract's order), features without requests left out. */
export function usageByFeature(items: AiUsageDto['items']): FeatureUsage[] {
  return AI_FEATURES.map((feature) => {
    const rows = items.filter((item) => item.feature === feature);
    return {
      feature,
      requests: rows.reduce((sum, row) => sum + row.requests, 0),
      promptTokens: rows.reduce((sum, row) => sum + row.prompt_tokens, 0),
      completionTokens: rows.reduce((sum, row) => sum + row.completion_tokens, 0),
      estimated: rows.some((row) => row.estimated_requests > 0),
    };
  }).filter((row) => row.requests > 0);
}

/** Share of today's quota used, 0–1 (`null` without a limit). */
export function quotaShare(quota: AiUsageDto['quota']): number | null {
  if (quota.daily_token_limit === null || quota.daily_token_limit <= 0) return null;
  return Math.min(1, quota.used_today / quota.daily_token_limit);
}
