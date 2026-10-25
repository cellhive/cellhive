import { describe, expect, it } from 'vitest';

import { parseInline, parseMarkdown, safeHref, type Block, type Inline } from '../src/index.js';

const text = (value: string): Inline => ({ type: 'text', text: value });
const paragraph = (...children: Inline[]): Block => ({ type: 'paragraph', children });

describe('parseMarkdown', () => {
  // The cases the web parser had before T529 (apps/web/src/lib/markdown): unchanged.
  it.each<[string, Block[]]>([
    ['', []],
    ['   \n\n  ', []],
    ['Hello', [paragraph(text('Hello'))]],
    ['a\nb', [paragraph(text('a'), { type: 'break' }, text('b'))]],
    [
      'a\r\nb\rc',
      [paragraph(text('a'), { type: 'break' }, text('b'), { type: 'break' }, text('c'))],
    ],
    ['a\n\nb', [paragraph(text('a')), paragraph(text('b'))]],
    ['## Title', [{ type: 'heading', level: 2, children: [text('Title')] }]],
    ['# One', [{ type: 'heading', level: 1, children: [text('One')] }]],
    ['### Three', [{ type: 'heading', level: 3, children: [text('Three')] }]],
    ['#### Four', [paragraph(text('#### Four'))]],
    ['#NoSpace', [paragraph(text('#NoSpace'))]],
    [
      '- one\n- two\n\n1. first',
      [
        { type: 'list', ordered: false, items: [[text('one')], [text('two')]] },
        { type: 'list', ordered: true, items: [[text('first')]] },
      ],
    ],
    [
      '* a\n2) b',
      [
        { type: 'list', ordered: false, items: [[text('a')]] },
        { type: 'list', ordered: true, items: [[text('b')]] },
      ],
    ],
    [
      'intro\n- item\nafter',
      [
        paragraph(text('intro')),
        { type: 'list', ordered: false, items: [[text('item')]] },
        paragraph(text('after')),
      ],
    ],
  ])('%j', (source, blocks) => {
    expect(parseMarkdown(source)).toEqual(blocks);
  });

  // T529: the syntax added for email bodies.
  it.each<[string, Block[]]>([
    ['---', [{ type: 'hr' }]],
    ['***', [{ type: 'hr' }]],
    ['_ _ _', [{ type: 'hr' }]],
    ['a\n---\nb', [paragraph(text('a')), { type: 'hr' }, paragraph(text('b'))]],
    ['--', [paragraph(text('--'))]],
    ['> quoted', [{ type: 'blockquote', children: [paragraph(text('quoted'))] }]],
    [
      '> a\n> b\n>\n> - c',
      [
        {
          type: 'blockquote',
          children: [
            paragraph(text('a'), { type: 'break' }, text('b')),
            { type: 'list', ordered: false, items: [[text('c')]] },
          ],
        },
      ],
    ],
    [
      '> > nested',
      [
        {
          type: 'blockquote',
          children: [{ type: 'blockquote', children: [paragraph(text('nested'))] }],
        },
      ],
    ],
    [
      '> > > > deep',
      [
        {
          type: 'blockquote',
          children: [
            {
              type: 'blockquote',
              children: [{ type: 'blockquote', children: [paragraph(text('> deep'))] }],
            },
          ],
        },
      ],
    ],
    [
      '```\nconst a = 1 < 2;\n\n**not bold**\n```',
      [{ type: 'code_block', children: [text('const a = 1 < 2;\n\n**not bold**')] }],
    ],
    ['```ts\nx\n```', [{ type: 'code_block', children: [text('x')] }]],
    [
      '```\nunclosed\n- still code',
      [{ type: 'code_block', children: [text('unclosed\n- still code')] }],
    ],
    ['```\n```', [{ type: 'code_block', children: [] }]],
    ['~~~\na\n~~~', [{ type: 'code_block', children: [text('a')] }]],
    [
      '| A | B |\n| --- | :-: |\n| 1 | **2** |\n| 3 |',
      [
        {
          type: 'table',
          align: [null, 'center'],
          head: [[text('A')], [text('B')]],
          rows: [
            [[text('1')], [{ type: 'strong', children: [text('2')] }]],
            [[text('3')], []],
          ],
        },
      ],
    ],
    [
      'A | B\n:-- | --:\nx \\| y | z | extra',
      [
        {
          type: 'table',
          align: ['left', 'right'],
          head: [[text('A')], [text('B')]],
          rows: [[[text('x | y')], [text('z')]]],
        },
      ],
    ],
    [
      'intro\n| A |\n| - |\n| 1 |\n\nafter',
      [
        paragraph(text('intro')),
        { type: 'table', align: [null], head: [[text('A')]], rows: [[[text('1')]]] },
        paragraph(text('after')),
      ],
    ],
    ['| A | B |\n| --- |', [paragraph(text('| A | B |'), { type: 'break' }, text('| --- |'))]],
    ['a | b', [paragraph(text('a | b'))]],
  ])('extended %j', (source, blocks) => {
    expect(parseMarkdown(source)).toEqual(blocks);
  });

  it.each<[string, Inline[]]>([
    ['**bold**', [{ type: 'strong', children: [text('bold')] }]],
    [
      '*it* _it_',
      [{ type: 'em', children: [text('it')] }, text(' '), { type: 'em', children: [text('it')] }],
    ],
    ['`x < y`', [{ type: 'code', text: 'x < y' }]],
    [
      '[site](https://a.test)',
      [{ type: 'link', href: 'https://a.test', children: [text('site')] }],
    ],
    ['[bad](javascript:alert(1))', [text('[bad](javascript:alert(1))')]],
    ['[bad](data:text/html,x)', [text('[bad](data:text/html,x)')]],
    ['2 * 3', [text('2 * 3')]],
    ['\\*not\\*', [text('*not*')]],
    ['~~gone~~', [{ type: 'del', children: [text('gone')] }]],
    ['~~~~', [text('~~~~')]],
    ['a ~ b', [text('a ~ b')]],
    ['\\~\\~x\\~\\~ \\| \\> \\{', [text('~~x~~ | > {')]],
    [
      '**bold _and it_**',
      [{ type: 'strong', children: [text('bold '), { type: 'em', children: [text('and it')] }] }],
    ],
    [
      '[**b**](mailto:a@b.test)',
      [
        {
          type: 'link',
          href: 'mailto:a@b.test',
          children: [{ type: 'strong', children: [text('b')] }],
        },
      ],
    ],
    ['<script>alert(1)</script>', [text('<script>alert(1)</script>')]],
    ['<img src=x onerror=alert(1)>', [text('<img src=x onerror=alert(1)>')]],
    [
      'Xin chào **Việt Nam** 🇻🇳',
      [text('Xin chào '), { type: 'strong', children: [text('Việt Nam')] }, text(' 🇻🇳')],
    ],
    ['😀 `😀`', [text('😀 '), { type: 'code', text: '😀' }]],
    ['**unclosed', [text('**unclosed')]],
    ['[no link]', [text('[no link]')]],
  ])('inline %j', (source, nodes) => {
    expect(parseInline(source)).toEqual(nodes);
  });

  it('closes at the first closing delimiter', () => {
    expect(parseInline('**a *b ~~c **d** e~~ f* g**')).toEqual([
      { type: 'strong', children: [text('a *b ~~c ')] },
      text('d'),
      { type: 'strong', children: [text(' e~~ f* g')] },
    ]);
  });

  it('caps inline nesting at four levels', () => {
    expect(parseInline('**_~~[*y*](https://a.test)~~_**')).toEqual([
      {
        type: 'strong',
        children: [
          {
            type: 'em',
            children: [
              {
                type: 'del',
                children: [{ type: 'link', href: 'https://a.test', children: [text('*y*')] }],
              },
            ],
          },
        ],
      },
    ]);
  });

  it.each<[string, string | null]>([
    ['https://a.test', 'https://a.test'],
    ['http://a.test/x?y=1', 'http://a.test/x?y=1'],
    ['  https://a.test  ', 'https://a.test'],
    ['mailto:a@b.test', 'mailto:a@b.test'],
    ['MAILTO:a@b.test', 'MAILTO:a@b.test'],
    ['javascript:alert(1)', null],
    ['JaVaScRiPt:alert(1)', null],
    ['data:text/html,x', null],
    ['vbscript:x', null],
    ['ftp://a.test', null],
    ['/relative', null],
    ['//a.test', null],
    ['', null],
  ])('safeHref(%j)', (url, expected) => {
    expect(safeHref(url)).toBe(expected);
  });
});
