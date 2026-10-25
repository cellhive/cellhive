import { describe, expect, it } from 'vitest';

import { NOTIFICATION_CHANNEL_DETAIL_CODES } from '../src/error-details.js';
import { realtimeServerMessageSchema } from '../src/realtime.js';
import { secretUsageSchema, secretUsagesSchema } from '../src/secrets.js';
import {
  orgNotificationChannelsSchema,
  TELEGRAM_LINK_TOKEN_LENGTH,
  TELEGRAM_LINK_TOKEN_PATTERN,
  telegramLinkSchema,
  telegramStartLink,
  UNKNOWN_SECRET,
  updateOrgNotificationChannelsSchema,
  userChannelListSchema,
  userChannelSchema,
} from '../src/user-channels.js';

/** BACKLOG T549 (CONTRACTS §22.7): schemas of the notification bot and personal channels. */
describe('user channels contracts (T549)', () => {
  it.each([
    ['A'.repeat(32), true],
    ['abcdefghijklmnopqrstuvwxyz012_-9', true],
    ['A'.repeat(31), false],
    ['A'.repeat(33), false],
    [`${'A'.repeat(31)}=`, false],
    [`${'A'.repeat(31)}/`, false],
    [`${'A'.repeat(31)} `, false],
    ['', false],
  ])('link token %j matches: %s', (token, ok) => {
    expect(TELEGRAM_LINK_TOKEN_PATTERN.test(token)).toBe(ok);
  });

  it('builds the t.me deep link', () => {
    const token = 'A'.repeat(TELEGRAM_LINK_TOKEN_LENGTH);
    expect(telegramStartLink('acme_bot', token)).toBe(`https://t.me/acme_bot?start=${token}`);
    expect(
      telegramLinkSchema.parse({
        link: telegramStartLink('acme_bot', token),
        expires_at: '2026-10-17T00:10:00.000Z',
      }),
    ).toBeTruthy();
  });

  it('PATCH body: a secret id or null, nothing else', () => {
    expect(updateOrgNotificationChannelsSchema.parse({ telegram_secret_id: null })).toEqual({
      telegram_secret_id: null,
    });
    expect(
      updateOrgNotificationChannelsSchema.safeParse({ telegram_secret_id: 'sec_0123456789abcdef' })
        .success,
    ).toBe(true);
    for (const body of [{}, { telegram_secret_id: 'x' }, { telegram_secret_id: null, other: 1 }]) {
      expect(updateOrgNotificationChannelsSchema.safeParse(body).success).toBe(false);
    }
  });

  it('PATCH body (T609): a delivery mode alone or with the secret; at least one key', () => {
    for (const body of [
      { telegram_delivery_mode: 'webhook' },
      { telegram_delivery_mode: 'polling' },
      { telegram_secret_id: 'sec_0123456789abcdef', telegram_delivery_mode: 'webhook' },
    ]) {
      expect(updateOrgNotificationChannelsSchema.safeParse(body).success).toBe(true);
    }
    for (const body of [
      { telegram_delivery_mode: 'push' },
      { telegram_delivery_mode: null },
      { telegram_delivery_mode: 'webhook', webhook_url: 'https://x.test' },
    ]) {
      expect(updateOrgNotificationChannelsSchema.safeParse(body).success).toBe(false);
    }
  });

  it('responses carry no chat id or name', () => {
    expect(
      orgNotificationChannelsSchema.parse({
        telegram: {
          secret_id: null,
          bot_username: null,
          status: null,
          delivery_mode: null,
          webhook_status: null,
          webhook_available: true,
        },
      }),
    ).toBeTruthy();
    // T609: the webhook mode adds a mode and a status, never a URL or a token; T616 whether
    // the instance can use it (a boolean).
    expect(Object.keys(orgNotificationChannelsSchema.shape.telegram.shape).sort()).toEqual([
      'bot_username',
      'delivery_mode',
      'secret_id',
      'status',
      'webhook_available',
      'webhook_status',
    ]);
    const channel = {
      kind: 'telegram',
      status: 'error',
      error_reason: 'bot_changed',
      linked_at: '2026-10-17T00:00:00.000Z',
      bot_username: 'acme_bot',
    };
    expect(userChannelSchema.parse(channel)).toEqual(channel);
    expect(Object.keys(userChannelSchema.shape).sort()).toEqual([
      'bot_username',
      'error_reason',
      'kind',
      'linked_at',
      'status',
    ]);
    expect(
      userChannelListSchema.parse({ items: [channel], available_kinds: ['telegram'] }).items,
    ).toHaveLength(1);
    expect(userChannelSchema.safeParse({ ...channel, status: 'unlinked' }).success).toBe(false);
  });

  it('secret usages are automations or the notification channel', () => {
    expect(secretUsageSchema.parse({ kind: 'notification_channel' })).toEqual({
      kind: 'notification_channel',
    });
    expect(
      secretUsagesSchema.parse({
        items: [
          { kind: 'notification_channel' },
          {
            kind: 'automation',
            automation_id: 'aut_0123456789abcdef',
            base_id: 'bse_0123456789abcdef',
            name: null,
          },
        ],
        total: 2,
      }).total,
    ).toBe(2);
    expect(
      secretUsageSchema.safeParse({
        automation_id: 'aut_0123456789abcdef',
        base_id: 'bse_0123456789abcdef',
        name: 'x',
      }).success,
    ).toBe(false);
  });

  it('channel.changed is a realtime message with kind and status only', () => {
    const message = {
      type: 'channel.changed',
      channel: 'user:usr_0123456789abcdef',
      organization_id: 'org_0123456789abcdef',
      kind: 'telegram',
      status: 'unlinked',
    };
    expect(realtimeServerMessageSchema.parse(message)).toEqual(message);
    expect(
      realtimeServerMessageSchema.safeParse({ ...message, chat_id: '7001234567' }).success,
    ).toBe(false);
    expect(realtimeServerMessageSchema.safeParse({ ...message, status: 'pending' }).success).toBe(
      false,
    );
  });

  it('detail codes are listed', () => {
    expect(NOTIFICATION_CHANNEL_DETAIL_CODES).toContain(UNKNOWN_SECRET);
    expect(NOTIFICATION_CHANNEL_DETAIL_CODES).toContain('INVALID_BOT_TOKEN');
  });
});
