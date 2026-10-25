import { describe, expect, it } from 'vitest';

import {
  EMAIL_MAX_WIDTH_PX,
  renderNotificationEmail,
  sanitizeEmailHtml,
  type NotificationEmailInput,
  type NotificationEmailItem,
} from '../../src/mail/index.js';
import { localHourOf, localeOf, timeZoneOf } from '../../src/notifications/index.js';

import type { Organization } from '../../src/db/schema.js';

const AT = new Date('2026-10-05T01:15:00.000Z');
const MANAGE = 'https://ob.example.test/o/acme/settings/notifications';

const message = (overrides: Partial<NotificationEmailItem> = {}): NotificationEmailItem =>
  ({
    type: 'automation.message',
    createdAt: AT,
    baseName: 'Bán hàng',
    automationName: 'Nhắc đơn',
    recordTitle: 'Đơn R1',
    url: 'https://ob.example.test/b/bse_1/t/tbl_1?record=rec_1',
    title: 'Đơn cần duyệt',
    body: 'Dòng 1\nDòng 2\n\nĐoạn 2',
    ...overrides,
  }) as NotificationEmailItem;

const disabled: NotificationEmailItem = {
  type: 'automation.disabled',
  reason: 'circuit_breaker',
  createdAt: AT,
  baseName: 'Sales',
  automationName: 'Escalate',
  recordTitle: null,
  url: 'https://ob.example.test/b/bse_1/automations/aut_1',
};

const overflow: NotificationEmailItem = {
  type: 'automation.batch_overflow',
  limit: 1000,
  skipped: null,
  createdAt: AT,
  baseName: null,
  automationName: null,
  recordTitle: null,
  url: null,
};

function input(overrides: Partial<NotificationEmailInput> = {}): NotificationEmailInput {
  return {
    locale: 'en',
    timeZone: 'Asia/Ho_Chi_Minh',
    mode: 'immediate',
    organizationName: 'Acme',
    recipientName: 'An',
    items: [disabled],
    manageUrl: MANAGE,
    now: AT,
    ...overrides,
  };
}

