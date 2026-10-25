import { z } from 'zod';

import { isoDateTimeSchema } from './common.js';
import { idOf } from './ids.js';

/**
 * Outbound HTTP allowlist of an organization (SPEC §5.10
 * `meta.http_allowlist`, §14.3; CONTRACTS §25.4; ADR-35 §3; BACKLOG T600).
 *
 * Automations may only call public addresses on ports 80/443. An entry
 * names a **host** — exact (`n8n.internal`, `n8n` for a Docker service) or a
 * wildcard over its subdomains (`*.corp.example`, at least two labels after
 * `*.`) — with an optional port (`n8n.internal:5678`). A matching entry lets
 * calls to that host reach private, ULA and CGNAT addresses (unless the
 * instance sets `HTTP_PRIVATE_ALLOWLIST=off`) and, with a port, use that
 * port. Loopback is reached only through an exact host **with** its port.
 * Cloud metadata, unspecified, multicast and broadcast addresses are never
 * reachable. IP addresses and CIDR ranges are not accepted: the list is
 * about names ("our internal n8n"), not about scanning a network.
 */

/** Most entries per organization (CONTRACTS §25.6). */
export const HTTP_ALLOWLIST_MAX_ENTRIES = 100;
/** Longest pattern as typed (a host name is at most 253 characters). */
export const MAX_ALLOWLIST_PATTERN_LENGTH = 300;
/** Longest note. */
export const MAX_ALLOWLIST_NOTE_LENGTH = 200;

export const httpAllowlistEntryIdSchema = idOf('hal');

/** A pattern after {@link parseAllowlistPattern}: canonical text and its parts. */
export interface ParsedAllowlistPattern {
  /** Canonical form stored and compared for duplicates: `host`, `*.suffix`, `…:port`. */
  readonly pattern: string;
  /** The exact host, or the suffix of a wildcard (without `*.`), ASCII lower case. */
  readonly host: string;
  readonly wildcard: boolean;
  /** `null`: the entry applies to ports 80 and 443 only. */
  readonly port: number | null;
}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/u;

/** The WHATWG URL parser of the platform (Node and browsers; this package has no DOM types). */
const PlatformUrl = (globalThis as { URL?: new (input: string) => { hostname: string } }).URL;

/** IDN → punycode with the URL parser of the platform; `null` when refused. */
function asciiHost(value: string): string | null {
  if (PlatformUrl === undefined) return null;
  try {
    const host = new PlatformUrl(`http://${value}/`).hostname;
    return host === '' ? null : host;
  } catch {
    return null;
  }
}

/**
 * Canonical form of an allowlist pattern, or `null` when it is not one:
 * `Host.Example` → `host.example`, `*.Bücher.example:8443` →
 * `*.xn--bcher-kva.example:8443`. Refused: IP addresses (v4 in any
 * notation the URL parser accepts, v6 in brackets), CIDR, scheme, path,
 * user info, a wildcard anywhere but a leading `*.`, a wildcard over fewer
 * than two labels (`*.com`, `*.internal`), ports outside 1–65535.
 */
