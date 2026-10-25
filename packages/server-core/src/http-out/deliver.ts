import { Buffer } from 'node:buffer';

import {
  HTTP_DELIVERY_LEASE_MS,
  HTTP_DELIVERY_MAX_ATTEMPTS,
  HTTP_DELIVERY_OUTPUT_BODY_MAX_BYTES,
  type HttpDeliveryStepErrorCode,
  type Id,
  SecretKind,
} from '@cellhive/contracts';

import { deriveSecretKey, unsealSecret } from '../auth/secret-box.js';
import {
  CAUSATION_HOOK_PATH_PREFIX,
  encodeCausationToken,
  deriveCausationKey,
} from '../automation/causation/token.js';
import {
  deliveryStepOutput,
  settleDeliveryStep,
  type DeliveryStepOutcome,
} from '../automation/engine/http-wait.js';
import { automationWaitJobKey } from '../automation/engine/run-engine.js';
import { AutomationsRepository } from '../automation/repository/automations.repository.js';
import { storableJsonText, storableJsonValue } from '../db/json.js';
import { withTxScope, type OrgScope } from '../db/repository.js';
import { enqueue } from '../jobs/enqueue.js';
import { isOutboundHttpError, OutboundHttpError } from '../net/errors.js';
import {
  guardedRequest,
  type GuardedRequestOptions,
  type GuardedResponse,
} from '../net/guarded-request.js';
import { isLookupQueueTimeout } from '../net/lookup.js';
import { recordSsrfBlocked } from '../net/metrics.js';
import { resolveOutboundTarget } from '../net/resolve-target.js';
import { parseOutboundUrl, type OutboundUrl } from '../net/url-policy.js';
import {
  secretHostDecision,
  secretHostPolicyOf,
  type SecretHostPolicy,
} from '../secrets/allowed-hosts.js';
import { SecretsRepository } from '../secrets/secrets.repository.js';
import { signWebhook } from '../webhooks/standard-webhooks.js';

import { HttpDeliveriesRepository } from './http-deliveries.repository.js';
import { httpDeliverJobKey } from './http-outbox.js';
import {
  observeHttpDeliveryDuration,
  recordHttpDeliveryOutcome,
  recordSecretHostBlocked,
} from './metrics.js';
import {
  deriveDeliveryKey,
  openDeliveryRequest,
  type HttpDeliveryRequest,
} from './request-crypto.js';
import { decideRetry, type DeliveryAttemptResult } from './retry-policy.js';

import type { Db, Tx } from '../db/create-db.js';
import type { HttpDeliveryRow, JsonObject, JsonValue } from '../db/schema.js';
import type { SsrfBlockReason } from '../net/errors.js';
import type { HostPacer } from '../net/host-pacer.js';
import type { HostLookup } from '../net/lookup.js';
import type { OutboundAllowlistSource, PrivateAllowlistMode } from '../net/resolve-target.js';

/** `User-Agent` of outbound calls (ADR-35 §5). */
export const HTTP_DELIVERY_USER_AGENT = 'Cellhive/0.1';

/**
 * Headers the outbox sets itself (ADR-35 §5): a value of the action under
 * one of these names is dropped (T606 refuses them when saving —
 * `HEADER_NOT_ALLOWED`; this is the last line).
 */
const OWNED_HEADERS = new Set([
  'webhook-id',
  'webhook-timestamp',
  'webhook-signature',
  'idempotency-key',
  'x-cellhive-causation',
  'user-agent',
]);

/** Where secret values come from at delivery time (current value first). */
export interface HttpDeliverySecretSource {
  /**
   * The hosts `secretId` may be sent to (T701, ADR-36 §4), read **without**
   * unsealing anything: the deliverer checks the URL against them before it
   * asks for {@link values}. `null` when the secret is not usable (the same
   * cases as `values`).
   */
  hosts(
    scope: OrgScope,
    input: {
      readonly secretId: Id<'sec'>;
      readonly purpose: 'auth' | 'signing';
      readonly baseId: Id<'bse'> | null;
    },
  ): Promise<SecretHostPolicy | null>;
  /**
   * Values of `secretId` usable by an automation of `baseId` (`null` for a
   * test without automation): the current one first, then the previous one
   * while a signing secret rotates (T606). `null` when the secret is gone,
   * of another kind, no longer shared with the base, or unreadable.
   */
  values(
    scope: OrgScope,
    input: {
      readonly secretId: Id<'sec'>;
      readonly purpose: 'auth' | 'signing';
      readonly baseId: Id<'bse'> | null;
    },
  ): Promise<readonly string[] | null>;
}

