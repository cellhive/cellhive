import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server } from 'node:http';

import type { AddressInfo } from 'node:net';

/** One Bot API call the fake received. */
export interface TelegramCall {
  readonly token: string;
  readonly method: string;
  readonly body: Record<string, unknown>;
}

export interface FakeTelegram {
  /** Base URL for the worker's Telegram client (`http://127.0.0.1:<port>`). */
  readonly baseUrl: string;
  readonly calls: TelegramCall[];
  close(): Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * A fake Telegram Bot API for the S5 scenario (BACKLOG T519): records each
 * `POST /bot<token>/<method>` and answers like Telegram (`ok: true` with a
 * message id). The real `api.telegram.org` is never called: only the
 * in-process worker of the spec is pointed here (a test-only option of
 * `buildTaskList`, never configurable in production).
 */
export async function startFakeTelegram(): Promise<FakeTelegram> {
  const calls: TelegramCall[] = [];
  let messageId = 1000;
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
      messageId += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, result: { message_id: messageId, date: 0 } }));
    })();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
