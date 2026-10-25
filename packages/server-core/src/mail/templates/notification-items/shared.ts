import { safeHref, type Inline } from '@cellhive/markdown';

import type { MailLocale } from '../../templates.js';

/**
 * Helpers shared by the notification email template and its per-type items
 * (T512, T542): every value placed in the email is a `text` node of the
 * `packages/markdown` tree — never parsed, so nothing a user wrote can
 * become markup.
 */

/** Characters a mail client could treat as line or format control: removed from text we place. */
// eslint-disable-next-line no-control-regex
export const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/** One line: control characters and line breaks become spaces. */
export function oneLine(value: string): string {
  return value
    .replace(/\r\n?|\n/g, ' ')
    .replace(CONTROL, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function text(value: string): Inline {
  return { type: 'text', text: value };
}

/** A link when `url` is http(s)/mailto, else plain text. */
export function linkOr(url: string | null, children: readonly Inline[]): readonly Inline[] {
  const href = url === null ? null : safeHref(url);
  return href === null ? children : [{ type: 'link', href, children }];
}

export const quoted = (name: string) => `“${name}”`;

/** Intl locale of numbers per mail language. */
export const NUMBER_LOCALE: Readonly<Record<MailLocale, string>> = { en: 'en-US', vi: 'vi-VN' };

/** Intl locale of dates per mail language. */
export const DATE_LOCALE: Readonly<Record<MailLocale, string>> = { en: 'en-GB', vi: 'vi-VN' };

export function formatCount(value: number, locale: MailLocale): string {
  return new Intl.NumberFormat(NUMBER_LOCALE[locale]).format(value);
}

/** A name placed in a sentence (one line), or `null` when there is none to show. */
export function nameOf(value: string | null): string | null {
  if (value === null) return null;
  const line = oneLine(value);
  return line === '' ? null : line;
}
