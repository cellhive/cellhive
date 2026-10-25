/**
 * Security headers of the web client, applied by `vite preview` (and so
 * exercised by the E2E tests) and by nginx in production
 * (`infra/docker/web/security-headers.conf.template`, kept identical by a unit test).
 *
 * The CSP allows no inline script and no inline `<style>` element
 * (FRONTEND §12). React `style` props are applied through the CSSOM, which
 * `style-src` does not restrict. `frame-ancestors 'none'` everywhere but on
 * an embedded share page (`/s/:token?embed=1`, T809), whose ancestors are
 * the origins its link allows (`frameAncestors`, from the API). The API
 * builds the same text (`webContentSecurityPolicy` of `@cellhive/contracts`;
 * a unit test compares them).
 *
 * Attachments (T418, CONTRACTS §20) travel between the browser and object
 * storage directly: uploads `PUT` to presigned URLs, images, video and audio
 * load from the URL `GET /files/:id` redirects to. With the `local` driver
 * that is the app's own origin; with S3/Garage it is `S3_PUBLIC_ENDPOINT`,
 * a host of its own (never the app's origin: storage cannot add `nosniff`
 * or a CSP to what it serves). That origin — and only it — is added to
 * `img-src`, `media-src` and `connect-src`: nginx renders it from
 * `STORAGE_PUBLIC_ORIGIN` (the web image's environment, empty for `local`).
 * Nothing is ever framed (`frame-src` stays `'self'`, PDFs open in a tab).
 */
export function contentSecurityPolicy(
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

/** The policy of `vite preview` and of nginx without an object storage host (`local` driver). */
export const CONTENT_SECURITY_POLICY = contentSecurityPolicy();

/** Where nginx writes the storage origin (`envsubst` of the web image, `infra/docker/web/*.conf.template`). */
export const STORAGE_ORIGIN_VARIABLE = 'STORAGE_PUBLIC_ORIGIN';

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

/** Path prefix of the share pages (`/s/:token`, SPEC §15A.3). */
export const SHARE_PAGE_PREFIX = '/s/';

/**
 * Path of the public sender verification page (`/verify-sender?token=…`,
 * T533): served by the share entry with the share page headers — the token
 * is in the URL too.
 */
export const VERIFY_SENDER_PATH = '/verify-sender';

/** Whether a request path (with its query) is served `share.html` (nginx `location /s/`, `= /verify-sender`). */
export function isSharePagePath(url: string): boolean {
  if (url.startsWith(SHARE_PAGE_PREFIX)) return true;
  const path = url.split(/[?#]/u)[0];
  return path === VERIFY_SENDER_PATH;
}

/**
 * Headers of the share pages: never indexed, no `Referer` carrying the
 * token to other sites (SPEC §15A.3). nginx: `share-page-headers.conf.template`.
 */
export const SHARE_PAGE_HEADERS: Readonly<Record<string, string>> = {
  ...SECURITY_HEADERS,
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
};

/**
 * Headers of an embedded share page (`/s/:token?embed=1`, T809) that do not
 * depend on its link: those of the share pages without
 * `Content-Security-Policy` and `X-Frame-Options`, which the API answers per
 * link (`GET /api/v1/shares/:token/page`). nginx:
 * `share-embed-headers.conf.template`.
 */
export const SHARE_EMBED_PAGE_HEADERS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(SHARE_PAGE_HEADERS).filter(
    ([name]) => name !== 'Content-Security-Policy' && name !== 'X-Frame-Options',
  ),
);

/** Headers of an embedded share page that the API answers per link. */
export const SHARE_EMBED_LINK_HEADERS = ['Content-Security-Policy', 'X-Frame-Options'] as const;

const SHARE_EMBED_PATH = /^\/s\/([A-Za-z0-9_-]{43})\/?$/u;

/**
 * The token of an embedded share page request (`/s/{token}?embed=1`), else
 * `null` — what nginx rewrites to `GET /api/v1/shares/{token}/page`
 * (`infra/docker/web/default.conf.template`).
 */
export function shareEmbedTokenOf(url: string): string | null {
  const [path = '', query = ''] = url.split('#')[0]?.split('?', 2) ?? [];
  if (new URLSearchParams(query).get('embed') !== '1') return null;
  return SHARE_EMBED_PATH.exec(path)?.[1] ?? null;
}
