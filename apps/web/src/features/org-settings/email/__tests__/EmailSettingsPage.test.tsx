import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { json, ME, ORG, problem, renderApp, stubApi } from '../../../../../test/app-harness';
import { axeViolations } from '../../../../../test/axe';
import { clearToasts } from '../../../../lib/toast/toast';

import type { EmailSettingsDto, EmailTestResult } from '@cellhive/contracts';

const PAGE = `/o/${ORG.slug}/settings/email`;
const PATH = `/orgs/${ORG.id}/email-settings`;
const MIB = 1024 * 1024;

function settings(overrides: {
  configured?: boolean;
  instance?: 'required' | 'org';
  automation?: Partial<EmailSettingsDto['automation']>;
}): EmailSettingsDto {
  const configured = overrides.configured ?? true;
  return {
    smtp: configured
      ? {
          configured: true,
          host: '***.example.com',
          port: 587,
          security: 'starttls',
          from: 'no-reply@example.com',
          from_name: 'Acme',
          allowed_from_domains: ['example.com'],
        }
      : {
          configured: false,
          host: null,
          port: null,
          security: null,
          from: null,
          from_name: null,
          allowed_from_domains: [],
        },
    limits: {
      max_per_hour_per_org: 500,
      max_recipients: 50,
      max_per_second_per_process: 5,
      test_sends_per_minute: 5,
      max_html_bytes: 102400,
      max_attachments: 10,
      max_attachment_bytes: 15 * MIB,
      max_inline_images: 5,
    },
    usage: { sent_this_hour: 132, resets_at: '2026-10-05T04:00:00.000Z' },
    automation: {
      instance_footer_policy: overrides.instance ?? 'required',
      footer_policy: 'required',
      footer_none_allowed: false,
      default_signature_md: null,
      system_sender_enabled: true,
      max_attachments: 10,
      max_attachment_bytes: 15 * MIB,
      attachment_limits_custom: false,
      system_sender_usage: { automations: 3, enabled_automations: 2 },
      ...overrides.automation,
    },
  };
}

interface Call {
  method: string;
  body: unknown;
}

function serve(initial: EmailSettingsDto, test?: EmailTestResult | Response) {
  let current = initial;
  const calls: Call[] = [];
  stubApi({
    signedIn: true,
    routes: {
      [`GET ${PATH}`]: () => json(current),
      [`PATCH ${PATH}`]: (init) => {
        const body = JSON.parse(init?.body as string) as Record<string, unknown>;
        calls.push({ method: 'PATCH', body });
        if (
          typeof body['default_signature_md'] === 'string' &&
          body['default_signature_md'].includes('forbidden')
        ) {
          return json(
            {
              type: 'https://cellhive.io/errors/VALIDATION_FAILED',
              title: 'VALIDATION_FAILED',
              status: 422,
              code: 'VALIDATION_FAILED',
              errors: [{ path: 'default_signature_md', code: 'PLACEHOLDER_NOT_ALLOWED' }],
            },
            422,
          );
        }
        const merged = {
          ...current.automation,
          ...(body as Partial<
            Omit<EmailSettingsDto['automation'], 'max_attachments' | 'max_attachment_bytes'>
          > & { max_attachments?: number | null; max_attachment_bytes?: number | null }),
        };
        // `null` attachment limits = the instance caps (T532).
        const limitsSent = 'max_attachments' in body || 'max_attachment_bytes' in body;
        const custom = limitsSent
          ? body['max_attachments'] !== null && body['max_attachment_bytes'] !== null
          : merged.attachment_limits_custom;
        current = {
          ...current,
          automation: {
            ...merged,
            max_attachments: merged.max_attachments ?? current.limits.max_attachments,
            max_attachment_bytes:
              merged.max_attachment_bytes ?? current.limits.max_attachment_bytes,
            attachment_limits_custom: custom,
          },
        };
        return json(current);
      },
      [`POST ${PATH}/test`]: () => {
        calls.push({ method: 'POST', body: null });
        if (test instanceof Response) return test;
        return json(
          test ?? {
            status: 'sent',
            to: ME.user.email,
            message_id: '<ob.1@example.com>',
            smtp: { code: 250, enhanced: '2.0.0' },
          },
        );
      },
    },
  });
  return calls;
}

afterEach(() => {
  clearToasts();
});

