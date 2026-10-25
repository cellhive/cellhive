/**
 * Minimal cookie parsing and `Set-Cookie` serialisation (RFC 6265) for the
 * few cookies the API sets; values are base64url tokens, so no encoding is
 * needed.
 */

/** Parses a `Cookie` header; the first occurrence of a name wins. */
export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (header === undefined || header === '') return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    let value = part.slice(index + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    if (name !== '' && !cookies.has(name)) cookies.set(name, value);
  }
  return cookies;
}

export interface CookieOptions {
  readonly httpOnly: boolean;
  readonly secure: boolean;
  /** Seconds; `0` deletes the cookie. */
  readonly maxAgeSeconds: number;
}

const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const COOKIE_VALUE = /^[!#-+\--:<-[\]-~]*$/;

/** `Set-Cookie` value with `Path=/; SameSite=Lax` (SPEC §14.2). */
export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  if (!COOKIE_NAME.test(name)) throw new TypeError(`Invalid cookie name '${name}'`);
  if (!COOKIE_VALUE.test(value)) throw new TypeError(`Invalid value for cookie '${name}'`);
  const parts = [
    `${name}=${value}`,
    'Path=/',
    `Max-Age=${String(Math.max(0, Math.floor(options.maxAgeSeconds)))}`,
    'SameSite=Lax',
  ];
  if (options.maxAgeSeconds <= 0) parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}
