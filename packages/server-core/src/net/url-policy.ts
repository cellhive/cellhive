import { isIP } from 'node:net';

import { ssrfBlocked } from './errors.js';

/** Longest URL accepted, after templates are rendered (CONTRACTS §25.6). */
export const MAX_OUTBOUND_URL_LENGTH = 2048;

/** Ports reachable without an allowlist entry naming the port. */
export const DEFAULT_OUTBOUND_PORTS: ReadonlySet<number> = new Set([80, 443]);

/** Control characters, space, DEL: refused anywhere (the URL parser would strip some silently). */
// eslint-disable-next-line no-control-regex
const CONTROL_OR_SPACE = /[\x00-\x20\x7f]/u;

/** A URL that passed the static checks of ADR-35 §3 (not yet the address checks). */
export interface OutboundUrl {
  /** Normalised URL without its fragment (never logged: it may carry tokens). */
  readonly href: string;
  readonly protocol: 'http:' | 'https:';
  /**
   * Host name in ASCII lower case (IDN → punycode), without IPv6 brackets or
   * a trailing dot — what the allowlist matches and the resolver gets. Safe
   * to log and to store (`target_host`).
   */
  readonly host: string;
  /** `4`/`6` when the host is an IP literal, `0` for a name. */
  readonly ipFamily: 0 | 4 | 6;
  readonly port: number;
  /** Path and query sent in the request line. */
  readonly path: string;
}

/**
 * Parses a user-supplied URL for an outbound call, or throws
 * `ssrf_blocked` / `invalid_url`: only `http`/`https`, at most 2 048
 * characters, no user info, no IPv6 zone id (the URL parser refuses `%`
 * in a host), no whitespace or control characters, a host present. The
 * WHATWG parser normalises the host: IDN → punycode, IPv4 in any notation
 * (`0x7f.1`, `2130706433`) → dotted decimal, so the address checks see what
 * a client would connect to.
 */
export function parseOutboundUrl(input: string): OutboundUrl {
  if (
    input.length === 0 ||
    input.length > MAX_OUTBOUND_URL_LENGTH ||
    CONTROL_OR_SPACE.test(input)
  ) {
    throw ssrfBlocked('invalid_url');
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw ssrfBlocked('invalid_url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw ssrfBlocked('invalid_url');
  if (url.username !== '' || url.password !== '') throw ssrfBlocked('invalid_url');
  const bracketed = url.hostname.startsWith('[') && url.hostname.endsWith(']');
  const host = (bracketed ? url.hostname.slice(1, -1) : url.hostname)
    .toLowerCase()
    .replace(/\.$/u, '');
  if (host === '' || host.includes('%')) throw ssrfBlocked('invalid_url');
  const ipFamily = isIP(host);
  if (bracketed && ipFamily !== 6) throw ssrfBlocked('invalid_url');
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  url.hash = '';
  if (url.href.length > MAX_OUTBOUND_URL_LENGTH) throw ssrfBlocked('invalid_url');
  return {
    href: url.href,
    protocol: url.protocol,
    host,
    ipFamily: ipFamily === 4 || ipFamily === 6 ? ipFamily : 0,
    port,
    path: `${url.pathname}${url.search}`,
  };
}
