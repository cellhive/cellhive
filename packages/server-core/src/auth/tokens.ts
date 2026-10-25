import { createHash, randomBytes } from 'node:crypto';

/**
 * Bearer tokens handed to browsers (session cookie, reset and invitation
 * links). Only their SHA-256 is stored.
 */

/** Random bytes in a session or reset token. */
export const TOKEN_BYTES = 32;

/** A new random bearer token: 32 bytes, base64url (43 characters). */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** Hex SHA-256: what `token_hash` columns hold. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
