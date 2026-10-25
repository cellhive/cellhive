import { createHash } from 'node:crypto';

import { idempotencyKeySchema, IDEMPOTENCY_KEY_HEADER } from '@cellhive/contracts';
import {
  deriveSecretKey,
  IdempotencyKeysRepository,
  sealSecret,
  unsealSecret,
  type AppConfig,
  type IdempotencyClaimRef,
  type IdempotencyKeyRecord,
  type OrgScope,
} from '@cellhive/server-core';
import { AppError } from '@cellhive/server-core/errors';
import { Inject, Injectable } from '@nestjs/common';

import { AppLogger } from '../logging/app-logger.js';
import { APP_CONFIG } from '../tokens.js';

import type { FastifyRequest } from 'fastify';
import type { Buffer } from 'node:buffer';

/** What identifies a request for `Idempotency-Key` (CONTRACTS §1.1). */
export interface IdempotentRequest {
  /** The header value; `undefined` = no idempotency. */
  readonly key: string | undefined;
  readonly method: string;
  /** Path and query string. */
  readonly url: string;
  readonly body: unknown;
}

/** The request with its validated `Idempotency-Key` header. */
export function idempotentRequestOf(request: FastifyRequest): IdempotentRequest {
  return {
    key: parseIdempotencyKey(request.headers[IDEMPOTENCY_KEY_HEADER]),
    method: request.method,
    url: request.url,
    body: request.body ?? null,
  };
}

/** A response to send: status plus body (`undefined` for `204`). */
export interface IdempotentResponse<T> {
  readonly status: number;
  readonly body: T | undefined;
}

export interface IdempotentOutcome<T> extends IdempotentResponse<T> {
  /** The stored response of an earlier request with the same key. */
  readonly replayed: boolean;
}

/**
 * The optional `Idempotency-Key` header, validated
 * (`422 VALIDATION_FAILED` when malformed).
 */
export function parseIdempotencyKey(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const parsed = idempotencyKeySchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError('VALIDATION_FAILED', {
      detail: 'The Idempotency-Key header is invalid.',
      errors: [
        {
          path: `headers.${IDEMPOTENCY_KEY_HEADER}`,
          code: 'INVALID_FORMAT',
          message: 'Must be 1–255 printable ASCII characters without spaces',
        },
      ],
    });
  }
  return parsed.data;
}

/** SHA-256 of method, path + query and body: a key reused for another request is detected. */
export function requestFingerprint(request: IdempotentRequest): string {
  return createHash('sha256')
    .update(JSON.stringify([request.method.toUpperCase(), request.url, request.body]), 'utf8')
    .digest('hex');
}

/**
 * A stored response body. `sealed`: the exact JSON text (`jsonb` would
 * reorder the keys of the replayed body), encrypted with AES-256-GCM under a
 * key derived from `APP_MASTER_KEY`, because some responses carry
 * single-use secrets (invitation and password reset links) that are
 * otherwise only stored hashed. `json`: plain text, written before responses
 * were sealed (read only). `null` body: `204`.
 */
type StoredResponse = { readonly sealed: string | null } | { readonly json: string | null };

function reused(detail: string): AppError {
  return new AppError('IDEMPOTENCY_KEY_REUSED', { detail });
}

/**
 * `Idempotency-Key` (CONTRACTS §1.1): the first request with a key claims
 * it in `meta.idempotency_keys` (per principal, 24 hours) and stores its
 * successful response; a later request with the same key and the same
 * fingerprint gets that response again without running. The same key with
 * another request is `409 IDEMPOTENCY_KEY_REUSED`; so is a duplicate that
 * arrives while the first one is still running (no waiting: the client
 * retries later and then gets the stored response). A failed request
 * releases its key, so the client can retry it with the same key; a key
 * left in progress for more than 60 s (the request died) is taken over by
 * the next request that uses it. Each claim has its own random id, so a
 * request whose key was taken over can neither store its late response
 * over the new claim nor release it.
 */
@Injectable()
export class IdempotencyService {
  private readonly sealKey: Buffer;

  constructor(
    @Inject(IdempotencyKeysRepository) private readonly keys: IdempotencyKeysRepository,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.sealKey = deriveSecretKey(config.security.appMasterKey, 'idempotency-response');
  }

  async run<T>(
    scope: OrgScope,
    principalKey: string,
    request: IdempotentRequest,
    execute: () => Promise<IdempotentResponse<T>>,
  ): Promise<IdempotentOutcome<T>> {
    if (request.key === undefined) return { ...(await execute()), replayed: false };
    const ref = { principalKey, key: request.key };
    const requestHash = requestFingerprint(request);

    // Twice at most: a failed first request may release the key between our
    // claim and our read.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const claimId = await this.keys.claim(scope, { ...ref, requestHash });
      if (claimId !== undefined) {
        return { ...(await this.execute(scope, { ...ref, claimId }, execute)), replayed: false };
      }
      const existing = await this.keys.find(scope, ref);
      if (existing !== undefined) return this.replay(existing, requestHash);
    }
    // Used by the same principal in another organization.
    throw reused('This Idempotency-Key was already used for another request.');
  }

  private async execute<T>(
    scope: OrgScope,
    ref: IdempotencyClaimRef,
    execute: () => Promise<IdempotentResponse<T>>,
  ): Promise<IdempotentResponse<T>> {
    let response: IdempotentResponse<T>;
    try {
      response = await execute();
    } catch (error) {
      await this.release(scope, ref);
      throw error;
    }
    const stored: StoredResponse = {
      sealed:
        response.body === undefined
          ? null
          : sealSecret(this.sealKey, JSON.stringify(response.body)),
    };
    try {
      const completed = await this.keys.complete(scope, {
        ...ref,
        statusCode: response.status,
        response: stored,
      });
      if (!completed) {
        // Taken over after 60 s by another request with this key: its claim
        // stays untouched and this response is not stored.
        this.logger.warn({}, 'idempotency key was taken over before the response was stored');
      }
    } catch (err) {
      // The write succeeded; without a stored response the key must not stay "in progress".
      this.logger.error({ err }, 'storing an idempotent response failed');
      await this.release(scope, ref);
    }
    return response;
  }

  private async release(scope: OrgScope, ref: IdempotencyClaimRef) {
    try {
      await this.keys.release(scope, ref);
    } catch (err) {
      this.logger.error({ err }, 'releasing an idempotency key failed');
    }
  }

  private replay<T>(row: IdempotencyKeyRecord, requestHash: string): IdempotentOutcome<T> {
    if (row.request_hash !== requestHash) {
      throw reused('This Idempotency-Key was already used for another request.');
    }
    if (row.status_code === null) {
      throw reused('A request with this Idempotency-Key is still being processed.');
    }
    const stored = row.response as unknown as StoredResponse | null;
    let json: string | null = null;
    if (stored !== null && 'sealed' in stored) {
      json = stored.sealed === null ? null : unsealSecret(this.sealKey, stored.sealed);
    } else if (stored !== null) {
      json = stored.json;
    }
    return {
      status: row.status_code,
      body: json === null ? undefined : (JSON.parse(json) as T),
      replayed: true,
    };
  }
}