/** Secret kinds per purpose (`meta.secrets`, T606). */
const KIND_OF: Record<'auth' | 'signing', SecretKind> = {
  auth: 'http_header',
  signing: 'webhook_signing',
};

/**
 * `meta.secrets` read again at each attempt: kind `http_header` for the
 * auth header, `webhook_signing` for the signature, usable in the
 * automation's base. A signing secret replaced less than 24 hours ago also
 * gives its previous value (`previous_ciphertext` until
 * `previous_expires_at`, T606): the request carries both signatures. A
 * value that cannot be unsealed (another master key) makes the secret
 * unusable; a previous one that cannot is just left out.
 */
export function databaseSecretSource(
  db: Db,
  masterKey: Buffer | string,
  now: () => Date = () => new Date(),
): HttpDeliverySecretSource {
  const secrets = new SecretsRepository(db);
  const key = deriveSecretKey(masterKey, 'org-secret');
  const usable = async (
    scope: OrgScope,
    input: Parameters<HttpDeliverySecretSource['values']>[1],
  ) => {
    const kind = KIND_OF[input.purpose];
    const row =
      input.baseId === null
        ? await secrets.findById(scope, input.secretId)
        : await secrets.findUsable(scope, input.secretId, input.baseId, kind);
    return row?.kind === kind ? row : null;
  };
  return {
    async hosts(scope, input) {
      const row = await usable(scope, input);
      return row === null ? null : secretHostPolicyOf(row);
    },
    async values(scope, input) {
      const row = await usable(scope, input);
      if (row === null) return null;
      let current: string;
      try {
        current = unsealSecret(key, row.ciphertext);
      } catch {
        return null;
      }
      const values = [current];
      if (
        input.purpose === 'signing' &&
        row.previous_ciphertext !== null &&
        row.previous_expires_at !== null &&
        row.previous_expires_at.getTime() > now().getTime()
      ) {
        try {
          values.push(unsealSecret(key, row.previous_ciphertext));
        } catch {
          // Unreadable previous value: sign with the current one only.
        }
      }
      return values;
    },
  };
}

/**
 * Outbound calls one worker process may have in flight at once, whatever
 * the organization (QA S5c, T616). The per-organization semaphore of the
 * `HostPacer` (2) protects organizations from each other, not the other
 * jobs of the instance: ten organizations with a slow destination took
 * every `WORKER_CONCURRENCY` slot for ~36 s in the T615 bench, delaying an
 * unrelated event by 34 s. With these slots a call never takes the last
 * slot of the process ({@link httpCallSlotsFor}); a delivery that finds
 * them full gives its attempt back and is tried again shortly, like a
 * pacer wait.
 */
export interface HttpCallSlots {
  /** Takes a slot when one is free (synchronous: no other job runs in between). */
  tryTake(): boolean;
  /** Gives a taken slot back. */
  free(): void;
}

/** Slots for at most `max` calls at once (`Infinity`: no limit). */
export function createHttpCallSlots(max: number): HttpCallSlots {
  if (!(max >= 1)) throw new RangeError('max must be at least 1');
  let used = 0;
  return {
    tryTake() {
      if (used >= max) return false;
      used += 1;
      return true;
    },
    free() {
      used = Math.max(0, used - 1);
    },
  };
}

/**
 * The cap of a worker process running `workerConcurrency` jobs at once:
 * `max(1, workerConcurrency − 1)` — one slot always stays for other jobs
 * (with `WORKER_CONCURRENCY=1` the only slot is shared, as before).
 */
