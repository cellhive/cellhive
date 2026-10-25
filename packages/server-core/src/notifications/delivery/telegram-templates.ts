import {
  AUTOMATION_MESSAGE_BODY_MAX,
  NOTIFICATION_TELEGRAM_MAX_CHARS,
  NOTIFICATION_TELEGRAM_MAX_ITEMS,
} from '@cellhive/contracts';

import { closeCutTelegramHtml } from '../../automation/actions/send-telegram/html.js';
import {
  escapeTelegramAttribute,
  escapeTelegramHtml,
  truncateText,
} from '../../automation/values/escape.js';
import {
  notificationItemHeadline,
  type NotificationEmailItem,
} from '../../mail/templates/notification-email.js';
import { formatCount, oneLine } from '../../mail/templates/notification-items/shared.js';
import { mailLocaleOf, type MailLocale } from '../../mail/templates.js';

/**
 * Notifications in a Telegram message (BACKLOG T550; ADR-34 §3, ADR-29 §1,
 * ADR-32 §1): the same content as the notification email, in Telegram HTML
 * (`parse_mode=HTML`), in the recipient's language — the fixed headline of
 * each type (shared with the email), the base name, the record's primary
 * field when the recipient reads it, the rendered title/body of
 * `automation.message`, a link to `PUBLIC_URL`. Never another field value.
 *
 * Every value is escaped on its own (`& < > "`, the `telegram_html` escaping
 * of T504) and every link must be an `http`/`https`/`mailto` URL (else it is
 * left out), so nothing a user wrote can become a tag or a link. At most
 * {@link NOTIFICATION_TELEGRAM_MAX_ITEMS} items are shown, fewer when the
 * message would exceed {@link NOTIFICATION_TELEGRAM_MAX_CHARS} visible
 * characters; the others are counted ("and N more" + a link to the
 * organization).
 */

export interface NotificationTelegramInput {
  readonly locale: string | null | undefined;
  /** IANA zone the dates are written in (the recipient's). */
  readonly timeZone: string;
  readonly organizationName: string;
  /** Every item the recipient may receive, oldest first. */
  readonly items: readonly NotificationEmailItem[];
  /** Where "and N more" links: the organization in the app (`PUBLIC_URL/o/<slug>`). */
  readonly moreUrl: string | null;
  /** The recipient's notification settings in this organization. */
  readonly manageUrl: string | null;
}

export interface RenderedNotificationTelegram {
  /** Telegram HTML, at most {@link NOTIFICATION_TELEGRAM_MAX_CHARS} visible characters. */
  readonly text: string;
  /** Items shown in full (the first ones). */
  readonly shown: number;
  /** Items only counted ("and N more"). */
  readonly more: number;
}

interface TelegramTexts {
  readonly headerOne: (org: string) => string;
  readonly headerMany: (count: string, org: string) => string;
  readonly base: (name: string) => string;
  readonly record: (title: string) => string;
  readonly open: string;
  readonly more: (count: number, formatted: string) => string;
  readonly manage: string;
  readonly untitledRecord: string;
  readonly moreRecords: (count: string) => string;
  readonly report: string;
}

const TEXTS: Readonly<Record<MailLocale, TelegramTexts>> = {
  en: {
    headerOne: (org) => `New notification in ${org}`,
    headerMany: (count, org) => `${count} new notifications in ${org}`,
    base: (name) => `Base: ${name}`,
    record: (title) => `Record: ${title}`,
    open: 'Open in Cellhive',
    more: (count, formatted) =>
      count === 1
        ? 'And 1 more notification: see it in Cellhive.'
        : `And ${formatted} more notifications: see them in Cellhive.`,
    manage: 'Manage notifications',
    untitledRecord: '(untitled record)',
    moreRecords: (count) => `And ${count} more`,
    report: 'Download the report of the rows that failed (available for 24 hours)',
  },
  vi: {
    headerOne: (org) => `Thông báo mới trong ${org}`,
    headerMany: (count, org) => `${count} thông báo mới trong ${org}`,
    base: (name) => `Base: ${name}`,
    record: (title) => `Bản ghi: ${title}`,
    open: 'Mở trong Cellhive',
    more: (_count, formatted) => `Và ${formatted} thông báo khác: xem trong Cellhive.`,
    manage: 'Quản lý thông báo',
    untitledRecord: '(bản ghi không có tiêu đề)',
    moreRecords: (count) => `Và ${count} bản ghi khác`,
    report: 'Tải báo cáo các dòng lỗi (có trong 24 giờ)',
  },
};

/** Longest name or record title placed on one line (code points, `…` when cut). */
const NAME_MAX = 200;

/** One value on one line, escaped for Telegram HTML. */
function line(value: string, max = NAME_MAX): string {
  return escapeTelegramHtml(truncateText(oneLine(value), max).text);
}

/** `<a href="…">label</a>` when `url` is http(s)/mailto, else the label alone. */
function link(url: string | null, labelHtml: string): string {
  const href = url === null ? '' : escapeTelegramAttribute(url);
  return href === '' ? labelHtml : `<a href="${href}">${labelHtml}</a>`;
}

