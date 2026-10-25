import { describe, expect, it } from 'vitest';

import {
  MAX_PLACEHOLDERS,
  parseTemplate,
  substitute,
  type Block,
  type Inline,
  type PlaceholderNode,
  type TemplateBlock,
  type TemplateIssue,
} from '../src/index.js';

const text = (value: string): Inline => ({ type: 'text', text: value });
const paragraph = (...children: Inline[]): Block => ({ type: 'paragraph', children });
const ph = (
  index: number,
  expression: string,
  start: number,
  length: number,
  code = false,
): PlaceholderNode => ({ type: 'placeholder', index, expression, start, length, code });

describe('parseTemplate', () => {
  it.each<[string, TemplateBlock[], PlaceholderNode[]]>([
    ['Hello', [{ type: 'paragraph', children: [text('Hello')] }], []],
    [
      'Hi {{ [Name] }}!',
      [{ type: 'paragraph', children: [text('Hi '), ph(0, '[Name]', 3, 12), text('!')] }],
      [ph(0, '[Name]', 3, 12)],
    ],
    [
      '{{a}}{{b}}',
      [{ type: 'paragraph', children: [ph(0, 'a', 0, 5), ph(1, 'b', 5, 5)] }],
      [ph(0, 'a', 0, 5), ph(1, 'b', 5, 5)],
    ],
    [
      // `}}` inside a string literal or a `[name]` does not close the placeholder.
      '{{ "}}" & [a}}b] }}',
      [{ type: 'paragraph', children: [ph(0, '"}}" & [a}}b]', 0, 19)] }],
      [ph(0, '"}}" & [a}}b]', 0, 19)],
    ],
    [
      '{{ "say \\"}}\\"" }}',
      [{ type: 'paragraph', children: [ph(0, '"say \\"}}\\""', 0, 18)] }],
      [ph(0, '"say \\"}}\\""', 0, 18)],
    ],
    [
      // A multi-line expression is one placeholder; it does not split the paragraph.
      'a {{ IF(x,\n\n"y") }} b',
      [{ type: 'paragraph', children: [text('a '), ph(0, 'IF(x,\n\n"y")', 2, 17), text(' b')] }],
      [ph(0, 'IF(x,\n\n"y")', 2, 17)],
    ],
    [
      '**{{ x }}** and *{{y}}*',
      [
        {
          type: 'paragraph',
          children: [
            { type: 'strong', children: [ph(0, 'x', 2, 7)] },
            text(' and '),
            { type: 'em', children: [ph(1, 'y', 17, 5)] },
          ],
        },
      ],
      [ph(0, 'x', 2, 7), ph(1, 'y', 17, 5)],
    ],
    [
      // Expression characters never reach the Markdown parser.
      '{{ [a*b] * 2 }} {{ "[x](https://a.test)" }}',
      [
        {
          type: 'paragraph',
          children: [ph(0, '[a*b] * 2', 0, 15), text(' '), ph(1, '"[x](https://a.test)"', 16, 27)],
        },
      ],
      [ph(0, '[a*b] * 2', 0, 15), ph(1, '"[x](https://a.test)"', 16, 27)],
    ],
    [
      '`id {{ x }}`',
      [{ type: 'paragraph', children: [{ type: 'code', text: 'id ' }, ph(0, 'x', 4, 7, true)] }],
      [ph(0, 'x', 4, 7, true)],
    ],
    [
      '```\nA {{x}}\n```',
      [{ type: 'code_block', children: [text('A '), ph(0, 'x', 6, 5)] }],
      [ph(0, 'x', 6, 5)],
    ],
    [
      '# {{ t }}\n- {{ a }}\n> {{ q }}\n\n| {{ h }} |\n| - |\n| {{ c }} |',
      [
        { type: 'heading', level: 1, children: [ph(0, 't', 2, 7)] },
        { type: 'list', ordered: false, items: [[ph(1, 'a', 12, 7)]] },
        { type: 'blockquote', children: [{ type: 'paragraph', children: [ph(2, 'q', 22, 7)] }] },
        {
          type: 'table',
          align: [null],
          head: [[ph(3, 'h', 33, 7)]],
          rows: [[[ph(4, 'c', 51, 7)]]],
        },
      ],
      [
        ph(0, 't', 2, 7),
        ph(1, 'a', 12, 7),
        ph(2, 'q', 22, 7),
        ph(3, 'h', 33, 7),
        ph(4, 'c', 51, 7),
      ],
    ],
    [
      // Escaped braces are literal text.
      '\\{{ x }}',
      [{ type: 'paragraph', children: [text('{{ x }}')] }],
      [],
    ],
    [
      // Private-use characters in the source survive unchanged.
      ' {{x}} ',
      [{ type: 'paragraph', children: [text(' '), ph(0, 'x', 2, 5), text(' ')] }],
      [ph(0, 'x', 2, 5)],
    ],
  ])('%j', (source, blocks, placeholders) => {
    const result = parseTemplate(source);
    expect(result.blocks).toEqual(blocks);
    expect(result.placeholders).toEqual(placeholders);
    expect(result.issues).toEqual([]);
  });

  it.each<[string, TemplateBlock[], TemplateIssue[]]>([
    [
      'a {{ b',
      [{ type: 'paragraph', children: [text('a {{ b')] }],
      [{ code: 'UNTERMINATED_PLACEHOLDER', start: 2, length: 4 }],
    ],
    [
      'a {{ "}} }}',
      [{ type: 'paragraph', children: [text('a {{ "}} }}')] }],
      [{ code: 'UNTERMINATED_PLACEHOLDER', start: 2, length: 9 }],
    ],
    [
      'x {{  }} y',
      [{ type: 'paragraph', children: [text('x {{  }} y')] }],
      [{ code: 'EMPTY_PLACEHOLDER', start: 2, length: 6 }],
    ],
  ])('issue %j', (source, blocks, issues) => {
    const result = parseTemplate(source);
    expect(result.blocks).toEqual(blocks);
    expect(result.placeholders).toEqual([]);
    expect(result.issues).toEqual(issues);
  });

  describe('placeholders in link targets', () => {
    it.each<[string, TemplateBlock[]]>([
      [
        '[Open](https://app.test/r/{{ RECORD_ID() }}?tab={{ t }})',
        [
          {
            type: 'paragraph',
            children: [
              {
                type: 'link_template',
                href: [
                  'https://app.test/r/',
                  ph(0, 'RECORD_ID()', 26, 17),
                  '?tab=',
                  ph(1, 't', 48, 7),
                ],
                children: [text('Open')],
              },
            ],
          },
        ],
      ],
      [
        '[Mail](mailto:{{ e }})',
        [
          {
            type: 'paragraph',
            children: [
              {
                type: 'link_template',
                href: ['mailto:', ph(0, 'e', 14, 7)],
                children: [text('Mail')],
              },
            ],
          },
        ],
      ],
      [
        // A whole URL from a field: becomes a link only if `safeHref` accepts the value.
        '[{{ n }}]({{ [Website] }})',
        [
          {
            type: 'paragraph',
            children: [
              {
                type: 'link_template',
                href: [ph(1, '[Website]', 10, 15)],
                children: [ph(0, 'n', 1, 7)],
              },
            ],
          },
        ],
      ],
    ])('%j', (source, blocks) => {
      const result = parseTemplate(source);
      expect(result.blocks).toEqual(blocks);
      expect(result.issues).toEqual([]);
    });

    it.each<[string, number, number]>([
      // Placeholder in the scheme or host, or after a scheme other than https/mailto.
      ['[x]({{ u }}/path)', 4, 7],
      ['[x](https://{{ h }}/p)', 12, 7],
      ['[x](https://a.test{{ p }})', 18, 7],
      ['[x](http://a.test/{{ p }})', 18, 7],
      ['[x](javascript:{{ p }})', 15, 7],
      ['[x](https{{ p }}://a.test/)', 9, 7],
    ])('rejects %j and keeps it as text', (source, start, length) => {
      const result = parseTemplate(source);
      expect(result.issues).toEqual([{ code: 'PLACEHOLDER_IN_LINK_NOT_ALLOWED', start, length }]);
      const [block] = result.blocks;
      expect(block?.type).toBe('paragraph');
      const children = block?.type === 'paragraph' ? block.children : [];
      expect(children.some((node) => node.type === 'link' || node.type === 'link_template')).toBe(
        false,
      );
      expect(children.filter((node) => node.type === 'placeholder')).toHaveLength(1);
    });
  });

  it('caps the number of placeholders', () => {
    const result = parseTemplate('{{x}}'.repeat(MAX_PLACEHOLDERS + 1));
    expect(result.placeholders).toHaveLength(MAX_PLACEHOLDERS);
    expect(result.issues).toEqual([
      { code: 'TOO_MANY_PLACEHOLDERS', start: MAX_PLACEHOLDERS * 5, length: 5 },
    ]);
  });
});