export function httpCallSlotsFor(workerConcurrency: number): number {
  return Math.max(1, Math.floor(workerConcurrency) - 1);
}

/** Wait before a delivery that found every call slot of the process taken tries again. */
export const HTTP_CALL_SLOTS_RETRY_MS = 1_000;

/**
 * Wait before a delivery whose DNS lookup found no slot of the process's
 * system resolver in time (`LookupQueueTimeoutError`) tries again — a wait,
 * not an attempt: the slots are held by other lookups, not by this target.
 */
export const HTTP_DNS_BUSY_RETRY_MS = 5_000;

export interface HttpDelivererOptions {
  /** `APP_MASTER_KEY`: request, secret and causation keys derive from it. */
  readonly masterKey: Buffer | string;
  /** `PUBLIC_URL`: its host is the target of the `X-Cellhive-Causation` token. */
  readonly publicUrl: string;
  readonly pacer: HostPacer;
  /** Calls in flight in this process (default: no limit besides the pacer's). */
  readonly callSlots?: HttpCallSlots;
  readonly allowlist: OutboundAllowlistSource;
  readonly privateAllowlist: PrivateAllowlistMode;
  /** Default: `meta.secrets` ({@link databaseSecretSource}). */
  readonly secrets?: HttpDeliverySecretSource;
  readonly userAgent?: string;
  /** DNS (tests inject one). */
  readonly lookup?: HostLookup;
  /** Clock of leases, attempts and timestamps (tests pin it). */
  readonly now?: () => Date;
  /** Jitter of the retry schedule. */
  readonly random?: () => number;
  readonly leaseMs?: number;
  /** Tests only: timeouts, extra blocked addresses, a TLS CA. */
  readonly request?: Pick<
    GuardedRequestOptions,
    'timeoutMs' | 'connectTimeoutMs' | 'blockedAddresses' | 'ca'
  >;
  /** Tests only: after TX-a committed, before the call (simulates a dying worker). */
  readonly afterLease?: (row: HttpDeliveryRow) => Promise<void>;
}

/** What one `http.deliver` job did. */
export type HttpDeliverResult =
  | { readonly status: 'missing' | 'final' | 'stale' }
  /** Not due (job early, or another worker holds the lease): the job is added again for `at`. */
  | { readonly status: 'not_due'; readonly at: Date }
  /** The pacer said wait (`reason`); not an attempt. */
  | { readonly status: 'deferred'; readonly reason: string; readonly at: Date }
  | {
      readonly status: 'succeeded';
      readonly attempt: number;
      readonly httpStatus: number;
    }
  | {
      readonly status: 'retry_scheduled';
      readonly attempt: number;
      readonly at: Date;
      readonly code: string;
    }
  | { readonly status: 'failed'; readonly attempt: number; readonly code: string };

/** Margin after a lease before the safety job takes a dead worker's row again. */
const LEASE_GRACE_MS = 1_000;

type FailureCode = HttpDeliveryStepErrorCode | 'secret_unavailable' | 'internal_error';

class PermanentFailure extends Error {
  constructor(
    readonly code: FailureCode,
    readonly params: Readonly<Record<string, string | number>> = {},
  ) {
    super(code);
  }
}

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Errors Node's HTTP client throws for a request it refuses to write (a
 * header name or value it does not accept): retrying cannot help, so the
 * delivery fails at once (`internal_error`, `reason: invalid_request`)
 * instead of failing the job and leaving the row `sending`.
 */
const INVALID_REQUEST_CODES: ReadonlySet<string> = new Set([
  'ERR_INVALID_CHAR',
  'ERR_INVALID_HTTP_TOKEN',
  'ERR_HTTP_INVALID_HEADER_VALUE',
  'ERR_UNESCAPED_CHARACTERS',
  'ERR_INVALID_ARG_VALUE',
]);

function isInvalidRequestError(error: unknown): boolean {
  return (
    isObject(error) && typeof error['code'] === 'string' && INVALID_REQUEST_CODES.has(error['code'])
  );
}

