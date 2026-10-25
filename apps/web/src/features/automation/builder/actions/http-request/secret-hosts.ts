import { allowlistPatternMatchesHost, parseAllowlistPattern } from '@cellhive/contracts';

import type { HttpRequestValue, SecretDto } from '@cellhive/contracts';

/** Ports an allowed host without `:port` covers (CONTRACTS §24, §25.4). */
const DEFAULT_PORTS: ReadonlySet<number> = new Set([80, 443]);

/** The host and port a literal URL is sent to, as the server normalises them. */
export interface LiteralTarget {
  /** ASCII lower case (punycode), without a trailing dot. */
  readonly host: string;
  readonly port: number;
  /** An IP literal: never an allowed host. */
  readonly ip: boolean;
  /** `https:`; a plain `http:` URL needs an entry naming its port. */
  readonly secure: boolean;
}

/**
 * Host and effective port of a step URL when it is a literal `http(s)` URL
 * (the WHATWG parser gives the same lower-case punycode host as the
 * server's `parseOutboundUrl`); `null` for a value from a field, a template
 * or an earlier step — checked when the step runs — and for a URL that
 * does not parse (the definition check names it).
 */
export function literalUrlTarget(value: HttpRequestValue | undefined): LiteralTarget | null {
  if (value === undefined || !('literal' in value) || typeof value.literal !== 'string') {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value.literal);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname.replace(/\.$/u, '');
  if (host === '') return null;
  const ip = host.startsWith('[') || /^[0-9.]+$/u.test(host);
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  return { host, port, ip, secure: url.protocol === 'https:' };
}

/** What the builder tells about the chosen secret and the step URL (BACKLOG T717). */
export type SecretHostVerdict =
  /** The literal URL is an allowed host. */
  | { readonly kind: 'allowed'; readonly hosts: readonly string[] }
  /** The URL is not a literal: checked when the step runs. */
  | { readonly kind: 'unchecked'; readonly hosts: readonly string[] }
  /** The literal URL is not an allowed host: saving is refused (`SECRET_HOST_NOT_ALLOWED`). */
  | {
      readonly kind: 'not_listed';
      readonly host: string;
      readonly ip: boolean;
      readonly hosts: readonly string[];
      /**
       * The host is listed without a port, but the URL is plain `http:`: the
       * secret would cross the network in clear text.
       */
      readonly plainHttp: boolean;
    }
  /** Stored before allowed hosts existed: still sent to any host until `until`. */
  | { readonly kind: 'legacy'; readonly until: string }
  /** Its transition period is over: runs fail (`legacy_expired`). */
  | { readonly kind: 'legacy_expired' };

/**
 * The save-time check of the server (CONTRACTS §24, `secretHostDecision`)
 * run in the browser on the literal URL, with the same matcher of the
 * allowlist (`parseAllowlistPattern` + `allowlistPatternMatchesHost`) and
 * port rule: an entry without a port covers 80/443 over `https:` only, one
 * with a port that port only (a plain `http:` URL needs such an entry); an
 * IP literal never matches. An empty list is the transition
 * period of a secret stored before lists existed.
 */
export function secretHostVerdict(
  secret: Pick<SecretDto, 'allowed_hosts' | 'legacy_hosts_until'>,
  url: HttpRequestValue | undefined,
  now: Date,
): SecretHostVerdict {
  const hosts = secret.allowed_hosts;
  if (hosts.length === 0) {
    const until = secret.legacy_hosts_until;
    return until !== null && new Date(until).getTime() > now.getTime()
      ? { kind: 'legacy', until }
      : { kind: 'legacy_expired' };
  }
  const target = literalUrlTarget(url);
  if (target === null) return { kind: 'unchecked', hosts };
  const entries = target.ip
    ? []
    : hosts.flatMap((pattern) => {
        const entry = parseAllowlistPattern(pattern);
        return entry !== null && allowlistPatternMatchesHost(entry, target.host) ? [entry] : [];
      });
  const allowed = entries.some((entry) =>
    entry.port === null
      ? target.secure && DEFAULT_PORTS.has(target.port)
      : entry.port === target.port,
  );
  if (allowed) return { kind: 'allowed', hosts };
  const plainHttp =
    !target.secure &&
    DEFAULT_PORTS.has(target.port) &&
    entries.some((entry) => entry.port === null);
  return { kind: 'not_listed', host: target.host, ip: target.ip, hosts, plainHttp };
}
