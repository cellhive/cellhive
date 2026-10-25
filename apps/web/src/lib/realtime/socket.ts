import {
  REALTIME_CLOSE_CODES,
  REALTIME_PATH,
  realtimeServerMessageSchema,
  type ErrorCode,
  type RealtimeServerMessage,
  type RealtimeSubscribeView,
} from '@cellhive/contracts';

import { devWarn } from '../dev-log';

import { setRealtimeSessionEnder } from './session-end';
import { realtimeStatus, type RealtimeConnection } from './status';

/**
 * The realtime client of the app (FRONTEND §5, CONTRACTS §7): one WebSocket
 * per tab on the same origin (`/ws`, the session cookie authenticates it),
 * shared by every screen through ref-counted channel subscriptions.
 *
 * - Server messages are validated with the contracts' zod schema; invalid
 *   ones are dropped (and reported in development).
 * - `subscribe` requests carry a request id; the `subscribed` / `error`
 *   answer is matched to it.
 * - The connection is kept alive by a JSON `ping` when nothing was heard for
 *   a while; no answer closes it (a dead TCP connection is not always
 *   noticed by the browser).
 * - A lost connection is re-opened with exponential backoff and jitter
 *   (1 s → 30 s, ±20 %); after that every channel is subscribed again and
 *   the reconnect listeners refetch what the screens show (messages missed
 *   meanwhile are lost: realtime is best effort).
 * - `4401` (session ended) never reconnects: the app signs in again —
 *   unless this tab is signing out itself (`endSession`): the server closes
 *   the socket of the ended session at once, and that close must not race
 *   the sign-out's own navigation with a `?next=` sign-in.
 *   `1008` / `1009` (policy, too big) are logged and reconnect with a longer
 *   backoff, so a client that keeps breaking the protocol cannot loop fast.
 */

/** The subset of the browser `WebSocket` the client uses (tests pass a fake). */
export interface SocketLike {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
}

export type SocketFactory = (url: string) => SocketLike;

/** `WebSocket.OPEN`, without depending on the global in tests. */
const OPEN = 1;

/** First reconnect delay; doubled on each failed attempt (FRONTEND §5). */
export const RECONNECT_BASE_MS = 1000;
/** Longest reconnect delay (FRONTEND §5). */
export const RECONNECT_MAX_MS = 30_000;
/** Jitter applied to each delay: ±20 % (FRONTEND §5). */
export const RECONNECT_JITTER = 0.2;
/** A JSON `ping` is sent after this long without any message from the server. */
export const HEARTBEAT_INTERVAL_MS = 25_000;
/** No answer to the `ping` this long after it was sent: the connection is dead. */
export const HEARTBEAT_TIMEOUT_MS = 10_000;
/** A connection open this long clears the penalty of earlier policy closes. */
export const POLICY_RESET_MS = 60_000;
/** The socket closes this long after the last channel was released. */
export const IDLE_CLOSE_MS = 2000;
/** Code of the closes the client initiates (heartbeat timeout, offline). */
const CLIENT_CLOSE_CODE = 4000;

/**
 * Delay before reconnect attempt `attempt` (0-based): `1 s · 2^attempt`
 * capped at 30 s, times a random factor in [0.8, 1.2), never above 30 s.
 */
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.max(0, attempt));
  const jittered = base * (1 - RECONNECT_JITTER + 2 * RECONNECT_JITTER * random());
  return Math.round(Math.min(RECONNECT_MAX_MS, jittered));
}

/** A message addressed to a channel (records, schema, permissions, jobs). */
export type ChannelMessage = Exclude<
  RealtimeServerMessage,
  { type: 'subscribed' | 'error' | 'pong' }
>;

export interface ChannelErrorDetail {
  /**
   * `NOT_FOUND` about the view of a `table:` subscription (T313): the view
   * is gone or hidden; the channel was subscribed again without it.
   */
  readonly viewId?: string;
}

export interface ChannelHandlers {
  readonly onMessage?: (message: ChannelMessage) => void;
  /**
   * The server refused or removed the subscription (`NOT_FOUND`: no access
   * any more; `DEPENDENCY_UNAVAILABLE` is retried by the client itself).
   */
  readonly onError?: (code: ErrorCode, detail: ChannelErrorDetail) => void;
  /**
   * The view open on screen (`table:` channels, T313, CONTRACTS §7): record
   * messages then follow its saved filter. One server subscription per
   * channel: the view of the latest registration that has one is used.
   */
  readonly view?: RealtimeSubscribeView | null;
}

