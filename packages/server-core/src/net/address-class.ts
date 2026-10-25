import { BlockList, isIP } from 'node:net';

/**
 * Classification of IP addresses for every outbound connection of the
 * server (SPEC §14.3, ADR-35 §3): the SMTP servers of sender identities
 * (T530, `mail/identities/host-guard.ts` re-exports this) and the HTTP
 * calls of automations (`net/resolve-target.ts`, T600).
 *
 * - `blocked` — **never** reachable, whatever the configuration or the
 *   organization's allowlist: unspecified (`0.0.0.0/8`, `::`), multicast,
 *   broadcast, reserved (`240.0.0.0/4`) and cloud metadata addresses
 *   ({@link NEVER_ALLOWED_RANGES});
 * - `private` — refused unless a setting opens it (SMTP:
 *   `SMTP_ALLOW_PRIVATE_HOSTS`; HTTP: a matching allowlist entry): loopback,
 *   RFC 1918, link-local, CGNAT, IPv6 ULA and link-local, benchmarking and
 *   documentation ranges ({@link PRIVATE_RANGES});
 * - `public` — everything else.
 *
 * IPv4 addresses embedded in IPv6 (`::ffff:a.b.c.d`, IPv4-translated
 * `::ffff:0:a.b.c.d`, NAT64 `64:ff9b::/96` and the local-use NAT64 prefix
 * `64:ff9b:1::/48` — QA S5c —, 6to4 `2002::/16`) are classified by their
 * IPv4 address.
 */

export type AddressClass = 'public' | 'private' | 'blocked';

/**
 * Ranges no setting ever opens (ADR-35 §3 "không bao giờ mở được"). Kept
 * apart from {@link PRIVATE_RANGES} so a reader sees at once what an
 * allowlist can never reach.
 */
export const NEVER_ALLOWED_RANGES = {
  ipv4: [
    // Unspecified ("this network").
    '0.0.0.0/8',
    // Cloud metadata endpoints (AWS/GCP/Azure/OpenStack, ECS task metadata, Alibaba).
    '169.254.169.254/32',
    '169.254.170.2/32',
    '100.100.100.200/32',
    // Multicast.
    '224.0.0.0/4',
    // Reserved; includes the limited broadcast 255.255.255.255.
    '240.0.0.0/4',
  ],
  ipv6: [
    // Unspecified.
    '::/128',
    // AWS metadata over IPv6.
    'fd00:ec2::254/128',
    // Multicast.
    'ff00::/8',
  ],
} as const;

/** Ranges a setting may open (loopback only through {@link isLoopbackAddress} rules). */
export const PRIVATE_RANGES = {
  ipv4: [
    '10.0.0.0/8',
    '100.64.0.0/10',
    '127.0.0.0/8',
    '169.254.0.0/16',
    '172.16.0.0/12',
    '192.0.0.0/24',
    '192.0.2.0/24',
    '192.168.0.0/16',
    '198.18.0.0/15',
    '198.51.100.0/24',
    '203.0.113.0/24',
  ],
  ipv6: [
    '::1/128',
    'fc00::/7',
    'fe80::/10',
    '2001:db8::/32',
    '100::/64',
    // QA S5c: deprecated site-local (may still be routed inside a network), Teredo (a relay
    // reaches IPv4 hosts), the new documentation prefix (RFC 9637).
    'fec0::/10',
    '2001::/32',
    '3fff::/20',
  ],
} as const;

function blockList(ipv4: readonly string[], ipv6: readonly string[]): BlockList {
  const list = new BlockList();
  for (const cidr of ipv4) {
    const [network = '', prefix = '32'] = cidr.split('/');
    list.addSubnet(network, Number(prefix), 'ipv4');
  }
  for (const cidr of ipv6) {
    const [network = '', prefix = '128'] = cidr.split('/');
    list.addSubnet(network, Number(prefix), 'ipv6');
  }
  return list;
}

const BLOCKED = blockList(NEVER_ALLOWED_RANGES.ipv4, NEVER_ALLOWED_RANGES.ipv6);

