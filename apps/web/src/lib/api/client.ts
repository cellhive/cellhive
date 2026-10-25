import {
  CSRF_COOKIE,
  CSRF_HEADER,
  IDEMPOTENCY_KEY_HEADER,
  isErrorCode,
  type ErrorCode,
  type ProblemErrorItem,
} from '@cellhive/contracts';

import { devWarn } from '../dev-log';

import type { z } from 'zod';

/** Every endpoint lives under this prefix (CONTRACTS §1.1). */
export const API_BASE = '/api/v1';

/**
 * Codes the client produces itself when there is no problem document:
 * the request never reached the server, or the answer was not the expected
 * JSON (e.g. an HTML error page of a proxy, or a contract mismatch in dev).
 */
export const CLIENT_ERROR_CODES = ['NETWORK_ERROR', 'UNEXPECTED_RESPONSE'] as const;
export type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[number];

export interface ApiErrorInit {
  status: number;
  code: ErrorCode | ClientErrorCode;
  title?: string | undefined;
  detail?: string | undefined;
  errors?: readonly ProblemErrorItem[] | undefined;
  request_id?: string | undefined;
  /** Seconds from `Retry-After` (429, 423). */
  retry_after?: number | undefined;
}

/**
 * A failed API call (FRONTEND §3.1, §8). Built from the problem+json body
 * (CONTRACTS §6); the UI translates it by `code` and `errors[].code`.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode | ClientErrorCode;
  readonly title: string | undefined;
  readonly detail: string | undefined;
  readonly errors: readonly ProblemErrorItem[];
  readonly request_id: string | undefined;
  readonly retry_after: number | undefined;

  constructor(init: ApiErrorInit) {
    super(init.detail ?? init.title ?? init.code);
    this.name = 'ApiError';
    this.status = init.status;
    this.code = init.code;
    this.title = init.title;
    this.detail = init.detail;
    this.errors = init.errors ?? [];
    this.request_id = init.request_id;
    this.retry_after = init.retry_after;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/** A query-string value; an array repeats the parameter (`?fields=a&fields=b`). */
export type QueryValue = string | number | boolean | readonly string[] | null | undefined;

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: Readonly<Record<string, QueryValue>>;
  /** JSON-serialised request body. */
  body?: unknown;
  signal?: AbortSignal | undefined;
  /** `Idempotency-Key` of a `POST` (CONTRACTS §1.1): a retry replays the first answer. */
  idempotencyKey?: string | undefined;
  /**
   * Extra request headers, e.g. `X-Share-CSRF-Token` of an unlocked share
   * link (CONTRACTS §12.0). Never the session CSRF header: it is added here.
   */
  headers?: Readonly<Record<string, string>> | undefined;
  /**
   * `false`: a `429` goes straight to the caller even with an
   * `Idempotency-Key` (T525: a button click says "try again in N seconds"
   * instead of waiting and running later than the user expects).
   */
  retryOnRateLimit?: boolean | undefined;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Value of a cookie readable by scripts, or `undefined`. */
export function readCookie(name: string, cookies: string = document.cookie): string | undefined {
  for (const part of cookies.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const raw = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return undefined;
}

function buildUrl(path: string, query: RequestOptions['query']): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value as readonly string[]) search.append(key, item);
    } else {
      search.set(key, String(value));
    }
  }
  const suffix = search.size > 0 ? `?${search.toString()}` : '';
  return `${API_BASE}${path}${suffix}`;
}

function retryAfterSeconds(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function problemErrors(value: unknown): ProblemErrorItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is ProblemErrorItem =>
      isRecord(item) && typeof item['path'] === 'string' && typeof item['code'] === 'string',
  );
}

async function toApiError(response: Response): Promise<ApiError> {
  const retry_after = retryAfterSeconds(response);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return problemToApiError(response.status, body, retry_after);
}

/**
 * An `ApiError` from a parsed problem+json body (CONTRACTS §6), for answers
 * that did not come through `fetch`: an upload with progress (XHR), a
 * download opened in a frame. Anything else is `UNEXPECTED_RESPONSE`.
 */
export function problemToApiError(status: number, body: unknown, retry_after?: number): ApiError {
  if (!isRecord(body) || !isErrorCode(body['code'])) {
    return new ApiError({ status, code: 'UNEXPECTED_RESPONSE', retry_after });
  }
  const text = (key: string) => (typeof body[key] === 'string' ? body[key] : undefined);
  return new ApiError({
    status,
    code: body['code'],
    title: text('title'),
    detail: text('detail'),
    errors: problemErrors(body['errors']),
    request_id: text('request_id'),
    retry_after,
  });
}

/** Retries of a write answered `429 RATE_LIMITED` (T421a, SPEC §13.1). */
export const RATE_LIMIT_RETRIES = 2;
/** Wait when a `429` has no usable `Retry-After`. */
const DEFAULT_RETRY_AFTER_MS = 1_000;
/** A longer `Retry-After` is not waited for: the error goes to the caller. */
const MAX_RETRY_AFTER_MS = 30_000;

