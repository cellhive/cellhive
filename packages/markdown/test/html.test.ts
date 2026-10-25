import { describe, expect, it } from 'vitest';

import {
  DEFAULT_EMAIL_STYLES,
  DEFAULT_IMAGE_STYLE,
  escapeHtml,
  HTML_ALLOWED_STYLES,
  HTML_ALLOWED_TAGS,
  parseMarkdown,
  parseTemplate,
  substitute,
  toHtml,
  utf8ByteLength,
  type HtmlStyles,
} from '../src/index.js';

/** Every element unstyled, to test the markup alone. */
const UNSTYLED = Object.fromEntries(
  Object.keys(DEFAULT_EMAIL_STYLES).map((key) => [key, '']),
) as unknown as HtmlStyles;

const plain = (source: string) => toHtml(parseMarkdown(source), { styles: UNSTYLED });

describe('toHtml', () => {
  it.each<[string, string]>([
    ['', ''],
    ['Hello', '<p>Hello</p>'],
    ['a\nb', '<p>a<br />b</p>'],
    ['# H1\n## H2\n### H3', '<h1>H1</h1><h2>H2</h2><h3>H3</h3>'],
    ['**b** *i* ~~d~~ `c`', '<p><strong>b</strong> <em>i</em> <del>d</del> <code>c</code></p>'],
    [
      '[docs](https://a.test/?a=1&b="2")',
      '<p><a href="https://a.test/?a=1&amp;b=&quot;2&quot;" rel="noopener noreferrer" target="_blank">docs</a></p>',
    ],
    ['- a\n- b', '<ul><li>a</li><li>b</li></ul>'],
    ['1. a\n2. b', '<ol><li>a</li><li>b</li></ol>'],
    ['> q', '<blockquote><p>q</p></blockquote>'],
    ['---', '<hr />'],
    ['```\n<b> & "x"\n```', '<pre><code>&lt;b&gt; &amp; "x"</code></pre>'],
    [
      '| A | B |\n| :-: | --: |\n| 1 | 2 |',
      '<table><thead><tr><th style="text-align:center">A</th><th style="text-align:right">B</th></tr></thead><tbody><tr><td style="text-align:center">1</td><td style="text-align:right">2</td></tr></tbody></table>',
    ],
    ['| A |\n| - |', '<table><thead><tr><th>A</th></tr></thead></table>'],
    [
      '<script>alert(1)</script> <img src=x onerror=alert(1)>',
      '<p>&lt;script&gt;alert(1)&lt;/script&gt; &lt;img src=x onerror=alert(1)&gt;</p>',
    ],
    ['it\'s "quoted"', '<p>it\'s "quoted"</p>'],
    ['Tiếng Việt 🇻🇳', '<p>Tiếng Việt 🇻🇳</p>'],
  ])('%j', (source, html) => {
    expect(plain(source)).toBe(html);
  });

  it('adds the layout styles inline', () => {
    const html = toHtml(parseMarkdown('Hi [a](https://a.test)\n\n| A |\n| :- |\n| 1 |'));
    expect(html).toBe(
      `<p style="${DEFAULT_EMAIL_STYLES.p}">Hi <a href="https://a.test" rel="noopener noreferrer" target="_blank" style="${DEFAULT_EMAIL_STYLES.a}">a</a></p>` +
        `<table style="${DEFAULT_EMAIL_STYLES.table}"><thead><tr><th style="${DEFAULT_EMAIL_STYLES.th};text-align:left">A</th></tr></thead>` +
        `<tbody><tr><td style="${DEFAULT_EMAIL_STYLES.td};text-align:left">1</td></tr></tbody></table>`,
    );
  });

  it('only uses allowlisted CSS in the default styles', () => {
    for (const style of Object.values(DEFAULT_EMAIL_STYLES) as string[]) {
      for (const declaration of style.split(';')) {
        const [property = '', ...rest] = declaration.split(':');
        const value = rest.join(':');
        expect(HTML_ALLOWED_STYLES[property]?.some((pattern) => pattern.test(value))).toBe(true);
      }
    }
  });

  it('only emits allowlisted tags', () => {
    expect([...HTML_ALLOWED_TAGS].sort()).toEqual(
      [
        'a',
        'blockquote',
        'br',
        'code',
        'del',
        'em',
        'h1',
        'h2',
        'h3',
        'hr',
        'li',
        'ol',
        'p',
        'pre',
        'strong',
        'table',
        'tbody',
        'td',
        'th',
        'thead',
        'tr',
        'ul',
        'img',
      ].sort(),
    );
  });

  describe('images (T534)', () => {
    const doc = (source: string) => parseMarkdown(source, { images: ['asset', 'field'] });
    const ASSET = 'att_0123456789abcDEF';
    const FIELD = 'fld_0123456789abcDEF';

    it('renders only resolved cid images, with alt and width', () => {
      const html = toHtml(doc(`Logo ![Acme "Co"](asset:${ASSET} =160) and ![x](field:${FIELD})`), {
        styles: UNSTYLED,
        images: (node) =>
          node.source === 'asset'
            ? [{ cid: `${node.id}@cellhive`, alt: node.alt, width: node.width }]
            : [
                { cid: 'att_a@cellhive', alt: 'x', width: null },
                { cid: 'att_b@cellhive', alt: 'x', width: 900 },
              ],
      });
      expect(html).toBe(
        `<p>Logo <img src="cid:${ASSET}@cellhive" alt="Acme &quot;Co&quot;" width="160" /> and ` +
          '<img src="cid:att_a@cellhive" alt="x" /><img src="cid:att_b@cellhive" alt="x" width="600" /></p>',
      );
    });

    it('leaves images out without a resolver or with an invalid Content-ID', () => {
      expect(toHtml(doc(`![a](asset:${ASSET})`), { styles: UNSTYLED })).toBe('<p></p>');
      const html = toHtml(doc(`![a](asset:${ASSET})`), {
        styles: UNSTYLED,
        images: () => [
          { cid: 'https://evil.test/x.png', alt: 'a', width: null },
          { cid: '"><script>@x', alt: 'a', width: null },
        ],
      });
      expect(html).toBe('<p></p>');
    });

    it('styles images with the default email style', () => {
      const html = toHtml(doc(`![a](asset:${ASSET})`), {
        images: (node) => [{ cid: `${node.id}@cellhive`, alt: 'a', width: null }],
      });
      expect(html).toContain(`style="${DEFAULT_IMAGE_STYLE}"`);
    });
  });

  it('renders substituted values as text', () => {
    const template = parseTemplate('Hello **{{ n }}**, see [ticket](https://a.test/t/{{ id }})');
    const html = toHtml(
      substitute(template.blocks, ['<img src=x onerror=alert(1)> [x](javascript:1)', '"><b>']),
      { styles: UNSTYLED },
    );
    expect(html).toBe(
      '<p>Hello <strong>&lt;img src=x onerror=alert(1)&gt; [x](javascript:1)</strong>, see ' +
        '<a href="https://a.test/t/%22%3E%3Cb%3E" rel="noopener noreferrer" target="_blank">ticket</a></p>',
    );
  });
});

describe('escapeHtml', () => {
  it.each<[string, string]>([
    ['a & b < c > d', 'a &amp; b &lt; c &gt; d'],
    ['"\'', '"\''],
    ['ctrl\u0000\u0001\u001f\u007f end', 'ctrl end'],
    ['keep\ttab\nnewline', 'keep\ttab\nnewline'],
    ['lone \uD800 surrogate \uDC00', 'lone � surrogate �'],
    ['😀', '😀'],
  ])('%j', (value, escaped) => {
    expect(escapeHtml(value)).toBe(escaped);
  });
});

describe('utf8ByteLength', () => {
  it.each<[string, number]>([
    ['', 0],
    ['abc', 3],
    ['Việt', 6],
    ['😀', 4],
    ['\uD800', 3],
    ['ß€😀a', 2 + 3 + 4 + 1],
  ])('%j', (value, bytes) => {
    expect(utf8ByteLength(value)).toBe(bytes);
  });
});
