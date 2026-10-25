import { Buffer } from 'node:buffer';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  guardedRequest,
  OutboundHttpError,
  resolveOutboundTarget,
  type HostLookup,
  type OutboundAllowlistEntry,
  type OutboundTarget,
} from '../../src/net/index.js';

import type { Id } from '@cellhive/contracts';
import type { AddressInfo, Socket } from 'node:net';

const ORG = 'org_NetRequestOrg001' as Id<'org'>;
const PUBLIC_ADDRESS = '93.184.216.34';

/** A loopback HTTP server counting TCP connections and recording requests. */
interface FakeServer {
  readonly port: number;
  connections: number;
  readonly requests: {
    method: string;
    url: string;
    headers: IncomingMessage['headers'];
    body: string;
  }[];
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  close(): Promise<void>;
}

async function startServer(): Promise<FakeServer> {
  const sockets = new Set<Socket>();
  const fake: FakeServer = {
    port: 0,
    connections: 0,
    requests: [],
    handler: (_req, res) => {
      res.end('ok');
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, 'close');
    },
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      fake.requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      fake.handler(req, res);
    });
  });
  server.on('connection', (socket: Socket) => {
    fake.connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return Object.assign(fake, { port: (server.address() as AddressInfo).port });
}

/** Answers from a list per call (the last answer repeats): a rebinding resolver. */
function answers(...list: (readonly string[])[]): HostLookup & { calls: number } {
  const lookup = (() => {
    const answer = list[Math.min(lookup.calls, list.length - 1)] ?? [];
    lookup.calls += 1;
    return Promise.resolve(answer);
  }) as unknown as HostLookup & { calls: number };
  lookup.calls = 0;
  return lookup;
}

function target(url: string, lookup: HostLookup, allowlist: readonly OutboundAllowlistEntry[]) {
  return resolveOutboundTarget(url, {
    organizationId: ORG,
    allowlist,
    privateAllowlist: 'org',
    lookup,
  });
}

async function failureOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'no error';
  } catch (error) {
    if (!(error instanceof OutboundHttpError)) throw error;
    return error.code === 'ssrf_blocked'
      ? `ssrf_blocked ${String(error.params['reason'])}`
      : error.code;
  }
}

