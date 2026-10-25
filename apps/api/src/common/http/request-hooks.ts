import { requestContext } from '../logging/request-context.js';

import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';

export const REQUEST_ID_HEADER = 'x-request-id';
const MAX_CLIENT_REQUEST_ID_LENGTH = 128;

/**
 * A client-supplied `X-Request-Id`, reduced to printable ASCII and bounded in
 * length. Only ever logged as `client_request_id` (CONTRACTS §1.1).
 */
export function sanitizeClientRequestId(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined) return undefined;
  const cleaned = raw.replace(/[^\x21-\x7e]/g, '').slice(0, MAX_CLIENT_REQUEST_ID_LENGTH);
  return cleaned === '' ? undefined : cleaned;
}

/** Path without the query string, which may carry signatures or tokens. */
function pathOf(url: string): string {
  const index = url.indexOf('?');
  return index === -1 ? url : url.slice(0, index);
}

export const REDACTED_SEGMENT = '[REDACTED]';

/** Route parameters that carry bearer secrets (`/invitations/:token`, …). */
const SECRET_PARAM = /token|secret|key|sig/i;

/**
 * Path segments that look like a bearer secret: long runs of base64url or
 * hex characters (our tokens are 43 characters of base64url). IDs such as
 * `usr_…` are shorter and keep readable logs.
 */
const SECRET_LIKE_SEGMENT = /^[A-Za-z0-9_-]{32,}$/;

/**
 * The path to log for a request: no query string; the values of secret
 * route parameters (`:token`, …) replaced by `[REDACTED]`; and, for any
 * route (also unmatched ones, where a token may sit in a mistyped URL), any
 * segment that looks like a secret replaced as well.
 */
export function redactedPathOf(url: string, route: string | undefined): string {
  const segments = pathOf(url).split('/');
  const template = route?.split('/');
  // A wildcard route (`/storage/local/*`) holds a storage key: never logged (T406).
  if (template !== undefined && template.at(-1) === '*' && segments.length >= template.length) {
    return [...segments.slice(0, template.length - 1), REDACTED_SEGMENT].join('/');
  }
  return segments
    .map((segment, index) => {
      const param =
        template !== undefined && template.length === segments.length ? template[index] : undefined;
      if (param?.startsWith(':') === true && SECRET_PARAM.test(param)) return REDACTED_SEGMENT;
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        // Malformed escapes: judge the raw segment.
      }
      return SECRET_LIKE_SEGMENT.test(decoded) ? REDACTED_SEGMENT : segment;
    })
    .join('/');
}

export interface RequestHooksOptions {
  readonly observe?: (
    method: string,
    route: string | undefined,
    status: number,
    ms: number,
  ) => void;
}

/**
 * Request lifecycle shared by every route:
 * - `X-Request-Id` response header = the server-generated `req_…` id
 *   (Fastify `genReqId`); the client's header is only logged;
 * - request context for `AppLogger`;
 * - one access log line per request (no body, no query string, no headers;
 *   the path with secrets such as invitation or reset tokens redacted);
 * - request duration metric.
 */
export function registerRequestHooks(fastify: FastifyInstance, options: RequestHooksOptions): void {
  fastify.addHook('onRequest', (request, reply, done) => {
    void reply.header(REQUEST_ID_HEADER, request.id);
    const clientRequestId = sanitizeClientRequestId(request.headers[REQUEST_ID_HEADER]);
    if (clientRequestId !== undefined) {
      request.log = request.log.child({ client_request_id: clientRequestId });
    }
    // `loggerInstance` is pino, so request loggers are pino child loggers.
    requestContext.run({ requestId: request.id, logger: request.log as Logger }, done);
  });

  fastify.addHook('onResponse', (request, reply, done) => {
    const route = request.routeOptions.url;
    options.observe?.(request.method, route, reply.statusCode, reply.elapsedTime);
    request.log.info(
      {
        method: request.method,
        path: redactedPathOf(request.url, route),
        route: route ?? null,
        status_code: reply.statusCode,
        duration_ms: Math.round(reply.elapsedTime * 100) / 100,
        remote_ip: request.ip,
      },
      'request completed',
    );
    done();
  });
}
