import { describe, expect, it } from 'vitest';

import {
  classifySmtpError,
  connectionTestEmail,
  createValkeyEmailQuota,
  deterministicMessageId,
  instanceEndpoint,
  isValidMessageId,
  mandatoryHeaders,
  maskAddress,
  maskHost,
  normalizeAddress,
  renderEmailLayout,
  sanitizeHeaderText,
  SendRateLimiter,
  smtpReplyOf,
  type QuotaClient,
} from '../../src/mail/index.js';

describe('classifySmtpError', () => {
  it.each([
    [
      { responseCode: 451, response: '451 4.7.1 Try later' },
      'smtp_temporary',
      'temporary',
      451,
      '4.7.1',
    ],
    [{ responseCode: 421, response: '421 busy' }, 'smtp_temporary', 'temporary', 421, null],
    [
      { responseCode: 550, response: '550 5.1.1 unknown' },
      'smtp_rejected',
      'rejected',
      550,
      '5.1.1',
    ],
    [{ responseCode: 552, response: '552 too big' }, 'smtp_rejected', 'rejected', 552, null],
    [
      { code: 'EAUTH', responseCode: 535, response: '535 5.7.8 bad' },
      'smtp_rejected',
      'auth_failed',
      535,
      '5.7.8',
    ],
    [
      { code: 'EAUTH', responseCode: 454, response: '454 4.7.0 later' },
      'smtp_temporary',
      'auth_failed',
      454,
      '4.7.0',
    ],
    [{ code: 'EAUTH' }, 'smtp_rejected', 'auth_failed', null, null],
    [
      { code: 'ETLS', responseCode: 502, response: '502 no' },
      'smtp_temporary',
      'tls_failed',
      502,
      null,
    ],
    [
      { code: 'ESOCKET', message: 'self-signed certificate' },
      'smtp_temporary',
      'tls_failed',
      null,
      null,
    ],
    [{ code: 'ETIMEDOUT' }, 'smtp_temporary', 'timeout', null, null],
    [{ code: 'ECONNECTION' }, 'smtp_temporary', 'connection_failed', null, null],
    [{ code: 'ECONNREFUSED' }, 'smtp_temporary', 'connection_failed', null, null],
    [{ code: 'EDNS' }, 'smtp_temporary', 'connection_failed', null, null],
    [{ code: 'EMESSAGE' }, 'smtp_rejected', 'rejected', null, null],
    [
      { code: 'EENVELOPE', rejectedErrors: [{ responseCode: 550 }, { responseCode: 452 }] },
      'smtp_temporary',
      'temporary',
      452,
      null,
    ],
    [
      { code: 'EENVELOPE', rejectedErrors: [{ responseCode: 550, response: '550 5.1.1 x' }] },
      'smtp_rejected',
      'rejected',
      550,
      '5.1.1',
    ],
    [new Error('something odd'), 'smtp_temporary', 'unknown', null, null],
    ['not an error', 'smtp_temporary', 'unknown', null, null],
  ] as const)('%j → %s / %s', (error, kind, reason, code, enhanced) => {
    const failure = classifySmtpError(error);
    expect(failure).toEqual({
      kind,
      reason,
      retryable: kind === 'smtp_temporary',
      smtp: { code, enhanced },
    });
  });

  it('reads the code from the reply text when no number is given', () => {
    expect(smtpReplyOf('250 2.0.0 Ok: queued as 123')).toEqual({ code: 250, enhanced: '2.0.0' });
    expect(smtpReplyOf(undefined)).toEqual({ code: null, enhanced: null });
  });
});

describe('addresses and header text', () => {
  it.each([
    ['an@example.com', 'an@example.com'],
    ['  An.B+tag@Example.COM ', 'An.B+tag@example.com'],
    ['an@bücher.example', 'an@xn--bcher-kva.example'],
    ['An <an@example.com>', null],
    ['an@example.com, b@example.com', null],
    ['an@example.com\r\nBcc: x@example.com', null],
    ['an@localhost', null],
    ['an@[127.0.0.1]', null],
    ['an..b@example.com', null],
    ['ân@example.com', null],
    ['@example.com', null],
    ['an@', null],
    [`${'a'.repeat(65)}@example.com`, null],
  ])('normalizeAddress(%j) → %j', (input, expected) => {
    expect(normalizeAddress(input)).toBe(expected);
  });

  it('masks addresses for logs and run steps', () => {
    expect(maskAddress('an.nguyen@Example.com')).toBe('a***@example.com');
    expect(maskAddress('garbage')).toBe('***');
  });

  it('strips CR/LF and control characters, at most 255 code points', () => {
    expect(sanitizeHeaderText('Hi\r\nBcc: x\u0000\u2028there')).toBe('Hi Bcc: x there');
    expect(Array.from(sanitizeHeaderText('🙂'.repeat(300)))).toHaveLength(255);
    expect(sanitizeHeaderText('abc', 2)).toBe('ab');
  });
});

