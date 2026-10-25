import { isIP } from 'node:net';

import { allowlistPatternMatchesHost, type Id } from '@cellhive/contracts';

import { classifyAddress, isLoopbackAddress } from './address-class.js';
import { OutboundHttpError, ssrfBlocked, type SsrfBlockReason } from './errors.js';
import {
  isLookupQueueTimeout,
  limitedSystemHostLookup,
  withTimeout,
  type HostLookup,
} from './lookup.js';
import { recordSsrfBlocked } from './metrics.js';
import { DEFAULT_OUTBOUND_PORTS, parseOutboundUrl, type OutboundUrl } from './url-policy.js';

/** An allowlist entry as the resolver needs it (`meta.http_allowlist`, parsed pattern). */
export interface OutboundAllowlistEntry {
  /** The exact host, or the suffix of a wildcard (ASCII lower case). */
  readonly host: string;
  readonly wildcard: boolean;
  /** `null`: the entry applies to ports 80/443. */
  readonly port: number | null;
}

/** The entries of an organization, read only when a URL needs them. */
export type OutboundAllowlistSource =
  | readonly OutboundAllowlistEntry[]
  | ((organizationId: Id<'org'>) => Promise<readonly OutboundAllowlistEntry[]>);

/**
 * `HTTP_PRIVATE_ALLOWLIST` (SPEC §20): `org` — an entry opens private
 * addresses for its host; `off` — entries only open another port on a
 * public host (instances shared by organizations that do not trust each
 * other).
 */
export type PrivateAllowlistMode = 'org' | 'off';

export interface ResolveOutboundOptions {
  readonly organizationId: Id<'org'>;
  readonly allowlist: OutboundAllowlistSource;
  readonly privateAllowlist: PrivateAllowlistMode;
  /**
   * DNS (A + AAAA); by default the system resolver, at most two lookups at
   * once per process and one per organization (`limitedSystemHostLookup`,
   * called with `{ key: organizationId }`); tests inject one.
   */
  readonly lookup?: HostLookup;
  /** Give up resolving after this long (default 5 s): `unresolvable`. */
  readonly lookupTimeoutMs?: number;
}

/** Where to connect: the URL and the one vetted address the socket must use. */
export interface OutboundTarget {
  readonly url: OutboundUrl;
  /** The address the connection is pinned to (never logged). */
  readonly address: string;
  readonly family: 4 | 6;
}

const DEFAULT_LOOKUP_TIMEOUT_MS = 5_000;

/**
 * Decides whether a URL may be called and pins the address (ADR-35 §3,
 * SPEC §14.3). Resolves **once**, every A and AAAA address, and every one
 * must be allowed — one forbidden address refuses the whole host (a name
 * answering [public, private] cannot be used to reach the private one);
 * an IP literal and an IPv4-mapped IPv6 address are judged like resolved
 * ones. Rules per address:
 *
 * - never reachable (`blocked_address`): metadata, unspecified, multicast,
 *   broadcast, reserved — even with an allowlist entry;
 * - public: allowed;
 * - private, ULA, CGNAT, link-local (`private_address` otherwise): only when
 *   an entry names the host (on this port, or without a port for 80/443) and
 *   `HTTP_PRIVATE_ALLOWLIST=org`;
 * - loopback: as private, but only an **exact** entry naming the host and
 *   **this port** opens it.
 *
 * Port: 80/443, or the port of a matching entry (`port_not_allowed`). The
 * caller connects to the returned address only (`guardedRequest`), so a
 * second DNS answer (rebinding) is never used. Blocks are counted in
 * `http_ssrf_blocked_total{reason}`.
 */
export async function resolveOutboundTarget(
  input: string | OutboundUrl,
  options: ResolveOutboundOptions,
): Promise<OutboundTarget> {
  try {
    return await resolve(input, options);
  } catch (error) {
    if (error instanceof OutboundHttpError && error.code === 'ssrf_blocked') {
      recordSsrfBlocked(error.params['reason'] as SsrfBlockReason);
    }
    throw error;
  }
}

async function resolve(
  input: string | OutboundUrl,
  options: ResolveOutboundOptions,
): Promise<OutboundTarget> {
  const url = typeof input === 'string' ? parseOutboundUrl(input) : input;
  let entries: readonly OutboundAllowlistEntry[] | null = null;
  const loadEntries = async (): Promise<readonly OutboundAllowlistEntry[]> => {
    if (entries === null) {
      const source = options.allowlist;
      const all = typeof source === 'function' ? await source(options.organizationId) : source;
      // IP literals never match: entries are host names.
      entries =
        url.ipFamily === 0
          ? all.filter((entry) => allowlistPatternMatchesHost(entry, url.host))
          : [];
    }
    return entries;
  };

  const defaultPort = DEFAULT_OUTBOUND_PORTS.has(url.port);
  // Entries that apply to this host on this port.
  const applicable = async () =>
    (await loadEntries()).filter((entry) =>
      entry.port === null ? defaultPort : entry.port === url.port,
    );
  if (!defaultPort && (await applicable()).length === 0) throw ssrfBlocked('port_not_allowed');

  const addresses = await addressesOf(url, options);
  for (const address of addresses) {
    const kind = classifyAddress(address);
    if (kind === 'blocked') throw ssrfBlocked('blocked_address');
    if (kind === 'public') continue;
    if (options.privateAllowlist === 'off') throw ssrfBlocked('private_address');
    const opening = await applicable();
    const opens = isLoopbackAddress(address)
      ? opening.some((entry) => !entry.wildcard && entry.port === url.port)
      : opening.length > 0;
    if (!opens) throw ssrfBlocked('private_address');
  }
  const [address = ''] = addresses;
  const family = isIP(address);
  return { url, address, family: family === 6 ? 6 : 4 };
}

async function addressesOf(url: OutboundUrl, options: ResolveOutboundOptions): Promise<string[]> {
  if (url.ipFamily !== 0) return [url.host];
  let addresses: readonly string[];
  try {
    addresses = await withTimeout(
      (options.lookup ?? limitedSystemHostLookup)(url.host, { key: options.organizationId }),
      options.lookupTimeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS,
      () => ssrfBlocked('unresolvable', { cause: 'timeout' }),
    );
  } catch (error) {
    // A slow or temporarily failing resolver (`EAI_AGAIN`) may answer later: the outbox
    // tries again (QA S5c). A name that does not exist stays permanent.
    if (error instanceof OutboundHttpError) throw error;
    // No slot of the process for this lookup in time: it never ran, so it says nothing
    // about the destination — not an SSRF block; the outbox gives the attempt back.
    if (isLookupQueueTimeout(error)) throw error;
    const code = (error as { code?: unknown } | null)?.code;
    throw ssrfBlocked('unresolvable', code === 'EAI_AGAIN' ? { cause: 'temporary' } : {});
  }
  const valid = addresses.filter((address) => isIP(address) !== 0);
  // Anything that is not an address makes the answer unusable as a whole.
  if (valid.length === 0 || valid.length !== addresses.length) throw ssrfBlocked('unresolvable');
  return [...valid];
}
