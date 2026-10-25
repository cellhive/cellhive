import { safeHref, toHtml, toText, type Block, type Inline } from '@cellhive/markdown';

import { renderEmailLayout } from '../layout.js';
import { sanitizeEmailHtml } from '../render/sanitize.js';
import { mailLocaleOf, type MailLocale } from '../templates.js';

import {
  dateReminderHeadline,
  importFinishedBlocks,
  importFinishedHeadline,
  recordAssignedBlocks,
  recordAssignedHeadline,
  recordFollowedChangedBlocks,
  recordFollowedChangedHeadline,
  type DateReminderEmailItem,
  type ImportFinishedEmailItem,
  type RecordAssignedEmailItem,
  type RecordFollowedChangedEmailItem,
} from './notification-items/index.js';
import {
  CONTROL,
  DATE_LOCALE,
  linkOr,
  oneLine,
  quoted,
  text,
} from './notification-items/shared.js';

/**
 * Notification emails (BACKLOG T512; ADR-29 §1, ADR-32 §1, §3): a fixed
 * template — no signature, no automation footer (T531 applies those to
 * automation emails only) — in the recipient's language, built as a
 * `packages/markdown` document tree (never parsed from text, so nothing a
 * user wrote can become markup), rendered to HTML + plain text from that
 * one tree, passed through the `sanitize-html` second layer and wrapped in
 * the fixed 600 px layout of T513.
 *
 * Content (ADR-29 §1): what happened, the base and record names the
 * recipient may read **now** (record: its primary field only) and links to
 * `PUBLIC_URL`; `automation.message` carries the title and body rendered
 * for that recipient (ADR-32 §1). Never another field value, never a
 * one-click login token: the footer links to the notification settings,
 * which need a session. The S5b types (T542) have one file each under
 * `notification-items/`: `record.assigned` lists up to 20 records the
 * recipient reads, `date.reminder` shows the reminded value of the date
 * field itself (ADR-34 §1), the others counts only.
 */

interface ItemBase {
  readonly createdAt: Date;
  /** Base name, when the recipient still opens the base. */
  readonly baseName: string | null;
  /** Automation name, when the recipient may see the automation. */
  readonly automationName: string | null;
  /** Primary field of the linked record as text; `null` = no record or unreadable primary field. */
  readonly recordTitle: string | null;
  /** Where the item opens in the app (`PUBLIC_URL/…`); `null` = no link. */
  readonly url: string | null;
}

/** One notification as the recipient may see it (already checked). */
export type NotificationEmailItem = ItemBase &
  (
    | {
        readonly type: 'automation.disabled';
        readonly reason: 'circuit_breaker' | 'run_as_lost_access';
      }
    | {
        readonly type: 'automation.batch_overflow';
        readonly limit: number;
        /** Records left out, read when sent (QA S5 L6); `null` = unknown. */
        readonly skipped: number | null;
      }
    | { readonly type: 'automation.message'; readonly title: string; readonly body: string }
    | RecordAssignedEmailItem
    | RecordFollowedChangedEmailItem
    | DateReminderEmailItem
    | ImportFinishedEmailItem
  );

export interface NotificationEmailInput {
  readonly locale: string | null | undefined;
  /** IANA zone the times are written in (the recipient's). */
  readonly timeZone: string;
  /** `immediate`: the 5-minute batch; `daily`: the daily summary. */
  readonly mode: 'immediate' | 'daily';
  readonly organizationName: string;
  readonly recipientName: string;
  /** Oldest first: the items shown in full. */
  readonly items: readonly NotificationEmailItem[];
  /** Further notifications of this email only counted ("and N more"), default 0. */
  readonly moreCount?: number;
  /** Where the "and N more" line links (the organization in the app). */
  readonly moreUrl?: string | null;
  /**
   * The recipient's notification settings in this organization (T524):
   * `PUBLIC_URL/o/<org slug>/settings/notifications`.
   */
  readonly manageUrl: string;
  /** When the email is built (date of the daily summary). */
  readonly now: Date;
}

export interface RenderedNotificationEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

interface NotificationTexts {
  readonly greeting: (name: string) => string;
  readonly introOne: (org: string) => string;
  readonly introMany: (count: number, org: string) => string;
  readonly introDaily: (count: number, org: string) => string;
  readonly subjectMany: (count: number) => string;
  readonly subjectDaily: (count: number, date: string) => string;
  readonly disabled: (
    name: string | null,
    reason: 'circuit_breaker' | 'run_as_lost_access',
  ) => string;
  readonly overflow: (name: string | null, limit: string) => string;
  readonly overflowSkipped: (name: string | null, skipped: string, limit: string) => string;
  readonly untitledMessage: string;
  readonly more: (count: number) => string;
  readonly base: (name: string) => string;
  readonly record: (title: string) => string;
  readonly open: string;
  readonly why: (org: string) => string;
  readonly manage: string;
  readonly sentBy: string;
  readonly numberLocale: string;
}