describe('renderNotificationEmail (T512)', () => {
  it.each([
    {
      name: 'one item: its headline is the subject (en)',
      input: input(),
      subject: 'The automation “Escalate” was turned off after failing repeatedly',
      text: ['Hello An,', 'You have a new notification in Acme.', 'Base: Sales'],
    },
    {
      name: 'one automation message: its title is the subject (vi)',
      input: input({ locale: 'vi-VN', items: [message()] }),
      subject: 'Đơn cần duyệt',
      text: ['Xin chào An,', 'Bản ghi: Đơn R1', 'Dòng 1\nDòng 2', 'Đoạn 2', 'Quản lý thông báo'],
    },
    {
      name: 'several items: a count subject',
      input: input({ items: [disabled, overflow, message()] }),
      subject: '3 new notifications',
      text: [
        'You have 3 new notifications in Acme.',
        'An automation skipped part of a bulk change (more than 1,000 records)',
      ],
    },
    {
      name: 'daily summary: dated subject in the recipient time zone',
      input: input({ mode: 'daily', locale: 'vi', items: [disabled, overflow] }),
      subject: 'Tóm tắt ngày 5 thg 10, 2026: 2 thông báo',
      text: ['Tóm tắt hằng ngày của Acme: 2 thông báo.'],
    },
    {
      name: 'more items than shown: counted with a link',
      input: input({ items: [disabled], moreCount: 4, moreUrl: 'https://ob.example.test/o/acme' }),
      subject: '5 new notifications',
      text: ['And 4 more notifications: see them in Cellhive. (https://ob.example.test/o/acme)'],
    },
  ])('$name', ({ input: data, subject, text }) => {
    const email = renderNotificationEmail(data);
    expect(email.subject).toBe(subject);
    for (const part of text) expect(email.text).toContain(part);
    // Footer: manage link in both parts, after the separator in text.
    expect(email.html).toContain(`href="${MANAGE}"`);
    expect(email.text.split('\n---\n')[1]).toContain(MANAGE);
    // Fixed layout of T513; the body already passes the second sanitizer layer.
    expect(email.html).toContain(`max-width:${String(EMAIL_MAX_WIDTH_PX)}px`);
    expect(email.html).toContain('<meta name="color-scheme" content="light dark">');
  });

  it('formats times in the recipient zone', () => {
    const email = renderNotificationEmail(input({ timeZone: 'Asia/Ho_Chi_Minh' }));
    // 01:15 UTC = 08:15 in Ho Chi Minh City.
    expect(email.text).toContain('08:15');
    const utc = renderNotificationEmail(input({ timeZone: 'UTC' }));
    expect(utc.text).toContain('01:15');
  });

  it.each([
    { field: 'title', value: '<script>alert(1)</script>' },
    { field: 'body', value: '[click](javascript:alert(1)) **bold** <img src=x onerror=1>' },
    { field: 'recordTitle', value: '<a href="https://evil.test">x</a>' },
    { field: 'baseName', value: '<b>base</b>' },
  ])('content is text, never markup: $field', ({ field, value }) => {
    const email = renderNotificationEmail(input({ items: [message({ [field]: value })] }));
    // Only tags the template wrote: values are escaped text.
    expect(email.html).not.toMatch(/<script|<img|href="javascript|<a href="https:\/\/evil|<b>/i);
    // Markdown syntax in values stays literal.
    if (field === 'body') expect(email.text).toContain('**bold**');
    // The sanitizer has nothing left to remove from the body.
    const body =
      /<td style="padding:24px;[^"]*">([\s\S]*?)<\/td><\/tr>\n<tr><td style="padding:16px/.exec(
        email.html,
      )?.[1];
    expect(body).toBeDefined();
    expect(sanitizeEmailHtml(body ?? '')).toBe(body);
  });

  it('control characters and line breaks never reach the subject', () => {
    const email = renderNotificationEmail(
      input({ items: [message({ title: 'Hi\r\nBcc: evil@example.test\u0007' })] }),
    );
    expect(email.subject).toBe('Hi Bcc: evil@example.test');
  });

  it('a link only to http(s): other urls leave the headline as text', () => {
    const email = renderNotificationEmail(
      input({ items: [message({ url: 'javascript:alert(1)' })] }),
    );
    expect(email.html).not.toContain('javascript:');
    expect(email.html).toContain('Đơn cần duyệt');
  });

  it('refuses an email without items', () => {
    expect(() => renderNotificationEmail(input({ items: [] }))).toThrow(RangeError);
  });
});

interface S5bCase {
  readonly name: string;
  readonly item: NotificationEmailItem;
  readonly locale: string;
  readonly subject: string;
  readonly text: readonly string[];
  readonly absent: readonly string[];
}

