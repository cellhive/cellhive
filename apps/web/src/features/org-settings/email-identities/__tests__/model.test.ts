import { describe, expect, it } from 'vitest';

import {
  checkForm,
  createRequest,
  displayNameChanged,
  displayNameIssue,
  initialForm,
  needsReverification,
  updateRequest,
  type IdentityFormState,
} from '../model/form';
import { domainOf, modeOf, previewSender, readableAddress, viaSuffix } from '../model/sender';
import {
  applyFormat,
  insertImage,
  signatureBlocks,
  signatureImageCount,
  signatureIssue,
} from '../model/signature';
import { failureKey, normalizeCode, smtpCodeText, verificationSteps } from '../model/verification';

import type { EmailIdentityDto, EmailSettingsDto } from '@cellhive/contracts';

const ASSET = 'att_0123456789abcDEF';

const SMTP: EmailSettingsDto['smtp'] = {
  configured: true,
  host: '***.corp.vn',
  port: 587,
  security: 'starttls',
  from: 'no-reply@corp.vn',
  from_name: 'Cellhive',
  allowed_from_domains: ['corp.vn', 'xn--bcher-kva.example'],
};
const NO_SMTP: EmailSettingsDto['smtp'] = {
  configured: false,
  host: null,
  port: null,
  security: null,
  from: null,
  from_name: null,
  allowed_from_domains: [],
};

