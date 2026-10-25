import { describe, expect, it } from 'vitest';

import {
  DISPLAY_NAME_ISSUES,
  DISPLAY_NAME_NOT_ALLOWED,
  createEmailIdentityRequestSchema,
  displayNameIssueOf,
  emailIdentitySchema,
  looksLikeAddressOrUrl,
  updateEmailIdentityRequestSchema,
  type DisplayNameIssue,
} from '../src/email-identities.js';
import { ERROR_DETAIL_CODES, EMAIL_IDENTITY_DETAIL_CODES } from '../src/error-details.js';

/**
 * Display names of sender identities (BACKLOG T540, QA S5 M7, Quyết định S5b
 * #1): `@`, `<`, `>`, control characters and URL/domain look-alikes are
 * refused, everything else a department may be called is kept.
 */
const CASES: readonly (readonly [string, string, DisplayNameIssue | null])[] = [
  // Allowed: names of departments, people, organizations.
  ['Vietnamese department', 'Phòng Nhân sự', null],
  ['parentheses', 'Nhân sự (HN)', null],
  ['abbreviation then space', 'Dept. IT', null],
  ['sentence ending with a full stop', 'Phòng Kế toán.', null],
  ['two Vietnamese sentences', 'Phòng IT. Hỗ trợ kỹ thuật.', null],
  ['ellipsis', 'Chăm sóc khách hàng…', null],
  ['no-break space inside', 'Phòng IT', null],
  ['narrow no-break space', 'Phòng IT', null],
  ['ampersand and hyphen', 'R&D - Hà Nội', null],
  ['version number', 'Hệ thống 2.0', null],
  ['decimal with letter suffix of one char', 'Tầng 3.A', null],
  ['single-letter initials', 'Công ty A.B.C', null],
  ['quotes and comma', 'Phòng "Kinh doanh", CN 2', null],
  ['space before the dot', 'example .com', null],
  ['space after the dot', 'example. com', null],
  ['emoji with zero-width joiner', 'Đội 👩‍💻 IT', null],
  ['left-to-right mark (allowed, not an override)', 'IT‎', null],
  ['the word www without a dot', 'Nhóm www', null],
  ['a colon without slashes', 'Hỗ trợ: 24/7', null],
  ['single slash path', 'Kế toán/Tài chính', null],
  ['Japanese', '人事部', null],
  ['Cyrillic', 'Отдел кадров', null],

  // `@` (also its NFKC look-alikes).
  ['plain address', 'hr@corp.vn', 'at_sign'],
  ['at sign without domain', 'hr@corp', 'at_sign'],
  ['lonely at sign', 'Team @ HN', 'at_sign'],
  ['fullwidth at sign', 'hr＠corp', 'at_sign'],
  ['small commercial at', 'hr﹫corp', 'at_sign'],

  // `<` / `>` (checked before `@`: a whole mailbox is reported as brackets).
  ['mailbox in brackets', 'PayPal <a@b>', 'angle_bracket'],
  ['less-than only', 'A < B', 'angle_bracket'],
  ['greater-than only', 'IT > HR', 'angle_bracket'],
  ['fullwidth angle bracket', 'PayPal ＜support＞', 'angle_bracket'],

  // Control characters (checked first).
  ['line feed', 'HR\nBcc: x', 'control_char'],
  ['carriage return', 'HR\r', 'control_char'],
  ['tab', 'HR\tteam', 'control_char'],
  ['NUL', 'HR\u0000', 'control_char'],
  ['DEL', 'HR\u007f', 'control_char'],
  ['C1 control', 'HR\u0085', 'control_char'],
  ['line separator', 'HR IT', 'control_char'],
  ['paragraph separator', 'HR IT', 'control_char'],
  ['right-to-left override (RLO)', 'Invoice‮fdp.exe', 'control_char'],
  ['left-to-right embedding', '‪HR', 'control_char'],
  ['pop directional formatting', 'HR‬', 'control_char'],
  ['right-to-left isolate', '⁧HR⁩', 'control_char'],
  ['first strong isolate', '⁨HR', 'control_char'],
  ['control char wins over brackets and URL', 'a <b> https://x\n', 'control_char'],

  // URL / domain look-alikes.
  ['https scheme', 'https://x', 'url'],
  ['http scheme with path', 'Bank http://evil.example/login', 'url'],
  ['other scheme', 'ftp://files', 'url'],
  ['uppercase scheme', 'HTTPS://BANK', 'url'],
  ['www prefix', 'www.bank', 'url'],
  ['www inside the name', 'Bank www.example', 'url'],
  ['uppercase www', 'WWW.EXAMPLE', 'url'],
  ['bare domain', 'x.com', 'url'],
  ['domain with subdomain', 'Support mail.corp.vn', 'url'],
  ['domain in a sentence', 'Liên hệ paypal.com ngay', 'url'],
  ['domain with hyphen', 'my-bank.vn', 'url'],
  ['domain then path', 'paypal.com/login', 'url'],
  ['digits in the label', 'bank24.io', 'url'],
  ['abbreviation without space', 'Dept.IT', 'url'],
  ['IDN domain (Unicode)', 'bücher.de', 'url'],
  ['IDN domain (Vietnamese)', 'ví-dụ.vn', 'url'],
  ['IDN TLD (Cyrillic)', 'пример.рф', 'url'],
  ['punycode label', 'xn--bcher-kva.de', 'url'],
  ['punycode TLD', 'example.xn--p1ai', 'url'],
  ['fullwidth dots and letters', 'ｗｗｗ．ｅｘａｍｐｌｅ．ｃｏｍ', 'url'],
  ['ideographic full stop as dot', 'example。com', 'url'],
  ['halfwidth ideographic full stop', 'example｡com', 'url'],
  // QA T559: invisible marks that are not format characters (default ignorable).
  ['U+034F combining grapheme joiner after the dot', 'paypal.͏com', 'url'],
  ['U+FE0F variation selector after the dot', 'paypal.️com', 'url'],
  ['U+FE00 variation selector after the dot', 'paypal.︀com', 'url'],
  ['U+17B4 Khmer inherent vowel after the dot', 'paypal.឴com', 'url'],
  ['U+034F before the label', 'Team ͏paypal.com', 'url'],
  ['U+FE0F before the label', 'Team ️paypal.com', 'url'],
  ['emoji with a variation selector', 'Café ☕️', null],
  ['zero-width space to hide the dot', 'example​.com', 'url'],
  ['soft hyphen inside the domain', 'pay­pal.com', 'url'],
  ['brackets win over URL', 'Bank <a> https://x', 'angle_bracket'],
  ['at sign wins over URL', 'Bank a@evil.com https://x', 'at_sign'],
];

