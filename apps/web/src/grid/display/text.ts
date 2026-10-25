import { isEmail } from '@cellhive/field-types';

/**
 * Helpers shared by the canvas renderers and the DOM value display
 * (record panel, history). Nothing here imports the grid library, so screens
 * outside the grid chunk can use them.
 */

const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);
const PHONE = /^\+?[0-9 ().-]{3,32}$/u;

/**
 * Link target of a `text` value with style url/email/phone, or `null` when
 * the value is not a safe link: only http/https/mailto/tel (FRONTEND §12).
 * A url without a scheme is read as https.
 */
export function linkTarget(style: string, value: string): string | null {
  const text = value.trim();
  if (text === '') return null;
  let href: string;
  if (style === 'email') {
    if (!isEmail(text)) return null;
    href = `mailto:${text}`;
  } else if (style === 'phone') {
    if (!PHONE.test(text)) return null;
    href = `tel:${text.replace(/[^0-9+]/gu, '')}`;
  } else if (style === 'url') {
    href = /^[a-z][a-z0-9+.-]*:/iu.test(text) ? text : `https://${text}`;
  } else {
    return null;
  }
  try {
    const url = new URL(href);
    return SAFE_SCHEMES.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/** The first grapheme of a word: a letter with its accents (even decomposed) or a whole emoji. */
export function firstGrapheme(word: string): string {
  if (typeof Intl.Segmenter === 'function') {
    for (const { segment } of new Intl.Segmenter().segment(word)) return segment;
    return '';
  }
  return Array.from(word)[0] ?? '';
}

/**
 * First letters of the first and last word ("Nguyễn Văn Ánh" → "NÁ"), at
 * most two graphemes (T420: an emoji or a decomposed accent is never split).
 */
export function initialsOf(name: string): string {
  const words = name.normalize('NFC').trim().split(/\s+/u).filter(Boolean);
  const first = firstGrapheme(words[0] ?? '');
  const last = words.length > 1 ? firstGrapheme(words[words.length - 1] ?? '') : '';
  return `${first}${last}`.toUpperCase();
}

/** Option palette index (0–7) of an id: user avatars (same hash as the canvas). */
export function paletteIndexOf(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) | 0;
  return Math.abs(hash) % 8;
}
