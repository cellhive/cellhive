import { WebSocket } from 'ws';

import type { BaseAccess } from '../../common/access/access.service.js';
import type { Principal } from '../../common/auth/principal.js';
import type {
  Id,
  RealtimeChannel,
  RealtimeServerMessage,
  RealtimeSubscribeView,
  RealtimeViewFilterMode,
  StoredColorRule,
} from '@cellhive/contracts';

/**
 * Values of the record-rule variables of a subscriber (SPEC §6.1), taken at
 * the last access check along with `base`: the zone of date operands and,
 * for `current_user_groups`, the members of the subscriber's groups.
 */
export interface RuleVariables {
  readonly timeZone: string;
  readonly groupMemberUserIds: readonly Id<'usr'>[];
}

/**
 * The view open on screen for a `table:` subscription (T313, ADR-0031), as
 * loaded at the last access check: record messages follow its saved filter
 * on top of the read rule (only the part hidden from the subscriber with
 * `filter_mode: replace`).
 */
export interface SubscriberView {
  readonly id: Id<'viw'>;
  readonly filterMode: RealtimeViewFilterMode;
  /** The saved filter (stored DSL, field ids); `null` = none. */
  readonly filter: unknown;
  /**
   * Color rules of the view (T816), stored form: record messages carry
   * `meta.color` under those that apply to the subscriber. Absent = none.
   */
  readonly colorRules?: readonly StoredColorRule[];
}

/**
 * What a delivery strategy knows about one subscription: who subscribed to
 * which channel, with the access they had when last checked. Per-subscriber
 * filtering (T210) works from `base` and `variables` alone, without
 * database reads.
 */
export interface Subscriber {
  readonly channel: string;
  readonly target: RealtimeChannel;
  readonly userId: Id<'usr'>;
  readonly connectionId: number;
  /** Access to the channel's base at the last check; `null` for `user:` channels. */
  readonly base: BaseAccess | null;
  /**
   * Access before the last re-check (`permission.changed`), so that a
   * change which removed something can still be told to those who saw it.
   */
  readonly previousBase: BaseAccess | null;
  /** Record-rule variables at the last check; `null` except for `table:` channels. */
  readonly variables: RuleVariables | null;
  /** The view of a `table:` subscription (T313); `null` = the whole read scope. */
  readonly view: SubscriberView | null;
  /**
   * Tables the data widgets of a `dashboard:` subscription read (T807), at
   * the last check: their record changes become `dashboard.data_changed`.
   * `null` for other channels.
   */
  readonly tables: ReadonlySet<Id<'tbl'>> | null;
}

/** A subscription held by a connection on this instance. */
export interface Subscription extends Subscriber {
  readonly connection: RealtimeConnection;
  /**
   * Organizations whose bus carries messages for the channel (narrowed by a
   * re-check when the user of a `user:` channel leaves one).
   */
  orgIds: readonly Id<'org'>[];
  readonly baseId: Id<'bse'> | null;
  base: BaseAccess | null;
  previousBase: BaseAccess | null;
  variables: RuleVariables | null;
  view: SubscriberView | null;
  tables: ReadonlySet<Id<'tbl'>> | null;
  /** The view the client asked for (checked again with every re-check). */
  viewRequest: RealtimeSubscribeView | null;
}

let nextConnectionId = 1;

/**
 * JSON of server messages. Delivery strategies hand the same message object
 * to every subscriber of a group (T210), so it is serialized once.
 */
const serialized = new WeakMap<RealtimeServerMessage, string>();

function serialize(message: RealtimeServerMessage): string {
  let text = serialized.get(message);
  if (text === undefined) {
    text = JSON.stringify(message);
    serialized.set(message, text);
  }
  return text;
}

/**
 * One WebSocket client. Client messages are handled one at a time, in
 * order (`enqueue`); server messages are sent as JSON text frames.
 */
export class RealtimeConnection {
  readonly id = nextConnectionId++;
  readonly subscriptions = new Map<string, Subscription>();
  /** Answered the last protocol ping (or sent something since). */
  alive = true;
  invalidMessages = 0;
  sessionCheckedAt = Date.now();
  #pending = 0;
  #chain: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(
    private readonly socket: WebSocket,
    readonly principal: Principal,
    /**
     * The session cookie or the API token of the handshake, kept in memory
     * only to re-validate it (never logged).
     */
    readonly credential: string,
    private readonly maxBufferedBytes: () => number,
  ) {}

  get userId(): Id<'usr'> {
    return this.principal.userId;
  }

  /** How the handshake authenticated (`ws_connections{auth}`, ADR-36 §2). */
  get auth(): 'session' | 'api_token' {
    return this.principal.kind === 'api_token' ? 'api_token' : 'session';
  }

  /** The API token of the connection, when it authenticated with one. */
  get tokenId(): Id<'tok'> | null {
    return this.principal.kind === 'api_token' ? this.principal.tokenId : null;
  }

  isClosed(): boolean {
    return this.#closed || this.socket.readyState !== WebSocket.OPEN;
  }

  get pending(): number {
    return this.#pending;
  }

  /**
   * A principal for one round of access checks: `AccessService` caches per
   * principal object, so a fresh object reads current memberships and roles.
   */
  freshPrincipal(): Principal {
    return { ...this.principal };
  }

  /** Runs `task` after the tasks queued before it. */
  enqueue(task: () => Promise<void>): void {
    this.#pending += 1;
    this.#chain = this.#chain
      .then(task)
      .catch(() => undefined)
      .finally(() => {
        this.#pending -= 1;
      });
  }

  send(message: RealtimeServerMessage): void {
    if (this.isClosed()) return;
    if (this.socket.bufferedAmount > this.maxBufferedBytes()) {
      // A client that does not read would make the server buffer forever.
      this.terminate();
      return;
    }
    this.socket.send(serialize(message));
  }

  ping(): void {
    if (!this.isClosed()) this.socket.ping();
  }

  close(code: number, reason: string): void {
    this.#closed = true;
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    ) {
      this.socket.close(code, reason);
    }
  }

  terminate(): void {
    this.#closed = true;
    this.socket.terminate();
  }

  /** Called when the socket closed, whatever the reason. */
  markClosed(): void {
    this.#closed = true;
  }
}
