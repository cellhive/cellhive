import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { json, problem, renderApp, stubApi } from '../../../../../test/app-harness';
import { axeViolations } from '../../../../../test/axe';
import { linkErrorKey, providerNavigation } from '../link-error';

const PROVIDERS = [
  { slug: 'keycloak', name: 'Keycloak' },
  { slug: 'authentik', name: 'Authentik' },
];

const KEYCLOAK_IDENTITY = {
  id: 'idn_0123456789ABCDEF',
  provider: 'keycloak',
  provider_name: 'Keycloak',
  email: 'an@sso.example.test',
  created_at: '2026-10-01T08:00:00.000Z',
  last_login_at: null,
};

const AUTHORIZATION_URL = 'https://sso.example.test/auth?client_id=c&max_age=0&state=s';

function lastLoginMethod(): Response {
  return new Response(
    JSON.stringify({
      type: 'https://cellhive.io/errors/VALIDATION_FAILED',
      title: 'VALIDATION_FAILED',
      status: 422,
      code: 'VALIDATION_FAILED',
      errors: [{ path: 'userIdentityId', code: 'LAST_LOGIN_METHOD', message: 'last' }],
      request_id: 'req_0123456789ABCDEF',
    }),
    { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

function serve(
  identities: (typeof KEYCLOAK_IDENTITY)[],
  routes: Record<string, (init: RequestInit | undefined) => Response> = {},
) {
  return stubApi({
    signedIn: true,
    routes: {
      'GET /setup': () =>
        json({
          setup_required: false,
          auth_config: { smtp_enabled: false, providers: PROVIDERS },
        }),
      'GET /me/identities': () => json({ items: identities }),
      ...routes,
    },
  });
}

beforeEach(() => {
  document.cookie = 'ob_csrf=csrf-token-value';
});

afterEach(() => {
  document.cookie = 'ob_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  vi.restoreAllMocks();
});

describe('linkErrorKey', () => {
  it.each([
    [null, null],
    ['IDENTITY_IN_USE', 'connections.linkError.IDENTITY_IN_USE'],
    ['OIDC_STATE_INVALID', 'connections.linkError.OIDC_STATE_INVALID'],
    ['OIDC_PROVIDER_ERROR', 'connections.linkError.OIDC_PROVIDER_ERROR'],
    ['RATE_LIMITED', 'connections.linkError.RATE_LIMITED'],
    ['OIDC_ACCOUNT_EXISTS', 'connections.linkError.generic'],
    ['constructor', 'connections.linkError.generic'],
  ])('%s → %s', (raw, key) => {
    expect(linkErrorKey(raw)).toBe(key);
  });
});

describe('ConnectionsPage', () => {
  it('lists the connected accounts and offers the providers not connected yet', async () => {
    serve([KEYCLOAK_IDENTITY]);
    await renderApp('/account/connections');
    const row = await screen.findByTestId('identity-row');
    expect(within(row).getByText('Keycloak')).toBeInTheDocument();
    expect(within(row).getByText('an@sso.example.test')).toBeInTheDocument();
    expect(row).toHaveTextContent('not used to sign in yet');
    expect(screen.getByRole('button', { name: 'Connect Authentik' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Connect Keycloak' })).toBeNull();
    expect(document.title).toContain('Connected accounts');
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('starts linking with a POST carrying the CSRF token, then opens the provider', async () => {
    const open = vi.spyOn(providerNavigation, 'open').mockImplementation(() => undefined);
    const fetchMock = serve([], {
      'POST /me/identities/authentik/start': () => json({ authorization_url: AUTHORIZATION_URL }),
    });
    await renderApp('/account/connections');
    expect(await screen.findByText('No account is connected yet.')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Connect Authentik' }));
    await waitFor(() => {
      expect(open).toHaveBeenCalledWith(AUTHORIZATION_URL);
    });
    const call = fetchMock.mock.calls.find(([url]) => url.includes('/authentik/start'));
    expect(call?.[1]?.method).toBe('POST');
    expect(new Headers(call?.[1]?.headers).get('X-CSRF-Token')).toBe('csrf-token-value');
    // On its way to the provider: no second start.
    expect(screen.getByRole('button', { name: 'Connect Keycloak' })).toBeDisabled();
  });

  it('shows the error of a failed start', async () => {
    serve([], {
      'POST /me/identities/keycloak/start': () => problem('DEPENDENCY_UNAVAILABLE', 503),
    });
    await renderApp('/account/connections');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Connect Keycloak' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect Keycloak' })).toBeEnabled();
  });

  it('disconnects after a confirmation in an alert dialog', async () => {
    let identities = [KEYCLOAK_IDENTITY];
    const fetchMock = serve([], {
      'GET /me/identities': () => json({ items: identities }),
      [`DELETE /me/identities/${KEYCLOAK_IDENTITY.id}`]: () => {
        identities = [];
        return new Response(null, { status: 204 });
      },
    });
    await renderApp('/account/connections');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Disconnect Keycloak' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Disconnect Keycloak?' });
    expect(await axeViolations(document.body)).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByText('No account is connected yet.')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE');
    expect(new Headers(call?.[1]?.headers).get('X-CSRF-Token')).toBe('csrf-token-value');
  });

  it('explains LAST_LOGIN_METHOD instead of disconnecting the only way to sign in', async () => {
    serve([KEYCLOAK_IDENTITY], {
      [`DELETE /me/identities/${KEYCLOAK_IDENTITY.id}`]: lastLoginMethod,
    });
    await renderApp('/account/connections');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Disconnect Keycloak' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    const explanation = await within(dialog).findByTestId('last-login-method');
    expect(explanation).toHaveTextContent('This is the only way you can sign in');
    expect(explanation).toHaveTextContent('Connect another provider first');
    expect(within(dialog).queryByRole('button', { name: 'Disconnect' })).toBeNull();
    // The account is still listed.
    expect(screen.getByTestId('identity-row')).toBeInTheDocument();
  });

  it('translates `?error=` of the link callback and never shows an unknown value', async () => {
    serve([]);
    const { router } = await renderApp('/account/connections?error=IDENTITY_IN_USE');
    expect(await screen.findByTestId('link-error')).toHaveTextContent(
      'This account of the provider is already connected to another Cellhive user',
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => {
      expect(screen.queryByTestId('link-error')).toBeNull();
    });
    expect(router.state.location.search).toBe('');

    await router.navigate('/account/connections?error=%3Cb%3Einjected%3C%2Fb%3E');
    expect(await screen.findByTestId('link-error')).toHaveTextContent(
      'The account was not connected. Try again.',
    );
    expect(document.body.textContent).not.toContain('injected');
  });

  it('says when the server has no identity provider', async () => {
    stubApi({
      signedIn: true,
      routes: {
        'GET /me/identities': () => json({ items: [] }),
      },
    });
    await renderApp('/account/connections');
    expect(
      await screen.findByText('No identity provider is set up on this server.'),
    ).toBeInTheDocument();
  });
});
