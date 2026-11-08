import {
  AI_CONCURRENT_PER_INSTANCE,
  AI_CONCURRENT_PER_ORG,
  AI_CONCURRENT_PER_USER,
  type AiFeature,
  type AiOutputRung,
  type Id,
} from '@cellhive/contracts';
import {
  AI_REQUEST_BUDGET_MS,
  AiSettingsRepository,
  AiUsageLedger,
  AppError,
  createAiKeySource,
  createDeadline,
  createValkeyCallSlots,
  httpAllowlistSource,
  isAiQuotaExceeded,
  LlmClient,
  parseOutboundUrl,
  recordAiRequest,
  requireAi,
  valkeyQuotaClient,
  writeAiRequestedAudit,
  type AiCallHooks,
  type AiDeadline,
  type AiKeySource,
  type AiProviderSettings,
  type AiQuotaContext,
  type AiSettingsRow,
  type AiSettingsState,
  type AiUsage,
  type AppConfig,
  type CallSlotLease,
  type CallSlots,
  type Db,
  type HostLookup,
} from '@cellhive/server-core';
import { Inject, Injectable } from '@nestjs/common';

import { mutationContextOf } from '../../common/access/change-log.js';
import { firstTimeZone, settingOf } from '../../common/access/time-zone.js';
import { AppLogger } from '../../common/logging/app-logger.js';
import { ApiRateLimits } from '../../common/rate-limit/api-rate-limits.js';
import { CACHE_KEY_PREFIX, cacheUnavailable } from '../../common/rate-limit/rate-limiter.js';
import { APP_CONFIG, CACHE_CLIENT, DB, OUTBOUND_LOOKUP } from '../../common/tokens.js';

import type { OrgAccess } from '../../common/access/access.service.js';
import type { Principal } from '../../common/auth/principal.js';
import type { RequestMeta } from '../../common/auth/request-meta.js';
import type { Redis } from 'ioredis';

/**
 * Longest an AI request holds its concurrency slots should its process die
 * mid-request: the 90 s budget of its calls plus the work around them
 * (the Q&A widget query, the audit entry).
 */
export const AI_CALL_SLOT_LEASE_MS = AI_REQUEST_BUDGET_MS + 30_000;

/**
 * The request facts of an AI route: those of every route, and the signal
 * aborted when the client closes the request ({@link clientAbortSignal}) —
 * the provider call in flight is aborted and the slots released.
 */
export interface AiRequestMeta extends RequestMeta {
  readonly signal?: AbortSignal;
}

/** What one AI request is and what its `ai.requested` audit entry names. */
export interface AiRequestOptions {
  readonly feature: AiFeature;
  /** The feature sends record values: needs `allow_record_data`. */
  readonly recordData: boolean;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly baseId?: Id<'bse'> | null;
  readonly tableId?: Id<'tbl'> | null;
  readonly meta: AiRequestMeta;
}

/** What a feature reports for the audit entry besides the tokens. */
export interface AiCallReport {
  /** Calls made (1 + repair rounds); default 1. */
  readonly attempts?: number;
  readonly outputMode?: AiOutputRung | null;
  /** A failure returned as a result (e.g. "Test connection"): its error code. */
  readonly status?: string;
  /** What the person typed and the answer: audited only with `log_prompts`. */
  readonly input?: string;
  readonly output?: string;
}

/** The hooks of every provider call of a request: pass them to each `LlmClient` call. */
export interface AiRequestHooks extends AiCallHooks {
  /** Each answer read is added to the usage ledger. */
  readonly onUsage: (usage: AiUsage) => Promise<void>;
  /** The quota, before every HTTP call (`429 AI_QUOTA_EXCEEDED`, nothing sent). */
  readonly beforeCall: () => Promise<void>;
}

/** Everything a feature needs for its provider calls during one request. */
export interface AiCall {
  readonly organizationId: Id<'org'>;
  readonly settings: AiProviderSettings;
  /** `allow_record_data`: a feature may also send record values (the Q&A narrative). */
  readonly allowRecordData: boolean;
  readonly deadline: AiDeadline;
  readonly llm: LlmClient;
  /** Spread into every `LlmClient` call (`...call.hooks`): ledger, quota, abort. */
  readonly hooks: AiRequestHooks;
  report(details: AiCallReport): void;
}

/**
 * The one way into the AI provider for API routes (BACKLOG T906 "AiAccess",
 * T1004, CONTRACTS §29.1): after a route's own `404`/`403` checks, `run`
 * refuses with `422 AI_NOT_CONFIGURED` / `AI_RECORD_DATA_DISABLED`, `429
 * RATE_LIMITED` (10 a minute per person; 2 in flight per person and 8 per
 * organization across every API instance — Valkey leases, fails closed with
 * `503` —; 8 per API process) and `429 AI_QUOTA_EXCEEDED` before any call;
 * then the quota is checked again before **every** provider call
 * (`hooks.beforeCall`), every call's usage goes to the ledger (failed ones
 * too), and one `ai.requested` audit entry, a log line (provider host,
 * never the URL, prompt or key) and the metrics close the request. A client
 * that closes its request aborts the call in flight; the slots are released
 * whatever happens.
 *
 * `now` and `budgetMs` are plain fields so tests can move the quota day
 * and shorten the time budget.
 */
