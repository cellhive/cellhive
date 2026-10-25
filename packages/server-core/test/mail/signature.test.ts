import { toHtml, toText } from '@cellhive/markdown';
import { describe, expect, it } from 'vitest';

import { AppError } from '../../src/errors/app-error.js';
import {
  checkSignature,
  DEFAULT_ORG_EMAIL_SETTINGS,
  orgEmailSettingsJson,
  orgEmailSettingsOf,
  signatureAssetIds,
  signatureBlocks,
  signatureInput,
} from '../../src/mail/index.js';

const ASSET = 'att_0123456789abcDEF';
const FIELD = 'fld_0123456789abcDEF';

describe('checkSignature (ADR-33 §3)', () => {
  it.each([
    { name: 'plain text', source: 'Phòng Nhân sự\n0123 456 789', code: null },
    { name: 'narrow Markdown', source: '**HR** · [corp.vn](https://corp.vn)', code: null },
    { name: 'exactly 2,000 characters', source: 'a'.repeat(2000), code: null },
    { name: '2,000 astral characters', source: '😀'.repeat(2000), code: null },
    { name: '2,001 characters', source: 'a'.repeat(2001), code: 'TOO_BIG' },
    { name: 'placeholder', source: 'Hi {{ [Name] }}', code: 'PLACEHOLDER_NOT_ALLOWED' },
    { name: 'bare {{', source: 'Text {{', code: 'PLACEHOLDER_NOT_ALLOWED' },
    { name: 'escaped braces', source: '\\{\\{ x }}', code: null },
    { name: '{{ in code', source: '`{{x}}`', code: 'PLACEHOLDER_NOT_ALLOWED' },
    { name: 'single braces', source: '{ a } }', code: null },
    // T534: up to two uploaded signature images, never a URL.
    { name: 'asset image', source: `![Logo](asset:${ASSET} =120) **HR**`, code: null },
    {
      name: 'two asset images',
      source: `![a](asset:${ASSET}) ![b](asset:${ASSET})`,
      code: null,
    },
    {
      name: 'three images',
      source: `![a](asset:${ASSET})\n![b](asset:${ASSET})\n![c](asset:${ASSET})`,
      code: 'TOO_MANY_IMAGES',
    },
    {
      name: 'remote image',
      source: '![x](https://x.test/p.png)',
      code: 'IMAGE_SOURCE_NOT_ALLOWED',
    },
    {
      name: 'data: image',
      source: '![x](data:image/png;base64,AA)',
      code: 'IMAGE_SOURCE_NOT_ALLOWED',
    },
    { name: 'cid: image', source: `![x](cid:${ASSET})`, code: 'IMAGE_SOURCE_NOT_ALLOWED' },
    { name: 'field image', source: `![x](field:${FIELD})`, code: 'IMAGE_SOURCE_NOT_ALLOWED' },
  ])('$name → $code', ({ source, code }) => {
    expect(checkSignature(source)?.code ?? null).toBe(code);
  });

  it('gives the position of the placeholder', () => {
    expect(checkSignature('ab{{c}}')).toMatchObject({ params: { position: 2 } });
  });

  it('signatureInput stores blank as null and throws VALIDATION_FAILED at the path', () => {
    expect(signatureInput(null, 'x')).toBeNull();
    expect(signatureInput('  \n ', 'x')).toBeNull();
    expect(signatureInput('HR', 'x')).toBe('HR');
    let error: unknown;
    try {
      signatureInput('{{ [Name] }}', 'default_signature_md');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [{ path: 'default_signature_md', code: 'PLACEHOLDER_NOT_ALLOWED' }],
    });
  });
});

describe('signatureBlocks', () => {
  it('renders narrow Markdown', () => {
    const html = toHtml(signatureBlocks('**HR** — [corp.vn](https://corp.vn)'));
    expect(html).toContain('<strong>HR</strong>');
    expect(html).toContain('href="https://corp.vn"');
  });

  it('never renders an image: ![alt](url) keeps only the alternative text', () => {
    for (const source of [
      '![logo](https://evil.example/pixel.png)',
      'Before ![logo](https://evil.example/pixel.png) after',
      '**![logo](https://evil.example/pixel.png)**',
      '- ![logo](https://evil.example/pixel.png)',
    ]) {
      const blocks = signatureBlocks(source);
      const html = toHtml(blocks);
      const text = toText(blocks);
      expect(html).not.toContain('<img');
      expect(html).not.toContain('evil.example');
      expect(text).not.toContain('evil.example');
      expect(text).toContain('logo');
      expect(text).not.toContain('!');
    }
  });

  it('keeps an exclamation mark that is not image syntax', () => {
    expect(toText(signatureBlocks('Thanks! [site](https://corp.vn)'))).toBe(
      'Thanks! site (https://corp.vn)',
    );
  });

  it('leaves a stored {{ as text (never evaluated)', () => {
    expect(toText(signatureBlocks('Hi {{ [Name] }}'))).toBe('Hi {{ [Name] }}');
  });

  it('is empty for null or blank', () => {
    expect(signatureBlocks(null)).toEqual([]);
    expect(signatureBlocks('  ')).toEqual([]);
  });

  it('keeps signature assets as image nodes, [alt] in text (T534)', () => {
    const blocks = signatureBlocks(`**HR** ![Logo](asset:${ASSET} =120)`);
    expect(toText(blocks)).toBe('HR [Logo]');
    // Without inline parts the HTML leaves the image out (never a URL).
    expect(toHtml(blocks)).not.toContain('<img');
    expect(signatureAssetIds(`![a](asset:${ASSET}) ![b](asset:${ASSET})`)).toEqual([ASSET]);
    expect(signatureAssetIds('![a](https://x.test/a.png)')).toEqual([]);
  });
});

describe('orgEmailSettingsOf', () => {
  it('defaults missing or malformed settings', () => {
    expect(orgEmailSettingsOf({})).toEqual(DEFAULT_ORG_EMAIL_SETTINGS);
    expect(orgEmailSettingsOf(null)).toEqual(DEFAULT_ORG_EMAIL_SETTINGS);
    expect(
      orgEmailSettingsOf({
        email: {
          footer_policy: 'never',
          default_signature_md: 3,
          system_sender_enabled: 'no',
          max_attachments: -1,
          max_attachment_bytes: 'x',
        },
      }),
    ).toEqual(DEFAULT_ORG_EMAIL_SETTINGS);
    expect(DEFAULT_ORG_EMAIL_SETTINGS).toEqual({
      footerPolicy: 'required',
      defaultSignatureMd: null,
      systemSenderEnabled: true,
      maxAttachments: null,
      maxAttachmentBytes: null,
    });
  });

  it('round-trips the stored form', () => {
    const value = {
      footerPolicy: 'author_choice' as const,
      defaultSignatureMd: 'HR',
      systemSenderEnabled: false,
      maxAttachments: 5,
      maxAttachmentBytes: 5 * 1024 * 1024,
    };
    expect(orgEmailSettingsOf({ locale: 'vi', email: orgEmailSettingsJson(value) })).toEqual(value);
  });
});