/**
 * Phase 2 of the outbound HTTP outbox (ADR-35 §4, BACKLOG T605), one call
 * per `http.deliver` job:
 *
 * 1. **TX-a**: the row `FOR UPDATE SKIP LOCKED`; `pending` and due (or
 *    `sending` with an expired lease) → `sending`, `attempts + 1`,
 *    `lease_until = now + 30 s`, plus a safety job for the end of the lease
 *    (a worker dying from here on leaves the row to it); commit. No
 *    transaction or connection is held during the call.
 * 2. **Pacer** (`HostPacer`, T600): paused host, full bucket, two calls in
 *    flight for the organization, or Valkey down → the attempt is given
 *    back (`pending`, `attempts - 1`) and the job added again for then.
 * 3. **Call**: request and secrets decrypted in memory only; headers
 *    `webhook-id` (the delivery id — the same for every attempt),
 *    `webhook-timestamp`, `webhook-signature` (with a signing secret; two
 *    signatures while it rotates), `Idempotency-Key`, a fresh
 *    `X-Cellhive-Causation` token bound to this instance (actions only),
 *    `User-Agent`; through the SSRF guard (`resolveOutboundTarget` +
 *    `guardedRequest`).
 * 4. **TX-b**: `succeeded` (the step `succeeded` with the response,
 *    body cut at 10 KB), `pending` for a later attempt (retry policy,
 *    `Retry-After` pauses the host), or `failed` (the step `failed` with
 *    the code); a final row loses its request and wakes the run
 *    (`automation.run`). Writes are fenced by the leased attempt: a worker
 *    that lost its lease changes nothing (`stale`).
 *
 * Logs nothing itself: callers log ids, statuses and codes only (the job
 * `http.deliver` does not log even the host) — never the URL, headers,
 * bodies or tokens.
 */
export class HttpDeliverer {
  private readonly deliveries: HttpDeliveriesRepository;
  private readonly automations: AutomationsRepository;
  private readonly requestKey: Buffer;
  private readonly causationKey: Buffer;
  private readonly publicHost: string;
  private readonly secrets: HttpDeliverySecretSource;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly leaseMs: number;

  constructor(
    private readonly db: Db,
    private readonly options: HttpDelivererOptions,
  ) {
    this.deliveries = new HttpDeliveriesRepository(db);
    this.automations = new AutomationsRepository(db);
    this.requestKey = deriveDeliveryKey(options.masterKey);
    this.causationKey = deriveCausationKey(options.masterKey);
    this.publicHost = new URL(options.publicUrl).host;
    this.now = options.now ?? (() => new Date());
    this.secrets = options.secrets ?? databaseSecretSource(db, options.masterKey, this.now);
    this.random = options.random ?? Math.random;
    this.leaseMs = options.leaseMs ?? HTTP_DELIVERY_LEASE_MS;
  }

