import { escapeAttribute, safeHref } from '@cellhive/markdown';

import type { AutomationTextContext } from '@cellhive/contracts';

/**
 * Contextual escaping of rendered templates (BACKLOG T504, ADR-32 §3): the
 * functions the send actions (T514–T516) use for subjects, display names,
 * notification texts and Telegram messages. Email **bodies** never come
 * here: they are parsed as Markdown first and each value becomes a text
 * node (`@cellhive/markdown` `parseTemplate` → `substitute`).
 */

/* eslint-disable no-control-regex -- matching control characters is the point */
/** C0 controls except tab and line feed, DEL, C1 controls. */
const CONTROL_KEEP_LINES = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu;
/** Every C0/C1 control, DEL and the Unicode line/paragraph separators. */
const ANY_BREAK_OR_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu;
/* eslint-enable no-control-regex */
const LONE_SURROGATE = /[\ud800-\udfff]/gu;

/** Multi-line text: `\r\n`/`\r` → `\n`, other controls removed, lone surrogates → U+FFFD. */
export function escapePlain(value: string): string {
  return value
    .replace(/\r\n?/gu, '\n')
    .replace(CONTROL_KEEP_LINES, '')
    .replace(LONE_SURROGATE, '�');
}

/**
 * One header line (email subject, display name): every line break or
 * control character run becomes one space, so no value can add a header
 * (no CRLF injection); trimmed.
 */
export function escapeHeader(value: string): string {
  return value.replace(ANY_BREAK_OR_CONTROL, ' ').replace(LONE_SURROGATE, '�').trim();
}

/** A value in Telegram `parse_mode=HTML` text: `& < > "` escaped, so it never becomes a tag. */
export function escapeTelegramHtml(value: string): string {
  return escapeAttribute(escapePlain(value));
}

/**
 * A value inside a Telegram HTML tag (`<a href="{{ … }}">`): only an
 * absolute `http`/`https`/`mailto` URL survives (attribute-escaped), so
 * `javascript:`, `data:` or a quote breaking out of the attribute cannot
 * become a link; anything else is empty.
 */
export function escapeTelegramAttribute(value: string): string {
  const href = safeHref(escapeHeader(value));
  return href === null ? '' : escapeAttribute(href);
}

/**
 * A value inside a URL (`http_request`, T606): percent-encoded like
 * `encodeURIComponent`, so `/`, `?`, `#`, `&`, `..` and spaces in a record
 * cannot change the path, the query or the host the author wrote. Lone
 * surrogates (which `encodeURIComponent` refuses) become U+FFFD first.
 */
export function escapeUrlComponent(value: string): string {
  return encodeURIComponent(value.replace(LONE_SURROGATE, '\ufffd'));
}

/**
 * A value inside a JSON string of a JSON body template (`http_request`,
 * T606): the content `JSON.stringify` would write between the quotes —
 * `"` and `\\` escaped, control characters as `\\uXXXX`.
 */
export function escapeJsonString(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

/** Escapes one placeholder value for `context` (`inTag`: inside `<…>` of Telegram HTML). */
export function escapeValue(value: string, context: AutomationTextContext, inTag = false): string {
  switch (context) {
    case 'raw':
      return value;
    case 'plain':
      return escapePlain(value);
    case 'header':
      return escapeHeader(value);
    case 'telegram_html':
      return inTag ? escapeTelegramAttribute(value) : escapeTelegramHtml(value);
    case 'url_component':
      return escapeUrlComponent(value);
    case 'json_string':
      return escapeJsonString(value);
  }
}

/** The whole rendered text made safe for `context` (literal parts included). */
export function finishText(text: string, context: AutomationTextContext): string {
  switch (context) {
    case 'raw':
    case 'json_string':
      return text;
    case 'header':
    case 'url_component':
      return escapeHeader(text);
    case 'plain':
    case 'telegram_html':
      return escapePlain(text);
  }
}

/**
 * Whether the text written so far ends inside an HTML tag (`<a href="`),
 * for placeholders of a Telegram template.
 */
export function endsInsideTag(text: string): boolean {
  return text.lastIndexOf('<') > text.lastIndexOf('>');
}

/** `text` cut to `max` code points, the last one replaced by `…` when cut. */
export function truncateText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const chars = Array.from(text);
  if (chars.length <= max) return { text, truncated: false };
  return { text: `${chars.slice(0, Math.max(0, max - 1)).join('')}…`, truncated: true };
}
