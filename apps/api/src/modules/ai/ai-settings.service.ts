import {
  AI_PROVIDER_ERROR_REASONS,
  AI_TEST_MAX_MODELS,
  AI_TEST_MAX_OUTPUT_TOKENS,
  AI_USAGE_MAX_DAYS,
  INVALID_SECRET_VALUE,
  isValidSecretValue,
  newId,
  RECORD_DATA_NOT_CONFIRMED,
  SECRET_HOST_NOT_ALLOWED,
  SECRET_LIMIT_REACHED,
  SECRETS_MAX_PER_ORG,
  UNKNOWN_SECRET,
  type AiApiKeyInput,
  type AiOutputRung,
  type AiSettingsDto,
  type AiSettingsTestResult,
  type AiUsageDto,
  type AiUsageQuery,
  type Id,
  type TestAiSettingsRequest,
  type UpdateAiSettingsRequest,
} from '@cellhive/contracts';
import {
  aiNotConfigured,
  AiSettingsRepository,
  AiUsageRepository,
  AppError,
  AuditWriter,
  DEFAULT_AI_SETTINGS,
  deriveSecretKey,
  extractJsonObject,
  isOutboundHttpError,
  keyHostPatternOf,
  lowerOutputMode,
  orgScope,
  parseOutboundUrl,
  providerSettingsOf,
  quotaDayOf,
  sealSecret,
  SecretsRepository,
  transientAiKeySource,
  type AiProviderSettings,
  type AiSettingsRow,
  type AiSettingsState,
  type AppConfig,
  type Db,
  type JsonObject,
  type OrgScope,
  type OutboundUrl,
  type SecretRow,
  type AuditContext,
  type LlmClient,
  type Tx,
} from '@cellhive/server-core';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { AccessService } from '../../common/access/access.service.js';
import { mutationContextOf } from '../../common/access/change-log.js';
import { iso } from '../../common/dto.js';
import { APP_CONFIG, DB } from '../../common/tokens.js';

import { AiAccess, type AiCall } from './ai-access.js';

import type { Principal } from '../../common/auth/principal.js';
import type { RequestMeta } from '../../common/auth/request-meta.js';
import type { Buffer } from 'node:buffer';

function invalidField(path: string, code: string, message: string, params?: JsonObject): AppError {
  return new AppError('VALIDATION_FAILED', {
    detail: message,
    errors: [{ path, code, message, ...(params === undefined ? {} : { params }) }],
  });
}

/** Name of the secret created for a key typed into the AI settings. */
const KEY_SECRET_NAME = 'AI provider key';

/** The settings keys an `ai_settings.updated` entry shows (never the key, never the detected rung). */
const AUDITED_KEYS = [
  'enabled',
  'provider_base_url',
  'model',
  'api_key_secret_id',
  'allow_record_data',
  'log_prompts',
  'daily_token_limit',
  'structured_output',
  'token_param',
  'request_timeout_seconds',
] as const satisfies readonly (keyof AiSettingsState)[];

function snapshotOf(state: AiSettingsState): JsonObject {
  return Object.fromEntries(
    AUDITED_KEYS.map((key) => {
      const value = state[key];
      return [key, typeof value === 'bigint' ? Number(value) : value];
    }),
  );
}

