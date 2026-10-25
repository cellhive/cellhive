import { describe, expect, it } from 'vitest';

import { parseMarkdown, parseTemplate, substitute, toText } from '../src/index.js';

describe('toText', () => {
  it.each<[string, string]>([
    ['', ''],
    ['Hello', 'Hello'],
    ['a\nb\n\nc', 'a\nb\n\nc'],
    ['# Title\nbody', 'Title\n\nbody'],
    ['**b** *i* ~~d~~ `c`', 'b i d c'],
    ['[docs](https://a.test)', 'docs (https://a.test)'],
    ['[https://a.test](https://a.test)', 'https://a.test'],
    ['[a@b.test](mailto:a@b.test)', 'a@b.test'],
    ['- a\n- b', '- a\n- b'],
    ['1. a\n1. b\n1. c', '1. a\n2. b\n3. c'],
    ['- a\nnext\nline', '- a\n\nnext\nline'],
    ['> q\n> r\n>\n> s', '> q\n> r\n>\n> s'],
    ['---', '----------'],
    ['```\n  code\n  indented\n```', '  code\n  indented'],
    ['| A | B |\n| - | - |\n| 1 | **2** |', 'A | B\n1 | 2'],
    ['<script>x</script>', '<script>x</script>'],
    ['Tiếng Việt 🇻🇳', 'Tiếng Việt 🇻🇳'],
  ])('%j', (source, expected) => {
    expect(toText(parseMarkdown(source))).toBe(expected);
  });

  it('renders substituted values as they are', () => {
    const template = parseTemplate('Hi {{ n }}, [open](https://a.test/{{ id }})');
    expect(toText(substitute(template.blocks, ['**Lan**\nB', 'x y']))).toBe(
      'Hi **Lan**\nB, open (https://a.test/x%20y)',
    );
  });

  it('removes control characters', () => {
    expect(toText(parseMarkdown('a\u0000b\u001bc'))).toBe('abc');
  });
});
