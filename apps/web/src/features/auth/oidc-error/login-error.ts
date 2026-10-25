import type { OidcLoginError } from '@cellhive/contracts';

/**
 * `?error=<CODE>` of `/login` after an OIDC sign-in (CONTRACTS §27.2) →
 * the `auth` key of its message. Only these known codes are translated;
 * anything else — including a value typed into the address bar — gets the
 * generic message, and the raw value is never shown (BACKLOG T715).
 */
const LOGIN_ERROR_KEYS = {
  OIDC_STATE_INVALID: 'login.ssoError.OIDC_STATE_INVALID',
  OIDC_PROVIDER_ERROR: 'login.ssoError.OIDC_PROVIDER_ERROR',
  OIDC_ACCOUNT_EXISTS: 'login.ssoError.OIDC_ACCOUNT_EXISTS',
  OIDC_SIGNUP_DISABLED: 'login.ssoError.OIDC_SIGNUP_DISABLED',
  OIDC_EMAIL_UNVERIFIED: 'login.ssoError.OIDC_EMAIL_UNVERIFIED',
  OIDC_DOMAIN_NOT_ALLOWED: 'login.ssoError.OIDC_DOMAIN_NOT_ALLOWED',
  // The callback answers `UNAUTHENTICATED` for a disabled user (T707 review): not the
  // "session ended" text of that code elsewhere.
  UNAUTHENTICATED: 'login.ssoError.accountDisabled',
  RATE_LIMITED: 'login.ssoError.RATE_LIMITED',
} as const satisfies Record<OidcLoginError, string>;

export type LoginErrorKey = (typeof LOGIN_ERROR_KEYS)[OidcLoginError] | 'login.ssoError.generic';

/** The message key for `?error=`, or `null` when the page has none. */
export function loginErrorKey(raw: string | null): LoginErrorKey | null {
  if (raw === null) return null;
  return Object.hasOwn(LOGIN_ERROR_KEYS, raw)
    ? LOGIN_ERROR_KEYS[raw as OidcLoginError]
    : 'login.ssoError.generic';
}
