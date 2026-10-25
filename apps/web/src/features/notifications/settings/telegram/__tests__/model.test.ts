import { TELEGRAM_LINK_TOKEN_TTL_MS } from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import {
  botOfLink,
  countdownLabel,
  isTelegramLink,
  LINK_TTL_MS,
  remainingMs,
  telegramView,
  type TelegramViewKind,
} from '../model';
import { qrPath } from '../qr-path';

import type { UserChannelDto, UserChannelListDto } from '@cellhive/contracts';

const NOW = Date.parse('2026-10-17T03:00:00.000Z');
const LATER = '2026-10-17T03:10:00.000Z';
const PAST = '2026-10-17T02:59:59.000Z';
const LINK = {
  link: 'https://t.me/acme_bot?start=AbCdEfGhIjKlMnOpQrStUvWxYz012345',
  expires_at: LATER,
};
const OLD_LINK = { ...LINK, expires_at: PAST };

function channel(overrides: Partial<UserChannelDto>): UserChannelDto {
  return {
    kind: 'telegram',
    status: 'linked',
    error_reason: null,
    linked_at: '2026-10-16T08:00:00.000Z',
    bot_username: 'acme_bot',
    ...overrides,
  };
}

function list(items: UserChannelDto[], available = true): UserChannelListDto {
  return { items, available_kinds: available ? ['telegram'] : [] };
}

describe('telegramView (T555)', () => {
  it.each<[string, UserChannelListDto, typeof LINK | null, boolean, TelegramViewKind]>([
    ['no bot', list([], false), null, false, 'unavailable'],
    [
      'no bot, old error channel',
      list([channel({ status: 'error', error_reason: 'bot_changed' })], false),
      null,
      false,
      'unavailable',
    ],
    ['no bot, link in hand', list([], false), LINK, false, 'unavailable'],
    ['nothing linked', list([]), null, false, 'unlinked'],
    ['linked', list([channel({})]), null, false, 'linked'],
    ['linked wins over a link in hand', list([channel({})]), LINK, true, 'linked'],
    ['link in hand, server not read again yet', list([]), LINK, false, 'linking'],
    [
      'link in hand, server waiting',
      list([channel({ status: 'pending', linked_at: null })]),
      LINK,
      true,
      'linking',
    ],
    [
      'link in hand over an old error',
      list([channel({ status: 'error', error_reason: 'blocked' })]),
      LINK,
      false,
      'linking',
    ],
    ['link cancelled elsewhere (fresh server, nothing waiting)', list([]), LINK, true, 'unlinked'],
    [
      'link cancelled by a bot change',
      list([channel({ status: 'error', error_reason: 'bot_changed', bot_username: 'new_bot' })]),
      LINK,
      true,
      'error',
    ],
    ['link expired', list([]), OLD_LINK, true, 'expired'],
    [
      'link expired, server still says pending',
      list([channel({ status: 'pending', linked_at: null })]),
      OLD_LINK,
      false,
      'expired',
    ],
    [
      'pending made elsewhere',
      list([channel({ status: 'pending', linked_at: null })]),
      null,
      false,
      'pending',
    ],
    [
      'blocked',
      list([channel({ status: 'error', error_reason: 'blocked' })]),
      null,
      false,
      'error',
    ],
    [
      'bot changed',
      list([channel({ status: 'error', error_reason: 'bot_changed' })]),
      null,
      false,
      'error',
    ],
  ])('%s', (_name, channels, link, fresh, expected) => {
    expect(telegramView(channels, link, NOW, fresh).kind).toBe(expected);
  });

  it('keeps the TTL of a link equal to the contract', () => {
    expect(LINK_TTL_MS).toBe(TELEGRAM_LINK_TOKEN_TTL_MS);
  });

  it.each<[string, UserChannelDto, TelegramViewKind]>([
    // Linked at 03:00:05, after the link was made (expires 03:10 → made 03:00): used.
    [
      'used, then blocked',
      channel({ status: 'error', error_reason: 'blocked', linked_at: '2026-10-17T03:00:05.000Z' }),
      'error',
    ],
    [
      'used, then the bot changed',
      channel({
        status: 'error',
        error_reason: 'bot_changed',
        linked_at: '2026-10-17T03:00:05.000Z',
      }),
      'error',
    ],
    // Linked the day before: this link is a new one (link again).
    [
      'an older link, blocked since',
      channel({ status: 'error', error_reason: 'blocked', linked_at: '2026-10-16T08:00:00.000Z' }),
      'linking',
    ],
  ])('a link of this tab: %s', (_name, item, expected) => {
    // Even before the list was read again after the link was made.
    expect(telegramView(list([item]), LINK, NOW, false).kind).toBe(expected);
  });

  it('carries what each state shows', () => {
    expect(telegramView(list([channel({})]), null, NOW)).toEqual({
      kind: 'linked',
      botUsername: 'acme_bot',
      linkedAt: '2026-10-16T08:00:00.000Z',
    });
    expect(telegramView(list([]), LINK, NOW)).toEqual({
      kind: 'linking',
      link: LINK.link,
      expiresAt: LATER,
      remainingMs: 600_000,
      // From the link itself while the server has no channel yet.
      botUsername: 'acme_bot',
    });
    expect(
      telegramView(
        list([channel({ status: 'error', error_reason: 'bot_changed', bot_username: 'new_bot' })]),
        null,
        NOW,
      ),
    ).toEqual({ kind: 'error', reason: 'bot_changed', botUsername: 'new_bot' });
  });
});

describe('link helpers (T555)', () => {
  it.each([
    ['https://t.me/acme_bot?start=abc', 'acme_bot'],
    ['https://t.me/acme%5Fbot?start=abc', 'acme_bot'],
    ['https://example.com/acme_bot?start=abc', null],
    ['https://t.me/a/b?start=abc', null],
    ['not a url', null],
  ])('botOfLink(%s) = %s', (link, expected) => {
    expect(botOfLink(link)).toBe(expected);
  });

  it.each([
    ['https://t.me/acme_bot?start=abc', true],
    ['http://t.me/acme_bot?start=abc', false],
    ['https://t.me.evil.test/acme_bot', false],
    ['javascript:alert(1)', false],
  ])('isTelegramLink(%s) = %s', (link, expected) => {
    expect(isTelegramLink(link)).toBe(expected);
  });

  it.each([
    [600_000, '10:00'],
    [581_000, '9:41'],
    [580_001, '9:41'],
    [59_000, '0:59'],
    [1, '0:01'],
    [0, '0:00'],
    [-5, '0:00'],
  ])('countdownLabel(%i) = %s', (ms, expected) => {
    expect(countdownLabel(ms)).toBe(expected);
  });

  it.each([
    [LATER, 600_000],
    [PAST, 0],
    ['garbage', 0],
  ])('remainingMs(%s) = %i', (expiresAt, expected) => {
    expect(remainingMs(expiresAt, NOW)).toBe(expected);
  });
});

describe('qrPath (T555)', () => {
  it.each<[string, boolean[][], string]>([
    ['empty', [[false, false]], ''],
    ['one module', [[false, true]], 'M1 0h1v1h-1z'],
    [
      'runs per row',
      [
        [true, true, false, true],
        [false, true, true, true],
      ],
      'M0 0h2v1h-2zM3 0h1v1h-1zM1 1h3v1h-3z',
    ],
  ])('%s', (_name, matrix, expected) => {
    expect(qrPath(matrix)).toBe(expected);
  });
});
