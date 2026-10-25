import { Buffer } from 'node:buffer';
import * as http from 'node:http';
import * as https from 'node:https';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

import { neverAllowedBlockList } from './address-class.js';
import { OutboundHttpError } from './errors.js';

import type { OutboundTarget } from './resolve-target.js';
import type { BlockList, LookupFunction } from 'node:net';
import type { Readable, Transform } from 'node:stream';

/** Whole call (connect, send, read) — CONTRACTS §25.6. */
export const OUTBOUND_TIMEOUT_MS = 10_000;
/** TCP (and TLS) connection. */
export const OUTBOUND_CONNECT_TIMEOUT_MS = 5_000;
/** Largest response body read, after decompression. */
export const OUTBOUND_MAX_RESPONSE_BYTES = 1_048_576;

/**
 * Request headers the client owns: a caller value is dropped (the client
 * sets `host`, `content-length` and `connection` itself). T606 refuses them
 * when an action is saved (`HEADER_NOT_ALLOWED`); this is the last line.
 */
const CLIENT_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'upgrade',
  'trailer',
]);

export interface GuardedRequestOptions {
  readonly method: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array | null;
  readonly timeoutMs?: number;
  readonly connectTimeoutMs?: number;
  readonly maxResponseBytes?: number;
  /**
   * Addresses the socket refuses besides the never-reachable ranges (which
   * it always refuses): an operator deny list, or a test standing in for an
   * unreachable host without sending a packet.
   */
  readonly blockedAddresses?: readonly string[];
  /**
   * Tests only: trusted CA certificates for `https` instead of the system
   * store (a fake destination with a self-signed certificate — the name is
   * still checked against `servername`, T605).
   */
  readonly ca?: string | Buffer | readonly (string | Buffer)[];
}

export interface GuardedResponse {
  readonly status: number;
  /** Lower-case names; `content-encoding`/`content-length` dropped when the body was decompressed. */
  readonly headers: Readonly<Record<string, string | readonly string[]>>;
  readonly body: Buffer;
}

function decoderOf(encoding: string): Transform | null {
  switch (encoding) {
    case 'gzip':
    case 'x-gzip':
      return createGunzip();
    case 'deflate':
      return createInflate();
    case 'br':
      return createBrotliDecompress();
    default:
      return null;
  }
}

/**
 * One HTTP request to a vetted target (ADR-35 §3), through `node:http` /
 * `node:https` — no dependency, no proxy:
 *
 * - the socket goes to `target.address` only: the `lookup` hook answers
 *   that address whatever name is asked (DNS rebinding cannot redirect the
 *   connection), while `Host` and TLS (`servername`, certificate check) keep
 *   the original host name;
 * - the socket's `blockList` refuses the never-reachable ranges again;
 * - a dedicated agent per call (no pooled socket to another address, no
 *   `HTTP(S)_PROXY` / `NODE_USE_ENV_PROXY`);
 * - redirects are **never** followed: a `3xx` is returned as is;
 * - connect timeout 5 s, whole call 10 s (`http_timeout`);
 * - the body is read up to `maxResponseBytes` (1 MiB), counted on the wire
 *   **and** after gzip/deflate/br decompression, then the call is aborted
 *   (`http_response_too_large`);
 * - other failures are `http_network`. Errors carry no URL, address,
 *   header or body.
 */
