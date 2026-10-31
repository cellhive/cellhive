import { automationDefinitionSchema } from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import {
  addAddresses,
  displayedSender,
  effectiveFooter,
  emailLimitsOf,
  footerLock,
  isEmailAddress,
  isRecipientField,
  readableAddress,
  recipientTokens,
  replyToKey,
  replyToOf,
  senderKeyOf,
  senderOptions,
  splitAddresses,
  testPrefix,
  testSendsLeft,
  testSendWaitSeconds,
  viaSuffix,
  type SenderOption,
} from '../actions/send-email/model';
import { checkDraft } from '../model/check';
import { COMING_SOON, isAddable, newAction, type TableId } from '../model/draft';

import type {
  AutomationDefinition,
  AutomationEmailPreview,
  EmailSettingsDto,
  FieldDto,
} from '@cellhive/contracts';

/**
 * T522: the pure rules of the send steps — new steps, the save check, the
 * sender picker ("recipients will see"), the footer lock, recipient tokens,
 * Reply-To choices, test send counting.
 */

const TICKETS = 'tbl_Tickets000000001' as TableId;
const HR = 'eid_Hr00000000000001' as const;
const IT = 'eid_It00000000000001' as const;

function definitionWith(action: AutomationDefinition['actions'][number]): AutomationDefinition {
  return {
    trigger: { type: 'record.created', table_id: TICKETS, skip_bulk: false },
    condition: null,
    actions: [action],
  };
}

const context = {
  now: new Date('2026-10-06T00:00:00Z'),
  conditions: new Map(),
  orgTimeZone: 'UTC',
};

describe('new send steps (T522)', () => {
  it('adds every send step (send_telegram since T516)', () => {
    expect(isAddable('send_email')).toBe(true);
    expect(isAddable('send_notification')).toBe(true);
    expect(isAddable('send_telegram')).toBe(true);
    // Only the AI steps wait for their editors (T915); none is in the menu.
    expect(COMING_SOON).toEqual({ ai_generate_text: 'T915', ai_classify: 'T915' });
  });

  it.each([
    { identityId: undefined, expected: null },
    { identityId: null, expected: null },
    { identityId: HR, expected: HR },
  ])('starts send_email with sender $identityId', ({ identityId, expected }) => {
    const action = newAction('send_email', 'act_1', {
      triggerTableId: TICKETS,
      firstTableId: TICKETS,
      identityId,
    });
    expect(action).toMatchObject({
      type: 'send_email',
      config: {
        identity_id: expected,
        to: [],
        footer: 'minimal',
        include_signature: true,
        attachments: [],
        on_missing_attachment: 'fail',
        body: { format: 'markdown', template: '', digest: null },
      },
    });
  });

  it.each([
    { triggerTableId: TICKETS, link: 'trigger' },
    { triggerTableId: null, link: null },
  ])(
    'links a notification to the trigger record when there is one ($link)',
    ({ triggerTableId, link }) => {
      const action = newAction('send_notification', 'act_1', {
        triggerTableId,
        firstTableId: TICKETS,
      });
      expect(action).toMatchObject({ config: { link_record: link, skip_actor: false } });
    },
  );

  it('asks for recipients and a subject/title before saving', () => {
    const email = newAction('send_email', 'act_1', { triggerTableId: TICKETS, firstTableId: null });
    expect(
      checkDraft(definitionWith(email), { name: 'A', ...context }).map((issue) => issue.path),
    ).toEqual(['config.to', 'config.subject.template']);
    const note = newAction('send_notification', 'act_1', {
      triggerTableId: TICKETS,
      firstTableId: null,
    });
    expect(
      checkDraft(definitionWith(note), { name: 'A', ...context }).map((issue) => issue.path),
    ).toEqual(['config.recipients', 'config.title.template']);
  });

  it('a filled send_email passes the contract', () => {
    const email = newAction('send_email', 'act_1', { triggerTableId: TICKETS, firstTableId: null });
    if (email.type !== 'send_email') throw new Error('not send_email');
    const filled = {
      ...email,
      config: {
        ...email.config,
        to: [{ literal: 'a@b.vn' }],
        subject: { template: 'Hi' },
      },
    };
    expect(checkDraft(definitionWith(filled), { name: 'A', ...context })).toEqual([]);
    expect(automationDefinitionSchema.safeParse(definitionWith(filled)).success).toBe(true);
  });
});