describe('S5b items (T542): one fixed headline per type, en and vi', () => {
  const TABLE_URL = 'https://ob.example.test/b/bse_1/t/tbl_1';
  const common = {
    createdAt: AT,
    baseName: 'Bán hàng',
    automationName: null,
    recordTitle: null,
    url: TABLE_URL,
  };
  const assigned = (count: number, records: number, tableName: string | null = 'Đơn hàng') =>
    ({
      ...common,
      type: 'record.assigned',
      count,
      tableName,
      records: Array.from({ length: records }, (_, i) => ({
        title: i === 1 ? null : `Đơn ${String(i + 1)}`,
        url: `${TABLE_URL}?record=rec_${String(i + 1)}`,
      })),
    }) as NotificationEmailItem;

  it.each<S5bCase>([
    {
      name: 'record.assigned grouped (vi): count, table, at most the records given, the rest counted',
      item: assigned(37, 20),
      locale: 'vi',
      subject: 'Bạn được gán 37 bản ghi trong “Đơn hàng”',
      text: [
        'Đơn 1',
        '(bản ghi không có tiêu đề)',
        'Đơn 20',
        'Và 17 bản ghi khác',
        `Mở trong Cellhive (${TABLE_URL})`,
      ],
      absent: ['Đơn 21'],
    },
    {
      name: 'record.assigned grouped (en), 4 000 records',
      item: assigned(4000, 2),
      locale: 'en',
      subject: 'You were assigned 4,000 records in “Đơn hàng”',
      text: ['Đơn 1', '(untitled record)', 'And 3,998 more'],
      absent: [],
    },
    {
      name: 'record.assigned single: the record is the item record',
      item: { ...assigned(1, 0), recordTitle: 'Đơn R1' },
      locale: 'en',
      subject: 'You were assigned a record in “Đơn hàng”',
      text: ['Record: Đơn R1'],
      absent: ['more'],
    },
    {
      name: 'record.assigned without a readable table name (vi)',
      item: assigned(1, 0, null),
      locale: 'vi',
      subject: 'Bạn được gán một bản ghi',
      text: [],
      absent: [],
    },
    {
      name: 'record.followed_changed (vi), several changes',
      item: {
        ...common,
        type: 'record.followed_changed',
        changeCount: 3,
        recordTitle: 'Đơn R1',
      },
      locale: 'vi',
      subject: 'Bản ghi bạn theo dõi đã thay đổi (3 thay đổi)',
      text: ['Bản ghi: Đơn R1'],
      absent: [],
    },
    {
      name: 'record.followed_changed (en), one change',
      item: { ...common, type: 'record.followed_changed', changeCount: 1 },
      locale: 'en',
      subject: 'A record you follow was changed',
      text: [],
      absent: [],
    },
    {
      name: 'record.assigned from a webhook (vi, T608): "qua webhook", records listed',
      item: { ...assigned(200, 20), viaWebhook: true } as NotificationEmailItem,
      locale: 'vi',
      subject: 'Bạn được gán 200 bản ghi trong “Đơn hàng” qua webhook',
      text: ['Đơn 1', 'Đơn 20', 'Và 180 bản ghi khác'],
      absent: ['Đơn 21'],
    },
    {
      name: 'record.assigned from a webhook (en, T608), one record: still listed (the item is the table)',
      item: { ...assigned(1, 1), viaWebhook: true } as NotificationEmailItem,
      locale: 'en',
      subject: 'You were assigned a record in “Đơn hàng” via a webhook',
      text: ['Đơn 1'],
      absent: ['more'],
    },
    {
      name: 'record.followed_changed from a webhook (en, T608): records, changes, list',
      item: {
        ...common,
        type: 'record.followed_changed',
        changeCount: 30,
        viaWebhook: true,
        recordCount: 23,
        records: [
          { title: 'Đơn 1', url: `${TABLE_URL}?record=rec_1` },
          { title: null, url: `${TABLE_URL}?record=rec_2` },
        ],
      },
      locale: 'en',
      subject: '23 records you follow were changed via a webhook (30 changes)',
      text: ['Đơn 1', '(untitled record)', 'And 21 more'],
      absent: [],
    },
    {
      name: 'record.followed_changed from a webhook (vi, T608), one record, one change',
      item: {
        ...common,
        type: 'record.followed_changed',
        changeCount: 1,
        viaWebhook: true,
        recordCount: 1,
        records: [{ title: 'Đơn 1', url: `${TABLE_URL}?record=rec_1` }],
      },
      locale: 'vi',
      subject: 'Bản ghi bạn theo dõi đã thay đổi qua webhook',
      text: ['Đơn 1'],
      absent: ['khác'],
    },
    {
      name: 'date.reminder, date-only value: the calendar day, no time zone shift (en)',
      item: {
        ...common,
        type: 'date.reminder',
        fieldName: 'Hạn giao',
        value: '2026-10-20',
      },
      locale: 'en',
      subject: 'Reminder: “Hạn giao” is due 20 Oct 2026',
      text: [],
      absent: [],
    },
    {
      name: 'date.reminder, instant: in the recipient time zone (vi)',
      item: {
        ...common,
        type: 'date.reminder',
        fieldName: 'Hạn giao',
        value: '2026-10-20T02:00:00.000Z',
      },
      locale: 'vi',
      subject: 'Nhắc hạn: “Hạn giao” đến hạn 09:00 20 thg 10, 2026',
      text: [],
      absent: [],
    },
    {
      name: 'import.finished succeeded with failed rows (en)',
      item: {
        ...common,
        type: 'import.finished',
        status: 'succeeded',
        tableName: 'Đơn hàng',
        created: 4990,
        updated: 0,
        failedRows: 10,
      },
      locale: 'en',
      subject: 'Import into “Đơn hàng” finished: 4,990 created, 0 updated, 10 rows failed',
      text: [],
      absent: [],
    },
    {
      name: 'import.finished failed (vi)',
      item: {
        ...common,
        type: 'import.finished',
        status: 'failed',
        tableName: 'Đơn hàng',
        created: 0,
        updated: 0,
        failedRows: 0,
      },
      locale: 'vi',
      subject: 'Nhập dữ liệu vào “Đơn hàng” thất bại',
      text: [],
      absent: [],
    },
    {
      name: 'import.finished cancelled, table no longer readable (en)',
      item: {
        ...common,
        type: 'import.finished',
        status: 'cancelled',
        tableName: null,
        created: 3,
        updated: 0,
        failedRows: 0,
      },
      locale: 'en',
      subject: 'Your import was cancelled',
      text: [],
      absent: [],
    },
    {
      name: 'import.finished with its report of failed rows (T548, en)',
      item: {
        ...common,
        type: 'import.finished',
        status: 'succeeded',
        tableName: 'Orders',
        created: 990,
        updated: 0,
        failedRows: 10,
        reportUrl: 'https://ob.example.test/api/v1/files/exports/job_1',
      },
      locale: 'en',
      subject: 'Import into “Orders” finished: 990 created, 0 updated, 10 rows failed',
      text: [
        'Download the report of the rows that failed (available for 24 hours) (https://ob.example.test/api/v1/files/exports/job_1)',
        `Open in Cellhive (${TABLE_URL})`,
      ],
      absent: [],
    },
    {
      name: 'import.finished with its report of failed rows (T548, vi)',
      item: {
        ...common,
        type: 'import.finished',
        status: 'succeeded',
        tableName: 'Đơn hàng',
        created: 990,
        updated: 0,
        failedRows: 10,
        reportUrl: 'https://ob.example.test/api/v1/files/exports/job_1',
      },
      locale: 'vi',
      subject: 'Nhập dữ liệu vào “Đơn hàng” đã xong: 990 tạo mới, 0 cập nhật, 10 dòng lỗi',
      text: ['Tải báo cáo các dòng lỗi (có trong 24 giờ)'],
      absent: [],
    },
    {
      name: 'import.finished: no report line without a report, failed rows or a safe link (T548)',
      item: {
        ...common,
        type: 'import.finished',
        status: 'succeeded',
        tableName: 'Orders',
        created: 5,
        updated: 0,
        failedRows: 0,
        reportUrl: 'https://ob.example.test/api/v1/files/exports/job_1',
      },
      locale: 'en',
      subject: 'Import into “Orders” finished: 5 created, 0 updated, 0 rows failed',
      text: [],
      absent: ['report', 'files/exports'],
    },
    {
      name: 'import.finished: an unsafe report link is never written (T548)',
      item: {
        ...common,
        type: 'import.finished',
        status: 'succeeded',
        tableName: 'Orders',
        created: 5,
        updated: 0,
        failedRows: 2,
        reportUrl: 'javascript:alert(1)',
      },
      locale: 'en',
      subject: 'Import into “Orders” finished: 5 created, 0 updated, 2 rows failed',
      text: [],
      absent: ['report', 'javascript'],
    },
    {
      name: 'import.finished failed: no report line (T548)',
      item: {
        ...common,
        type: 'import.finished',
        status: 'failed',
        tableName: 'Orders',
        created: 0,
        updated: 0,
        failedRows: 0,
        reportUrl: null,
      },
      locale: 'en',
      subject: 'Import into “Orders” failed',
      text: [],
      absent: ['report'],
    },
    {
      name: 'automation.batch_overflow with the records left out (QA S5 L6, en)',
      item: { ...overflow, automationName: 'Gửi mail', skipped: 4000 },
      locale: 'en',
      subject:
        'The automation “Gửi mail” skipped 4,000 records of a bulk change (limit 1,000 runs per change)',
      text: [],
      absent: [],
    },
    {
      name: 'automation.batch_overflow with the records left out (vi)',
      item: { ...overflow, automationName: 'Gửi mail', skipped: 4000 },
      locale: 'vi',
      subject:
        'Automation “Gửi mail” đã bỏ qua 4.000 bản ghi của một thay đổi hàng loạt (giới hạn 1.000 lần chạy mỗi thay đổi)',
      text: [],
      absent: [],
    },
  ])('$name', ({ item, locale, subject, text, absent }) => {
    const email = renderNotificationEmail(input({ locale, items: [item] }));
    expect(email.subject).toBe(subject);
    for (const part of text) expect(email.text).toContain(part);
    for (const part of absent) expect(email.text).not.toContain(part);
  });

  it('record titles of an assignment are text with their own links, never markup', () => {
    const item = {
      ...assigned(2, 2),
      records: [
        { title: '<img src=x onerror=1>', url: `${TABLE_URL}?record=rec_1` },
        { title: '[x](javascript:alert(1))', url: 'javascript:alert(1)' },
      ],
    } as NotificationEmailItem;
    const email = renderNotificationEmail(input({ items: [item] }));
    expect(email.html).not.toMatch(/<img|href="javascript/i);
    expect(email.html).toContain(`href="${TABLE_URL}?record=rec_1"`);
    expect(email.text).toContain('[x](javascript:alert(1))');
  });
});

describe('recipient time zone and language (T512)', () => {
  const org = (settings: Record<string, unknown>) => ({ settings }) as unknown as Organization;
  const defaults = { timeZone: 'UTC', locale: 'en' };

  it.each([
    { user: 'Asia/Ho_Chi_Minh', org: 'Europe/Paris', expected: 'Asia/Ho_Chi_Minh' },
    { user: null, org: 'Europe/Paris', expected: 'Europe/Paris' },
    { user: 'Not/AZone', org: 'Also/Bad', expected: 'UTC' },
    { user: null, org: undefined, expected: 'UTC' },
  ])('time zone: user $user, org $org → $expected', ({ user, org: zone, expected }) => {
    expect(timeZoneOf({ timezone: user }, org({ timezone: zone }), defaults)).toBe(expected);
  });

  it.each([
    { user: 'vi', org: 'en', expected: 'vi' },
    { user: null, org: 'vi', expected: 'vi' },
    { user: null, org: undefined, expected: 'en' },
  ])('locale: user $user, org $org → $expected', ({ user, org: locale, expected }) => {
    expect(localeOf({ locale: user }, org({ locale }), defaults)).toBe(expected);
  });

  it.each([
    { at: '2026-10-05T01:00:00Z', zone: 'Asia/Ho_Chi_Minh', hour: 8 },
    { at: '2026-10-05T16:59:59Z', zone: 'Asia/Ho_Chi_Minh', hour: 23 },
    { at: '2026-10-05T17:00:00Z', zone: 'Asia/Ho_Chi_Minh', hour: 0 },
    { at: '2026-10-05T00:00:00Z', zone: 'UTC', hour: 0 },
    { at: '2026-07-01T07:00:00Z', zone: 'Europe/Paris', hour: 9 },
  ])('local hour of $at in $zone is $hour', ({ at, zone, hour }) => {
    expect(localHourOf(new Date(at), zone)).toBe(hour);
  });
});