/** Every entry of a bulk `records` body carries its `version`. */
function hasVersions(body: unknown): boolean {
  if (!isRecord(body)) return false;
  if (typeof body['version'] === 'number') return true;
  const records = body['records'];
  return (
    Array.isArray(records) &&
    records.length > 0 &&
    records.every((item) => isRecord(item) && typeof item['version'] === 'number')
  );
}

/**
 * Whether a write may be sent again after a `429` (T421a): only when the
 * server cannot apply it twice — it carries an `Idempotency-Key` (the
 * first answer is replayed, CONTRACTS §1.1) or it is a `PATCH` guarded by
 * `version` (a second apply is a `409`). Reads are retried by TanStack
 * Query, nothing else is retried here.
 */
export function retriesOnRateLimit(options: RequestOptions): boolean {
  const method = options.method ?? 'GET';
  if (SAFE_METHODS.has(method) || options.retryOnRateLimit === false) return false;
  if (options.idempotencyKey !== undefined) return true;
  return method === 'PATCH' && hasVersions(options.body);
}

/** Milliseconds a `429` asks to wait (`Retry-After`: seconds or an HTTP date). */
function retryDelayMs(response: Response, now = Date.now()): number {
  const header = response.headers.get('retry-after');
  if (header === null || header.trim() === '') return DEFAULT_RETRY_AFTER_MS;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - now) : DEFAULT_RETRY_AFTER_MS;
}

/** Resolves after `ms`, or rejects as soon as `signal` aborts. */
function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason as Error);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason as Error);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const retryable = retriesOnRateLimit(options);
  for (let attempt = 0; ; attempt += 1) {
    const response = await sendOnce(path, options);
    if (response.ok) return response;
    if (response.status === 429 && retryable && attempt < RATE_LIMIT_RETRIES) {
      const delay = retryDelayMs(response);
      if (delay <= MAX_RETRY_AFTER_MS) {
        // The body of the refused answer is not needed.
        void response.body?.cancel().catch(() => undefined);
        await wait(delay, options.signal);
        continue;
      }
    }
    throw await toApiError(response);
  }
}

async function sendOnce(path: string, options: RequestOptions): Promise<Response> {
  const method = options.method ?? 'GET';
  const headers = new Headers({ ...options.headers, Accept: 'application/json' });
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  if (!SAFE_METHODS.has(method)) {
    // Signed double-submit token (SPEC §14.2): copy the readable cookie.
    const csrf = readCookie(CSRF_COOKIE);
    if (csrf !== undefined) headers.set(CSRF_HEADER, csrf);
  }
  if (options.idempotencyKey !== undefined) {
    headers.set(IDEMPOTENCY_KEY_HEADER, options.idempotencyKey);
  }
  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      method,
      headers,
      credentials: 'include',
      body: options.body === undefined ? null : JSON.stringify(options.body),
      signal: options.signal ?? null,
    });
  } catch (error) {
    // Cancellation is not an error to report; TanStack Query expects it as is.
    if (options.signal?.aborted === true) throw error;
    throw new ApiError({ status: 0, code: 'NETWORK_ERROR' });
  }
  return response;
}

/**
 * Calls the API and returns the body validated against `schema` in
 * development (contract drift shows up immediately) and cast in production.
 */
export async function apiRequest<S extends z.ZodType>(
  path: string,
  schema: S,
  options: RequestOptions = {},
): Promise<z.output<S>> {
  return parseBody(await send(path, options), path, schema, options);
}

/**
 * Like `apiRequest` for endpoints that may answer `204` instead of the
 * resource, e.g. a write after which the caller can no longer read the
 * record (CONTRACTS §1.1): `null` then.
 */
export async function apiRequestOptional<S extends z.ZodType>(
  path: string,
  schema: S,
  options: RequestOptions = {},
): Promise<z.output<S> | null> {
  const response = await send(path, options);
  if (response.status === 204) return null;
  return parseBody(response, path, schema, options);
}

/**
 * Stand-in for a response schema in production builds, where `parseBody`
 * never reads it (responses are only checked in development). Call sites of
 * the first load (API client, session, share page, the app shell's `api`:
 * T700) write `import.meta.env.DEV ? schema : UNCHECKED_SCHEMA`, so a
 * production build drops those zod schemas from the initial JS (T422,
 * FRONTEND §11.1).
 * Typed `never`: the expression keeps the schema's type.
 */
export const UNCHECKED_SCHEMA = undefined as never;

async function parseBody<S extends z.ZodType>(
  response: Response,
  path: string,
  schema: S,
  options: RequestOptions,
): Promise<z.output<S>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiError({ status: response.status, code: 'UNEXPECTED_RESPONSE' });
  }
  if (import.meta.env.DEV) {
    const result = schema.safeParse(body);
    if (!result.success) {
      devWarn(
        `Response of ${options.method ?? 'GET'} ${path} does not match the contract`,
        result.error.issues,
      );
      throw new ApiError({ status: response.status, code: 'UNEXPECTED_RESPONSE' });
    }
    return result.data;
  }
  return body as z.output<S>;
}

/** Calls an endpoint that answers without a body (204/202). */
export async function apiRequestVoid(path: string, options: RequestOptions = {}): Promise<void> {
  await send(path, options);
}
