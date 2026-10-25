import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { json, renderApp, stubApi } from '../../../../test/app-harness';
import { axeViolations } from '../../../../test/axe';
import { initialsOf } from '../VerifySenderPage';

const TOKEN = 'org_0123456789ABCDEF.abc';
const FUTURE = '2099-10-06T03:40:00.000Z';

function invalid(): Response {
  return new Response(
    JSON.stringify({
      type: 'x',
      title: 'x',
      status: 422,
      code: 'EMAIL_VERIFICATION_INVALID',
      errors: [{ path: 'token', code: 'TOKEN_INVALID', message: 'x' }],
    }),
    { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

function serve(preview: () => Response, confirm: () => Response = () => json({})) {
  const bodies: { route: string; body: unknown }[] = [];
  const fetchMock = stubApi({
    routes: {
      'POST /email-identities/verify/preview': (init) => {
        bodies.push({ route: 'preview', body: JSON.parse(init?.body as string) });
        return preview();
      },
      'POST /email-identities/verify': (init) => {
        bodies.push({ route: 'confirm', body: JSON.parse(init?.body as string) });
        return confirm();
      },
    },
  });
  return { bodies, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('VerifySenderPage (T533)', () => {
  it('opening the link only shows the request; the button confirms it', async () => {
    const { bodies } = serve(
      () =>
        json({
          organization_name: 'Công ty Bán Hàng',
          email: 'ketoan@banhang.vn',
          display_name: 'Kế toán',
          requested_by: 'Nguyễn Minh Anh',
          expires_at: FUTURE,
        }),
      () => json({ status: 'verified', email: 'ketoan@banhang.vn' }),
    );
    const user = userEvent.setup();
    await renderApp(`/verify-sender?token=${encodeURIComponent(TOKEN)}`);
    const page = await screen.findByTestId('verify-sender-page');
    expect(within(page).getByRole('heading', { name: 'Confirm a sender address' })).toBeVisible();
    expect(page).toHaveTextContent(
      'Nguyễn Minh Anh (administrator of Công ty Bán Hàng) asks to use ketoan@banhang.vn',
    );
    expect(page).toHaveTextContent('Kế toán');
    expect(bodies).toEqual([{ route: 'preview', body: { token: TOKEN } }]);
    expect(await axeViolations(document.body)).toEqual([]);

    await user.click(within(page).getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByTestId('verify-sender-done')).toHaveTextContent(
      'ketoan@banhang.vn can now send automated emails of Công ty Bán Hàng',
    );
    expect(bodies.map((call) => call.route)).toEqual(['preview', 'confirm']);
    expect(document.title).toContain('Address confirmed');
  });

  it('an invalid, used or replaced link says so without a button', async () => {
    serve(invalid);
    await renderApp(`/verify-sender?token=${encodeURIComponent(TOKEN)}`);
    expect(await screen.findByTestId('verify-sender-invalid')).toHaveTextContent(
      'This link no longer works',
    );
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
  });

  it('a link without token is invalid and calls nothing', async () => {
    const { bodies } = serve(invalid);
    await renderApp('/verify-sender');
    expect(await screen.findByTestId('verify-sender-invalid')).toBeInTheDocument();
    expect(bodies).toEqual([]);
  });

  it('too many attempts from the network', async () => {
    serve(
      () =>
        new Response(JSON.stringify({ type: 'x', title: 'x', status: 429, code: 'RATE_LIMITED' }), {
          status: 429,
          headers: { 'Content-Type': 'application/problem+json', 'Retry-After': '600' },
        }),
    );
    await renderApp(`/verify-sender?token=${encodeURIComponent(TOKEN)}`);
    expect(await screen.findByTestId('verify-sender-rateLimited')).toHaveTextContent(
      'Too many attempts',
    );
  });

  it.each([
    ['Công ty Bán Hàng', 'CT'],
    ['acme', 'A'],
    ['  Ēlan  Vital ', 'ĒV'],
  ])('initialsOf(%j) = %j', (name, initials) => {
    expect(initialsOf(name)).toBe(initials);
  });
});
