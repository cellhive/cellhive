import { REALTIME_MAX_MESSAGE_BYTES } from '@cellhive/contracts';
import { Injectable } from '@nestjs/common';

/** Subscriptions one WebSocket connection may hold (CONTRACTS §7). */
export const MAX_SUBSCRIPTIONS_PER_CONNECTION = 50;
/** Open WebSocket connections per user on one api instance (CONTRACTS §7). */
export const MAX_CONNECTIONS_PER_USER = 10;
/** Interval of protocol pings; a connection that missed the previous pong is dropped. */
export const HEARTBEAT_INTERVAL_MS = 30_000;
/** Invalid messages tolerated on a connection before it is closed (1008). */
export const MAX_INVALID_MESSAGES = 10;
/** Client messages queued on a connection before it is closed (1008). */
export const MAX_PENDING_MESSAGES = 32;
/** Unsent bytes buffered for a slow client before it is dropped. */
export const MAX_BUFFERED_BYTES = 1024 * 1024;
/** How often an open connection re-validates its session (logout, expiry). */
export const SESSION_RECHECK_INTERVAL_MS = 5 * 60_000;
/** Open WebSocket connections per API token on one api instance (ADR-36 §2, CONTRACTS §26.5). */
export const MAX_CONNECTIONS_PER_API_TOKEN = 10;
/** How often connections opened with an API token re-validate it (expiry, ADR-36 §2). */
export const API_TOKEN_RECHECK_INTERVAL_MS = 60_000;
/**
 * `Retry-After` (seconds) of a handshake refused because the user or the
 * token already holds the maximum number of connections (CONTRACTS §1.1:
 * every `429` carries it). There is no window to wait for: a slot frees up
 * when a connection closes, so this is a polite pause before retrying.
 */
export const CONNECTION_LIMIT_RETRY_AFTER_SECONDS = 30;

/**
 * Limits of the WebSocket gateway (CONTRACTS §7). Plain fields, like
 * `ApiRateLimits`, so that tests and embedders can tune them; SPEC §20
 * keeps the environment variable list closed. `maxMessageBytes` and
 * `apiTokenRecheckIntervalMs` are read when the gateway starts; the others
 * on every use.
 */
@Injectable()
export class RealtimeLimits {
  maxSubscriptionsPerConnection = MAX_SUBSCRIPTIONS_PER_CONNECTION;
  maxConnectionsPerUser = MAX_CONNECTIONS_PER_USER;
  maxMessageBytes = REALTIME_MAX_MESSAGE_BYTES;
  heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS;
  maxInvalidMessages = MAX_INVALID_MESSAGES;
  maxPendingMessages = MAX_PENDING_MESSAGES;
  maxBufferedBytes = MAX_BUFFERED_BYTES;
  sessionRecheckIntervalMs = SESSION_RECHECK_INTERVAL_MS;
  maxConnectionsPerApiToken = MAX_CONNECTIONS_PER_API_TOKEN;
  apiTokenRecheckIntervalMs = API_TOKEN_RECHECK_INTERVAL_MS;
  connectionLimitRetryAfterSeconds = CONNECTION_LIMIT_RETRY_AFTER_SECONDS;
}
