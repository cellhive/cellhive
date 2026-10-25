import { describe, expect, it } from 'vitest';

import { classifyAddress as classifyFromMail } from '../../src/mail/identities/index.js';
import {
  classifyAddress,
  isLoopbackAddress,
  NEVER_ALLOWED_RANGES,
  type AddressClass,
} from '../../src/net/index.js';

/**
 * Address classes of the shared SSRF core (ADR-35 §3, BACKLOG T600). The
 * SMTP guard keeps its own expectations (`test/mail/identities/host-guard`);
 * this table covers the outbound HTTP needs: mapped, NAT64, 6to4, CGNAT,
 * ULA, cloud metadata, unspecified, broadcast, documentation, public.
 */
const CASES: readonly (readonly [string, AddressClass, string])[] = [
  // Public IPv4 / IPv6.
  ['8.8.8.8', 'public', 'Google DNS'],
  ['1.1.1.1', 'public', 'Cloudflare DNS'],
  ['93.184.216.34', 'public', 'example.com'],
  ['172.32.0.1', 'public', 'just above 172.16/12'],
  ['100.63.255.255', 'public', 'just below CGNAT'],
  ['100.128.0.1', 'public', 'just above CGNAT'],
  ['192.169.0.1', 'public', 'just above 192.168/16'],
  ['11.0.0.1', 'public', 'just above 10/8'],
  ['2606:4700:4700::1111', 'public', 'Cloudflare IPv6'],
  ['2001:4860:4860::8888', 'public', 'Google IPv6'],
  ['::ffff:8.8.8.8', 'public', 'IPv4-mapped public'],
  ['64:ff9b::808:808', 'public', 'NAT64 of a public address'],
  ['2002:5db8:d822::1', 'public', '6to4 of a public address'],
  // Loopback.
  ['127.0.0.1', 'private', 'loopback'],
  ['127.1.2.3', 'private', 'loopback /8'],
  ['::1', 'private', 'IPv6 loopback'],
  ['::ffff:127.0.0.1', 'private', 'IPv4-mapped loopback'],
  ['::ffff:7f00:1', 'private', 'IPv4-mapped loopback (hex)'],
  ['64:ff9b::7f00:1', 'private', 'NAT64 of loopback'],
  // RFC 1918.
  ['10.0.0.5', 'private', '10/8'],
  ['10.255.255.255', 'private', '10/8 top'],
  ['172.16.0.1', 'private', '172.16/12'],
  ['172.31.255.254', 'private', '172.16/12 top'],
  ['192.168.1.10', 'private', '192.168/16'],
  ['::ffff:192.168.1.10', 'private', 'IPv4-mapped RFC 1918'],
  ['::ffff:c0a8:10a', 'private', 'IPv4-mapped RFC 1918 (hex)'],
  ['64:ff9b::a00:5', 'private', 'NAT64 of 10.0.0.5'],
  ['2002:c0a8:101::1', 'private', '6to4 of 192.168.1.1'],
  // CGNAT, link-local, special purpose, benchmarking, documentation.
  ['100.64.0.1', 'private', 'CGNAT'],
  ['100.127.255.254', 'private', 'CGNAT top'],
  ['169.254.1.1', 'private', 'link-local'],
  ['192.0.0.8', 'private', 'IETF protocol assignments'],
  ['198.18.0.1', 'private', 'benchmarking'],
  ['192.0.2.1', 'private', 'TEST-NET-1'],
  ['198.51.100.7', 'private', 'TEST-NET-2'],
  ['203.0.113.9', 'private', 'TEST-NET-3'],
  // IPv6 ULA, link-local, documentation, discard.
  ['fd12:3456:789a::1', 'private', 'ULA fd00::/8'],
  ['fc00::1', 'private', 'ULA fc00::/8'],
  ['fe80::1', 'private', 'IPv6 link-local'],
  ['fe80::1%eth0', 'private', 'link-local with zone'],
  ['2001:db8::1', 'private', 'IPv6 documentation'],
  ['100::1', 'private', 'discard prefix'],
  // QA S5c: IPv6 forms that could still reach an internal IPv4 or network.
  ['64:ff9b:1::a00:1', 'private', 'local-use NAT64 of 10.0.0.1'],
  ['64:ff9b:1::7f00:1', 'private', 'local-use NAT64 of loopback'],
  ['64:ff9b:1::808:808', 'public', 'local-use NAT64 of a public address'],
  ['::ffff:0:7f00:1', 'private', 'IPv4-translated loopback'],
  ['::ffff:0:a00:5', 'private', 'IPv4-translated 10.0.0.5'],
  ['::ffff:0:808:808', 'public', 'IPv4-translated public'],
  ['fec0::1', 'private', 'site-local (deprecated)'],
  ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'private', 'Teredo'],
  ['3fff::1', 'private', 'documentation (RFC 9637)'],
  // Never reachable: cloud metadata (AWS, GCP, Azure, OpenStack, ECS, Alibaba).
  ['169.254.169.254', 'blocked', 'AWS/GCP/Azure metadata'],
  ['::ffff:169.254.169.254', 'blocked', 'metadata IPv4-mapped'],
  ['::ffff:a9fe:a9fe', 'blocked', 'metadata IPv4-mapped (hex)'],
  ['64:ff9b::a9fe:a9fe', 'blocked', 'metadata through NAT64'],
  ['64:ff9b:1::a9fe:a9fe', 'blocked', 'metadata through local-use NAT64'],
  ['::ffff:0:a9fe:a9fe', 'blocked', 'metadata IPv4-translated'],
  ['169.254.170.2', 'blocked', 'ECS task metadata'],
  ['100.100.100.200', 'blocked', 'Alibaba Cloud metadata'],
  ['fd00:ec2::254', 'blocked', 'AWS metadata IPv6'],
  // Never reachable: unspecified, multicast, broadcast, reserved.
  ['0.0.0.0', 'blocked', 'unspecified'],
  ['0.1.2.3', 'blocked', '"this network" 0/8'],
  ['::', 'blocked', 'IPv6 unspecified'],
  ['224.0.0.1', 'blocked', 'multicast'],
  ['239.255.255.250', 'blocked', 'SSDP multicast'],
  ['ff02::1', 'blocked', 'IPv6 multicast'],
  ['255.255.255.255', 'blocked', 'limited broadcast'],
  ['240.0.0.1', 'blocked', 'reserved'],
  // Not an address at all.
  ['localhost', 'blocked', 'a name'],
  ['', 'blocked', 'empty'],
  ['999.1.1.1', 'blocked', 'malformed IPv4'],
];

