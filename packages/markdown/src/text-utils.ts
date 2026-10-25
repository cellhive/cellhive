/** Characters a `\` escapes in inline Markdown (the backslash is dropped, the character is text). */
export const ESCAPABLE_CLASS = '[\\\\`*_[\\]()#\\-~|>{}]';

/** C0 controls except tab and line feed, and DEL: never valid in an email body. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/gu;
/** With the `u` flag a surrogate class only matches unpaired surrogates. */
const LONE_SURROGATE = /[\ud800-\udfff]/gu;

/** Text safe to put in HTML or a text/plain part: no controls, well-formed UTF-16. */
export function cleanText(value: string): string {
  return value.replace(CONTROL, '').replace(LONE_SURROGATE, '�');
}

/** `\r\n` and `\r` as `\n`. */
export function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/gu, '\n');
}

/** Escapes text for an HTML text node (`&`, `<`, `>`), after `cleanText`. */
export function escapeHtml(value: string): string {
  return cleanText(value).replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

/** Escapes text for a double-quoted HTML attribute. */
export function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/"/gu, '&quot;');
}

/**
 * Size of `value` in UTF-8, as sent in an email (`EMAIL_MAX_HTML_BYTES`);
 * an unpaired surrogate counts as U+FFFD (3 bytes), like `TextEncoder`.
 */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code < 0x10000) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}
