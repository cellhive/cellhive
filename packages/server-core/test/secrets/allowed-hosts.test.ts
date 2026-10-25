import { canonicalAllowedHosts } from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import { parseOutboundUrl } from '../../src/net/url-policy.js';
import { secretHostDecision, type SecretHostPolicy } from '../../src/secrets/allowed-hosts.js';

const NOW = new Date('2026-10-24T00:00:00.000Z');

/** A policy from patterns as an admin types them (canonicalised like the API stores them). */
const listed = (...patterns: string[]): SecretHostPolicy => ({
  allowedHosts: canonicalAllowedHosts(patterns),
  legacyHostsUntil: null,
});

/**
 * BACKLOG T701 (ADR-36 §4, CONTRACTS §24): where an HTTP secret may be sent.
 * The URL goes through `parseOutboundUrl` first, as in `HttpDeliverer.prepare`
 * and the save check, so case, trailing dots, IDN and IPv4 notations are
 * normalised before matching.
 */
describe('secretHostDecision (T701)', () => {
  const cases: readonly [label: string, policy: SecretHostPolicy, url: string, allowed: boolean][] =
    [
      ['exact host', listed('api.crm.test'), 'https://api.crm.test/v1', true],
      // Review fix 2026-10-25: an entry without a port never sends a secret in clear text.
      [
        'exact host, plain http on 80 refused',
        listed('api.crm.test'),
        'http://api.crm.test/v1',
        false,
      ],
      [
        'exact host, plain http on 443 refused',
        listed('api.crm.test'),
        'http://api.crm.test:443/',
        false,
      ],
      [
        'wildcard without a port, plain http refused',
        listed('*.crm.example'),
        'http://api.crm.example/',
        false,
      ],
      [
        'plain http, the entry names port 80',
        listed('api.crm.test:80'),
        'http://api.crm.test/',
        true,
      ],
      [
        'plain http, a loopback dev entry with its port',
        listed('localhost:5678'),
        'http://localhost:5678/hook',
        true,
      ],
      [
        'plain http, a Docker service entry with its port',
        listed('n8n:5678'),
        'http://n8n:5678/webhook/x',
        true,
      ],
      ['plain http, another port than the entry', listed('n8n:5678'), 'http://n8n:5679/', false],
      [
        'https on 80, entry without a port',
        listed('api.crm.test'),
        'https://api.crm.test:80/',
        true,
      ],
      ['upper-case URL host', listed('api.crm.test'), 'https://API.CRM.Test/v1', true],
      ['upper-case pattern', listed('API.Crm.TEST'), 'https://api.crm.test/', true],
      ['trailing dot in the URL', listed('api.crm.test'), 'https://api.crm.test./', true],
      ['trailing dot in the pattern', listed('api.crm.test.'), 'https://api.crm.test/', true],
      ['another host', listed('api.crm.test'), 'https://attacker.test/', false],
      ['a subdomain of an exact host', listed('api.crm.test'), 'https://x.api.crm.test/', false],
      ['the parent of an exact host', listed('api.crm.test'), 'https://crm.test/', false],
      [
        'suffix trick: host.attacker',
        listed('api.crm.test'),
        'https://api.crm.test.attacker.test/',
        false,
      ],
      ['suffix trick: prefixed name', listed('crm.test'), 'https://evilcrm.test/', false],
      ['wildcard: a subdomain', listed('*.crm.example'), 'https://api.crm.example/', true],
      ['wildcard: a deeper subdomain', listed('*.crm.example'), 'https://a.b.crm.example/', true],
      ['wildcard: never the root', listed('*.crm.example'), 'https://crm.example/', false],
      [
        'wildcard: host.attacker',
        listed('*.crm.example'),
        'https://crm.example.attacker.test/',
        false,
      ],
      ['wildcard: evilcrm', listed('*.crm.example'), 'https://evilcrm.example/', false],
      ['wildcard: x.evilcrm', listed('*.crm.example'), 'https://x.evilcrm.example/', false],
      [
        'IDN pattern, punycode URL',
        listed('bücher.example'),
        'https://xn--bcher-kva.example/',
        true,
      ],
      [
        'IDN URL, punycode pattern',
        listed('xn--bcher-kva.example'),
        'https://Bücher.example/',
        true,
      ],
      ['IDN wildcard', listed('*.bücher.example'), 'https://shop.bücher.example/', true],
      ['IDN look-alike', listed('bucher.example'), 'https://bücher.example/', false],
      ['no port in the entry: 443', listed('api.crm.test'), 'https://api.crm.test:443/', true],
      [
        'no port in the entry: 8443 refused',
        listed('api.crm.test'),
        'https://api.crm.test:8443/',
        false,
      ],
      [
        'port in the entry: that port',
        listed('*.hooks.example:8443'),
        'https://a.hooks.example:8443/',
        true,
      ],
      [
        'port in the entry: 443 refused',
        listed('*.hooks.example:8443'),
        'https://a.hooks.example/',
        false,
      ],
      [
        'port in the entry: another port',
        listed('api.crm.test:8443'),
        'https://api.crm.test:9443/',
        false,
      ],
      ['second entry matches', listed('a.test', 'api.crm.test'), 'https://api.crm.test/', true],
      ['IPv4 literal never matches', listed('api.crm.test'), 'https://127.0.0.1/', false],
      ['IPv4 in another notation', listed('api.crm.test'), 'http://2130706433/', false],
      ['IPv6 literal never matches', listed('api.crm.test'), 'https://[::1]/', false],
      [
        'userinfo-like path does not move the host',
        listed('api.crm.test'),
        'https://attacker.test/api.crm.test',
        false,
      ],
      [
        'query does not move the host',
        listed('api.crm.test'),
        'https://attacker.test/?h=api.crm.test',
        false,
      ],
    ];

  it.each(cases)('%s', (_label, policy, url, allowed) => {
    const decision = secretHostDecision(policy, parseOutboundUrl(url), NOW);
    expect(decision).toEqual(
      allowed ? { allowed: true } : { allowed: false, reason: 'not_listed' },
    );
  });

  it('has at least 20 pattern cases', () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
  });

  describe('secrets stored before lists existed (empty list)', () => {
    const until = new Date(NOW.getTime() + 1_000);
    const legacy: SecretHostPolicy = { allowedHosts: [], legacyHostsUntil: until };
    const url = parseOutboundUrl('https://anything.test/');

    it.each([
      ['before the deadline: any host', NOW, { allowed: true }],
      ['at the deadline: expired', until, { allowed: false, reason: 'legacy_expired' }],
      [
        'after the deadline: expired',
        new Date(until.getTime() + 30 * 24 * 3600_000),
        { allowed: false, reason: 'legacy_expired' },
      ],
    ] as const)('%s', (_label, now, expected) => {
      expect(secretHostDecision(legacy, url, now)).toEqual(expected);
    });

    it('an empty list without a deadline is never allowed', () => {
      expect(secretHostDecision({ allowedHosts: [], legacyHostsUntil: null }, url, NOW)).toEqual({
        allowed: false,
        reason: 'not_listed',
      });
    });
  });

  it('canonicalises and de-duplicates the stored list', () => {
    expect(
      canonicalAllowedHosts([' API.crm.test ', 'api.crm.test.', '*.Bücher.example:8443', 'x']),
    ).toEqual(['api.crm.test', '*.xn--bcher-kva.example:8443', 'x']);
  });
});