/** Releases a registration; `setView` changes its view without a gap. */
export type ChannelRelease = (() => void) & {
  readonly setView: (view: RealtimeSubscribeView | null) => void;
};

interface ChannelEntry {
  readonly handlers: Set<ChannelHandlers>;
  /** Views of the registrations that have one, in registration order. */
  readonly views: Map<ChannelHandlers, RealtimeSubscribeView>;
  /** The view refused by the server (`NOT_FOUND` naming it): not asked again. */
  refusedViewId: string | null;
  /** Key of the view sent with the last `subscribe` (`''` = none). */
  sentView: string;
  /** Request id of the `subscribe` waiting for its answer. */
  pending: string | null;
  subscribed: boolean;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
}

function viewKey(view: RealtimeSubscribeView | null): string {
  return view === null ? '' : `${view.id}:${view.filter_mode ?? 'and'}`;
}

/** The view a channel is subscribed with: the latest registration's, unless refused. */
function effectiveView(entry: ChannelEntry): RealtimeSubscribeView | null {
  let found: RealtimeSubscribeView | null = null;
  for (const view of entry.views.values()) {
    if (view.id !== entry.refusedViewId) found = view;
  }
  return found;
}

export interface RealtimeClientOptions {
  /** WebSocket URL; default: `ws(s)://<this origin>/ws`. */
  readonly url?: string;
  readonly createSocket?: SocketFactory;
  readonly random?: () => number;
  readonly now?: () => number;
  /** The session ended (`4401`): the app signs in again. */
  readonly onSessionExpired?: () => void;
  /** Receives the connection state (default: the app-wide status store of the banner). */
  readonly onStatus?: (status: RealtimeConnection) => void;
  /** Watches `online`/`offline` of the window (default: when a window exists). */
  readonly watchNetwork?: boolean;
}

function defaultUrl(): string {
  const { protocol, host } = window.location;
  return `${protocol === 'https:' ? 'wss:' : 'ws:'}//${host}${REALTIME_PATH}`;
}

function defaultSocket(url: string): SocketLike {
  return new WebSocket(url) as unknown as SocketLike;
}

function isChannelMessage(message: RealtimeServerMessage): message is ChannelMessage {
  return message.type !== 'subscribed' && message.type !== 'error' && message.type !== 'pong';
}

export class RealtimeClient {
  readonly #options: RealtimeClientOptions;
  readonly #channels = new Map<string, ChannelEntry>();
  readonly #reconnectListeners = new Set<() => void>();
  #socket: SocketLike | null = null;
  /** The socket opened at least once: the next open is a reconnect. */
  #wasOpen = false;
  #attempt = 0;
  #policyStrikes = 0;
  #requestSeq = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  #pingTimeout: ReturnType<typeof setTimeout> | undefined;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  #stableTimer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;
  /** This tab signed out (`endSession`): never connects again, a `4401` is expected. */
  #sessionEnded = false;
  #unwatchNetwork: (() => void) | null = null;
  #status: RealtimeConnection = { status: 'idle' };

  constructor(options: RealtimeClientOptions = {}) {
    this.#options = options;
  }

  get status(): RealtimeConnection {
    return this.#status;
  }

  /** Channels with at least one subscriber (tests, debugging). */
  channels(): string[] {
    return [...this.#channels.keys()];
  }

  /** Whether the server confirmed the subscription of `channel`. */
  isSubscribed(channel: string): boolean {
    return this.#channels.get(channel)?.subscribed === true;
  }

  /**
   * Subscribes to `channel` for as long as the returned function is not
   * called. Several subscribers of one channel share one server
   * subscription; the last one to leave unsubscribes it.
   */
  subscribe(channel: string, handlers: ChannelHandlers): ChannelRelease {
    this.#stopped = false;
    clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
    // One registration per call, even when the same handlers object is passed twice.
    const registration: ChannelHandlers = { ...handlers };
    let entry = this.#channels.get(channel);
    const created = entry === undefined;
    if (entry === undefined) {
      entry = {
        handlers: new Set(),
        views: new Map(),
        refusedViewId: null,
        sentView: '',
        pending: null,
        subscribed: false,
        retryTimer: undefined,
      };
      this.#channels.set(channel, entry);
    }
    entry.handlers.add(registration);
    if (handlers.view !== undefined && handlers.view !== null) {
      entry.views.set(registration, handlers.view);
    }
    if (created) this.#sendSubscribe(channel, entry);
    else this.#viewChanged(channel, entry);
    this.#ensureConnected();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.#release(channel, registration);
    };
    return Object.assign(release, {
      setView: (view: RealtimeSubscribeView | null) => {
        const current = this.#channels.get(channel);
        if (released || current === undefined) return;
        if (viewKey(view) === viewKey(current.views.get(registration) ?? null)) return;
        current.views.delete(registration);
        if (view !== null) current.views.set(registration, view);
        this.#viewChanged(channel, current);
      },
    });
  }

