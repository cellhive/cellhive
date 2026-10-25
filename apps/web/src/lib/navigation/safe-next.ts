const PROBE_ORIGIN = 'https://cellhive.invalid';

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isProtocolRelative(path: string): boolean {
  return path.startsWith('//') || path.startsWith('/\\');
}

/**
 * The `?next=` target after sign-in, only if it is a path of this app
 * (FRONTEND §2: no open redirect). Rejects absolute and protocol-relative
 * URLs (`//evil`, `/\evil`), schemes (`javascript:`), control characters that
 * browsers strip (`/\t/evil`) and the sign-in page itself. The checks on
 * `//` and `/\` are made again on the normalised result: dot segments
 * (`/.//evil`, `/a/..//evil`, `/%2e//evil`) collapse into a protocol-relative
 * path. Returns the normalised path with query and hash, or `null`.
 */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (!raw.startsWith('/') || isProtocolRelative(raw)) return null;
  if (hasControlCharacter(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw, PROBE_ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== PROBE_ORIGIN) return null;
  if (url.pathname === '/login' || url.pathname.startsWith('/login/')) return null;
  const path = `${url.pathname}${url.search}${url.hash}`;
  return isProtocolRelative(path) ? null : path;
}

/** `/login?next=<current path>` for a page that needs a session. */
export function loginPathFor(location: {
  pathname: string;
  search: string;
  hash?: string;
}): string {
  const next = safeNextPath(`${location.pathname}${location.search}${location.hash ?? ''}`);
  return next === null || next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`;
}
