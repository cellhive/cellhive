import { INCOMING_WEBHOOK_MAX_BODY_BYTES, type HookReceiveResponse } from '@cellhive/contracts';
import {
  authenticateHookRequest,
  BasesRepository,
  buildSample,
  deriveCausationKey,
  findIncomingWebhookByTokenHash,
  hashHookSecret,
  inboundCausation,
  IncomingWebhookCredentials,
  IncomingWebhookRequestsRepository,
  IncomingWebhooksRepository,
  isWellFormedHookToken,
  orgScope,
  parseWebhookBody,
  parseWebhookQuery,
  readLimitedBody,
  recordIncomingWebhookRequest,
  sqlStateOf,
  storedWebhookHeaders,
  type AppConfig,
  type Db,
  type IncomingWebhookRow,
} from '@cellhive/server-core';
import { AppError, isAppError } from '@cellhive/server-core/errors';
import { Inject, Injectable } from '@nestjs/common';

import { isAbortError } from '../../common/errors/problem-mapping.js';
import { AppLogger } from '../../common/logging/app-logger.js';
import { IncomingWebhookRateLimits } from '../../common/rate-limit/incoming-webhook-rate-limits.js';
import { APP_CONFIG, DB } from '../../common/tokens.js';

import type { Buffer } from 'node:buffer';
import type { IncomingHttpHeaders } from 'node:http';
import type { Readable } from 'node:stream';

/** What the controller hands over: nothing of Fastify beyond plain values. */
export interface HookRequest {
  readonly token: string;
  /** Client IP derived through `TRUSTED_PROXIES` (`null` when unknown). */
  readonly ip: string | null;
  /** `Host` header after `TRUSTED_PROXIES` (`X-Forwarded-Host` from a trusted proxy). */
  readonly host: string | undefined;
  /** Path and query of the request URL, as received. */
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  /** The `Content-Type` the client sent. */
  readonly contentType: string | undefined;
  /** The unread body. */
  readonly body: Readable;
}

/** `Retry-After` of a `503` when the database fails: the sender tries again. */
const DATABASE_RETRY_AFTER_SECONDS = 5;

/** The same answer for every hook that cannot receive (ADR-35 §1: no difference shown). */
function hookNotFound(): AppError {
  return new AppError('NOT_FOUND', { detail: 'Not found.' });
}

/**
 * The public route `POST /api/v1/hooks/:token` (BACKLOG T603, ADR-35 §1,
 * CONTRACTS §25.2). Checks run in the order of ADR-35 §1, each cheaper than
 * the next:
 *
 * 1. 20 requests/s per IP;
 * 2. token shape → `404`;
 * 3. token hash lookup (cross-tenant, ids only), then the hook read in its
 *    organization: unknown, disabled, deleted or base in the trash → the
 *    same `404`;
 * 4. hook bucket (`min(rate_limit_per_sec, WEBHOOK_MAX_RATE_PER_SEC)`,
 *    burst 4×) + 50 requests/s per base → `429` (`503` without Valkey);
 * 5. body ≤ 1 MiB (`413`, reading stops), JSON or form (`415`), valid
 *    (`400 MALFORMED_JSON`);
 * 6. Bearer then Standard Webhooks signature → `401` with no reason;
 * 7. one transaction: request row (replay → `202`, no event), event
 *    `webhook.received` + `events.dispatch`, sample if listening → `202`.
 *
 * A database failure at any step is `503 DEPENDENCY_UNAVAILABLE` +
 * `Retry-After: 5` (the sender tries again; QA S5c): only its SQLSTATE and
 * error class are logged — a PostgreSQL error's detail can quote the row
 * ("Failing row contains (…)"), i.e. the body.
 *
 * Never logs the token, a credential, a header or the body.
 */
