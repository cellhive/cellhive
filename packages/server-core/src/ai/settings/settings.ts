import {
  AI_DEFAULT_DAILY_TOKEN_LIMIT,
  AI_DEFAULT_REQUEST_TIMEOUT_SECONDS,
  parseAllowlistPattern,
  type AiTokenParam,
  type OrganizationAi,
} from '@cellhive/contracts';

import { AppError } from '../../errors/app-error.js';
import { parseOutboundUrl, type OutboundUrl } from '../../net/url-policy.js';

import type { AiSettingsRow } from '../../db/schema.js';
import type { AiProviderSettings } from '../client.js';

/** The settings that matter once stored (no organization, no timestamps). */
export type AiSettingsState = Omit<AiSettingsRow, 'organization_id' | 'created_at' | 'updated_at'>;

/** Settings of an organization that never saved any (CONTRACTS §29.1). */
export const DEFAULT_AI_SETTINGS: AiSettingsState = {
  enabled: false,
  provider_base_url: null,
  model: null,
  api_key_secret_id: null,
  allow_record_data: false,
  log_prompts: false,
  daily_token_limit: BigInt(AI_DEFAULT_DAILY_TOKEN_LIMIT),
  structured_output: 'auto',
  detected_output: null,
  token_param: null,
  request_timeout_seconds: AI_DEFAULT_REQUEST_TIMEOUT_SECONDS,
};

/**
 * `token_param` when none is set: OpenAI's newer models refuse `max_tokens`,
 * every other OpenAI-compatible server reads it (ADR-39 §1).
 */
export function defaultTokenParam(baseUrl: string | null): AiTokenParam {
  if (baseUrl === null) return 'max_tokens';
  try {
    return parseOutboundUrl(baseUrl).host === 'api.openai.com'
      ? 'max_completion_tokens'
      : 'max_tokens';
  } catch {
    return 'max_tokens';
  }
}

/** `enabled` with a provider URL and a model: AI entry points exist. */
export function isAiAvailable(settings: AiSettingsState | undefined): boolean {
  return (
    settings !== undefined &&
    settings.enabled &&
    settings.provider_base_url !== null &&
    settings.model !== null
  );
}

/** `GET /orgs/:id` → `ai`, for every member (never the URL, model or key). */
export function organizationAiOf(settings: AiSettingsState | undefined): OrganizationAi {
  const available = isAiAvailable(settings);
  return { available, record_data: available && settings?.allow_record_data === true };
}

/** What `LlmClient` needs, or `null` without a provider URL and a model (`enabled` not looked at). */
export function providerSettingsOf(settings: AiSettingsState): AiProviderSettings | null {
  if (settings.provider_base_url === null || settings.model === null) return null;
  return {
    baseUrl: settings.provider_base_url,
    model: settings.model,
    apiKeySecretId: settings.api_key_secret_id,
    tokenParam: settings.token_param ?? defaultTokenParam(settings.provider_base_url),
    requestTimeoutSeconds: settings.request_timeout_seconds,
    // `auto` starts at the rung "Test connection" found; the ladder steps down on `400` anyway.
    outputMode:
      settings.structured_output === 'auto'
        ? (settings.detected_output ?? 'json_schema')
        : settings.structured_output,
  };
}

/** `422 AI_NOT_CONFIGURED`: AI is off, or has no provider URL or model. */
export function aiNotConfigured(): AppError {
  return new AppError('AI_NOT_CONFIGURED', {
    detail: 'AI is not set up or is turned off for this organization.',
  });
}

/**
 * The provider of an AI feature, or `422 AI_NOT_CONFIGURED` (AI off, no
 * URL or model) / `422 AI_RECORD_DATA_DISABLED` (the feature sends record
 * values and `allow_record_data` is off). Every AI route and the AI worker
 * call it after their `404`/`403` checks and before any provider call
 * (BACKLOG T906 "AiAccess.require").
 */
export function requireAi(
  settings: AiSettingsState | undefined,
  options: { readonly recordData: boolean },
): AiProviderSettings {
  const provider =
    settings === undefined || !settings.enabled ? null : providerSettingsOf(settings);
  if (provider === null || settings === undefined) throw aiNotConfigured();
  if (options.recordData && !settings.allow_record_data) {
    throw new AppError('AI_RECORD_DATA_DISABLED', {
      detail: 'This organization does not let AI see record values.',
    });
  }
  return provider;
}

/**
 * The `allowed_hosts` entry of a key for `url` (T701 rules): the host for
 * `https` on 443, `host:port` otherwise — a plain `http` URL only matches an
 * entry naming its port. `null` for an IP address, which no entry matches.
 */
export function keyHostPatternOf(url: OutboundUrl): string | null {
  const pattern =
    url.protocol === 'https:' && url.port === 443 ? url.host : `${url.host}:${String(url.port)}`;
  return parseAllowlistPattern(pattern)?.pattern ?? null;
}
