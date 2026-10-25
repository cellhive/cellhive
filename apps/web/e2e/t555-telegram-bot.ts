import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/** One Bot API call the fake received. */
export interface FakeBotCall {
  readonly token: string;
  readonly method: string;
  readonly body: Record<string, unknown>;
}

/** An answer forced for the next call of a method (FIFO per method). */
export interface FakeBotReply {
  readonly status: number;
  readonly body: unknown;
}

export interface FakeTelegramBot {
  /** Base URL for `TelegramClient`/`TelegramBotApi` (`http://127.0.0.1:<port>`). */
  readonly baseUrl: string;
  readonly calls: FakeBotCall[];
  /** The `sendMessage` calls, as `{ chatId, text }`. */
  sent(): { chatId: string; text: string }[];
  /** Forces the answers of the next calls of `method`. */
  queue(method: string, ...replies: FakeBotReply[]): void;
  /** A private text message a user sends to the bot; a waiting long poll wakes up. */
  send(message: { readonly chatId: number; readonly text: string }): void;
  /**
   * A webhook is set on the bot elsewhere: `getUpdates` answers `409` and
   * `getWebhookInfo` reports that other URL (T614).
   */
  setWebhook(on: boolean): void;
  /** The webhook URL the bot has now (`''` when none) — set by `setWebhook` of the Bot API too. */
  webhookUrl(): string;
  /** `getMe` username of a token's bot (default `cellhive_test_bot`). */
  setUsername(token: string, username: string): void;
  close(): Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function json(response: ServerResponse, status: number, body: unknown): void {
  if (response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

/**
 * A fake Telegram Bot API for the T555 spec, in the test process — the same
 * behaviour as the fake of the T549/T550 integration tests
 * (`apps/api/test/int/telegram-bot-support.ts`; specs never import another
 * package's test files): `getMe` (bot id = the token's numeric prefix),
 * `getUpdates` (long polling, `offset` confirmation, `409` with a webhook),
 * `sendMessage`; T614 adds `getWebhookInfo`, `setWebhook` and
 * `deleteWebhook` (one webhook URL for the fake). The real `api.telegram.org` is never called: only the
 * spec's in-process API and worker are pointed here (their test-only
 * `telegramClient` option).
 */
export async function startFakeTelegramBot(): Promise<FakeTelegramBot> {
  const calls: FakeBotCall[] = [];
  const forced = new Map<string, FakeBotReply[]>();
  const updates: { update_id: number; [key: string]: unknown }[] = [];
  const usernames = new Map<string, string>();
  const waiters = new Set<() => void>();
  const open = new Set<ServerResponse>();
  /** The webhook URL of the bot (`''`: none, so `getUpdates` works). */
  let webhook = '';
  let nextUpdateId = 100;
  let nextMessageId = 1000;
  const wake = () => {
    for (const waiter of [...waiters]) waiter();
  };

  const server: Server = createServer((request, response) => {
    open.add(response);
    response.on('close', () => open.delete(response));
    void (async () => {
      const match = /^\/bot([^/]+)\/([A-Za-z]+)$/u.exec(request.url ?? '');
      const raw = await readBody(request);
      if (match === null) {
        json(response, 404, { ok: false, error_code: 404, description: 'Not Found' });
        return;
      }
      const token = match[1] ?? '';
      const method = match[2] ?? '';
      const body = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
      calls.push({ token, method, body });
      const reply = forced.get(method)?.shift();
      if (reply !== undefined) {
        json(response, reply.status, reply.body);
        return;
      }
      if (method === 'getMe') {
        json(response, 200, {
          ok: true,
          result: {
            id: Number(token.slice(0, token.indexOf(':'))),
            is_bot: true,
            first_name: 'Cellhive test',
            username: usernames.get(token) ?? 'cellhive_test_bot',
          },
        });
        return;
      }
      if (method === 'sendMessage') {
        json(response, 200, { ok: true, result: { message_id: (nextMessageId += 1), date: 0 } });
        return;
      }
      if (method === 'getWebhookInfo') {
        json(response, 200, {
          ok: true,
          result: { url: webhook, has_custom_certificate: false, pending_update_count: 0 },
        });
        return;
      }
      if (method === 'setWebhook') {
        webhook = typeof body['url'] === 'string' ? body['url'] : '';
        json(response, 200, { ok: true, result: true, description: 'Webhook was set' });
        return;
      }
      if (method === 'deleteWebhook') {
        webhook = '';
        json(response, 200, { ok: true, result: true, description: 'Webhook was deleted' });
        return;
      }
      if (method === 'getUpdates') {
        if (webhook !== '') {
          json(response, 409, {
            ok: false,
            error_code: 409,
            description:
              "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook " +
              'to delete the webhook first',
          });
          return;
        }
        const offset = typeof body['offset'] === 'number' ? body['offset'] : null;
        if (offset !== null) {
          for (let index = updates.length - 1; index >= 0; index -= 1) {
            if ((updates[index]?.update_id ?? 0) < offset) updates.splice(index, 1);
          }
        }
        const timeout = typeof body['timeout'] === 'number' ? body['timeout'] : 0;
        if (updates.length === 0 && timeout > 0) {
          await new Promise<void>((resolve) => {
            const done = () => {
              waiters.delete(done);
              clearTimeout(timer);
              resolve();
            };
            const timer = setTimeout(done, timeout * 1000);
            waiters.add(done);
            response.on('close', done);
          });
        }
        json(response, 200, { ok: true, result: [...updates] });
        return;
      }
      json(response, 404, { ok: false, error_code: 404, description: 'Not Found' });
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
    sent: () =>
      calls
        .filter((call) => call.method === 'sendMessage')
        .map((call) => ({ chatId: String(call.body['chat_id']), text: String(call.body['text']) })),
    queue: (method, ...replies) => {
      forced.set(method, [...(forced.get(method) ?? []), ...replies]);
    },
    send: (message) => {
      nextUpdateId += 1;
      updates.push({
        update_id: nextUpdateId,
        message: {
          message_id: (nextMessageId += 1),
          date: 0,
          chat: { id: message.chatId, type: 'private' },
          from: { id: message.chatId, is_bot: false, first_name: 'Secret Name' },
          text: message.text,
        },
      });
      wake();
    },
    setWebhook: (on) => {
      webhook = on ? 'https://elsewhere.example/telegram/hook' : '';
    },
    webhookUrl: () => webhook,
    setUsername: (token, username) => {
      usernames.set(token, username);
    },
    close: () =>
      new Promise<void>((resolve) => {
        wake();
        for (const response of open) response.destroy();
        server.close(() => {
          resolve();
        });
      }),
  };
}