describe('displayNameIssueOf (T540, QA S5 M7)', () => {
  it.each(CASES)('%s: %j → %s', (_label, name, issue) => {
    expect(displayNameIssueOf(name)).toBe(issue);
  });

  it('covers at least 30 cases of every kind', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(30);
    for (const issue of [null, ...DISPLAY_NAME_ISSUES]) {
      expect(CASES.some(([, , expected]) => expected === issue)).toBe(true);
    }
  });
});

describe('displayNameIssueOf on hostile input', () => {
  it.each([
    ['letters', 'a'.repeat(200_000)],
    ['labels and hyphens', 'a-'.repeat(100_000)],
    ['dots and letters', 'a.'.repeat(100_000) + '1'],
    ['letters with a dot at the end', 'a'.repeat(200_000) + '.1'],
  ])('stays fast on long %s', (_label, value) => {
    const start = performance.now();
    displayNameIssueOf(value);
    expect(performance.now() - start).toBeLessThan(500);
  });

  it('a request name over the limit only reports its length', () => {
    const result = updateEmailIdentityRequestSchema.safeParse({
      display_name: 'https://x '.repeat(100_000),
    });
    expect(result.error?.issues.map((issue) => issue.code)).toEqual(['too_big']);
  });
});

describe('looksLikeAddressOrUrl', () => {
  it.each([
    ['https://x', true],
    ['www.example', true],
    ['x.com', true],
    ['bücher.de', true],
    ['example.xn--p1ai', true],
    ['example .com', false],
    ['Dept. IT', false],
    ['Phòng Nhân sự.', false],
    ['Hệ thống 2.0', false],
    ['hr@corp', false],
    ['', false],
  ] as const)('%j → %s', (value, expected) => {
    expect(looksLikeAddressOrUrl(value)).toBe(expected);
  });
});

describe('display_name in requests (CONTRACTS §23.3)', () => {
  const create = { email: 'hr@corp.vn', transport: 'system' };

  it.each([
    ['PayPal <a@b>', 'angle_bracket'],
    ['hr@corp', 'at_sign'],
    ['HR‮', 'control_char'],
    ['https://x', 'url'],
  ] as const)('refuses %j on create and update with reason %s', (name, reason) => {
    for (const result of [
      createEmailIdentityRequestSchema.safeParse({ ...create, display_name: name }),
      updateEmailIdentityRequestSchema.safeParse({ display_name: name }),
    ]) {
      expect(result.success).toBe(false);
      expect(result.error?.issues).toEqual([
        expect.objectContaining({
          code: 'custom',
          path: ['display_name'],
          params: { code: DISPLAY_NAME_NOT_ALLOWED, reason },
        }),
      ]);
    }
  });

  it('accepts ordinary names and an update without display_name', () => {
    expect(
      createEmailIdentityRequestSchema.parse({ ...create, display_name: 'Phòng Nhân sự' })
        .display_name,
    ).toBe('Phòng Nhân sự');
    expect(updateEmailIdentityRequestSchema.parse({ signature_md: 'Trân trọng' })).toEqual({
      signature_md: 'Trân trọng',
    });
  });

  it('keeps the length checks', () => {
    expect(
      createEmailIdentityRequestSchema.safeParse({ ...create, display_name: '' }).error?.issues[0]
        ?.code,
    ).toBe('too_small');
    expect(
      updateEmailIdentityRequestSchema.safeParse({ display_name: 'x'.repeat(101) }).error?.issues[0]
        ?.code,
    ).toBe('too_big');
  });

  it('documents the detail code', () => {
    expect(EMAIL_IDENTITY_DETAIL_CODES).toContain(DISPLAY_NAME_NOT_ALLOWED);
    expect(ERROR_DETAIL_CODES).toContain(DISPLAY_NAME_NOT_ALLOWED);
  });
});

describe('display_name_issue in responses', () => {
  it('is null or one of the reasons', () => {
    const shape = emailIdentitySchema.shape.display_name_issue;
    expect(shape.parse(null)).toBeNull();
    for (const issue of DISPLAY_NAME_ISSUES) expect(shape.parse(issue)).toBe(issue);
    expect(shape.safeParse('other').success).toBe(false);
  });
});
