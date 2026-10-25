import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { json, renderApp, stubApi } from '../../../../test/app-harness';
import { axeViolations } from '../../../../test/axe';
import { oidcStartHref } from '../login/ProviderButtons';
import { loginErrorKey } from '../oidc-error/login-error';

const PROVIDERS = [
  { slug: 'keycloak', name: 'Keycloak' },
  { slug: 'entra-id', name: 'Microsoft Entra ID' },
];

function withProviders(providers: readonly { slug: string; name: string }[]) {
  return stubApi({
    routes: {
      'GET /setup': () =>
        json({ setup_required: false, auth_config: { smtp_enabled: false, providers } }),
    },
  });
}

describe('loginErrorKey', () => {
  it.each([
    [null, null],
    ['OIDC_ACCOUNT_EXISTS', 'login.ssoError.OIDC_ACCOUNT_EXISTS'],
    ['OIDC_SIGNUP_DISABLED', 'login.ssoError.OIDC_SIGNUP_DISABLED'],
    ['OIDC_STATE_INVALID', 'login.ssoError.OIDC_STATE_INVALID'],
    ['OIDC_PROVIDER_ERROR', 'login.ssoError.OIDC_PROVIDER_ERROR'],
    ['OIDC_EMAIL_UNVERIFIED', 'login.ssoError.OIDC_EMAIL_UNVERIFIED'],
    ['OIDC_DOMAIN_NOT_ALLOWED', 'login.ssoError.OIDC_DOMAIN_NOT_ALLOWED'],
    ['RATE_LIMITED', 'login.ssoError.RATE_LIMITED'],
    ['UNAUTHENTICATED', 'login.ssoError.accountDisabled'],
    ['', 'login.ssoError.generic'],
    ['access_denied', 'login.ssoError.generic'],
    ['toString', 'login.ssoError.generic'],
    ['__proto__', 'login.ssoError.generic'],
  ])('%s → %s', (raw, key) => {
    expect(loginErrorKey(raw)).toBe(key);
  });
});

describe('oidcStartHref', () => {
  it.each([
    ['keycloak', null, '/api/v1/auth/oidc/keycloak/start'],
    ['keycloak', '/o/acme', '/api/v1/auth/oidc/keycloak/start?next=%2Fo%2Facme'],
    [
      'entra-id',
      '/b/bse_1/t/tbl_1?record=rec_1#x',
      '/api/v1/auth/oidc/entra-id/start?next=%2Fb%2Fbse_1%2Ft%2Ftbl_1%3Frecord%3Drec_1%23x',
    ],
  ])('%s, next %s → %s', (slug, next, href) => {
    expect(oidcStartHref(slug, next)).toBe(href);
  });
});

describe('LoginPage with OIDC providers', () => {
  it('links each provider to its start route with the safe `next`, above the password form', async () => {
    withProviders(PROVIDERS);
    await renderApp('/login?next=%2Fo%2Facme');
    const keycloak = await screen.findByRole('link', { name: 'Continue with Keycloak' });
    expect(keycloak).toHaveAttribute('href', '/api/v1/auth/oidc/keycloak/start?next=%2Fo%2Facme');
    expect(screen.getByRole('link', { name: 'Continue with Microsoft Entra ID' })).toHaveAttribute(
      'href',
      '/api/v1/auth/oidc/entra-id/start?next=%2Fo%2Facme',
    );
    expect(screen.getByText('or sign in with email')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it.each(['//evil.example', '/\\evil.example', 'https://evil.example/', '/.//evil.example'])(
    'drops an unsafe `next` (%s) from the provider link',
    async (next) => {
      withProviders(PROVIDERS.slice(0, 1));
      await renderApp(`/login?next=${encodeURIComponent(next)}`);
      expect(await screen.findByRole('link', { name: 'Continue with Keycloak' })).toHaveAttribute(
        'href',
        '/api/v1/auth/oidc/keycloak/start',
      );
    },
  );

  it('shows only the password form without providers', async () => {
    withProviders([]);
    await renderApp('/login');
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Continue with/u })).toBeNull();
    expect(screen.queryByText('or sign in with email')).toBeNull();
  });

  it('explains OIDC_ACCOUNT_EXISTS: sign in with the password, then connect', async () => {
    withProviders(PROVIDERS);
    await renderApp('/login?error=OIDC_ACCOUNT_EXISTS');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'An account with this email already exists. Sign in with your password, then connect the provider under "Connected accounts" in your account menu.',
    );
  });

  it('says a disabled account is disabled, not that the session ended (UNAUTHENTICATED)', async () => {
    withProviders(PROVIDERS);
    await renderApp('/login?error=UNAUTHENTICATED');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Your account has been disabled. Contact an administrator.');
    expect(alert).not.toHaveTextContent(/session/u);
  });

  it('never shows an unknown `error` value, only the generic message', async () => {
    withProviders(PROVIDERS);
    const raw = '<img src=x onerror=alert(1)> Call +1 555 0100 for help';
    await renderApp(`/login?error=${encodeURIComponent(raw)}`);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Sign-in did not complete. Try again.',
    );
    expect(document.body.textContent).not.toContain('555 0100');
    expect(document.querySelector('img')).toBeNull();
  });

  it('hides the OIDC error once the password form is submitted', async () => {
    withProviders(PROVIDERS);
    await renderApp('/login?error=OIDC_STATE_INVALID');
    expect(await screen.findByTestId('login-sso-error')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email'), 'an@example.test');
    await user.type(screen.getByLabelText('Password'), 'wrong-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => {
      expect(screen.queryByTestId('login-sso-error')).toBeNull();
    });
  });
});
