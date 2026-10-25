import { describe, expect, it } from 'vitest';

import { webContentSecurityPolicy } from '../src/share-embed.js';
import {
  createShareLinkRequestSchema,
  embedOriginOf,
  MAX_EMBED_ORIGINS,
  MAX_SHARE_REFRESH_SECONDS,
  MIN_SHARE_REFRESH_SECONDS,
} from '../src/share-links.js';

describe('embedOriginOf (T809, S7 decision 16)', () => {
  it.each([
    ['https://intranet.example.com', 'https://intranet.example.com'],
    ['https://intranet.example.com/', 'https://intranet.example.com'],
    ['https://Intranet.Example.COM', 'https://intranet.example.com'],
    ['https://example.com:443', 'https://example.com'],
    ['https://example.com:8443', 'https://example.com:8443'],
    ['https://sub-1.example.co', 'https://sub-1.example.co'],
    ['https://localhost:3000', 'https://localhost:3000'],
  ])('%s → %s', (value, expected) => {
    expect(embedOriginOf(value)).toBe(expected);
  });

  it.each([
    'http://example.com',
    'http://localhost:5173',
    'https://example.com/path',
    'https://example.com?x=1',
    'https://example.com#x',
    'https://*.example.com',
    'https://user@example.com',
    'https://-bad.example.com',
    'https://exa_mple.com',
    'https://example..com',
    'https://example.com:0',
    'https://example.com:65536',
    'ftp://example.com',
    'javascript:alert(1)',
    'example.com',
    "https://example.com 'unsafe-inline'",
    'https://example.com;script-src *',
    '*',
    "'self'",
    '',
  ])('%s is not an origin that may embed', (value) => {
    expect(embedOriginOf(value)).toBeNull();
  });

  it.each([
    ['http://localhost:5173', 'http://localhost:5173'],
    ['http://127.0.0.1:8080/', 'http://127.0.0.1:8080'],
    ['http://[::1]:3000', 'http://[::1]:3000'],
    ['http://localhost:80', 'http://localhost'],
    ['http://example.com', null],
  ])('with allowLocalHttp: %s → %s', (value, expected) => {
    expect(embedOriginOf(value, { allowLocalHttp: true })).toBe(expected);
  });
});

describe('share link settings (T809)', () => {
  it('limits the allowed origins and the refresh interval', () => {
    const origins = Array.from(
      { length: MAX_EMBED_ORIGINS + 1 },
      (_, index) => `https://a${String(index)}.example.com`,
    );
    expect(
      createShareLinkRequestSchema.safeParse({
        settings: { embed: { enabled: true, allowed_origins: origins } },
      }).success,
    ).toBe(false);
    for (const [refresh, ok] of [
      [MIN_SHARE_REFRESH_SECONDS, true],
      [MAX_SHARE_REFRESH_SECONDS, true],
      [MIN_SHARE_REFRESH_SECONDS - 1, false],
      [MAX_SHARE_REFRESH_SECONDS + 1, false],
    ] as const) {
      expect(
        createShareLinkRequestSchema.safeParse({
          settings: { dashboard: { refresh_seconds: refresh } },
        }).success,
      ).toBe(ok);
    }
    expect(MAX_SHARE_REFRESH_SECONDS).toBe(3600);
  });
});

describe('webContentSecurityPolicy', () => {
  it.each([
    ['', [], "frame-ancestors 'none'"],
    ['', ['https://a.example.com'], 'frame-ancestors https://a.example.com'],
    [
      'https://files.example.com',
      ['https://a.example.com', 'https://b.example.com'],
      'frame-ancestors https://a.example.com https://b.example.com',
    ],
  ])('storage %s, ancestors %j → %s', (storage, ancestors, last) => {
    const policy = webContentSecurityPolicy(storage, ancestors);
    expect(policy.split('; ').at(-1)).toBe(last);
    expect(policy).toContain("script-src 'self'");
    expect(policy).not.toMatch(/unsafe-/u);
    if (storage !== '') expect(policy).toContain(`connect-src 'self' ${storage}`);
  });
});
