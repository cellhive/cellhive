import {
  AI_CONCURRENT_PER_INSTANCE,
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
  httpAllowlistSource,
  LlmClient,
  parseOutboundUrl,
  recordAiRequest,
  requireAi,
  writeAiRequestedAudit,
  type AiDeadline,
  type AiKeySource,
  type AiProviderSettings,
  type AiQuotaContext,
  type AiSettingsRow,
  type AiSettingsState,
  type AiUsage,
  type AppConfig,
  type Db,
  type HostLookup,
} from '@cellhive/server-core';
import { Inject, Injectable } from '@nestjs/common';

import { mutationContextOf } from '../../common/access/change-log.js';
import { firstTimeZone, settingOf } from '../../common/access/time-zone.js';
import { AppLogger } from '../../common/logging/app-logger.js';
import { ApiRateLimits } from '../../common/rate-limit/api-rate-limits.js';
import { APP_CONFIG, DB, OUTBOUND_LOOKUP } from '../../common/tokens.js';

import type { OrgAccess } from '../../common/access/access.service.js';
import type { Principal } from '../../common/auth/principal.js';
import type { RequestMeta } from '../../common/auth/request-meta.js';

/** What one AI request is and what its `ai.requested` audit entry names. */
export interface AiRequestOptions {
  readonly feature: AiFeature;
  /** The feature sends record values: needs `allow_record_data`. */
  readonly recordData: boolean;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly baseId?: Id<'bse'> | null;
  readonly tableId?: Id<'tbl'> | null;
  readonly meta: RequestMeta;
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

/** Everything a feature needs for its provider calls during one request. */
export interface AiCall {
  readonly organizationId: Id<'org'>;
  readonly settings: AiProviderSettings;
  readonly deadline: AiDeadline;
  readonly llm: LlmClient;
  /** Pass to every `LlmClient` call: each answer read is added to the usage ledger. */
  readonly onUsage: (usage: AiUsage) => Promise<void>;
  report(details: AiCallReport): void;
}

/**
 * The one way into the AI provider for API routes (BACKLOG T906 "AiAccess",
 * CONTRACTS §29.1): after a route's own `404`/`403` checks, `run` refuses
 * with `422 AI_NOT_CONFIGURED` / `AI_RECORD_DATA_DISABLED`, `429
 * RATE_LIMITED` (10 a minute per person — Valkey, fails closed —, 2 in
 * flight per person, 8 per API instance) and `429 AI_QUOTA_EXCEEDED` before
 * any call; then every call's usage goes to the ledger (failed ones too),
 * and one `ai.requested` audit entry, a log line (provider host, never the
 * URL, prompt or key) and the metrics close the request.
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
  private readonly inFlight = new Map<Id<'usr'>, number>();
  private total = 0;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DB) private readonly db: Db,
    @Inject(AiSettingsRepository) private readonly settings: AiSettingsRepository,
    @Inject(ApiRateLimits) private readonly limits: ApiRateLimits,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Inject(OUTBOUND_LOOKUP) private readonly lookup: HostLookup | null,
  ) {
    this.ledger = new AiUsageLedger(db);
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
    const release = this.acquire(principal.userId);
    try {
      const quota = this.quotaContextOf(org);
      const limit = state.daily_token_limit === null ? null : Number(state.daily_token_limit);
      await this.ledger.check(quota, limit);

      const started = performance.now();
      let usage: AiUsage = { promptTokens: 0, completionTokens: 0, estimated: false };
      let report: AiCallReport = {};
      let status = 'ok';
      try {
        return await work({
          organizationId: org.organizationId,
          settings: provider,
          deadline: createDeadline(this.budgetMs),
          llm,
          onUsage: async (call) => {
            usage = {
              promptTokens: usage.promptTokens + call.promptTokens,
              completionTokens: usage.completionTokens + call.completionTokens,
              estimated: usage.estimated || call.estimated,
            };
            await this.ledger.record(quota, options.feature, call);
          },
          report: (details) => {
            report = { ...report, ...details };
          },
        });
      } catch (error) {
        status = error instanceof AppError ? error.code : 'INTERNAL';
        // `AI_INVALID_OUTPUT` carries the calls made (1 + repair rounds).
        const attempts = error instanceof AppError ? error.params?.['attempts'] : undefined;
        if (typeof attempts === 'number') report = { attempts, ...report };
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
      release();
    }
  }

  /** In-process slots: 2 per person, 8 per instance (`429 RATE_LIMITED`). */
  private acquire(userId: Id<'usr'>): () => void {
    const mine = this.inFlight.get(userId) ?? 0;
    if (mine >= AI_CONCURRENT_PER_USER || this.total >= AI_CONCURRENT_PER_INSTANCE) {
      throw new AppError('RATE_LIMITED', {
        detail: 'Too many AI requests at once; try again shortly.',
        retryAfterSeconds: 5,
      });
    }
    this.inFlight.set(userId, mine + 1);
    this.total += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total -= 1;
      const left = (this.inFlight.get(userId) ?? 1) - 1;
      if (left <= 0) this.inFlight.delete(userId);
      else this.inFlight.set(userId, left);
    };
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
  }
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
