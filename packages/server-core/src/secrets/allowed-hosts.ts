import { allowlistPatternMatchesHost, parseAllowlistPattern } from '@cellhive/contracts';

import { DEFAULT_OUTBOUND_PORTS, type OutboundUrl } from '../net/url-policy.js';

import type { SecretRow } from '../db/schema.js';

/**
 * Where an `http_header` / `webhook_signing` secret may be sent (ADR-36 §4,
 * BACKLOG T701, CONTRACTS §24): its canonical host patterns, or — for a
 * secret stored before the list existed — the end of its transition period.
 */
export interface SecretHostPolicy {
  readonly allowedHosts: readonly string[];
  readonly legacyHostsUntil: Date | null;
}

/** Why a host was refused (`params.reason` of `secret_host_not_allowed`). */
export type SecretHostRefusal = 'not_listed' | 'legacy_expired';

export type SecretHostDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: SecretHostRefusal };

export function secretHostPolicyOf(
  row: Pick<SecretRow, 'allowed_hosts' | 'legacy_hosts_until'>,
): SecretHostPolicy {
  return { allowedHosts: row.allowed_hosts, legacyHostsUntil: row.legacy_hosts_until };
}

const ALLOWED: SecretHostDecision = { allowed: true };

/**
 * Whether a secret with `policy` may be sent to `url` (already normalised by
 * `parseOutboundUrl`: ASCII lower case, punycode, no trailing dot, the
 * effective port). Matching reuses the HTTP allowlist's
 * `allowlistPatternMatchesHost` — an exact entry equals the host, `*.suffix`
 * matches subdomains only (never the suffix itself, never
 * `suffix.attacker.test` or `evilsuffix`) — and the port rule of the
 * allowlist: an entry without a port covers 80/443, one with a port that
 * port only. A plain `http:` URL (the secret would cross the network in
 * clear text) matches only an entry naming its port explicitly
 * (`n8n:5678`, `localhost:8080`, `api.example:80`): an entry without a
 * port opens `https:` only (review fix 2026-10-25). An IP literal never
 * matches. An empty list is the transition
 * period of a secret stored before lists existed: any host until
 * `legacyHostsUntil`, then `legacy_expired`. Pure: the caller passes the
 * clock.
 */
export function secretHostDecision(
  policy: SecretHostPolicy,
  url: Pick<OutboundUrl, 'protocol' | 'host' | 'port' | 'ipFamily'>,
  now: Date,
): SecretHostDecision {
  if (policy.allowedHosts.length === 0) {
    if (policy.legacyHostsUntil !== null && policy.legacyHostsUntil.getTime() > now.getTime()) {
      return ALLOWED;
    }
    return {
      allowed: false,
      reason: policy.legacyHostsUntil === null ? 'not_listed' : 'legacy_expired',
    };
  }
  if (url.ipFamily !== 0) return { allowed: false, reason: 'not_listed' };
  for (const pattern of policy.allowedHosts) {
    const entry = parseAllowlistPattern(pattern);
    if (entry === null || !allowlistPatternMatchesHost(entry, url.host)) continue;
    if (
      entry.port === null
        ? url.protocol === 'https:' && DEFAULT_OUTBOUND_PORTS.has(url.port)
        : entry.port === url.port
    ) {
      return ALLOWED;
    }
  }
  return { allowed: false, reason: 'not_listed' };
}
