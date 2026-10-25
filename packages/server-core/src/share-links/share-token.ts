import { createHash, randomBytes } from 'node:crypto';

import { SHARE_TOKEN_LENGTH, SHARE_TOKEN_PREFIX_LENGTH } from '@cellhive/contracts';

/** A fresh share link token and what may be stored about it (SPEC §15A.3). */
export interface ShareToken {
  /** 32 random bytes, base64url: returned once, never stored or logged. */
  readonly token: string;
  /** SHA-256 of the token, hex (`meta.share_links.token_hash`). */
  readonly hash: string;
  /** First six characters, for admins to recognise a link. */
  readonly prefix: string;
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/u;

/** SHA-256 (hex) of a token. */
export function hashShareToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Whether a string has the shape of a share token (checked before any lookup). */
export function isShareTokenFormat(value: string): boolean {
  return value.length === SHARE_TOKEN_LENGTH && TOKEN_PATTERN.test(value);
}

export function generateShareToken(): ShareToken {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    hash: hashShareToken(token),
    prefix: token.slice(0, SHARE_TOKEN_PREFIX_LENGTH),
  };
}
