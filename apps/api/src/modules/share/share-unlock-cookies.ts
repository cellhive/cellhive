import { createHash, createHmac } from 'node:crypto';

import {
  SHARE_UNLOCK_COOKIE_PATH,
  SHARE_UNLOCK_COOKIE_PREFIX,
  SHARE_UNLOCK_TTL_SECONDS,
  type Id,
} from '@cellhive/contracts';

import { deriveKey, safeEqual } from '../../common/auth/secrets.js';

/** What an unlock cookie is bound to. */
export interface UnlockableLink {
  readonly id: Id<'shl'>;
  /** argon2id PHC string; a changed password invalidates earlier cookies. */
  readonly password_hash: string | null;
}

export interface IssuedUnlock {
  readonly value: string;
  readonly expiresAt: Date;
  readonly csrfToken: string;
}

const VALUE_PATTERN = /^([0-9a-z]{1,12})\.([A-Za-z0-9_-]{43})$/u;

/**
 * Unlock cookies of password-protected links (SPEC §15A.3, CONTRACTS
 * §12.0/§16A): stateless, `<expiry base36>.<HMAC-SHA256>` over the link id,
 * the expiry and a digest of the current password hash, keyed by a key
 * derived from `SESSION_SECRET`. One cookie per link
 * (`ob_share_<shl_…>`), `HttpOnly; SameSite=Strict; Path=/api/v1/shares/`,
 * 24 h. The CSRF token of a cookie is another HMAC of its value.
 */
export class ShareUnlockCookies {
  private readonly key: Buffer;

  constructor(sessionSecret: string) {
    this.key = deriveKey(sessionSecret, 'share-unlock');
  }

  nameOf(linkId: Id<'shl'>): string {
    return `${SHARE_UNLOCK_COOKIE_PREFIX}${linkId}`;
  }

  issue(link: UnlockableLink, now: Date = new Date()): IssuedUnlock {
    const expiresAt = new Date(now.getTime() + SHARE_UNLOCK_TTL_SECONDS * 1000);
    const expiry = Math.floor(expiresAt.getTime() / 1000).toString(36);
    const value = `${expiry}.${this.signature(link, expiry)}`;
    return {
      value,
      expiresAt: new Date(Number.parseInt(expiry, 36) * 1000),
      csrfToken: this.csrfTokenOf(value),
    };
  }

  /** Whether `value` unlocks `link` at `now` (right link, same password, not expired). */
  verify(link: UnlockableLink, value: string | undefined, now: Date = new Date()): boolean {
    if (value === undefined || link.password_hash === null) return false;
    const match = VALUE_PATTERN.exec(value);
    if (match === null) return false;
    const [, expiry = '', signature = ''] = match;
    if (Number.parseInt(expiry, 36) * 1000 <= now.getTime()) return false;
    return safeEqual(signature, this.signature(link, expiry));
  }

  csrfTokenOf(value: string): string {
    return createHmac('sha256', this.key).update(`csrf.${value}`, 'utf8').digest('base64url');
  }

  /** The CSRF header of a request carrying the valid cookie `value`. */
  csrfValid(value: string, header: string | undefined): boolean {
    return header !== undefined && safeEqual(header, this.csrfTokenOf(value));
  }

  /** `Set-Cookie` of an unlock (or of its removal with `maxAgeSeconds = 0`). */
  serialize(
    linkId: Id<'shl'>,
    value: string,
    options: { readonly secure: boolean; readonly maxAgeSeconds: number },
  ): string {
    const parts = [
      `${this.nameOf(linkId)}=${value}`,
      `Path=${SHARE_UNLOCK_COOKIE_PATH}`,
      `Max-Age=${String(Math.max(0, Math.floor(options.maxAgeSeconds)))}`,
      'SameSite=Strict',
      'HttpOnly',
    ];
    if (options.maxAgeSeconds <= 0) parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    if (options.secure) parts.push('Secure');
    return parts.join('; ');
  }

  private signature(link: UnlockableLink, expiry: string): string {
    const password = createHash('sha256')
      .update(link.password_hash ?? '', 'utf8')
      .digest('base64url');
    return createHmac('sha256', this.key)
      .update(`unlock.${link.id}.${expiry}.${password}`, 'utf8')
      .digest('base64url');
  }
}
