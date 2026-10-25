import { describe, expect, it } from 'vitest';

import {
  OutboundHttpError,
  parseOutboundUrl,
  resolveOutboundTarget,
  ssrfBlockedCounts,
  type HostLookup,
  type OutboundAllowlistEntry,
  type PrivateAllowlistMode,
  type SsrfBlockReason,
} from '../../src/net/index.js';

import type { Id } from '@cellhive/contracts';

const ORG = 'org_NetResolveOrg001' as Id<'org'>;

/** A resolver answering from a table; unknown names fail like NXDOMAIN. */
function dns(table: Record<string, readonly string[]>): HostLookup & { calls: string[] } {
  const calls: string[] = [];
  const lookup = (host: string) => {
    calls.push(host);
    const answer = table[host];
    return answer === undefined
      ? Promise.reject(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }))
      : Promise.resolve(answer);
  };
  return Object.assign(lookup, { calls });
}

const DNS = dns({
  'api.example.com': ['93.184.216.34', '2606:2800:220:1::1'],
  'mixed.example.com': ['93.184.216.34', '10.0.0.5'],
  'n8n.internal': ['10.0.0.20'],
  'internal.test': ['10.0.0.5'],
  'redis.internal': ['127.0.0.1'],
  'metadata.example.com': ['169.254.169.254'],
  'mapped.example.com': ['::ffff:10.0.0.5'],
  'ula.corp.example': ['fd12::1'],
  'cgnat.corp.example': ['100.64.1.1'],
  'empty.example.com': [],
  'garbage.example.com': ['not-an-address'],
  localhost: ['127.0.0.1', '::1'],
});

const entry = (
  host: string,
  port: number | null = null,
  wildcard = false,
): OutboundAllowlistEntry => ({
  host,
  port,
  wildcard,
});

async function decide(
  url: string,
  allowlist: readonly OutboundAllowlistEntry[] = [],
  privateAllowlist: PrivateAllowlistMode = 'org',
  lookup: HostLookup = DNS,
): Promise<string> {
  try {
    const target = await resolveOutboundTarget(url, {
      organizationId: ORG,
      allowlist,
      privateAllowlist,
      lookup,
    });
    return `ok ${target.address}`;
  } catch (error) {
    if (error instanceof OutboundHttpError) {
      return error.code === 'ssrf_blocked'
        ? `blocked ${String(error.params['reason'])}`
        : error.code;
    }
    throw error;
  }
}

describe('parseOutboundUrl (ADR-35 §3)', () => {
  it.each([
    ['https://api.example.com/hook?a=1#frag', 'https:', 'api.example.com', 443, '/hook?a=1'],
    ['http://API.Example.com:8080', 'http:', 'api.example.com', 8080, '/'],
    ['http://bücher.example/', 'http:', 'xn--bcher-kva.example', 80, '/'],
    ['https://api.example.com.:443/x', 'https:', 'api.example.com', 443, '/x'],
    ['http://0x7f.1/', 'http:', '127.0.0.1', 80, '/'],
    ['http://2130706433/', 'http:', '127.0.0.1', 80, '/'],
    ['http://[::1]:8080/', 'http:', '::1', 8080, '/'],
    ['http://[::ffff:127.0.0.1]/', 'http:', '::ffff:7f00:1', 80, '/'],
  ])('%s', (input, protocol, host, port, path) => {
    const url = parseOutboundUrl(input);
    expect(url).toMatchObject({ protocol, host, port, path });
    expect(url.href).not.toContain('#');
  });

  it.each([
    ['ftp://example.com/', 'scheme'],
    ['file:///etc/passwd', 'scheme'],
    ['gopher://127.0.0.1:6379/_INFO', 'scheme'],
    ['javascript:alert(1)', 'scheme'],
    ['https://user:pass@api.example.com/', 'user info'],
    ['https://user@api.example.com/', 'user info'],
    ['http://[fe80::1%25eth0]/', 'IPv6 zone id'],
    ['http://[fe80::1%eth0]/', 'IPv6 zone id'],
    [`https://api.example.com/${'a'.repeat(2048)}`, 'too long'],
    ['https://api.example.com/a b', 'space'],
    ['https://api.example.com/\n', 'control character'],
    [' https://api.example.com/', 'leading space'],
    ['not a url', 'not a URL'],
    ['', 'empty'],
    ['http://', 'no host'],
  ])('refuses %j (%s)', (input) => {
    expect(() => parseOutboundUrl(input)).toThrow(
      expect.objectContaining({ code: 'ssrf_blocked', params: { reason: 'invalid_url' } }),
    );
  });
});

