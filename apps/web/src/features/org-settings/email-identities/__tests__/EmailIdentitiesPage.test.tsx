import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { json, ME, ORG, problem, renderApp, stubApi } from '../../../../../test/app-harness';
import { axeViolations } from '../../../../../test/axe';
import { clearToasts } from '../../../../lib/toast/toast';

import type { EmailIdentityDto } from '@cellhive/contracts';

const PATH = `/o/${ORG.slug}/settings/email/identities`;
const NOW = '2026-10-05T03:00:00.000Z';
const LATER = '2026-10-06T03:00:00.000Z';
const BASE = { id: 'bse_0123456789ABCDEF', name: 'Sales' } as const;

function identity(overrides: Partial<EmailIdentityDto>): EmailIdentityDto {
  return {
    id: 'eid_0000000000000001',
    organization_id: ORG.id,
    email: 'hr@acme.test',
    display_name: 'Human Resources',
    display_name_issue: null,
    reply_to: null,
    transport: 'system',
    mode: 'send_as',
    status: 'verified',
    error_reason: null,
    verified_at: NOW,
    verified_via: 'code',
    base_scope: 'all',
    base_ids: [],
    signature_md: null,
    smtp: null,
    display: { from: '"Human Resources" <hr@acme.test>', reply_to: null },
    hints: ['spf_dkim_alignment'],
    verification: { pending: false, sent_at: null, expires_at: null, code_attempts_left: null },
    created_by: ME.user.id,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

const HR = identity({});
const IT = identity({
  id: 'eid_0000000000000002',
  email: 'support@partner.test',
  display_name: 'IT Helpdesk',
  mode: 'on_behalf',
  display: {
    from: '"IT Helpdesk (via Cellhive)" <no-reply@acme.test>',
    reply_to: '<support@partner.test>',
  },
  base_scope: 'selected',
  base_ids: [BASE.id],
});
const MAIL = identity({
  id: 'eid_0000000000000003',
  email: 'it@acme.test',
  display_name: 'IT',
  transport: 'smtp',
  status: 'pending',
  verified_at: null,
  verified_via: null,
  smtp: {
    host: 'mail.acme.test',
    port: 587,
    security: 'starttls',
    username: 'it@acme.test',
    password_set: true,
  },
  verification: { pending: true, sent_at: NOW, expires_at: LATER, code_attempts_left: 5 },
});

/** T556 (QA S5 M7): a display name saved before T540, flagged by the server. */
const FLAGGED = identity({
  id: 'eid_0000000000000004',
  email: 'billing@acme.test',
  display_name: 'PayPal <a@b>',
  display_name_issue: 'angle_bracket',
  display: { from: '"PayPal <a@b>" <billing@acme.test>', reply_to: null },
});

const SETTINGS = {
  smtp: {
    configured: true,
    host: '***.acme.test',
    port: 587,
    security: 'starttls',
    from: 'no-reply@acme.test',
    from_name: 'Acme',
    allowed_from_domains: ['acme.test'],
  },
  limits: {
    max_per_hour_per_org: 500,
    max_recipients: 50,
    max_per_second_per_process: 5,
    test_sends_per_minute: 5,
    max_html_bytes: 102400,
    max_attachments: 10,
    max_attachment_bytes: 15 * 1024 * 1024,
    max_inline_images: 5,
  },
  usage: { sent_this_hour: 0, resets_at: LATER },
  automation: {
    instance_footer_policy: 'required',
    footer_policy: 'required',
    footer_none_allowed: false,
    default_signature_md: null,
    system_sender_enabled: true,
    max_attachments: 10,
    max_attachment_bytes: 15 * 1024 * 1024,
    attachment_limits_custom: false,
    system_sender_usage: { automations: 0, enabled_automations: 0 },
  },
};

interface Call {
  readonly route: string;
  readonly body: unknown;
}

function serve(initial: EmailIdentityDto[], role: 'owner' | 'member' = 'owner') {
  let items = initial;
  const calls: Call[] = [];
  const record = (route: string, init: RequestInit | undefined) => {
    calls.push({ route, body: typeof init?.body === 'string' ? JSON.parse(init.body) : null });
  };
  const put = (next: EmailIdentityDto) => {
    items = items.some((item) => item.id === next.id)
      ? items.map((item) => (item.id === next.id ? next : item))
      : [...items, next];
    return next;
  };
  const routes: Record<string, (init: RequestInit | undefined) => Response> = {
    'GET /me': () => json({ ...ME, orgs: [{ ...ME.orgs[0], role }] }),
    [`GET /orgs/${ORG.id}`]: () => json(ORG),
    [`GET /orgs/${ORG.id}/email-identities`]: () => json({ items }),
    [`GET /orgs/${ORG.id}/email-settings`]: () => json(SETTINGS),
    [`GET /orgs/${ORG.id}/workspaces`]: () =>
      json({
        items: [
          {
            id: 'wsp_0123456789ABCDEF',
            organization_id: ORG.id,
            name: 'Main',
            slug: 'main',
            role: 'admin',
            created_at: NOW,
            updated_at: NOW,
          },
        ],
        total: 1,
        offset: 0,
        limit: 1000,
      }),
    'GET /workspaces/wsp_0123456789ABCDEF/bases': () =>
      json({
        items: [
          {
            id: BASE.id,
            organization_id: ORG.id,
            workspace_id: 'wsp_0123456789ABCDEF',
            owner_id: ME.user.id,
            name: BASE.name,
            icon: null,
            description: null,
            permission_version: 1,
            created_at: NOW,
            updated_at: NOW,
            deleted_at: null,
          },
        ],
        total: 1,
        offset: 0,
        limit: 1000,
      }),
    [`POST /orgs/${ORG.id}/email-identities`]: (init) => {
      record('create', init);
      const body = JSON.parse(init?.body as string) as { email: string; display_name: string };
      const created = put(
        identity({
          id: 'eid_0000000000000009',
          email: body.email,
          display_name: body.display_name,
          status: 'pending',
          verified_at: null,
          verified_via: null,
          verification: { pending: true, sent_at: NOW, expires_at: LATER, code_attempts_left: 5 },
        }),
      );
      return json(
        {
          identity: created,
          verification: {
            status: 'sent',
            to: body.email,
            expires_at: LATER,
            smtp: { code: 250, enhanced: null },
          },
        },
        201,
      );
    },
    'POST /email-identities/eid_0000000000000009/verify-code': (init) => {
      record('verify-code', init);
      const body = JSON.parse(init?.body as string) as { code: string };
      if (body.code !== '482917') {
        return new Response(
          JSON.stringify({
            type: 'x',
            title: 'x',
            status: 422,
            code: 'EMAIL_VERIFICATION_INVALID',
            errors: [
              { path: 'code', code: 'CODE_INVALID', message: 'x', params: { attempts_left: 4 } },
            ],
          }),
          { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
        );
      }
      const current = items.find((item) => item.id === 'eid_0000000000000009');
      return json(
        put({
          ...(current as EmailIdentityDto),
          status: 'verified',
          verified_via: 'code',
          verified_at: NOW,
          verification: {
            pending: false,
            sent_at: null,
            expires_at: null,
            code_attempts_left: null,
          },
        }),
      );
    },
    [`POST /email-identities/${MAIL.id}/test-and-verify`]: (init) => {
      record('test-and-verify', init);
      return json({
        status: 'failed',
        step: 'auth',
        code: 'smtp_rejected',
        reason: 'auth_failed',
        smtp: { code: 535, enhanced: '5.7.8' },
      });
    },
    [`PATCH /email-identities/${MAIL.id}`]: (init) => {
      record('update', init);
      return json({ identity: MAIL, verification: null });
    },
    [`POST /email-identities/${HR.id}/disable`]: (init) => {
      record('disable', init);
      return json(put({ ...HR, status: 'disabled' }));
    },
  };
  for (const item of initial) {
    routes[`GET /email-identities/${item.id}/usages`] = () =>
      item.id === HR.id
        ? json({
            items: [
              { automation_id: 'aut_0000000000000001', base_id: BASE.id, name: 'Interview invite' },
              {
                automation_id: 'aut_0000000000000002',
                base_id: 'bse_Hidden0000000001',
                name: null,
              },
            ],
            total: 2,
          })
        : json({ items: [], total: 0 });
  }
  routes['GET /email-identities/eid_0000000000000009/usages'] = () => json({ items: [], total: 0 });
  const fetchMock = stubApi({ signedIn: true, routes });
  return { calls, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
});

describe('EmailIdentitiesPage (T533)', () => {
  it('lists identities with how they send, status, scope and usage', async () => {
    serve([HR, IT, MAIL]);
    await renderApp(PATH);
    const table = await screen.findByRole('table', { name: 'Sender identities' });
    const hr = within(table).getByTestId(`identity-row-${HR.id}`);
    expect(hr).toHaveTextContent('Sent directly');
    expect(hr).toHaveTextContent('Recipients see: Human Resources <hr@acme.test>');
    expect(hr).toHaveTextContent('Verified');
    expect(hr).toHaveTextContent('All bases');
    await waitFor(() => {
      expect(within(hr).getByTestId('identity-usage')).toHaveTextContent('2');
    });
    const it = within(table).getByTestId(`identity-row-${IT.id}`);
    expect(it).toHaveTextContent('Sent on behalf');
    expect(it).toHaveTextContent('IT Helpdesk (via Cellhive) <no-reply@acme.test>');
    await waitFor(() => {
      expect(it).toHaveTextContent('Sales');
    });
    const mail = within(table).getByTestId(`identity-row-${MAIL.id}`);
    expect(mail).toHaveTextContent('Waiting for verification');
    expect(mail).toHaveTextContent('Own server: mail.acme.test');
    expect(within(mail).getByRole('button', { name: /Enter code/u })).toBeInTheDocument();
    expect(screen.getByTestId('domains-note')).toHaveTextContent('acme.test');
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('adds an identity, previews how it sends, then verifies it by code', async () => {
    const { calls } = serve([HR]);
    const user = userEvent.setup();
    await renderApp(PATH);
    await user.click(await screen.findByTestId('identity-add'));
    const drawer = await screen.findByRole('dialog', { name: 'Add sender identity' });
    await user.type(within(drawer).getByLabelText('Email address'), 'support@partner.test');
    await user.type(within(drawer).getByLabelText('Display name'), 'IT Helpdesk');
    const preview = within(drawer).getByTestId('sender-preview');
    expect(preview).toHaveTextContent('Sent on behalf');
    expect(preview).toHaveTextContent('IT Helpdesk (via Cellhive) <no-reply@acme.test>');
    expect(preview).toHaveTextContent('Replies go to: support@partner.test');
    await user.clear(within(drawer).getByLabelText('Email address'));
    await user.type(within(drawer).getByLabelText('Email address'), 'it@acme.test');
    expect(within(drawer).getByTestId('sender-preview')).toHaveTextContent('Sent directly');

    // Signature: placeholders are refused as you type; images preview as text.
    const signature = within(drawer).getByLabelText('Signature');
    await user.type(signature, 'Hi {{{{');
    expect(within(drawer).getByText(/remove the double curly braces/u)).toBeInTheDocument();
    await user.clear(signature);
    await user.type(signature, '**IT** team');
    expect(within(drawer).getByTestId('signature-preview')).toHaveTextContent('IT team');

    await user.click(
      within(drawer).getByRole('button', { name: 'Save and send verification email' }),
    );
    const verify = await screen.findByRole('dialog', { name: 'Verify it@acme.test' });
    expect(calls.find((call) => call.route === 'create')?.body).toEqual({
      email: 'it@acme.test',
      display_name: 'IT Helpdesk',
      reply_to: null,
      transport: 'system',
      base_scope: 'all',
      base_ids: [],
      signature_md: '**IT** team',
    });
    expect(within(verify).getByTestId('verify-sent')).toHaveTextContent(
      'Verification email sent to it@acme.test',
    );
    const code = within(verify).getByLabelText('6-digit code');
    await user.type(code, '111-111');
    await user.click(within(verify).getByRole('button', { name: 'Verify' }));
    expect(await within(verify).findByRole('alert')).toHaveTextContent(
      'Wrong code. 4 attempts left.',
    );
    await user.clear(code);
    await user.type(code, '482 917');
    await user.click(within(verify).getByRole('button', { name: 'Verify' }));
    expect(await within(verify).findByTestId('verify-done')).toHaveTextContent(
      'it@acme.test is verified',
    );
    expect(calls.filter((call) => call.route === 'verify-code').map((call) => call.body)).toEqual([
      { code: '111111' },
      { code: '482917' },
    ]);
  });

  it('never shows a stored SMTP password and reports "Test & verify" per step', async () => {
    const { calls } = serve([MAIL]);
    const user = userEvent.setup();
    await renderApp(PATH);
    await user.click(await screen.findByTestId(`identity-menu-${MAIL.id}`));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    const drawer = await screen.findByRole('dialog', { name: 'Edit IT' });
    expect(within(drawer).getByTestId('smtp-password-saved')).toHaveTextContent('Saved');
    expect(within(drawer).queryByLabelText('Password')).toBeNull();
    expect(within(drawer).getByLabelText('Host')).toHaveValue('mail.acme.test');
    // A new user name needs a new verification.
    await user.type(within(drawer).getByLabelText('User name'), 'x');
    expect(within(drawer).getByTestId('reverify-warning')).toBeInTheDocument();
    await user.click(within(drawer).getByRole('button', { name: 'Change password' }));
    const password = within(drawer).getByLabelText('Password');
    expect(password).toHaveValue('');
    expect(password).toHaveAttribute('type', 'password');
    await user.click(within(drawer).getByRole('button', { name: 'Keep the saved password' }));
    await user.clear(within(drawer).getByLabelText('User name'));
    await user.type(within(drawer).getByLabelText('User name'), 'it@acme.test');
    expect(within(drawer).queryByTestId('reverify-warning')).toBeNull();
    // Encryption "None" must be confirmed.
    await user.click(within(drawer).getByRole('radio', { name: 'None' }));
    expect(within(drawer).getByLabelText('Port')).toHaveValue('25');
    await user.click(within(drawer).getByRole('button', { name: 'Save' }));
    expect(
      within(drawer).getByText('Confirm the unencrypted connection, or choose STARTTLS or TLS.'),
    ).toBeInTheDocument();
    expect(calls.some((call) => call.route === 'update')).toBe(false);
    await user.click(within(drawer).getByRole('button', { name: 'Cancel' }));

    await user.click(screen.getByRole('button', { name: /Enter code/u }));
    const verify = await screen.findByRole('dialog', { name: 'Verify it@acme.test' });
    await user.click(within(verify).getByTestId('verify-resend'));
    const failed = await within(verify).findByTestId('verify-failed');
    expect(failed).toHaveTextContent('The server refused the user name or password');
    expect(failed).toHaveTextContent('SMTP reply 535 5.7.8');
    const steps = within(failed).getByTestId('verify-steps');
    expect(
      [...steps.querySelectorAll('li')].map((step) => [
        step.dataset['step'],
        step.dataset['state'],
      ]),
    ).toEqual([
      ['connect', 'done'],
      ['tls', 'done'],
      ['auth', 'failed'],
      ['send', 'not_run'],
    ]);
    expect(calls.map((call) => call.route)).toEqual(['test-and-verify']);
  });

  it('lists the automations using an identity before turning it off', async () => {
    const { calls } = serve([HR]);
    const user = userEvent.setup();
    await renderApp(PATH);
    await user.click(await screen.findByTestId(`identity-menu-${HR.id}`));
    await user.click(await screen.findByRole('menuitem', { name: 'Turn off' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Turn off Human Resources?' });
    const usages = await within(confirm).findByTestId('identity-usages');
    expect(usages).toHaveTextContent('Interview invite');
    expect(usages).toHaveTextContent('Automation of a base you cannot see');
    expect(within(confirm).getByText('2 automations send as this identity:')).toBeInTheDocument();
    await user.click(within(confirm).getByTestId('identity-confirm'));
    await waitFor(() => {
      expect(screen.getByTestId(`identity-row-${HR.id}`)).toHaveTextContent('Off');
    });
    expect(calls.map((call) => call.route)).toEqual(['disable']);
  });

  it('flags a display name saved before T540 and fixes it from the row (T556)', async () => {
    const { calls, fetchMock } = serve([FLAGGED, HR]);
    let patches = 0;
    const FIXED: EmailIdentityDto = {
      ...FLAGGED,
      display_name: 'PayPal Support',
      display_name_issue: null,
      display: { from: '"PayPal Support" <billing@acme.test>', reply_to: null },
    };
    const wrapped = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((input: string, init?: RequestInit) => {
      const path = new URL(input, 'http://localhost').pathname.replace('/api/v1', '');
      if (path === `/orgs/${ORG.id}/email-identities` && patches > 1) {
        return Promise.resolve(json({ items: [FIXED, HR] }));
      }
      if (path === `/email-identities/${FLAGGED.id}` && init?.method === 'PATCH') {
        patches += 1;
        calls.push({ route: 'update', body: JSON.parse(init.body as string) });
        if (patches === 1) {
          // The server is the judge: its reason is shown under the field.
          return Promise.resolve(
            new Response(
              JSON.stringify({
                type: 'x',
                title: 'x',
                status: 422,
                code: 'VALIDATION_FAILED',
                errors: [
                  {
                    path: 'display_name',
                    code: 'DISPLAY_NAME_NOT_ALLOWED',
                    message: 'x',
                    params: { reason: 'at_sign' },
                  },
                ],
              }),
              { status: 422, headers: { 'Content-Type': 'application/problem+json' } },
            ),
          );
        }
        return Promise.resolve(json({ identity: FIXED, verification: null }));
      }
      return wrapped?.(input, init) ?? Promise.resolve(problem('NOT_FOUND', 404));
    });
    const user = userEvent.setup();
    await renderApp(PATH);
    const row = await screen.findByTestId(`identity-row-${FLAGGED.id}`);
    const flag = within(row).getByTestId('display-name-issue');
    expect(flag).toHaveTextContent('Display name needs a fix');
    expect(flag).toHaveTextContent(
      'The display name cannot contain < or >: recipients could take it for an email address.',
    );
    expect(
      within(screen.getByTestId(`identity-row-${HR.id}`)).queryByTestId('display-name-issue'),
    ).toBeNull();
    expect(await axeViolations(document.body)).toEqual([]);

    await user.click(within(flag).getByRole('button', { name: 'Fix display name · PayPal <a@b>' }));
    const drawer = await screen.findByRole('dialog', { name: 'Edit PayPal <a@b>' });
    expect(within(drawer).getByTestId('display-name-issue-note')).toHaveTextContent(
      'This display name is no longer accepted',
    );
    const name = within(drawer).getByLabelText('Display name');
    await waitFor(() => {
      expect(name).toHaveFocus();
    });
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(name).toHaveAccessibleDescription(/cannot contain < or >/u);

    // Another refused name: worded by its reason as it is typed, and not sent.
    await user.clear(name);
    await user.type(name, 'PayPal www.paypal.com');
    expect(name).toHaveAccessibleDescription(/cannot look like a web address/u);
    await user.click(within(drawer).getByRole('button', { name: 'Save' }));
    expect(calls.some((call) => call.route === 'update')).toBe(false);

    await user.clear(name);
    await user.type(name, 'PayPal Support');
    expect(name).toHaveAttribute('aria-invalid', 'false');
    await user.click(within(drawer).getByRole('button', { name: 'Save' }));
    expect(
      await within(drawer).findByText(
        'The display name cannot contain @: recipients could take it for an email address.',
      ),
    ).toBeInTheDocument();
    await user.click(within(drawer).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Edit PayPal <a@b>' })).toBeNull();
    });
    expect(calls.filter((call) => call.route === 'update').map((call) => call.body)).toEqual([
      { display_name: 'PayPal Support' },
      { display_name: 'PayPal Support' },
    ]);
    await waitFor(() => {
      expect(
        within(screen.getByTestId(`identity-row-${FLAGGED.id}`)).queryByTestId(
          'display-name-issue',
        ),
      ).toBeNull();
    });
  });

  it('keeps a flagged name while other settings are saved (T556)', async () => {
    const { calls, fetchMock } = serve([FLAGGED]);
    const wrapped = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((input: string, init?: RequestInit) => {
      const path = new URL(input, 'http://localhost').pathname.replace('/api/v1', '');
      if (path === `/email-identities/${FLAGGED.id}` && init?.method === 'PATCH') {
        calls.push({ route: 'update', body: JSON.parse(init.body as string) });
        return Promise.resolve(
          json({ identity: { ...FLAGGED, signature_md: 'Thanks' }, verification: null }),
        );
      }
      return wrapped?.(input, init) ?? Promise.resolve(problem('NOT_FOUND', 404));
    });
    const user = userEvent.setup();
    await renderApp(PATH);
    await user.click(await screen.findByTestId(`identity-menu-${FLAGGED.id}`));
    await user.click(await screen.findByRole('menuitem', { name: 'Edit' }));
    const drawer = await screen.findByRole('dialog', { name: 'Edit PayPal <a@b>' });
    await user.type(within(drawer).getByLabelText('Signature'), 'Thanks');
    await user.click(within(drawer).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(calls.filter((call) => call.route === 'update').map((call) => call.body)).toEqual([
        { signature_md: 'Thanks' },
      ]);
    });
  });

  it('is not found for members who are not organization admins', async () => {
    serve([HR], 'member');
    await renderApp(PATH);
    expect(await screen.findByRole('heading', { name: /not found/iu })).toBeInTheDocument();
  });

  it('shows a load error', async () => {
    const { fetchMock } = serve([]);
    fetchMock.mockImplementation((input: string) => {
      const path = new URL(input, 'http://localhost').pathname.replace('/api/v1', '');
      if (path === '/me') return Promise.resolve(json(ME));
      if (path === `/orgs/${ORG.id}/email-identities`) {
        return Promise.resolve(problem('INTERNAL_ERROR', 500));
      }
      return Promise.resolve(problem('NOT_FOUND', 404));
    });
    await renderApp(PATH);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});
