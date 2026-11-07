import { describe, expect, it } from 'vitest';

import { foldText, unaccent } from '../src/index.js';
import { unaccentRules } from '../src/unaccent.js';

import { PLAIN_UNACCENT_RULES } from './unaccent-rules.plain.js';

/** The plain list as PostgreSQL's file has it: character → replacement (`''`: deleted). */
function plainRules(): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of PLAIN_UNACCENT_RULES.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab === -1) map.set(line, '');
    else map.set(line.slice(0, tab), line.slice(tab + 1));
  }
  return map;
}

describe('unaccent rules: the compact table (T1000)', () => {
  const plain = plainRules();

  it('decodes to exactly the rules of PostgreSQL 18 unaccent.rules', () => {
    expect(plain.size).toBe(2661);
    const decoded = unaccentRules();
    expect(decoded.size).toBe(plain.size);
    const byCodePoint = (a: [string, string], b: [string, string]) =>
      (a[0].codePointAt(0) ?? 0) - (b[0].codePointAt(0) ?? 0);
    expect([...decoded].sort(byCodePoint)).toEqual([...plain].sort(byCodePoint));
  });

  it('unaccents every character of the table to its rule', () => {
    const wrong = [...plain].filter(([from, to]) => unaccent(from) !== to);
    expect(wrong).toEqual([]);
  });
});

/** Vietnamese vowels with the marks that make them (breve, circumflex, horn) and their base. */
const VOWELS: readonly (readonly [vowel: string, base: string])[] = [
  ['a', 'a'],
  ['ă', 'a'],
  ['â', 'a'],
  ['e', 'e'],
  ['ê', 'e'],
  ['i', 'i'],
  ['o', 'o'],
  ['ô', 'o'],
  ['ơ', 'o'],
  ['u', 'u'],
  ['ư', 'u'],
  ['y', 'y'],
];
/** No tone, huyền, sắc, hỏi, ngã, nặng. */
const TONES = ['', '̀', '́', '̉', '̃', '̣'] as const;

describe('unaccent: every Vietnamese vowel with every tone, and đ', () => {
  const cases = VOWELS.flatMap(([vowel, base]) =>
    TONES.map((tone) => ({ decomposed: `${vowel}${tone}`, base })),
  );

  it('covers the 72 vowel and tone combinations', () => {
    expect(new Set(cases.map(({ decomposed }) => decomposed.normalize('NFC'))).size).toBe(72);
  });

  it.each(cases)(
    '$decomposed → $base (composed and decomposed, both cases)',
    ({ decomposed, base }) => {
      const composed = decomposed.normalize('NFC');
      // One precomposed code point (the form people type).
      expect(String.fromCodePoint(composed.codePointAt(0) ?? 0)).toBe(composed);
      expect(unaccent(composed)).toBe(base);
      expect(unaccent(composed.toUpperCase())).toBe(base.toUpperCase());
      expect(unaccent(decomposed)).toBe(base);
      expect(unaccent(decomposed.toUpperCase())).toBe(base.toUpperCase());
      expect(foldText(composed.toUpperCase())).toBe(base);
    },
  );

  it('turns đ and Đ into d and D', () => {
    expect(unaccent('đ')).toBe('d');
    expect(unaccent('Đ')).toBe('D');
    expect(foldText('Đ')).toBe('d');
  });

  it('unaccents whole Vietnamese sentences', () => {
    const sentence = 'Đặng Thị Hồng Nhung ở Hà Nội mua chiếc xe đạp màu xanh lá với giá rẻ nhất';
    expect(unaccent(sentence)).toBe(
      'Dang Thi Hong Nhung o Ha Noi mua chiec xe dap mau xanh la voi gia re nhat',
    );
    expect(unaccent(sentence.normalize('NFD'))).toBe(unaccent(sentence));
    expect(foldText('TRƯỜNG ĐẠI HỌC QUỐC GIA')).toBe('truong dai hoc quoc gia');
  });
});