  async deliver(scope: OrgScope, deliveryId: Id<'hdl'>): Promise<HttpDeliverResult> {
    // --- TX-a: lease, commit.
    const leased = await this.db.withTx(async (tx) => {
      const lease = await this.deliveries.lease(withTxScope(scope, tx), deliveryId, {
        now: this.now(),
        leaseMs: this.leaseMs,
      });
      if (lease.state === 'early' || lease.state === 'leased') {
        const at = new Date(lease.at.getTime() + (lease.state === 'leased' ? LEASE_GRACE_MS : 0));
        await this.schedule(tx, scope, deliveryId, at);
        return { state: 'not_due' as const, at };
      }
      if (lease.state === 'acquired' && lease.row.lease_until !== null) {
        // Safety job: a worker dying after this commit leaves the row to it.
        await this.schedule(
          tx,
          scope,
          deliveryId,
          new Date(lease.row.lease_until.getTime() + LEASE_GRACE_MS),
        );
      }
      return lease;
    });
    if (leased.state === 'missing') return { status: 'missing' };
    if (leased.state === 'final') return { status: 'final' };
    if (leased.state === 'not_due') return { status: 'not_due', at: leased.at };
    const row = leased.row;
    const attempt = row.attempts;
    if (attempt > HTTP_DELIVERY_MAX_ATTEMPTS) {
      // QA S5c: the last attempt was leased and never settled (its worker died, or its
      // result could not be written): fail instead of calling the destination again and
      // again — a delivery is never sent more than its attempts.
      return this.finishFailed(scope, row, attempt, {
        code: 'internal_error',
        params: { reason: 'attempts_exhausted' },
        lastStatus: row.last_status,
        response: null,
      });
    }
    await this.options.afterLease?.(row);

    // --- Call slots of this process, then the pacer: wait without counting the attempt.
    const giveBack = async (reason: string, at: Date): Promise<HttpDeliverResult> => {
      await this.db.withTx(async (tx) => {
        const released = await this.deliveries.release(withTxScope(scope, tx), row.id, attempt, at);
        if (released) await this.schedule(tx, scope, row.id, at);
      });
      recordHttpDeliveryOutcome('deferred');
      return { status: 'deferred', reason, at };
    };
    const slots = this.options.callSlots;
    if (slots !== undefined && !slots.tryTake()) {
      return giveBack('worker_busy', new Date(this.now().getTime() + HTTP_CALL_SLOTS_RETRY_MS));
    }
    const target = { organizationId: scope.organizationId, host: row.target_host };
    let decision: Awaited<ReturnType<HostPacer['acquire']>>;
    try {
      decision = await this.options.pacer.acquire(target);
    } catch (error) {
      slots?.free();
      throw error;
    }
    if (!decision.ok) {
      slots?.free();
      return giveBack(decision.reason, decision.waitUntil);
    }

    // --- Call (no transaction held).
    let result: DeliveryAttemptResult | null = null;
    let response: GuardedResponse | null = null;
    let permanent: PermanentFailure | null = null;
    let dnsBusy = false;
    let failOnHttpError = true;
    try {
      const prepared = await this.prepare(scope, row);
      failOnHttpError = prepared.request.failOnHttpError !== false;
      const started = performance.now();
      try {
        response = await guardedRequest(prepared.target, {
          method: prepared.request.method,
          headers: prepared.headers,
          body: prepared.request.body,
          ...this.options.request,
        });
        result = {
          kind: 'response',
          status: response.status,
          retryAfter: firstHeader(response.headers['retry-after']),
        };
      } finally {
        observeHttpDeliveryDuration((performance.now() - started) / 1000);
      }
    } catch (error) {
      if (isOutboundHttpError(error)) {
        result = { kind: 'error', code: error.code, params: error.params };
      } else if (isLookupQueueTimeout(error)) {
        dnsBusy = true;
      } else if (error instanceof PermanentFailure) {
        permanent = error;
      } else if (isInvalidRequestError(error)) {
        permanent = new PermanentFailure('internal_error', { reason: 'invalid_request' });
      } else {
        throw error;
      }
    } finally {
      slots?.free();
      await decision.lease.release();
    }
    if (dnsBusy) {
      return giveBack('dns_busy', new Date(this.now().getTime() + HTTP_DNS_BUSY_RETRY_MS));
    }
    if (permanent !== null || result === null) {
      return this.finishFailed(scope, row, attempt, {
        code: permanent?.code ?? 'internal_error',
        params: permanent?.params ?? {},
        lastStatus: null,
        response: null,
      });
    }

    // --- TX-b.
    const now = this.now();
    const retry = decideRetry({ result, attempt, now, random: this.random });
    const lastStatus = result.kind === 'response' ? result.status : null;
    const kept = response === null ? null : responseRecord(response);
    if (retry.action === 'succeed') {
      return this.finishSucceeded(scope, row, attempt, response as GuardedResponse, kept);
    }
    if (retry.action === 'retry') {
      if (retry.pauseUntil !== null) await this.options.pacer.pause(target, retry.pauseUntil);
      const updated = await this.db.withTx(async (tx) => {
        const done = await this.deliveries.retryLater(withTxScope(scope, tx), row.id, attempt, {
          at: now,
          nextAttemptAt: retry.at,
          lastStatus,
          lastError: { code: retry.failure.code, params: { ...retry.failure.params } },
        });
        if (done !== undefined) await this.schedule(tx, scope, row.id, retry.at);
        return done;
      });
      if (updated === undefined) return { status: 'stale' };
      recordHttpDeliveryOutcome('retry');
      return { status: 'retry_scheduled', attempt, at: retry.at, code: retry.failure.code };
    }
    if (retry.failure.code === 'http_status' && !failOnHttpError && response !== null) {
      // `fail_on_http_error: false` (T606): the final status is the step's result.
      return this.finishSucceeded(scope, row, attempt, response, kept);
    }
    if (retry.failure.code === 'rate_limited') {
      // Asked to wait more than an hour: the host rests as long as the pacer allows.
      await this.options.pacer.pause(target, new Date(now.getTime() + 60 * 60 * 1000));
    }
    return this.finishFailed(scope, row, attempt, {
      code: retry.failure.code,
      params: retry.failure.params,
      lastStatus,
      response: kept,
    });
  }

