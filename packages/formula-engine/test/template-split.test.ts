import { describe, expect, it } from 'vitest';

import {
  MAX_TEMPLATE_PLACEHOLDERS,
  placeholderEnd,
  splitTemplate,
  type TemplatePart,
} from '../src/template/split.js';

/** Parts as `text:…` / `{…}` strings for compact assertions. */
const shapeOf = (parts: readonly TemplatePart[]) =>
  parts.map((part) => (part.kind === 'text' ? `text:${part.text}` : `{${part.expression}}`));

describe('splitTemplate: literal text and {{ expressions }} (SPEC §11.4)', () => {
  const cases: { name: string; source: string; parts: string[] }[] = [
    { name: 'empty', source: '', parts: [] },
    { name: 'text only', source: 'Hello', parts: ['text:Hello'] },
    { name: 'one placeholder', source: '{{ [fld_a] }}', parts: ['{[fld_a]}'] },
    {
      name: 'text around',
      source: 'Ticket {{ [fld_a] }} done',
      parts: ['text:Ticket ', '{[fld_a]}', 'text: done'],
    },
    { name: 'no spaces', source: '{{1+2}}', parts: ['{1+2}'] },
    { name: 'two in a row', source: '{{ 1 }}{{ 2 }}', parts: ['{1}', '{2}'] },
    {
      name: '}} inside a string does not close',
      source: '{{ "a}}b" & [x] }}!',
      parts: ['{"a}}b" & [x]}', 'text:!'],
    },
    {
      name: '}} inside a [name] does not close',
      source: '{{ [a}}b] }}',
      parts: ['{[a}}b]}'],
    },
    {
      name: 'escaped quote inside a string',
      source: '{{ "say \\"}}\\"" }}',
      parts: ['{"say \\"}}\\""}'],
    },
    {
      name: 'escaped bracket inside a name',
      source: '{{ [a\\]}}] }}',
      parts: ['{[a\\]}}]}'],
    },
    { name: 'a single brace is text', source: 'a { b } c', parts: ['text:a { b } c'] },
    { name: '\\{ keeps a literal brace', source: '\\{{ x }}', parts: ['text:{{ x }}'] },
    { name: '\\\\ is one backslash', source: 'C:\\\\{{ 1 }}', parts: ['text:C:\\', '{1}'] },
    { name: 'other backslashes stay', source: 'a\\nb', parts: ['text:a\\nb'] },
    {
      name: 'nested braces in expression text',
      source: '{{ IF(1, "{", "}") }}',
      parts: ['{IF(1, "{", "}")}'],
    },
    {
      name: 'Vietnamese and emoji',
      source: '✅ {{ [Tên] }} — xong',
      parts: ['text:✅ ', '{[Tên]}', 'text: — xong'],
    },
  ];
  it.each(cases)('$name', ({ source, parts }) => {
    const result = splitTemplate(source);
    expect(result.issues).toEqual([]);
    expect(shapeOf(result.parts)).toEqual(parts);
  });

  it('records the positions of each part', () => {
    const source = 'Hi {{  [fld_a]  }}!';
    const { parts } = splitTemplate(source);
    expect(parts).toEqual([
      { kind: 'text', text: 'Hi ', start: 0, length: 3 },
      {
        kind: 'expression',
        index: 0,
        expression: '[fld_a]',
        start: 3,
        length: 15,
        expressionStart: 7,
      },
      { kind: 'text', text: '!', start: 18, length: 1 },
    ]);
    const expression = parts[1];
    if (expression?.kind !== 'expression') throw new Error('expected an expression');
    expect(source.slice(expression.expressionStart, expression.expressionStart + 7)).toBe(
      '[fld_a]',
    );
  });
});

describe('splitTemplate: issues', () => {
  const cases: {
    name: string;
    source: string;
    issues: { code: string; start: number; length: number }[];
    parts: string[];
  }[] = [
    {
      name: 'unterminated placeholder: the rest is text',
      source: 'a {{ [x b }} {{ 1 }}',
      issues: [{ code: 'UNTERMINATED_PLACEHOLDER', start: 2, length: 18 }],
      parts: ['text:a {{ [x b }} {{ 1 }}'],
    },
    {
      name: 'unterminated string inside',
      source: '{{ "abc }}',
      issues: [{ code: 'UNTERMINATED_PLACEHOLDER', start: 0, length: 10 }],
      parts: ['text:{{ "abc }}'],
    },
    {
      name: 'empty placeholder stays text',
      source: 'a {{   }} b {{ 1 }}',
      issues: [{ code: 'EMPTY_PLACEHOLDER', start: 2, length: 7 }],
      parts: ['text:a {{   }} b ', '{1}'],
    },
  ];
  it.each(cases)('$name', ({ source, issues, parts }) => {
    const result = splitTemplate(source);
    expect(result.issues).toEqual(issues);
    expect(shapeOf(result.parts)).toEqual(parts);
  });

  it(`keeps at most ${String(MAX_TEMPLATE_PLACEHOLDERS)} placeholders`, () => {
    const source = '{{ 1 }}'.repeat(MAX_TEMPLATE_PLACEHOLDERS + 2);
    const result = splitTemplate(source);
    expect(result.parts.filter((part) => part.kind === 'expression')).toHaveLength(
      MAX_TEMPLATE_PLACEHOLDERS,
    );
    expect(result.issues).toEqual([
      { code: 'TOO_MANY_PLACEHOLDERS', start: MAX_TEMPLATE_PLACEHOLDERS * 7, length: 7 },
    ]);
    expect(result.parts.at(-1)).toMatchObject({ kind: 'text', text: '{{ 1 }}{{ 1 }}' });
  });

  it('a lower limit can be passed', () => {
    const result = splitTemplate('{{ 1 }}{{ 2 }}', { maxPlaceholders: 1 });
    expect(shapeOf(result.parts)).toEqual(['{1}', 'text:{{ 2 }}']);
  });
});

describe('placeholderEnd', () => {
  const cases: { source: string; from: number; end: number }[] = [
    { source: '{{ 1 }}', from: 2, end: 7 },
    { source: '{{ "}}" }}x', from: 2, end: 10 },
    { source: '{{ [}}] }}', from: 2, end: 10 },
    { source: '{{ 1 }', from: 2, end: -1 },
    { source: '{{ "1 }}', from: 2, end: -1 },
    { source: '{{ [1 }}', from: 2, end: -1 },
  ];
  it.each(cases)('$source from $from → $end', ({ source, from, end }) => {
    expect(placeholderEnd(source, from)).toBe(end);
  });
});
