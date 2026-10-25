import { CSRF_COOKIE, CSRF_HEADER } from '../../auth.js';

import { SESSION_SECURITY_SCHEME } from './auth.js';
import { IDEMPOTENCY_NOTE, idempotencyHeaders, withIdempotencyConflict } from './idempotency.js';

import type { problemResponse } from '../types.js';
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import type { z } from 'zod';

const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });

const CSRF_NOTE =
  `Requires the \`${CSRF_HEADER}\` header (value of the \`${CSRF_COOKIE}\` cookie) when ` +
  'authenticated by the session cookie.';

const NOT_VISIBLE =
  '`NOT_FOUND`: does not exist or is not visible to the caller (never `403` for something ' +
  'the caller cannot read)';

const RATE_LIMITED =
  '`RATE_LIMITED` with `Retry-After`: more than 60 requests/s by the user, or 20 requests/s ' +
  'by the user on one base';

export type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** One route of the public document, with its standard error responses. */
export interface RouteSpec {
  readonly method: Method;
  readonly path: string;
  readonly operationId: string;
  readonly tag: string;
  readonly summary: string;
  readonly description?: string;
  readonly params?: z.ZodObject;
  readonly query?: z.ZodObject;
  readonly body?: z.ZodType;
  /** Extra request headers (besides `Idempotency-Key`). */
  readonly headers?: z.ZodObject;
  /** The body may be omitted (default: required unless the route is public). */
  readonly bodyOptional?: boolean;
  /** Omitted for `204`. */
  readonly response?: z.ZodType;
  readonly status: 200 | 201 | 202 | 204;
  /** Extra error responses besides 401/403/404 (and 422 when there is input). */
  readonly errors?: Readonly<Record<number, string>>;
  /** Example problem documents of error responses, by status. */
  readonly errorExamples?: Readonly<Record<number, object>>;
  /** Public route: no session required. */
  readonly public?: boolean;
  /** Description of `403`; defaults to permission + CSRF. */
  readonly forbidden?: string;
  /** A read sent as `POST`: ignores `Idempotency-Key` (CONTRACTS §1.1). */
  readonly read?: boolean;
}

/**
 * Authenticated `POST` routes honour `Idempotency-Key` (CONTRACTS §1.1);
 * public ones (setup, sign-in, invitation acceptance) do not.
 */
function isIdempotent(spec: RouteSpec): boolean {
  return spec.method === 'post' && spec.public !== true && spec.read !== true;
}

/** Adds `example` to every media type of an error response. */
function withExample(response: object, example: object): object {
  const { content, ...rest } = response as { content?: Record<string, object> };
  if (content === undefined) return response;
  return {
    ...rest,
    content: Object.fromEntries(
      Object.entries(content).map(([type, media]) => [type, { ...media, example }]),
    ),
  };
}

/** Registers `spec` with `401`/`403`/`404`/`422` problems added as they apply. */
export function register(
  registry: OpenAPIRegistry,
  problem: (description: string) => ReturnType<typeof problemResponse>,
  spec: RouteSpec,
): void {
  const mutating = spec.method !== 'get';
  const hasInput = spec.body !== undefined || spec.query !== undefined || spec.params !== undefined;
  const responses: Record<number, object> = {
    [spec.status]:
      spec.response === undefined
        ? { description: 'Done' }
        : { description: 'Success', content: json(spec.response) },
  };
  if (spec.public !== true) responses[401] = problem('`UNAUTHENTICATED`');
  const forbidden =
    spec.forbidden ??
    (mutating
      ? '`PERMISSION_DENIED` (visible but not allowed) or `CSRF_INVALID`'
      : '`PERMISSION_DENIED`');
  if (spec.public !== true || mutating) responses[403] = problem(forbidden);
  if (spec.public !== true) responses[404] = problem(NOT_VISIBLE);
  // SPEC §13.1: every authenticated route counts against the per-user limit
  // (and the per-user-and-base limit when it acts on a base).
  if (spec.public !== true) responses[429] = problem(RATE_LIMITED);
  if (hasInput) responses[422] = problem('`VALIDATION_FAILED`');
  for (const [status, description] of Object.entries(spec.errors ?? {})) {
    responses[Number(status)] = problem(description);
  }
  for (const [status, example] of Object.entries(spec.errorExamples ?? {})) {
    const response = responses[Number(status)];
    if (response === undefined) throw new Error(`${spec.operationId}: no ${status} response`);
    responses[Number(status)] = withExample(response, example);
  }
  const idempotent = isIdempotent(spec);
  if (idempotent) responses[409] = problem(withIdempotencyConflict(spec.errors?.[409]));
  registry.registerPath({
    method: spec.method,
    path: spec.path,
    operationId: spec.operationId,
    tags: [spec.tag],
    summary: spec.summary,
    ...(spec.description === undefined && !mutating
      ? {}
      : {
          description: [
            spec.description,
            idempotent ? IDEMPOTENCY_NOTE : undefined,
            mutating ? CSRF_NOTE : undefined,
          ]
            .filter((part) => part !== undefined)
            .join(' '),
        }),
    security:
      spec.public === true
        ? [{ [SESSION_SECURITY_SCHEME]: [] }, {}]
        : [{ [SESSION_SECURITY_SCHEME]: [] }],
    request: {
      ...(spec.params === undefined ? {} : { params: spec.params }),
      ...(spec.query === undefined ? {} : { query: spec.query }),
      ...(idempotent || spec.headers !== undefined
        ? {
            headers: [
              ...(idempotent ? [idempotencyHeaders] : []),
              ...(spec.headers === undefined ? [] : [spec.headers]),
            ].reduce((all, item) => all.extend(item.shape)),
          }
        : {}),
      ...(spec.body === undefined
        ? {}
        : {
            body: {
              content: json(spec.body),
              required: spec.public !== true && spec.bodyOptional !== true,
            },
          }),
    },
    responses,
  });
}
