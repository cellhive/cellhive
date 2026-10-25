import { describe, expect, it } from 'vitest';

import {
  automationEmailImages,
  composeAutomationEmail,
  DEFAULT_ORG_EMAIL_SETTINGS,
  inlineImageCid,
  InlineImageSet,
  sanitizeEmailHtml,
  signatureSourceOf,
  type ComposeAutomationEmailInput,
  type ComposedAutomationEmail,
} from '../../src/mail/index.js';

const BASE_INPUT: ComposeAutomationEmailInput = {
  subject: 'Leave approved',
  body: { template: 'Hello **{{ [Name] }}**,\n\nYour leave is approved.', values: ['Lan'] },
  sender: { identityId: null, mode: 'send_as', signatureMd: null },
  orgSettings: { ...DEFAULT_ORG_EMAIL_SETTINGS, defaultSignatureMd: '**Acme HR bot**' },
  instanceFooterPolicy: 'required',
  locale: 'en',
  organizationName: 'Acme',
  publicUrl: 'https://cellhive.example.com',
  automation: {
    id: 'aut_Compose000000001',
    name: 'Secret payroll flow',
    baseId: 'bse_Compose000000001',
    baseName: 'Payroll 2026',
  },
  maxHtmlBytes: 102_400,
};

function compose(overrides: Partial<ComposeAutomationEmailInput> = {}): ComposedAutomationEmail {
  const result = composeAutomationEmail({ ...BASE_INPUT, ...overrides });
  if (!result.ok) throw new Error(`compose failed: ${result.code}`);
  return result.email;
}

const IDENTITY_SEND_AS = {
  identityId: 'eid_Compose000000001' as const,
  mode: 'send_as' as const,
  signatureMd: 'Phòng Nhân sự · [corp.vn](https://corp.vn)',
};

