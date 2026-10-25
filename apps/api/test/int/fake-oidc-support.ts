import { Buffer } from 'node:buffer';
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';

/**
 * A fake OpenID Provider for integration tests (BACKLOG T707), with
 * `node:http` + `node:crypto` only: discovery, JWKS (RS256, key rotation),
 * an `authorize` endpoint that accepts at once (`login_hint` picks the
 * user), a `token` endpoint that checks `client_secret_basic`, the code,
 * the redirect URI and the PKCE `code_verifier`, and per-login changes of
 * the ID token (wrong `nonce`/`iss`/`aud`, past `exp`, bad signature, old or
 * missing `auth_time`…).
 */

export interface FakeOidcUser {
  readonly sub: string;
  readonly email?: string;
  /** Sent as is (a string `"true"` must not count as verified). */
  readonly email_verified?: boolean | string;
  readonly name?: string;
  readonly preferred_username?: string;
}

/** Changes to the next ID token issued (then reset). */
export interface IdTokenTweaks {
  readonly nonce?: string;
  readonly iss?: string;
  readonly aud?: string | readonly string[];
  readonly azp?: string;
  /** Seconds relative to now. */
  readonly expIn?: number;
  /** Seconds relative to now. */
  readonly iatIn?: number;
  /** Sign with a key that is not in the JWKS, under the current `kid`. */
  readonly badSignature?: boolean;
  /** `auth_time` in seconds relative to now (default 0); `null` leaves the claim out (T708). */
  readonly authTimeIn?: number | null;
}

interface SigningKey {
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly publicJwk: Record<string, unknown>;
}

interface IssuedCode {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly nonce: string | undefined;
  readonly user: FakeOidcUser;
}

export interface FakeOidcRequest {
  readonly method: string;
  readonly path: string;
}

export interface FakeOidcProvider {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Users by `login_hint`; `default` is used without a hint. */
  readonly users: Map<string, FakeOidcUser>;
  /** Applied to the next ID token, then cleared. */
  tweaks: IdTokenTweaks | null;
  /** The next `authorize` redirects with this OAuth `error` (then cleared). */
  authorizeError: { readonly error: string; readonly description: string } | null;
  readonly requests: FakeOidcRequest[];
  /** Every secret value that went through this provider: codes, verifiers, states, nonces, tokens. */
  readonly secretsSeen: Set<string>;
  /** Replaces the signing key (new `kid`); the JWKS only lists the new key. */
  rotateKey(): void;
  count(path: string): number;
  /** `OIDC_<SLUG>_*` for a provider slug, plus overrides (`ALLOW_SIGNUP: 'true'`…). */
  env(slug: string, overrides?: Readonly<Record<string, string>>): Record<string, string>;
  close(): Promise<void>;
}

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

function newKey(): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = `k-${randomBytes(6).toString('hex')}`;
  return {
    kid,
    privateKey,
    publicJwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' },
  };
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
  const match = /^Basic ([A-Za-z0-9+/=]+)$/.exec(header ?? '');
  if (match === null) return null;
  const decoded = Buffer.from(match[1] ?? '', 'base64').toString('utf8');
  const index = decoded.indexOf(':');
  if (index === -1) return null;
  const unescape = (value: string) => decodeURIComponent(value.replaceAll('+', ' '));
  return { id: unescape(decoded.slice(0, index)), secret: unescape(decoded.slice(index + 1)) };
}

