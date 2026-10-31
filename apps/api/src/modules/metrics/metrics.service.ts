import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { newId, PROBLEM_CONTENT_TYPE, type ErrorCode } from '@cellhive/contracts';
import {
  aiQuotaExhaustedCount,
  aiRequestCounts,
  aiRetryCounts,
  aiTokenCounts,
  AppError,
  buildProblem,
  causationRejectedCounts,
  httpDeliveriesRescuedCount,
  measureAiGenerationQueue,
  measureHttpDeliveryBacklog,
  observeAiDurations,
  secretHostBlockedCounts,
  ssrfBlockedCounts,
  webhookRequestCounts,
  type AppConfig,
  type Db,
  type WebhookRequestResult,
} from '@cellhive/server-core';
import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

import { AppLogger } from '../../common/logging/app-logger.js';
import { APP_CONFIG, DB } from '../../common/tokens.js';

/** Route label for requests that matched no route (keeps cardinality bounded). */
export const UNMATCHED_ROUTE = '<unmatched>';

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * Prometheus metrics (SPEC §19). Labels never carry organization or user
 * identifiers: only method, route template and status code.
 *
 * Exposure: with METRICS_PORT, `/metrics` is served only on that internal
 * port; otherwise with METRICS_TOKEN it is served on the main port behind
 * `Authorization: Bearer`; with neither it does not exist (404).
 */
