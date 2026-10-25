import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/** One Bot API call the fake received. */
export interface FakeTelegramCall {
  readonly token: string;
  readonly method: string;
  readonly body: Record<string, unknown>;
  /** When the request arrived (`performance.now()`, T550: per-second limits). */
  readonly at: number;
}

/** An answer forced for the next call of a method (FIFO per method). */
export interface FakeTelegramReply {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
}

/** A private (or group) text message a user sends to the bot. */
export interface FakeTelegramMessage {
  readonly chatId: number;
  readonly text: string;
  readonly chatType?: 'private' | 'group' | 'supergroup' | 'channel';
  readonly languageCode?: string;
}

export interface FakeTelegramBot {
  /** Base URL to give `TelegramClient`/`TelegramBotApi` (`http://127.0.0.1:<port>`). */
  readonly baseUrl: string;
  readonly calls: FakeTelegramCall[];
  /** Calls of one method. */
  callsOf(method: string): FakeTelegramCall[];
  /** The `sendMessage` calls, as `{ chatId, text }`. */
  sent(): { chatId: string; text: string }[];
  /** Forces the answers of the next calls of `method`. */
  queue(method: string, ...replies: FakeTelegramReply[]): void;
  /** A message to the bot; `getUpdates` returns it (and a waiting long poll wakes up). */
  send(message: FakeTelegramMessage): number;
  /** An update of another kind (e.g. `edited_message`, `my_chat_member`). */
  sendRaw(update: Record<string, unknown>): number;
  /** Updates not confirmed yet (`offset` not past them). */
  pendingUpdates(): number;
  /**
   * A webhook is set on the bot elsewhere (`on`: a foreign URL) or removed:
   * `getUpdates` answers `409` while one is set.
   */
  setWebhook(on: boolean): void;
  /** The URL of the webhook (`setWebhook`, T609), `''` without one. */
  webhookUrl(): string;
  /** The `secret_token` given to `setWebhook`, `null` without one. */
  webhookSecret(): string | null;
  /** `last_error_date` (unix seconds) `getWebhookInfo` reports; `null` clears it. */
  setWebhookError(unixSeconds: number | null): void;
  /** A token Telegram no longer knows (`on = false` restores it): every call answers `401`. */
  revoke(token: string, on?: boolean): void;
  /** `getMe` username of a token's bot (default `cellhive_test_bot`). */
  setUsername(token: string, username: string): void;
  /** Most `getUpdates` of one token seen running at once. */
  readonly maxConcurrentPolls: () => number;
  close(): Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function json(response: ServerResponse, status: number, body: unknown, headers = {}): void {
  if (response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}

/**
 * A fake Telegram Bot API on a free local port (BACKLOG T549; same as
 * `packages/server-core/test/support/fake-telegram-bot.ts`, tests of one
 * package never import another's test files):
 * `getMe`, `getUpdates` (long polling with `offset` confirmation and the
 * `409` of a second concurrent poller or of a webhook), `sendMessage` —
 * never the real network. Long polls wait at most their `timeout` (seconds)
 * or until a message arrives.
 */
export async function startFakeTelegramBot(): Promise<FakeTelegramBot> {
  const calls: FakeTelegramCall[] = [];
  const forced = new Map<string, FakeTelegramReply[]>();
  const updates: { update_id: number; [key: string]: unknown }[] = [];
  const revoked = new Set<string>();
  const usernames = new Map<string, string>();
  const active = new Map<string, number>();
  const waiters = new Set<() => void>();
  let webhookUrl = '';
  let webhookSecret: string | null = null;
  let webhookErrorDate: number | null = null;
  let nextUpdateId = 100;
  let nextMessageId = 1000;
  let maxConcurrent = 0;
  const openResponses = new Set<ServerResponse>();

  const wake = () => {
    for (const waiter of [...waiters]) waiter();
  };

  const server: Server = createServer((request, response) => {
    openResponses.add(response);
    response.on('close', () => openResponses.delete(response));
    void (async () => {
      const match = /^\/bot([^/]+)\/([A-Za-z]+)$/u.exec(request.url ?? '');
      const raw = await readBody(request);
      if (match === null) {
        json(response, 404, { ok: false, error_code: 404, description: 'Not Found' });
        return;
      }
      const token = match[1] ?? '';
      const method = match[2] ?? '';
      const at = performance.now();
      const body = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
      calls.push({ token, method, body, at });
      const reply = forced.get(method)?.shift();
      if (reply !== undefined) {
        json(response, reply.status, reply.body, reply.headers ?? {});
        return;
      }
      if (revoked.has(token)) {
        json(response, 401, { ok: false, error_code: 401, description: 'Unauthorized' });
        return;
      }
      if (method === 'getMe') {
        const id = Number(token.slice(0, token.indexOf(':')));
        json(response, 200, {
          ok: true,
          result: {
            id,
            is_bot: true,
            first_name: 'Cellhive test',
            username: usernames.get(token) ?? 'cellhive_test_bot',
          },
        });
        return;
      }
      if (method === 'setWebhook') {
        webhookUrl = typeof body['url'] === 'string' ? body['url'] : '';
        webhookSecret = typeof body['secret_token'] === 'string' ? body['secret_token'] : null;
        webhookErrorDate = null;
        json(response, 200, { ok: true, result: true, description: 'Webhook was set' });
        return;
      }
      if (method === 'deleteWebhook') {
        webhookUrl = '';
        webhookSecret = null;
        webhookErrorDate = null;
        json(response, 200, { ok: true, result: true, description: 'Webhook was deleted' });
        return;
      }
      if (method === 'getWebhookInfo') {
        json(response, 200, {
          ok: true,
          result: {
            url: webhookUrl,
            has_custom_certificate: false,
            pending_update_count: updates.length,
            ...(webhookErrorDate === null
              ? {}
              : {
                  last_error_date: webhookErrorDate,
                  last_error_message: 'Wrong response from the webhook: 502 Bad Gateway',
                }),
          },
        });
        return;
      }
      if (method === 'sendMessage') {
        json(response, 200, {
          ok: true,
          result: { message_id: (nextMessageId += 1), date: 0, text: body['text'] },
        });
        return;
      }
      if (method === 'getUpdates') {
        if (webhookUrl !== '') {
          json(response, 409, {
            ok: false,
            error_code: 409,
            description:
              "Conflict: can't use getUpdates method while webhook is active; use " +
              'deleteWebhook to delete the webhook first',
          });
          return;
        }
        const running = active.get(token) ?? 0;
        if (running > 0) {
          maxConcurrent = Math.max(maxConcurrent, running + 1);
          json(response, 409, {
            ok: false,
            error_code: 409,
            description:
              'Conflict: terminated by other getUpdates request; make sure that only one bot ' +
              'instance is running',
          });
          return;
        }
        active.set(token, 1);
        maxConcurrent = Math.max(maxConcurrent, 1);
        try {
          const offset = typeof body['offset'] === 'number' ? body['offset'] : null;
          if (offset !== null) {
            // Confirmed: Telegram forgets every update below the offset.
            for (let index = updates.length - 1; index >= 0; index -= 1) {
              if ((updates[index]?.update_id ?? 0) < offset) updates.splice(index, 1);
            }
          }
          const timeout = typeof body['timeout'] === 'number' ? body['timeout'] : 0;
          const limit = typeof body['limit'] === 'number' ? body['limit'] : 100;
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
          json(response, 200, { ok: true, result: updates.slice(0, limit) });
        } finally {
          active.set(token, 0);
        }
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

  const push = (update: Record<string, unknown>) => {
    nextUpdateId += 1;
    updates.push({ ...update, update_id: nextUpdateId });
    wake();
    return nextUpdateId;
  };

  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    calls,
    callsOf: (method) => calls.filter((call) => call.method === method),
    sent: () =>
      calls
        .filter((call) => call.method === 'sendMessage')
        .map((call) => ({ chatId: String(call.body['chat_id']), text: String(call.body['text']) })),
    queue: (method, ...replies) => {
      forced.set(method, [...(forced.get(method) ?? []), ...replies]);
    },
    send: (message) =>
      push({
        message: {
          message_id: (nextMessageId += 1),
          date: 0,
          chat: { id: message.chatId, type: message.chatType ?? 'private' },
          from: {
            id: message.chatId,
            is_bot: false,
            first_name: 'Secret Name',
            ...(message.languageCode === undefined ? {} : { language_code: message.languageCode }),
          },
          text: message.text,
        },
      }),
    sendRaw: (update) => push(update),
    pendingUpdates: () => updates.length,
    setWebhook: (on) => {
      webhookUrl = on ? 'https://elsewhere.example/telegram' : '';
      webhookSecret = null;
    },
    webhookUrl: () => webhookUrl,
    webhookSecret: () => webhookSecret,
    setWebhookError: (unixSeconds) => {
      webhookErrorDate = unixSeconds;
    },
    revoke: (token, on = true) => {
      if (on) revoked.add(token);
      else revoked.delete(token);
    },
    setUsername: (token, username) => {
      usernames.set(token, username);
    },
    maxConcurrentPolls: () => maxConcurrent,
    close: () =>
      new Promise<void>((resolve) => {
        wake();
        for (const response of openResponses) response.destroy();
        server.close(() => {
          resolve();
        });
      }),
  };
}