describe('composeAutomationEmail (T531)', () => {
  it('orders body → signature → rule → footer in HTML and text', () => {
    const email = compose();
    const { html, text } = email;
    const order = ['Lan', 'Acme HR bot', 'This email was sent automatically by Cellhive of Acme.'];
    const htmlAt = order.map((part) => html.indexOf(part));
    const textAt = order.map((part) => text.indexOf(part));
    expect(htmlAt.every((at) => at >= 0)).toBe(true);
    expect(textAt.every((at) => at >= 0)).toBe(true);
    expect([...htmlAt].sort((a, b) => a - b)).toEqual(htmlAt);
    expect([...textAt].sort((a, b) => a - b)).toEqual(textAt);
    // The rule (layout footer row) sits between the signature and the footer.
    const rule = html.indexOf('border-top:1px solid');
    expect(rule).toBeGreaterThan(htmlAt[1] as number);
    expect(rule).toBeLessThan(htmlAt[2] as number);
    expect(text).toBe(
      'Hello Lan,\n\nYour leave is approved.\n\nAcme HR bot\n\n---\n' +
        'This email was sent automatically by Cellhive of Acme.\n',
    );
    expect(email).toMatchObject({ footer: 'minimal', footerDowngraded: null, signature: true });
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<title>Leave approved</title>');
  });

  it('never parses values: a value with Markdown/HTML stays text', () => {
    const email = compose({
      body: {
        template: 'Note: {{ [Note] }}',
        values: ['[click](https://evil.example) ![x](https://evil.example/p.png) <b>hi</b>'],
      },
    });
    expect(email.html).not.toContain('href="https://evil.example"');
    expect(email.html).not.toContain('<img');
    expect(email.html).not.toContain('<b>');
    expect(email.html).toContain('&lt;b&gt;hi&lt;/b&gt;');
  });

  it('is unchanged by the sanitize-html second layer (body fragment already clean)', () => {
    const email = compose({ footer: 'full' });
    const body = /<td style="padding:24px;[^"]*">([\s\S]*?)<\/td><\/tr>/.exec(email.html)?.[1];
    expect(body).toBeDefined();
    expect(sanitizeEmailHtml(body as string)).toBe(body);
  });

  it('uses the organization default signature for the system sender only', () => {
    expect(compose().text).toContain('Acme HR bot');
    const identity = compose({ sender: IDENTITY_SEND_AS });
    expect(identity.text).not.toContain('Acme HR bot');
    expect(identity.text).toContain('Phòng Nhân sự · corp.vn (https://corp.vn)');
  });

  it('include_signature: false leaves the signature out', () => {
    const email = compose({ includeSignature: false, sender: IDENTITY_SEND_AS });
    expect(email.signature).toBe(false);
    expect(email.text).not.toContain('Phòng Nhân sự');
    expect(
      compose({ orgSettings: DEFAULT_ORG_EMAIL_SETTINGS, includeSignature: true }).signature,
    ).toBe(false);
  });

  it('never renders an image of a signature', () => {
    const email = compose({
      sender: { ...IDENTITY_SEND_AS, signatureMd: 'HR ![logo](https://evil.example/logo.png)' },
    });
    expect(email.html).not.toContain('<img');
    expect(email.html).not.toContain('evil.example');
    expect(email.text).toContain('HR logo');
  });

  it('full shows the automation and base; minimal never does', () => {
    const minimal = compose({ footer: 'minimal' });
    for (const part of [minimal.html, minimal.text]) {
      expect(part).not.toContain('Secret payroll flow');
      expect(part).not.toContain('Payroll 2026');
      expect(part).not.toContain('/automations/');
    }
    const full = compose({ footer: 'full' });
    expect(full.footer).toBe('full');
    expect(full.text).toContain('Automation “Secret payroll flow” in base “Payroll 2026”.');
    expect(full.html).toContain(
      'href="https://cellhive.example.com/b/bse_Compose000000001/automations/aut_Compose000000001"',
    );
  });

  it('applies minimal when none is no longer allowed (policy tightened after saving)', () => {
    const sendAs = { sender: IDENTITY_SEND_AS, footer: 'none' as const };
    const allowed = compose({
      ...sendAs,
      instanceFooterPolicy: 'org',
      orgSettings: { ...DEFAULT_ORG_EMAIL_SETTINGS, footerPolicy: 'author_choice' },
    });
    expect(allowed).toMatchObject({ footer: 'none', footerDowngraded: null });
    expect(allowed.text).not.toContain('Cellhive of Acme');
    expect(allowed.text).not.toContain('\n---\n');

    const orgTightened = compose({ ...sendAs, instanceFooterPolicy: 'org' });
    expect(orgTightened).toMatchObject({ footer: 'minimal', footerDowngraded: 'policy' });
    expect(orgTightened.text).toContain('This email was sent automatically by Cellhive of Acme.');

    const envTightened = compose({
      ...sendAs,
      orgSettings: { ...DEFAULT_ORG_EMAIL_SETTINGS, footerPolicy: 'author_choice' },
    });
    expect(envTightened).toMatchObject({ footer: 'minimal', footerDowngraded: 'policy' });
  });

  it('always has a footer with the system sender or on_behalf', () => {
    const policies = {
      footer: 'none' as const,
      instanceFooterPolicy: 'org' as const,
      orgSettings: { ...DEFAULT_ORG_EMAIL_SETTINGS, footerPolicy: 'author_choice' as const },
    };
    expect(compose(policies)).toMatchObject({ footer: 'minimal', footerDowngraded: 'sender' });
    expect(
      compose({ ...policies, sender: { ...IDENTITY_SEND_AS, mode: 'on_behalf' } }),
    ).toMatchObject({ footer: 'minimal', footerDowngraded: 'sender' });
  });

  it('writes the footer in the organization language', () => {
    const email = compose({ locale: 'vi' });
    expect(email.text).toContain('Email được gửi tự động bởi Cellhive của Acme.');
    expect(email.html).toContain('<html lang="vi">');
  });

  it('cleans the subject (no CR/LF, ≤ 255)', () => {
    const email = compose({ subject: `Hi\r\nBcc: x@evil.example ${'a'.repeat(300)}` });
    expect(email.subject).not.toMatch(/[\r\n]/);
    expect(Array.from(email.subject).length).toBeLessThanOrEqual(255);
  });

  it('fails with email_body_too_large above EMAIL_MAX_HTML_BYTES, without cutting', () => {
    const result = composeAutomationEmail({ ...BASE_INPUT, maxHtmlBytes: 1024 });
    expect(result).toMatchObject({ ok: false, code: 'email_body_too_large' });
    expect(result.ok ? 0 : result.htmlBytes).toBeGreaterThan(1024);
  });
});

