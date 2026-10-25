import { describe, expect, it } from 'vitest';

import {
  loginRequestSchema,
  meResponseSchema,
  newPasswordSchema,
  passwordResetLinkSchema,
  RESET_TOKEN_PATTERN,
  setupRequestSchema,
} from '../src/auth.js';

const SETUP = {
  email: 'an@example.com',
  password: 'Correct-Horse-9',
  display_name: '  Nguyễn An ',
  org_name: 'Công ty A',
};

describe('auth schemas', () => {
  it('accepts a minimal setup request and trims names', () => {
    const parsed = setupRequestSchema.parse(SETUP);
    expect(parsed.display_name).toBe('Nguyễn An');
    expect(parsed.locale).toBeUndefined();
  });

  it.each([
    [{ ...SETUP, email: 'nope' }],
    [{ ...SETUP, password: 'short' }],
    [{ ...SETUP, display_name: '   ' }],
    [{ ...SETUP, locale: 'not a locale!' }],
    [{ ...SETUP, timezone: 'Mars/Olympus' }],
    [{ ...SETUP, extra: true }],
  ])('rejects %j', (input) => {
    expect(setupRequestSchema.safeParse(input).success).toBe(false);
  });

  it('accepts a known locale and time zone', () => {
    expect(
      setupRequestSchema.safeParse({ ...SETUP, locale: 'vi-VN', timezone: 'Asia/Ho_Chi_Minh' })
        .success,
    ).toBe(true);
  });

  it('enforces the new-password length only (10..256)', () => {
    expect(newPasswordSchema.safeParse('x'.repeat(9)).success).toBe(false);
    expect(newPasswordSchema.safeParse('x'.repeat(10)).success).toBe(true);
    expect(newPasswordSchema.safeParse('x'.repeat(257)).success).toBe(false);
  });

  it('does not apply the policy to login passwords', () => {
    expect(loginRequestSchema.safeParse({ email: 'a@b.co', password: 'x' }).success).toBe(true);
    expect(loginRequestSchema.safeParse({ email: 'a@b.co', password: '' }).success).toBe(false);
  });

  it('describes GET /me (CONTRACTS §5A)', () => {
    const me = {
      user: {
        id: 'usr_A1b2C3d4E5f6G7h8',
        email: 'a@b.co',
        display_name: 'A',
        avatar_url: null,
      },
      orgs: [{ id: 'org_A1b2C3d4E5f6G7h8', name: 'A', slug: 'a', role: 'owner' }],
      locale: 'vi',
      timezone: 'Asia/Ho_Chi_Minh',
    };
    expect(meResponseSchema.safeParse(me).success).toBe(true);
    // Every organization entry carries its slug (web routes are `/o/:slug`).
    expect(
      meResponseSchema.safeParse({
        ...me,
        orgs: [{ id: 'org_A1b2C3d4E5f6G7h8', name: 'A', role: 'owner' }],
      }).success,
    ).toBe(false);
  });

  it('describes reset links (CONTRACTS §12.1)', () => {
    expect(
      passwordResetLinkSchema.safeParse({
        reset_url: `https://x.test/reset/${'A'.repeat(43)}`,
        expires_at: '2026-09-24T03:15:00.000Z',
      }).success,
    ).toBe(true);
    expect(RESET_TOKEN_PATTERN.test('A'.repeat(43))).toBe(true);
    expect(RESET_TOKEN_PATTERN.test('A'.repeat(44))).toBe(false);
  });
});