const field = (type: string, options: unknown = {}): Pick<FieldDto, 'type' | 'options'> => ({
  type: type as FieldDto['type'],
  options: options as FieldDto['options'],
});

describe('recipients', () => {
  it.each([
    [field('user'), true],
    [field('created_by'), true],
    [field('updated_by'), true],
    [field('text', { style: { type: 'email' } }), true],
    [field('text', { style: { type: 'plain' } }), false],
    [field('number'), false],
  ])('%o is a recipient field: %s', (input, expected) => {
    expect(isRecipientField(input)).toBe(expected);
  });

  it.each([
    ['a@b.vn', true],
    ['a.b+c@sub.example.com', true],
    ['a@b', false],
    ['not an email', false],
    ['<a@b.vn>', false],
  ])('%s is an address: %s', (input, expected) => {
    expect(isEmailAddress(input)).toBe(expected);
  });

  it.each([
    ['a@b.vn, c@d.vn; e@f.vn', ['a@b.vn', 'c@d.vn', 'e@f.vn'], []],
    ['<a@b.vn> nope', ['a@b.vn'], ['nope']],
    ['   ', [], []],
  ])('splits %j', (input, valid, invalid) => {
    expect(splitAddresses(input)).toEqual({ valid, invalid });
  });

  it('adds addresses once (case-insensitive) and shows a list literal as tokens', () => {
    const start = [{ literal: ['a@b.vn', 'c@d.vn'] }, { field: 'fld_Owner000000000001' as const }];
    expect(recipientTokens(start)).toEqual([
      { literal: 'a@b.vn' },
      { literal: 'c@d.vn' },
      { field: 'fld_Owner000000000001' },
    ]);
    expect(addAddresses(recipientTokens(start), ['A@B.vn', 'x@y.vn', 'x@y.vn'])).toEqual([
      { literal: 'a@b.vn' },
      { literal: 'c@d.vn' },
      { field: 'fld_Owner000000000001' },
      { literal: 'x@y.vn' },
    ]);
  });

  it.each([
    null,
    { identity_id: HR },
    { field: 'fld_Owner000000000001' as const },
    { run_as: true as const },
    { trigger: 'clicked_by' as const },
  ])('Reply-To %j round-trips through its select value', (value) => {
    expect(replyToOf(replyToKey(value))).toEqual(value);
  });
});

describe('senders (ADR-33)', () => {
  const identities = [
    { id: HR, email: 'hr@banhang.vn', display_name: 'Phòng Nhân sự', mode: 'send_as' as const },
    {
      id: IT,
      email: 'support@itpartner.vn',
      display_name: 'IT Helpdesk',
      mode: 'on_behalf' as const,
    },
  ];

  it.each([
    { enabled: true, keys: ['system', HR, IT] },
    { enabled: null, keys: ['system', HR, IT] },
    { enabled: false, keys: [HR, IT] },
  ])('system sender first unless turned off ($enabled)', ({ enabled, keys }) => {
    const options = senderOptions(identities, {
      systemSenderEnabled: enabled,
      smtpFrom: 'no-reply@banhang.vn',
      orgName: 'Bán Hàng Việt',
    });
    expect(options.map((option) => option.key)).toEqual(keys);
  });

  it('keys the system sender as "system"', () => {
    expect(senderKeyOf(null)).toBe('system');
    expect(senderKeyOf(HR)).toBe(HR);
  });

  const option = (
    mode: SenderOption['mode'],
    name: string,
    email: string | null,
  ): SenderOption => ({
    key: 'k',
    identityId: null,
    name,
    email,
    mode,
  });

  it.each([
    {
      sender: option('system', 'Bán Hàng Việt', 'no-reply@banhang.vn'),
      locale: 'vi-VN',
      from: 'Bán Hàng Việt <no-reply@banhang.vn>',
      replyTo: null,
    },
    {
      sender: option('send_as', 'Phòng Nhân sự', 'hr@banhang.vn'),
      locale: 'vi-VN',
      from: 'Phòng Nhân sự <hr@banhang.vn>',
      replyTo: null,
    },
    {
      sender: option('on_behalf', 'IT Helpdesk', 'support@itpartner.vn'),
      locale: 'vi-VN',
      from: 'IT Helpdesk (qua Cellhive) <no-reply@banhang.vn>',
      replyTo: 'support@itpartner.vn',
    },
    {
      sender: option('on_behalf', 'IT Helpdesk', 'support@itpartner.vn'),
      locale: 'en-US',
      from: 'IT Helpdesk (via Cellhive) <no-reply@banhang.vn>',
      replyTo: 'support@itpartner.vn',
    },
  ])('$sender.mode in $locale shows $from', ({ sender, locale, from, replyTo }) => {
    expect(displayedSender(sender, 'no-reply@banhang.vn', locale, 'system')).toEqual({
      from,
      replyTo,
    });
  });

  it('uses a placeholder when SMTP_FROM is not readable', () => {
    expect(
      displayedSender(option('system', 'Org', null), null, 'en', 'the system address').from,
    ).toBe('Org <the system address>');
  });

  it('reads header addresses', () => {
    expect(readableAddress('"Phòng \\"HR\\"" <hr@a.vn>')).toBe('Phòng "HR" <hr@a.vn>');
    expect(viaSuffix('vi')).toBe('(qua Cellhive)');
    expect(viaSuffix(null)).toBe('(via Cellhive)');
  });
});

