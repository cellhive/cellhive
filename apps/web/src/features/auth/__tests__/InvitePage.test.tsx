import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { json, ME, ORG, problem, renderApp, stubApi } from '../../../../test/app-harness';

const TOKEN = 'A'.repeat(43);

function preview(accountExists: boolean, email = 'new@example.test') {
  return () =>
    json({
      organization: { id: ORG.id, name: ORG.name },
      email,
      role: 'member',
      expires_at: '2026-09-30T00:00:00.000Z',
      account_exists: accountExists,
    });
}

describe('InvitePage (/invite/:token)', () => {
  it('shows one "no longer valid" screen for 410 INVITATION_INVALID', async () => {
    stubApi({
      routes: { [`GET /invitations/${TOKEN}`]: () => problem('INVITATION_INVALID', 410) },
    });
    await renderApp(`/invite/${TOKEN}`);
    expect(
      await screen.findByRole('heading', { name: 'This invitation is no longer valid' }),
    ).toBeInTheDocument();
  });

  it('asks an existing account to sign in first, coming back to the invitation', async () => {
    stubApi({ routes: { [`GET /invitations/${TOKEN}`]: preview(true, 'an@example.test') } });
    await renderApp(`/invite/${TOKEN}`);
    const link = await screen.findByRole('link', { name: 'Sign in as an@example.test to accept' });
    expect(link).toHaveAttribute('href', `/login?next=${encodeURIComponent(`/invite/${TOKEN}`)}`);
    expect(screen.getByText(/join Acme as a member/u)).toBeInTheDocument();
  });

  it('accepts in one click when signed in as the invited user', async () => {
    const accepted: unknown[] = [];
    stubApi({
      signedIn: true,
      routes: {
        [`GET /invitations/${TOKEN}`]: preview(true, ME.user.email),
        [`POST /invitations/${TOKEN}/accept`]: (init) => {
          accepted.push(JSON.parse(init?.body as string));
          return json({
            organization: { id: ORG.id, name: ORG.name, slug: ORG.slug },
            user: ME.user,
            role: 'member',
            workspace_id: null,
          });
        },
      },
    });
    const { router } = await renderApp(`/invite/${TOKEN}`);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Accept invitation' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/o/acme');
    });
    expect(accepted).toEqual([{}]);
  });

  it('creates the account with the invitation, then sends the user to sign in', async () => {
    let body: unknown;
    stubApi({
      routes: {
        [`GET /invitations/${TOKEN}`]: preview(false),
        [`POST /invitations/${TOKEN}/accept`]: (init) => {
          body = JSON.parse(init?.body as string);
          return json({
            organization: { id: ORG.id, name: ORG.name, slug: ORG.slug },
            user: { ...ME.user, email: 'new@example.test' },
            role: 'member',
            workspace_id: null,
          });
        },
      },
    });
    const { router } = await renderApp(`/invite/${TOKEN}`);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Your name'), 'Bình');
    await user.type(screen.getByLabelText('Password'), 'A-long-password-1');
    await user.type(screen.getByLabelText('Confirm password'), 'A-long-password-2');
    await user.click(screen.getByRole('button', { name: 'Create account and join' }));
    expect(await screen.findByText('The passwords do not match.')).toBeInTheDocument();

    await user.clear(screen.getByLabelText('Confirm password'));
    await user.type(screen.getByLabelText('Confirm password'), 'A-long-password-1');
    await user.click(screen.getByRole('button', { name: 'Create account and join' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/login');
    });
    expect(router.state.location.search).toBe('?next=%2Fo%2Facme');
    expect(body).toMatchObject({
      display_name: 'Bình',
      password: 'A-long-password-1',
      locale: 'en',
    });
    expect(await screen.findByLabelText('Email')).toHaveValue('new@example.test');
  });
});

describe('ResetPasswordPage (/reset/:token)', () => {
  it.each([
    [false, true],
    [true, false],
  ])(
    'sends revoke_tokens (box on by default; unticked: %s → %s), then goes to sign-in (T802)',
    async (untick, expected) => {
      const sent: unknown[] = [];
      stubApi({
        routes: {
          [`POST /auth/password-reset/${TOKEN}`]: (init) => {
            sent.push(JSON.parse(init?.body as string));
            return new Response(null, { status: 204 });
          },
        },
      });
      const { router } = await renderApp(`/reset/${TOKEN}`);
      const user = userEvent.setup();
      const box = await screen.findByRole('checkbox', { name: 'Revoke all my API tokens' });
      expect(box).toBeChecked();
      expect(box).toHaveAccessibleDescription(/Integrations, scripts and connections/u);
      if (untick) await user.click(box);
      await user.type(screen.getByLabelText('New password'), 'A-long-password-1');
      await user.type(screen.getByLabelText('Confirm password'), 'A-long-password-1');
      await user.click(screen.getByRole('button', { name: 'Change password' }));
      await waitFor(() => {
        expect(router.state.location.pathname).toBe('/login');
      });
      expect(sent).toEqual([{ password: 'A-long-password-1', revoke_tokens: expected }]);
    },
  );

  it('shows the expired-link screen for 410 RESET_TOKEN_INVALID', async () => {
    stubApi({
      routes: { [`POST /auth/password-reset/${TOKEN}`]: () => problem('RESET_TOKEN_INVALID', 410) },
    });
    await renderApp(`/reset/${TOKEN}`);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('New password'), 'A-long-password-1');
    await user.type(screen.getByLabelText('Confirm password'), 'A-long-password-1');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(
      await screen.findByRole('heading', { name: 'This link has expired or was already used' }),
    ).toBeInTheDocument();
  });

  it('shows a weak-password error from the server next to the field', async () => {
    stubApi({
      routes: {
        [`POST /auth/password-reset/${TOKEN}`]: () =>
          new Response(
            JSON.stringify({
              type: 'https://cellhive.io/errors/VALIDATION_FAILED',
              title: 'Validation failed',
              status: 422,
              code: 'VALIDATION_FAILED',
              errors: [{ path: 'password', code: 'PASSWORD_TOO_COMMON', message: 'Too common' }],
              request_id: 'req_0123456789ABCDEF',
            }),
            { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
          ),
      },
    });
    await renderApp(`/reset/${TOKEN}`);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('New password'), 'password1234');
    await user.type(screen.getByLabelText('Confirm password'), 'password1234');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(
      await screen.findByText('This password is too common. Choose another one.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('New password')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('req_0123456789ABCDEF');
  });
});
