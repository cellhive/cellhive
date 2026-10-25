import { Buffer } from 'node:buffer';

import {
  OIDC_LINK_MAX_AUTH_AGE_SECONDS,
  OIDC_MAX_IAT_SKEW_SECONDS,
  OIDC_METADATA_CACHE_SECONDS,
  OIDC_PROVIDER_TIMEOUT_SECONDS,
  type AuthProvider,
  type OidcCallbackQuery,
} from '@cellhive/contracts';
import { Inject, Injectable } from '@nestjs/common';
import * as client from 'openid-client';

import { APP_CONFIG } from '../../tokens.js';

import { candidateKeys, jwsHeaderOf, verifyJws, type Jwk } from './jws.js';

import type { OidcState } from './state-cookie.js';
import type { AppConfig, OidcProviderConfig } from '@cellhive/server-core';

/** Largest JWKS document read (bytes). */
const MAX_JWKS_BYTES = 256 * 1024;

/**
 * Why a call to a provider failed, for logs and metrics only: never the
 * provider's response, a claim, the code or a token.
 */
export type OidcFailureReason =
  | 'discovery_failed'
  | 'token_request_failed'
  | 'id_token_invalid'
  | 'jwks_failed'
  | 'signature_invalid';

/** A provider call that failed (shown to the user as `OIDC_PROVIDER_ERROR`). */
export class OidcFailure extends Error {
  constructor(
    readonly reason: OidcFailureReason,
    /** `code` of the `openid-client` error (e.g. `OAUTH_JWT_CLAIM_COMPARISON_FAILED`), if any. */
    readonly libraryCode: string | null = null,
    /** OAuth `error` of the token endpoint (`invalid_grant`, …), if it looked like one. */
    readonly oauthError: string | null = null,
  ) {
    super(`OIDC ${reason}`);
    this.name = 'OidcFailure';
  }
}

/** Identity claims of a validated ID token (OIDC Core §5.1). */
export interface OidcIdentity {
  readonly subject: string;
  /** `null` when absent or not a string. */
  readonly email: string | null;
  /** `true` only when the claim is the JSON boolean `true`. */
  readonly emailVerified: boolean;
  readonly name: string | null;
  readonly preferredUsername: string | null;
}

interface CachedConfiguration {
  readonly configuration: client.Configuration;
  readonly fetchedAt: number;
}

interface CachedJwks {
  readonly keys: readonly Jwk[];
  readonly fetchedAt: number;
}

function codeOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : null;
}

/**
 * The body of `response` as UTF-8, refused with `TOO_LARGE` beyond
 * `maxBytes`: early on a larger `content-length`, else while reading (the
 * stream is cancelled at the first byte over the limit).
 */
export async function readCappedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN);
  const tooLarge = () => new OidcFailure('jwks_failed', 'TOO_LARGE');
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw tooLarge();
  }
  if (response.body === null) return '';
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

function oauthErrorOf(error: unknown): string | null {
  if (!(error instanceof client.ResponseBodyError)) return null;
  return /^[a-z0-9_]{1,64}$/.test(error.error) ? error.error : null;
}

function stringClaim(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function isJwk(value: unknown): value is Jwk {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { kty?: unknown }).kty === 'string'
  );
}

/**
 * Calls to the OIDC providers of `OIDC_PROVIDERS` (ADR-36 §3) through
 * `openid-client` v6: discovery, authorization URL, code exchange with PKCE
 * and `client_secret_basic`, ID token validation. A named exception of the
 * single outbound HTTP gate (SPEC §14.3): the URLs come from the operator's
 * environment (an IdP inside the LAN is fine), not from users. Every call
 * has a 10 s timeout; metadata and JWKS are cached 1 hour, the JWKS is
 * reloaded when a token names an unknown `kid`.
 */
