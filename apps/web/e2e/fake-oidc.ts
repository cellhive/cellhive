import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * A fake OpenID Provider for the E2E stack (BACKLOG T715), adapted from the
 * integration-test one of T707 (`apps/api/test/int/fake-oidc-support.ts`):
 * the stack runs the API with `NODE_ENV=production`, where an issuer must
 * be `https://`, so this one serves HTTPS with a throwaway self-signed
 * certificate (made with the `openssl` CLI) that the API trusts through
 * `NODE_EXTRA_CA_CERTS`; the browser of a spec ignores certificate errors.
 * Instead of `login_hint`, `authorize` shows a small sign-in form so a spec
 * types who signs in, as with a real provider.
 */

export const FAKE_OIDC_SLUG = 'fake-idp';
export const FAKE_OIDC_NAME = 'Fake IdP';
/**
 * A second provider on the same fake server with `LINK_BY_EMAIL=true`
 * (T719: an unverified email still never links to an existing account).
 */
export const MAIL_OIDC_SLUG = 'mail-idp';
export const MAIL_OIDC_NAME = 'Mail IdP';

export interface FakeOidcServer {
  readonly issuer: string;
  /** `OIDC_*` and `NODE_EXTRA_CA_CERTS` for the API process. */
  readonly env: Record<string, string>;
  close(): Promise<void>;
}

interface IssuedCode {
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly nonce: string | undefined;
  readonly claims: Record<string, unknown>;
}

const CERT_CONFIG = [
  '[req]',
  'distinguished_name = dn',
  'prompt = no',
  '[dn]',
  'CN = 127.0.0.1',
  '[v3]',
  'subjectAltName = IP:127.0.0.1',
  'basicConstraints = critical, CA:TRUE',
  'keyUsage = digitalSignature, keyCertSign',
  'extendedKeyUsage = serverAuth',
  '',
].join('\n');

async function selfSignedCertificate(dir: string): Promise<{ key: string; cert: string }> {
  const config = join(dir, 'openssl.cnf');
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  await writeFile(config, CERT_CONFIG);
  const result = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '2',
      '-config',
      config,
      '-extensions',
      'v3',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  if (result.status !== 0) {
    throw new Error(`openssl could not make the fake IdP certificate: ${String(result.stderr)}`);
  }
  return { key: await readFile(keyPath, 'utf8'), cert: certPath };
}

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