export function guardedRequest(
  target: OutboundTarget,
  options: GuardedRequestOptions,
): Promise<GuardedResponse> {
  const { url } = target;
  const timeoutMs = options.timeoutMs ?? OUTBOUND_TIMEOUT_MS;
  const connectTimeoutMs = options.connectTimeoutMs ?? OUTBOUND_CONNECT_TIMEOUT_MS;
  const maxBytes = options.maxResponseBytes ?? OUTBOUND_MAX_RESPONSE_BYTES;
  const body =
    options.body === undefined || options.body === null ? null : Buffer.from(options.body);

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    const lower = name.toLowerCase();
    if (!CLIENT_HEADERS.has(lower) && !lower.startsWith('proxy-')) headers[lower] = value;
  }
  headers['connection'] = 'close';
  if (body !== null) headers['content-length'] = String(body.length);

  const blockList = neverAllowedBlockList(options.blockedAddresses);
  const blocked = blockList.check(target.address, target.family === 6 ? 'ipv6' : 'ipv4');

  const pinned: LookupFunction = (_hostname, lookupOptions, callback) => {
    if (lookupOptions.all === true) {
      (callback as (error: null, addresses: { address: string; family: number }[]) => void)(null, [
        { address: target.address, family: target.family },
      ]);
    } else {
      callback(null, target.address, target.family);
    }
  };

  const secure = url.protocol === 'https:';
  // No `proxyEnv`: environment proxies are never used (proxy egress is P2).
  const agent = secure
    ? new https.Agent({ keepAlive: false })
    : new http.Agent({ keepAlive: false });
  // `blockList` reaches `net.connect` through the agent (Node ≥ 22.13); not in the typings yet.
  const requestOptions: https.RequestOptions & { blockList: BlockList } = {
    method: options.method,
    // A name goes through the pinned lookup; an IP literal is connected to as is
    // (Node skips `lookup`), so it must be the vetted address itself.
    host: url.ipFamily === 0 ? url.host : target.address,
    port: url.port,
    path: url.path,
    headers,
    agent,
    lookup: pinned,
    // Second line behind `resolveOutboundTarget`: metadata, unspecified,
    // multicast and broadcast never reach the kernel (`ERR_IP_BLOCKED`).
    blockList,
    // SNI only for names (an IP literal has none).
    ...(secure && url.ipFamily === 0 ? { servername: url.host } : {}),
    ...(secure && options.ca !== undefined
      ? { ca: options.ca as string | Buffer | (string | Buffer)[] }
      : {}),
  };

  // Refused here, not by the socket alone: Node 24 throws its
  // `ERR_IP_BLOCKED` from inside the connect path (pinned lookup with
  // `all: true`, or an IP literal) as an uncaught exception instead of a
  // request error — that would take the worker process down.
  if (blocked) return Promise.reject(new OutboundHttpError('http_network'));

  return new Promise<GuardedResponse>((resolve, reject) => {
    let settled = false;
    let connectTimer: NodeJS.Timeout | null = null;
    const streams: Readable[] = [];
    const finish = (error: OutboundHttpError | null, response?: GuardedResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      if (connectTimer !== null) clearTimeout(connectTimer);
      if (error !== null) {
        request.destroy();
        for (const stream of streams) stream.destroy();
        reject(error);
      } else if (response !== undefined) {
        resolve(response);
      }
      agent.destroy();
    };
    const fail = (error: OutboundHttpError) => {
      finish(error);
    };

    const request = (secure ? https : http).request(requestOptions);
    const totalTimer = setTimeout(() => {
      fail(new OutboundHttpError('http_timeout'));
    }, timeoutMs);

    request.on('socket', (socket) => {
      if (!socket.connecting) return;
      connectTimer = setTimeout(() => {
        fail(new OutboundHttpError('http_timeout'));
      }, connectTimeoutMs);
      socket.once('connect', () => {
        if (connectTimer !== null) clearTimeout(connectTimer);
        connectTimer = null;
      });
    });
    request.on('error', () => {
      fail(new OutboundHttpError('http_network'));
    });
    request.on('response', (response) => {
      streams.push(response);
      const encoding = (response.headers['content-encoding'] ?? '').trim().toLowerCase();
      const decoder = decoderOf(encoding);
      let wireBytes = 0;
      let bodyBytes = 0;
      const chunks: Buffer[] = [];
      const tooLarge = () => {
        fail(new OutboundHttpError('http_response_too_large', { limit_bytes: maxBytes }));
      };
      response.on('data', (chunk: Buffer) => {
        wireBytes += chunk.length;
        if (wireBytes > maxBytes) tooLarge();
      });
      response.on('error', () => {
        fail(new OutboundHttpError('http_network'));
      });
      const reader: Readable = decoder === null ? response : response.pipe(decoder);
      if (decoder !== null) streams.push(reader);
      reader.on('data', (chunk: Buffer) => {
        if (settled) return;
        bodyBytes += chunk.length;
        if (bodyBytes > maxBytes) {
          tooLarge();
          return;
        }
        chunks.push(chunk);
      });
      reader.on('error', () => {
        fail(new OutboundHttpError('http_network'));
      });
      reader.on('end', () => {
        const out: Record<string, string | readonly string[]> = {};
        for (const [name, value] of Object.entries(response.headers)) {
          if (value === undefined) continue;
          if (decoder !== null && (name === 'content-encoding' || name === 'content-length')) {
            continue;
          }
          out[name] = value;
        }
        finish(null, {
          status: response.statusCode ?? 0,
          headers: out,
          body: Buffer.concat(chunks),
        });
      });
    });

    request.end(body ?? undefined);
  });
}