/**
 * A fresh `BlockList` of {@link NEVER_ALLOWED_RANGES} plus `extra` addresses,
 * for the `blockList` option of a socket: the kernel never sees a
 * connection to them (`ERR_IP_BLOCKED`), whatever address reached the
 * socket — a second line behind {@link classifyAddress}.
 */
export function neverAllowedBlockList(extra: readonly string[] = []): BlockList {
  const list = blockList(NEVER_ALLOWED_RANGES.ipv4, NEVER_ALLOWED_RANGES.ipv6);
  for (const address of extra) {
    const family = isIP(address);
    if (family !== 0) list.addAddress(address, family === 6 ? 'ipv6' : 'ipv4');
  }
  return list;
}
const PRIVATE = blockList(PRIVATE_RANGES.ipv4, PRIVATE_RANGES.ipv6);
const LOOPBACK = blockList(['127.0.0.0/8'], ['::1/128']);

/** Groups of an IPv6 address as numbers (handles `::` and a trailing IPv4). */
function ipv6Groups(address: string): number[] | null {
  let text = address.toLowerCase().split('%')[0] ?? '';
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (isIP(tail) === 4) {
    const octets = tail.split('.').map(Number);
    const high = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
    const low = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
    text = `${text.slice(0, lastColon + 1)}${high.toString(16)}:${low.toString(16)}`;
  }
  const [head = '', rest] = text.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = rest === undefined || rest === '' ? [] : rest.split(':');
  const missing = 8 - left.length - right.length;
  if (rest === undefined ? missing !== 0 : missing < 0) return null;
  const groups = [...left, ...Array<string>(rest === undefined ? 0 : missing).fill('0'), ...right];
  const numbers = groups.map((group) => Number.parseInt(group, 16));
  return numbers.length === 8 && numbers.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff)
    ? numbers
    : null;
}

function ipv4Of(high: number, low: number): string {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

/** The IPv4 address an IPv6 address carries (mapped, NAT64, 6to4), if any. */
function embeddedIpv4(address: string): string | null {
  const g = ipv6Groups(address);
  if (g === null) return null;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (deprecated compatible).
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
    return g5 === 0 && g6 === 0 && g7 <= 1 ? null : ipv4Of(g6, g7);
  }
  // ::ffff:0:a.b.c.d (IPv4-translated, SIIT — RFC 2765).
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) {
    return ipv4Of(g6, g7);
  }
  // 64:ff9b::a.b.c.d (NAT64).
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return ipv4Of(g6, g7);
  }
  // 64:ff9b:1::/48 (local-use NAT64, RFC 8215): the IPv4 address in the last 32 bits.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 1) return ipv4Of(g6, g7);
  // 2002:aabb:ccdd::/48 (6to4).
  if (g0 === 0x2002) return ipv4Of(g1, g2);
  return null;
}

/** Class of an IP address; anything that is not an IP address is `blocked`. */
export function classifyAddress(address: string): AddressClass {
  const family = isIP(address);
  if (family === 4) {
    if (BLOCKED.check(address, 'ipv4')) return 'blocked';
    return PRIVATE.check(address, 'ipv4') ? 'private' : 'public';
  }
  if (family === 6) {
    const embedded = embeddedIpv4(address);
    if (embedded !== null) return classifyAddress(embedded);
    const plain = address.split('%')[0] ?? address;
    if (BLOCKED.check(plain, 'ipv6')) return 'blocked';
    return PRIVATE.check(plain, 'ipv6') ? 'private' : 'public';
  }
  return 'blocked';
}

/**
 * A loopback address (`127.0.0.0/8`, `::1`, or IPv4 loopback embedded in
 * IPv6). An HTTP allowlist entry opens it only when it names the exact host
 * **and** port (ADR-35 §3): the instance's own Valkey, Postgres and API
 * listen there.
 */
export function isLoopbackAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return LOOPBACK.check(address, 'ipv4');
  if (family === 6) {
    const embedded = embeddedIpv4(address);
    if (embedded !== null) return isLoopbackAddress(embedded);
    return LOOPBACK.check(address.split('%')[0] ?? address, 'ipv6');
  }
  return false;
}