describe('headers', () => {
  it('always sets Auto-Submitted and X-Auto-Response-Suppress (never All)', () => {
    expect(mandatoryHeaders({ kind: 'system' })).toEqual({
      'Auto-Submitted': 'auto-generated',
      'X-Auto-Response-Suppress': 'OOF, AutoReply',
    });
    expect(
      mandatoryHeaders({ kind: 'automation', organizationId: 'org_a', automationId: 'aut_1' }),
    ).toMatchObject({ 'X-Cellhive-Automation': 'aut_1' });
    expect(() =>
      mandatoryHeaders({ kind: 'automation', organizationId: 'org_a', automationId: 'a\r\nb' }),
    ).toThrow(TypeError);
  });

  it('derives a stable Message-ID that hides the key', () => {
    const first = deterministicMessageId('run_9:act_2', 'Example.COM');
    expect(first).toBe(deterministicMessageId('run_9:act_2', 'example.com'));
    expect(first).not.toBe(deterministicMessageId('run_9:act_3', 'example.com'));
    expect(first).toMatch(/^<ob\.[0-9a-f]{40}@example\.com>$/);
    expect(isValidMessageId(first)).toBe(true);
    expect(isValidMessageId('<a\r\n@b>')).toBe(false);
    expect(isValidMessageId('no-brackets@b')).toBe(false);
  });
});

