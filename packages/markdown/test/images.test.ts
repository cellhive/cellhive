import { describe, expect, it } from 'vitest';

import {
  collectImages,
  escapeImageAlt,
  imageMarkdown,
  imageSyntaxIssues,
  parseMarkdown,
  parseTemplate,
  substitute,
  toHtml,
  toText,
  unescapeImageAlt,
  type ImageNode,
  type Inline,
} from '../src/index.js';

const ASSET = 'att_0123456789abcDEF';
const FIELD = 'fld_0123456789abcDEF';
const BOTH = ['asset', 'field'] as const;

const image = (
  source: 'asset' | 'field',
  id: string,
  alt: string,
  width: number | null = null,
): ImageNode => ({ type: 'image', source, id, alt, width });

const inlineOf = (source: string, images: readonly ('asset' | 'field')[] = BOTH): Inline[] => {
  const [block] = parseMarkdown(source, { images });
  return block?.type === 'paragraph' ? [...block.children] : [];
};

describe('image syntax (T534)', () => {
  it.each<[string, Inline[]]>([
    [`![Logo](asset:${ASSET})`, [image('asset', ASSET, 'Logo')]],
    [`![ Logo ](asset:${ASSET} =160)`, [image('asset', ASSET, 'Logo', 160)]],
    [`![](field:${FIELD} =9999)`, [image('field', FIELD, '', 600)]],
    [
      `a ![x](asset:${ASSET}) b`,
      [{ type: 'text', text: 'a ' }, image('asset', ASSET, 'x'), { type: 'text', text: ' b' }],
    ],
    // Never a URL, `data:` or `cid:`: the syntax stays a link or text.
    [
      '![x](https://evil.test/p.png)',
      [
        { type: 'text', text: '!' },
        {
          type: 'link',
          href: 'https://evil.test/p.png',
          children: [{ type: 'text', text: 'x' }],
        },
      ],
    ],
    [
      '![x](data:image/png;base64,AAAA)',
      [{ type: 'text', text: '![x](data:image/png;base64,AAAA)' }],
    ],
    [`![x](cid:${ASSET})`, [{ type: 'text', text: `![x](cid:${ASSET})` }]],
    // Wrong prefix for the source.
    [`![x](asset:${FIELD})`, [{ type: 'text', text: `![x](asset:${FIELD})` }]],
  ])('%j', (source, nodes) => {
    expect(inlineOf(source)).toEqual(nodes);
  });

  it('keeps image syntax as text when images are not allowed', () => {
    expect(inlineOf(`![x](asset:${ASSET})`, [])).toEqual([
      { type: 'text', text: `![x](asset:${ASSET})` },
    ]);
    expect(inlineOf(`![x](field:${FIELD})`, ['asset'])).toEqual([
      { type: 'text', text: `![x](field:${FIELD})` },
    ]);
    // A plain document (the web's default) never has images.
    expect(collectImages(parseMarkdown(`![x](asset:${ASSET})`))).toEqual([]);
  });

  it('collects images in source order, nested blocks included', () => {
    const blocks = parseMarkdown(
      `> ![a](asset:${ASSET})\n\n- **![b](field:${FIELD})**\n\n| ![c](asset:${ASSET}) |\n| - |`,
      { images: BOTH },
    );
    expect(collectImages(blocks).map((node) => node.alt)).toEqual(['a', 'b', 'c']);
  });

  it('writes images as [alt] in text', () => {
    const blocks = parseMarkdown(`Hi ![Logo](asset:${ASSET}) ![](asset:${ASSET})`, {
      images: BOTH,
    });
    expect(toText(blocks)).toBe('Hi [Logo] ');
    expect(
      toText(blocks, { images: (node) => (node.alt === '' ? [] : [{ alt: 'A' }, { alt: 'B' }]) }),
    ).toBe('Hi [A] [B] ');
  });

  it('round-trips the Markdown the editors insert', () => {
    const markdown = imageMarkdown({ source: 'asset', id: ASSET, alt: 'Lo[g]o\n', width: 120 });
    expect(markdown).toBe(`![Lo[g\\]o ](asset:${ASSET} =120)`);
    expect(inlineOf(markdown)).toEqual([image('asset', ASSET, 'Lo[g]o', 120)]);
  });

  it.each<[string, string]>([
    ['Ảnh [chính]', String.raw`Ảnh [chính\]`],
    ['C:\\files\\', 'C:\\\\files\\\\'],
    [String.raw`a\]b`, String.raw`a\\\]b`],
    ['two\r\nlines', 'two  lines'],
  ])('escapes `]` and `\\` of the alt text %j', (alt, written) => {
    const markdown = imageMarkdown({ source: 'field', id: FIELD, alt, width: null });
    expect(markdown).toBe(`![${written}](field:${FIELD})`);
    expect(escapeImageAlt(alt)).toBe(written);
    expect(unescapeImageAlt(written)).toBe(alt.replace(/[\r\n]/gu, ' '));
    expect(inlineOf(markdown)).toEqual([
      image('field', FIELD, alt.replace(/[\r\n]/gu, ' ').trim()),
    ]);
    expect(collectImages(parseTemplate(markdown, { images: BOTH }).blocks)).toHaveLength(1);
    expect(imageSyntaxIssues(markdown, BOTH)).toEqual([]);
  });

  it('reads a lone backslash as itself and keeps an unescaped `]` out of the alt', () => {
    expect(inlineOf(String.raw`![a\b](asset:${ASSET})`)).toEqual([
      image('asset', ASSET, String.raw`a\b`),
    ]);
    expect(collectImages(parseMarkdown(`![a]b](asset:${ASSET})`, { images: BOTH }))).toEqual([]);
  });

  it('resolves the escapes of inline text in the alt text, as in templates', () => {
    // The template editors store `\\` for a typed `\` and `\{` for a typed `{`.
    const parsed = parseTemplate(String.raw`![C:\\x \{\{ a \*](field:${FIELD})`, { images: BOTH });
    expect(collectImages(parsed.blocks)).toEqual([image('field', FIELD, String.raw`C:\x {{ a *`)]);
  });

  it('caps the alt text at 200 characters before escaping', () => {
    const markdown = imageMarkdown({
      source: 'asset',
      id: ASSET,
      alt: ']'.repeat(250),
      width: null,
    });
    expect(inlineOf(markdown)).toEqual([image('asset', ASSET, ']'.repeat(200))]);
  });
});