export function parseAllowlistPattern(input: string): ParsedAllowlistPattern | null {
  const value = input.trim().toLowerCase();
  if (value === '' || value.length > MAX_ALLOWLIST_PATTERN_LENGTH) return null;
  if (/[\s/@?#\\[\]%]/u.test(value)) return null;
  let hostPart = value;
  let port: number | null = null;
  const colon = value.lastIndexOf(':');
  if (colon !== -1) {
    const portText = value.slice(colon + 1);
    if (!/^[0-9]{1,5}$/u.test(portText)) return null;
    port = Number(portText);
    if (port < 1 || port > 65_535) return null;
    hostPart = value.slice(0, colon);
    if (hostPart.includes(':')) return null;
  }
  const wildcard = hostPart.startsWith('*.');
  const name = (wildcard ? hostPart.slice(2) : hostPart).replace(/\.$/u, '');
  if (name === '' || name.includes('*')) return null;
  const ascii = asciiHost(name);
  if (ascii === null || ascii.length > 253) return null;
  // The URL parser turns IPv4 in any notation (`0x7f.1`, `2130706433`) into `a.b.c.d`.
  if (/^[0-9.]+$/u.test(ascii)) return null;
  const labels = ascii.split('.');
  if (!labels.every((label) => LABEL.test(label))) return null;
  if (wildcard && labels.length < 2) return null;
  const host = ascii;
  const pattern = `${wildcard ? '*.' : ''}${host}${port === null ? '' : `:${String(port)}`}`;
  return { pattern, host, wildcard, port };
}

/**
 * Whether an entry names `host` (ASCII lower case, no trailing dot): an
 * exact entry equals it; a wildcard matches its subdomains only
 * (`*.corp.example` matches `n8n.corp.example`, not `corp.example`).
 */
export function allowlistPatternMatchesHost(
  entry: Pick<ParsedAllowlistPattern, 'host' | 'wildcard'>,
  host: string,
): boolean {
  return entry.wildcard ? host.endsWith(`.${entry.host}`) : host === entry.host;
}

// --- API ---------------------------------------------------------------------------------

export const createHttpAllowlistEntryRequestSchema = z
  .strictObject({
    pattern: z
      .string()
      .trim()
      .min(1)
      .max(MAX_ALLOWLIST_PATTERN_LENGTH)
      .meta({
        description:
          'Exact host (`n8n.internal`, `n8n`) or `*.suffix` (at least two labels), with an ' +
          'optional `:port`. No IP address or CIDR (`INVALID_ALLOWLIST_PATTERN`)',
        example: 'n8n.internal:5678',
      }),
    note: z.string().trim().max(MAX_ALLOWLIST_NOTE_LENGTH).default('').meta({
      description: 'Why the host is allowed (shown to owners/admins)',
    }),
  })
  .meta({ id: 'CreateHttpAllowlistEntryRequest' });
export type CreateHttpAllowlistEntryRequest = z.infer<typeof createHttpAllowlistEntryRequestSchema>;
export type CreateHttpAllowlistEntryInput = z.input<typeof createHttpAllowlistEntryRequestSchema>;

export const httpAllowlistEntrySchema = z
  .object({
    id: httpAllowlistEntryIdSchema,
    organization_id: idOf('org'),
    pattern: z.string().meta({ description: 'Canonical form (lower case, punycode)' }),
    host: z.string().meta({ description: 'The exact host, or the suffix of a wildcard' }),
    wildcard: z.boolean(),
    port: z
      .int()
      .min(1)
      .max(65_535)
      .nullable()
      .meta({ description: '`null`: ports 80 and 443 only' }),
    note: z.string(),
    created_by: z
      .object({ id: idOf('usr'), name: z.string() })
      .nullable()
      .meta({ description: '`null` when that member left or the account is gone' }),
    created_at: isoDateTimeSchema,
  })
  .meta({
    id: 'HttpAllowlistEntry',
    description: 'Host automations may call on a private network',
  });
export type HttpAllowlistEntryDto = z.infer<typeof httpAllowlistEntrySchema>;

export const httpAllowlistSchema = z
  .object({
    items: z.array(httpAllowlistEntrySchema),
    private_addresses: z.enum(['org', 'off']).meta({
      description:
        '`HTTP_PRIVATE_ALLOWLIST` of the instance: `off` — entries never open private ' +
        'addresses, they only allow another port on a public host',
    }),
  })
  .meta({ id: 'HttpAllowlist' });
export type HttpAllowlist = z.infer<typeof httpAllowlistSchema>;

// --- Errors ------------------------------------------------------------------------------

/** `VALIDATION_FAILED` detail (path `pattern`): not a host pattern (IP, CIDR, `*.com`…). */
export const INVALID_ALLOWLIST_PATTERN = 'INVALID_ALLOWLIST_PATTERN';
/** `VALIDATION_FAILED` detail (path `pattern`): the canonical pattern is already listed. */
export const ALLOWLIST_ENTRY_EXISTS = 'ALLOWLIST_ENTRY_EXISTS';
/** `VALIDATION_FAILED` detail (path `pattern`): the organization has 100 entries. */
export const TOO_MANY_ALLOWLIST_ENTRIES = 'TOO_MANY_ALLOWLIST_ENTRIES';
