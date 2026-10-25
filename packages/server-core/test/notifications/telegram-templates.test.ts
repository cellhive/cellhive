/**
 * BACKLOG T550: the Telegram message of notifications (fixed headline per
 * type, values escaped one by one, safe links only, ≤ 10 items and ≤ 4,096
 * visible characters, "and N more"), and the keys of the Telegram limits.
 */
import {
  NOTIFICATION_TELEGRAM_MAX_CHARS,
  NOTIFICATION_TELEGRAM_MAX_ITEMS,
} from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import {
  telegramBotPacerKey,
  telegramChatPacerKey,
} from '../../src/automation/actions/send-telegram/index.js';
import {
  renderNotificationTelegram,
  telegramVisibleLength,
  type NotificationTelegramInput,
} from '../../src/notifications/index.js';

import type { NotificationEmailItem } from '../../src/mail/index.js';

const AT = new Date('2026-10-17T03:00:00.000Z');
const URL = 'https://ob.example.test/b/bse_1/t/tbl_1?record=rec_1';

const message = (
  title: string,
  body = 'Body',
  overrides: Partial<NotificationEmailItem> = {},
): NotificationEmailItem =>
  ({
    type: 'automation.message',
    createdAt: AT,
    baseName: 'Sales',
    automationName: null,
    recordTitle: 'Order R1',
    url: URL,
    title,
    body,
    ...overrides,
  }) as NotificationEmailItem;

const input = (
  items: readonly NotificationEmailItem[],
  overrides: Partial<NotificationTelegramInput> = {},
): NotificationTelegramInput => ({
  locale: 'en',
  timeZone: 'UTC',
  organizationName: 'Acme',
  items,
  moreUrl: 'https://ob.example.test/o/acme',
  manageUrl: 'https://ob.example.test/o/acme/settings/notifications',
  ...overrides,
});

/** Tags of a Telegram HTML text, in order. */
const tagsOf = (html: string) => [...html.matchAll(/<\/?([a-z]+)[^>]*>/gu)].map((m) => m[0]);

