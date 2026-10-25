import {
  DEFAULT_EMAIL_STYLES,
  parseMarkdown,
  parseTemplate,
  substitute,
  toHtml,
  type HtmlStyles,
} from '@cellhive/markdown';
import { describe, expect, it } from 'vitest';

// The fuzz corpus of the renderer, so both layers are checked on the same inputs.
import { HOSTILE_VALUES, randomSource, seededRandom } from '../../../markdown/test/fixtures.js';
import { sanitizeEmailHtml } from '../../src/mail/render/sanitize.js';

const RUNS = 10_000;
const TIMEOUT = 120_000;

const FIXTURES: readonly string[] = [
  '',
  'Hello **world**, *it* _it_ ~~del~~ `code < 1`',
  '# H1\n## H2\n### H3\n\npara\nline',
  '- a\n- **b**\n\n1. one\n2. [two](https://a.test/?x=1&y="2")',
  '> quote\n> > nested\n\n---\n\n```\n<b>raw</b> & "q"\n```',
  '| A | B | C |\n| :- | :-: | -: |\n| 1 | [m](mailto:a@b.test) | `3` |\n| x |',
  "<script>alert(1)</script> <img src=x onerror=alert(1)> it's",
  'Tiếng Việt có dấu 😀🇻🇳 — “quotes” & ampersand',
];

describe('sanitizeEmailHtml', () => {
  it.each(FIXTURES)('leaves the renderer output unchanged: %j', (source) => {
    const html = toHtml(parseMarkdown(source));
    expect(sanitizeEmailHtml(html)).toBe(html);
  });

  it(
    'leaves the renderer output unchanged on the fuzz corpus',
    () => {
      const random = seededRandom(5291);
      const changed: string[] = [];
      for (let run = 0; run < RUNS; run += 1) {
        const template = parseTemplate(randomSource(random, true));
        const blocks = substitute(
          template.blocks,
          () => HOSTILE_VALUES[Math.floor(random() * HOSTILE_VALUES.length)] ?? '',
        );
        const html = toHtml(blocks);
        if (sanitizeEmailHtml(html) !== html) changed.push(html);
      }
      expect(changed.slice(0, 5)).toEqual([]);
    },
    TIMEOUT,
  );

  it('keeps unstyled output unchanged', () => {
    const unstyled = Object.fromEntries(
      Object.keys(DEFAULT_EMAIL_STYLES).map((key) => [key, '']),
    ) as unknown as HtmlStyles;
    const html = toHtml(parseMarkdown(FIXTURES.join('\n\n')), { styles: unstyled });
    expect(sanitizeEmailHtml(html)).toBe(html);
  });

  it.each<[string, string]>([
    ['<p onclick="x()">a</p>', '<p>a</p>'],
    ['<script>alert(1)</script><p>a</p>', '<p>a</p>'],
    ['<style>p{}</style><p>a</p>', '<p>a</p>'],
    ['<img src="https://evil.test/pixel.gif" />', ''],
    ['<iframe src="https://evil.test"></iframe>', ''],
    ['<a href="javascript:alert(1)">x</a>', '<a>x</a>'],
    ['<a href="data:text/html,x">x</a>', '<a>x</a>'],
    ['<a href="//evil.test">x</a>', '<a>x</a>'],
    // A value outside the list empties the attribute (sanitize-html keeps the bare name).
    [
      '<a href="https://a.test" target="_top" rel="opener">x</a>',
      '<a href="https://a.test" target rel>x</a>',
    ],
    ['<p style="background-image:url(https://evil.test/x)">a</p>', '<p>a</p>'],
    ['<p style="color:red;margin:0">a</p>', '<p style="margin:0">a</p>'],
    ['<p class="x" id="y">a</p>', '<p>a</p>'],
    ['<form><input name="p" /></form><p>a</p>', '<p>a</p>'],
    ['<base href="https://evil.test" /><meta http-equiv="refresh" /><p>a</p>', '<p>a</p>'],
    ['<svg onload="x()"><circle /></svg><math></math>', ''],
    // T534: an image only with a cid: source, alt and a pixel width.
    ['<img src="data:image/png;base64,AAAA" />', ''],
    ['<img src="cid:att_x@cellhive" onerror="x()" />', '<img src="cid:att_x@cellhive" />'],
    ['<img src="cid:att_x@cellhive" width="100%" />', ''],
    ['<img src="cid:att_x@cellhive" width="9999" />', ''],
    ['<img src="cid:not a cid" />', ''],
    ['<img alt="x" />', ''],
    ['<img src="CID:att_x@cellhive" />', ''],
    [
      '<img src="cid:att_x@cellhive" alt="Logo" width="120" style="max-width:100%;position:fixed" />',
      '<img src="cid:att_x@cellhive" alt="Logo" width="120" style="max-width:100%" />',
    ],
  ])('removes %j', (html, expected) => {
    expect(sanitizeEmailHtml(html)).toBe(expected);
  });

  it('leaves the renderer images unchanged (cid, alt, width, style)', () => {
    const blocks = parseMarkdown('Logo ![Acme "Co" <b>](asset:att_0123456789abcDEF =120) end', {
      images: ['asset'],
    });
    const html = toHtml(blocks, {
      images: (node) => [{ cid: `${node.id}@cellhive`, alt: node.alt, width: node.width }],
    });
    expect(html).toContain('<img src="cid:att_0123456789abcDEF@cellhive"');
    expect(sanitizeEmailHtml(html)).toBe(html);
  });
});
