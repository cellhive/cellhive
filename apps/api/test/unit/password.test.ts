import { describe, expect, it } from 'vitest';

import { COMMON_PASSWORDS_TEXT } from '../../src/common/auth/password/common-passwords.js';
import { ARGON2_OPTIONS, PasswordHasher } from '../../src/common/auth/password/password-hasher.js';
import {
  assertPasswordPolicy,
  isCommonPassword,
  passwordProblems,
} from '../../src/common/auth/password/password-policy.js';
import { slugify } from '../../src/modules/setup/org-provisioning.js';

describe('password policy (SPEC §14.2)', () => {
  it.each([
    ['short', 'TOO_SMALL'],
    ['123456789', 'TOO_SMALL'],
    ['qwertyuiop', 'PASSWORD_TOO_COMMON'],
    ['QwertyUIOP', 'PASSWORD_TOO_COMMON'],
    ['1234567890', 'PASSWORD_TOO_COMMON'],
    ['password123', 'PASSWORD_TOO_COMMON'],
    ['x'.repeat(257), 'TOO_BIG'],
  ])('rejects %j with %s', (password, code) => {
    expect(passwordProblems(password)).toEqual([
      expect.objectContaining({ path: 'password', code }),
    ]);
    expect(() => {
      assertPasswordPolicy(password);
    }).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it.each(['Correct-Horse-Battery-9', 'mật khẩu rất dài 2026', 'x'.repeat(256)])(
    'accepts %j',
    (password) => {
      expect(passwordProblems(password)).toEqual([]);
    },
  );

  it('ships a sorted, lower-case list of passwords of at least 10 characters', () => {
    const entries = COMMON_PASSWORDS_TEXT.split('\n');
    expect(entries.length).toBeGreaterThan(9000);
    expect(entries.every((entry) => entry.length >= 10 && entry === entry.toLowerCase())).toBe(
      true,
    );
    expect(new Set(entries).size).toBe(entries.length);
    expect(isCommonPassword('iloveyou12')).toBe(entries.includes('iloveyou12'));
  });
});

describe('PasswordHasher', () => {
  const hasher = new PasswordHasher({ memoryCost: 1024, timeCost: 1, parallelism: 1 });

  it('uses OWASP argon2id parameters by default', () => {
    expect(ARGON2_OPTIONS).toMatchObject({ memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  });

  it('hashes with argon2id and verifies', async () => {
    const hash = await hasher.hash('Correct-Horse-Battery-9');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=1024,t=1,p=1\$/);
    await expect(hasher.verify(hash, 'Correct-Horse-Battery-9')).resolves.toBe(true);
    await expect(hasher.verify(hash, 'correct-horse-battery-9')).resolves.toBe(false);
  });

  it('treats a malformed hash as a mismatch and has a dummy verification', async () => {
    await expect(hasher.verify('not-a-hash', 'x')).resolves.toBe(false);
    await expect(hasher.verifyDummy('anything')).resolves.toBe(false);
  });
});

describe('slugify', () => {
  it.each([
    ['Công ty Đông Á', 'cong-ty-dong-a'],
    ['  Acme,  Inc. ', 'acme-inc'],
    ['Nguyễn Văn Ánh & Co', 'nguyen-van-anh-co'],
    ['日本', 'org'],
    ['', 'org'],
    ['a'.repeat(60), 'a'.repeat(48)],
  ])('%j → %j', (name, slug) => {
    expect(slugify(name)).toBe(slug);
  });
});
