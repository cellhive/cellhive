/**
 * `Content-Disposition` with a UTF-8 filename (RFC 6266 + RFC 5987/8187):
 * `attachment; filename="<ASCII fallback>"; filename*=UTF-8''<percent-encoded>`.
 * Older clients use the quoted ASCII fallback; every current browser uses
 * `filename*`.
 */

const FALLBACK_NAME = 'download';

// C0/C1 control characters and DEL, which must never reach a header.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
// Directory separators: a filename is a single path segment.
const SEPARATORS = /[/\\]/g;
const COMBINING_MARKS = /\p{M}/gu;

/** Removes characters that are never valid in a filename. */
export function sanitizeFilename(filename: string): string {
  const cleaned = filename.normalize('NFC').replace(CONTROL, '').replace(SEPARATORS, '_').trim();
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? FALLBACK_NAME : cleaned;
}

/**
 * ASCII-only fallback for the quoted `filename` parameter: accents are
 * stripped (`Báo cáo.pdf` → `Bao cao.pdf`), anything else outside printable
 * ASCII and the characters `"`, `\` and `%` become `_`.
 */
export function asciiFallbackFilename(filename: string): string {
  const ascii = sanitizeFilename(filename)
    .replaceAll('đ', 'd')
    .replaceAll('Đ', 'D')
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .replace(/[^\x20-\x7e]|["\\%]/g, '_');
  return ascii.trim() === '' ? FALLBACK_NAME : ascii;
}

/** RFC 5987 `attr-char` percent-encoding (stricter than `encodeURIComponent`). */
export function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function contentDisposition(
  filename: string,
  disposition: 'attachment' | 'inline' = 'attachment',
): string {
  const name = sanitizeFilename(filename);
  return `${disposition}; filename="${asciiFallbackFilename(name)}"; filename*=UTF-8''${encodeRfc5987(name)}`;
}