  /** The request opened, the secrets read, the target vetted and the headers built. */
  private async prepare(scope: OrgScope, row: HttpDeliveryRow) {
    const request =
      row.request_enc === null ? null : openDeliveryRequest(this.requestKey, row.request_enc);
    if (request === null) throw new PermanentFailure('internal_error', { reason: 'unreadable' });
    // `undefined`: the automation is gone — its secrets are no longer usable.
    const baseId =
      row.automation_id === null
        ? null
        : (await this.automations.get(scope, row.automation_id))?.base_id;
    // The URL as rendered (the outbox never follows redirects: its host is the final one).
    let url: OutboundUrl;
    try {
      url = parseOutboundUrl(request.url);
    } catch (error) {
      if (error instanceof OutboundHttpError && error.code === 'ssrf_blocked') {
        recordSsrfBlocked(error.params['reason'] as SsrfBlockReason);
      }
      throw error;
    }
    // T701 (ADR-36 §4): a secret goes only to its allowed hosts — checked before any secret
    // is unsealed and before any DNS lookup or connection; a refusal is permanent.
    const purposes: { purpose: 'auth' | 'signing'; secretId: Id<'sec'> | null }[] = [];
    if (request.authHeaderName !== null) {
      purposes.push({ purpose: 'auth', secretId: row.auth_secret_id });
    }
    if (request.signed) purposes.push({ purpose: 'signing', secretId: row.signing_secret_id });
    for (const { purpose, secretId } of purposes) {
      if (secretId === null || baseId === undefined) {
        throw new PermanentFailure('secret_unavailable', { purpose, reason: 'deleted' });
      }
      const policy = await this.secrets.hosts(scope, { secretId, purpose, baseId });
      if (policy === null) {
        throw new PermanentFailure('secret_unavailable', { purpose, secret_id: secretId });
      }
      const decision = secretHostDecision(policy, url, this.now());
      if (!decision.allowed) {
        recordSecretHostBlocked(decision.reason);
        throw new PermanentFailure('secret_host_not_allowed', {
          purpose,
          secret_id: secretId,
          reason: decision.reason,
        });
      }
    }
    const authValue = await this.authValueOf(scope, row, request, baseId);
    const signing = await this.signingSecretsOf(scope, row, request, baseId);
    const target = await resolveOutboundTarget(url, {
      organizationId: scope.organizationId,
      allowlist: this.options.allowlist,
      privateAllowlist: this.options.privateAllowlist,
      ...(this.options.lookup === undefined ? {} : { lookup: this.options.lookup }),
    });
    const now = this.now();
    const headers: Record<string, string> = {};
    for (const [name, value] of request.headers) {
      const lower = name.toLowerCase();
      if (!OWNED_HEADERS.has(lower)) headers[lower] = value;
    }
    if (request.authHeaderName !== null && authValue !== null) {
      headers[request.authHeaderName.toLowerCase()] = authValue;
    }
    const timestamp = Math.floor(now.getTime() / 1000);
    headers['webhook-id'] = row.message_id;
    headers['webhook-timestamp'] = String(timestamp);
    if (signing !== null) {
      try {
        headers['webhook-signature'] = signWebhook(
          { id: row.message_id, timestamp, body: request.body ?? '' },
          signing,
        );
      } catch {
        throw new PermanentFailure('secret_unavailable', {
          purpose: 'signing',
          secret_id: row.signing_secret_id ?? '',
          reason: 'unreadable',
        });
      }
    }
    headers['idempotency-key'] = row.idempotency_key;
    if (request.causation !== null) {
      // Bound to this instance, not to the destination (amendment 2026-10-18
      // of ADR-27 §5 / ADR-35 §5): n8n or any system forwarding the header
      // to `/hooks/:token` continues the chain.
      headers['x-cellhive-causation'] = encodeCausationToken(request.causation, {
        key: this.causationKey,
        host: this.publicHost,
        path: CAUSATION_HOOK_PATH_PREFIX,
        now,
      });
    }
    headers['user-agent'] = this.options.userAgent ?? HTTP_DELIVERY_USER_AGENT;
    return { request, target, headers };
  }