@Injectable()
export class HookReceiveService {
  private readonly credentials: IncomingWebhookCredentials;
  private readonly causationKey: Buffer;
  private readonly publicHost: string;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DB) private readonly db: Db,
    @Inject(IncomingWebhookRateLimits) private readonly limits: IncomingWebhookRateLimits,
    @Inject(BasesRepository) private readonly bases: BasesRepository,
    @Inject(IncomingWebhooksRepository) private readonly hooks: IncomingWebhooksRepository,
    @Inject(IncomingWebhookRequestsRepository)
    private readonly requests: IncomingWebhookRequestsRepository,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {
    this.credentials = new IncomingWebhookCredentials(config.security.appMasterKey);
    this.causationKey = deriveCausationKey(config.security.appMasterKey);
    this.publicHost = new URL(config.publicUrl).host;
  }

  async receive(
    request: HookRequest,
  ): Promise<{ result: 'accepted' | 'duplicate'; response: HookReceiveResponse }> {
    try {
      return await this.receiveChecked(request);
    } catch (error) {
      if (isAppError(error) || isAbortError(error)) throw error;
      this.logger.warn(
        {
          sqlstate: sqlStateOf(error) ?? null,
          error_class: error instanceof Error ? error.name : typeof error,
        },
        'webhook request not stored',
      );
      throw new AppError('DEPENDENCY_UNAVAILABLE', {
        detail: 'The request could not be stored; send it again later.',
        retryAfterSeconds: DATABASE_RETRY_AFTER_SECONDS,
      });
    }
  }

  private async receiveChecked(
    request: HookRequest,
  ): Promise<{ result: 'accepted' | 'duplicate'; response: HookReceiveResponse }> {
    await this.limits.hitIp(request.ip);
    if (!isWellFormedHookToken(request.token)) throw hookNotFound();
    const hook = await this.findReceivingHook(request.token);
    await this.limits.takeHook(
      hook.base_id,
      hook.id,
      Math.min(hook.rate_limit_per_sec, this.config.incomingWebhooks.maxRatePerSec),
    );

    const raw = await this.readBody(request);
    const parsed = parseWebhookBody(raw, request.contentType);
    if (!parsed.ok) {
      throw parsed.error === 'unsupported'
        ? new AppError('UNSUPPORTED_MEDIA_TYPE', {
            detail: 'Send application/json (an object or an array) or a form.',
          })
        : new AppError('MALFORMED_JSON', {
            detail: 'The request body is not a valid JSON object or array.',
          });
    }

    const now = new Date();
    const auth = authenticateHookRequest(
      {
        auth: hook.auth,
        bearerHash: hook.bearer_hash,
        signingSecrets: this.signingSecretsOf(hook, now),
      },
      request.headers,
      raw,
      now,
    );
    if (!auth.ok) throw new AppError('UNAUTHENTICATED', { detail: 'Unauthorized.' });

    const path = pathOf(request.url);
    const causation = inboundCausation(request.headers['x-cellhive-causation'], {
      key: this.causationKey,
      hosts: [this.publicHost, request.host],
      path,
      now,
    });
    const headers = storedWebhookHeaders(request.headers);
    const query = parseWebhookQuery(queryOf(request.url));
    const body = parsed.value;

    const recorded = await this.db.withTx((tx) =>
      recordIncomingWebhookRequest(
        this.db,
        tx,
        { hooks: this.hooks, requests: this.requests },
        {
          organizationId: hook.organization_id,
          baseId: hook.base_id,
          incomingWebhookId: hook.id,
          messageId: auth.messageId,
          body,
          headers,
          query,
          sizeBytes: raw.length,
          causation: causation.causation,
          causationAccepted: causation.accepted,
          sample: () => buildSample({ body, headers, query }),
        },
      ),
    );
    return { result: recorded.kind, response: { request_id: recorded.requestId } };
  }

  /** The live, enabled hook of `token` whose base is not in the trash, else `404`. */
  private async findReceivingHook(token: string): Promise<IncomingWebhookRow> {
    const match = await findIncomingWebhookByTokenHash(this.db.kysely, hashHookSecret(token));
    if (match === undefined) throw hookNotFound();
    const scope = orgScope(match.organization_id);
    const hook = await this.hooks.findById(scope, match.incoming_webhook_id);
    if (hook?.enabled !== true) throw hookNotFound();
    const base = await this.bases.getById(scope, hook.base_id);
    if (base === undefined) throw hookNotFound();
    return hook;
  }

  /** The body, at most 1 MiB: `413` as soon as it is larger (declared or read). */
  private async readBody(request: HookRequest): Promise<Buffer> {
    const tooLarge = () =>
      new AppError('PAYLOAD_TOO_LARGE', { detail: 'The request body exceeds 1 MiB.' });
    const declared = Number(request.headers['content-length']);
    if (Number.isFinite(declared) && declared > INCOMING_WEBHOOK_MAX_BODY_BYTES) throw tooLarge();
    const read = await readLimitedBody(request.body, INCOMING_WEBHOOK_MAX_BODY_BYTES);
    if (!read.ok) throw tooLarge();
    return read.body;
  }

  /** The current signing secret and, until it expires, the previous one (in memory only). */
  private signingSecretsOf(hook: IncomingWebhookRow, now: Date): string[] {
    const secrets: string[] = [];
    if (hook.signing_secret_enc !== null) {
      secrets.push(this.credentials.unsealSigningSecret(hook.signing_secret_enc));
    }
    if (
      hook.signing_secret_prev_enc !== null &&
      hook.signing_secret_prev_expires_at !== null &&
      hook.signing_secret_prev_expires_at.getTime() > now.getTime()
    ) {
      secrets.push(this.credentials.unsealSigningSecret(hook.signing_secret_prev_enc));
    }
    return secrets;
  }
}

function pathOf(url: string): string {
  const index = url.indexOf('?');
  return index === -1 ? url : url.slice(0, index);
}

function queryOf(url: string): string {
  const index = url.indexOf('?');
  return index === -1 ? '' : url.slice(index + 1);
}