describe('layout', () => {
  const rendered = renderEmailLayout({
    lang: 'vi',
    title: 'Ticket <1>',
    preheader: 'Preview & more',
    body: { html: '<p>Body</p>', text: 'Body' },
    footer: { html: 'Footer', text: 'Footer' },
  });

  it('is one column of at most 600 px with inline styles and color-scheme', () => {
    expect(rendered.html).toContain('max-width:600px');
    expect(rendered.html).toContain('width="600"');
    expect(rendered.html).toContain('<meta name="color-scheme" content="light dark">');
    expect(rendered.html).toContain('<meta name="supported-color-schemes" content="light dark">');
    expect(rendered.html).toContain('<html lang="vi">');
    expect(rendered.html).toContain('<title>Ticket &lt;1&gt;</title>');
    expect(rendered.html).toContain('Preview &amp; more');
    expect(rendered.html.indexOf('<p>Body</p>')).toBeLessThan(rendered.html.indexOf('Footer'));
  });

  it('breaks long words inside the card, body and footer (T527)', () => {
    const cells = rendered.html.match(/<td style="[^"]*">(?:<p>Body<\/p>|Footer)<\/td>/gu) ?? [];
    expect(cells).toHaveLength(2);
    for (const cell of cells) {
      expect(cell).toContain('word-break:break-word;overflow-wrap:anywhere;');
    }
  });

  it('has no remote resources, stylesheet or script', () => {
    expect(rendered.html).not.toMatch(/<link|<style|<script|<img|url\(|@import|https?:\/\//i);
  });

  it('builds the plain-text part with the footer after a rule', () => {
    expect(rendered.text).toBe('Body\n\n---\nFooter\n');
    const bare = renderEmailLayout({
      lang: 'x"><script>',
      title: 't',
      body: { html: '', text: 'B' },
    });
    expect(bare.text).toBe('B\n');
    expect(bare.html).toContain('<html lang="en">');
  });

  it('wraps the connection test email in it, en and vi', () => {
    const at = new Date('2026-10-05T03:00:00.000Z');
    const en = connectionTestEmail('me@example.test', {
      locale: 'en',
      organizationName: 'Acme <b>',
      sentAt: at,
    });
    expect(en.subject).toBe('Cellhive: SMTP connection test');
    expect(en.html).toContain('max-width:600px');
    expect(en.html).toContain('Acme &lt;b&gt;');
    expect(en.text).toContain('Sent at 2026-10-05 03:00 UTC.');
    const vi = connectionTestEmail('me@example.test', {
      locale: 'vi-VN',
      organizationName: 'Acme',
      sentAt: at,
    });
    expect(vi.subject).toBe('Cellhive: kiểm tra kết nối SMTP');
  });
});

describe('transport description', () => {
  it.each([
    ['smtp.mail.example.com', '***.example.com'],
    ['mail.example.com', '***.example.com'],
    ['example.com', 'e***.com'],
    ['10.0.0.5', '***'],
    ['::1', '***'],
  ])('maskHost(%s) → %s', (host, masked) => {
    expect(maskHost(host)).toBe(masked);
  });

  it.each([
    ['smtps://u:p%40ss@mail.example.com', false, 'tls', 465, { user: 'u', pass: 'p@ss' }],
    ['smtp://mail.example.com', false, 'starttls', 587, null],
    ['smtp://mail.example.com:25', true, 'none', 25, null],
  ] as const)('%s (insecure %s) → %s:%i', (url, allowInsecure, security, port, credentials) => {
    const parsed = instanceEndpoint({
      url,
      from: 'a@example.com',
      fromAddress: 'a@example.com',
      fromName: null,
      allowedFromDomains: ['example.com'],
      allowInsecure,
    });
    expect(parsed.endpoint).toMatchObject({ host: 'mail.example.com', port, security });
    expect(parsed.credentials).toEqual(credentials);
  });
});

describe('SendRateLimiter', () => {
  it('lets at most N messages start per second (slots released at once)', async () => {
    let now = 0;
    const slept: number[] = [];
    const limiter = new SendRateLimiter(2, {
      now: () => now,
      sleep: (ms) => {
        slept.push(ms);
        now += ms;
        return Promise.resolve();
      },
    });
    const starts: number[] = [];
    await Promise.all(
      Array.from({ length: 5 }, () =>
        limiter.acquire().then(async (slot) => {
          starts.push(now);
          await slot.release();
        }),
      ),
    );
    expect(starts).toEqual([0, 0, 1000, 1000, 2000]);
    expect(slept).toEqual([1000, 1000]);
  });
});

describe('createValkeyEmailQuota', () => {
  /** Interprets the two scripts like Valkey would, on a Map. */
  function fakeValkey(): QuotaClient & { store: Map<string, number>; ttls: Map<string, number> } {
    const store = new Map<string, number>();
    const ttls = new Map<string, number>();
    return {
      store,
      ttls,
      eval(script, _numKeys, key, ...args) {
        const k = String(key);
        const used = store.get(k) ?? 0;
        if (script.includes('INCR')) {
          if (used >= Number(args[0])) return Promise.resolve([0, used]);
          store.set(k, used + 1);
          if (used === 0) ttls.set(k, Number(args[1]));
          return Promise.resolve([1, used + 1]);
        }
        if (used > 0) store.set(k, used - 1);
        return Promise.resolve(used > 0 ? used - 1 : 0);
      },
      get(key) {
        const value = store.get(key);
        return Promise.resolve(value === undefined ? null : String(value));
      },
    };
  }

  it('allows N per clock hour per key, then tells when to retry', async () => {
    const client = fakeValkey();
    const quota = createValkeyEmailQuota(client, { limit: 2, scope: 'org' });
    const at = new Date('2026-10-05T03:15:00.000Z');
    expect(await quota.take('org_a', at)).toEqual({ allowed: true, used: 1 });
    expect(await quota.take('org_a', at)).toEqual({ allowed: true, used: 2 });
    expect(await quota.take('org_a', at)).toEqual({
      allowed: false,
      used: 2,
      retryAt: new Date('2026-10-05T04:00:00.000Z'),
    });
    expect(await quota.take('org_b', at)).toEqual({ allowed: true, used: 1 });
    // Next hour: a fresh counter.
    expect(await quota.take('org_a', new Date('2026-10-05T04:00:00.000Z'))).toMatchObject({
      allowed: true,
    });
    await quota.release('org_a', at);
    expect(await quota.used('org_a', at)).toEqual({
      used: 1,
      resetsAt: new Date('2026-10-05T04:00:00.000Z'),
    });
    const key = [...client.ttls.keys()][0] ?? '';
    expect(key).toMatch(/^ob:email:quota:org:org_a:\d+$/);
    // Expires one minute after the end of the hour.
    expect(client.ttls.get(key)).toBe(45 * 60_000 + 60_000);
  });
});
