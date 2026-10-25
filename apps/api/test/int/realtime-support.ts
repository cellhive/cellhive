import { type AddressInfo } from 'node:net';

import { realtimeServerMessageSchema, type RealtimeServerMessage } from '@cellhive/contracts';
import { WebSocket } from 'ws';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';

/** Listens on an ephemeral port and returns the `ws://` URL of `/ws`. */
export async function listen(app: NestFastifyApplication): Promise<string> {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.getHttpServer().address() as AddressInfo;
  return `ws://127.0.0.1:${String(address.port)}/ws`;
}

export interface SocketOptions {
  readonly origin?: string;
  readonly cookie?: string;
  /** `false`: never answer protocol pings (a dead peer). */
  readonly autoPong?: boolean;
  /** `Authorization` header, e.g. `Bearer cht_…` (T706). */
  readonly authorization?: string;
  /** `X-Forwarded-For` (the test server trusts 127.0.0.1 as a proxy). */
  readonly forwardedFor?: string;
}

export type OpenResult =
  | { readonly ok: true; readonly socket: TestSocket }
  | {
      readonly ok: false;
      readonly status: number;
      readonly body: string;
      readonly headers: Readonly<Record<string, string | string[] | undefined>>;
    };

/** A WebSocket client that records every server message for assertions. */
export class TestSocket {
  readonly received: RealtimeServerMessage[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  readonly #waiters = new Set<() => void>();

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data: Buffer) => {
      this.received.push(realtimeServerMessageSchema.parse(JSON.parse(data.toString('utf8'))));
      for (const waiter of this.#waiters) waiter();
    });
    this.closed = new Promise((resolve) => {
      ws.on('close', (code, reason) => {
        resolve({ code, reason: reason.toString('utf8') });
        for (const waiter of this.#waiters) waiter();
      });
    });
  }

  static open(url: string, options: SocketOptions = {}): Promise<OpenResult> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        autoPong: options.autoPong ?? true,
        headers: {
          ...(options.origin === undefined ? {} : { origin: options.origin }),
          ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
          ...(options.authorization === undefined ? {} : { authorization: options.authorization }),
          ...(options.forwardedFor === undefined
            ? {}
            : { 'x-forwarded-for': options.forwardedFor }),
        },
      });
      ws.once('unexpected-response', (_request, response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            ok: false,
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: response.headers,
          });
        });
      });
      ws.once('open', () => {
        resolve({ ok: true, socket: new TestSocket(ws) });
      });
      ws.once('error', reject);
    });
  }

  static async connect(url: string, options: SocketOptions): Promise<TestSocket> {
    const result = await TestSocket.open(url, options);
    if (!result.ok) throw new Error(`websocket refused: ${String(result.status)} ${result.body}`);
    return result.socket;
  }

  send(message: unknown): void {
    this.ws.send(typeof message === 'string' ? message : JSON.stringify(message));
  }

  /**
   * The next message (after those already consumed) that matches, waiting
   * up to `timeoutMs`. Messages skipped over stay available to `next` calls
   * with another predicate. The wait ends as soon as the message arrives:
   * the bound only decides when a missing message fails, and 5 s was too
   * short with every package's integration tests on one machine (T319).
   */
  async next(
    predicate: (message: RealtimeServerMessage) => boolean = () => true,
    timeoutMs = 15_000,
  ): Promise<RealtimeServerMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (let index = 0; index < this.received.length; index += 1) {
        const message = this.received[index];
        if (message !== undefined && predicate(message)) {
          this.received.splice(index, 1);
          return message;
        }
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0 || this.ws.readyState === WebSocket.CLOSED) {
        throw new Error(`no matching message; received: ${JSON.stringify(this.received)}`);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.min(remaining, 250));
        function done(): void {
          clearTimeout(timer);
          resolve();
        }
        this.#waiters.add(done);
      }).finally(() => {
        this.#waiters.clear();
      });
    }
  }

  /** Subscribes and returns the reply (`subscribed` or `error`). */
  async subscribe(
    channel: string,
    reqId: string = channel,
    extra: Readonly<Record<string, unknown>> = {},
  ): Promise<RealtimeServerMessage> {
    this.send({ type: 'subscribe', channel, req_id: reqId, ...extra });
    return this.next(
      (message) =>
        (message.type === 'subscribed' || message.type === 'error') && message.req_id === reqId,
    );
  }

  /** Nothing matching arrives within `ms` (after a round trip through `ping`). */
  async expectNone(
    predicate: (message: RealtimeServerMessage) => boolean,
    ms = 500,
  ): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    const reqId = `quiet-${String(Date.now())}`;
    this.send({ type: 'ping', req_id: reqId });
    await this.next((message) => message.type === 'pong' && message.req_id === reqId);
    const unexpected = this.received.filter(predicate);
    if (unexpected.length > 0) throw new Error(`unexpected: ${JSON.stringify(unexpected)}`);
  }

  close(): void {
    this.ws.close();
  }
}

/**
 * Closes every socket and waits for each close handshake to finish (then
 * terminates what is left after `timeoutMs`), so that no upgraded
 * connection is still open when the app closes: `server.close()` waits for
 * every TCP connection, and a handshake racing the gateway's own shutdown
 * on a loaded machine made `afterAll` slow (T319).
 */
export async function closeSockets(
  sockets: readonly TestSocket[],
  timeoutMs = 5_000,
): Promise<void> {
  await Promise.all(
    sockets.map(async (socket) => {
      if (socket.ws.readyState === WebSocket.CLOSED) return;
      socket.close();
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => {
          resolve('timeout');
        }, timeoutMs);
      });
      const result = await Promise.race([socket.closed, timedOut]);
      clearTimeout(timer);
      if (result === 'timeout') socket.ws.terminate();
    }),
  );
}