describe('substitute', () => {
  it.each<[string, readonly string[], Block[]]>([
    ['Hi {{ n }}!', ['Lan'], [paragraph(text('Hi Lan!'))]],
    [
      // Values are text: Markdown, HTML and links inside them stay characters.
      '{{a}}',
      ['**b** [x](https://evil.test) <script>alert(1)</script> | ~~'],
      [paragraph(text('**b** [x](https://evil.test) <script>alert(1)</script> | ~~'))],
    ],
    [
      '- {{a}}',
      ['# not a heading\n- not an item'],
      [
        {
          type: 'list',
          ordered: false,
          items: [[text('# not a heading'), { type: 'break' }, text('- not an item')]],
        },
      ],
    ],
    [
      '{{a}}',
      ['line1\r\nline2\rline3'],
      [
        paragraph(
          text('line1'),
          { type: 'break' },
          text('line2'),
          { type: 'break' },
          text('line3'),
        ),
      ],
    ],
    ['{{a}}', ['nul\u0000 bell\u0007 tab\t'], [paragraph(text('nul bell tab\t'))]],
    ['{{a}}', [''], []],
    ['x{{a}}', [''], [paragraph(text('x'))]],
    [
      '**{{a}}**',
      ['Đơn hàng 😀'],
      [paragraph({ type: 'strong', children: [text('Đơn hàng 😀')] })],
    ],
    [
      '`a {{x}}` `{{y}}`',
      ['b', '`c`'],
      [paragraph({ type: 'code', text: 'a b' }, text(' '), { type: 'code', text: '`c`' })],
    ],
    ['```\n{{x}}\n```', ['<b>\n**x**'], [{ type: 'code_block', children: [text('<b>\n**x**')] }]],
    [
      '| {{a}} |\n| - |\n| {{b}} |',
      ['x | y', 'z\nw'],
      [
        {
          type: 'table',
          align: [null],
          head: [[text('x | y')]],
          rows: [[[text('z'), { type: 'break' }, text('w')]]],
        },
      ],
    ],
    [
      '[Open](https://app.test/r/{{ id }}?q={{ q }})',
      ['rec 1/2', 'a&b=c#d'],
      [
        paragraph({
          type: 'link',
          href: 'https://app.test/r/rec%201%2F2?q=a%26b%3Dc%23d',
          children: [text('Open')],
        }),
      ],
    ],
    [
      '[Mail](mailto:{{ e }})',
      ['a@b.test'],
      [paragraph({ type: 'link', href: 'mailto:a%40b.test', children: [text('Mail')] })],
    ],
    [
      '[Site]({{ u }})',
      ['https://ok.test/p?x=1'],
      [paragraph({ type: 'link', href: 'https://ok.test/p?x=1', children: [text('Site')] })],
    ],
    ['[Site]({{ u }})', ['javascript:alert(1)'], [paragraph(text('Site'))]],
    ['[Site]({{ u }})', ['data:text/html,<script>'], [paragraph(text('Site'))]],
    ['[Site]({{ u }})', ['not a url'], [paragraph(text('Site'))]],
    [
      '[{{ n }}]({{ u }})',
      ['<b>', ' https://ok.test '],
      [paragraph({ type: 'link', href: 'https://ok.test', children: [text('<b>')] })],
    ],
    [
      '[x](https://a.test/{{ p }})',
      ['\uD800 lone'],
      [paragraph({ type: 'link', href: 'https://a.test/%EF%BF%BD%20lone', children: [text('x')] })],
    ],
  ])('%j with %j', (source, values, blocks) => {
    const template = parseTemplate(source);
    expect(substitute(template.blocks, values)).toEqual(blocks);
  });

  it('takes a function of the placeholder', () => {
    const template = parseTemplate('{{ a }} {{ b }}');
    expect(
      substitute(template.blocks, (placeholder) => placeholder.expression.toUpperCase()),
    ).toEqual([paragraph(text('A B'))]);
  });

  it('treats a missing value as empty', () => {
    expect(substitute(parseTemplate('a{{x}}b').blocks, [])).toEqual([paragraph(text('ab'))]);
  });
});
