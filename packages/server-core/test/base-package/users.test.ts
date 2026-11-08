import { describe, expect, it } from 'vitest';

import {
  isUnknownUserEmail,
  normalizePackageEmail,
  PackageUserEmails,
  PackageUserMatcher,
} from '../../src/base-package/index.js';

import type { Id } from '@cellhive/contracts';

const AN = 'usr_An00000000000000' as Id<'usr'>;
const BINH = 'usr_Binh000000000000' as Id<'usr'>;

describe('email ↔ user (T1016)', () => {
  it('export: user id → email; an unknown id → one placeholder per id', () => {
    const emails = new PackageUserEmails([[AN, 'an@example.com']]);
    expect(emails.emailOf(AN)).toBe('an@example.com');
    expect(emails.emailOf('usr_Gone000000000000')).toBe('unknown-1@cellhive.invalid');
    expect(emails.emailOf('usr_Other00000000000')).toBe('unknown-2@cellhive.invalid');
    expect(emails.emailOf('usr_Gone000000000000')).toBe('unknown-1@cellhive.invalid');
    expect(emails.emailOrNull(null)).toBeNull();
    expect(emails.emailOrNull(undefined)).toBeNull();
    expect(emails.emailOrNull(AN)).toBe('an@example.com');
    expect(new PackageUserEmails(new Map([[AN, 'x@y.z']])).emailOf(AN)).toBe('x@y.z');
  });

  it('import: members of the target organization only, emails compared like citext', () => {
    const matcher = new PackageUserMatcher([
      { id: AN, email: 'An@Example.com' },
      { id: BINH, email: 'binh@example.com' },
    ]);
    expect(normalizePackageEmail('  AN@example.COM ')).toBe('an@example.com');
    expect(matcher.memberOf('an@example.com')).toBe(AN);
    expect(matcher.resolve(' BINH@example.com', 'value')).toBe(BINH);
    expect(matcher.memberOf('nobody@example.com')).toBeNull();
  });

  it('value places leave a stranger out; reference places get one new id per email', () => {
    const matcher = new PackageUserMatcher([{ id: AN, email: 'an@example.com' }]);
    expect(matcher.resolve('gone@example.com', 'value')).toBeNull();
    const ghost = matcher.resolve('gone@example.com', 'reference');
    expect(ghost).toMatch(/^usr_[0-9A-Za-z]{16}$/u);
    expect(matcher.resolve('GONE@example.com', 'reference')).toBe(ghost);
    expect(matcher.resolve('other@example.com', 'reference')).not.toBe(ghost);
  });

  it('reports only emails of the package that matched nobody, sorted, placeholders aside', () => {
    const matcher = new PackageUserMatcher([{ id: AN, email: 'an@example.com' }]);
    for (const email of [
      'zoe@example.com',
      'an@example.com',
      'bao@example.com',
      'unknown-1@cellhive.invalid',
    ]) {
      matcher.resolve(email, 'value');
    }
    matcher.resolve('ZOE@example.com', 'reference');
    expect(matcher.unmatchedEmails(10)).toEqual({
      emails: ['bao@example.com', 'zoe@example.com'],
      total: 2,
    });
    expect(matcher.unmatchedEmails(1)).toEqual({ emails: ['bao@example.com'], total: 2 });
    expect(isUnknownUserEmail('Unknown-3@CELLHIVE.invalid')).toBe(true);
    expect(isUnknownUserEmail('an@example.com')).toBe(false);
  });
});
