/**
 * BACKLOG T549: pure parts of the Telegram channel — `getMe`/`getUpdates`
 * classification (table-driven, fake fetch, never the network), the
 * notification bot in `organizations.settings`, the fixed replies and the
 * sealing of chat ids.
 */
import { describe, expect, it } from 'vitest';

import { TelegramBotApi } from '../../src/automation/index.js';
import {
  NO_TELEGRAM_BOT,
  orgTelegramSettingsJson,
  orgTelegramSettingsOf,
  replyLanguageOf,
  TelegramChatAddress,
  telegramLinkReply,
  withOrgTelegramSettings,
} from '../../src/notifications/index.js';

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0';

function fakeFetch(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): { fetch: typeof fetch; calls: { url: string; body: unknown; signal: AbortSignal | null }[] } {
  const calls: { url: string; body: unknown; signal: AbortSignal | null }[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push({
      url,
      body: JSON.parse(init?.body as string) as unknown,
      signal: init?.signal ?? null,
    });
    return Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      }),
    );
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

describe('TelegramBotApi.getMe (T549)', () => {
  it('reads the bot id and username at the fixed host', async () => {
    const fake = fakeFetch(200, {
      ok: true,
      result: { id: 123456789, is_bot: true, username: 'CellhiveBot' },
    });
    const api = new TelegramBotApi({ fetch: fake.fetch });
    await expect(api.getMe(TOKEN)).resolves.toEqual({
      ok: true,
      botId: 123456789,
      username: 'CellhiveBot',
    });
    expect(fake.calls.map((call) => call.url)).toEqual([
      `https://api.telegram.org/bot${TOKEN}/getMe`,
    ]);
  });

  it.each([
    ['401', 401, { ok: false, error_code: 401 }, {}, { ok: false, kind: 'unauthorized' }],
    ['404 (malformed token path)', 404, { ok: false }, {}, { ok: false, kind: 'unauthorized' }],
    [
      '429',
      429,
      { ok: false, parameters: { retry_after: 5 } },
      {},
      { ok: false, kind: 'rate_limited', retryAfterMs: 5_000 },
    ],
    ['400', 400, { ok: false }, {}, { ok: false, kind: 'rejected', status: 400 }],
    ['500', 500, {}, {}, { ok: false, kind: 'unavailable', cause: 'server_error' }],
    [
      '200 without a username',
      200,
      { ok: true, result: { id: 1 } },
      {},
      { ok: false, kind: 'unavailable', cause: 'server_error' },
    ],
    [
      '200 with a strange username',
      200,
      { ok: true, result: { id: 1, username: 'a b' } },
      {},
      { ok: false, kind: 'unavailable', cause: 'server_error' },
    ],
    [
      '200 that is not JSON',
      200,
      '<html>',
      {},
      { ok: false, kind: 'unavailable', cause: 'server_error' },
    ],
  ])('classifies %s', async (_name, status, body, headers, expected) => {
    const api = new TelegramBotApi({ fetch: fakeFetch(status, body, headers).fetch });
    await expect(api.getMe(TOKEN)).resolves.toEqual(expected);
  });

  it('never calls with a malformed token, and reports network failures', async () => {
    const fake = fakeFetch(200, {});
    const api = new TelegramBotApi({ fetch: fake.fetch });
    await expect(api.getMe('1/../getMe?x')).resolves.toEqual({ ok: false, kind: 'unauthorized' });
    expect(fake.calls).toEqual([]);
    const failing = new TelegramBotApi({
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    await expect(failing.getMe(TOKEN)).resolves.toEqual({
      ok: false,
      kind: 'unavailable',
      cause: 'network',
    });
  });
});

describe('TelegramBotApi.getUpdates (T549)', () => {
  it('long polls with offset, timeout and only messages, and parses what the poller needs', async () => {
    const fake = fakeFetch(200, {
      ok: true,
      result: [
        {
          update_id: 10,
          message: {
            chat: { id: 7001, type: 'private' },
            from: { id: 7001, first_name: 'Name', language_code: 'vi' },
            text: '/start abc',
          },
        },
        { update_id: 11, message: { chat: { id: -100, type: 'group' }, text: 'hi' } },
        { update_id: 12, message: { chat: { id: 7001, type: 'private' }, sticker: {} } },
        { update_id: 13, my_chat_member: {} },
        { update_id: -1 },
        'junk',
      ],
    });
    const api = new TelegramBotApi({ fetch: fake.fetch });
    await expect(api.getUpdates(TOKEN, { offset: 9, timeoutSeconds: 25 })).resolves.toEqual({
      ok: true,
      updates: [
        {
          updateId: 10,
          message: { chatId: '7001', chatType: 'private', text: '/start abc', languageCode: 'vi' },
        },
        {
          updateId: 11,
          message: { chatId: '-100', chatType: 'group', text: 'hi', languageCode: null },
        },
        { updateId: 12, message: null },
        { updateId: 13, message: null },
      ],
    });
    expect(fake.calls[0]).toMatchObject({
      url: `https://api.telegram.org/bot${TOKEN}/getUpdates`,
      body: { offset: 9, timeout: 25, limit: 100, allowed_updates: ['message'] },
    });
    // Without offset (first call of a job).
    await api.getUpdates(TOKEN, { offset: null, timeoutSeconds: 0, limit: 1 });
    expect(fake.calls[1]?.body).toEqual({ timeout: 0, limit: 1, allowed_updates: ['message'] });
  });

  it.each([
    [
      '409 with a webhook',
      409,
      {
        ok: false,
        description: "Conflict: can't use getUpdates method while webhook is active",
      },
      { ok: false, kind: 'conflict', reason: 'webhook' },
    ],
    [
      '409 from another poller',
      409,
      { ok: false, description: 'Conflict: terminated by other getUpdates request' },
      { ok: false, kind: 'conflict', reason: 'poller' },
    ],
    ['409 without description', 409, {}, { ok: false, kind: 'conflict', reason: 'poller' }],
    ['401', 401, { ok: false }, { ok: false, kind: 'unauthorized' }],
    [
      '429',
      429,
      { ok: false, parameters: { retry_after: 2 } },
      { ok: false, kind: 'rate_limited', retryAfterMs: 2_000 },
    ],
    ['400', 400, { ok: false }, { ok: false, kind: 'rejected', status: 400 }],
    ['502', 502, {}, { ok: false, kind: 'unavailable', cause: 'server_error' }],
    [
      '200 with a non-array result',
      200,
      { ok: true, result: {} },
      { ok: false, kind: 'unavailable', cause: 'server_error' },
    ],
  ])('classifies %s', async (_name, status, body, expected) => {
    const api = new TelegramBotApi({ fetch: fakeFetch(status, body).fetch });
    await expect(api.getUpdates(TOKEN, { offset: null, timeoutSeconds: 1 })).resolves.toEqual(
      expected,
    );
  });

  it('gives a long poll its timeout plus a grace before abandoning it', async () => {
    let signal: AbortSignal | undefined;
    const hanging = ((_input: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason as Error);
        });
      });
    }) as typeof fetch;
    // The request timeout of other calls does not cut a long poll short.
    const api = new TelegramBotApi({ fetch: hanging, timeoutMs: 10 });
    const pending = api.getUpdates(TOKEN, { offset: null, timeoutSeconds: 0 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(signal?.aborted).toBe(false);
    void pending;
  });
});