/** A multi-line body: control characters removed, at most `max` code points, escaped. */
function body(value: string, max: number): string {
  const normalized = value
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((part) => part.trimEnd())
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  return escapeTelegramHtml(truncateText(normalized, max).text);
}

function itemHtml(
  item: NotificationEmailItem,
  t: TelegramTexts,
  locale: MailLocale,
  timeZone: string,
  bodyMax: number,
): string {
  const parts: string[] = [
    `<b>${line(notificationItemHeadline(item, locale, timeZone), 1_000)}</b>`,
  ];
  const meta: string[] = [];
  if (item.baseName !== null && oneLine(item.baseName) !== '')
    meta.push(t.base(line(item.baseName)));
  if (item.recordTitle !== null && oneLine(item.recordTitle) !== '') {
    meta.push(t.record(line(item.recordTitle)));
  }
  if (meta.length > 0) parts.push(`<i>${meta.join(' · ')}</i>`);
  if (item.type === 'automation.message' && bodyMax > 0) {
    const text = body(item.body, bodyMax);
    if (text !== '') parts.push(text);
  }
  // Records of a grouped item: a bulk or webhook `record.assigned`, a webhook
  // `record.followed_changed` (T608) — the item itself is the table then.
  const records =
    item.type === 'record.assigned' && (item.count > 1 || item.viaWebhook === true)
      ? { lines: item.records, total: item.count }
      : item.type === 'record.followed_changed' &&
          item.viaWebhook === true &&
          item.records !== undefined
        ? { lines: item.records, total: item.recordCount ?? item.records.length }
        : null;
  if (records !== null) {
    for (const record of records.lines) {
      const title = record.title === null ? '' : oneLine(record.title);
      parts.push(`• ${link(record.url, title === '' ? t.untitledRecord : line(title))}`);
    }
    const more = records.total - records.lines.length;
    if (more > 0) parts.push(t.moreRecords(formatCount(more, locale)));
  }
  if (item.type === 'import.finished' && item.failedRows > 0 && (item.reportUrl ?? null) !== null) {
    const report = link(item.reportUrl ?? null, t.report);
    if (report !== t.report) parts.push(report);
  }
  if (item.url !== null) {
    const open = link(item.url, t.open);
    if (open !== t.open) parts.push(open);
  }
  return parts.join('\n');
}

/**
 * Characters Telegram counts for the 4,096 limit: the text after parsing
 * the HTML (tags dropped, each entity one character), in UTF-16 units.
 */
export function telegramVisibleLength(html: string): number {
  return html.replace(/<[^<>]*>/gu, '').replace(/&(?:[A-Za-z]+|#\d+|#x[0-9A-Fa-f]+);/gu, '_')
    .length;
}

function build(
  input: NotificationTelegramInput,
  t: TelegramTexts,
  locale: MailLocale,
  shown: number,
  bodyMax: number,
): string {
  const organization = line(input.organizationName);
  const total = input.items.length;
  const blocks: string[] = [
    `<b>${total === 1 ? t.headerOne(organization) : t.headerMany(formatCount(total, locale), organization)}</b>`,
  ];
  for (const item of input.items.slice(0, shown)) {
    blocks.push(itemHtml(item, t, locale, input.timeZone, bodyMax));
  }
  const footer: string[] = [];
  const more = total - shown;
  if (more > 0) footer.push(link(input.moreUrl, t.more(more, formatCount(more, locale))));
  if (input.manageUrl !== null) {
    const manage = link(input.manageUrl, t.manage);
    if (manage !== t.manage) footer.push(manage);
  }
  if (footer.length > 0) blocks.push(footer.join('\n'));
  return blocks.join('\n\n');
}

/** Cuts a message that still does not fit to the limit, closing the tags it leaves open. */
function hardCut(html: string): string {
  const chars = Array.from(html);
  return closeCutTelegramHtml(`${chars.slice(0, NOTIFICATION_TELEGRAM_MAX_CHARS - 1).join('')}…`);
}

/** The Telegram message of the items (see the module comment). */
export function renderNotificationTelegram(
  input: NotificationTelegramInput,
): RenderedNotificationTelegram {
  if (input.items.length === 0) throw new RangeError('renderNotificationTelegram: no item');
  const locale = mailLocaleOf(input.locale);
  const t = TEXTS[locale];
  let shown = Math.min(input.items.length, NOTIFICATION_TELEGRAM_MAX_ITEMS);
  let bodyMax: number = AUTOMATION_MESSAGE_BODY_MAX;
  for (;;) {
    const text = build(input, t, locale, shown, bodyMax);
    if (telegramVisibleLength(text) <= NOTIFICATION_TELEGRAM_MAX_CHARS) {
      return { text, shown, more: input.items.length - shown };
    }
    if (shown > 1) {
      shown -= 1;
    } else if (bodyMax > 0) {
      bodyMax = Math.floor(bodyMax / 2);
    } else {
      return { text: hardCut(text), shown, more: input.items.length - shown };
    }
  }
}
