import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { json, ME, renderApp, stubApi } from '../../../../test/app-harness';
import { axeViolations } from '../../../../test/axe';
import { clearToasts } from '../../../lib/toast/toast';

import type { MeResponse } from '@cellhive/contracts';

/** `/account` (T831): profile (`PATCH /me`) and password (`POST /me/password`). */

const NEW_PASSWORD = 'Profile-Change-Secret-2026';

function validationFailed(path: string, code: string): Response {
  return new Response(
    JSON.stringify({
      type: 'https://cellhive.io/errors/VALIDATION_FAILED',
      title: 'VALIDATION_FAILED',
      status: 422,
      code: 'VALIDATION_FAILED',
      errors: [{ path, code, message: code }],
      request_id: 'req_0123456789ABCDEF',
    }),
    { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

function serve(password: (body: unknown) => Response = () => new Response(null, { status: 204 })) {
  let me: MeResponse = { ...ME, user: { ...ME.user }, orgs: [...ME.orgs] };
  const calls: [string, unknown][] = [];
  const body = (init: RequestInit | undefined) =>
    typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
  stubApi({
    signedIn: true,
    routes: {
      'GET /me': () => json(me),
      'GET /me/identities': () => json({ items: [] }),
      'PATCH /me': (init) => {
        const changes = body(init) as { display_name?: string; locale?: string };
        calls.push(['PATCH /me', changes]);
        me = {
          ...me,
          user: { ...me.user, display_name: changes.display_name ?? me.user.display_name },
          locale: changes.locale ?? me.locale,
        };
        return json(me);
      },
      'POST /me/password': (init) => {
        calls.push(['POST /me/password', body(init)]);
        return password(body(init));
      },
    },
  });
  return { calls };
}

afterEach(() => {
  clearToasts();
  window.localStorage.clear();
});

describe('account page › profile', () => {
  it('saves only what changed, updates the signed-in user and applies a new language', async () => {
    const { calls } = serve();
    await renderApp('/account');
    const form = await screen.findByTestId('profile-form');
    expect(within(form).getByRole('button', { name: 'Save changes' })).toBeDisabled();
    // No identity provider and no identity: no "Connected accounts" section.
    expect(screen.queryByTestId('connections-section')).toBeNull();
    expect(await axeViolations(document.body)).toEqual([]);

    const name = within(form).getByLabelText('Display name');
    await userEvent.clear(name);
    await userEvent.type(name, '  An Trần ');
    await userEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Profile saved.')).toBeVisible();
    // The sidebar's account menu reads the cached `me`.
    expect(screen.getByRole('button', { name: 'Account menu for An Trần' })).toBeVisible();

    await userEvent.selectOptions(
      within(screen.getByTestId('profile-form')).getByLabelText('Language'),
      'vi',
    );
    await userEvent.click(
      within(screen.getByTestId('profile-form')).getByRole('button', { name: 'Save changes' }),
    );
    // Already in the new language.
    expect(await screen.findByText('Đã lưu hồ sơ.')).toBeVisible();
    expect(window.localStorage.getItem('cellhive.language')).toBe('vi');
    expect(calls).toEqual([
      ['PATCH /me', { display_name: 'An Trần' }],
      ['PATCH /me', { locale: 'vi' }],
    ]);
  });
});

describe('account page › password', () => {
  it('checks the confirmation, shows a wrong current password under its field, then changes it', async () => {
    let attempts = 0;
    const { calls } = serve(() => {
      attempts += 1;
      return attempts === 1
        ? validationFailed('current_password', 'CURRENT_PASSWORD_INVALID')
        : new Response(null, { status: 204 });
    });
    await renderApp('/account');
    const form = await screen.findByTestId('password-form');
    const user = userEvent.setup();
    await user.type(within(form).getByLabelText('Current password'), 'Old-Secret-2026');
    await user.type(within(form).getByLabelText('New password'), NEW_PASSWORD);
    await user.type(within(form).getByLabelText('Confirm new password'), 'Something-Else-2026');
    await user.click(within(form).getByRole('button', { name: 'Change password' }));
    expect(await within(form).findByText('The passwords do not match.')).toBeVisible();
    expect(calls).toEqual([]);

    await user.clear(within(form).getByLabelText('Confirm new password'));
    await user.type(within(form).getByLabelText('Confirm new password'), NEW_PASSWORD);
    await user.click(within(form).getByRole('button', { name: 'Change password' }));
    expect(await within(form).findByText('The current password is wrong.')).toBeVisible();
    expect(within(form).getByLabelText('Current password')).toHaveAttribute('aria-invalid', 'true');
    expect(await axeViolations(document.body)).toEqual([]);

    await user.click(within(form).getByLabelText('Revoke all my API tokens'));
    await user.click(within(form).getByRole('button', { name: 'Change password' }));
    expect(
      await screen.findByText('Password changed. Other devices are signed out.'),
    ).toBeVisible();
    await waitFor(() => {
      expect(within(form).getByLabelText('Current password')).toHaveValue('');
    });
    const request = {
      current_password: 'Old-Secret-2026',
      new_password: NEW_PASSWORD,
    };
    expect(calls).toEqual([
      ['POST /me/password', { ...request, revoke_tokens: false }],
      ['POST /me/password', { ...request, revoke_tokens: true }],
    ]);
  });
});
