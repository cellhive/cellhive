import {
  embedOriginOf,
  MAX_EMBED_ORIGINS,
  SHARE_TOKEN_LENGTH,
  type ShareLinkTargetType,
} from '@cellhive/contracts';

/**
 * (T814) Embedding a share link (CONTRACTS §16 `settings.embed`, §16A
 * **Nhúng**): the sites allowed to frame `/s/:token?embed=1` and the
 * `<iframe>` code to paste into them.
 */

const TOKEN = new RegExp(`/s/([A-Za-z0-9_-]{${String(SHARE_TOKEN_LENGTH)}})(?:[?#].*)?$`, 'u');

/**
 * The full address of a link pasted back by its owner (the token is shown
 * once, CONTRACTS §16): `https://host/s/<43 characters>` whose token starts
 * with the link's `token_prefix`, without query; `null` otherwise.
 */
export function pastedLinkUrl(value: string, tokenPrefix: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const match = TOKEN.exec(url.pathname);
  const token = match?.[1];
  if (token === undefined || !token.startsWith(tokenPrefix)) return null;
  return `${url.origin}/s/${token}`;
}

/** The embeddable page of a link: `?embed=1` (the only page that may be framed). */
export function embedUrl(linkUrl: string): string {
  const url = new URL(linkUrl);
  url.search = '';
  url.hash = '';
  url.searchParams.set('embed', '1');
  return url.toString();
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/**
 * The suggested `sandbox` of a frame showing a link of `target`: scripts and
 * same-origin requests for the page itself, downloads for CSV, and popups
 * escaping the sandbox because every target can render external links that
 * open in a new tab (URL cells, form and text-widget Markdown — all
 * `target="_blank" rel="noopener noreferrer"`, so the new tab cannot reach
 * the frame). Forms also get `allow-forms`, without which the browser
 * blocks the submission. Never top navigation.
 */
export function embedSandbox(target: ShareLinkTargetType): string {
  return [
    'allow-scripts',
    'allow-same-origin',
    ...(target === 'form' ? ['allow-forms'] : []),
    'allow-downloads',
    'allow-popups',
    'allow-popups-to-escape-sandbox',
  ].join(' ');
}

/**
 * The `<iframe>` to paste into an allowed site: a `title` (the frame's
 * accessible name), lazy loading, no `Referer` (the token is in the
 * address), the sandbox suggested for the link's target (`embedSandbox`)
 * and fullscreen for TV mode.
 */
export function embedCode(linkUrl: string, title: string, target: ShareLinkTargetType): string {
  return [
    `<iframe src="${escapeAttribute(embedUrl(linkUrl))}"`,
    `  title="${escapeAttribute(title)}"`,
    '  width="100%" height="600" style="border:0"',
    '  loading="lazy" referrerpolicy="no-referrer"',
    `  sandbox="${embedSandbox(target)}"`,
    '  allow="fullscreen"></iframe>',
  ].join('\n');
}

export type OriginProblem = 'invalid' | 'duplicate' | 'tooMany';

/**
 * A site typed into the list of allowed origins, normalized as the API
 * stores it (`https://host[:port]`, lower-case, default port dropped), or
 * why it cannot be added. `http://localhost` passes here: the API accepts
 * it outside production and answers `422 INVALID_ORIGIN` otherwise.
 */
export function addOrigin(
  value: string,
  current: readonly string[],
): { readonly origin: string } | { readonly problem: OriginProblem } {
  const origin = embedOriginOf(value.trim(), { allowLocalHttp: true });
  if (origin === null) return { problem: 'invalid' };
  if (current.includes(origin)) return { problem: 'duplicate' };
  if (current.length >= MAX_EMBED_ORIGINS) return { problem: 'tooMany' };
  return { origin };
}