describe('composeAutomationEmail images (T534)', () => {
  const ASSET = 'att_ComposeLogo00001';
  const BODY_ASSET = 'att_ComposeBody00001';
  const FIELD = 'fld_ComposePhoto0001';
  const file = (fileId: string, width: number | null) => ({
    fileId,
    cid: inlineImageCid(fileId),
    objectKey: `org/${fileId}`,
    size: 100,
    mime: 'image/png',
    filename: `${fileId}.png`,
    width,
  });

  it('embeds images only as cid: parts the caller resolved, [alt] in text', () => {
    const set = new InlineImageSet();
    const body = {
      template:
        `Hi ![Banner](asset:${BODY_ASSET})\n\n![Photo](field:${FIELD})\n\n` +
        '![remote](https://evil.example/p.png) {{ [Note] }}',
      values: [`![x](asset:${BODY_ASSET}) <img src="cid:${BODY_ASSET}@cellhive">`],
    };
    const orgSettings = {
      ...DEFAULT_ORG_EMAIL_SETTINGS,
      defaultSignatureMd: `**Acme** ![Logo](asset:${ASSET} =120)`,
    };
    const nodes = automationEmailImages(body.template, orgSettings.defaultSignatureMd);
    expect(nodes.body.map((node) => node.id)).toEqual([BODY_ASSET, FIELD]);
    expect(nodes.signature.map((node) => node.id)).toEqual([ASSET]);
    const [banner, photo] = nodes.body;
    const [logo] = nodes.signature;
    if (banner === undefined || photo === undefined || logo === undefined) throw new Error('nodes');
    set.set('body', banner, [file(BODY_ASSET, 1280)]);
    set.set('body', photo, [
      file('att_ComposePhoto0001', null),
      file('att_ComposePhoto0002', null),
    ]);
    set.set('signature', logo, [file(ASSET, 300)]);
    const email = compose({
      body,
      orgSettings,
      images: { body: set.resolver('body'), signature: set.resolver('signature') },
    });
    const sources = [...email.html.matchAll(/<img src="([^"]+)"[^>]*>/gu)].map((match) => match[1]);
    expect(sources).toEqual([
      `cid:${BODY_ASSET}@cellhive`,
      'cid:att_ComposePhoto0001@cellhive',
      'cid:att_ComposePhoto0002@cellhive',
      `cid:${ASSET}@cellhive`,
    ]);
    // Natural width capped to the column; the author's width kept.
    expect(email.html).toContain(`src="cid:${BODY_ASSET}@cellhive" alt="Banner" width="552"`);
    expect(email.html).toContain(`src="cid:${ASSET}@cellhive" alt="Logo" width="120"`);
    // Values and URLs never become images (a URL written by the author stays a link,
    // refused when saved: IMAGE_SOURCE_NOT_ALLOWED).
    expect(email.html).not.toMatch(/<img[^>]*evil\.example/u);
    expect(email.html).toContain('&lt;img src="cid:');
    expect(email.text).toContain('Hi [Banner]');
    expect(email.text).toContain('[Photo] [Photo]');
    expect(email.text).toContain('Acme [Logo]');
    expect(set.files.map((item) => item.fileId)).toEqual([
      BODY_ASSET,
      'att_ComposePhoto0001',
      'att_ComposePhoto0002',
      ASSET,
    ]);
    expect(set.bytes).toBe(400);
  });

  it('leaves out images without resolved parts (no URL, no data:)', () => {
    const email = compose({
      body: { template: `![Banner](asset:${BODY_ASSET}) text`, values: [] },
    });
    expect(email.html).not.toContain('<img');
    expect(email.text).toContain('text');
  });

  it('signatureSourceOf picks the identity signature or the organization default', () => {
    const org = { defaultSignatureMd: 'org' };
    expect(signatureSourceOf({ identityId: null, signatureMd: 'x' }, org, undefined)).toBe('org');
    expect(signatureSourceOf(IDENTITY_SEND_AS, org, true)).toBe(IDENTITY_SEND_AS.signatureMd);
    expect(signatureSourceOf(IDENTITY_SEND_AS, org, false)).toBeNull();
  });
});