function signJwt(payload: Record<string, unknown>, kid: string, key: KeyObject): string {
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
  const body = base64url(JSON.stringify(payload));
  const signature = sign('sha256', Buffer.from(`${header}.${body}`), key);
  return `${header}.${body}.${base64url(signature)}`;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

/** `client_secret_basic` (RFC 6749 §2.3.1): form-urlencoded id and secret, then Basic. */
function basicCredentials(header: string | undefined): { id: string; secret: string } | null {
  const match = /^Basic ([A-Za-z0-9+/=]+)$/u.exec(header ?? '');
  if (match === null) return null;
  const decoded = Buffer.from(match[1] ?? '', 'base64').toString('utf8');
  const index = decoded.indexOf(':');
  if (index === -1) return null;
  const unescape = (value: string) => decodeURIComponent(value.replaceAll('+', ' '));
  return { id: unescape(decoded.slice(0, index)), secret: unescape(decoded.slice(index + 1)) };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** The provider's sign-in page: who signs in is typed by the spec. */
function signInPage(query: URLSearchParams): string {
  const maxAge = query.get('max_age');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Fake IdP sign-in</title></head>
<body>
<h1>Fake IdP</h1>
<p data-testid="fake-idp-max-age">max_age: ${maxAge === null ? 'none' : escapeHtml(maxAge)}</p>
<form method="post" action="/authorize">
<input type="hidden" name="request" value="${escapeHtml(query.toString())}">
<p><label>Subject <input name="sub" required></label></p>
<p><label>Email <input name="email"></label></p>
<p><label><input type="checkbox" name="email_verified" checked> Email verified</label></p>
<p><label>Name <input name="name"></label></p>
<p><button type="submit">Sign in to Fake IdP</button></p>
</form>
</body></html>`;
}

export async function startFakeOidc(): Promise<FakeOidcServer> {
  const dir = await mkdtemp(join(tmpdir(), 'cellhive-e2e-idp-'));
  const { key: tlsKey, cert: certPath } = await selfSignedCertificate(dir);
  const clientId = `client-${randomBytes(4).toString('hex')}`;
  const clientSecret = `fake-oidc-client-secret-${randomBytes(12).toString('hex')}`;
  const codes = new Map<string, IssuedCode>();
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = `k-${randomBytes(6).toString('hex')}`;
  const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  let issuer = '';

  function authorizeForm(url: URL, response: ServerResponse): void {
    const params = url.searchParams;
    if (params.get('client_id') !== clientId || params.get('redirect_uri') === null) {
      sendJson(response, 400, { error: 'invalid_request' });
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(signInPage(params));
  }

  async function approve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const form = new URLSearchParams(await readBody(request));
    const params = new URLSearchParams(form.get('request') ?? '');
    const redirectUri = params.get('redirect_uri');
    const challenge = params.get('code_challenge');
    if (redirectUri === null || params.get('client_id') !== clientId) {
      sendJson(response, 400, { error: 'invalid_request' });
      return;
    }
    const back = new URL(redirectUri);
    const state = params.get('state');
    if (state !== null) back.searchParams.set('state', state);
    if (
      params.get('response_type') !== 'code' ||
      params.get('code_challenge_method') !== 'S256' ||
      challenge === null
    ) {
      back.searchParams.set('error', 'invalid_request');
    } else {
      const code = randomBytes(24).toString('base64url');
      const email = form.get('email') ?? '';
      const name = form.get('name') ?? '';
      codes.set(code, {
        redirectUri,
        codeChallenge: challenge,
        nonce: params.get('nonce') ?? undefined,
        claims: {
          sub: form.get('sub') ?? '',
          ...(email === '' ? {} : { email, email_verified: form.get('email_verified') === 'on' }),
          ...(name === '' ? {} : { name }),
          // Every sign-in on this page authenticates the user now.
          auth_time: Math.floor(Date.now() / 1000),
        },
      });
      back.searchParams.set('code', code);
    }
    response.writeHead(302, { location: back.href });
    response.end();
  }

  async function token(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const form = new URLSearchParams(await readBody(request));
    const credentials = basicCredentials(request.headers.authorization);
    if (credentials?.id !== clientId || credentials.secret !== clientSecret) {
      sendJson(response, 401, { error: 'invalid_client' });
      return;
    }
    const code = form.get('code') ?? '';
    const issued = codes.get(code);
    codes.delete(code);
    const verifier = form.get('code_verifier') ?? '';
    if (
      form.get('grant_type') !== 'authorization_code' ||
      issued === undefined ||
      form.get('redirect_uri') !== issued.redirectUri ||
      base64url(createHash('sha256').update(verifier).digest()) !== issued.codeChallenge
    ) {
      sendJson(response, 400, { error: 'invalid_grant' });
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    const idToken = signJwt(
      {
        iss: issuer,
        aud: clientId,
        exp: now + 300,
        iat: now,
        ...(issued.nonce === undefined ? {} : { nonce: issued.nonce }),
        ...issued.claims,
      },
      kid,
      privateKey,
    );
    sendJson(response, 200, {
      access_token: randomBytes(24).toString('base64url'),
      token_type: 'Bearer',
      expires_in: 300,
      id_token: idToken,
    });
  }

  const server: Server = createServer(
    { key: tlsKey, cert: await readFile(certPath) },
    (request, response) => {
      const url = new URL(request.url ?? '/', issuer);
      if (request.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
        sendJson(response, 200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['client_secret_basic'],
          scopes_supported: ['openid', 'email', 'profile'],
        });
      } else if (request.method === 'GET' && url.pathname === '/jwks') {
        sendJson(response, 200, { keys: [publicJwk] });
      } else if (request.method === 'GET' && url.pathname === '/authorize') {
        authorizeForm(url, response);
      } else if (request.method === 'POST' && url.pathname === '/authorize') {
        void approve(request, response);
      } else if (request.method === 'POST' && url.pathname === '/token') {
        void token(request, response);
      } else {
        sendJson(response, 404, { error: 'not_found' });
      }
    },
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  issuer = `https://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  const prefix = `OIDC_${FAKE_OIDC_SLUG.toUpperCase().replaceAll('-', '_')}_`;
  const mail = `OIDC_${MAIL_OIDC_SLUG.toUpperCase().replaceAll('-', '_')}_`;
  return {
    issuer,
    env: {
      OIDC_PROVIDERS: `${FAKE_OIDC_SLUG},${MAIL_OIDC_SLUG}`,
      [`${prefix}ISSUER`]: issuer,
      [`${prefix}CLIENT_ID`]: clientId,
      [`${prefix}CLIENT_SECRET`]: clientSecret,
      [`${prefix}NAME`]: FAKE_OIDC_NAME,
      // JIT accounts: the "no password, one connection" user of t715.
      [`${prefix}ALLOW_SIGNUP`]: 'true',
      [`${mail}ISSUER`]: issuer,
      [`${mail}CLIENT_ID`]: clientId,
      [`${mail}CLIENT_SECRET`]: clientSecret,
      [`${mail}NAME`]: MAIL_OIDC_NAME,
      [`${mail}LINK_BY_EMAIL`]: 'true',
      NODE_EXTRA_CA_CERTS: certPath,
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      await rm(dir, { recursive: true, force: true });
    },
  };
}
