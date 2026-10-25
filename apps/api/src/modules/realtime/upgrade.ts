import { Buffer } from 'node:buffer';
import { STATUS_CODES } from 'node:http';
import { BlockList, isIP } from 'node:net';

import { newId, PROBLEM_CONTENT_TYPE, type ErrorCode } from '@cellhive/contracts';
import { buildProblem, type AppConfig, type Cidr } from '@cellhive/server-core';

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

/**
 * Origins allowed to open the WebSocket: `CORS_ORIGINS` (which defaults to
 * the origin of `PUBLIC_URL`) plus the origin of `PUBLIC_URL`.
 */
export function allowedOrigins(config: AppConfig): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const origin of [...config.security.corsOrigins, config.publicUrl]) {
    const normalized = normalizeOrigin(origin);
    if (normalized !== undefined) origins.add(normalized);
  }
  return origins;
}

/** `scheme://host[:port]` of a URL or origin, lower-cased; `undefined` when not a web origin. */
export function normalizeOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/**
 * Cross-site WebSocket hijacking guard: browsers always send `Origin` on a
 * WebSocket handshake and page scripts cannot forge it, so it replaces the
 * CSRF token of HTTP requests. A missing or foreign origin is refused.
 */
export function originAllowed(
  origin: string | string[] | undefined,
  allowed: ReadonlySet<string>,
): boolean {
  if (typeof origin !== 'string') return false;
  const normalized = normalizeOrigin(origin);
  return normalized !== undefined && allowed.has(normalized);
}

/** The path of a request target, without the query string. */
export function pathOf(url: string | undefined): string {
  const target = url ?? '/';
  const index = target.indexOf('?');
  return index < 0 ? target : target.slice(0, index);
}

/** Extra parts of a refused handshake (CONTRACTS §7). */
export interface RejectUpgradeOptions {
  readonly detail?: string | undefined;
  /** `WWW-Authenticate` of the Bearer branch (ADR-36 §2). */
  readonly wwwAuthenticate?: string | undefined;
  /** `Retry-After` in seconds (`429`). */
  readonly retryAfterSeconds?: number | undefined;
}

/**
 * Refuses a WebSocket handshake with an HTTP status and a problem+json body
 * (CONTRACTS §6), then closes the socket.
 */
export function rejectUpgrade(
  socket: Duplex,
  code: ErrorCode,
  options: RejectUpgradeOptions = {},
): void {
  if (socket.destroyed) return;
  const requestId = newId('req');
  const problem = buildProblem(code, requestId, { detail: options.detail });
  const body = JSON.stringify(problem);
  socket.end(
    [
      `HTTP/1.1 ${String(problem.status)} ${STATUS_CODES[problem.status] ?? ''}`,
      'Connection: close',
      `Content-Type: ${PROBLEM_CONTENT_TYPE}; charset=utf-8`,
      `Content-Length: ${String(Buffer.byteLength(body))}`,
      `X-Request-Id: ${requestId}`,
      ...(options.wwwAuthenticate === undefined
        ? []
        : [`WWW-Authenticate: ${options.wwwAuthenticate}`]),
      ...(options.retryAfterSeconds === undefined
        ? []
        : [`Retry-After: ${String(options.retryAfterSeconds)}`]),
      '',
      body,
    ].join('\r\n'),
  );
}

/** `TRUSTED_PROXIES` as a `BlockList`, for {@link clientIpOf}. */
export function trustedProxyList(cidrs: readonly Cidr[]): BlockList {
  const list = new BlockList();
  for (const cidr of cidrs) {
    list.addSubnet(cidr.address, cidr.prefix, cidr.family === 4 ? 'ipv4' : 'ipv6');
  }
  return list;
}

/** IPv4-mapped IPv6 (`::ffff:a.b.c.d`) as plain IPv4, like Fastify's `request.ip`. */
function plainAddress(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(address);
  return mapped?.[1] ?? address;
}

function isTrustedProxy(address: string, proxies: BlockList): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return proxies.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * The client address of a handshake, derived like Fastify's `request.ip`
 * with `trustProxy: TRUSTED_PROXIES` (proxy-addr): starting from the peer,
 * `X-Forwarded-For` entries are taken right to left while the address seen
 * so far is a trusted proxy. `null` when unknown.
 */
export function clientIpOf(request: IncomingMessage, proxies: BlockList): string | null {
  const peer = request.socket.remoteAddress;
  if (peer === undefined) return null;
  let address = plainAddress(peer);
  const header = request.headers['x-forwarded-for'];
  const forwarded = (Array.isArray(header) ? header.join(',') : (header ?? ''))
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  let next = forwarded.pop();
  while (next !== undefined && isTrustedProxy(address, proxies)) {
    address = plainAddress(next);
    next = forwarded.pop();
  }
  return isIP(address) === 0 ? null : address;
}