describe('guardedRequest (ADR-35 §3, BACKLOG T600)', () => {
  let internal: FakeServer;
  let other: FakeServer;

  beforeAll(async () => {
    internal = await startServer();
    other = await startServer();
  });

  afterAll(async () => {
    await internal.close();
    await other.close();
  });

  afterEach(() => {
    for (const server of [internal, other]) {
      server.connections = 0;
      server.requests.length = 0;
      server.handler = (_req, res) => {
        res.end('ok');
      };
    }
  });

  const allowInternal = (): OutboundAllowlistEntry[] => [
    { host: 'n8n.internal', wildcard: false, port: internal.port },
  ];

  it('reaches an allowlisted internal host through the vetted address, keeping the host name', async () => {
    // `.internal` is not resolvable by the system: the pinned address is the only way.
    internal.handler = (_req, res) => {
      res.writeHead(201, { 'content-type': 'application/json' }).end('{"ok":true}');
    };
    const vetted = await target(
      `http://n8n.internal:${String(internal.port)}/webhook/abc?x=1`,
      answers(['127.0.0.1']),
      allowInternal(),
    );
    const response = await guardedRequest(vetted, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Host: 'evil.example', 'X-Custom': 'yes' },
      body: '{"a":1}',
    });
    expect(response.status).toBe(201);
    expect(response.headers['content-type']).toBe('application/json');
    expect(response.body.toString()).toBe('{"ok":true}');
    expect(internal.requests).toEqual([
      expect.objectContaining({ method: 'POST', url: '/webhook/abc?x=1', body: '{"a":1}' }),
    ]);
    const headers = internal.requests[0]?.headers ?? {};
    expect(headers.host).toBe(`n8n.internal:${String(internal.port)}`);
    expect(headers['x-custom']).toBe('yes');
    expect(headers['content-length']).toBe('7');
    expect(headers.connection).toBe('close');
  });

  it('DNS rebinding: a public first answer then 127.0.0.1 never reaches the loopback server', async () => {
    const lookup = answers([PUBLIC_ADDRESS], ['127.0.0.1']);
    const vetted = await target(`http://rebind.example:${String(internal.port)}/`, lookup, [
      // The port is allowlisted for the public host; loopback stays closed (not this answer).
      { host: 'rebind.example', wildcard: false, port: internal.port },
    ]);
    expect(vetted.address).toBe(PUBLIC_ADDRESS);
    // The public stand-in is refused by the socket itself: no packet leaves the machine.
    expect(
      await failureOf(
        guardedRequest(vetted, { method: 'GET', blockedAddresses: [PUBLIC_ADDRESS] }),
      ),
    ).toBe('http_network');
    expect(lookup.calls).toBe(1);
    expect(internal.connections).toBe(0);
  });

  it('a host answering [public, private] is refused before any connection', async () => {
    const lookup = answers([PUBLIC_ADDRESS, '127.0.0.1']);
    expect(await failureOf(target(`http://mixed.example/`, lookup, []))).toBe(
      'ssrf_blocked private_address',
    );
    expect(internal.connections).toBe(0);
  });

  it('never follows a redirect: 302 to loopback is returned as is', async () => {
    internal.handler = (_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${String(other.port)}/` }).end();
    };
    const vetted = await target(
      `http://n8n.internal:${String(internal.port)}/`,
      answers(['127.0.0.1']),
      allowInternal(),
    );
    const response = await guardedRequest(vetted, { method: 'GET' });
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe(`http://127.0.0.1:${String(other.port)}/`);
    expect(other.connections).toBe(0);
  });

  it('refuses a port other than 80/443 without an entry (:6379)', async () => {
    expect(await failureOf(target('http://127.0.0.1:6379/', answers([]), []))).toBe(
      'ssrf_blocked port_not_allowed',
    );
    expect(
      await failureOf(target('http://cache.example:6379/', answers([PUBLIC_ADDRESS]), [])),
    ).toBe('ssrf_blocked port_not_allowed');
  });

  it('a name pointing at 169.254.169.254 stays blocked even when allowlisted', async () => {
    expect(
      await failureOf(
        target('http://meta.internal/', answers(['169.254.169.254']), [
          { host: 'meta.internal', wildcard: false, port: null },
        ]),
      ),
    ).toBe('ssrf_blocked blocked_address');
  });

  it('the socket refuses a never-reachable address even past the resolver', async () => {
    const vetted = await target('http://forged.example/', answers([PUBLIC_ADDRESS]), []);
    for (const address of ['169.254.169.254', '0.0.0.0']) {
      const forged: OutboundTarget = { ...vetted, address, family: 4 };
      expect(await failureOf(guardedRequest(forged, { method: 'GET', timeoutMs: 2_000 }))).toBe(
        'http_network',
      );
    }
    // An IP literal is connected to as the vetted address, never the URL text.
    const literal = await target('http://8.8.8.8/', answers([]), []);
    const swapped: OutboundTarget = { ...literal, address: '169.254.169.254', family: 4 };
    expect(await failureOf(guardedRequest(swapped, { method: 'GET', timeoutMs: 2_000 }))).toBe(
      'http_network',
    );
  });

  it('aborts a 2 MiB response at 1 MiB', async () => {
    internal.handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(Buffer.alloc(2 * 1024 * 1024, 1));
    };
    const vetted = await target(
      `http://n8n.internal:${String(internal.port)}/`,
      answers(['127.0.0.1']),
      allowInternal(),
    );
    await expect(guardedRequest(vetted, { method: 'GET' })).rejects.toMatchObject({
      code: 'http_response_too_large',
      params: { limit_bytes: 1_048_576 },
    });
  });

  it('counts the body after decompression (a small gzip of 2 MiB is too large)', async () => {
    const bomb = gzipSync(Buffer.alloc(2 * 1024 * 1024, 0));
    expect(bomb.length).toBeLessThan(10_000);
    internal.handler = (_req, res) => {
      res.writeHead(200, { 'content-encoding': 'gzip' }).end(bomb);
    };
    const vetted = await target(
      `http://n8n.internal:${String(internal.port)}/`,
      answers(['127.0.0.1']),
      allowInternal(),
    );
    expect(await failureOf(guardedRequest(vetted, { method: 'GET' }))).toBe(
      'http_response_too_large',
    );
  });

  it('decompresses a gzip body within the cap', async () => {
    internal.handler = (_req, res) => {
      res.writeHead(200, { 'content-encoding': 'gzip' }).end(gzipSync('hello'));
    };
    const vetted = await target(
      `http://n8n.internal:${String(internal.port)}/`,
      answers(['127.0.0.1']),
      allowInternal(),
    );
    const response = await guardedRequest(vetted, { method: 'GET' });
    expect(response.body.toString()).toBe('hello');
    expect(response.headers['content-encoding']).toBeUndefined();
  });

  it('a server slower than the timeout is http_timeout (scaled: 300 ms for 10 s)', async () => {
    internal.handler = (_req, res) => {
      setTimeout(() => res.end('late'), 1_000).unref();
    };
    const vetted = await target(
      `http://n8n.internal:${String(internal.port)}/`,
      answers(['127.0.0.1']),
      allowInternal(),
    );
    expect(await failureOf(guardedRequest(vetted, { method: 'GET', timeoutMs: 300 }))).toBe(
      'http_timeout',
    );
  });

  it('a closed port is http_network', async () => {
    const closed = await startServer();
    const port = closed.port;
    await closed.close();
    const vetted = await target(`http://n8n.internal:${String(port)}/`, answers(['127.0.0.1']), [
      { host: 'n8n.internal', wildcard: false, port },
    ]);
    expect(await failureOf(guardedRequest(vetted, { method: 'GET' }))).toBe('http_network');
  });

  it('ignores proxy environment variables', async () => {
    const proxy = await startServer();
    const saved = { http: process.env['HTTP_PROXY'], lower: process.env['http_proxy'] };
    process.env['HTTP_PROXY'] = `http://127.0.0.1:${String(proxy.port)}`;
    process.env['http_proxy'] = `http://127.0.0.1:${String(proxy.port)}`;
    try {
      const vetted = await target(
        `http://n8n.internal:${String(internal.port)}/`,
        answers(['127.0.0.1']),
        allowInternal(),
      );
      expect((await guardedRequest(vetted, { method: 'GET' })).status).toBe(200);
      expect(proxy.connections).toBe(0);
      expect(internal.connections).toBe(1);
    } finally {
      if (saved.http === undefined) delete process.env['HTTP_PROXY'];
      else process.env['HTTP_PROXY'] = saved.http;
      if (saved.lower === undefined) delete process.env['http_proxy'];
      else process.env['http_proxy'] = saved.lower;
      await proxy.close();
    }
  });
});
