/** Schemes a link may use (ADR-32 §3); anything else stays plain text. */
export const LINK_SCHEMES: readonly string[] = ['http', 'https', 'mailto'];

/**
 * The WHATWG `URL` of browsers and Node, typed here because the package
 * compiles without DOM or Node typings (it must run in both).
 */
const WhatwgUrl = (globalThis as unknown as { URL: new (url: string) => { protocol: string } }).URL;

/** The trimmed URL when it is absolute with an allowed scheme, else `null`. */
export function safeHref(url: string): string | null {
  const trimmed = url.trim();
  try {
    const parsed = new WhatwgUrl(trimmed);
    return LINK_SCHEMES.includes(parsed.protocol.slice(0, -1)) ? trimmed : null;
  } catch {
    return null;
  }
}