describe('renderNotificationTelegram (T550)', () => {
  it('one item: header, headline, base and record, body, link — in English', () => {
    const { text, shown, more } = renderNotificationTelegram(input([message('Deal won')]));
    expect({ shown, more }).toEqual({ shown: 1, more: 0 });
    expect(text).toBe(
      [
        '<b>New notification in Acme</b>',
        [
          '<b>Deal won</b>',
          '<i>Base: Sales · Record: Order R1</i>',
          'Body',
          `<a href="${URL.replace(/&/gu, '&amp;')}">Open in Cellhive</a>`,
        ].join('\n'),
        '<a href="https://ob.example.test/o/acme/settings/notifications">Manage notifications</a>',
      ].join('\n\n'),
    );
  });

  it('Vietnamese, several items: the count in the header, one block per item', () => {
    const { text } = renderNotificationTelegram(
      input([message('Tin A'), message('Tin B'), message('Tin C')], { locale: 'vi-VN' }),
    );
    expect(text.startsWith('<b>3 thông báo mới trong Acme</b>')).toBe(true);
    expect(text).toContain('<i>Base: Sales · Bản ghi: Order R1</i>');
    expect(text).toContain('Mở trong Cellhive');
    expect(text).toContain('Quản lý thông báo');
    expect(text.indexOf('Tin A')).toBeLessThan(text.indexOf('Tin B'));
    expect(text.indexOf('Tin B')).toBeLessThan(text.indexOf('Tin C'));
  });

  it.each([
    ['a primary field with tags', { recordTitle: '<b>x</b>' }, '&lt;b&gt;x&lt;/b&gt;'],
    ['a base name with an ampersand', { baseName: 'R&D <team>' }, 'R&amp;D &lt;team&gt;'],
    [
      'a title with a link tag',
      { title: '<a href="https://evil.test">click</a>' },
      '&lt;a href=&quot;https://evil.test&quot;&gt;click&lt;/a&gt;',
    ],
    [
      'a body with HTML',
      { body: '<i>not italic</i> & "quoted"' },
      '&lt;i&gt;not italic&lt;/i&gt; &amp; &quot;quoted&quot;',
    ],
    ['an organization name', {}, 'Acme &amp; Co'],
  ] as const)('escapes %s (shown literally)', (_name, overrides, expected) => {
    const { text } = renderNotificationTelegram(
      input([message('Title', 'Body', overrides)], {
        organizationName: _name === 'an organization name' ? 'Acme & Co' : 'Acme',
      }),
    );
    expect(text).toContain(expected);
    // Only the template's own tags remain.
    for (const tag of tagsOf(text)) expect(tag).toMatch(/^<\/?(b|i|a)( href="[^"]*")?>$/u);
  });

  it.each([
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/html,<b>x</b>'],
    ['a relative path', '/b/bse_1'],
  ])('leaves out a link that is not http(s) (%s)', (_name, url) => {
    const { text } = renderNotificationTelegram(input([message('Title', 'Body', { url })]));
    expect(text).not.toContain('Open in Cellhive');
    expect(text).not.toContain(url);
  });

  it('no base, no record, no url: only the headline', () => {
    const { text } = renderNotificationTelegram(
      input([message('Only', '', { baseName: null, recordTitle: null, url: null })], {
        manageUrl: null,
      }),
    );
    expect(text).toBe('<b>New notification in Acme</b>\n\n<b>Only</b>');
  });

  it.each([
    [
      'automation.disabled',
      { type: 'automation.disabled', reason: 'circuit_breaker', automationName: 'Nightly' },
      'The automation “Nightly” was turned off after failing repeatedly',
    ],
    [
      'automation.batch_overflow',
      { type: 'automation.batch_overflow', limit: 1000, skipped: 4000, automationName: 'Sync' },
      'The automation “Sync” skipped 4,000 records of a bulk change (limit 1,000 runs per change)',
    ],
    [
      'record.assigned (one)',
      { type: 'record.assigned', count: 1, tableName: 'Orders', records: [] },
      'You were assigned a record in “Orders”',
    ],
    [
      'record.followed_changed',
      { type: 'record.followed_changed', changeCount: 3 },
      'A record you follow was changed (3 changes)',
    ],
    [
      'record.assigned from a webhook (T608)',
      { type: 'record.assigned', count: 200, tableName: 'Orders', records: [], viaWebhook: true },
      'You were assigned 200 records in “Orders” via a webhook',
    ],
    [
      'record.followed_changed from a webhook (T608)',
      {
        type: 'record.followed_changed',
        changeCount: 30,
        viaWebhook: true,
        recordCount: 3,
        records: [],
      },
      '3 records you follow were changed via a webhook (30 changes)',
    ],
    [
      'date.reminder',
      { type: 'date.reminder', fieldName: 'Due', value: '2026-10-20' },
      'Reminder: “Due” is due 20 Oct 2026',
    ],
    [
      'import.finished',
      {
        type: 'import.finished',
        status: 'succeeded',
        tableName: 'Orders',
        created: 5,
        updated: 2,
        failedRows: 0,
      },
      'Import into “Orders” finished: 5 created, 2 updated, 0 rows failed',
    ],
  ])('the fixed headline of %s is the email one', (_name, item, headline) => {
    const { text } = renderNotificationTelegram(
      input([
        {
          createdAt: AT,
          baseName: 'Sales',
          automationName: null,
          recordTitle: null,
          url: URL,
          ...item,
        } as NotificationEmailItem,
      ]),
    );
    expect(text).toContain(`<b>${headline}</b>`);
  });

  it('a grouped record.assigned lists the readable records with their links and counts the rest', () => {
    const { text } = renderNotificationTelegram(
      input([
        {
          type: 'record.assigned',
          createdAt: AT,
          baseName: 'Sales',
          automationName: null,
          recordTitle: null,
          url: 'https://ob.example.test/b/bse_1/t/tbl_1',
          count: 25,
          tableName: 'Orders',
          records: [
            { title: 'R1 <x>', url: 'https://ob.example.test/b/bse_1/t/tbl_1?record=rec_1' },
            { title: null, url: null },
          ],
        },
      ]),
    );
    expect(text).toContain('<b>You were assigned 25 records in “Orders”</b>');
    expect(text).toContain(
      '• <a href="https://ob.example.test/b/bse_1/t/tbl_1?record=rec_1">R1 &lt;x&gt;</a>',
    );
    expect(text).toContain('• (untitled record)');
    expect(text).toContain('And 23 more');
  });

  it('import.finished links the report of the failed rows only when there is one', () => {
    const base = {
      type: 'import.finished',
      createdAt: AT,
      baseName: 'Sales',
      automationName: null,
      recordTitle: null,
      url: null,
      status: 'succeeded',
      tableName: 'Orders',
      created: 1,
      updated: 0,
      failedRows: 2,
    } as const;
    const withReport = renderNotificationTelegram(
      input([{ ...base, reportUrl: 'https://ob.example.test/api/v1/files/exports/job_1' }]),
    ).text;
    expect(withReport).toContain(
      '<a href="https://ob.example.test/api/v1/files/exports/job_1">Download the report',
    );
    const without = renderNotificationTelegram(input([{ ...base, reportUrl: null }])).text;
    expect(without).not.toContain('Download the report');
  });

  it(`shows at most ${String(NOTIFICATION_TELEGRAM_MAX_ITEMS)} items, the rest counted with a link`, () => {
    const items = Array.from({ length: 14 }, (_, i) => message(`Item ${String(i + 1)}`));
    const { text, shown, more } = renderNotificationTelegram(input(items));
    expect({ shown, more }).toEqual({ shown: 10, more: 4 });
    expect(text.startsWith('<b>14 new notifications in Acme</b>')).toBe(true);
    expect(text).toContain('Item 10');
    expect(text).not.toContain('Item 11');
    expect(text).toContain(
      '<a href="https://ob.example.test/o/acme">And 4 more notifications: see them in Cellhive.</a>',
    );
    const vi = renderNotificationTelegram(input(items, { locale: 'vi' })).text;
    expect(vi).toContain('Và 4 thông báo khác: xem trong Cellhive.');
  });

  it('long bodies: fewer items so that the message stays within 4,096 characters', () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      message(`Long ${String(i + 1)}`, 'x'.repeat(1_500)),
    );
    const { text, shown, more } = renderNotificationTelegram(input(items));
    expect(telegramVisibleLength(text)).toBeLessThanOrEqual(NOTIFICATION_TELEGRAM_MAX_CHARS);
    expect(shown).toBeLessThan(10);
    expect(shown + more).toBe(10);
    expect(text).toContain(`And ${String(more)} more notifications`);
  });

  it('one item too long by itself: its body is shortened, the tags stay balanced', () => {
    const item = message('<'.repeat(200), '&'.repeat(2_000), {
      recordTitle: '"'.repeat(5_000),
      baseName: '>'.repeat(5_000),
    });
    const { text, shown } = renderNotificationTelegram(input([item]));
    expect(shown).toBe(1);
    expect(telegramVisibleLength(text)).toBeLessThanOrEqual(NOTIFICATION_TELEGRAM_MAX_CHARS);
    const opened = tagsOf(text).filter((tag) => !tag.startsWith('</')).length;
    const closed = tagsOf(text).filter((tag) => tag.startsWith('</')).length;
    expect(opened).toBe(closed);
  });

  it('a grouped record.assigned with 20 very long titles still fits', () => {
    const { text } = renderNotificationTelegram(
      input([
        {
          type: 'record.assigned',
          createdAt: AT,
          baseName: 'B'.repeat(300),
          automationName: null,
          recordTitle: null,
          url: 'https://ob.example.test/b/bse_1/t/tbl_1',
          count: 20,
          tableName: 'T'.repeat(300),
          records: Array.from({ length: 20 }, () => ({
            title: 'é'.repeat(1_000),
            url: 'https://ob.example.test/b/bse_1/t/tbl_1?record=rec_1',
          })),
        },
      ]),
    );
    expect(telegramVisibleLength(text)).toBeLessThanOrEqual(NOTIFICATION_TELEGRAM_MAX_CHARS);
  });

  it('control characters and line breaks of names are flattened; body lines are kept', () => {
    const { text } = renderNotificationTelegram(
      input([message('Title\nInjected', 'Line 1\r\nLine 2\u0007', { baseName: 'Sa‮les' })]),
    );
    expect(text).toContain('<b>Title Injected</b>');
    expect(text).toContain('Base: Sales');
    expect(text).toContain('Line 1\nLine 2');
    expect(text).not.toContain('\u0007');
  });

  it('refuses an empty list', () => {
    expect(() => renderNotificationTelegram(input([]))).toThrow(RangeError);
  });
});