  private async authValueOf(
    scope: OrgScope,
    row: HttpDeliveryRow,
    request: HttpDeliveryRequest,
    baseId: Id<'bse'> | null | undefined,
  ): Promise<string | null> {
    if (request.authHeaderName === null) return null;
    if (row.auth_secret_id === null || baseId === undefined) {
      throw new PermanentFailure('secret_unavailable', { purpose: 'auth', reason: 'deleted' });
    }
    const values = await this.secrets.values(scope, {
      secretId: row.auth_secret_id,
      purpose: 'auth',
      baseId,
    });
    const [value] = values ?? [];
    if (value === undefined) {
      throw new PermanentFailure('secret_unavailable', {
        purpose: 'auth',
        secret_id: row.auth_secret_id,
      });
    }
    return value;
  }

  private async signingSecretsOf(
    scope: OrgScope,
    row: HttpDeliveryRow,
    request: HttpDeliveryRequest,
    baseId: Id<'bse'> | null | undefined,
  ): Promise<readonly string[] | null> {
    if (!request.signed) return null;
    if (row.signing_secret_id === null || baseId === undefined) {
      throw new PermanentFailure('secret_unavailable', { purpose: 'signing', reason: 'deleted' });
    }
    const values = await this.secrets.values(scope, {
      secretId: row.signing_secret_id,
      purpose: 'signing',
      baseId,
    });
    if (values === null || values.length === 0) {
      throw new PermanentFailure('secret_unavailable', {
        purpose: 'signing',
        secret_id: row.signing_secret_id,
      });
    }
    return values;
  }

  private async finishSucceeded(
    scope: OrgScope,
    row: HttpDeliveryRow,
    attempt: number,
    response: GuardedResponse,
    kept: JsonObject | null,
  ): Promise<HttpDeliverResult> {
    const at = this.now();
    const record = kept ?? responseRecord(response);
    const updated = await this.db.withTx(async (tx) => {
      const done = await this.deliveries.succeed(withTxScope(scope, tx), row.id, attempt, {
        at,
        lastStatus: response.status,
        lastError: null,
        response: record,
      });
      if (done === undefined) return undefined;
      await this.settle(tx, scope, done, {
        status: 'succeeded',
        output: deliveryStepOutput(done),
      });
      return done;
    });
    if (updated === undefined) return { status: 'stale' };
    recordHttpDeliveryOutcome('succeeded');
    return { status: 'succeeded', attempt, httpStatus: response.status };
  }

  private async finishFailed(
    scope: OrgScope,
    row: HttpDeliveryRow,
    attempt: number,
    failure: {
      readonly code: string;
      readonly params: Readonly<Record<string, string | number>>;
      readonly lastStatus: number | null;
      readonly response: JsonObject | null;
    },
  ): Promise<HttpDeliverResult> {
    const at = this.now();
    const error: JsonObject = { code: failure.code, params: { ...failure.params } };
    const updated = await this.db.withTx(async (tx) => {
      const txScope = withTxScope(scope, tx);
      const done = await this.deliveries.fail(txScope, row.id, attempt, {
        at,
        lastStatus: failure.lastStatus,
        lastError: error,
        response: failure.response,
      });
      if (done === undefined) return undefined;
      await this.settle(tx, scope, done, {
        status: 'failed',
        error: { code: failure.code, params: { ...failure.params } },
      });
      return done;
    });
    if (updated === undefined) return { status: 'stale' };
    recordHttpDeliveryOutcome('failed');
    return { status: 'failed', attempt, code: failure.code };
  }

