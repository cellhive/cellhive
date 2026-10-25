import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  IDLE_CLOSE_MS,
  RealtimeClient,
  reconnectDelay,
  type ChannelMessage,
  type SocketLike,
} from '../socket';

import type { RealtimeConnection } from '../status';

const TABLE = 'table:tbl_AAAAAAAAAAAAAAAA';
const BASE = 'base:bse_AAAAAAAAAAAAAAAA';
const RECORD = 'rec_AAAAAAAAAAAAAAAA';

class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  readonly sent: Record<string, unknown>[] = [];
  closedWith: number | undefined;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code?: number): void {
    this.closedWith = code ?? 1000;
    this.readyState = 3;
  }

  // --- server side ---
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: typeof message === 'string' ? message : JSON.stringify(message) });
  }

  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }

  /** Answers every pending `subscribe`. */
  confirmAll(): void {
    for (const message of this.sent) {
      if (message['type'] === 'subscribe') {
        this.receive({
          type: 'subscribed',
          req_id: message['req_id'],
          channel: message['channel'],
        });
      }
    }
  }

  types(): unknown[] {
    return this.sent.map((message) => message['type']);
  }
}

function setup(options: { random?: () => number } = {}) {
  const sockets: FakeSocket[] = [];
  const statuses: RealtimeConnection[] = [];
  const expired = vi.fn();
  const client = new RealtimeClient({
    url: 'ws://test/ws',
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    random: options.random ?? (() => 0.5),
    onStatus: (status) => statuses.push(status),
    onSessionExpired: expired,
    watchNetwork: true,
  });
  const last = () => {
    const socket = sockets.at(-1);
    if (socket === undefined) throw new Error('no socket');
    return socket;
  };
  return { client, sockets, statuses, expired, last };
}

