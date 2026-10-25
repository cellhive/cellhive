import { Buffer } from 'node:buffer';

import {
  INSUFFICIENT_SCOPE,
  parseRealtimeChannel,
  parseRealtimeClientMessage,
  REALTIME_CLOSE_CODES,
  REALTIME_PATH,
  SESSION_COOKIE,
  type Id,
  type RealtimeChannel,
  type RealtimeSubscribeView,
} from '@cellhive/contracts';
import { AppError, isAppError } from '@cellhive/server-core/errors';
import {
  Inject,
  Injectable,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';

import {
  ApiTokenAuthService,
  BEARER_CHALLENGE,
  bearerTokenOf,
} from '../../common/auth/api-token-auth.service.js';
import { parseCookies } from '../../common/auth/cookies.js';
import { SessionService } from '../../common/auth/session.service.js';
import { AppLogger } from '../../common/logging/app-logger.js';
import { ApiRateLimits } from '../../common/rate-limit/api-rate-limits.js';
import { APP_CONFIG } from '../../common/tokens.js';

import { RealtimeBusSubscriber } from './bus-subscriber.js';
import { ChannelAuthorizer, type ChannelGrant } from './channel-authorizer.js';
import { RealtimeConnection, type Subscription } from './realtime-connection.js';
import { RealtimeLimits } from './realtime-limits.js';
import { RealtimeRouter } from './realtime-router.js';
import { SubscriptionRegistry } from './subscription-registry.js';
import {
  allowedOrigins,
  clientIpOf,
  originAllowed,
  pathOf,
  rejectUpgrade,
  trustedProxyList,
} from './upgrade.js';

import type { ApiTokenPrincipal, Principal } from '../../common/auth/principal.js';
import type {
  ApiTokenRevokedEnvelope,
  AppConfig,
  SessionRevokedEnvelope,
} from '@cellhive/server-core';
import type { IncomingMessage, Server } from 'node:http';
import type { BlockList } from 'node:net';
import type { Duplex } from 'node:stream';

/** Time given to clients to complete the close handshake on shutdown. */
const SHUTDOWN_GRACE_MS = 1_000;

/** The scope a token needs for `base:` and `table:` channels (ADR-36 §2). */
const CHANNEL_SCOPE = 'records:read';

/**
 * Token checks of one handshake while revocations of its organization keep
 * arriving; past that the handshake is refused (`503`) and the client retries.
 */
const MAX_HANDSHAKE_RECHECKS = 5;

/** Open connections per authentication kind (`ws_connections{auth}`). */
export interface ConnectionCounts {
  readonly session: number;
  readonly api_token: number;
}

/**
 * The WebSocket endpoint `/ws` (SPEC §15, CONTRACTS §7, §26.5), on the HTTP
 * server of the API (same port, same Fastify instance).
 *
 * Handshake, two branches:
 * - `Authorization` present (ADR-36 §2): authenticated by that header only,
 *   with the resolver of HTTP requests (`ApiTokenAuthService`) and the same
 *   per-IP limit on failed attempts; a refusal is `401` with
 *   `WWW-Authenticate: Bearer error="invalid_token"`. No `Origin` check
 *   (browsers cannot set this header on a WebSocket) and the cookie is not
 *   read. A token may hold `maxConnectionsPerApiToken` connections on this
 *   instance (`429`).
 * - otherwise `Origin` must be an allowed origin (`403`), the session cookie
 *   must be valid (`401`), and a user may hold `maxConnectionsPerUser`
 *   connections on this instance (`429`). No CSRF token: the Origin check
 *   replaces it.
 * Refusals are HTTP responses with a problem+json body.
 *
 * Protocol: `subscribe` (access checked, `NOT_FOUND` when not readable;
 * a token needs `records:read`, else `INSUFFICIENT_SCOPE`, and has no
 * `user:` channel), `unsubscribe`, `ping`; invalid messages get
 * `error VALIDATION_FAILED` and too many of them close the connection
 * (1008), as does a message over the size limit (1009). Protocol pings
 * detect dead peers; sessions are re-validated periodically and API tokens
 * every `apiTokenRecheckIntervalMs`, on `permission.changed` and on
 * `api_token.revoked` (4401 when they ended).
 */
@Injectable()
export class RealtimeGateway implements OnApplicationBootstrap, BeforeApplicationShutdown {
  readonly #connections = new Set<RealtimeConnection>();
  readonly #perUser = new Map<string, number>();
  readonly #perToken = new Map<Id<'tok'>, number>();
  readonly #origins: ReadonlySet<string>;
  readonly #proxies: BlockList;
  #server: Server | undefined;
  #wss: WebSocketServer | undefined;
  #heartbeat: NodeJS.Timeout | undefined;
  #tokenRecheck: NodeJS.Timeout | undefined;
  /** `api_token.revoked` envelopes received so far (handshakes in flight compare it). */
  #revocations = 0;
  /** The same, per organization. */
  readonly #orgRevocations = new Map<Id<'org'>, number>();
  /** Token checks in flight: one per token however many connections it has. */
  readonly #tokenChecks = new Map<Id<'tok'>, Promise<boolean>>();
  #closing = false;

  constructor(
    @Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost,
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(ApiTokenAuthService) private readonly apiTokens: ApiTokenAuthService,
    @Inject(ApiRateLimits) private readonly rateLimits: ApiRateLimits,
    @Inject(RealtimeLimits) private readonly limits: RealtimeLimits,
    @Inject(ChannelAuthorizer) private readonly authorizer: ChannelAuthorizer,
    @Inject(SubscriptionRegistry) private readonly registry: SubscriptionRegistry,
    @Inject(RealtimeRouter) private readonly router: RealtimeRouter,
    @Inject(RealtimeBusSubscriber) private readonly bus: RealtimeBusSubscriber,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {
    this.#origins = allowedOrigins(config);
    this.#proxies = trustedProxyList(config.security.trustedProxies);
    router.onApiTokenRevoked((envelope) => {
      this.closeRevoked(envelope);
    });
    router.onSessionRevoked((envelope) => {
      this.closeEndedSessions(envelope);
    });
    router.setCredentialCheck((connection) => this.checkApiToken(connection));
  }

  /** Open connections on this instance. */
  get connections(): number {
    return this.#connections.size;
  }

  /** Open connections on this instance by how they authenticated. */
  connectionCounts(): ConnectionCounts {
    let tokens = 0;
    for (const connection of this.#connections) {
      if (connection.auth === 'api_token') tokens += 1;
    }
    return { session: this.#connections.size - tokens, api_token: tokens };
  }

  /** Shutting down: no new connections (a method, so checks after `await` are not narrowed away). */
  private isClosing(): boolean {
    return this.#closing;
  }

  onApplicationBootstrap(): void {
    // An application context without HTTP (seed, CLI) serves no WebSocket.
    const adapter = this.adapterHost.httpAdapter as HttpAdapterHost['httpAdapter'] | null;
    if (adapter === null) return;
    this.#wss = new WebSocketServer({
      noServer: true,
      maxPayload: this.limits.maxMessageBytes,
      perMessageDeflate: false,
      clientTracking: false,
    });
    this.#server = adapter.getHttpServer() as Server;
    this.#server.on('upgrade', this.onUpgrade);
    this.#heartbeat = setInterval(() => {
      this.heartbeat();
    }, this.limits.heartbeatIntervalMs);
    this.#heartbeat.unref();
    this.#tokenRecheck = setInterval(() => {
      void this.recheckApiTokens();
    }, this.limits.apiTokenRecheckIntervalMs);
    this.#tokenRecheck.unref();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.#closing = true;
    this.#server?.off('upgrade', this.onUpgrade);
    if (this.#heartbeat !== undefined) clearInterval(this.#heartbeat);
    if (this.#tokenRecheck !== undefined) clearInterval(this.#tokenRecheck);
    const open = [...this.#connections];
    for (const connection of open) {
      connection.close(REALTIME_CLOSE_CODES.goingAway, 'server shutting down');
    }
    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    while (this.#connections.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    for (const connection of this.#connections) connection.terminate();
    this.#wss?.close();
  }

  // -------------------------------------------------------------------------
  // Handshake

  private readonly onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    // The socket may fail while the session is looked up.
    socket.on('error', () => undefined);
    this.upgrade(request, socket, head).catch((err: unknown) => {
      this.logger.error({ err }, 'websocket upgrade failed');
      rejectUpgrade(socket, 'DEPENDENCY_UNAVAILABLE');
    });
  };

  private async upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (pathOf(request.url) !== REALTIME_PATH) {
      rejectUpgrade(socket, 'NOT_FOUND');
      return;
    }
    if (this.isClosing()) {
      rejectUpgrade(socket, 'DEPENDENCY_UNAVAILABLE');
      return;
    }
    // Bearer wins over the cookie, without falling back to it (ADR-36 §1, §2).
    const authorization = request.headers.authorization;
    if (authorization !== undefined) {
      await this.upgradeWithApiToken(request, socket, head, authorization);
      return;
    }
    if (!originAllowed(request.headers.origin, this.#origins)) {
      this.logger.debug({ reason: 'origin' }, 'websocket handshake refused');
      rejectUpgrade(socket, 'PERMISSION_DENIED');
      return;
    }
    const token = parseCookies(request.headers.cookie).get(SESSION_COOKIE);
    const resolved = token === undefined ? undefined : await this.sessions.resolve(token);
    if (token === undefined || resolved === undefined) {
      rejectUpgrade(socket, 'UNAUTHENTICATED');
      return;
    }
    const principal = resolved.principal;
    if ((this.#perUser.get(principal.userId) ?? 0) >= this.limits.maxConnectionsPerUser) {
      this.logger.debug({ user_id: principal.userId }, 'websocket connection limit reached');
      rejectUpgrade(socket, 'RATE_LIMITED', {
        retryAfterSeconds: this.limits.connectionLimitRetryAfterSeconds,
      });
      return;
    }
    const wss = this.#wss;
    if (socket.destroyed || wss === undefined || this.isClosing()) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      this.accept(ws, principal, token);
    });
  }

  /**
   * The Bearer branch (ADR-36 §2, CONTRACTS §7): same resolver, same codes
   * and same per-IP limit on failures as HTTP requests (`AuthGuard`). The
   * connection listens to its organization's bus from the start, so that
   * `api_token.revoked` reaches it even without a subscription.
   */
  private async upgradeWithApiToken(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    authorization: string,
  ): Promise<void> {
    const ip = clientIpOf(request, this.#proxies) ?? 'unknown';
    try {
      await this.rateLimits.ensureBearerAttemptAllowed(ip, bearerTokenOf(authorization));
    } catch (error) {
      if (!isAppError(error)) throw error;
      this.refuse(socket, error);
      return;
    }
    const revocations = this.#revocations;
    let token: string;
    let principal: ApiTokenPrincipal;
    try {
      const value = bearerTokenOf(authorization);
      if (value === undefined) {
        throw new AppError('UNAUTHENTICATED', {
          detail: 'Use "Authorization: Bearer <API token>".',
        });
      }
      token = value;
      principal = await this.apiTokens.authenticate(token);
      await this.rateLimits.rememberValidBearer(token);
    } catch (error) {
      if (!isAppError(error)) throw error;
      let refusal = error;
      if (error.status === 401) {
        try {
          // Counts the failure; the one that crosses the limit is already `429`.
          await this.rateLimits.hitBearerFailure(ip);
        } catch (limited) {
          if (!isAppError(limited)) throw limited;
          refusal = limited;
        }
      }
      this.refuse(socket, refusal, error.status === 401 ? BEARER_CHALLENGE : undefined);
      return;
    }

    const organizationId = principal.organizationId;
    let started: boolean;
    try {
      started = await this.bus.acquire(organizationId);
    } catch (err) {
      this.logger.warn({ err, token_id: principal.tokenId }, 'realtime bus subscribe failed');
      rejectUpgrade(socket, 'DEPENDENCY_UNAVAILABLE');
      return;
    }
    // A revocation published while the token was checked was not heard if
    // this instance was not yet listening to the organization (or was heard
    // before the connection existed): check the token again, until no
    // revocation of the organization arrived during the check.
    // (The organization is known only after the first check: compare all
    // revocations for that one, the organization's afterwards.)
    let seen: number;
    let recheck = started || this.#revocations !== revocations;
    for (let attempt = 0; recheck; attempt += 1) {
      if (attempt >= MAX_HANDSHAKE_RECHECKS) {
        this.bus.release(organizationId);
        rejectUpgrade(socket, 'DEPENDENCY_UNAVAILABLE');
        return;
      }
      seen = this.revocationsOf(organizationId);
      try {
        principal = await this.apiTokens.authenticate(token);
      } catch (error) {
        this.bus.release(organizationId);
        if (!isAppError(error)) throw error;
        this.refuse(socket, error, error.status === 401 ? BEARER_CHALLENGE : undefined);
        return;
      }
      recheck = this.revocationsOf(organizationId) !== seen;
    }
    // From here on everything is synchronous: the limit check and the
    // connection being counted (in `accept`) cannot interleave with another
    // handshake of the same token.
    // An object: the flag is set in a callback, which flow analysis does not follow.
    const handshake = { accepted: false };
    try {
      if ((this.#perToken.get(principal.tokenId) ?? 0) >= this.limits.maxConnectionsPerApiToken) {
        this.logger.debug({ token_id: principal.tokenId }, 'websocket connection limit reached');
        rejectUpgrade(socket, 'RATE_LIMITED', {
          retryAfterSeconds: this.limits.connectionLimitRetryAfterSeconds,
        });
        return;
      }
      const wss = this.#wss;
      if (socket.destroyed || wss === undefined || this.isClosing()) {
        socket.destroy();
        return;
      }
      // `ws` completes the upgrade (or aborts it) before returning.
      wss.handleUpgrade(request, socket, head, (ws) => {
        handshake.accepted = true;
        this.accept(ws, principal, token);
      });
    } finally {
      // The connection holds the listener until it closes (`release`).
      if (!handshake.accepted) this.bus.release(organizationId);
    }
  }

  /** Refuses the handshake with the code of `error` (never the token itself). */
  private refuse(socket: Duplex, error: AppError, wwwAuthenticate?: string): void {
    this.logger.debug({ reason: error.code }, 'websocket handshake refused');
    rejectUpgrade(socket, error.code, {
      detail: error.detail,
      retryAfterSeconds: error.retryAfterSeconds,
      wwwAuthenticate,
    });
  }

  private accept(ws: WebSocket, principal: Principal, credential: string): void {
    const connection = new RealtimeConnection(
      ws,
      principal,
      credential,
      () => this.limits.maxBufferedBytes,
    );
    this.#connections.add(connection);
    if (principal.kind === 'api_token') {
      this.#perToken.set(principal.tokenId, (this.#perToken.get(principal.tokenId) ?? 0) + 1);
    } else {
      this.#perUser.set(principal.userId, (this.#perUser.get(principal.userId) ?? 0) + 1);
    }
    this.logger.debug(
      {
        user_id: principal.userId,
        connection_id: connection.id,
        auth: connection.auth,
        ...(connection.tokenId === null ? {} : { token_id: connection.tokenId }),
      },
      'websocket connected',
    );
    ws.on('message', (data, isBinary) => {
      this.onMessage(connection, data, isBinary);
    });
    ws.on('pong', () => {
      connection.alive = true;
    });
    ws.on('error', (err) => {
      // e.g. a frame over maxPayload; ws closes the connection itself (1009).
      this.logger.debug({ err, connection_id: connection.id }, 'websocket error');
    });
    ws.on('close', () => {
      this.release(connection);
    });
  }

  private release(connection: RealtimeConnection): void {
    connection.markClosed();
    if (!this.#connections.delete(connection)) return;
    for (const subscription of [...connection.subscriptions.values()]) {
      this.registry.remove(subscription);
    }
    const principal = connection.principal;
    if (principal.kind === 'api_token') {
      const remaining = (this.#perToken.get(principal.tokenId) ?? 1) - 1;
      if (remaining <= 0) this.#perToken.delete(principal.tokenId);
      else this.#perToken.set(principal.tokenId, remaining);
      this.bus.release(principal.organizationId);
    } else {
      const remaining = (this.#perUser.get(connection.userId) ?? 1) - 1;
      if (remaining <= 0) this.#perUser.delete(connection.userId);
      else this.#perUser.set(connection.userId, remaining);
    }
    this.logger.debug(
      { user_id: connection.userId, connection_id: connection.id },
      'websocket closed',
    );
  }

  // -------------------------------------------------------------------------
  // Client messages

  private onMessage(connection: RealtimeConnection, data: RawData, isBinary: boolean): void {
    connection.alive = true;
    if (connection.pending >= this.limits.maxPendingMessages) {
      connection.close(REALTIME_CLOSE_CODES.policyViolation, 'too many messages in flight');
      return;
    }
    const text = isBinary ? undefined : rawText(data);
    connection.enqueue(() => this.handle(connection, text));
  }

  private async handle(connection: RealtimeConnection, text: string | undefined): Promise<void> {
    if (connection.isClosed()) return;
    const parsed =
      text === undefined
        ? {
            ok: false as const,
            reqId: null,
            errors: [{ path: '', code: 'BINARY_FRAME', message: 'Send JSON text frames.' }],
          }
        : parseRealtimeClientMessage(text);
    if (!parsed.ok) {
      connection.invalidMessages += 1;
      connection.send({
        type: 'error',
        req_id: parsed.reqId,
        code: 'VALIDATION_FAILED',
        errors: parsed.errors,
      });
      if (connection.invalidMessages >= this.limits.maxInvalidMessages) {
        connection.close(REALTIME_CLOSE_CODES.policyViolation, 'too many invalid messages');
      }
      return;
    }
    const message = parsed.message;
    switch (message.type) {
      case 'ping':
        connection.send(
          message.req_id === undefined
            ? { type: 'pong' }
            : { type: 'pong', req_id: message.req_id },
        );
        return;
      case 'unsubscribe': {
        const subscription = connection.subscriptions.get(message.channel);
        if (subscription !== undefined) this.registry.remove(subscription);
        return;
      }
      case 'subscribe':
        await this.subscribe(connection, message.channel, message.req_id, message.view ?? null);
        return;
    }
  }

  private async subscribe(
    connection: RealtimeConnection,
    channel: string,
    reqId: string,
    view: RealtimeSubscribeView | null,
  ): Promise<void> {
    // The schema only accepts valid channels.
    const target = parseRealtimeChannel(channel) as RealtimeChannel;
    const existing = connection.subscriptions.get(channel);
    const limit = this.limits.maxSubscriptionsPerConnection;
    if (existing === undefined && connection.subscriptions.size >= limit) {
      connection.send({
        type: 'error',
        req_id: reqId,
        code: 'VALIDATION_FAILED',
        channel,
        errors: [
          {
            path: 'channel',
            code: 'TOO_MANY_SUBSCRIPTIONS',
            message: `A connection can hold at most ${String(limit)} subscriptions.`,
            params: { limit },
          },
        ],
      });
      return;
    }
    // An API token has no `user:` channel (ADR-36 §2): like a channel that does not exist.
    if (connection.auth === 'api_token' && target.kind === 'user') {
      connection.send({ type: 'error', req_id: reqId, code: 'NOT_FOUND', channel });
      return;
    }

    const epoch = this.router.permissionEpoch;
    const grant = await this.grant(connection, target, reqId, channel, view);
    if (grant === null) return;
    // Reachable but not allowed by the token's scopes (checked after the
    // 404 cases, like `ScopeGuard`, so the error tells nothing about bases
    // outside the token's reach).
    if (grant !== undefined && !this.scopeAllows(connection)) {
      if (existing !== undefined) this.registry.remove(existing);
      connection.send({
        type: 'error',
        req_id: reqId,
        code: 'INSUFFICIENT_SCOPE',
        channel,
        errors: [
          {
            path: '',
            code: INSUFFICIENT_SCOPE,
            message: 'The API token does not allow this channel',
            params: { required: [CHANNEL_SCOPE] },
          },
        ],
      });
      return;
    }
    if (grant === undefined || grant.view === 'not_found') {
      if (existing !== undefined) this.registry.remove(existing);
      connection.send({
        type: 'error',
        req_id: reqId,
        code: 'NOT_FOUND',
        channel,
        // The table is readable, the view is not (T313): the client opens another view.
        ...(grant === undefined || view === null ? {} : { view_id: view.id }),
      });
      return;
    }
    if (connection.isClosed()) return;

    if (
      existing !== undefined &&
      this.registry.has(existing) &&
      !sameOrganizations(existing.orgIds, grant.orgIds)
    ) {
      // The channel's organizations changed (`user:`): registered anew below.
      this.registry.remove(existing);
    }
    if (existing !== undefined && this.registry.has(existing)) {
      // Subscribing again replaces the view (T313): one scope per channel and connection.
      existing.previousBase = existing.base;
      existing.base = grant.base;
      existing.variables = grant.variables;
      existing.view = grant.view;
      existing.tables = grant.tables;
      existing.viewRequest = view;
      // A permission change handled while the grant was computed may have
      // narrowed this subscription already: the grant may be stale, check again.
      if (this.router.permissionEpoch !== epoch) {
        await this.router.recheckConnection(connection, [existing], { notify: false });
        if (!this.registry.has(existing)) return;
      }
      connection.send({ type: 'subscribed', req_id: reqId, channel });
      return;
    }

    const subscription: Subscription = {
      connection,
      channel,
      target,
      userId: connection.userId,
      connectionId: connection.id,
      orgIds: grant.orgIds,
      baseId: grant.baseId,
      base: grant.base,
      previousBase: null,
      variables: grant.variables,
      view: grant.view,
      tables: grant.tables,
      viewRequest: view,
    };
    let started: boolean;
    try {
      started = await this.registry.add(subscription);
    } catch (err) {
      this.logger.warn({ err, user_id: connection.userId }, 'realtime bus subscribe failed');
      connection.send({ type: 'error', req_id: reqId, code: 'DEPENDENCY_UNAVAILABLE', channel });
      return;
    }
    if (connection.isClosed()) {
      this.registry.remove(subscription);
      return;
    }
    // A permission change may have been missed between the check above and
    // the moment messages of the organization started to arrive: check again.
    if (started || this.router.permissionEpoch !== epoch) {
      await this.router.recheckConnection(connection, [subscription], { notify: false });
      if (!this.registry.has(subscription)) return;
    }
    connection.send({ type: 'subscribed', req_id: reqId, channel });
  }

  /** Sessions read every channel they can see; a token needs `records:read`. */
  private scopeAllows(connection: RealtimeConnection): boolean {
    const principal = connection.principal;
    return principal.kind !== 'api_token' || principal.scopes.includes(CHANNEL_SCOPE);
  }

  /** The grant for a channel; `null` when the check failed (error already sent). */
  private async grant(
    connection: RealtimeConnection,
    target: RealtimeChannel,
    reqId: string,
    channel: string,
    view: RealtimeSubscribeView | null,
  ): Promise<ChannelGrant | undefined | null> {
    try {
      return await this.authorizer.authorize(connection.freshPrincipal(), target, view);
    } catch (err) {
      this.logger.warn({ err, user_id: connection.userId }, 'realtime access check failed');
      connection.send({ type: 'error', req_id: reqId, code: 'DEPENDENCY_UNAVAILABLE', channel });
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Heartbeat, session and API token

  /**
   * One heartbeat tick (run every `heartbeatIntervalMs`): drops connections
   * that did not answer the previous ping, pings the others and re-validates
   * sessions that are due. Public so that tests can tick without waiting.
   */
  heartbeat(): void {
    const now = Date.now();
    for (const connection of this.#connections) {
      if (!connection.alive) {
        connection.terminate();
        continue;
      }
      connection.alive = false;
      connection.ping();
      if (
        connection.auth === 'session' &&
        now - connection.sessionCheckedAt >= this.limits.sessionRecheckIntervalMs
      ) {
        connection.sessionCheckedAt = now;
        void this.checkSession(connection);
      }
    }
  }

  /**
   * Re-validates every connection opened with an API token (run every
   * `apiTokenRecheckIntervalMs`, ADR-36 §2): expired, revoked, policy off,
   * user gone → closed with 4401. Public so that tests can tick without
   * waiting. Resolves once every check is done.
   */
  async recheckApiTokens(): Promise<void> {
    const checks: Promise<boolean>[] = [];
    for (const connection of this.#connections) {
      // One database check per token (`tokenStillValid` shares it).
      if (connection.auth === 'api_token') checks.push(this.checkApiToken(connection));
    }
    await Promise.all(checks);
  }

  private async checkSession(connection: RealtimeConnection): Promise<void> {
    try {
      // An open socket is not activity: the check never slides the expiry.
      const resolved = await this.sessions.resolve(connection.credential, { touch: false });
      if (resolved === undefined || resolved.principal.userId !== connection.userId) {
        connection.close(REALTIME_CLOSE_CODES.unauthenticated, 'session ended');
      }
    } catch (err) {
      // Keep the connection: the database is only unavailable for now.
      this.logger.warn({ err, user_id: connection.userId }, 'websocket session check failed');
    }
  }

  /** Whether the connection's API token still authenticates; closes it (4401) if not. */
  private async checkApiToken(connection: RealtimeConnection): Promise<boolean> {
    const principal = connection.principal;
    if (connection.isClosed() || principal.kind !== 'api_token') return false;
    if (await this.tokenStillValid(principal, connection.credential)) return true;
    connection.close(REALTIME_CLOSE_CODES.unauthenticated, 'api token no longer valid');
    return false;
  }

  /**
   * Whether the token still authenticates as the same user. Checks running
   * at the same time for one token (its connections in one tick or one
   * `permission.changed`) share one database read. A database error keeps
   * the connections (`true`): it is only unavailable for now.
   */
  private tokenStillValid(principal: ApiTokenPrincipal, credential: string): Promise<boolean> {
    const pending = this.#tokenChecks.get(principal.tokenId);
    if (pending !== undefined) return pending;
    const check = (async () => {
      try {
        const current = await this.apiTokens.authenticate(credential);
        return current.tokenId === principal.tokenId && current.userId === principal.userId;
      } catch (error) {
        if (isAppError(error) && error.status === 401) return false;
        this.logger.warn(
          { err: error, token_id: principal.tokenId },
          'websocket api token check failed',
        );
        return true;
      }
    })().finally(() => {
      this.#tokenChecks.delete(principal.tokenId);
    });
    this.#tokenChecks.set(principal.tokenId, check);
    return check;
  }

  /**
   * `session.revoked`: closes the connections opened with those sessions
   * on this instance (4401), without waiting for the periodic check.
   */
  private closeEndedSessions(envelope: SessionRevokedEnvelope): void {
    const sessionIds =
      envelope.session_ids === undefined ? undefined : new Set<string>(envelope.session_ids);
    for (const connection of this.#connections) {
      const principal = connection.principal;
      if (principal.kind !== 'session' || principal.userId !== envelope.user_id) continue;
      if (sessionIds !== undefined && !sessionIds.has(principal.session.id)) continue;
      this.logger.debug(
        { user_id: principal.userId, connection_id: connection.id },
        'websocket closed: session ended',
      );
      connection.close(REALTIME_CLOSE_CODES.unauthenticated, 'session ended');
    }
  }

  /** `api_token.revoked` envelopes of `organizationId` received so far. */
  private revocationsOf(organizationId: Id<'org'>): number {
    return this.#orgRevocations.get(organizationId) ?? 0;
  }

  /** `api_token.revoked` (T703): closes the connections of those tokens on this instance. */
  private closeRevoked(envelope: ApiTokenRevokedEnvelope): void {
    this.#revocations += 1;
    this.#orgRevocations.set(
      envelope.organization_id,
      this.revocationsOf(envelope.organization_id) + 1,
    );
    const tokenIds = envelope.token_ids === undefined ? undefined : new Set(envelope.token_ids);
    for (const connection of this.#connections) {
      const principal = connection.principal;
      if (principal.kind !== 'api_token') continue;
      if (principal.organizationId !== envelope.organization_id) continue;
      if (tokenIds !== undefined && !tokenIds.has(principal.tokenId)) continue;
      this.logger.debug(
        { token_id: principal.tokenId, connection_id: connection.id },
        'websocket closed: api token revoked',
      );
      connection.close(REALTIME_CLOSE_CODES.unauthenticated, 'api token revoked');
    }
  }
}

/** Whether two lists name the same organizations. */
function sameOrganizations(a: readonly Id<'org'>[], b: readonly Id<'org'>[]): boolean {
  const set = new Set(a);
  return set.size === new Set(b).size && b.every((id) => set.has(id));
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}
