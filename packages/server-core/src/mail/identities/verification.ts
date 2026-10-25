import { Buffer } from 'node:buffer';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

import {
  EMAIL_VERIFICATION_CODE_LENGTH,
  EMAIL_VERIFICATION_TOKEN_PATTERN,
  EMAIL_VERIFICATION_TTL_HOURS,
  isId,
  type Id,
} from '@cellhive/contracts';

import { generateToken, hashToken } from '../../auth/tokens.js';

/**
 * Verification of a sender identity (ADR-33 §2): a link token
 * `<org_id>.<secret>` (32 random bytes; only the SHA-256 of the secret is
 * stored) and a 6-digit code (stored as an HMAC under a key derived from
 * `APP_MASTER_KEY`, so a database read alone does not give the code). The
 * organization id in the token lets the public page call tenant
 * repositories with an `organizationId` like every other (AGENTS.md rule 5).
 */

export const EMAIL_VERIFICATION_TTL_MS = EMAIL_VERIFICATION_TTL_HOURS * 60 * 60 * 1000;

export interface IssuedVerification {
  /** For the link only: never stored, logged or returned by the API. */
  readonly token: string;
  readonly tokenHash: string;
  /** For the email only: never stored, logged or returned by the API. */
  readonly code: string;
  readonly codeHash: string;
}

/** HMAC-SHA256 (hex) of the code of `identityId`. */
export function verificationCodeHash(key: Buffer, identityId: Id<'eid'>, code: string): string {
  return createHmac('sha256', key).update(`${identityId}:${code}`, 'utf8').digest('hex');
}

/** Constant-time comparison of a typed code with the stored HMAC. */
export function verificationCodeMatches(
  key: Buffer,
  identityId: Id<'eid'>,
  code: string,
  codeHash: string,
): boolean {
  const actual = Buffer.from(verificationCodeHash(key, identityId, code), 'hex');
  const expected = Buffer.from(codeHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A new link token and code for an identity of `organizationId`. */
export function issueVerification(
  key: Buffer,
  organizationId: Id<'org'>,
  identityId: Id<'eid'>,
): IssuedVerification {
  const secret = generateToken();
  const code = String(randomInt(0, 10 ** EMAIL_VERIFICATION_CODE_LENGTH)).padStart(
    EMAIL_VERIFICATION_CODE_LENGTH,
    '0',
  );
  return {
    token: `${organizationId}.${secret}`,
    tokenHash: hashToken(secret),
    code,
    codeHash: verificationCodeHash(key, identityId, code),
  };
}

/** `{ organizationId, tokenHash }` of a well-formed token, else `null`. */
export function parseVerificationToken(
  token: string,
): { readonly organizationId: Id<'org'>; readonly tokenHash: string } | null {
  if (!EMAIL_VERIFICATION_TOKEN_PATTERN.test(token)) return null;
  const dot = token.indexOf('.');
  const organizationId = token.slice(0, dot);
  if (!isId('org', organizationId)) return null;
  return { organizationId, tokenHash: hashToken(token.slice(dot + 1)) };
}

/** The public page that confirms an identity (`GET` shows, `POST` confirms). */
export function verifySenderUrlOf(publicUrl: string, token: string): string {
  return `${publicUrl}/verify-sender?token=${encodeURIComponent(token)}`;
}