function updated(version: number): ChannelMessage {
  return {
    type: 'record.updated',
    channel: TABLE,
    record_id: RECORD,
    version,
    fields: {},
    actor_id: null,
    event_id: null,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('reconnectDelay (FRONTEND §5)', () => {
  it.each([
    { attempt: 0, random: 0.5, expected: 1000 },
    { attempt: 1, random: 0.5, expected: 2000 },
    { attempt: 2, random: 0.5, expected: 4000 },
    { attempt: 3, random: 0.5, expected: 8000 },
    { attempt: 4, random: 0.5, expected: 16_000 },
    { attempt: 5, random: 0.5, expected: 30_000 },
    { attempt: 12, random: 0.5, expected: 30_000 },
    // ±20 % jitter
    { attempt: 0, random: 0, expected: 800 },
    { attempt: 0, random: 0.999_999, expected: 1200 },
    { attempt: 3, random: 0, expected: 6400 },
    // Never above 30 s, jitter or not.
    { attempt: 5, random: 0.999_999, expected: 30_000 },
    { attempt: 5, random: 0, expected: 24_000 },
  ])('attempt $attempt, random $random → $expected ms', ({ attempt, random, expected }) => {
    expect(reconnectDelay(attempt, () => random)).toBe(expected);
  });
});

describe('RealtimeClient', () => {
  it('opens one connection lazily and subscribes with request ids', () => {
    const { client, sockets, statuses, last } = setup();
    expect(sockets).toHaveLength(0);
    client.subscribe(TABLE, {});
    client.subscribe(BASE, {});
    expect(sockets).toHaveLength(1);
    expect(last().url).toBe('ws://test/ws');
    expect(statuses.at(-1)).toEqual({ status: 'connecting' });
    last().open();
    expect(statuses.at(-1)).toEqual({ status: 'open' });
    expect(last().sent).toEqual([
      { type: 'subscribe', channel: TABLE, req_id: expect.any(String) as unknown },
      { type: 'subscribe', channel: BASE, req_id: expect.any(String) as unknown },
    ]);
    const ids = last().sent.map((message) => message['req_id']);
    expect(new Set(ids).size).toBe(2);
    last().confirmAll();
    expect(client.isSubscribed(TABLE)).toBe(true);
  });

  it('counts references: one subscribe per channel, unsubscribe when the last one leaves', () => {
    const { client, last } = setup();
    const a = vi.fn();
    const b = vi.fn();
    const releaseA = client.subscribe(TABLE, { onMessage: a });
    last().open();
    const releaseB = client.subscribe(TABLE, { onMessage: b });
    expect(last().types()).toEqual(['subscribe']);
    last().receive(updated(2));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    releaseA();
    releaseA(); // idempotent
    expect(last().types()).toEqual(['subscribe']);
    last().receive(updated(3));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);

    releaseB();
    expect(last().sent.at(-1)).toEqual({ type: 'unsubscribe', channel: TABLE });
    expect(client.channels()).toEqual([]);
    // The idle socket closes a little later, unless a screen subscribes again.
    vi.advanceTimersByTime(IDLE_CLOSE_MS);
    expect(last().closedWith).toBe(1000);
  });

  it('keeps the socket when a channel is subscribed again before the idle delay', () => {
    const { client, sockets, last } = setup();
    const release = client.subscribe(TABLE, {});
    last().open();
    release();
    client.subscribe(TABLE, {});
    vi.advanceTimersByTime(IDLE_CLOSE_MS * 2);
    expect(sockets).toHaveLength(1);
    expect(last().closedWith).toBeUndefined();
    expect(last().types()).toEqual(['subscribe', 'unsubscribe', 'subscribe']);
  });

  it('drops messages that do not match the contract', () => {
    const { client, last } = setup();
    const onMessage = vi.fn();
    client.subscribe(TABLE, { onMessage });
    last().open();
    last().receive('{not json');
    last().receive({ type: 'record.updated', channel: TABLE, record_id: 'nope' });
    last().receive({ type: 'mystery', channel: TABLE });
    expect(onMessage).not.toHaveBeenCalled();
    last().receive(updated(4));
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it('reports NOT_FOUND for the channel of the request', () => {
    const { client, last } = setup();
    const onError = vi.fn();
    client.subscribe(TABLE, { onError });
    last().open();
    const reqId = last().sent[0]?.['req_id'];
    last().receive({ type: 'error', req_id: reqId, code: 'NOT_FOUND', channel: TABLE });
    expect(onError).toHaveBeenCalledWith('NOT_FOUND', {});
    expect(client.isSubscribed(TABLE)).toBe(false);
  });

  it('subscribes with the view on screen and changes it without unsubscribing (T313)', () => {
    const { client, last } = setup();
    const VIEW = 'viw_V000000000000001';
    const release = client.subscribe(TABLE, { view: { id: VIEW } });
    last().open();
    expect(last().sent[0]).toMatchObject({ type: 'subscribe', channel: TABLE, view: { id: VIEW } });
    release.setView({ id: VIEW });
    expect(last().types()).toEqual(['subscribe']);
    release.setView({ id: VIEW, filter_mode: 'replace' });
    expect(last().types()).toEqual(['subscribe', 'subscribe']);
    expect(last().sent[1]).toMatchObject({ view: { id: VIEW, filter_mode: 'replace' } });
    // Another screen without a view shares the channel: the view stays.
    const other = client.subscribe(TABLE, {});
    other();
    expect(last().types()).toEqual(['subscribe', 'subscribe']);
    release.setView(null);
    expect(last().sent[2]).toEqual({
      type: 'subscribe',
      channel: TABLE,
      req_id: expect.any(String) as unknown,
    });
  });

  it('a refused view keeps the table without it and tells the screen (T313)', () => {
    const { client, last } = setup();
    const VIEW = 'viw_V000000000000001';
    const onError = vi.fn();
    client.subscribe(TABLE, { onError, view: { id: VIEW } });
    last().open();
    const reqId = last().sent[0]?.['req_id'];
    last().receive({
      type: 'error',
      req_id: reqId,
      code: 'NOT_FOUND',
      channel: TABLE,
      view_id: VIEW,
    });
    expect(onError).toHaveBeenCalledWith('NOT_FOUND', { viewId: VIEW });
    expect(last().sent[1]).toEqual({
      type: 'subscribe',
      channel: TABLE,
      req_id: expect.any(String) as unknown,
    });
  });

  it('subscribes again after DEPENDENCY_UNAVAILABLE', () => {
    const { client, last } = setup();
    const onError = vi.fn();
    client.subscribe(TABLE, { onError });
    last().open();
    last().confirmAll();
    last().receive({ type: 'error', req_id: null, code: 'DEPENDENCY_UNAVAILABLE', channel: TABLE });
    expect(onError).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(last().types()).toEqual(['subscribe', 'subscribe']);
  });

  it('reconnects with backoff, resubscribes every channel and notifies listeners', () => {
    const { client, sockets, statuses, last } = setup();
    const reconnected = vi.fn();
    client.onReconnect(reconnected);
    client.subscribe(TABLE, {});
    client.subscribe(BASE, {});
    last().open();
    last().confirmAll();
    expect(reconnected).not.toHaveBeenCalled();

    last().drop();
    expect(statuses.at(-1)).toMatchObject({ status: 'reconnecting' });
    expect(client.isSubscribed(TABLE)).toBe(false);
    // 1 s, then 2 s, then 4 s between attempts (random 0.5 = no jitter).
    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    last().drop();
    vi.advanceTimersByTime(1999);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);
    last().drop();
    vi.advanceTimersByTime(3999);
    expect(sockets).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(4);

    last().open();
    expect(statuses.at(-1)).toEqual({ status: 'open' });
    expect(last().sent.map((message) => message['channel'])).toEqual([TABLE, BASE]);
    expect(reconnected).toHaveBeenCalledTimes(1);

    // A successful open resets the backoff.
    last().drop();
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(5);
  });

  it('never waits more than 30 s between attempts', () => {
    const { client, sockets, last } = setup({ random: () => 0.999 });
    client.subscribe(TABLE, {});
    last().open();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      last().drop();
      const before = sockets.length;
      vi.advanceTimersByTime(30_000);
      expect(sockets.length).toBe(before + 1);
    }
  });

  it('4401: stops and hands over to the sign-in, without reconnecting', () => {
    const { client, sockets, statuses, expired, last } = setup();
    client.subscribe(TABLE, {});
    last().open();
    last().drop(4401);
    expect(expired).toHaveBeenCalledTimes(1);
    expect(statuses.at(-1)).toEqual({ status: 'idle' });
    vi.advanceTimersByTime(120_000);
    expect(sockets).toHaveLength(1);
  });

  it('endSession (sign-out of this tab): closes, ignores the 4401 of the ended session, never reconnects', () => {
    const { client, sockets, statuses, expired, last } = setup();
    client.subscribe(TABLE, {});
    last().open();
    const socket = last();
    client.endSession();
    expect(socket.closedWith).toBe(1000);
    expect(statuses.at(-1)).toEqual({ status: 'idle' });
    // The server's close of the ended session still reaches the old handler slot.
    socket.drop(4401);
    // A screen subscribing while the sign-out request runs does not reconnect.
    client.subscribe(BASE, {});
    vi.advanceTimersByTime(120_000);
    expect(sockets).toHaveLength(1);
    expect(expired).not.toHaveBeenCalled();
  });

  it.each([1008, 1009])('%i: logs and reconnects with a longer backoff', (code) => {
    const { client, sockets, last } = setup();
    client.subscribe(TABLE, {});
    last().open();
    last().drop(code);
    // At least 4 s after a policy close instead of 1 s.
    vi.advanceTimersByTime(3999);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    last().open();
    last().drop(code);
    vi.advanceTimersByTime(7999);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);
  });

  it('pings when the server is silent and reconnects when nothing answers', () => {
    const { client, sockets, last } = setup();
    client.subscribe(TABLE, {});
    last().open();
    last().confirmAll();
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(last().sent.at(-1)).toMatchObject({ type: 'ping' });
    // An answer keeps the connection.
    last().receive({ type: 'pong', req_id: last().sent.at(-1)?.['req_id'] });
    vi.advanceTimersByTime(HEARTBEAT_TIMEOUT_MS);
    expect(last().closedWith).toBeUndefined();
    // Silence after the next ping: closed and re-opened.
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS + HEARTBEAT_TIMEOUT_MS);
    expect(sockets[0]?.closedWith).toBe(4000);
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
  });

  it('closes on `offline` and reconnects at once on `online`', () => {
    const { client, sockets, statuses, last } = setup();
    client.subscribe(TABLE, {});
    last().open();
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    window.dispatchEvent(new Event('offline'));
    expect(sockets[0]?.closedWith).toBe(4000);
    expect(statuses.at(-1)).toMatchObject({ status: 'reconnecting' });
    expect(sockets).toHaveLength(1);
    onLine.mockReturnValue(true);
    window.dispatchEvent(new Event('online'));
    expect(sockets).toHaveLength(2);
    client.stop();
  });

  it('connects even when the browser says offline (navigator.onLine is only a hint)', () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const { client, sockets, last } = setup();
    client.subscribe(TABLE, {});
    expect(sockets).toHaveLength(1);
    last().open();
    // A lost connection backs off and retries while the flag stays false.
    last().close(1006);
    vi.advanceTimersByTime(60_000);
    expect(sockets.length).toBeGreaterThan(1);
    onLine.mockRestore();
    client.stop();
  });

  it('stop() closes the socket and forgets the channels', () => {
    const { client, last } = setup();
    client.subscribe(TABLE, {});
    last().open();
    client.stop();
    expect(last().closedWith).toBe(1000);
    expect(client.channels()).toEqual([]);
  });
});
