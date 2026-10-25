import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nextProvider } from 'react-i18next';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { axeViolations } from '../../../../test/axe';
import { createTestI18n } from '../../../../test/i18n';
import { ApiError } from '../../../lib/api/client';
import { EMPTY_FORM } from '../model/questions';
import { FormRenderer } from '../renderer/FormRenderer';

import type { FormClock, FormRendererField, FormRendererProps } from '../../../lib/forms/renderer';
import type { FormSubmitRequest, StoredFormSettings } from '@cellhive/contracts';
import type { i18n as I18n } from 'i18next';

const TITLE = 'fld_Title00000000001';
const PRIORITY = 'fld_Priority00000001';
const AMOUNT = 'fld_Amount0000000001';
const CODE = 'fld_Code000000000001';

const FIELDS: FormRendererField[] = [
  {
    id: TITLE,
    name: 'Title',
    type: 'text',
    options: {},
    description: null,
    is_primary: true,
    required: true,
  },
  {
    id: PRIORITY,
    name: 'Priority',
    type: 'select',
    options: {
      options: [
        { id: 'opt_High000000000001', name: 'High' },
        { id: 'opt_Low0000000000001', name: 'Low' },
      ],
    },
    description: null,
  },
  { id: AMOUNT, name: 'Amount', type: 'number', options: {}, description: null },
  { id: CODE, name: 'Code', type: 'text', options: {}, description: null },
];

const FORM: StoredFormSettings = {
  ...EMPTY_FORM,
  title: 'Support request',
  description: 'Tell us **what** happened.',
  fields: [
    { field: TITLE, required: false, label: 'What broke?', help: 'One line' },
    { field: PRIORITY, required: true, label: null, help: null },
    { field: AMOUNT, required: false, label: null, help: null },
    { field: CODE, required: false, label: null, help: null },
  ],
  success_message: 'Thanks!',
};

const CTX = { locale: 'en', timeZone: 'UTC' };

let i18n: I18n;
beforeAll(async () => {
  i18n = await createTestI18n('en');
});

function renderForm(props: Partial<FormRendererProps> = {}) {
  return render(
    <I18nextProvider i18n={i18n}>
      <FormRenderer form={FORM} fields={FIELDS} locale={CTX} {...props} />
    </I18nextProvider>,
  );
}

const ok = { success_message: 'Thanks!', redirect_url: null };