describe('resolveOutboundTarget (ADR-35 §3, BACKLOG T600)', () => {
  it.each([
    // Public hosts on 80/443.
    ['https://api.example.com/hook', [], 'org', 'ok 93.184.216.34'],
    ['http://8.8.8.8/', [], 'org', 'ok 8.8.8.8'],
    // Every resolved address must be allowed: one private address refuses the host.
    ['https://mixed.example.com/', [], 'org', 'blocked private_address'],
    // Private addresses and IP literals without an allowlist.
    ['http://10.0.0.5/', [], 'org', 'blocked private_address'],
    ['http://127.0.0.1/', [], 'org', 'blocked private_address'],
    ['http://[::1]/', [], 'org', 'blocked private_address'],
    ['http://[::ffff:10.0.0.5]/', [], 'org', 'blocked private_address'],
    ['http://mapped.example.com/', [], 'org', 'blocked private_address'],
    ['http://0x7f.1/', [], 'org', 'blocked private_address'],
    ['http://localhost/', [], 'org', 'blocked private_address'],
    // Never reachable, even when allowlisted.
    ['http://169.254.169.254/latest/meta-data/', [], 'org', 'blocked blocked_address'],
    ['http://[fd00:ec2::254]/', [], 'org', 'blocked blocked_address'],
    ['http://100.100.100.200/', [], 'org', 'blocked blocked_address'],
    ['http://0.0.0.0/', [], 'org', 'blocked blocked_address'],
    ['http://255.255.255.255/', [], 'org', 'blocked blocked_address'],
    [
      'http://metadata.example.com/',
      [entry('metadata.example.com')],
      'org',
      'blocked blocked_address',
    ],
    // Ports: 80/443, or the port of a matching entry.
    ['http://api.example.com:6379/', [], 'org', 'blocked port_not_allowed'],
    ['http://127.0.0.1:6379/', [], 'org', 'blocked port_not_allowed'],
    ['https://api.example.com:8443/', [entry('api.example.com', 8443)], 'org', 'ok 93.184.216.34'],
    [
      'https://api.example.com:8443/',
      [entry('api.example.com')],
      'org',
      'blocked port_not_allowed',
    ],
    // An entry opens private addresses of its host (ports 80/443 without a port).
    ['http://internal.test/', [entry('internal.test')], 'org', 'ok 10.0.0.5'],
    ['http://n8n.internal:5678/', [entry('n8n.internal', 5678)], 'org', 'ok 10.0.0.20'],
    ['http://n8n.internal/', [entry('n8n.internal', 5678)], 'org', 'blocked private_address'],
    ['http://n8n.internal:5679/', [entry('n8n.internal', 5678)], 'org', 'blocked port_not_allowed'],
    ['http://ula.corp.example/', [entry('corp.example', null, true)], 'org', 'ok fd12::1'],
    ['http://cgnat.corp.example/', [entry('corp.example', null, true)], 'org', 'ok 100.64.1.1'],
    // An entry never names an IP literal.
    ['http://10.0.0.5/', [entry('internal.test')], 'org', 'blocked private_address'],
    // Loopback: only an exact entry naming the host and the port.
    ['http://redis.internal:6379/', [entry('redis.internal', 6379)], 'org', 'ok 127.0.0.1'],
    ['http://redis.internal/', [entry('redis.internal')], 'org', 'blocked private_address'],
    ['http://localhost:8080/', [entry('localhost', 8080)], 'org', 'ok 127.0.0.1'],
    // HTTP_PRIVATE_ALLOWLIST=off: entries only open another port on a public host.
    ['http://internal.test/', [entry('internal.test')], 'off', 'blocked private_address'],
    ['http://n8n.internal:5678/', [entry('n8n.internal', 5678)], 'off', 'blocked private_address'],
    ['https://api.example.com:8443/', [entry('api.example.com', 8443)], 'off', 'ok 93.184.216.34'],
    // Resolution failures.
    ['https://nxdomain.example.com/', [], 'org', 'blocked unresolvable'],
    ['https://empty.example.com/', [], 'org', 'blocked unresolvable'],
    ['https://garbage.example.com/', [], 'org', 'blocked unresolvable'],
    // Static URL problems.
    ['ftp://api.example.com/', [], 'org', 'blocked invalid_url'],
    ['https://u:p@api.example.com/', [], 'org', 'blocked invalid_url'],
  ] as const)('%s with %j (%s) → %s', async (url, allowlist, mode, expected) => {
    expect(await decide(url, allowlist, mode)).toBe(expected);
  });

  // QA S5c (T616 (3)): the SSRF case list, each spelling as a client would connect.
  const QA_DNS = dns({
    'api.example.com': ['93.184.216.34'],
    localhost: ['127.0.0.1'],
    // The system resolver answers a name with a trailing dot like the name.
    'localhost.': ['127.0.0.1'],
    // Cyrillic "а" in "аpple.com" (IDN homograph) → its own punycode name, on an internal host.
    'xn--pple-43d.com': ['10.0.0.9'],
    'apple.com': ['17.253.144.10'],
    'corp.example': ['10.0.0.30'],
    'evilcorp.example': ['10.0.0.31'],
    'a.b.corp.example': ['10.0.0.32'],
  });
  it.each([
    // IPv6 shorthand and all-zero forms.
    ['http://[0:0:0:0:0:0:0:1]/', [], 'blocked private_address'],
    ['http://[::]/', [], 'blocked blocked_address'],
    ['http://[::127.0.0.1]/', [], 'blocked private_address'],
    ['http://[::ffff:7f00:1]/', [], 'blocked private_address'],
    ['http://[::ffff:a9fe:a9fe]/', [], 'blocked blocked_address'],
    ['http://[64:ff9b::a9fe:a9fe]/', [], 'blocked blocked_address'],
    ['http://[64:ff9b:1::7f00:1]/', [], 'blocked private_address'],
    // IPv4 in decimal, octal, hex, short forms.
    ['http://2130706433/', [], 'blocked private_address'],
    ['http://017700000001/', [], 'blocked private_address'],
    ['http://0177.0.0.1/', [], 'blocked private_address'],
    ['http://0x7f000001/', [], 'blocked private_address'],
    ['http://0x7f.1/', [], 'blocked private_address'],
    ['http://127.1/', [], 'blocked private_address'],
    ['http://0/', [], 'blocked blocked_address'],
    // Unicode look-alikes the URL parser folds (fullwidth letters, ideographic dots, circled digits).
    ['http://ｌｏｃａｌｈｏｓｔ/', [], 'blocked private_address'],
    ['http://127。0。0。1/', [], 'blocked private_address'],
    ['http://①②⑦.0.0.1/', [], 'blocked private_address'],
    // IDN homograph: an entry for apple.com never opens "аpple.com" (Cyrillic а).
    ['http://аpple.com/', [entry('apple.com')], 'blocked private_address'],
    ['http://apple.com/', [entry('apple.com')], 'ok 17.253.144.10'],
    // Trailing dots: one is the same host (entry applies, still loopback rules), two never match.
    ['http://localhost./', [], 'blocked private_address'],
    ['http://localhost.:8080/', [entry('localhost', 8080)], 'ok 127.0.0.1'],
    ['http://localhost..:8080/', [entry('localhost', 8080)], 'blocked port_not_allowed'],
    ['http://localhost../', [], 'blocked private_address'],
    // Odd ports.
    ['http://api.example.com:0/', [], 'blocked port_not_allowed'],
    ['http://api.example.com:65536/', [], 'blocked invalid_url'],
    ['http://api.example.com:22/', [], 'blocked port_not_allowed'],
    ['https://api.example.com:80/', [], 'ok 93.184.216.34'],
    ['http://api.example.com:443/', [], 'ok 93.184.216.34'],
    // Wildcard entries: subdomains only, never the apex or a look-alike suffix.
    ['http://corp.example/', [entry('corp.example', null, true)], 'blocked private_address'],
    ['http://evilcorp.example/', [entry('corp.example', null, true)], 'blocked private_address'],
    ['http://a.b.corp.example/', [entry('corp.example', null, true)], 'ok 10.0.0.32'],
  ] as const)('QA S5c: %s with %j → %s', async (url, allowlist, expected) => {
    expect(await decide(url, allowlist, 'org', QA_DNS)).toBe(expected);
  });

  it('resolves once and reads the allowlist only when the URL needs it', async () => {
    const lookup = dns({ 'api.example.com': ['93.184.216.34'], 'internal.test': ['10.0.0.5'] });
    let loads = 0;
    const source = (organizationId: Id<'org'>) => {
      expect(organizationId).toBe(ORG);
      loads += 1;
      return Promise.resolve([entry('internal.test')]);
    };
    const options = {
      organizationId: ORG,
      allowlist: source,
      privateAllowlist: 'org',
      lookup,
    } as const;
    await resolveOutboundTarget('https://api.example.com/', options);
    expect(loads).toBe(0);
    expect((await resolveOutboundTarget('http://internal.test/', options)).address).toBe(
      '10.0.0.5',
    );
    expect(loads).toBe(1);
    expect(lookup.calls).toEqual(['api.example.com', 'internal.test']);
  });

  it('gives up on a resolver that does not answer (unresolvable)', async () => {
    const hanging: HostLookup = () => new Promise(() => undefined);
    await expect(
      resolveOutboundTarget('https://slow.example.com/', {
        organizationId: ORG,
        allowlist: [],
        privateAllowlist: 'org',
        lookup: hanging,
        lookupTimeoutMs: 20,
      }),
    ).rejects.toMatchObject({
      code: 'ssrf_blocked',
      params: { reason: 'unresolvable', cause: 'timeout' },
    });
  });

  it.each([
    ['EAI_AGAIN', { reason: 'unresolvable', cause: 'temporary' }],
    ['ENOTFOUND', { reason: 'unresolvable' }],
  ])('QA S5c: a resolver error %s → %o', async (code, params) => {
    const failing: HostLookup = () =>
      Promise.reject(Object.assign(new Error('lookup failed'), { code }));
    const error = await resolveOutboundTarget('https://flaky.example.com/', {
      organizationId: ORG,
      allowlist: [],
      privateAllowlist: 'org',
      lookup: failing,
    }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'ssrf_blocked' });
    expect((error as { params: unknown }).params).toEqual(params);
  });

  it('counts blocks per reason (http_ssrf_blocked_total)', async () => {
    const before = ssrfBlockedCounts();
    await decide('http://169.254.169.254/');
    await decide('http://10.0.0.5/');
    await decide('http://10.0.0.5/');
    const after = ssrfBlockedCounts();
    const delta = (reason: SsrfBlockReason) => (after.get(reason) ?? 0) - (before.get(reason) ?? 0);
    expect(delta('blocked_address')).toBe(1);
    expect(delta('private_address')).toBe(2);
  });

  it('never puts the URL or the address in the error', async () => {
    try {
      await resolveOutboundTarget('http://10.0.0.5/secret-token-abc', {
        organizationId: ORG,
        allowlist: [],
        privateAllowlist: 'org',
      });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain('10.0.0.5');
      expect(String(error)).not.toContain('secret-token-abc');
      expect(JSON.stringify(error)).not.toContain('secret-token-abc');
    }
  });
});
