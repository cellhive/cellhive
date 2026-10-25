import { createServer, type IncomingMessage, type Server } from 'node:http';

/** One `sendMessage` the fake Bot API received. */
export interface TelegramCall {
  readonly token: string;
  readonly method: string;
  readonly body: Record<string, unknown>;
}

/** The next answers, in order; when none is queued, a success. */
export interface TelegramReply {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
}

export interface FakeTelegram {
  /** Base URL to give `TelegramClient` (`http://127.0.0.1:<port>`). */
  readonly baseUrl: string;
  readonly calls: TelegramCall[];
  /** Answers for the next calls (FIFO). */
  queue(...replies: TelegramReply[]): void;
  close(): Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * A fake Telegram Bot API on a free local port (BACKLOG T516): records each
 * `POST /bot<token>/<method>` and answers like Telegram — never the real
 * network.
 */
export async function startFakeTelegram(): Promise<FakeTelegram> {
  const calls: TelegramCall[] = [];
  const replies: TelegramReply[] = [];
  let nextMessageId = 1000;
  const server: Server = createServer((request, response) => {
    void (async () => {
      const match = /^\/bot([^/]+)\/([A-Za-z]+)$/u.exec(request.url ?? '');
      const raw = await readBody(request);
      if (match === null) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: false, error_code: 404, description: 'Not Found' }));
        return;
      }
      calls.push({
        token: match[1] ?? '',
        method: match[2] ?? '',
        body: JSON.parse(raw) as Record<string, unknown>,
      });
      const reply = replies.shift() ?? {
        status: 200,
        body: { ok: true, result: { message_id: (nextMessageId += 1), date: 0 } },
      };
      response.writeHead(reply.status, {
        'content-type': 'application/json',
        ...(reply.headers ?? {}),
      });
      response.end(JSON.stringify(reply.body));
    })();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    calls,
    queue: (...items) => {
      replies.push(...items);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}
