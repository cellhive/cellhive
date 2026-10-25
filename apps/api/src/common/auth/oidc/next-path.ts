import { OIDC_NEXT_MAX_LENGTH } from '@cellhive/contracts';

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
 * Where to send the browser after an OIDC sign-in: `next` when it is a path
 * of the app, else `/` (no open redirect; same rule as `safeNextPath` of the
 * web client, FRONTEND §2). Rejects absolute and protocol-relative URLs
 * (`//evil`, `/\evil`), schemes, control characters browsers strip, API
 * paths and the sign-in page itself. The checks on `//` and `/\` are made
 * again on the normalised result: dot segments (`/.//evil`, `/a/..//evil`,
 * `/%2e//evil`) collapse into a protocol-relative path.
 */
export function oidcNextPath(raw: string | undefined): string {
  if (raw === undefined || raw === '' || raw.length > OIDC_NEXT_MAX_LENGTH) return '/';
  if (!raw.startsWith('/') || isProtocolRelative(raw)) return '/';
  if (hasControlCharacter(raw)) return '/';
  let url: URL;
  try {
    url = new URL(raw, PROBE_ORIGIN);
  } catch {
    return '/';
  }
  if (url.origin !== PROBE_ORIGIN) return '/';
  const { pathname } = url;
  if (pathname === '/login' || pathname.startsWith('/login/')) return '/';
  if (pathname === '/api' || pathname.startsWith('/api/')) return '/';
  const path = `${pathname}${url.search}${url.hash}`;
  return isProtocolRelative(path) ? '/' : path;
}
