import { describe, expect, it } from 'vitest';

import { ERROR_DETAIL_CODES, HTTP_ALLOWLIST_DETAIL_CODES } from '../src/error-details.js';
import { isAuditAction, isEventType } from '../src/events.js';
import {
  ALLOWLIST_ENTRY_EXISTS,
  allowlistPatternMatchesHost,
  createHttpAllowlistEntryRequestSchema,
  httpAllowlistSchema,
  INVALID_ALLOWLIST_PATTERN,
  parseAllowlistPattern,
  TOO_MANY_ALLOWLIST_ENTRIES,
} from '../src/http-allowlist.js';

describe('parseAllowlistPattern (CONTRACTS §25.4, ADR-35 §3)', () => {
  it.each([
    ['n8n.internal', 'n8n.internal', 'n8n.internal', false, null],
    ['N8N.Internal:5678', 'n8n.internal:5678', 'n8n.internal', false, 5678],
    ['  hooks.example.com  ', 'hooks.example.com', 'hooks.example.com', false, null],
    ['n8n', 'n8n', 'n8n', false, null],
    ['n8n:5678', 'n8n:5678', 'n8n', false, 5678],
    ['localhost:8080', 'localhost:8080', 'localhost', false, 8080],
    ['*.corp.example', '*.corp.example', 'corp.example', true, null],
    ['*.Corp.Example:8443', '*.corp.example:8443', 'corp.example', true, 8443],
    ['bücher.example', 'xn--bcher-kva.example', 'xn--bcher-kva.example', false, null],
    ['*.bücher.example:1', '*.xn--bcher-kva.example:1', 'xn--bcher-kva.example', true, 1],
    ['api.example.com.', 'api.example.com', 'api.example.com', false, null],
    ['a-b.example:65535', 'a-b.example:65535', 'a-b.example', false, 65535],
  ])('%j → %s', (input, pattern, host, wildcard, port) => {
    expect(parseAllowlistPattern(input)).toEqual({ pattern, host, wildcard, port });
  });

  it.each([
    '',
    '   ',
    // IP addresses in any notation, CIDR.
    '10.0.0.5',
    '10.0.0.5:5678',
    '127.0.0.1',
    '0x7f.1',
    '2130706433',
    '169.254.169.254',
    '[::1]',
    '[::1]:8080',
    '::1',
    'fd00::1',
    '10.0.0.0/8',
    // Wildcards over fewer than two labels, or not leading.
    '*',
    '*.com',
    '*.internal',
    '*.internal:5678',
    'n8n.*.example',
    '**.example.com',
    'a*.example.com',
    // URLs, paths, user info.
    'http://n8n.internal',
    'n8n.internal/hook',
    'user@n8n.internal',
    'n8n.internal?x=1',
    // Ports.
    'n8n.internal:0',
    'n8n.internal:65536',
    'n8n.internal:',
    'n8n.internal:abc',
    'n8n.internal:56:78',
    // Labels.
    '-bad.example',
    'bad-.example',
    'bad_label.example',
    'two words.example',
    `${'a'.repeat(64)}.example`,
    `${'a.'.repeat(130)}example`,
  ])('refuses %j', (input) => {
    expect(parseAllowlistPattern(input)).toBeNull();
  });

  it('matches exact hosts, and the subdomains of a wildcard only', () => {
    const exact = { host: 'n8n.internal', wildcard: false };
    const wildcard = { host: 'corp.example', wildcard: true };
    expect(allowlistPatternMatchesHost(exact, 'n8n.internal')).toBe(true);
    expect(allowlistPatternMatchesHost(exact, 'x.n8n.internal')).toBe(false);
    expect(allowlistPatternMatchesHost(wildcard, 'n8n.corp.example')).toBe(true);
    expect(allowlistPatternMatchesHost(wildcard, 'a.b.corp.example')).toBe(true);
    expect(allowlistPatternMatchesHost(wildcard, 'corp.example')).toBe(false);
    expect(allowlistPatternMatchesHost(wildcard, 'evilcorp.example')).toBe(false);
  });
});

describe('allowlist API schemas', () => {
  it('trims the pattern and defaults the note', () => {
    expect(createHttpAllowlistEntryRequestSchema.parse({ pattern: ' n8n:5678 ' })).toEqual({
      pattern: 'n8n:5678',
      note: '',
    });
    expect(
      createHttpAllowlistEntryRequestSchema.safeParse({ pattern: 'n8n', extra: true }).success,
    ).toBe(false);
  });

  it('describes the list with the instance policy', () => {
    expect(
      httpAllowlistSchema.parse({
        items: [
          {
            id: 'hal_AllowlistEntry01',
            organization_id: 'org_AllowlistOrg0001',
            pattern: 'n8n.internal:5678',
            host: 'n8n.internal',
            wildcard: false,
            port: 5678,
            note: '',
            created_by: null,
            created_at: '2026-10-18T00:00:00.000Z',
          },
        ],
        private_addresses: 'org',
      }).items,
    ).toHaveLength(1);
  });

  it('documents its error codes and audit actions', () => {
    expect(HTTP_ALLOWLIST_DETAIL_CODES).toEqual([
      INVALID_ALLOWLIST_PATTERN,
      ALLOWLIST_ENTRY_EXISTS,
      TOO_MANY_ALLOWLIST_ENTRIES,
    ]);
    for (const code of HTTP_ALLOWLIST_DETAIL_CODES) expect(ERROR_DETAIL_CODES).toContain(code);
    for (const action of ['http_allowlist.created', 'http_allowlist.deleted']) {
      expect(isAuditAction(action)).toBe(true);
      expect(isEventType(action)).toBe(false);
    }
  });
});