const TEXTS: Readonly<Record<MailLocale, NotificationTexts>> = {
  en: {
    greeting: (name) => `Hello ${name},`,
    introOne: (org) => `You have a new notification in ${org}.`,
    introMany: (count, org) => `You have ${String(count)} new notifications in ${org}.`,
    introDaily: (count, org) =>
      count === 1
        ? `Here is your daily summary of ${org}: 1 notification.`
        : `Here is your daily summary of ${org}: ${String(count)} notifications.`,
    subjectMany: (count) => `${String(count)} new notifications`,
    subjectDaily: (count, date) =>
      count === 1
        ? `Daily summary for ${date}: 1 notification`
        : `Daily summary for ${date}: ${String(count)} notifications`,
    disabled: (name, reason) => {
      const subject = name === null ? 'An automation' : `The automation ${quoted(name)}`;
      return reason === 'circuit_breaker'
        ? `${subject} was turned off after failing repeatedly`
        : `${subject} was turned off: the user it runs as lost access`;
    },
    overflow: (name, limit) =>
      `${name === null ? 'An automation' : `The automation ${quoted(name)}`} skipped part of a bulk change (more than ${limit} records)`,
    overflowSkipped: (name, skipped, limit) =>
      `${name === null ? 'An automation' : `The automation ${quoted(name)}`} skipped ${skipped} records of a bulk change (limit ${limit} runs per change)`,
    untitledMessage: 'Message from an automation',
    more: (count) =>
      count === 1
        ? 'And 1 more notification: see it in Cellhive.'
        : `And ${String(count)} more notifications: see them in Cellhive.`,
    base: (name) => `Base: ${name}`,
    record: (title) => `Record: ${title}`,
    open: 'Open in Cellhive',
    why: (org) => `You receive this email because of your notification settings in ${org}.`,
    manage: 'Manage notifications',
    sentBy: 'Sent automatically by Cellhive.',
    numberLocale: 'en-US',
  },
  vi: {
    greeting: (name) => `Xin chào ${name},`,
    introOne: (org) => `Bạn có một thông báo mới trong ${org}.`,
    introMany: (count, org) => `Bạn có ${String(count)} thông báo mới trong ${org}.`,
    introDaily: (count, org) => `Tóm tắt hằng ngày của ${org}: ${String(count)} thông báo.`,
    subjectMany: (count) => `${String(count)} thông báo mới`,
    subjectDaily: (count, date) => `Tóm tắt ngày ${date}: ${String(count)} thông báo`,
    disabled: (name, reason) => {
      const subject = name === null ? 'Một automation' : `Automation ${quoted(name)}`;
      return reason === 'circuit_breaker'
        ? `${subject} đã bị tắt vì lỗi liên tiếp`
        : `${subject} đã bị tắt: người dùng mà automation chạy thay đã mất quyền`;
    },
    overflow: (name, limit) =>
      `${name === null ? 'Một automation' : `Automation ${quoted(name)}`} đã bỏ qua một phần thay đổi hàng loạt (quá ${limit} bản ghi)`,
    overflowSkipped: (name, skipped, limit) =>
      `${name === null ? 'Một automation' : `Automation ${quoted(name)}`} đã bỏ qua ${skipped} bản ghi của một thay đổi hàng loạt (giới hạn ${limit} lần chạy mỗi thay đổi)`,
    untitledMessage: 'Tin nhắn từ automation',
    more: (count) => `Và ${String(count)} thông báo khác: xem trong Cellhive.`,
    base: (name) => `Base: ${name}`,
    record: (title) => `Bản ghi: ${title}`,
    open: 'Mở trong Cellhive',
    why: (org) => `Bạn nhận email này theo cài đặt thông báo của bạn trong ${org}.`,
    manage: 'Quản lý thông báo',
    sentBy: 'Email được gửi tự động bởi Cellhive.',
    numberLocale: 'vi-VN',
  },
};

function headlineOf(
  item: NotificationEmailItem,
  t: NotificationTexts,
  locale: MailLocale,
  timeZone: string,
): string {
  switch (item.type) {
    case 'automation.disabled':
      return t.disabled(
        item.automationName === null ? null : oneLine(item.automationName),
        item.reason,
      );
    case 'automation.batch_overflow': {
      const name = item.automationName === null ? null : oneLine(item.automationName);
      const limit = new Intl.NumberFormat(t.numberLocale).format(item.limit);
      return item.skipped === null
        ? t.overflow(name, limit)
        : t.overflowSkipped(
            name,
            new Intl.NumberFormat(t.numberLocale).format(item.skipped),
            limit,
          );
    }
    case 'automation.message': {
      const title = oneLine(item.title);
      return title === '' ? t.untitledMessage : title;
    }
    case 'record.assigned':
      return recordAssignedHeadline(item, locale);
    case 'record.followed_changed':
      return recordFollowedChangedHeadline(item, locale);
    case 'date.reminder':
      return dateReminderHeadline(item, locale, timeZone);
    case 'import.finished':
      return importFinishedHeadline(item, locale);
  }
}