@Injectable()
export class MetricsService implements OnApplicationBootstrap, OnApplicationShutdown {
  readonly registry = new Registry();
  private readonly httpDuration: Histogram<'method' | 'route' | 'status_code'>;
  private readonly webhookDuration: Histogram<'result'>;
  private readonly tokenDigest: Buffer | null;
  private server: Server | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Inject(DB) db: Db,
  ) {
    collectDefaultMetrics({ register: this.registry });
    this.httpDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'Duration of HTTP requests handled by the API',
      labelNames: ['method', 'route', 'status_code'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });
    // Outbound calls refused by the SSRF guard in this process (ADR-35 §3, T600).
    new Counter({
      name: 'http_ssrf_blocked_total',
      help: 'Outbound HTTP calls refused by the SSRF guard, by reason',
      labelNames: ['reason'],
      registers: [this.registry],
      collect() {
        this.reset();
        for (const [reason, count] of ssrfBlockedCounts()) this.inc({ reason }, count);
      },
    });
    // Deliveries refused because the host is not an allowed host of their secret (T701).
    // Counted by `http.deliver` in the worker process, like the SSRF counter.
    new Counter({
      name: 'http_secret_host_blocked_total',
      help: 'Outbound HTTP calls refused because the host is not an allowed host of their secret',
      labelNames: ['reason'],
      registers: [this.registry],
      collect() {
        this.reset();
        for (const [reason, count] of secretHostBlockedCounts()) this.inc({ reason }, count);
      },
    });
    // Jobs `http.deliver` added again for deliveries whose job was lost (T702). Counted by
    // the cron `http.deliveries_rescue` in the worker process, like the counters above.
    new Counter({
      name: 'http_deliveries_rescued_total',
      help: 'Outbound HTTP deliveries whose lost job was queued again by the rescue cron',
      registers: [this.registry],
      collect() {
        this.reset();
        this.inc(httpDeliveriesRescuedCount());
      },
    });
    // Outbound HTTP backlog, instance-wide, read from the database when scraped
    // (T605, SPEC §19: alert above 600 s). The delivery counters live in the
    // worker process, which has no `/metrics` yet (BACKLOG "Tồn đọng S5c").
    const backlogLogger = logger;
    new Gauge({
      name: 'http_delivery_oldest_pending_seconds',
      help: 'Age of the oldest outbound HTTP delivery not yet final (pending or sending)',
      registers: [this.registry],
      async collect() {
        try {
          const backlog = await measureHttpDeliveryBacklog(db, { now: new Date() });
          this.set(backlog.oldestPendingSeconds);
        } catch (err: unknown) {
          backlogLogger.warn({ err }, 'http delivery backlog not measured');
        }
      },
    });
    // AI field generation queue (T910, research S8 §4.9), instance-wide, read when scraped.
    new Gauge({
      name: 'ai_generation_queue',
      help: 'Rows of the AI field generation queue, by status',
      labelNames: ['status'],
      registers: [this.registry],
      async collect() {
        try {
          const counts = await measureAiGenerationQueue(db);
          for (const [status, count] of Object.entries(counts)) this.set({ status }, count);
        } catch (err: unknown) {
          backlogLogger.warn({ err }, 'ai generation queue not measured');
        }
      },
    });
    // Incoming webhook route (T603): outcome counts kept in server-core, duration here.
    new Counter({
      name: 'webhook_requests_total',
      help: 'Requests to POST /api/v1/hooks/:token, by result',
      labelNames: ['result'],
      registers: [this.registry],
      collect() {
        this.reset();
        for (const [result, count] of webhookRequestCounts()) this.inc({ result }, count);
      },
    });
    new Counter({
      name: 'automation_causation_rejected_total',
      help: 'X-Cellhive-Causation tokens rejected on incoming webhooks, by reason',
      labelNames: ['reason'],
      registers: [this.registry],
      collect() {
        this.reset();
        for (const [reason, count] of causationRejectedCounts()) this.inc({ reason }, count);
      },
    });
    this.webhookDuration = new Histogram({
      name: 'webhook_request_duration_seconds',
      help: 'Duration of POST /api/v1/hooks/:token, by result',
      labelNames: ['result'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });
    // AI requests (T906, research S8 §4.9): counts kept in server-core, duration observed here.
    new Counter({
      name: 'ai_requests_total',
      help: 'AI requests (interactive, batches, action steps), by feature and outcome',
      labelNames: ['feature', 'status'],
      registers: [this.registry],
      collect() {
        this.reset();
        for (const { feature, status, count } of aiRequestCounts())
          this.inc({ feature, status }, count);
      },
    });
    new Counter({
      name: 'ai_tokens_total',
      help: 'Tokens of AI calls (provider usage, estimated without one), by feature and kind',
      labelNames: ['feature', 'kind'],
      registers: [this.registry],
      collect() {
        this.reset();
        for (const { feature, kind, count } of aiTokenCounts()) this.inc({ feature, kind }, count);
      },
    });
    new Counter({
      name: 'ai_output_retries_total',
      help: 'Repair rounds of AI answers that did not fit their schema, by feature',
      labelNames: ['feature'],
      registers: [this.registry],
      collect() {
        this.reset();
        for (const [feature, count] of aiRetryCounts()) this.inc({ feature }, count);
      },
    });
    new Counter({
      name: 'ai_quota_exhausted_total',
      help: 'AI calls refused because the daily token quota of the organization was used up',
      registers: [this.registry],
      collect() {
        this.reset();
        this.inc(aiQuotaExhaustedCount());
      },
    });
    const aiDuration = new Histogram({
      name: 'ai_request_seconds',
      help: 'Duration of AI requests, every provider call and repair round included, by feature',
      labelNames: ['feature'],
      buckets: [0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 45, 60, 90],
      registers: [this.registry],
    });
    observeAiDurations((feature, seconds) => {
      aiDuration.observe({ feature }, seconds);
    });
    this.tokenDigest = config.metrics.token === null ? null : digest(config.metrics.token);
  }

  /** One request to the incoming webhook route (T603). */
  observeWebhookRequest(result: WebhookRequestResult, ms: number): void {
    this.webhookDuration.observe({ result }, ms / 1000);
  }

  observeRequest(method: string, route: string | undefined, statusCode: number, ms: number): void {
    this.httpDuration.observe(
      { method, route: route ?? UNMATCHED_ROUTE, status_code: String(statusCode) },
      ms / 1000,
    );
  }

  /** Access rule for `/metrics` on the main HTTP port. */
  authorizeMainPort(authorization: string | undefined): void {
    if (this.config.metrics.port !== null || this.tokenDigest === null) {
      throw new AppError('NOT_FOUND');
    }
    this.authorizeToken(authorization);
  }

  async render(): Promise<{ contentType: string; body: string }> {
    return { contentType: this.registry.contentType, body: await this.registry.metrics() };
  }

  async onApplicationBootstrap(): Promise<void> {
    const port = this.config.metrics.port;
    if (port === null) return;
    const server = createServer((req, res) => {
      void this.handleInternal(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '0.0.0.0', () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
    this.logger.info({ port }, 'metrics listening on internal port');
  }

  async onApplicationShutdown(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server === null) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  }

  /** `Authorization: Bearer <METRICS_TOKEN>`, compared in constant time. */
  private authorizeToken(authorization: string | undefined): void {
    if (this.tokenDigest === null) return;
    const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? '');
    const provided = match?.[1];
    if (provided === undefined || !timingSafeEqual(digest(provided), this.tokenDigest)) {
      throw new AppError('UNAUTHENTICATED', { detail: 'A valid metrics token is required.' });
    }
  }

  private async handleInternal(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?')[0];
    try {
      if (path !== '/metrics' || (req.method !== 'GET' && req.method !== 'HEAD')) {
        throw new AppError('NOT_FOUND');
      }
      this.authorizeToken(req.headers.authorization);
      const { contentType, body } = await this.render();
      res.writeHead(200, { 'content-type': contentType });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (error) {
      const code: ErrorCode = error instanceof AppError ? error.code : 'INTERNAL';
      if (!(error instanceof AppError)) {
        this.logger.error({ err: error }, 'metrics endpoint failed');
      }
      const requestId = newId('req');
      const problem = buildProblem(code, requestId);
      res.writeHead(problem.status, {
        'content-type': `${PROBLEM_CONTENT_TYPE}; charset=utf-8`,
        'x-request-id': requestId,
      });
      res.end(JSON.stringify(problem));
    }
  }
}