  /** A final step outcome for an action delivery: the step, then the run woken. */
  private async settle(
    tx: Tx,
    scope: OrgScope,
    row: HttpDeliveryRow,
    outcome: DeliveryStepOutcome,
  ): Promise<void> {
    if (row.kind !== 'action' || row.run_id === null) return;
    const settled = await settleDeliveryStep(this.db, tx, scope, row, outcome, this.now());
    if (!settled) return;
    await enqueue(
      tx,
      'automation.run',
      { organization_id: scope.organizationId, run_id: row.run_id },
      { jobKey: automationWaitJobKey(row.run_id) },
    );
  }

  private async schedule(tx: Tx, scope: OrgScope, deliveryId: Id<'hdl'>, at: Date): Promise<void> {
    await enqueue(
      tx,
      'http.deliver',
      { organization_id: scope.organizationId, delivery_id: deliveryId },
      { runAt: at, jobKey: httpDeliverJobKey(deliveryId) },
    );
  }
}

/** The first value of a response header, `null` when absent. */
function firstHeader(value: string | readonly string[] | undefined): string | null {
  if (value === undefined) return null;
  return typeof value === 'string' ? value : (value[0] ?? null);
}

const JSON_TYPE = /^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/iu;

/**
 * What is kept of a response (row `response`, step output): status,
 * `content-type`, body — JSON parsed when the whole body fits in 10 KB and
 * parses, else UTF-8 text cut at 10 KB on a character boundary. Characters
 * `jsonb` cannot store (NUL, a lone surrogate — in text, JSON strings or
 * keys) become U+FFFD: the destination chooses the bytes, and a write
 * PostgreSQL refuses would leave the attempt unsettled (QA S5c).
 */
export function responseRecord(response: GuardedResponse): JsonObject {
  const rawType = firstHeader(response.headers['content-type']);
  const contentType = rawType === null ? null : storableJsonText(rawType);
  const max = HTTP_DELIVERY_OUTPUT_BODY_MAX_BYTES;
  const bytes = response.body;
  let body: JsonValue = null;
  let truncated = false;
  if (bytes.length > 0) {
    if (contentType !== null && JSON_TYPE.test(contentType) && bytes.length <= max) {
      try {
        body = storableJsonValue(JSON.parse(bytes.toString('utf8')) as JsonValue);
      } catch {
        body = storableJsonText(bytes.toString('utf8'));
      }
    } else if (bytes.length <= max) {
      body = storableJsonText(bytes.toString('utf8'));
    } else {
      body = storableJsonText(cutUtf8(bytes, max));
      truncated = true;
    }
  }
  return {
    status: response.status,
    headers: { 'content-type': contentType },
    body,
    body_truncated: truncated,
  };
}

/** The first `max` bytes as text, without a broken character at the end. */
function cutUtf8(bytes: Buffer, max: number): string {
  let end = Math.min(max, bytes.length);
  // Step back over continuation bytes (10xxxxxx) to a character start.
  while (end > 0 && end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return Buffer.from(bytes.subarray(0, end)).toString('utf8');
}

/** `last_error` of a delivery row as `{ code, params }`, or `null`. */
export function deliveryErrorOf(
  value: JsonValue | null,
): { code: string; params?: Record<string, string | number> } | null {
  if (!isObject(value) || typeof value['code'] !== 'string') return null;
  const params: Record<string, string | number> = {};
  if (isObject(value['params'])) {
    for (const [key, item] of Object.entries(value['params'])) {
      if (typeof item === 'string' || typeof item === 'number') params[key] = item;
    }
  }
  return Object.keys(params).length === 0
    ? { code: value['code'] }
    : { code: value['code'], params };
}