describe('EmailSettingsPage (T526)', () => {
  it('shows the SMTP status, limits and tests the connection', async () => {
    const calls = serve(settings({}));
    await renderApp(PAGE);
    expect(await screen.findByTestId('smtp-status')).toHaveTextContent('Configured');
    expect(screen.getByTestId('smtp-host')).toHaveTextContent('***.example.com');
    expect(screen.getByTestId('smtp-port')).toHaveTextContent('587 · STARTTLS');
    expect(screen.getByTestId('smtp-from')).toHaveTextContent('Acme <no-reply@example.com>');
    expect(screen.getByTestId('smtp-domains')).toHaveTextContent('example.com');
    expect(screen.getByTestId('limit-hour')).toHaveTextContent('132 sent / 500');
    expect(screen.getByTestId('test-hint')).toHaveTextContent(
      `Sends a test email to ${ME.user.email}. 5 tests left this minute.`,
    );
    expect(await axeViolations(document.body)).toEqual([]);

    await userEvent.click(screen.getByTestId('test-connection'));
    const result = await screen.findByTestId('test-result');
    expect(result).toHaveTextContent('Connection works.');
    expect(result).toHaveTextContent(`A test email was sent to ${ME.user.email}`);
    expect(screen.getByTestId('test-reply')).toHaveTextContent('Server code: 250 2.0.0.');
    expect(screen.getByTestId('test-hint')).toHaveTextContent('4 tests left this minute.');
    expect(calls).toEqual([{ method: 'POST', body: null }]);
  });

  it('explains a classified failure', async () => {
    serve(settings({}), {
      status: 'failed',
      code: 'smtp_rejected',
      reason: 'auth_failed',
      smtp: { code: 535, enhanced: '5.7.8' },
    });
    await renderApp(PAGE);
    await userEvent.click(await screen.findByTestId('test-connection'));
    const result = await screen.findByTestId('test-result');
    expect(result).toHaveTextContent('The server refused to sign in.');
    expect(result).toHaveTextContent('Check the user name and password in SMTP_URL.');
    expect(result).toHaveTextContent('535 5.7.8');
  });

  it('shows a rate limited test as an error', async () => {
    serve(settings({}), problem('RATE_LIMITED', 429));
    await renderApp(PAGE);
    await userEvent.click(await screen.findByTestId('test-connection'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many requests.');
  });

  it('explains how to configure SMTP when there is none', async () => {
    serve(settings({ configured: false }));
    await renderApp(PAGE);
    expect(await screen.findByTestId('smtp-status')).toHaveTextContent('Not configured');
    const missing = screen.getByTestId('smtp-missing');
    expect(missing).toHaveTextContent('No email server yet.');
    expect(missing).toHaveTextContent('SMTP_URL=');
    expect(missing).toHaveTextContent('EMAIL_AUTOMATION_FOOTER=required');
    expect(screen.queryByTestId('test-connection')).toBeNull();
    expect(screen.getByText('Allow automations to send with the system sender')).toBeVisible();
    expect(await axeViolations(document.body)).toEqual([]);
  });

  it('locks the footer policy while the instance requires a footer', async () => {
    serve(settings({}));
    await renderApp(PAGE);
    expect(await screen.findByTestId('footer-required')).toBeDisabled();
    expect(screen.getByTestId('footer-author_choice')).toBeDisabled();
    expect(screen.getByTestId('footer-locked')).toHaveTextContent('Locked by the instance');
  });

  it('saves the footer policy and the signature with "Save changes"', async () => {
    const calls = serve(settings({ instance: 'org' }));
    await renderApp(PAGE);
    expect(await screen.findByTestId('footer-org')).toBeVisible();
    const save = screen.getByTestId('email-settings-save');
    expect(save).toBeDisabled();

    await userEvent.click(screen.getByTestId('footer-author_choice'));
    const section = screen.getByTestId('signature');
    const input = within(section).getByRole('textbox', { name: 'Signature' });
    await userEvent.type(input, 'Phong HC');
    await userEvent.keyboard('{Control>}a{/Control}');
    await userEvent.click(within(section).getByRole('button', { name: 'Bold' }));
    expect(input).toHaveValue('**Phong HC**');
    expect(within(screen.getByTestId('signature-preview')).getByText('Phong HC').tagName).toBe(
      'STRONG',
    );
    expect(section).toHaveTextContent('12 / 2,000');

    await userEvent.click(save);
    await waitFor(() => {
      expect(calls).toEqual([
        {
          method: 'PATCH',
          body: { footer_policy: 'author_choice', default_signature_md: '**Phong HC**' },
        },
      ]);
    });
    expect(await screen.findByText('Email settings saved.')).toBeVisible();
    await waitFor(() => {
      expect(screen.getByTestId('email-settings-save')).toBeDisabled();
    });
  });

  it('refuses placeholders and long signatures before saving', async () => {
    serve(settings({}));
    await renderApp(PAGE);
    const section = await screen.findByTestId('signature');
    const input = within(section).getByRole('textbox', { name: 'Signature' });
    await userEvent.type(input, 'Hi {{{{');
    expect(
      within(section).getByText('A signature is fixed text: remove the double curly braces', {
        exact: false,
      }),
    ).toBeVisible();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('email-settings-save')).toBeDisabled();

    await userEvent.clear(input);
    await userEvent.click(input);
    await userEvent.paste('x'.repeat(2001));
    expect(within(section).getByText('At most 2,000 characters.')).toBeVisible();
    expect(screen.getByTestId('email-settings-save')).toBeDisabled();
  });

  it('shows the server refusal next to the signature', async () => {
    serve(settings({}));
    await renderApp(PAGE);
    const section = await screen.findByTestId('signature');
    await userEvent.type(within(section).getByRole('textbox', { name: 'Signature' }), 'forbidden');
    await userEvent.click(screen.getByTestId('email-settings-save'));
    expect(
      await within(section).findByText(
        'A signature is fixed text: it cannot contain placeholders.',
      ),
    ).toBeVisible();
  });

  it('shows the organization settings nav with the email pages', async () => {
    serve(settings({}));
    await renderApp(PAGE);
    const nav = await screen.findByRole('navigation', { name: 'Organization settings' });
    expect(within(nav).getByRole('link', { name: 'Email settings' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Sender identities' })).toHaveAttribute(
      'href',
      `/o/${ORG.slug}/settings/email/identities`,
    );
    // T830: the personal pages (notifications, API tokens) are in the account menu instead.
    expect(within(nav).queryByRole('link', { name: 'API tokens' })).toBeNull();
    expect(within(nav).getByRole('link', { name: 'Share links' })).toHaveAttribute(
      'href',
      `/o/${ORG.slug}/settings/share-links`,
    );
  });

  it('asks before turning off the system sender used by automations', async () => {
    const calls = serve(settings({}));
    await renderApp(PAGE);
    expect(await screen.findByTestId('system-sender-usage')).toHaveTextContent(
      '3 automations use it (2 turned on).',
    );
    const toggle = screen.getByRole('switch', {
      name: 'Allow automations to send as Acme <no-reply@example.com>',
    });
    expect(toggle).toBeChecked();
    await userEvent.click(toggle);
    const dialog = await screen.findByTestId('system-sender-dialog');
    expect(dialog).toHaveTextContent('3 automations send with the system sender (2 turned on).');
    expect(calls).toEqual([]);
    expect(await axeViolations(document.body)).toEqual([]);

    await userEvent.click(screen.getByTestId('system-sender-confirm'));
    await waitFor(() => {
      expect(calls).toEqual([{ method: 'PATCH', body: { system_sender_enabled: false } }]);
    });
    expect(await screen.findByTestId('system-sender-saved')).toHaveTextContent(
      'Saved: the system sender is turned off.',
    );
    expect(toggle).not.toBeChecked();

    await userEvent.click(toggle);
    await waitFor(() => {
      expect(calls).toHaveLength(2);
    });
    expect(calls[1]).toEqual({ method: 'PATCH', body: { system_sender_enabled: true } });
  });

  it('saves attachment limits within the server caps and resets them (T532)', async () => {
    const calls = serve(settings({}));
    await renderApp(PAGE);
    const section = await screen.findByTestId('attachment-limits');
    expect(section).toHaveTextContent('At most 10 (limit of this server).');
    expect(section).toHaveTextContent('at most 15 MB');
    const files = within(section).getByTestId('attachment-max-files');
    const size = within(section).getByTestId('attachment-max-size');
    expect(files).toHaveValue('10');
    expect(size).toHaveValue('15');
    const save = within(section).getByTestId('attachment-limits-save');
    expect(save).toBeDisabled();
    expect(within(section).queryByTestId('attachment-limits-reset')).toBeNull();

    await userEvent.clear(files);
    await userEvent.type(files, '11');
    expect(section).toHaveTextContent('Enter a whole number from 1 to 10.');
    expect(save).toBeDisabled();
    await userEvent.clear(files);
    await userEvent.type(files, '5');
    await userEvent.clear(size);
    await userEvent.type(size, '8');
    await userEvent.click(save);
    await waitFor(() => {
      expect(calls).toEqual([
        { method: 'PATCH', body: { max_attachments: 5, max_attachment_bytes: 8 * MIB } },
      ]);
    });
    expect(await screen.findByTestId('attachment-limits-saved')).toHaveTextContent(
      'Saved: attachment limits updated.',
    );
    expect(await axeViolations(document.body)).toEqual([]);

    await userEvent.click(within(section).getByTestId('attachment-limits-reset'));
    await waitFor(() => {
      expect(calls[1]).toEqual({
        method: 'PATCH',
        body: { max_attachments: null, max_attachment_bytes: null },
      });
    });
    await waitFor(() => {
      expect(within(section).getByTestId('attachment-max-files')).toHaveValue('10');
    });
  });

  it('is the 404 screen for a member who is not an admin', async () => {
    stubApi({
      signedIn: true,
      routes: {
        'GET /me': () =>
          json({ ...ME, orgs: [{ id: ORG.id, name: ORG.name, slug: ORG.slug, role: 'member' }] }),
      },
    });
    await renderApp(PAGE);
    expect(await screen.findByText('Page not found')).toBeVisible();
    expect(screen.queryByTestId('smtp')).toBeNull();
  });
});