describe('telegramVisibleLength (T550)', () => {
  it.each([
    ['plain', 'abc', 3],
    ['tags dropped', '<b>abc</b>', 3],
    ['entities count once', '&lt;b&gt; &amp; &quot;', 7],
    ['links', '<a href="https://x.test/?a=1&amp;b=2">go</a>', 2],
    ['astral characters are two UTF-16 units', '😀', 2],
  ])('%s', (_name, html, expected) => {
    expect(telegramVisibleLength(html)).toBe(expected);
  });
});

describe('Telegram limit keys (T550)', () => {
  it.each([
    ['123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0', 'bot:123456789'],
    ['987654321:BBHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw9', 'bot:987654321'],
    ['not-a-token', 'bot:invalid'],
    [':AAH', 'bot:invalid'],
  ])('bot bucket of %s → %s (the bot id, never the secret part)', (token, key) => {
    expect(telegramBotPacerKey(token)).toBe(key);
    expect(telegramBotPacerKey(token)).not.toContain('AAH');
  });

  it('chat bucket by channel id, never the chat id', () => {
    expect(telegramChatPacerKey('uch_A1b2C3d4E5f6G7h8')).toBe('chat:uch_A1b2C3d4E5f6G7h8');
  });
  it('a webhook record.followed_changed lists the readable records and counts the rest (T608)', () => {
    const { text } = renderNotificationTelegram(
      input([
        {
          type: 'record.followed_changed',
          createdAt: AT,
          baseName: 'Sales',
          automationName: null,
          recordTitle: null,
          url: 'https://ob.example.test/b/bse_1/t/tbl_1',
          changeCount: 30,
          viaWebhook: true,
          recordCount: 5,
          records: [
            { title: 'Order <1>', url: 'https://ob.example.test/b/bse_1/t/tbl_1?record=rec_1' },
            { title: null, url: null },
          ],
        },
      ]),
    );
    expect(text).toContain(
      '• <a href="https://ob.example.test/b/bse_1/t/tbl_1?record=rec_1">Order &lt;1&gt;</a>',
    );
    expect(text).toContain('• (untitled record)');
    expect(text).toContain('And 3 more');
  });
});
