import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { renderApp, stubApi } from '../../../../test/app-harness';

describe('LoginPage', () => {
  it('links to "forgot password" only when the server has SMTP', async () => {
    stubApi({ smtpEnabled: true });
    await renderApp('/login');
    expect(await screen.findByRole('link', { name: 'Forgot your password?' })).toHaveAttribute(
      'href',
      '/forgot-password',
    );
  });

  it('tells the user to ask an administrator without SMTP', async () => {
    stubApi({ smtpEnabled: false });
    await renderApp('/login');
    expect(await screen.findByText(/Ask an administrator/u)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Forgot your password?' })).toBeNull();
  });

  it('validates on the client with translated messages before calling the API', async () => {
    const fetchMock = stubApi({});
    await renderApp('/login');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Email'), 'not-an-email');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
    expect(screen.getByText('Required.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => url.includes('/auth/login'))).toBe(false);
  });

  it('shows "wrong email or password" for a 401 from sign-in', async () => {
    stubApi({});
    await renderApp('/login');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Email'), 'an@example.test');
    await user.type(screen.getByLabelText('Password'), 'wrong-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Wrong email or password.');
    });
  });
});
