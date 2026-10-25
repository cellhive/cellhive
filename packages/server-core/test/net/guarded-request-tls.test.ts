import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  guardedRequest,
  OutboundHttpError,
  resolveOutboundTarget,
  type HostLookup,
} from '../../src/net/index.js';

import type { Id } from '@cellhive/contracts';
import type { AddressInfo } from 'node:net';

const ORG = 'org_NetTlsTestOrg001' as Id<'org'>;
const FIXTURES = new URL('./fixtures/', import.meta.url);
/** Self-signed for `hooks.example.test` only (SAN), valid 100 years. */
const CERT = readFileSync(new URL('tls-hooks.example.test.crt', FIXTURES), 'utf8');
const KEY = readFileSync(new URL('tls-hooks.example.test.key', FIXTURES), 'utf8');

/**
 * BACKLOG "Tồn đọng S5c" (T600 → T605): HTTPS through the pinned address.
 * The socket goes to the vetted IP (here loopback, opened by an exact
 * allowlist entry with its port) while TLS keeps the original host name:
 * SNI = the host, and the certificate is checked against that name — a
 * certificate for another name fails (`http_network`), even though the
 * address is the same.
 */
describe('guardedRequest over TLS (SNI and certificate name)', () => {
  let server: Server;
  let port: number;
  const servernames: (string | false)[] = [];

  /** Every name resolves to the loopback server. */
  const lookup: HostLookup = () => Promise.resolve(['127.0.0.1']);

  const target = (host: string) =>
    resolveOutboundTarget(`https://${host}:${String(port)}/hook`, {
      organizationId: ORG,
      allowlist: [{ host, wildcard: false, port }],
      privateAllowlist: 'org',
      lookup,
    });

  beforeAll(async () => {
    server = createServer({ cert: CERT, key: KEY }, (req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ host: req.headers.host ?? null }));
    });
    server.on('secureConnection', (socket) => {
      servernames.push((socket as unknown as { servername: string | false }).servername);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server.close();
    await once(server, 'close');
  });

  it('connects to the pinned address with SNI and Host of the original name', async () => {
    const response = await guardedRequest(await target('hooks.example.test'), {
      method: 'GET',
      ca: CERT,
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body.toString('utf8'))).toEqual({
      host: `hooks.example.test:${String(port)}`,
    });
    expect(servernames.at(-1)).toBe('hooks.example.test');
  });

  it('refuses a certificate issued for another name (http_network)', async () => {
    const error = await guardedRequest(await target('other.example.test'), {
      method: 'GET',
      ca: CERT,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OutboundHttpError);
    expect((error as OutboundHttpError).code).toBe('http_network');
  });

  it('refuses a certificate the trust store does not know (no CA given)', async () => {
    const error = await guardedRequest(await target('hooks.example.test'), {
      method: 'GET',
    }).catch((caught: unknown) => caught);
    expect((error as OutboundHttpError).code).toBe('http_network');
  });
});
