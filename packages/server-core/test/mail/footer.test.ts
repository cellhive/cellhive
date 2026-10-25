import { toHtml, toText } from '@cellhive/markdown';
import { describe, expect, it } from 'vitest';

import {
  automationUrlOf,
  footerBlocks,
  footerNoneAllowedByPolicy,
  resolveFooter,
  type FooterSender,
} from '../../src/mail/index.js';

import type {
  EmailFooterLevel,
  EmailFooterPolicy,
  EmailInstanceFooterPolicy,
} from '@cellhive/contracts';

const INSTANCE: readonly EmailInstanceFooterPolicy[] = ['required', 'org'];
const ORG: readonly EmailFooterPolicy[] = ['required', 'author_choice'];
const REQUESTED: readonly (EmailFooterLevel | undefined)[] = [undefined, 'minimal', 'full', 'none'];
const SENDERS: readonly { name: string; sender: FooterSender }[] = [
  { name: 'system sender', sender: { kind: 'system' } },
  { name: 'identity send_as', sender: { kind: 'identity', mode: 'send_as' } },
  { name: 'identity on_behalf', sender: { kind: 'identity', mode: 'on_behalf' } },
];

/**
 * Expected outcome, written independently of the implementation
 * (ADR-33 §4): `none` only when env = org, org = author_choice and the
 * message goes out as a verified identity in `send_as` mode.
 */
function expected(
  instance: EmailInstanceFooterPolicy,
  org: EmailFooterPolicy,
  requested: EmailFooterLevel | undefined,
  sender: FooterSender,
  phase: 'save' | 'run',
) {
  const level = requested ?? 'minimal';
  if (level !== 'none') return { ok: true, footer: level, downgraded: null };
  const policyAllows = instance === 'org' && org === 'author_choice';
  const senderAllows = sender.kind === 'identity' && sender.mode === 'send_as';
  if (policyAllows && senderAllows) return { ok: true, footer: 'none', downgraded: null };
  const reason = policyAllows ? 'sender' : 'policy';
  return phase === 'save'
    ? { ok: false, code: 'EMAIL_FOOTER_NOT_ALLOWED', reason }
    : { ok: true, footer: 'minimal', downgraded: reason };
}

const CASES = INSTANCE.flatMap((instance) =>
  ORG.flatMap((org) =>
    REQUESTED.flatMap((requested) =>
      SENDERS.flatMap(({ name, sender }) =>
        (['save', 'run'] as const).map((phase) => ({
          instance,
          org,
          requested,
          name,
          sender,
          phase,
        })),
      ),
    ),
  ),
);

describe('resolveFooter: env × org × action × sender × phase (ADR-33 §4)', () => {
  it('covers every combination', () => {
    expect(CASES).toHaveLength(2 * 2 * 4 * 3 * 2);
  });

  it.each(CASES)(
    'env $instance, org $org, action $requested, $name, $phase',
    ({ instance, org, requested, sender, phase }) => {
      expect(
        resolveFooter({ instancePolicy: instance, orgPolicy: org, requested, sender, phase }),
      ).toEqual(expected(instance, org, requested, sender, phase));
    },
  );

  it('allows none only with env org + author_choice + verified send_as identity', () => {
    const allowed = CASES.filter(
      (c) =>
        c.requested === 'none' &&
        resolveFooter({
          instancePolicy: c.instance,
          orgPolicy: c.org,
          requested: c.requested,
          sender: c.sender,
          phase: c.phase,
        }).ok &&
        c.phase === 'save',
    );
    expect(allowed.map((c) => [c.instance, c.org, c.name])).toEqual([
      ['org', 'author_choice', 'identity send_as'],
    ]);
  });

  it('refuses none with the system sender even when the policies allow it', () => {
    expect(
      resolveFooter({
        instancePolicy: 'org',
        orgPolicy: 'author_choice',
        requested: 'none',
        sender: { kind: 'system' },
        phase: 'save',
      }),
    ).toEqual({ ok: false, code: 'EMAIL_FOOTER_NOT_ALLOWED', reason: 'sender' });
  });

  it('reports whether the policies let automations choose none', () => {
    expect(
      footerNoneAllowedByPolicy({ instancePolicy: 'required', orgPolicy: 'author_choice' }),
    ).toBe(false);
    expect(footerNoneAllowedByPolicy({ instancePolicy: 'org', orgPolicy: 'required' })).toBe(false);
    expect(footerNoneAllowedByPolicy({ instancePolicy: 'org', orgPolicy: 'author_choice' })).toBe(
      true,
    );
  });
});

describe('footerBlocks', () => {
  const automation = {
    id: 'aut_Footer0000000001',
    name: 'Payroll cuts 2026',
    baseId: 'bse_Footer0000000001',
    baseName: 'Bad debt customers',
  };
  const content = {
    locale: 'en',
    organizationName: 'Acme',
    publicUrl: 'https://cellhive.example.com/',
    automation,
  };

  it('minimal names only the organization, never the base or automation', () => {
    const blocks = footerBlocks({ ...content, level: 'minimal' });
    const html = toHtml(blocks);
    const text = toText(blocks);
    expect(text).toBe('This email was sent automatically by Cellhive of Acme.');
    for (const output of [html, text]) {
      expect(output).not.toContain('Payroll');
      expect(output).not.toContain('Bad debt');
      expect(output).not.toContain('aut_');
      expect(output).not.toContain('bse_');
      expect(output).not.toContain('http');
    }
  });

  it('full adds the automation, base and a link without token', () => {
    const blocks = footerBlocks({ ...content, level: 'full' });
    const html = toHtml(blocks);
    const text = toText(blocks);
    const url =
      'https://cellhive.example.com/b/bse_Footer0000000001/automations/aut_Footer0000000001';
    expect(automationUrlOf(content.publicUrl, automation)).toBe(url);
    expect(text).toContain('Automation “Payroll cuts 2026” in base “Bad debt customers”.');
    expect(text).toContain(url);
    expect(html).toContain(`href="${url}"`);
    expect(url).not.toMatch(/token|\?/);
  });

  it('is written in the organization language (vi)', () => {
    const blocks = footerBlocks({ ...content, locale: 'vi-VN', level: 'full' });
    const text = toText(blocks);
    expect(text).toContain('Email được gửi tự động bởi Cellhive của Acme.');
    expect(text).toContain('Automation “Payroll cuts 2026” trong base “Bad debt customers”.');
    expect(text).toContain('Mở automation (cần đăng nhập)');
  });

  it('keeps names as text: markup and line breaks in names do nothing', () => {
    const blocks = footerBlocks({
      ...content,
      organizationName: 'Evil **Org**\r\nBcc: x@y.z <script>',
      level: 'full',
      automation: { ...automation, name: '[click](https://evil.example)' },
    });
    const html = toHtml(blocks);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<strong>');
    expect(html).not.toContain('href="https://evil.example"');
    expect(toText(blocks)).not.toContain('\r');
  });
});