@Injectable()
export class OidcClient {
  /** Clock of the caches and of the `iat` check (epoch milliseconds); tests move it. */
  now: () => number = () => Date.now();
  private readonly providers: ReadonlyMap<string, OidcProviderConfig>;
  private readonly configurations = new Map<string, CachedConfiguration>();
  private readonly discoveries = new Map<string, Promise<client.Configuration>>();
  private readonly jwks = new Map<string, CachedJwks>();
  private readonly jwksLoads = new Map<string, Promise<readonly Jwk[]>>();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.providers = new Map(config.oidc.providers.map((provider) => [provider.slug, provider]));
  }

  /** Sign-in buttons, in `OIDC_PROVIDERS` order. */
  list(): AuthProvider[] {
    return this.config.oidc.providers.map(({ slug, name }) => ({ slug, name }));
  }

  provider(slug: string): OidcProviderConfig | undefined {
    return this.providers.get(slug);
  }

  /** Redirect URI registered at the provider. */
  redirectUri(provider: OidcProviderConfig): string {
    return `${this.config.publicUrl}/api/v1/auth/oidc/${provider.slug}/callback`;
  }

  /**
   * Authorization request (code flow, PKCE S256, `state`, `nonce`); a link
   * attempt (T708) also sends `max_age=0` so the provider authenticates the
   * person again instead of reusing whatever session it has.
   */
  async authorizationUrl(provider: OidcProviderConfig, state: OidcState): Promise<URL> {
    const configuration = await this.configuration(provider);
    const codeChallenge = await client.calculatePKCECodeChallenge(state.codeVerifier);
    return client.buildAuthorizationUrl(configuration, {
      response_type: 'code',
      redirect_uri: this.redirectUri(provider),
      scope: provider.scopes.join(' '),
      state: state.state,
      nonce: state.nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      ...(state.link === undefined ? {} : { max_age: '0' }),
    });
  }

  /**
   * Exchanges the code of a successful authorization response and returns
   * the identity of the validated ID token: `iss` = issuer, `aud` contains
   * the client id (`azp` when several), `exp`, `iat` within 5 minutes,
   * `nonce` of the attempt, signature by a key of the provider's JWKS.
   */
  async signIn(
    provider: OidcProviderConfig,
    query: OidcCallbackQuery,
    state: OidcState,
  ): Promise<OidcIdentity> {
    const configuration = await this.configuration(provider);
    const callbackUrl = new URL(this.redirectUri(provider));
    if (query.code !== undefined) callbackUrl.searchParams.set('code', query.code);
    if (query.state !== undefined) callbackUrl.searchParams.set('state', query.state);
    if (query.iss !== undefined) callbackUrl.searchParams.set('iss', query.iss);

    let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
    try {
      tokens = await client.authorizationCodeGrant(configuration, callbackUrl, {
        pkceCodeVerifier: state.codeVerifier,
        expectedState: state.state,
        expectedNonce: state.nonce,
        idTokenExpected: true,
      });
    } catch (error) {
      const code = codeOf(error);
      const claimProblem =
        code === 'OAUTH_JWT_CLAIM_COMPARISON_FAILED' ||
        code === 'OAUTH_JWT_TIMESTAMP_CHECK_FAILED' ||
        code === 'OAUTH_INVALID_RESPONSE';
      throw new OidcFailure(
        claimProblem ? 'id_token_invalid' : 'token_request_failed',
        code,
        oauthErrorOf(error),
      );
    }
    const idToken = tokens.id_token;
    const claims = tokens.claims();
    if (idToken === undefined || claims === undefined) throw new OidcFailure('id_token_invalid');
    const nowSeconds = this.now() / 1000;
    if (Math.abs(nowSeconds - claims.iat) > OIDC_MAX_IAT_SKEW_SECONDS) {
      throw new OidcFailure('id_token_invalid', 'IAT_SKEW');
    }
    if (state.link !== undefined) {
      // Link mode asked for `max_age=0`: the person must just have signed in.
      const authTime = claims.auth_time;
      if (
        typeof authTime !== 'number' ||
        nowSeconds - authTime > OIDC_LINK_MAX_AUTH_AGE_SECONDS ||
        authTime - nowSeconds > OIDC_MAX_IAT_SKEW_SECONDS
      ) {
        throw new OidcFailure('id_token_invalid', 'AUTH_TIME');
      }
    }
    await this.verifySignature(provider, configuration, idToken);
    return {
      subject: claims.sub,
      email: stringClaim(claims['email']),
      emailVerified: claims['email_verified'] === true,
      name: stringClaim(claims['name']),
      preferredUsername: stringClaim(claims['preferred_username']),
    };
  }

  /** Provider metadata (discovery), cached 1 hour; one discovery in flight per provider. */
  private async configuration(provider: OidcProviderConfig): Promise<client.Configuration> {
    const cached = this.configurations.get(provider.slug);
    if (
      cached !== undefined &&
      this.now() - cached.fetchedAt < OIDC_METADATA_CACHE_SECONDS * 1000
    ) {
      return cached.configuration;
    }
    const pending = this.discoveries.get(provider.slug);
    if (pending !== undefined) return pending;
    const discovery = this.discover(provider).finally(() => {
      this.discoveries.delete(provider.slug);
    });
    this.discoveries.set(provider.slug, discovery);
    return discovery;
  }

  private async discover(provider: OidcProviderConfig): Promise<client.Configuration> {
    const insecure = new URL(provider.issuer).protocol === 'http:';
    let configuration: client.Configuration;
    try {
      configuration = await client.discovery(
        new URL(provider.issuer),
        provider.clientId,
        undefined,
        client.ClientSecretBasic(provider.clientSecret),
        {
          timeout: OIDC_PROVIDER_TIMEOUT_SECONDS,
          // `http://` issuers are accepted by the configuration only with
          // NODE_ENV=development (SPEC §20).
          // eslint-disable-next-line @typescript-eslint/no-deprecated -- deprecated only as a warning sign; development issuers
          ...(insecure ? { execute: [client.allowInsecureRequests] } : {}),
        },
      );
    } catch (error) {
      throw new OidcFailure('discovery_failed', codeOf(error));
    }
    configuration.timeout = OIDC_PROVIDER_TIMEOUT_SECONDS;
    this.configurations.set(provider.slug, { configuration, fetchedAt: this.now() });
    // New metadata may name another `jwks_uri`.
    this.jwks.delete(provider.slug);
    return configuration;
  }

  /** The ID token is signed by a key of the provider's JWKS (reloaded once for an unknown `kid`). */
  private async verifySignature(
    provider: OidcProviderConfig,
    configuration: client.Configuration,
    idToken: string,
  ): Promise<void> {
    const header = jwsHeaderOf(idToken);
    if (header === undefined) throw new OidcFailure('signature_invalid', 'UNSUPPORTED_JWS');
    const cached = this.jwks.get(provider.slug);
    const fresh =
      cached !== undefined && this.now() - cached.fetchedAt < OIDC_METADATA_CACHE_SECONDS * 1000;
    let keys = candidateKeys(
      fresh ? cached.keys : await this.loadJwks(provider, configuration),
      header,
    );
    if (keys.length === 0 && fresh) {
      // Unknown `kid`: the provider may have rotated its keys.
      keys = candidateKeys(await this.loadJwks(provider, configuration), header);
    }
    if (keys.length === 0) throw new OidcFailure('signature_invalid', 'NO_MATCHING_KEY');
    if (!keys.some((key) => verifyJws(idToken, header, key))) {
      throw new OidcFailure('signature_invalid', 'BAD_SIGNATURE');
    }
  }

  private async loadJwks(
    provider: OidcProviderConfig,
    configuration: client.Configuration,
  ): Promise<readonly Jwk[]> {
    const pending = this.jwksLoads.get(provider.slug);
    if (pending !== undefined) return pending;
    const load = this.fetchJwks(configuration)
      .then((keys) => {
        this.jwks.set(provider.slug, { keys, fetchedAt: this.now() });
        return keys;
      })
      .finally(() => {
        this.jwksLoads.delete(provider.slug);
      });
    this.jwksLoads.set(provider.slug, load);
    return load;
  }

  private async fetchJwks(configuration: client.Configuration): Promise<readonly Jwk[]> {
    const uri = configuration.serverMetadata().jwks_uri;
    if (uri === undefined) throw new OidcFailure('jwks_failed', 'NO_JWKS_URI');
    const url = new URL(uri);
    const issuerInsecure = new URL(configuration.serverMetadata().issuer).protocol === 'http:';
    if (url.protocol !== 'https:' && !(issuerInsecure && url.protocol === 'http:')) {
      throw new OidcFailure('jwks_failed', 'INSECURE_JWKS_URI');
    }
    let body: unknown;
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/jwk-set+json, application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(OIDC_PROVIDER_TIMEOUT_SECONDS * 1000),
      });
      if (!response.ok) throw new OidcFailure('jwks_failed', `HTTP_${String(response.status)}`);
      body = JSON.parse(await readCappedText(response, MAX_JWKS_BYTES));
    } catch (error) {
      if (error instanceof OidcFailure) throw error;
      throw new OidcFailure('jwks_failed', codeOf(error));
    }
    const keys = (body as { keys?: unknown } | null)?.keys;
    if (!Array.isArray(keys)) throw new OidcFailure('jwks_failed', 'MALFORMED_JWKS');
    return keys.filter(isJwk);
  }
}
