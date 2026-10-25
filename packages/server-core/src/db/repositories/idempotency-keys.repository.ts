import { randomBytes } from 'node:crypto';

import { sql } from 'kysely';

import { jsonb } from '../json.js';
import { TenantRepository, type OrgScope, type TenantRepositoryContract } from '../repository.js';

import type { Db } from '../create-db.js';
import type { IdempotencyKeysTable, JsonValue } from '../schema.js';
import type { Selectable } from 'kysely';

/** A row of `meta.idempotency_keys`. */
export type IdempotencyKeyRecord = Selectable<IdempotencyKeysTable>;

/** How long a key is honoured (CONTRACTS §1.1). */
export const IDEMPOTENCY_KEY_TTL_HOURS = 24;
/**
 * A key still "in progress" after this many seconds belongs to a request
 * that died (process crash, lost connection): it may be taken over instead
 * of blocking its key for 24 hours. Well above the 10 s request statement
 * timeout.
 */
export const IDEMPOTENCY_IN_FLIGHT_TIMEOUT_SECONDS = 60;

export interface IdempotencyKeyRef {
  /** Who sent the key: `usr_…` (sessions) or `tok_…` (API tokens). */
  readonly principalKey: string;
  /** The `Idempotency-Key` header value. */
  readonly key: string;
}

export interface ClaimIdempotencyKeyInput extends IdempotencyKeyRef {
  /** Fingerprint of the request (method, path, query, body). */
  readonly requestHash: string;
}

/** A key the caller claimed: `complete`/`release` only act on this claim. */
export interface IdempotencyClaimRef extends IdempotencyKeyRef {
  /** Random id returned by `claim`. */
  readonly claimId: string;
}

function newClaimId(): string {
  return randomBytes(16).toString('base64url');
}

/**
 * `meta.idempotency_keys` (CONTRACTS §1.1): one row per (principal, key).
 * `status_code IS NULL` while the first request is still running. Keys
 * older than 24 hours are ignored here and purged by the worker's
 * `maintenance.cleanup` job.
 */
export class IdempotencyKeysRepository
  extends TenantRepository<'idempotency_keys'>
  implements TenantRepositoryContract<IdempotencyKeysRepository>
{
  constructor(db: Db) {
    super(db, 'idempotency_keys');
  }

  /**
   * Takes the key for a new request: inserts it as in progress, or replaces
   * a row of the same organization that expired (24 h) or was abandoned in
   * progress (no response after 60 s). Returns the id of the new claim when
   * the caller owns the key now (pass it to `complete`/`release`);
   * `undefined` when a live row exists (read it with `find`).
   *
   * A taken-over claim gets a new id, so the abandoned request, should it
   * finish after all, can neither complete nor release the new claim.
   */
  async claim(scope: OrgScope, input: ClaimIdempotencyKeyInput): Promise<string | undefined> {
    const executor = this.executor(scope);
    const claimId = newClaimId();
    const { rows } = await sql<{ key: string }>`
      INSERT INTO meta.idempotency_keys AS k
             (organization_id, principal_key, key, request_hash, claim_id, status_code, response)
      VALUES (${scope.organizationId}, ${input.principalKey}, ${input.key}, ${input.requestHash},
              ${claimId}, NULL, NULL)
      ON CONFLICT (principal_key, key) DO UPDATE
         SET request_hash = excluded.request_hash,
             claim_id = excluded.claim_id,
             status_code = NULL,
             response = NULL,
             created_at = now()
       WHERE k.organization_id = excluded.organization_id
         AND (k.created_at < now() - make_interval(hours => ${IDEMPOTENCY_KEY_TTL_HOURS})
              OR (k.status_code IS NULL
                  AND k.created_at < now() - make_interval(secs => ${IDEMPOTENCY_IN_FLIGHT_TIMEOUT_SECONDS})))
      RETURNING k.key
    `.execute(executor);
    return rows.length === 1 ? claimId : undefined;
  }

  /** The live (not expired) row of the key in this organization. */
  async find(scope: OrgScope, ref: IdempotencyKeyRef): Promise<IdempotencyKeyRecord | undefined> {
    return this.executor(scope)
      .selectFrom('meta.idempotency_keys')
      .selectAll()
      .where('organization_id', '=', scope.organizationId)
      .where('principal_key', '=', ref.principalKey)
      .where('key', '=', ref.key)
      .where(
        'created_at',
        '>=',
        sql<Date>`now() - make_interval(hours => ${IDEMPOTENCY_KEY_TTL_HOURS})`,
      )
      .executeTakeFirst();
  }

  /**
   * Stores the response of the request that claimed the key; `false` when
   * the claim is no longer current (taken over, completed or released).
   */
  async complete(
    scope: OrgScope,
    ref: IdempotencyClaimRef & { readonly statusCode: number; readonly response: JsonValue },
  ): Promise<boolean> {
    const result = await this.executor(scope)
      .updateTable('meta.idempotency_keys')
      .set({ status_code: ref.statusCode, response: jsonb(ref.response) })
      .where('organization_id', '=', scope.organizationId)
      .where('principal_key', '=', ref.principalKey)
      .where('key', '=', ref.key)
      .where('claim_id', '=', ref.claimId)
      .where('status_code', 'is', null)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /**
   * Forgets an in-progress key (the request failed: the client may retry
   * with it); only while `ref.claimId` is still the current claim.
   */
  async release(scope: OrgScope, ref: IdempotencyClaimRef): Promise<boolean> {
    const result = await this.executor(scope)
      .deleteFrom('meta.idempotency_keys')
      .where('organization_id', '=', scope.organizationId)
      .where('principal_key', '=', ref.principalKey)
      .where('key', '=', ref.key)
      .where('claim_id', '=', ref.claimId)
      .where('status_code', 'is', null)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
  }
}