describe('footer (CONTRACTS §23.4)', () => {
  it.each([
    { mode: 'system' as const, policy: true, lock: 'system' },
    { mode: null, policy: true, lock: 'system' },
    { mode: 'on_behalf' as const, policy: true, lock: 'on_behalf' },
    { mode: 'send_as' as const, policy: false, lock: 'policy' },
    { mode: 'send_as' as const, policy: true, lock: null },
    { mode: 'send_as' as const, policy: null, lock: null },
  ])('$mode with policy $policy → $lock', ({ mode, policy, lock }) => {
    expect(footerLock(mode, policy)).toBe(lock);
  });

  it.each([
    ['none', 'policy', 'minimal'],
    ['none', null, 'none'],
    ['full', 'system', 'full'],
  ] as const)('%s with lock %s is sent as %s', (footer, lock, expected) => {
    expect(effectiveFooter(footer, lock)).toBe(expected);
  });
});

describe('limits and test sends', () => {
  it('reads limits from the settings, else from the preview warning', () => {
    const preview = {
      warnings: [
        {
          code: 'ATTACHMENTS_SIZE',
          params: { max_attachments: 4, max_attachment_bytes: 1_000 },
        },
      ],
    } as unknown as AutomationEmailPreview;
    expect(emailLimitsOf(undefined, preview)).toEqual({
      maxAttachments: 4,
      maxAttachmentBytes: 1_000,
      maxRecipients: null,
      maxHtmlBytes: null,
      testSendsPerMinute: 5,
    });
    const settings = {
      limits: { max_recipients: 50, max_html_bytes: 102_400, test_sends_per_minute: 3 },
      automation: { max_attachments: 10, max_attachment_bytes: 15_728_640 },
    } as unknown as EmailSettingsDto;
    expect(emailLimitsOf(settings, undefined)).toEqual({
      maxAttachments: 10,
      maxAttachmentBytes: 15_728_640,
      maxRecipients: 50,
      maxHtmlBytes: 102_400,
      testSendsPerMinute: 3,
    });
  });

  it.each([
    { sent: [], now: 100_000, left: 5, wait: 0 },
    { sent: [50_000, 60_000], now: 100_000, left: 3, wait: 10 },
    { sent: [10_000], now: 100_000, left: 5, wait: 0 },
    { sent: [41_000, 42_000, 43_000, 44_000, 45_000], now: 100_000, left: 0, wait: 1 },
  ])('$sent at $now: $left left, wait $wait s', ({ sent, now, left, wait }) => {
    expect(testSendsLeft(sent, now, 5)).toBe(left);
    expect(testSendWaitSeconds(sent, now)).toBe(wait);
  });

  it.each([
    ['vi', '[Thử]'],
    ['vi-VN', '[Thử]'],
    ['en', '[Test]'],
    [null, '[Test]'],
  ])('test subject prefix for %s is %s', (locale, prefix) => {
    expect(testPrefix(locale)).toBe(prefix);
  });
});
