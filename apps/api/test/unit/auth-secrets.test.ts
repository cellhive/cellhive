import { describe, expect, it } from 'vitest';

import { parseCookies, serializeCookie } from '../../src/common/auth/cookies.js';
import {
  checkCsrf,
  createCsrfToken,
  deriveKey,
  generateToken,
  hashToken,
  isWellFormedToken,
  safeEqual,
  verifyCsrfToken,
} from '../../src/common/auth/secrets.js';

const SECRET = 'unit-test-session-secret-0123456789abcdef';

describe('bearer tokens', () => {
  it('are 32 random bytes in base64url and differ every time', () => {
    const tokens = new Set(Array.from({ length: 100 }, generateToken));
    expect(tokens.size).toBe(100);
    for (const token of tokens) {
      expect(isWellFormedToken(token)).toBe(true);
      expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    }
  });

  it.each([
    ['', false],
    ['A'.repeat(42), false],
    ['A'.repeat(44), false],
    [`${'A'.repeat(42)}=`, false],
    [`${'A'.repeat(42)}+`, false],
    ['A'.repeat(43), true],
  ])('isWellFormedToken(%j) = %s', (token, expected) => {
    expect(isWellFormedToken(token)).toBe(expected);
  });

  it('are stored as hex SHA-256', () => {
    expect(hashToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('compares in constant time and handles different lengths', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('signed double-submit CSRF token', () => {
  const key = deriveKey(SECRET, 'csrf');
  const session = 'ses_A1b2C3d4E5f6G7h8';

  it('derives purpose-specific keys', () => {
    expect(key).toHaveLength(32);
    expect(deriveKey(SECRET, 'csrf').equals(key)).toBe(true);
    expect(deriveKey(SECRET, 'storage').equals(key)).toBe(false);
  });

  it('verifies for its session only, with the right key only', () => {
    const token = createCsrfToken(key, session);
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
    expect(verifyCsrfToken(key, session, token)).toBe(true);
    expect(verifyCsrfToken(key, 'ses_Other0000000000', token)).toBe(false);
    expect(
      verifyCsrfToken(deriveKey('another-secret-0123456789abcdef', 'csrf'), session, token),
    ).toBe(false);
  });

  it('rejects tampered and malformed tokens', () => {
    const token = createCsrfToken(key, session);
    const [nonce = '', signature = ''] = token.split('.');
    const flipped = `${nonce.slice(0, -1)}${nonce.endsWith('A') ? 'B' : 'A'}.${signature}`;
    expect(verifyCsrfToken(key, session, flipped)).toBe(false);
    expect(verifyCsrfToken(key, session, nonce)).toBe(false);
    expect(verifyCsrfToken(key, session, '')).toBe(false);
    expect(verifyCsrfToken(key, session, `${token}x`)).toBe(false);
  });

  it('requires the header to repeat the cookie', () => {
    const token = createCsrfToken(key, session);
    const other = createCsrfToken(key, session);
    expect(checkCsrf(key, session, token, token)).toBe(true);
    expect(checkCsrf(key, session, token, other)).toBe(false);
    expect(checkCsrf(key, session, undefined, token)).toBe(false);
    expect(checkCsrf(key, session, token, undefined)).toBe(false);
  });
});

describe('cookies', () => {
  it('parses a Cookie header; first occurrence wins; quotes removed', () => {
    const cookies = parseCookies('a=1; b="two"; a=3; bad; =x; c=');
    expect([...cookies]).toEqual([
      ['a', '1'],
      ['b', 'two'],
      ['c', ''],
    ]);
    expect(parseCookies(undefined).size).toBe(0);
  });

  it('serialises with Path=/, SameSite=Lax and the requested flags', () => {
    expect(
      serializeCookie('ob_session', 'tok', { httpOnly: true, secure: true, maxAgeSeconds: 60 }),
    ).toBe('ob_session=tok; Path=/; Max-Age=60; SameSite=Lax; HttpOnly; Secure');
    expect(
      serializeCookie('ob_csrf', 'x.y', { httpOnly: false, secure: false, maxAgeSeconds: 0 }),
    ).toBe('ob_csrf=x.y; Path=/; Max-Age=0; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  });

  it('refuses names and values that would break the header', () => {
    const options = { httpOnly: true, secure: false, maxAgeSeconds: 1 };
    expect(() => serializeCookie('a b', 'x', options)).toThrow(TypeError);
    expect(() => serializeCookie('a', 'x;y', options)).toThrow(TypeError);
    expect(() => serializeCookie('a', 'x\r\nSet-Cookie: z', options)).toThrow(TypeError);
  });
});