describe('FormRenderer (T315)', () => {
  it('renders title, Markdown description, labels, help and required marks; no axe violations', async () => {
    const { container } = renderForm({ submit: vi.fn() });
    expect(screen.getByRole('heading', { level: 2, name: 'Support request' })).toBeVisible();
    expect(screen.getByText('what').tagName).toBe('STRONG');
    const title = screen.getByRole('textbox', { name: /What broke\?/u });
    expect(title).toHaveAttribute('aria-required', 'true');
    expect(title).toHaveAccessibleDescription('One line');
    expect(screen.getByRole('radiogroup', { name: /Priority/u })).toBeVisible();
    expect(await axeViolations(container)).toEqual([]);
  });

  it('blocks a submission with a required question empty, then sends the values', async () => {
    const user = userEvent.setup();
    const submit = vi.fn().mockResolvedValue(ok);
    renderForm({ submit });
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(submit).not.toHaveBeenCalled();
    const title = screen.getByRole('textbox', { name: /What broke\?/u });
    expect(title).toHaveAttribute('aria-invalid', 'true');
    expect(title).toHaveAccessibleDescription(/This field is required\./u);
    await waitFor(() => {
      expect(title).toHaveFocus();
    });

    await user.type(title, 'Printer jam');
    await user.click(screen.getByRole('radio', { name: 'High' }));
    await user.type(screen.getByRole('textbox', { name: 'Amount' }), '1,500');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(submit).toHaveBeenCalledWith({
      fields: { [TITLE]: 'Printer jam', [PRIORITY]: 'High', [AMOUNT]: 1500 },
    });
    expect(await screen.findByRole('heading', { name: 'Response sent' })).toBeVisible();
    expect(screen.getByText('Thanks!')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Submit another response' }));
    expect(screen.getByRole('textbox', { name: /What broke\?/u })).toHaveValue('');
  });

  it('shows server problems under their question (errors[].path fields.<id>)', async () => {
    const user = userEvent.setup();
    const submit = vi.fn().mockRejectedValue(
      new ApiError({
        status: 422,
        code: 'VALIDATION_FAILED',
        errors: [
          { path: `fields.${AMOUNT}`, code: 'EXPECTED_NUMBER', message: 'Expected a number' },
        ],
      }),
    );
    renderForm({ submit, search: `?prefill_${TITLE}=Jam&prefill_${PRIORITY}=low` });
    expect(screen.getByRole('textbox', { name: /What broke\?/u })).toHaveValue('Jam');
    expect(screen.getByRole('radio', { name: 'Low' })).toBeChecked();
    await user.type(screen.getByRole('textbox', { name: 'Amount' }), '12');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    const amount = screen.getByRole('textbox', { name: 'Amount' });
    await waitFor(() => {
      expect(amount).toHaveAttribute('aria-invalid', 'true');
    });
    expect(amount).toHaveAccessibleDescription('Expected a number.');
    // Typing clears the problem of that question.
    await user.type(amount, '3');
    expect(amount).toHaveAttribute('aria-invalid', 'false');
  });

  it('hides prefilled hidden questions and sends their raw value', async () => {
    const user = userEvent.setup();
    const submit = vi.fn().mockResolvedValue(ok);
    renderForm({ submit, search: `?prefill_${CODE}=ABC-1&hide_${CODE}=1&hide_${AMOUNT}=1` });
    expect(screen.queryByRole('textbox', { name: 'Code' })).toBeNull();
    // Hidden without a value: still asked (it could not be answered otherwise).
    expect(screen.getByRole('textbox', { name: 'Amount' })).toBeVisible();
    await user.type(screen.getByRole('textbox', { name: /What broke\?/u }), 'Jam');
    await user.click(screen.getByRole('radio', { name: 'High' }));
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(submit).toHaveBeenCalledWith({
      fields: { [TITLE]: 'Jam', [PRIORITY]: 'High', [CODE]: 'ABC-1' },
    });
  });

  it('shows the submission limit with the next allowed time', async () => {
    const user = userEvent.setup();
    const submit = vi.fn().mockRejectedValue(
      new ApiError({
        status: 409,
        code: 'SUBMISSION_LIMIT_REACHED',
        errors: [
          {
            path: '',
            code: 'SUBMISSION_LIMIT_REACHED',
            message: '',
            params: { limit: 'daily', next_allowed_at: '2026-09-26T00:00:00.000Z' },
          },
        ],
      }),
    );
    const clock: FormClock = {
      now: () => Date.parse('2026-09-25T12:00:00.000Z'),
      sleep: () => Promise.resolve(),
    };
    renderForm({ submit, clock, search: `?prefill_${TITLE}=Jam&prefill_${PRIORITY}=High` });
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    const limit = await screen.findByTestId('form-limit');
    expect(limit).toHaveTextContent('You have already filled in this form');
    expect(limit).toHaveTextContent(/You can submit it again in 12 hours \(Sep 26, 2026/u);
  });

  it('redirects to an http(s) redirect URL after the submission', async () => {
    const user = userEvent.setup();
    const onRedirect = vi.fn();
    const submit = vi
      .fn()
      .mockResolvedValue({ success_message: '', redirect_url: 'https://example.com/thanks' });
    renderForm({ submit, onRedirect, search: `?prefill_${TITLE}=Jam&prefill_${PRIORITY}=High` });
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    await screen.findByRole('heading', { name: 'Response sent' });
    expect(onRedirect).toHaveBeenCalledWith('https://example.com/thanks');
  });

  it('shows why a person cannot submit instead of the button', () => {
    renderForm({ submit: vi.fn(), blocked: 'No right to add records.' });
    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull();
    expect(screen.getByText('No right to add records.')).toBeVisible();
  });

  it('preview checks the answers but sends nothing', async () => {
    const user = userEvent.setup();
    renderForm({ search: `?prefill_${TITLE}=Jam&prefill_${PRIORITY}=High` });
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    expect(screen.getByText(/This is a preview: nothing was sent\./u)).toBeVisible();
  });
});

describe('FormRenderer anti-spam (link forms, T317)', () => {
  const later: FormClock = {
    now: () => Date.parse('2026-09-25T00:00:10.000Z'),
    sleep: () => Promise.resolve(),
  };
  const token = (value: string, notBefore: string) => ({
    submit_token: value,
    not_before: notBefore,
    expires_at: '2026-09-26T00:00:00.000Z',
  });

  it('fetches a token on open, waits for the fill time, sends token and honeypot', async () => {
    const user = userEvent.setup();
    const fetchToken = vi.fn().mockResolvedValue(token('v1.a', '2026-09-25T00:00:03.000Z'));
    const sleep = vi.fn(() => Promise.resolve());
    const clock: FormClock = { now: () => Date.parse('2026-09-25T00:00:01.000Z'), sleep };
    const submit = vi.fn().mockResolvedValue(ok);
    const { container } = renderForm({
      submit,
      clock,
      antiSpam: { fetchToken },
      search: `?prefill_${TITLE}=Jam&prefill_${PRIORITY}=High`,
    });
    expect(fetchToken).toHaveBeenCalledTimes(1);
    // The honeypot is out of reach: hidden from assistive technology and the tab order.
    const honeypot = container.querySelector<HTMLInputElement>('input[name="website"]');
    expect(honeypot).not.toBeNull();
    expect(honeypot).toHaveAttribute('tabindex', '-1');
    expect(honeypot?.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(await axeViolations(container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Submit' }));
    await screen.findByRole('heading', { name: 'Response sent' });
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(submit).toHaveBeenCalledWith({
      fields: { [TITLE]: 'Jam', [PRIORITY]: 'High' },
      submit_token: 'v1.a',
      honeypot: '',
    } satisfies FormSubmitRequest);

    // A new response needs a new token (single use).
    await user.click(screen.getByRole('button', { name: 'Submit another response' }));
    expect(fetchToken).toHaveBeenCalledTimes(2);
  });

  it('sends what a bot typed into the honeypot', async () => {
    const fetchToken = vi.fn().mockResolvedValue(token('v1.a', '2026-09-25T00:00:00.000Z'));
    const submit = vi.fn().mockResolvedValue(ok);
    const user = userEvent.setup();
    const { container } = renderForm({
      submit,
      clock: later,
      antiSpam: { fetchToken },
      search: `?prefill_${TITLE}=Jam&prefill_${PRIORITY}=High`,
    });
    const honeypot = container.querySelector<HTMLInputElement>('input[name="website"]');
    if (honeypot === null) throw new TypeError('no honeypot');
    await user.type(honeypot, 'spam.test');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => {
      expect(submit).toHaveBeenCalledWith(expect.objectContaining({ honeypot: 'spam.test' }));
    });
  });

  it('gets a new token once when the server refuses it', async () => {
    const user = userEvent.setup();
    const fetchToken = vi
      .fn()
      .mockResolvedValueOnce(token('v1.old', '2026-09-25T00:00:00.000Z'))
      .mockResolvedValueOnce(token('v1.new', '2026-09-25T00:00:00.000Z'));
    const refused = (code: string, params?: Record<string, unknown>) =>
      new ApiError({
        status: 422,
        code: 'VALIDATION_FAILED',
        errors: [{ path: 'submit_token', code, message: '', ...(params ? { params } : {}) }],
      });
    const submit = vi
      .fn()
      .mockRejectedValueOnce(refused('SUBMIT_TOKEN_INVALID'))
      .mockResolvedValueOnce(ok);
    renderForm({
      submit,
      clock: later,
      antiSpam: { fetchToken },
      search: `?prefill_${TITLE}=Jam&prefill_${PRIORITY}=High`,
    });
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    await screen.findByRole('heading', { name: 'Response sent' });
    expect(submit.mock.calls.map(([body]) => (body as FormSubmitRequest).submit_token)).toEqual([
      'v1.old',
      'v1.new',
    ]);
  });

  it('retries after SUBMITTED_TOO_FAST with the same token', async () => {
    const user = userEvent.setup();
    const fetchToken = vi.fn().mockResolvedValue(token('v1.a', '2026-09-25T00:00:00.000Z'));
    const sleep = vi.fn(() => Promise.resolve());
    const submit = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError({
          status: 422,
          code: 'VALIDATION_FAILED',
          errors: [
            {
              path: 'submit_token',
              code: 'SUBMITTED_TOO_FAST',
              message: '',
              params: { retry_after_ms: 800 },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(ok);
    renderForm({
      submit,
      antiSpam: { fetchToken },
      clock: { now: () => Date.parse('2026-09-25T00:00:10.000Z'), sleep },
      search: `?prefill_${TITLE}=Jam&prefill_${PRIORITY}=High`,
    });
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    await screen.findByRole('heading', { name: 'Response sent' });
    expect(sleep).toHaveBeenCalledWith(800);
    expect(fetchToken).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(2);
  });
});