/**
 * The fixed headline of one item in the recipient's language — the same
 * sentence in the email and in the Telegram message (T550). Plain text: the
 * caller escapes it for its format.
 */
export function notificationItemHeadline(
  item: NotificationEmailItem,
  locale: string | null | undefined,
  timeZone: string,
): string {
  const mailLocale = mailLocaleOf(locale);
  return headlineOf(item, TEXTS[mailLocale], mailLocale, timeZone);
}

/** Paragraphs of a plain-text body: blank lines split paragraphs, single newlines break lines. */
function plainParagraphs(body: string): Block[] {
  const normalized = body.replace(/\r\n?/g, '\n').replace(CONTROL, '');
  const paragraphs: Block[] = [];
  for (const chunk of normalized.split(/\n{2,}/)) {
    const lines = chunk.split('\n').map((line) => line.trimEnd());
    if (lines.every((line) => line.trim() === '')) continue;
    const children: Inline[] = [];
    lines.forEach((line, index) => {
      if (index > 0) children.push({ type: 'break' });
      children.push(text(line));
    });
    paragraphs.push({ type: 'paragraph', children });
  }
  return paragraphs;
}

function formatTime(at: Date, locale: MailLocale, timeZone: string): string {
  return new Intl.DateTimeFormat(DATE_LOCALE[locale], {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(at);
}

function formatDate(at: Date, locale: MailLocale, timeZone: string): string {
  return new Intl.DateTimeFormat(DATE_LOCALE[locale], { timeZone, dateStyle: 'medium' }).format(at);
}

function itemBlocks(
  item: NotificationEmailItem,
  t: NotificationTexts,
  locale: MailLocale,
  timeZone: string,
): Block[] {
  const blocks: Block[] = [
    {
      type: 'heading',
      level: 3,
      children: linkOr(item.url, [text(headlineOf(item, t, locale, timeZone))]),
    },
  ];
  const meta = [formatTime(item.createdAt, locale, timeZone)];
  if (item.baseName !== null) meta.push(t.base(oneLine(item.baseName)));
  if (item.recordTitle !== null && oneLine(item.recordTitle) !== '') {
    meta.push(t.record(oneLine(item.recordTitle)));
  }
  blocks.push({
    type: 'paragraph',
    children: [{ type: 'em', children: [text(meta.join(' · '))] }],
  });
  if (item.type === 'automation.message') blocks.push(...plainParagraphs(item.body));
  if (item.type === 'record.assigned') blocks.push(...recordAssignedBlocks(item, locale));
  if (item.type === 'record.followed_changed') {
    blocks.push(...recordFollowedChangedBlocks(item, locale));
  }
  if (item.type === 'import.finished') blocks.push(...importFinishedBlocks(item, locale));
  if (item.url !== null && safeHref(item.url) !== null) {
    blocks.push({ type: 'paragraph', children: linkOr(item.url, [text(t.open)]) });
  }
  return blocks;
}

/** Subject, HTML and text of one notification email (fixed template, recipient's language). */
export function renderNotificationEmail(input: NotificationEmailInput): RenderedNotificationEmail {
  if (input.items.length === 0) throw new RangeError('renderNotificationEmail: no item');
  const locale = mailLocaleOf(input.locale);
  const t = TEXTS[locale];
  const organization = oneLine(input.organizationName);
  const more = input.moreCount ?? 0;
  const count = input.items.length + more;
  const first = input.items[0] as NotificationEmailItem;

  const subject =
    input.mode === 'daily'
      ? t.subjectDaily(count, formatDate(input.now, locale, input.timeZone))
      : count === 1
        ? headlineOf(first, t, locale, input.timeZone)
        : t.subjectMany(count);
  const intro =
    input.mode === 'daily'
      ? t.introDaily(count, organization)
      : count === 1
        ? t.introOne(organization)
        : t.introMany(count, organization);

  const body: Block[] = [
    { type: 'paragraph', children: [text(t.greeting(oneLine(input.recipientName)))] },
    { type: 'paragraph', children: [text(intro)] },
  ];
  input.items.forEach((item, index) => {
    if (index > 0) body.push({ type: 'hr' });
    body.push(...itemBlocks(item, t, locale, input.timeZone));
  });
  if (more > 0) {
    body.push({ type: 'hr' });
    body.push({ type: 'paragraph', children: linkOr(input.moreUrl ?? null, [text(t.more(more))]) });
  }
  const footer: Block[] = [
    { type: 'paragraph', children: [text(t.why(organization))] },
    {
      type: 'paragraph',
      children: [...linkOr(input.manageUrl, [text(t.manage)]), text(` · ${t.sentBy}`)],
    },
  ];

  const rendered = renderEmailLayout({
    lang: locale,
    title: subject,
    preheader: intro,
    body: { html: sanitizeEmailHtml(toHtml(body)), text: toText(body) },
    footer: { html: sanitizeEmailHtml(toHtml(footer)), text: toText(footer) },
  });
  return { subject, html: rendered.html, text: rendered.text };
}