  /** The view of a channel changed: subscribe again with it (the server replaces the scope). */
  #viewChanged(channel: string, entry: ChannelEntry): void {
    if (viewKey(effectiveView(entry)) === entry.sentView) return;
    this.#sendSubscribe(channel, entry);
  }

  /** Called after every reconnect, once the channels were subscribed again. */
  onReconnect(listener: () => void): () => void {
    this.#reconnectListeners.add(listener);
    return () => this.#reconnectListeners.delete(listener);
  }

  /** Closes the connection for good (sign-out, tests). */
  stop(): void {
    this.#stopped = true;
    this.#clearTimers();
    for (const entry of this.#channels.values()) clearTimeout(entry.retryTimer);
    this.#channels.clear();
    this.#closeSocket(1000);
    this.#unwatchNetwork?.();
    this.#unwatchNetwork = null;
    this.#setStatus({ status: 'idle' });
  }

  /**
   * This tab signs out: closes the connection for good and ignores the
   * `4401` the server sends for the ended session (the sign-out navigates
   * itself). Later subscriptions never connect; the page is loaded again.
   */
  endSession(): void {
    this.#sessionEnded = true;
    this.stop();
  }

  // --- connection ------------------------------------------------------------------

  #ensureConnected(): void {
    this.#watchNetwork();
    if (this.#socket !== null || this.#reconnectTimer !== undefined) return;
    // `navigator.onLine` is only a hint: browsers report `false` behind some
    // VPNs and proxies while the server is reachable, so always try.
    this.#connect();
  }

  #connect(): void {
    if (this.#stopped || this.#sessionEnded || this.#channels.size === 0) return;
    this.#reconnectTimer = undefined;
    const url = this.#options.url ?? defaultUrl();
    let socket: SocketLike;
    try {
      socket = (this.#options.createSocket ?? defaultSocket)(url);
    } catch (error) {
      devWarn('realtime: cannot open the WebSocket', error);
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;
    if (!this.#wasOpen) this.#setStatus({ status: 'connecting' });
    socket.onopen = () => {
      if (this.#socket !== socket) return;
      this.#onOpen();
    };
    socket.onmessage = (event) => {
      if (this.#socket !== socket) return;
      this.#onMessage(event.data);
    };
    socket.onclose = (event) => {
      if (this.#socket !== socket) return;
      this.#onClose(event.code);
    };
    socket.onerror = () => {
      // A `close` event always follows; it decides what to do.
    };
  }

  #onOpen(): void {
    const reconnected = this.#wasOpen;
    this.#wasOpen = true;
    this.#attempt = 0;
    this.#setStatus({ status: 'open' });
    clearTimeout(this.#stableTimer);
    this.#stableTimer = setTimeout(() => {
      this.#policyStrikes = 0;
    }, POLICY_RESET_MS);
    for (const [channel, entry] of this.#channels) {
      entry.subscribed = false;
      this.#sendSubscribe(channel, entry);
    }
    this.#armHeartbeat();
    if (reconnected) {
      for (const listener of [...this.#reconnectListeners]) listener();
    }
  }

  #onClose(code: number): void {
    this.#socket = null;
    this.#clearHeartbeat();
    clearTimeout(this.#stableTimer);
    for (const entry of this.#channels.values()) {
      entry.subscribed = false;
      entry.pending = null;
    }
    if (code === REALTIME_CLOSE_CODES.unauthenticated) {
      this.stop();
      if (!this.#sessionEnded) this.#options.onSessionExpired?.();
      return;
    }
    if (
      code === REALTIME_CLOSE_CODES.policyViolation ||
      code === REALTIME_CLOSE_CODES.messageTooBig
    ) {
      devWarn(`realtime: connection closed by the server (${String(code)})`);
      this.#policyStrikes += 1;
    }
    if (this.#stopped || this.#channels.size === 0) {
      this.#setStatus({ status: 'idle' });
      return;
    }
    this.#setStatus({ status: 'reconnecting', since: this.#now() });
    // Back off even when the browser says offline (see #ensureConnected);
    // the `online` event still reconnects at once.
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.#reconnectTimer !== undefined || this.#stopped) return;
    // After policy closes, start further up the backoff (at least 4 s, 8 s…).
    const attempt = Math.max(this.#attempt, this.#policyStrikes > 0 ? this.#policyStrikes + 1 : 0);
    const delay = reconnectDelay(attempt, this.#options.random);
    this.#attempt += 1;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.#connect();
    }, delay);
  }

  #closeSocket(code: number): void {
    const socket = this.#socket;
    this.#socket = null;
    this.#clearHeartbeat();
    if (socket === null) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close(code);
    } catch {
      // Already closing.
    }
  }

  #watchNetwork(): void {
    if (this.#unwatchNetwork !== null) return;
    const watch = this.#options.watchNetwork ?? typeof window !== 'undefined';
    if (!watch) return;
    const offline = () => {
      // The socket cannot work while offline; announce it now and reconnect on `online`.
      if (this.#socket === null && this.#reconnectTimer === undefined) return;
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
      if (this.#socket !== null) {
        this.#closeSocket(CLIENT_CLOSE_CODE);
        this.#onClose(CLIENT_CLOSE_CODE);
      }
    };
    const online = () => {
      if (this.#stopped || this.#channels.size === 0 || this.#socket !== null) return;
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
      this.#attempt = 0;
      this.#connect();
    };
    window.addEventListener('offline', offline);
    window.addEventListener('online', online);
    this.#unwatchNetwork = () => {
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', online);
    };
  }

  // --- heartbeat -------------------------------------------------------------------

  #armHeartbeat(): void {
    this.#clearHeartbeat();
    this.#heartbeatTimer = setTimeout(() => {
      this.#heartbeatTimer = undefined;
      this.#send({ type: 'ping', req_id: this.#nextRequestId('p') });
      this.#pingTimeout = setTimeout(() => {
        this.#pingTimeout = undefined;
        // No answer: the connection is dead even if the browser has not noticed.
        this.#closeSocket(CLIENT_CLOSE_CODE);
        this.#onClose(CLIENT_CLOSE_CODE);
      }, HEARTBEAT_TIMEOUT_MS);
    }, HEARTBEAT_INTERVAL_MS);
  }

  #clearHeartbeat(): void {
    clearTimeout(this.#heartbeatTimer);
    clearTimeout(this.#pingTimeout);
    this.#heartbeatTimer = undefined;
    this.#pingTimeout = undefined;
  }

  // --- messages --------------------------------------------------------------------

  #onMessage(data: unknown): void {
    // Anything from the server proves the connection is alive.
    this.#armHeartbeat();
    if (typeof data !== 'string') {
      devWarn('realtime: unexpected binary frame');
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      devWarn('realtime: malformed message');
      return;
    }
    const parsed = realtimeServerMessageSchema.safeParse(json);
    if (!parsed.success) {
      devWarn('realtime: message does not match the contract', parsed.error.issues);
      return;
    }
    const message = parsed.data;
    switch (message.type) {
      case 'pong':
        return;
      case 'subscribed': {
        const entry = this.#channels.get(message.channel);
        if (entry?.pending === message.req_id) {
          entry.pending = null;
          entry.subscribed = true;
        }
        return;
      }
      case 'error':
        this.#onError(message);
        return;
      default:
        if (isChannelMessage(message)) this.#dispatch(message);
    }
  }

  #onError(message: Extract<RealtimeServerMessage, { type: 'error' }>): void {
    const channel =
      message.channel ??
      [...this.#channels].find(
        ([, entry]) => message.req_id !== null && entry.pending === message.req_id,
      )?.[0];
    if (channel === undefined) {
      devWarn(`realtime: server error ${message.code}`, message.errors);
      return;
    }
    const entry = this.#channels.get(channel);
    if (entry === undefined) return;
    // An answer to an older request (the channel was subscribed again since) is stale.
    if (message.req_id !== null && entry.pending !== null && entry.pending !== message.req_id) {
      return;
    }
    entry.pending = null;
    entry.subscribed = false;
    if (message.code === 'DEPENDENCY_UNAVAILABLE') {
      // The server could not check access: subscribe again shortly.
      clearTimeout(entry.retryTimer);
      entry.retryTimer = setTimeout(
        () => {
          entry.retryTimer = undefined;
          if (this.#channels.get(channel) === entry) this.#sendSubscribe(channel, entry);
        },
        reconnectDelay(0, this.#options.random),
      );
      return;
    }
    if (message.code !== 'NOT_FOUND') {
      devWarn(`realtime: subscription refused (${message.code})`, message.errors);
    }
    if (message.code === 'NOT_FOUND' && message.view_id !== undefined) {
      // Only the view went away (T313): keep the table, without that view.
      entry.refusedViewId = message.view_id;
      this.#sendSubscribe(channel, entry);
      for (const handlers of [...entry.handlers]) {
        handlers.onError?.(message.code, { viewId: message.view_id });
      }
      return;
    }
    for (const handlers of [...entry.handlers]) handlers.onError?.(message.code, {});
  }

  #dispatch(message: ChannelMessage): void {
    const entry = this.#channels.get(message.channel);
    if (entry === undefined) return;
    for (const handlers of [...entry.handlers]) {
      try {
        handlers.onMessage?.(message);
      } catch (error) {
        devWarn(`realtime: handler of ${message.type} failed`, error);
      }
    }
  }

  // --- channels --------------------------------------------------------------------

  #sendSubscribe(channel: string, entry: ChannelEntry): void {
    const view = effectiveView(entry);
    entry.sentView = viewKey(view);
    if (this.#socket?.readyState !== OPEN) return;
    entry.pending = this.#nextRequestId('s');
    this.#send({
      type: 'subscribe',
      channel,
      req_id: entry.pending,
      ...(view === null ? {} : { view }),
    });
  }

  #release(channel: string, handlers: ChannelHandlers): void {
    const entry = this.#channels.get(channel);
    if (entry === undefined) return;
    entry.handlers.delete(handlers);
    entry.views.delete(handlers);
    if (entry.handlers.size > 0) {
      this.#viewChanged(channel, entry);
      return;
    }
    clearTimeout(entry.retryTimer);
    this.#channels.delete(channel);
    this.#send({ type: 'unsubscribe', channel });
    if (this.#channels.size === 0) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = setTimeout(() => {
        this.#idleTimer = undefined;
        if (this.#channels.size > 0) return;
        clearTimeout(this.#reconnectTimer);
        this.#reconnectTimer = undefined;
        this.#closeSocket(1000);
        this.#setStatus({ status: 'idle' });
      }, IDLE_CLOSE_MS);
    }
  }

  #send(message: Readonly<Record<string, unknown>>): void {
    const socket = this.#socket;
    if (socket?.readyState !== OPEN) return;
    try {
      socket.send(JSON.stringify(message));
    } catch (error) {
      devWarn('realtime: send failed', error);
    }
  }

  #nextRequestId(prefix: string): string {
    this.#requestSeq += 1;
    return `${prefix}${String(this.#requestSeq)}`;
  }

  // --- misc ------------------------------------------------------------------------

  #setStatus(status: RealtimeConnection): void {
    this.#status =
      status.status === 'reconnecting' && this.#status.status === 'reconnecting'
        ? this.#status
        : status;
    (this.#options.onStatus ?? realtimeStatus.set)(status);
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  #clearTimers(): void {
    clearTimeout(this.#reconnectTimer);
    clearTimeout(this.#idleTimer);
    clearTimeout(this.#stableTimer);
    this.#reconnectTimer = undefined;
    this.#idleTimer = undefined;
    this.#clearHeartbeat();
  }
}

let shared: RealtimeClient | null = null;

/**
 * The WebSocket client of this tab, created on first use. Sign-out ends its
 * session through `session-end.ts` (`endRealtimeSession`), so the light
 * entries never import this module.
 */
export function realtimeClient(options?: RealtimeClientOptions): RealtimeClient {
  if (shared === null) {
    const client = new RealtimeClient(options);
    shared = client;
    setRealtimeSessionEnder(() => {
      client.endSession();
    });
  }
  return shared;
}