describe('notification bot settings (T549)', () => {
  it.each([
    ['nothing', undefined, NO_TELEGRAM_BOT],
    ['not an object', 'x', NO_TELEGRAM_BOT],
    ['no secret id', { notifications: { telegram_bot_username: 'Bot1' } }, NO_TELEGRAM_BOT],
    [
      'a malformed secret id',
      { notifications: { telegram_bot_secret_id: 'sec_x' } },
      NO_TELEGRAM_BOT,
    ],
    [
      'a full bot',
      {
        notifications: {
          telegram_bot_secret_id: 'sec_0123456789abcdef',
          telegram_bot_id: 42,
          telegram_bot_username: 'CellhiveBot',
          telegram_status: 'webhook_conflict',
        },
      },
      {
        secretId: 'sec_0123456789abcdef',
        botId: 42,
        botUsername: 'CellhiveBot',
        status: 'webhook_conflict',
        deliveryMode: 'polling',
      },
    ],
    [
      'a bot in webhook mode (T609)',
      {
        notifications: {
          telegram_bot_secret_id: 'sec_0123456789abcdef',
          telegram_bot_id: 42,
          telegram_bot_username: 'CellhiveBot',
          telegram_status: 'ok',
          telegram_delivery_mode: 'webhook',
        },
      },
      {
        secretId: 'sec_0123456789abcdef',
        botId: 42,
        botUsername: 'CellhiveBot',
        status: 'ok',
        deliveryMode: 'webhook',
      },
    ],
    [
      'odd values read as unknown',
      {
        notifications: {
          telegram_bot_secret_id: 'sec_0123456789abcdef',
          telegram_bot_id: -1,
          telegram_bot_username: '<b>',
          telegram_status: 'weird',
          telegram_delivery_mode: 'carrier-pigeon',
        },
      },
      {
        secretId: 'sec_0123456789abcdef',
        botId: null,
        botUsername: null,
        status: 'ok',
        deliveryMode: 'polling',
      },
    ],
  ])('reads %s', (_name, settings, expected) => {
    expect(orgTelegramSettingsOf(settings as never)).toEqual(expected);
  });

  it('writes the bot next to other settings and removes it cleanly', () => {
    const settings = { locale: 'vi', notifications: { other: true } };
    const withBot = withOrgTelegramSettings(settings, {
      secretId: 'sec_0123456789abcdef',
      botId: 42,
      botUsername: 'CellhiveBot',
      status: null,
    });
    expect(withBot).toEqual({
      locale: 'vi',
      notifications: {
        other: true,
        telegram_bot_secret_id: 'sec_0123456789abcdef',
        telegram_bot_id: 42,
        telegram_bot_username: 'CellhiveBot',
        telegram_status: 'ok',
        telegram_delivery_mode: 'polling',
      },
    });
    expect(orgTelegramSettingsJson(withBot, NO_TELEGRAM_BOT)).toEqual({ other: true });
    expect(withOrgTelegramSettings(withBot, NO_TELEGRAM_BOT)).toEqual(settings);
  });
});

