import { isApiError } from '../../../lib/api/client';

import type { OidcLinkError } from '@cellhive/contracts';

/**
 * `?error=<CODE>` of `/account/connections` after a link attempt (CONTRACTS
 * §27.3) → the `account` key of its message. Unknown values get the generic
 * message; the raw value is never shown (BACKLOG T715).
 */
const LINK_ERROR_KEYS = {
  IDENTITY_IN_USE: 'connections.linkError.IDENTITY_IN_USE',
  OIDC_STATE_INVALID: 'connections.linkError.OIDC_STATE_INVALID',
  OIDC_PROVIDER_ERROR: 'connections.linkError.OIDC_PROVIDER_ERROR',
  RATE_LIMITED: 'connections.linkError.RATE_LIMITED',
} as const satisfies Record<OidcLinkError | 'RATE_LIMITED', string>;

export type LinkErrorKey =
  (typeof LINK_ERROR_KEYS)[keyof typeof LINK_ERROR_KEYS] | 'connections.linkError.generic';

export function linkErrorKey(raw: string | null): LinkErrorKey | null {
  if (raw === null) return null;
  return Object.hasOwn(LINK_ERROR_KEYS, raw)
    ? LINK_ERROR_KEYS[raw as keyof typeof LINK_ERROR_KEYS]
    : 'connections.linkError.generic';
}

/** `DELETE /me/identities/:id` refused: the user would have no way left to sign in. */
export function isLastLoginMethod(error: unknown): boolean {
  return isApiError(error) && error.errors.some((item) => item.code === 'LAST_LOGIN_METHOD');
}

/** Only a web URL is followed after `POST …/start` (the contract says `https://…`). */
export function isNavigableUrl(raw: string): boolean {
  try {
    const protocol = new URL(raw).protocol;
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

/** Top-level navigation to the provider (an object so tests can replace it). */
export const providerNavigation = {
  open(url: string): void {
    if (isNavigableUrl(url)) window.location.assign(url);
  },
};