@Injectable()
export class AiAccess {
  now: () => Date = () => new Date();
  budgetMs = AI_REQUEST_BUDGET_MS;

  /** The client of the saved settings (key from `meta.secrets`). */
  readonly llm: LlmClient;
  private readonly ledger: AiUsageLedger;
  /** Slots per person and per organization, shared by every API instance. */
  private readonly slots: CallSlots;
  /** Requests in flight in this process: a resource ceiling. */
  private total = 0;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DB) private readonly db: Db,
    @Inject(AiSettingsRepository) private readonly settings: AiSettingsRepository,
    @Inject(ApiRateLimits) private readonly limits: ApiRateLimits,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Inject(OUTBOUND_LOOKUP) private readonly lookup: HostLookup | null,
    @Inject(CACHE_CLIENT) cache: Redis,
  ) {
    this.ledger = new AiUsageLedger(db);
    this.slots = createValkeyCallSlots(valkeyQuotaClient(cache), {
      keyPrefix: CACHE_KEY_PREFIX,
      leaseMs: AI_CALL_SLOT_LEASE_MS,
    });
    this.llm = this.clientWith(createAiKeySource(db, config.security.appMasterKey));
  }

  /** A client with another key source (a key typed into "Test connection" and not saved). */
  clientWith(keys: AiKeySource): LlmClient {
    return new LlmClient({
      allowlist: httpAllowlistSource(this.db),
      privateAllowlist: this.config.outboundHttp.privateAllowlist,
      keys,
      ...(this.lookup === null ? {} : { lookup: this.lookup }),
      now: () => this.now(),
      logger: this.logger,
    });
  }

  /** The organization's zone for quota days: its `settings.timezone`, else the instance default. */
  timeZoneOf(org: OrgAccess): string {
    return firstTimeZone(
      [settingOf(org.membership.settings, 'timezone')],
      this.config.defaults.timezone,
    );
  }

  quotaContextOf(org: OrgAccess): AiQuotaContext {
    return { organizationId: org.organizationId, timeZone: this.timeZoneOf(org), now: this.now() };
  }

  /** Tokens of today in the organization's zone. */
  usedToday(org: OrgAccess): Promise<number> {
    return this.ledger.usedToday(this.quotaContextOf(org));
  }

  /**
   * The checks of {@link run} for a request whose calls the AI worker makes
   * later (`POST /fields/:id/ai/generate`, BACKLOG T1003), after the route's
   * own `404`/`403`/`422` checks: `429 RATE_LIMITED` (10 a minute per
   * person), then `429 AI_QUOTA_EXCEEDED` when today's tokens are used up —
   * before anything is queued.
   */
  async admit(principal: Principal, org: OrgAccess, state: AiSettingsState): Promise<void> {
    await this.limits.hitAi(principal.userId);
    const limit = state.daily_token_limit === null ? null : Number(state.daily_token_limit);
    await this.ledger.check(this.quotaContextOf(org), limit);
  }

  /** One AI request with the saved settings (every AI feature route). */
  async run<T>(
    principal: Principal,
    org: OrgAccess,
    options: AiRequestOptions,
    work: (call: AiCall) => Promise<T>,
  ): Promise<T> {
    const saved = await this.settings.find(org.scope);
    const provider = requireAi(saved, { recordData: options.recordData });
    return this.runWith(principal, org, saved as AiSettingsRow, provider, this.llm, options, work);
  }

  /** {@link run} with given settings and client ("Test connection" of unsaved settings). */
  async runWith<T>(
    principal: Principal,
    org: OrgAccess,
    state: AiSettingsState,
    provider: AiProviderSettings,
    llm: LlmClient,
    options: AiRequestOptions,
    work: (call: AiCall) => Promise<T>,
  ): Promise<T> {
    await this.limits.hitAi(principal.userId);
    const lease = await this.acquire(principal.userId, org.organizationId);
    try {
      const quota = this.quotaContextOf(org);
      const limit = state.daily_token_limit === null ? null : Number(state.daily_token_limit);
      await this.ledger.check(quota, limit);

      const started = performance.now();
      let usage: AiUsage = { promptTokens: 0, completionTokens: 0, estimated: false };
      let report: AiCallReport = {};
      let status = 'ok';
      // Provider calls sent: each passed the quota first.
      let sent = 0;
      const { signal } = options.meta;
      try {
        return await work({
          organizationId: org.organizationId,
          settings: provider,
          allowRecordData: state.allow_record_data,
          deadline: createDeadline(this.budgetMs),
          llm,
          hooks: {
            beforeCall: async () => {
              await this.ledger.check(quota, limit);
              sent += 1;
            },
            onUsage: async (call) => {
              usage = {
                promptTokens: usage.promptTokens + call.promptTokens,
                completionTokens: usage.completionTokens + call.completionTokens,
                estimated: usage.estimated || call.estimated,
              };
              await this.ledger.record(quota, options.feature, call);
            },
            ...(signal === undefined ? {} : { signal }),
          },
          report: (details) => {
            report = { ...report, ...details };
          },
        });
      } catch (error) {
        status =
          signal?.aborted === true
            ? 'aborted'
            : error instanceof AppError
              ? error.code
              : 'INTERNAL';
        // `AI_INVALID_OUTPUT` carries the calls made (1 + repair rounds).
        const attempts = error instanceof AppError ? error.params?.['attempts'] : undefined;
        if (typeof attempts === 'number') report = { attempts, ...report };
        // Refused by the quota between two calls: the calls that were sent.
        else if (isAiQuotaExceeded(error)) report = { attempts: sent, ...report };
        throw error;
      } finally {
        await this.finish(principal, org, state, provider, options, {
          status: report.status ?? status,
          report,
          usage,
          durationMs: performance.now() - started,
        });
      }
    } finally {
      await lease.release();
    }
  }

  /**
   * Slots of one request: this process under its ceiling (8), then — in
   * Valkey, for every API instance at once — 2 per person and 8 per
   * organization (`429 RATE_LIMITED`, `Retry-After: 5`); Valkey unreachable
   * → `503 DEPENDENCY_UNAVAILABLE`, like the other limits.
   */
  private async acquire(userId: Id<'usr'>, organizationId: Id<'org'>): Promise<CallSlotLease> {
    if (this.total >= AI_CONCURRENT_PER_INSTANCE) throw tooManyAtOnce();
    this.total += 1;
    let released = false;
    const local = () => {
      if (released) return;
      released = true;
      this.total -= 1;
    };
    try {
      const decision = await this.slots.acquire([
        { key: `ai:inflight:user:${userId}`, limit: AI_CONCURRENT_PER_USER },
        { key: `ai:inflight:org:${organizationId}`, limit: AI_CONCURRENT_PER_ORG },
      ]);
      if (!decision.ok) {
        throw decision.reason === 'full'
          ? tooManyAtOnce()
          : cacheUnavailable(new Error('AI slots unavailable'));
      }
      const { lease } = decision;
      return {
        release: async () => {
          local();
          await lease.release();
        },
      };
    } catch (error) {
      local();
      throw error;
    }
  }

  private async finish(
    principal: Principal,
    org: OrgAccess,
    state: AiSettingsState,
    provider: AiProviderSettings,
    options: AiRequestOptions,
    outcome: {
      readonly status: string;
      readonly report: AiCallReport;
      readonly usage: AiUsage;
      readonly durationMs: number;
    },
  ): Promise<void> {
    const attempts = outcome.report.attempts ?? 1;
    recordAiRequest({
      feature: options.feature,
      status: outcome.status,
      durationMs: outcome.durationMs,
      promptTokens: outcome.usage.promptTokens,
      completionTokens: outcome.usage.completionTokens,
      attempts,
    });
    this.logger.info(
      {
        organization_id: org.organizationId,
        feature: options.feature,
        status: outcome.status,
        provider_host: hostOf(provider.baseUrl),
        attempts,
        prompt_tokens: outcome.usage.promptTokens,
        completion_tokens: outcome.usage.completionTokens,
        duration_ms: Math.round(outcome.durationMs),
      },
      'ai request',
    );
    try {
      await this.db.withTx((tx) =>
        writeAiRequestedAudit(tx, {
          organizationId: org.organizationId,
          baseId: options.baseId ?? null,
          tableId: options.tableId ?? null,
          entityType: options.entityType,
          entityId: options.entityId,
          feature: options.feature,
          model: provider.model,
          status: outcome.status,
          attempts,
          usage: outcome.usage,
          durationMs: outcome.durationMs,
          outputMode: outcome.report.outputMode ?? null,
          logPrompts: state.log_prompts,
          ...(outcome.report.input === undefined ? {} : { input: outcome.report.input }),
          ...(outcome.report.output === undefined ? {} : { output: outcome.report.output }),
          context: mutationContextOf(options.meta, principal.userId),
        }),
      );
    } catch (error) {
      // The outcome of the request stands (its original error too); the entry is lost, said so.
      this.logger.error(
        { err: error, organization_id: org.organizationId, feature: options.feature },
        'ai request audit entry not written',
      );
    }
  }
}

/** `429 RATE_LIMITED` of the concurrency slots. */
function tooManyAtOnce(): AppError {
  return new AppError('RATE_LIMITED', {
    detail: 'Too many AI requests at once; try again shortly.',
    retryAfterSeconds: 5,
  });
}

/** Host (and a port other than 80/443) of the provider: what logs may name. */
function hostOf(baseUrl: string): string {
  try {
    const url = parseOutboundUrl(baseUrl);
    return url.port === 80 || url.port === 443 ? url.host : `${url.host}:${String(url.port)}`;
  } catch {
    return '';
  }
}