describe('classifyAddress (net, ADR-35 §3)', () => {
  it('has at least 40 cases', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(40);
  });

  it.each(CASES)('%s is %s (%s)', (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });

  it('is the very function the SMTP guard re-exports (T530)', () => {
    expect(classifyFromMail).toBe(classifyAddress);
  });

  it('lists the never-reachable ranges apart', () => {
    expect(NEVER_ALLOWED_RANGES.ipv4).toContain('169.254.169.254/32');
    expect(NEVER_ALLOWED_RANGES.ipv4).toContain('100.100.100.200/32');
    expect(NEVER_ALLOWED_RANGES.ipv6).toContain('fd00:ec2::254/128');
    for (const cidr of [...NEVER_ALLOWED_RANGES.ipv4, ...NEVER_ALLOWED_RANGES.ipv6]) {
      expect(classifyAddress(cidr.split('/')[0] ?? '')).toBe('blocked');
    }
  });
});

describe('isLoopbackAddress', () => {
  it.each([
    ['127.0.0.1', true],
    ['127.255.0.1', true],
    ['::1', true],
    ['::ffff:127.0.0.1', true],
    ['64:ff9b::7f00:1', true],
    ['10.0.0.1', false],
    ['169.254.169.254', false],
    ['fe80::1', false],
    ['8.8.8.8', false],
    ['localhost', false],
  ])('%s → %s', (address, expected) => {
    expect(isLoopbackAddress(address)).toBe(expected);
  });
});
