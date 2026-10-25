/**
 * Embedding share links (BACKLOG T809, S7 decisions 14–16, ADR-38 §4).
 *
 * `/s/{token}?embed=1` is the only page that may be framed, and only by the
 * origins of its link. nginx (and `vite preview`) send such a request to the
 * API (`GET /api/v1/shares/{token}/page`), which answers the headers of the
 * page — `Content-Security-Policy` with `frame-ancestors` of the link, or
 * `'none'` plus `X-Frame-Options: DENY` for any link that may not be framed
 * — and `X-Accel-Redirect` to {@link SHARE_EMBED_PAGE_PATH}, where nginx
 * serves the share entry (`share.html`) with those headers. Every other page
 * keeps the static `frame-ancestors 'none'` of nginx.
 */

/** Internal nginx location serving `share.html` with the headers of the API. */
export const SHARE_EMBED_PAGE_PATH = '/_share/embed';

/**
 * Content Security Policy of the web client (FRONTEND §12), with the origin
 * of object storage (`STORAGE_PUBLIC_ORIGIN`, empty for the `local` driver)
 * and the sources of `frame-ancestors` (`'none'` unless an embeddable link).
 * `apps/web/security-headers.ts` (nginx, `vite preview`) builds the same
 * text; a unit test of the web app compares them.
 */
export function webContentSecurityPolicy(
  storageOrigin = '',
  frameAncestors: readonly string[] = [],
): string {
  const storage = storageOrigin === '' ? '' : ` ${storageOrigin}`;
  const ancestors = frameAncestors.length === 0 ? "'none'" : frameAncestors.join(' ');
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    `img-src 'self' data: blob:${storage}`,
    `media-src 'self' blob:${storage}`,
    "font-src 'self' data:",
    `connect-src 'self'${storage}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${ancestors}`,
  ].join('; ');
}