describe('templates with images', () => {
  it('parses literal images and never images from values', () => {
    const parsed = parseTemplate(`![Logo](asset:${ASSET}) {{ [fld_x] }}`, { images: BOTH });
    const blocks = substitute(parsed.blocks, [`![x](asset:${ASSET}) <img src="cid:x@y">`]);
    expect(collectImages(blocks)).toEqual([image('asset', ASSET, 'Logo')]);
    const html = toHtml(blocks, {
      images: (node) => [{ cid: `${node.id}@cellhive`, alt: node.alt, width: null }],
    });
    expect(html.match(/<img /gu)).toHaveLength(1);
    expect(html).toContain('&lt;img src="cid:x@y"&gt;');
  });

  it('keeps an image whose alt or target holds a placeholder as text', () => {
    const alt = parseTemplate(`![{{ [n] }}](asset:${ASSET})`, { images: BOTH });
    expect(collectImages(alt.blocks)).toEqual([]);
    const target = parseTemplate('![x]({{ [url] }})', { images: BOTH });
    expect(collectImages(target.blocks)).toEqual([]);
  });

  it('keeps literal private-use characters of the alt text', () => {
    const parsed = parseTemplate(`![a\uE000b](asset:${ASSET})`, { images: BOTH });
    expect(collectImages(parsed.blocks)).toEqual([image('asset', ASSET, 'a\uE000b')]);
  });
});

describe('imageSyntaxIssues', () => {
  it.each<[string, readonly ('asset' | 'field')[], number[]]>([
    [`![a](asset:${ASSET}) ![b](field:${FIELD} =10)`, BOTH, []],
    ['![a](https://x.test/a.png)', BOTH, [0]],
    ['x ![a](data:image/png;base64,AA)', BOTH, [2]],
    [`![a](cid:${ASSET})`, BOTH, [0]],
    [`![a](field:${FIELD})`, ['asset'], [0]],
    ['\\![a](https://x.test/a.png)', BOTH, []],
    ['[a](https://x.test) !not', BOTH, []],
    [String.raw`![a\]b](https://x.test/a.png)`, BOTH, [0]],
    [String.raw`![a\]b](field:${FIELD})`, BOTH, []],
  ])('%j', (source, allowed, starts) => {
    expect(imageSyntaxIssues(source, allowed).map((issue) => issue.start)).toEqual(starts);
  });
});