function identity(overrides: Partial<EmailIdentityDto> = {}): EmailIdentityDto {
  return {
    id: 'eid_0123456789ABCDEF',
    organization_id: 'org_0123456789ABCDEF',
    email: 'hr@corp.vn',
    display_name: 'HR',
    display_name_issue: null,
    reply_to: null,
    transport: 'system',
    mode: 'send_as',
    status: 'verified',
    error_reason: null,
    verified_at: '2026-10-02T03:00:00.000Z',
    verified_via: 'code',
    base_scope: 'all',
    base_ids: [],
    signature_md: null,
    smtp: null,
    display: { from: '"HR" <hr@corp.vn>', reply_to: null },
    hints: ['spf_dkim_alignment'],
    verification: { pending: false, sent_at: null, expires_at: null, code_attempts_left: null },
    created_by: 'usr_0123456789ABCDEF',
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

const SMTP_IDENTITY = identity({
  transport: 'smtp',
  smtp: {
    host: 'mail.corp.vn',
    port: 587,
    security: 'starttls',
    username: 'it@corp.vn',
    password_set: true,
  },
});

describe('sender preview (ADR-33 §1)', () => {
  it.each([
    ['hr@corp.vn', 'corp.vn'],
    [' HR@Corp.VN ', 'corp.vn'],
    ['a@bücher.example', 'xn--bcher-kva.example'],
    ['no-at-sign', null],
    ['@corp.vn', null],
    ['a@', null],
    ['a@b c.vn', null],
  ])('domainOf(%j) = %j', (email, expected) => {
    expect(domainOf(email)).toBe(expected);
  });

  it.each([
    ['system', 'hr@corp.vn', SMTP, 'send_as'],
    ['system', 'HR@CORP.VN', SMTP, 'send_as'],
    ['system', 'x@bücher.example', SMTP, 'send_as'],
    ['system', 'support@partner.vn', SMTP, 'on_behalf'],
    ['system', 'hr@corp.vn', NO_SMTP, 'on_behalf'],
    ['system', 'hr@corp.vn', undefined, 'on_behalf'],
    ['smtp', 'support@partner.vn', NO_SMTP, 'send_as'],
  ] as const)('modeOf(%s, %s) = %s', (transport, email, smtp, mode) => {
    expect(modeOf(transport, email, smtp)).toBe(mode);
  });

  it('SMTP_FROM itself is sent directly whatever its domain', () => {
    expect(modeOf('system', 'no-reply@corp.vn', { ...SMTP, allowed_from_domains: [] })).toBe(
      'send_as',
    );
  });

  it('send_as shows the identity; on_behalf the system address in the organization language', () => {
    const draft = {
      email: 'hr@corp.vn',
      displayName: 'HR',
      replyTo: '',
      transport: 'system' as const,
    };
    expect(previewSender(draft, SMTP, 'en')).toEqual({
      mode: 'send_as',
      from: 'HR <hr@corp.vn>',
      replyTo: null,
    });
    expect(
      previewSender({ ...draft, email: 'Support@Partner.vn', displayName: 'IT' }, SMTP, 'vi-VN'),
    ).toEqual({
      mode: 'on_behalf',
      from: 'IT (qua Cellhive) <no-reply@corp.vn>',
      replyTo: 'support@partner.vn',
    });
    expect(
      previewSender({ ...draft, email: 'x@partner.vn', replyTo: 'Desk@Partner.vn' }, SMTP, 'en'),
    ).toMatchObject({ from: 'HR (via Cellhive) <no-reply@corp.vn>', replyTo: 'desk@partner.vn' });
    expect(previewSender({ ...draft, email: 'x@partner.vn' }, NO_SMTP, 'en')?.from).toBeNull();
    expect(previewSender({ ...draft, email: 'not-yet' }, SMTP, 'en')).toBeNull();
  });

  it.each([
    ['en', '(via Cellhive)'],
    ['vi', '(qua Cellhive)'],
    ['vi_VN', '(qua Cellhive)'],
    [null, '(via Cellhive)'],
  ])('viaSuffix(%j)', (locale, suffix) => {
    expect(viaSuffix(locale)).toBe(suffix);
  });

  it.each([
    ['"HR" <hr@corp.vn>', 'HR <hr@corp.vn>'],
    [
      '"IT \\"Desk\\" (via Cellhive)" <no-reply@corp.vn>',
      'IT "Desk" (via Cellhive) <no-reply@corp.vn>',
    ],
    ['<hr@corp.vn>', '<hr@corp.vn>'],
  ])('readableAddress(%j)', (header, expected) => {
    expect(readableAddress(header)).toBe(expected);
  });
});

describe('signature (ADR-33 §3)', () => {
  it.each([
    ['**HR** · 028 1234', null],
    ['Hello {{ name }}', { code: 'PLACEHOLDER_NOT_ALLOWED', position: 6 }],
    ['x'.repeat(2000), null],
    ['x'.repeat(2001), { code: 'TOO_BIG', maximum: 2000 }],
    // Code points, as the server counts: 2,000 emoji are allowed.
    ['😀'.repeat(2000), null],
    // T534: signature images are uploaded assets only, at most 2.
    [`![Logo](asset:${ASSET} =120) **HR**`, null],
    ['Logo ![Acme](https://x.test/a.png)', { code: 'IMAGE_SOURCE_NOT_ALLOWED', position: 5 }],
    ['![x](data:image/png;base64,AA)', { code: 'IMAGE_SOURCE_NOT_ALLOWED', position: 0 }],
    [`![x](field:fld_0123456789abcDEF)`, { code: 'IMAGE_SOURCE_NOT_ALLOWED', position: 0 }],
    [
      `![a](asset:${ASSET}) ![b](asset:${ASSET}) ![c](asset:${ASSET})`,
      { code: 'TOO_MANY_IMAGES', maximum: 2 },
    ],
  ])('signatureIssue(%#)', (source, issue) => {
    expect(signatureIssue(source)).toEqual(issue);
  });

  it('previews signature images as image nodes and counts them', () => {
    expect(signatureBlocks(`![Logo](asset:${ASSET} =120)`)).toEqual([
      {
        type: 'paragraph',
        children: [{ type: 'image', source: 'asset', id: ASSET, alt: 'Logo', width: 120 }],
      },
    ]);
    expect(signatureImageCount(`![a](asset:${ASSET}) x ![b](asset:${ASSET})`)).toBe(2);
    expect(signatureImageCount('![a](https://x.test/a.png)')).toBe(0);
  });

  it.each([
    ['', 0, 0, '![L](asset:x)', [13, 13]],
    ['Hi', 2, 2, '\n![L](asset:x)', [16, 16]],
    ['Hi\nthere', 2, 2, '\n![L](asset:x)', [16, 16]],
    ['Hi there', 3, 8, '\n![L](asset:x)', [17, 17]],
    ['ab', 1, 1, '\n![L](asset:x)\n', [15, 15]],
  ] as const)('insertImage on %j at %i', (value, start, end, inserted, selection) => {
    const edit = insertImage(value, start, end, '![L](asset:x)');
    expect(edit.value).toBe(`${value.slice(0, start)}${inserted}${value.slice(end)}`);
    expect([edit.selectionStart, edit.selectionEnd]).toEqual(selection);
  });

  it('previews image syntax as its alternative text only', () => {
    expect(signatureBlocks('Logo ![Acme](https://x.test/a.png) **HR**')).toEqual([
      {
        type: 'paragraph',
        children: [
          { type: 'text', text: 'Logo ' },
          { type: 'text', text: 'Acme' },
          { type: 'text', text: ' ' },
          { type: 'strong', children: [{ type: 'text', text: 'HR' }] },
        ],
      },
    ]);
    expect(signatureBlocks('  \n ')).toEqual([]);
  });

  it.each([
    ['bold', 'Hi HR', 3, 5, 'Hi **HR**', [5, 7]],
    ['italic', 'Hi ', 3, 3, 'Hi _text_', [4, 8]],
    ['link', 'site', 0, 4, '[site](https://)', [7, 15]],
    ['list', 'a\nb', 0, 3, '- a\n- b', [0, 7]],
    ['list', 'x\nb', 2, 2, 'x\n- b', [2, 5]],
    ['list', 'x\n', 2, 2, 'x\n- text', [2, 8]],
  ] as const)('applyFormat(%s) on %j', (format, value, start, end, expected, selection) => {
    const edit = applyFormat(value, start, end, format, 'text');
    expect(edit.value).toBe(expected);
    expect([edit.selectionStart, edit.selectionEnd]).toEqual(selection);
  });
});

describe('verification outcome (CONTRACTS §23.3)', () => {
  const smtp = { code: 535, enhanced: '5.7.8' };
  it.each([
    [
      {
        status: 'sent',
        to: 'a@b.vn',
        expires_at: '2026-10-06T00:00:00.000Z',
        smtp: { code: 250, enhanced: null },
      },
      'starttls',
      ['done', 'done', 'done', 'done'],
    ],
    [
      {
        status: 'sent',
        to: 'a@b.vn',
        expires_at: '2026-10-06T00:00:00.000Z',
        smtp: { code: 250, enhanced: null },
      },
      'none',
      ['done', 'skipped', 'done', 'done'],
    ],
    [
      { status: 'failed', step: 'auth', code: 'smtp_rejected', reason: 'auth_failed', smtp },
      'starttls',
      ['done', 'done', 'failed', 'not_run'],
    ],
    [
      {
        status: 'failed',
        step: 'connect',
        code: 'smtp_rejected',
        reason: 'host_not_allowed',
        smtp: { code: null, enhanced: null },
      },
      'none',
      ['failed', 'not_run', 'not_run', 'not_run'],
    ],
    [
      {
        status: 'failed',
        step: 'tls',
        code: 'smtp_temporary',
        reason: 'tls_failed',
        smtp: { code: null, enhanced: null },
      },
      'tls',
      ['done', 'failed', 'not_run', 'not_run'],
    ],
  ] as const)('steps of %#', (outcome, security, states) => {
    expect(verificationSteps(outcome, security)?.map((step) => step.state)).toEqual(states);
  });

  it('a rate-limited answer ran no step', () => {
    expect(
      verificationSteps({ status: 'rate_limited', retry_after_seconds: 60 }, 'tls'),
    ).toBeNull();
  });

  it.each([
    [{ code: 'smtp_rejected', reason: 'auth_failed', smtp }, 'auth_failed'],
    [
      { code: 'smtp_rejected', reason: 'rejected', smtp: { code: 550, enhanced: '5.7.60' } },
      'send_as_denied',
    ],
    [
      { code: 'smtp_not_configured', reason: null, smtp: { code: null, enhanced: null } },
      'smtp_not_configured',
    ],
    [
      { code: 'smtp_temporary', reason: 'timeout', smtp: { code: null, enhanced: null } },
      'timeout',
    ],
    [{ code: 'smtp_rejected', reason: 'unknown', smtp: { code: 554, enhanced: null } }, 'rejected'],
    [{ code: 'smtp_temporary', reason: null, smtp: { code: null, enhanced: null } }, 'unknown'],
  ] as const)('failureKey %#', (failure, key) => {
    expect(failureKey({ status: 'failed', step: 'send', ...failure })).toBe(key);
  });

  it.each([
    [{ code: 535, enhanced: '5.7.8' }, '535 5.7.8'],
    [{ code: 421, enhanced: null }, '421'],
    [{ code: null, enhanced: null }, null],
  ])('smtpCodeText(%j)', (reply, text) => {
    expect(smtpCodeText(reply)).toBe(text);
  });

  it.each([
    ['482 917', '482917'],
    ['48-29-17', '482917'],
    ['4829171234', '482917'],
    ['ab', ''],
  ])('normalizeCode(%j)', (input, code) => {
    expect(normalizeCode(input)).toBe(code);
  });
});

describe('identity form (T533)', () => {
  const filled = (patch: Partial<IdentityFormState> = {}): IdentityFormState => ({
    ...initialForm(null),
    email: 'hr@corp.vn',
    displayName: 'HR',
    ...patch,
  });

  it('checks what the server would refuse', () => {
    expect(checkForm(null, initialForm(null))).toEqual({
      email: 'required',
      displayName: 'required',
    });
    expect(checkForm(null, filled({ email: 'hr', replyTo: 'x' }))).toEqual({
      email: 'invalidEmail',
      replyTo: 'invalidEmail',
    });
    expect(checkForm(null, filled({ transport: 'smtp' }))).toEqual({
      host: 'required',
      username: 'required',
      password: 'required',
    });
    expect(
      checkForm(
        null,
        filled({ transport: 'smtp', host: 'h', username: 'u', password: 'p', security: 'none' }),
      ),
    ).toEqual({ allowInsecure: 'confirmInsecure' });
    expect(checkForm(null, filled({ baseScope: 'selected' }))).toEqual({ baseIds: 'pickBase' });
    // A stored password is kept: none is required on edit.
    expect(checkForm(SMTP_IDENTITY, initialForm(SMTP_IDENTITY))).toEqual({});
  });

  it('creates with the SMTP password only for an own server', () => {
    expect(createRequest(filled({ signature: '  ' }))).toEqual({
      email: 'hr@corp.vn',
      display_name: 'HR',
      reply_to: null,
      transport: 'system',
      base_scope: 'all',
      base_ids: [],
      signature_md: null,
    });
    expect(
      createRequest(
        filled({
          transport: 'smtp',
          host: ' mail.corp.vn ',
          username: 'it',
          password: 'secret',
          security: 'none',
          port: 25,
          allowInsecure: true,
          baseScope: 'selected',
          baseIds: ['bse_0123456789ABCDEF'],
        }),
      ),
    ).toMatchObject({
      smtp: {
        host: 'mail.corp.vn',
        port: 25,
        security: 'none',
        username: 'it',
        password: 'secret',
        allow_insecure: true,
      },
      base_scope: 'selected',
      base_ids: ['bse_0123456789ABCDEF'],
    });
  });

  it('updates only what changed and never resends a stored password', () => {
    const form = initialForm(SMTP_IDENTITY);
    expect(updateRequest(SMTP_IDENTITY, form)).toEqual({});
    expect(updateRequest(SMTP_IDENTITY, { ...form, displayName: 'IT', port: 2525 })).toEqual({
      display_name: 'IT',
      smtp: { host: 'mail.corp.vn', port: 2525, security: 'starttls', username: 'it@corp.vn' },
    });
    expect(
      updateRequest(SMTP_IDENTITY, { ...form, changePassword: true, password: 'new' }).smtp,
    ).toMatchObject({ password: 'new' });
    // "Change password" opened but nothing typed: the stored one stays.
    expect(updateRequest(SMTP_IDENTITY, { ...form, changePassword: true })).toEqual({});
  });

  it.each([
    [{}, false],
    [{ displayName: 'IT', signature: '**IT**', port: 465 as const }, false],
    [{ email: 'it@corp.vn' }, true],
    [{ transport: 'system' as const }, true],
    [{ host: 'smtp.corp.vn' }, true],
    [{ username: 'other' }, true],
    [{ changePassword: true, password: 'new' }, true],
    [{ changePassword: true }, false],
  ])('needsReverification %#', (patch, expected) => {
    expect(needsReverification(SMTP_IDENTITY, { ...initialForm(SMTP_IDENTITY), ...patch })).toBe(
      expected,
    );
  });
});

describe('display names refused since T540 (T556, QA S5 M7)', () => {
  const flagged = identity({ display_name: 'PayPal <a@b>', display_name_issue: 'angle_bracket' });
  const named = (displayName: string): IdentityFormState => ({
    ...initialForm(null),
    email: 'hr@corp.vn',
    displayName,
  });

  it.each([
    ['Phòng Nhân sự', null],
    ['Dept. IT', null],
    ['Phòng Kế toán.', null],
    ['   ', null],
    ['PayPal <a@b>', 'angle_bracket'],
    ['HR @ corp', 'at_sign'],
    ['Nhận quà tại evil.test', 'url'],
    ['www.example', 'url'],
    ['HR‮RLO', 'control_char'],
  ] as const)('displayNameIssue(%j) = %s', (name, issue) => {
    expect(displayNameIssue({ displayName: name })).toBe(issue);
  });

  it('blocks a new or changed name the server would refuse, not a kept one', () => {
    expect(checkForm(null, named('PayPal <a@b>'))).toEqual({ displayName: 'notAllowed' });
    expect(checkForm(null, named('Phòng Nhân sự'))).toEqual({});
    // The stored name saved before the rule may stay while other settings change.
    const kept = initialForm(flagged);
    expect(displayNameChanged(flagged, kept)).toBe(false);
    expect(checkForm(flagged, { ...kept, signature: 'Thanks' })).toEqual({});
    expect(updateRequest(flagged, { ...kept, signature: 'Thanks' })).toEqual({
      signature_md: 'Thanks',
    });
    // Changing it to another refused name is blocked; to a valid one is sent.
    expect(checkForm(flagged, { ...kept, displayName: 'PayPal www.paypal.com' })).toEqual({
      displayName: 'notAllowed',
    });
    expect(displayNameChanged(flagged, { ...kept, displayName: 'PayPal Support' })).toBe(true);
    expect(checkForm(flagged, { ...kept, displayName: 'PayPal Support' })).toEqual({});
    expect(updateRequest(flagged, { ...kept, displayName: ' PayPal Support ' })).toEqual({
      display_name: 'PayPal Support',
    });
    // Too long wins over the reason.
    expect(checkForm(null, named(`<${'a'.repeat(120)}`))).toEqual({ displayName: 'tooLong' });
  });
});
