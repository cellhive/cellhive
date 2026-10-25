import { describe, expect, it } from 'vitest';

import { literalUrlTarget, secretHostVerdict } from '../actions/http-request/secret-hosts';

import type { HttpRequestValue } from '@cellhive/contracts';

/** T717: the save-time check of a secret's allowed hosts, in the browser. */

const NOW = new Date('2026-10-24T00:00:00.000Z');
const lit = (literal: string): HttpRequestValue => ({ literal });

describe('literalUrlTarget', () => {
  it.each([
    ['https://API.CRM.test/x', { host: 'api.crm.test', port: 443, ip: false, secure: true }],
    ['http://api.crm.test./x', { host: 'api.crm.test', port: 80, ip: false, secure: false }],
    ['https://hooks.example:8443/', { host: 'hooks.example', port: 8443, ip: false, secure: true }],
    [
      'https://bücher.example/',
      { host: 'xn--bcher-kva.example', port: 443, ip: false, secure: true },
    ],
    ['https://10.0.0.1/', { host: '10.0.0.1', port: 443, ip: true, secure: true }],
    ['https://0x7f.1/', { host: '127.0.0.1', port: 443, ip: true, secure: true }],
    ['https://[::1]/', { host: '[::1]', port: 443, ip: true, secure: true }],
    ['ftp://api.crm.test/', null],
    ['not a url', null],
    ['', null],
  ] as const)('%j → %j', (url, expected) => {
    expect(literalUrlTarget(lit(url))).toEqual(expected);
  });

  it('is null for a value that is not a literal', () => {
    expect(literalUrlTarget({ template: 'https://{{ [fld_1] }}/' })).toBeNull();
    expect(literalUrlTarget(undefined)).toBeNull();
  });
});

describe('secretHostVerdict', () => {
  const listed = (hosts: string[]) => ({ allowed_hosts: hosts, legacy_hosts_until: null });
  it.each([
    ['an exact host', ['api.crm.test'], 'https://api.crm.test/v1', 'allowed'],
    ['a subdomain of *.', ['*.crm.test'], 'https://eu.api.crm.test/', 'allowed'],
    ['the suffix itself is not a subdomain', ['*.crm.test'], 'https://crm.test/', 'not_listed'],
    ['a look-alike suffix', ['*.crm.test'], 'https://evilcrm.test/', 'not_listed'],
    [
      'a suffix inside another host',
      ['api.crm.test'],
      'https://api.crm.test.attacker.test/',
      'not_listed',
    ],
    ['another host', ['api.crm.test'], 'https://attacker.test/', 'not_listed'],
    // Review fix 2026-10-25: plain http needs an entry naming its port.
    ['plain http on 80 without :port', ['api.crm.test'], 'http://api.crm.test/', 'not_listed'],
    ['plain http, the entry names :80', ['api.crm.test:80'], 'http://api.crm.test/', 'allowed'],
    [
      'plain http, a dev entry with its port',
      ['localhost:5678'],
      'http://localhost:5678/',
      'allowed',
    ],
    ['https on 80 without :port', ['api.crm.test'], 'https://api.crm.test:80/', 'allowed'],
    ['another port without :port', ['api.crm.test'], 'https://api.crm.test:8443/', 'not_listed'],
    ['the port of the entry', ['api.crm.test:8443'], 'https://api.crm.test:8443/', 'allowed'],
    ['443 with an entry of 8443', ['api.crm.test:8443'], 'https://api.crm.test/', 'not_listed'],
    ['an IP address', ['api.crm.test'], 'https://10.0.0.1/', 'not_listed'],
    ['a URL from values', ['api.crm.test'], undefined, 'unchecked'],
  ] as const)('%s', (_label, hosts, url, kind) => {
    const value =
      url === undefined ? ({ template: '{{ [fld_1] }}' } as HttpRequestValue) : lit(url);
    expect(secretHostVerdict(listed([...hosts]), value, NOW).kind).toBe(kind);
  });

  it('names the host of a refused URL', () => {
    expect(
      secretHostVerdict(listed(['api.crm.test']), lit('https://Attacker.test/x'), NOW),
    ).toEqual({
      kind: 'not_listed',
      host: 'attacker.test',
      ip: false,
      hosts: ['api.crm.test'],
      plainHttp: false,
    });
  });

  it('says when a listed host is refused only because the URL is plain http', () => {
    expect(
      secretHostVerdict(listed(['api.crm.test']), lit('http://api.crm.test/x'), NOW),
    ).toMatchObject({ kind: 'not_listed', host: 'api.crm.test', plainHttp: true });
    expect(
      secretHostVerdict(listed(['other.test']), lit('http://api.crm.test/x'), NOW),
    ).toMatchObject({ kind: 'not_listed', plainHttp: false });
  });

  it.each([
    [
      'before the deadline',
      '2026-11-01T00:00:00.000Z',
      { kind: 'legacy', until: '2026-11-01T00:00:00.000Z' },
    ],
    ['after the deadline', '2026-10-01T00:00:00.000Z', { kind: 'legacy_expired' }],
    ['without a deadline', null, { kind: 'legacy_expired' }],
  ] as const)('a secret without hosts %s', (_label, until, expected) => {
    expect(
      secretHostVerdict(
        { allowed_hosts: [], legacy_hosts_until: until },
        lit('https://x.test/'),
        NOW,
      ),
    ).toEqual(expected);
  });
});
