import { newId, type Id } from '@cellhive/contracts';
import { sql } from 'kysely';

import { withTxScope, type OrgScope } from '../db/repository.js';
import { enqueue } from '../jobs/enqueue.js';
import { parseOutboundUrl } from '../net/url-policy.js';

import { HttpDeliveriesRepository } from './http-deliveries.repository.js';
import {
  deriveDeliveryKey,
  sealDeliveryRequest,
  type HttpDeliveryRequest,
} from './request-crypto.js';

import type { Db, Tx } from '../db/create-db.js';
import type { HttpDeliveryRow } from '../db/schema.js';

/** Job key of the job delivering `deliveryId` (one pending job per delivery). */
export function httpDeliverJobKey(deliveryId: Id<'hdl'>): string {
  return `http:${deliveryId}`;
}

interface EnqueueCommon {
  /** `signed` is derived from `signingSecretId`. */
  readonly request: Omit<HttpDeliveryRequest, 'signed'>;
  /** Secret whose value goes in `request.authHeaderName` (kind `http_header`, T606). */
  readonly authSecretId?: Id<'sec'> | null;
  /** Secret that signs the request (kind `webhook_signing`, T606). */
  readonly signingSecretId?: Id<'sec'> | null;
}

/** A step of a run (`kind = action`). */
export interface EnqueueActionDelivery extends EnqueueCommon {
  readonly kind: 'action';
  readonly automationId: Id<'aut'>;
  readonly runId: Id<'run'>;
  readonly actionId: string;
  /** `Idempotency-Key`: the step key `<aut>:<event|run>:<act>` (SPEC §11.7). */
  readonly idempotencyKey: string;
}

/** "Send a test" of an action (`kind = test`, T606): no run, kept 24 hours. */
export interface EnqueueTestDelivery extends EnqueueCommon {
  readonly kind: 'test';
  readonly automationId: Id<'aut'> | null;
  readonly actionId: string | null;
  readonly requestedBy: Id<'usr'>;
}

export type EnqueueHttpDelivery = EnqueueActionDelivery | EnqueueTestDelivery;

export interface EnqueuedHttpDelivery {
  readonly row: HttpDeliveryRow;
  /** `false`: the idempotency key already had a row (returned as is, no new job). */
  readonly created: boolean;
}

/**
 * Phase 1 of the outbound HTTP outbox (ADR-35 §4, BACKLOG T605): inside
 * the caller's transaction — the one that parks the step `waiting` —
 * checks the URL statically (`parseOutboundUrl`: scheme, user info, length,
 * host; the address checks wait for phase 2 because DNS may change), seals
 * the request, inserts the `pending` row and adds the job `http.deliver`
 * (job key `http:<id>`). The same `idempotency_key` again returns the
 * existing row and adds nothing. No network here.
 *
 * `message_id` (`webhook-id`) is the delivery id: the same for every
 * attempt (the receiver dedupes retries) and different for every step —
 * an event that triggers two HTTP steps (two automations, or two steps of
 * one run) must not look like a replay to the receiver ("Câu hỏi mở S5c"
 * #4, T605).
 *
 * Throws `OutboundHttpError` `ssrf_blocked` / `invalid_url` for a URL that
 * can never be called.
 */
export class HttpOutbox {
  private readonly deliveries: HttpDeliveriesRepository;
  private readonly key: Buffer;

  constructor(db: Db, options: { readonly masterKey: Buffer | string }) {
    this.deliveries = new HttpDeliveriesRepository(db);
    this.key = deriveDeliveryKey(options.masterKey);
  }

  async enqueue(
    tx: Tx,
    scope: OrgScope,
    input: EnqueueHttpDelivery,
  ): Promise<EnqueuedHttpDelivery> {
    const url = parseOutboundUrl(input.request.url);
    const authSecretId = input.authSecretId ?? null;
    const signingSecretId = input.signingSecretId ?? null;
    if ((authSecretId === null) !== (input.request.authHeaderName === null)) {
      throw new TypeError('An auth header needs both its name and its secret');
    }
    const id = newId('hdl');
    const common = {
      id,
      kind: input.kind,
      method: input.request.method,
      target_host: url.host,
      request_enc: sealDeliveryRequest(this.key, {
        ...input.request,
        signed: signingSecretId !== null,
      }),
      auth_secret_id: authSecretId,
      signing_secret_id: signingSecretId,
    };
    const values =
      input.kind === 'action'
        ? {
            ...common,
            automation_id: input.automationId,
            run_id: input.runId,
            action_id: input.actionId,
            idempotency_key: input.idempotencyKey,
            message_id: id,
          }
        : {
            ...common,
            automation_id: input.automationId,
            action_id: input.actionId,
            requested_by: input.requestedBy,
            idempotency_key: `test:${id}`,
            message_id: id,
          };
    const result = await this.deliveries.insertOrGet(withTxScope(scope, tx), values);
    if (result.created) {
      await enqueue(
        tx,
        'http.deliver',
        { organization_id: scope.organizationId, delivery_id: result.row.id },
        { jobKey: httpDeliverJobKey(result.row.id) },
      );
    }
    return result;
  }
}

/**
 * What `rescueHttpDelivery` did: `queued` (job `http.deliver` added again),
 * `job_live` (a job with the key is waiting or running — left as it is),
 * `not_stuck` (no such row in this organization, or it is final).
 */
export type HttpDeliveryRescue = 'queued' | 'job_live' | 'not_stuck';

/**
 * Queues `http.deliver` again for a delivery whose job was lost (cron
 * `http.deliveries_rescue`, BACKLOG T702, ADR-36 §5), in the caller's
 * transaction and organization scope. Re-reads the row in `scope` (a row
 * of another organization is `not_stuck`), then adds the job with
 * `job_key = http:<id>` and `job_key_mode = preserve_run_at` unless a job
 * with that key is still live — locked by a worker, or waiting with
 * attempts left — so a running job is never touched (graphile-worker would
 * clear its key) and a job scheduled later (`Retry-After`, pacer, lease)
 * is never pulled earlier. Never changes the row: the job leases it like
 * any other run (ADR-35 §4), so `attempts` and the status stay its
 * business.
 */
export async function rescueHttpDelivery(
  db: Db,
  tx: Tx,
  scope: OrgScope,
  deliveryId: Id<'hdl'>,
): Promise<HttpDeliveryRescue> {
  const row = await new HttpDeliveriesRepository(db).get(withTxScope(scope, tx), deliveryId);
  if (row === undefined || (row.status !== 'pending' && row.status !== 'sending')) {
    return 'not_stuck';
  }
  const jobKey = httpDeliverJobKey(row.id);
  // The public view of graphile-worker, one row by its unique key.
  const { rows } = await sql<{ live: boolean }>`
    SELECT true AS live
      FROM graphile_worker.jobs
     WHERE key = ${jobKey}
       AND (locked_at IS NOT NULL OR attempts < max_attempts)
  `.execute(tx);
  if (rows.length > 0) return 'job_live';
  await enqueue(
    tx,
    'http.deliver',
    { organization_id: scope.organizationId, delivery_id: row.id },
    { jobKey, jobKeyMode: 'preserve_run_at' },
  );
  return 'queued';
}
