import { describe, expect, it } from 'vitest';

import { addOrigin, embedCode, embedSandbox, embedUrl, pastedLinkUrl } from '../embed';

const TOKEN = 'Ab3xY_' + 'a'.repeat(37);

describe('embedding a share link (T814)', () => {
  it.each([
    ['the full address', `https://ob.test/s/${TOKEN}`, `https://ob.test/s/${TOKEN}`],
    [
      'with spaces and a query',
      `  https://ob.test/s/${TOKEN}?embed=1 `,
      `https://ob.test/s/${TOKEN}`,
    ],
    ['another link', `https://ob.test/s/Zz${'a'.repeat(41)}`, null],
    ['a short token', 'https://ob.test/s/Ab3xY_abc', null],
    ['not an address', 'Ab3xY_', null],
    ['another scheme', `ftp://ob.test/s/${TOKEN}`, null],
  ] as const)('a pasted link: %s', (_name, value, expected) => {
    expect(pastedLinkUrl(value, 'Ab3xY_')).toBe(expected);
  });

  it('frames only the `?embed=1` page', () => {
    expect(embedUrl(`https://ob.test/s/${TOKEN}?x=1#y`)).toBe(`https://ob.test/s/${TOKEN}?embed=1`);
  });

  it('gives an iframe with a title, lazy loading, no referrer and a sandbox', () => {
    const code = embedCode(`https://ob.test/s/${TOKEN}`, 'Sales "Q4" <live>', 'dashboard');
    expect(code).toContain(`src="https://ob.test/s/${TOKEN}?embed=1"`);
    expect(code).toContain('title="Sales &quot;Q4&quot; &lt;live&gt;"');
    expect(code).toContain('loading="lazy"');
    expect(code).toContain('referrerpolicy="no-referrer"');
    expect(code).toContain(`sandbox="${embedSandbox('dashboard')}"`);
    expect(code).toContain('allow="fullscreen"');
    expect(code.endsWith('</iframe>')).toBe(true);
  });

  it.each([
    [
      'view',
      'allow-scripts allow-same-origin allow-downloads allow-popups allow-popups-to-escape-sandbox',
    ],
    [
      'form',
      'allow-scripts allow-same-origin allow-forms allow-downloads allow-popups allow-popups-to-escape-sandbox',
    ],
    [
      'dashboard',
      'allow-scripts allow-same-origin allow-downloads allow-popups allow-popups-to-escape-sandbox',
    ],
  ] as const)('the sandbox suggested for a %s link', (target, expected) => {
    expect(embedCode(`https://ob.test/s/${TOKEN}`, 'x', target)).toContain(`sandbox="${expected}"`);
    expect(embedSandbox(target)).not.toContain('allow-top-navigation');
  });

  it.each([
    ['a site', 'https://Intranet.Example.com', [], { origin: 'https://intranet.example.com' }],
    ['the default port dropped', 'https://a.example:443', [], { origin: 'https://a.example' }],
    ['a path', 'https://a.example/page', [], { problem: 'invalid' }],
    ['plain http', 'http://a.example', [], { problem: 'invalid' }],
    ['local http', 'http://localhost:5173', [], { origin: 'http://localhost:5173' }],
    ['twice', 'https://a.example', ['https://a.example'], { problem: 'duplicate' }],
    [
      'over the limit',
      'https://b.example',
      Array.from({ length: 20 }, (_, index) => `https://s${String(index)}.example`),
      { problem: 'tooMany' },
    ],
  ] as const)('an allowed origin: %s', (_name, value, current, expected) => {
    expect(addOrigin(value, current)).toEqual(expected);
  });
});