/** The provider URL as the AI core will call it, or `422 INVALID_URL` (never echoed). */
function parseBaseUrl(baseUrl: string): OutboundUrl {
  try {
    // A query or fragment would end up before `/chat/completions`.
    if (/[?#]/u.test(baseUrl)) throw new Error('query or fragment');
    return parseOutboundUrl(baseUrl);
  } catch (error) {
    const reason = isOutboundHttpError(error)
      ? String(error.params['reason'] ?? 'invalid_url')
      : 'invalid_url';
    throw invalidField(
      'provider_base_url',
      'INVALID_URL',
      'Enter the http(s) base URL of an OpenAI-compatible API, without user info, query or fragment.',
      { reason },
    );
  }
}

/** The `allowed_hosts` entry of a key for `baseUrl`, or `422 SECRET_HOST_NOT_ALLOWED` (an IP address). */
function keyHostOf(baseUrl: string | null): string {
  if (baseUrl === null) {
    throw invalidField('provider_base_url', 'REQUIRED', 'Enter the provider URL the key is for.');
  }
  const pattern = keyHostPatternOf(parseBaseUrl(baseUrl));
  if (pattern === null) {
    throw invalidField(
      'api_key',
      SECRET_HOST_NOT_ALLOWED,
      'An API key can only be sent to a host name, not to an IP address.',
    );
  }
  return pattern;
}

function assertKeyValue(value: string): void {
  if (!isValidSecretValue('ai_api_key', value)) {
    throw invalidField(
      'api_key.value',
      INVALID_SECRET_VALUE,
      'An API key is printable ASCII text without line breaks (at most 4,096 characters).',
    );
  }
}

/** The answer of the "Test connection" call: any member of the enum is right. */
const probeSchema = z.strictObject({ colour: z.enum(['blue', 'green', 'red']) });
const PROBE_MESSAGES = [
  { role: 'system', content: 'This is a connection test. Answer with JSON.' },
  { role: 'user', content: 'Which colour is a clear daytime sky?' },
] as const;

const DAY_MS = 86_400_000;
const addDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

const audit = new AuditWriter();

/**
 * AI settings, "Test connection" and usage of an organization (BACKLOG
 * T906, CONTRACTS §29.1, ADR-39). Organization owners/admins only: other
 * members `403`, other organizations `404`. The key is an `ai_api_key`
 * secret (§24) bound to the host of the provider URL — created or replaced
 * in the transaction that saves the settings, never returned, logged or
 * audited. Saves are audited (`ai_settings.updated`).
 */
@Injectable()
export class AiSettingsService {
  private readonly key: Buffer;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(DB) private readonly db: Db,
    @Inject(AccessService) private readonly access: AccessService,
    @Inject(AiAccess) private readonly ai: AiAccess,
    @Inject(AiSettingsRepository) private readonly settings: AiSettingsRepository,
    @Inject(SecretsRepository) private readonly secrets: SecretsRepository,
  ) {
    this.key = deriveSecretKey(config.security.appMasterKey, 'org-secret');
  }

  async get(principal: Principal, organizationId: Id<'org'>): Promise<AiSettingsDto> {
    const org = await this.access.requireOrgAdmin(principal, organizationId);
    return this.dtoOf(org.scope, await this.settings.find(org.scope));
  }

  async update(
    principal: Principal,
    organizationId: Id<'org'>,
    body: UpdateAiSettingsRequest,
    meta: RequestMeta,
  ): Promise<AiSettingsDto> {
    const org = await this.access.requireOrgAdmin(principal, organizationId);
    if (body.provider_base_url !== undefined && body.provider_base_url !== null) {
      parseBaseUrl(body.provider_base_url);
    }
    if (body.api_key !== undefined && body.api_key !== null && 'value' in body.api_key) {
      assertKeyValue(body.api_key.value);
    }
    const context = mutationContextOf(meta, principal.userId);
    const saved = await this.db.withTx(async (tx) => {
      const scope = orgScope(organizationId, tx);
      const stored = await this.settings.find(scope, { forUpdate: true });
      const before: AiSettingsState = stored ?? DEFAULT_AI_SETTINGS;
      const next: AiSettingsState = { ...before };
      if (body.enabled !== undefined) next.enabled = body.enabled;
      if (body.provider_base_url !== undefined) next.provider_base_url = body.provider_base_url;
      if (body.model !== undefined) next.model = body.model;
      if (body.log_prompts !== undefined) next.log_prompts = body.log_prompts;
      if (body.structured_output !== undefined) next.structured_output = body.structured_output;
      if (body.token_param !== undefined) next.token_param = body.token_param;
      if (body.request_timeout_seconds !== undefined) {
        next.request_timeout_seconds = body.request_timeout_seconds;
      }
      if (body.daily_token_limit !== undefined) {
        next.daily_token_limit =
          body.daily_token_limit === null ? null : BigInt(body.daily_token_limit);
      }
      if (body.allow_record_data !== undefined) {
        if (body.allow_record_data && !before.allow_record_data && body.confirm !== true) {
          throw invalidField(
            'confirm',
            RECORD_DATA_NOT_CONFIRMED,
            'Letting AI see record values sends them to the provider: confirm it (confirm: true).',
          );
        }
        next.allow_record_data = body.allow_record_data;
      }
      // Another provider: its structured output is found again by "Test connection".
      if (next.provider_base_url !== before.provider_base_url || next.model !== before.model) {
        next.detected_output = null;
      }
      let keyReplaced = false;
      if (body.api_key !== undefined) {
        next.api_key_secret_id = await this.keyOf(scope, before, next, body.api_key, {
          context,
          userId: principal.userId,
        });
        keyReplaced = body.api_key !== null && 'value' in body.api_key;
      }
      const changed = AUDITED_KEYS.filter((key) => next[key] !== before[key]);
      if (stored !== undefined && changed.length === 0 && !keyReplaced) return stored;
      const row = await this.settings.save(scope, next);
      if (changed.length > 0 || keyReplaced) {
        await audit.write(tx, {
          action: 'ai_settings.updated',
          organizationId,
          entityType: 'ai_settings',
          entityId: organizationId,
          before: stored === undefined ? null : snapshotOf(before),
          after: {
            ...snapshotOf(next),
            changed: [...changed],
            ...(keyReplaced ? { key_replaced: true } : {}),
          },
          context,
        });
      }
      return row;
    });
    return this.dtoOf(org.scope, saved);
  }

  /**
   * "Test connection" (C§29.1): `GET /models`, then a small call with an
   * enum schema from the configured rung down until one answers correctly.
   * A failed call is a result (`ok: false`), not an HTTP error.
   */
  async test(
    principal: Principal,
    organizationId: Id<'org'>,
    body: TestAiSettingsRequest,
    meta: RequestMeta,
  ): Promise<AiSettingsTestResult> {
    const org = await this.access.requireOrgAdmin(principal, organizationId);
    const saved = await this.settings.find(org.scope);
    const overrides = body.settings ?? {};
    const state: AiSettingsState = { ...(saved ?? DEFAULT_AI_SETTINGS) };
    if (overrides.provider_base_url !== undefined) {
      if (overrides.provider_base_url !== null) parseBaseUrl(overrides.provider_base_url);
      state.provider_base_url = overrides.provider_base_url;
    }
    if (overrides.model !== undefined) state.model = overrides.model;
    if (overrides.structured_output !== undefined)
      state.structured_output = overrides.structured_output;
    if (overrides.token_param !== undefined) state.token_param = overrides.token_param;
    if (overrides.request_timeout_seconds !== undefined) {
      state.request_timeout_seconds = overrides.request_timeout_seconds;
    }
    let llm: LlmClient | undefined;
    if (overrides.api_key !== undefined) {
      if (overrides.api_key === null) {
        state.api_key_secret_id = null;
      } else if ('secret_id' in overrides.api_key) {
        state.api_key_secret_id = (
          await this.aiKeySecret(org.scope, overrides.api_key.secret_id)
        ).id;
      } else {
        assertKeyValue(overrides.api_key.value);
        // Not stored: allowed on the host of the URL it is tried with, like a saved key would be.
        llm = this.ai.clientWith(
          transientAiKeySource(keyHostOf(state.provider_base_url), overrides.api_key.value),
        );
        state.api_key_secret_id = newId('sec');
      }
    }
    const configured = providerSettingsOf(state);
    if (configured === null) throw aiNotConfigured();
    // Probe from the top for `auto` (the detected rung may be stale), else from the chosen rung.
    const provider: AiProviderSettings = {
      ...configured,
      outputMode: state.structured_output === 'auto' ? 'json_schema' : state.structured_output,
    };
    const savedProvider =
      saved !== undefined &&
      saved.provider_base_url === state.provider_base_url &&
      saved.model === state.model;

    return this.ai.runWith(
      principal,
      org,
      state,
      provider,
      llm ?? this.ai.llm,
      {
        feature: 'test',
        recordData: false,
        entityType: 'ai_settings',
        entityId: organizationId,
        meta,
      },
      async (call) => {
        const started = performance.now();
        const result = await probe(call);
        call.report({
          attempts: result.attempts,
          outputMode: result.rung,
          ...(result.error === null ? {} : { status: result.error.code }),
        });
        if (result.rung !== null && savedProvider && state.structured_output === 'auto') {
          await this.settings.saveDetectedOutput(
            org.scope,
            { baseUrl: provider.baseUrl, model: provider.model },
            result.rung,
          );
        }
        return {
          ok: result.error === null,
          models: result.models,
          structured_output: result.rung,
          token_param: provider.tokenParam,
          latency_ms: Math.round(performance.now() - started),
          error: result.error,
        };
      },
    );
  }

  async usage(
    principal: Principal,
    organizationId: Id<'org'>,
    query: AiUsageQuery,
  ): Promise<AiUsageDto> {
    const org = await this.access.requireOrgAdmin(principal, organizationId);
    const context = this.ai.quotaContextOf(org);
    const today = quotaDayOf(context.now, context.timeZone);
    const to = query.to ?? today.day;
    const from = query.from ?? addDays(to, -29);
    if (from > to || Date.parse(to) - Date.parse(from) >= AI_USAGE_MAX_DAYS * DAY_MS) {
      throw invalidField(
        'from',
        'OUT_OF_RANGE',
        `Choose at most ${String(AI_USAGE_MAX_DAYS)} days, from before to.`,
        { maximum: AI_USAGE_MAX_DAYS },
      );
    }
    const usage = new AiUsageRepository(this.db);
    const [items, saved, usedToday] = await Promise.all([
      usage.list(org.scope, from, to),
      this.settings.find(org.scope),
      this.ai.usedToday(org),
    ]);
    const limit = (saved ?? DEFAULT_AI_SETTINGS).daily_token_limit;
    return {
      from,
      to,
      time_zone: context.timeZone,
      items: items.map((item) => ({
        day: item.day,
        feature: item.feature,
        requests: item.requests,
        prompt_tokens: item.promptTokens,
        completion_tokens: item.completionTokens,
        estimated_requests: item.estimatedRequests,
      })),
      quota: {
        daily_token_limit: limit === null ? null : Number(limit),
        used_today: usedToday,
        reset_at: iso(today.resetAt),
      },
    };
  }

  // --- Internals ---------------------------------------------------------

  /** An `ai_api_key` secret of the organization, or `422 UNKNOWN_SECRET`. */
  private async aiKeySecret(scope: OrgScope, secretId: Id<'sec'>): Promise<SecretRow> {
    const secret = await this.secrets.findById(scope, secretId);
    if (secret?.kind !== 'ai_api_key') {
      throw invalidField(
        'api_key.secret_id',
        UNKNOWN_SECRET,
        'This is not an AI key of the organization.',
      );
    }
    return secret;
  }

  /**
   * The key of the new settings: `{ value }` replaces the value of the
   * current `ai_api_key` secret (or creates one) with `allowed_hosts` = the
   * host of the provider URL, in the settings' transaction; `secret_id`
   * must be an `ai_api_key` of the organization.
   */
  private async keyOf(
    scope: OrgScope,
    before: AiSettingsState,
    next: AiSettingsState,
    input: AiApiKeyInput,
    by: { readonly context: AuditContext; readonly userId: Id<'usr'> },
  ): Promise<Id<'sec'> | null> {
    const { context } = by;
    if (input === null) return null;
    if ('secret_id' in input) return (await this.aiKeySecret(scope, input.secret_id)).id;
    const host = keyHostOf(next.provider_base_url);
    const tx = scope.tx as Tx;
    const current =
      before.api_key_secret_id === null
        ? undefined
        : await this.secrets.findById(scope, before.api_key_secret_id, { forUpdate: true });
    const ciphertext = sealSecret(this.key, input.value);
    if (current?.kind === 'ai_api_key') {
      const updated = await this.secrets.update(scope, current.id, {
        ciphertext,
        allowed_hosts: [host],
      });
      if (updated === undefined) throw new AppError('NOT_FOUND');
      await this.auditSecret(tx, 'secret.updated', updated, context, {
        before: secretSnapshot(current),
        after: { ...secretSnapshot(updated), value_replaced: true },
      });
      return updated.id;
    }
    if ((await this.secrets.count(scope)) >= SECRETS_MAX_PER_ORG) {
      throw invalidField(
        'api_key',
        SECRET_LIMIT_REACHED,
        `An organization has at most ${String(SECRETS_MAX_PER_ORG)} secrets.`,
      );
    }
    const id = newId('sec');
    const names = new Set((await this.secrets.list(scope)).map((row) => row.name.toLowerCase()));
    const created = await this.secrets.create(scope, {
      id,
      kind: 'ai_api_key',
      name: names.has(KEY_SECRET_NAME.toLowerCase())
        ? `${KEY_SECRET_NAME} (${id.slice(-6)})`
        : KEY_SECRET_NAME,
      ciphertext,
      allowed_hosts: [host],
      created_by: by.userId,
    });
    await this.auditSecret(tx, 'secret.created', created, context, {
      after: secretSnapshot(created),
    });
    return created.id;
  }

  private async auditSecret(
    tx: Tx,
    action: 'secret.created' | 'secret.updated',
    secret: SecretRow,
    context: AuditContext,
    values: { readonly before?: JsonObject; readonly after: JsonObject },
  ): Promise<void> {
    await audit.write(tx, {
      action,
      organizationId: secret.organization_id,
      baseId: null,
      entityType: 'secret',
      entityId: secret.id,
      before: values.before ?? null,
      after: values.after,
      context,
    });
  }

  private async dtoOf(scope: OrgScope, row: AiSettingsRow | undefined): Promise<AiSettingsDto> {
    const state = row ?? DEFAULT_AI_SETTINGS;
    const secret =
      state.api_key_secret_id === null
        ? undefined
        : await this.secrets.findById(scope, state.api_key_secret_id);
    const provider = providerSettingsOf(state);
    return {
      enabled: state.enabled,
      provider_base_url: state.provider_base_url,
      model: state.model,
      api_key:
        secret === undefined
          ? null
          : { secret_id: secret.id, name: secret.name, allowed_hosts: [...secret.allowed_hosts] },
      allow_record_data: state.allow_record_data,
      log_prompts: state.log_prompts,
      daily_token_limit: state.daily_token_limit === null ? null : Number(state.daily_token_limit),
      structured_output: state.structured_output,
      detected_output: state.detected_output,
      token_param: provider?.tokenParam ?? state.token_param ?? 'max_tokens',
      request_timeout_seconds: state.request_timeout_seconds,
      available: state.enabled && provider !== null,
      updated_at: row === undefined ? null : iso(row.updated_at),
    };
  }
}

/** Audit snapshot of a key secret (never the value), as `secret.*` entries show HTTP secrets. */
function secretSnapshot(secret: SecretRow): JsonObject {
  return {
    kind: secret.kind,
    name: secret.name,
    base_scope: secret.base_scope,
    base_ids: [],
    allowed_hosts: [...secret.allowed_hosts],
  };
}

interface ProbeResult {
  readonly models: string[] | null;
  readonly rung: AiOutputRung | null;
  readonly attempts: number;
  readonly error: AiSettingsTestResult['error'];
}

/** A provider failure as the test result's `error`; any other error is thrown on. */
function errorOf(error: unknown): NonNullable<AiSettingsTestResult['error']> {
  if (
    error instanceof AppError &&
    (error.code === 'AI_PROVIDER_ERROR' ||
      error.code === 'AI_TIMEOUT' ||
      error.code === 'AI_INVALID_OUTPUT')
  ) {
    const params: Record<string, unknown> = error.errors?.[0]?.params ?? {};
    const reason = AI_PROVIDER_ERROR_REASONS.find((known) => known === params['reason']);
    const status = params['status'];
    return {
      code: error.code,
      reason: reason ?? null,
      status: typeof status === 'number' ? status : null,
    };
  }
  throw error;
}

/**
 * `GET /models` (a provider without the route, or another answer shape,
 * gives `models: null`), then the enum probe: a rung whose answer is not
 * the asked JSON (a provider silently ignoring `response_format`) steps one
 * rung down; a `400` already did inside the client.
 */
async function probe(call: AiCall): Promise<ProbeResult> {
  let models: string[] | null = null;
  try {
    models = await call.llm.listModels({
      organizationId: call.organizationId,
      settings: call.settings,
      deadline: call.deadline,
      max: AI_TEST_MAX_MODELS,
    });
  } catch (error) {
    const failure = errorOf(error);
    if (failure.reason !== 'http_status' && failure.reason !== 'invalid_response') {
      return { models: null, rung: null, attempts: 0, error: failure };
    }
  }
  let rung: AiOutputRung | null = call.settings.outputMode;
  let attempts = 0;
  while (rung !== null) {
    attempts += 1;
    try {
      const completion = await call.llm.complete({
        organizationId: call.organizationId,
        settings: { ...call.settings, outputMode: rung },
        messages: PROBE_MESSAGES,
        output: { kind: 'json', schema: probeSchema, name: 'connection_test' },
        maxOutputTokens: AI_TEST_MAX_OUTPUT_TOKENS,
        deadline: call.deadline,
        onUsage: call.onUsage,
      });
      const used = completion.outputMode ?? rung;
      if (probeSchema.safeParse(extractJsonObject(completion.content)).success) {
        return { models, rung: used, attempts, error: null };
      }
      rung = lowerOutputMode(used);
    } catch (error) {
      return { models, rung: null, attempts, error: errorOf(error) };
    }
  }
  return {
    models,
    rung: null,
    attempts,
    error: { code: 'AI_INVALID_OUTPUT', reason: null, status: null },
  };
}