describe('fixed replies (T549)', () => {
  it.each([
    ['vi', 'vi'],
    ['vi-VN', 'vi'],
    ['VI', 'vi'],
    ['en', 'en'],
    ['fr', 'en'],
    ['video', 'en'],
    [null, 'en'],
    [undefined, 'en'],
  ] as const)('%s → %s', (locale, expected) => {
    expect(replyLanguageOf(locale)).toBe(expected);
  });

  it('have no HTML to escape and no placeholder', () => {
    for (const locale of ['en', 'vi']) {
      for (const reply of ['linked', 'invalid', 'stopped'] as const) {
        const text = telegramLinkReply(reply, locale);
        expect(text).not.toMatch(/[<>&{}]/u);
        expect(text.length).toBeGreaterThan(10);
      }
    }
    expect(telegramLinkReply('invalid', 'vi')).toContain('Link không hợp lệ');
  });
});

describe('TelegramChatAddress (T549)', () => {
  it('seals with a new IV each time, opens only with the same master key, looks up per bot', () => {
    const address = new TelegramChatAddress(Buffer.alloc(32, 3));
    const one = address.seal('7001234567');
    const two = address.seal('7001234567');
    expect(one).not.toBe(two);
    expect(one).not.toContain('7001234567');
    expect(address.unseal(one)).toBe('7001234567');
    expect(() => new TelegramChatAddress(Buffer.alloc(32, 4)).unseal(one)).toThrow();
    const lookup = address.lookup('sec_0123456789abcdef', '7001234567');
    expect(lookup).toMatch(/^[0-9a-f]{64}$/u);
    expect(lookup).toBe(address.lookup('sec_0123456789abcdef', '7001234567'));
    expect(lookup).not.toBe(address.lookup('sec_fedcba9876543210', '7001234567'));
    expect(lookup).not.toBe(
      new TelegramChatAddress(Buffer.alloc(32, 4)).lookup('sec_0123456789abcdef', '7001234567'),
    );
  });
});