export async function startFakeOidc(): Promise<FakeOidcProvider> {
  const clientId = `client-${randomBytes(4).toString('hex')}`;
  const clientSecret = `fake-oidc-client-secret-${randomBytes(12).toString('hex')}`;
  const codes = new Map<string, IssuedCode>();
  const requests: FakeOidcRequest[] = [];
  const secretsSeen = new Set<string>([clientSecret]);
  let key = newKey();
  let issuer = '';

  const provider: FakeOidcProvider = {
    get issuer() {
      return issuer;
    },
    clientId,
    clientSecret,
    users: new Map([
      ['default', { sub: 'sub-default', email: 'default@example.test', email_verified: true }],
    ]),
    tweaks: null,
    authorizeError: null,
    requests,
    secretsSeen,
    rotateKey() {
      key = newKey();
    },
    count(path) {
      return requests.filter((request) => request.path === path).length;
    },
    env(slug, overrides = {}) {
      const prefix = `OIDC_${slug.toUpperCase().replaceAll('-', '_')}_`;
      const env: Record<string, string> = {
        [`${prefix}ISSUER`]: issuer,
        [`${prefix}CLIENT_ID`]: clientId,
        [`${prefix}CLIENT_SECRET`]: clientSecret,
      };
      for (const [name, value] of Object.entries(overrides)) env[`${prefix}${name}`] = value;
      return env;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };

  function authorize(url: URL, response: ServerResponse): void {
    const params = url.searchParams;
    const redirectUri = params.get('redirect_uri');
    if (redirectUri === null || params.get('client_id') !== clientId) {
      sendJson(response, 400, { error: 'invalid_request' });
      return;
    }
    const back = new URL(redirectUri);
    const state = params.get('state');
    if (state !== null) {
      back.searchParams.set('state', state);
      secretsSeen.add(state);
    }
    const nonce = params.get('nonce') ?? undefined;
    if (nonce !== undefined) secretsSeen.add(nonce);
    const challenge = params.get('code_challenge');
    const error = provider.authorizeError;
    provider.authorizeError = null;
    if (error !== null) {
      back.searchParams.set('error', error.error);
      back.searchParams.set('error_description', error.description);
    } else if (
      params.get('response_type') !== 'code' ||
      params.get('code_challenge_method') !== 'S256' ||
      challenge === null ||
      !(params.get('scope') ?? '').split(' ').includes('openid')
    ) {
      back.searchParams.set('error', 'invalid_request');
    } else {
      const user = provider.users.get(params.get('login_hint') ?? 'default');
      if (user === undefined) {
        back.searchParams.set('error', 'access_denied');
      } else {
        const code = randomBytes(24).toString('base64url');
        secretsSeen.add(code);
        codes.set(code, { clientId, redirectUri, codeChallenge: challenge, nonce, user });
        back.searchParams.set('code', code);
      }
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
    if (verifier !== '') secretsSeen.add(verifier);
    if (
      form.get('grant_type') !== 'authorization_code' ||
      issued === undefined ||
      form.get('redirect_uri') !== issued.redirectUri ||
      base64url(createHash('sha256').update(verifier).digest()) !== issued.codeChallenge
    ) {
      sendJson(response, 400, { error: 'invalid_grant' });
      return;
    }
    const tweaks = provider.tweaks ?? {};
    provider.tweaks = null;
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      iss: tweaks.iss ?? issuer,
      aud: tweaks.aud ?? clientId,
      ...(tweaks.azp === undefined ? {} : { azp: tweaks.azp }),
      exp: now + (tweaks.expIn ?? 300),
      iat: now + (tweaks.iatIn ?? 0),
      // The fake provider authenticates on every authorize: `auth_time` = now.
      ...(tweaks.authTimeIn === null ? {} : { auth_time: now + (tweaks.authTimeIn ?? 0) }),
      ...(tweaks.nonce !== undefined
        ? { nonce: tweaks.nonce }
        : issued.nonce === undefined
          ? {}
          : { nonce: issued.nonce }),
      ...issued.user,
    };
    const signingKey = tweaks.badSignature === true ? newKey().privateKey : key.privateKey;
    const idToken = signJwt(claims, key.kid, signingKey);
    const accessToken = randomBytes(24).toString('base64url');
    secretsSeen.add(idToken);
    secretsSeen.add(accessToken);
    sendJson(response, 200, {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 300,
      id_token: idToken,
    });
  }

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', issuer);
    requests.push({ method: request.method ?? 'GET', path: url.pathname });
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
      sendJson(response, 200, { keys: [key.publicJwk] });
    } else if (request.method === 'GET' && url.pathname === '/authorize') {
      authorize(url, response);
    } else if (request.method === 'POST' && url.pathname === '/token') {
      void token(request, response);
    } else {
      sendJson(response, 404, { error: 'not_found' });
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  issuer = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return provider;
}
