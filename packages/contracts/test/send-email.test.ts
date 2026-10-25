import { describe, expect, it } from 'vitest';

import { AUTOMATION_STEP_ERROR_CODES } from '../src/automation-runs.js';
import {
  AUTOMATION_ACTION_TYPES,
  automationActionSchema,
  automationBranchActionSchema,
  automationEmailPreviewRequestSchema,
  automationEmailTestRequestSchema,
  sendEmailConfigSchema,
} from '../src/automations.js';
import { updateEmailSettingsRequestSchema } from '../src/email.js';
import { AUDIT_ONLY_ACTIONS } from '../src/events.js';

const FLD = 'fld_A1b2C3d4E5f6G7h8';
const EID = 'eid_A1b2C3d4E5f6G7h8';

const minimal = {
  to: [{ field: FLD }],
  subject: { template: 'Đơn {{ [fld_A1b2C3d4E5f6G7h8] }}' },
  body: { format: 'markdown', template: 'Xin chào' },
};

describe('send_email config (CONTRACTS §21, BACKLOG T514)', () => {
  it('fills the defaults: system sender, no cc/bcc/Reply-To, signature on, minimal footer', () => {
    expect(sendEmailConfigSchema.parse(minimal)).toEqual({
      identity_id: null,
      to: [{ field: FLD }],
      cc: [],
      bcc: [],
      reply_to: null,
      subject: minimal.subject,
      body: { format: 'markdown', template: 'Xin chào', digest: null },
      include_signature: true,
      footer: 'minimal',
      attachments: [],
      on_missing_attachment: 'fail',
    });
  });

  it.each([
    ['Reply-To an identity', { reply_to: { identity_id: EID } }],
    ['Reply-To a user field', { reply_to: { field: FLD } }],
    ['Reply-To the person who clicked', { reply_to: { trigger: 'clicked_by' } }],
    ['Reply-To run_as', { reply_to: { run_as: true } }],
    ['a list literal', { to: [{ literal: ['a@b.vn', 'c@d.vn'] }] }],
    [
      'a step and clicked_by',
      { cc: [{ step: 'act_1', path: 'records[0].fields.x' }, { trigger: 'clicked_by' }] },
    ],
    ['an identity, footer none', { identity_id: EID, footer: 'none', include_signature: false }],
    [
      'a body digest',
      {
        body: {
          format: 'markdown',
          template: '{{ [@digest] }}',
          digest: { step: 'act_1', row_template: 'x' },
        },
      },
    ],
  ])('accepts %s', (_name, extra) => {
    expect(sendEmailConfigSchema.safeParse({ ...minimal, ...extra }).success).toBe(true);
  });

  it.each([
    ['no recipient', { to: [] }],
    ['Reply-To a literal (ADR-33 §1)', { reply_to: { literal: 'phish@evil.vn' } }],
    ['Reply-To a template', { reply_to: { template: 'x@y.vn' } }],
    ['Reply-To run_as false', { reply_to: { run_as: false } }],
    ['a recipient template', { to: [{ template: '{{ x }}' }] }],
    ['a literal that is not a string', { to: [{ literal: 42 }] }],
    ['51 recipient values', { to: Array.from({ length: 51 }, () => ({ field: FLD })) }],
    ['an empty subject', { subject: { template: '' } }],
    ['HTML instead of Markdown', { body: { format: 'html', template: '<b>x</b>' } }],
    ['a sender name (belongs to the identity)', { sender_name: 'HR' }],
    ['a footer level that does not exist', { footer: 'big' }],
    [
      'a body over 20 000 characters',
      { body: { format: 'markdown', template: 'x'.repeat(20_001) } },
    ],
  ])('refuses %s', (_name, extra) => {
    expect(sendEmailConfigSchema.safeParse({ ...minimal, ...extra }).success).toBe(false);
  });

  it('is an action type, also inside an if branch', () => {
    expect(AUTOMATION_ACTION_TYPES).toContain('send_email');
    const action = { id: 'act_mail', type: 'send_email', config: minimal };
    expect(automationActionSchema.safeParse(action).success).toBe(true);
    expect(automationBranchActionSchema.safeParse(action).success).toBe(true);
  });

  it('has its run error codes and audit action', () => {
    for (const code of [
      'smtp_not_configured',
      'smtp_temporary',
      'smtp_rejected',
      'email_quota_exceeded',
      'too_many_recipients',
      'email_body_too_large',
      'email_identity_unavailable',
      'email_identity_auth_failed',
      // T532
      'attachment_access_denied',
      'attachment_not_ready',
      'attachment_type_blocked',
      'too_many_attachments',
      'attachments_too_large',
    ]) {
      expect(AUTOMATION_STEP_ERROR_CODES).toContain(code);
    }
    expect(AUDIT_ONLY_ACTIONS).toContain('automation.test_email_sent');
  });

  it('preview and test requests take a record and a draft, never an address', () => {
    expect(automationEmailPreviewRequestSchema.parse({})).toEqual({ record_id: null });
    expect(
      automationEmailTestRequestSchema.safeParse({ record_id: null, to: 'x@y.vn' }).success,
    ).toBe(false);
    expect(
      automationEmailPreviewRequestSchema.safeParse({ record_id: null, draft: minimal }).success,
    ).toBe(true);
  });
});

describe('email settings attachment limits (T532)', () => {
  it('accepts whole limits within the hard ceilings, or null', () => {
    expect(
      updateEmailSettingsRequestSchema.safeParse({
        max_attachments: 20,
        max_attachment_bytes: 30 * 1024 * 1024,
      }).success,
    ).toBe(true);
    expect(updateEmailSettingsRequestSchema.safeParse({ max_attachments: null }).success).toBe(
      true,
    );
  });

  it.each([
    { max_attachments: 0 },
    { max_attachments: 21 },
    { max_attachments: 2.5 },
    { max_attachment_bytes: 1000 },
    { max_attachment_bytes: 30 * 1024 * 1024 + 1 },
  ])('refuses %j', (body) => {
    expect(updateEmailSettingsRequestSchema.safeParse(body).success).toBe(false);
  });
});
