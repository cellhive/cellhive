import { describe, expect, it } from 'vitest';

import {
  createValkeyTelegramReplyLimiter,
  MemoryTelegramReplyLimiter,
  telegramSecretTokenMatches,
  telegramWebhookPrefix,
} from '../../src/notifications/index.js';

/** BACKLOG T609 (ADR-35 §7): the pure parts of the webhook mode and of the reply cap. */
describe('telegramWebhookPrefix', () => {
  it.each([
    ['https://cellhive.test', 'https://cellhive.test/api/v1/telegram/webhook/'],
    ['https://cellhive.test/', 'https://cellhive.test/api/v1/telegram/webhook/'],
    ['https://cellhive.test:443', 'https://cellhive.test:443/api/v1/telegram/webhook/'],
    ['https://cellhive.test:8443', 'https://cellhive.test:8443/api/v1/telegram/webhook/'],
    ['https://cellhive.test:88', 'https://cellhive.test:88/api/v1/telegram/webhook/'],
    ['https://cellhive.test:80', 'https://cellhive.test:80/api/v1/telegram/webhook/'],
    ['https://cellhive.test:3000', null],
    ['http://cellhive.test', null],
    ['http://localhost:3000', null],
    ['not a url', null],
  ])('%s → %s', (publicUrl, expected) => {
    expect(telegramWebhookPrefix(publicUrl)).toBe(expected);
  });
});

describe('telegramSecretTokenMatches', () => {
  const secret = 'a'.repeat(32) + 'B_-'.repeat(10) + 'cd';
  it.each([
    ['the same token', secret, true],
    ['a missing header', undefined, false],
    ['an empty header', '', false],
    ['one more character', `${secret}x`, false],
    ['one character less', secret.slice(1), false],
    ['another token', 'z'.repeat(64), false],
  ])('%s', (_name, given, expected) => {
    expect(telegramSecretTokenMatches(secret, given)).toBe(expected);
  });

  it('never matches when the stored token is unusable (cannot be unsealed)', () => {
    expect(telegramSecretTokenMatches('', '')).toBe(false);
  });
});

describe('MemoryTelegramReplyLimiter', () => {
  it('allows 3 per key in a sliding hour', async () => {
    const limiter = new MemoryTelegramReplyLimiter();
    const at = (minutes: number) => new Date(Date.UTC(2026, 9, 18, 10, 0) + minutes * 60_000);
    const results: boolean[] = [];
    for (const minute of [0, 1, 2, 3, 59]) results.push(await limiter.take('chat', at(minute)));
    expect(results).toEqual([true, true, true, false, false]);
    // Another chat has its own budget.
    expect(await limiter.take('other', at(3))).toBe(true);
    // The first take leaves the window after one hour.
    expect(await limiter.take('chat', at(60.5))).toBe(true);
    expect(await limiter.take('chat', at(60.6))).toBe(false);
  });
});

describe('createValkeyTelegramReplyLimiter', () => {
  it('passes the window and limit to one script and fails closed', async () => {
    const calls: unknown[][] = [];
    const ok = createValkeyTelegramReplyLimiter(
      {
        eval: (...args: unknown[]) => {
          calls.push(args);
          return Promise.resolve(1);
        },
        get: () => Promise.resolve(null),
      },
      { keyPrefix: 'ob:test:' },
    );
    const now = new Date(1_000_000);
    expect(await ok.take('bot:1:reply:abc', now)).toBe(true);
    expect(calls[0]?.slice(1, 6)).toEqual([
      1,
      'ob:test:telegram:invalid-reply:bot:1:reply:abc',
      1_000_000,
      3_600_000,
      3,
    ]);
    const down = createValkeyTelegramReplyLimiter({
      eval: () => Promise.reject(new Error('connection refused')),
      get: () => Promise.resolve(null),
    });
    expect(await down.take('k', now)).toBe(false);
  });
});
