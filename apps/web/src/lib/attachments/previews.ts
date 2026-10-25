/**
 * Just uploaded images and thumbnails that are not there yet (T421b,
 * CONTRACTS §20 "Ảnh thu nhỏ").
 *
 * - An image uploaded in this tab is drawn from its local copy (`blob:`
 *   URL of the chosen file) for the rest of the session: the panel, the
 *   grid and the lightbox strip show it at once, before the cell write
 *   reaches the server and before the worker renders the thumbnail.
 * - A thumbnail that fails (`404` while it is not rendered yet for a user
 *   who may not download the original) is asked again with backoff — about
 *   a minute in all, then a placeholder. No realtime signal exists for a
 *   rendered thumbnail; this poll is cheap (a few requests per image).
 */

/** Waits before asking again for a missing thumbnail, ms (about a minute in all). */
export const THUMBNAIL_RETRY_DELAYS_MS: readonly number[] = [
  1_000, 2_000, 4_000, 8_000, 15_000, 30_000,
];

/** Local copies kept per tab (the oldest are revoked first). */
export const MAX_LOCAL_PREVIEWS = 200;

type Revoke = (url: string) => void;

function defaultRevoke(url: string): void {
  if (typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
}

/** Local copies (`blob:` URLs) of images uploaded in this tab, by attachment id. */
export class LocalPreviews {
  readonly #urls = new Map<string, string>();
  readonly #limit: number;
  readonly #revoke: Revoke;

  constructor(limit = MAX_LOCAL_PREVIEWS, revoke: Revoke = defaultRevoke) {
    this.#limit = limit;
    this.#revoke = revoke;
  }

  remember(attachmentId: string, url: string): void {
    const current = this.#urls.get(attachmentId);
    if (current !== undefined && current !== url) this.#revoke(current);
    this.#urls.delete(attachmentId);
    this.#urls.set(attachmentId, url);
    while (this.#urls.size > this.#limit) {
      const [oldest] = this.#urls;
      if (oldest === undefined) break;
      this.#urls.delete(oldest[0]);
      this.#revoke(oldest[1]);
    }
  }

  get(attachmentId: string): string | null {
    return this.#urls.get(attachmentId) ?? null;
  }

  clear(): void {
    for (const url of this.#urls.values()) this.#revoke(url);
    this.#urls.clear();
  }
}

/** The previews of this tab. */
export const localPreviews = new LocalPreviews();

/** Whether a source is a local copy (never retried: it does not wait for the server). */
function isLocal(url: string): boolean {
  return url.startsWith('blob:') || url.startsWith('data:');
}

/**
 * Wait before try `attempt` + 1 of a failed image (0 = after the first
 * failure), `null` when it is not retried (a local copy) or tries ran out.
 */
export function thumbnailRetryDelay(url: string, attempt: number): number | null {
  if (isLocal(url)) return null;
  return THUMBNAIL_RETRY_DELAYS_MS[attempt] ?? null;
}

/**
 * The URL of try `attempt` (0 = the URL itself): a distinct query so that
 * neither the browser nor the canvas image cache answers with the failure.
 */
export function thumbnailRetryUrl(url: string, attempt: number): string {
  if (attempt <= 0 || isLocal(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}retry=${String(attempt)}`;
}
