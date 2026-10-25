import { describe, expect, it } from 'vitest';

import { containFoldsCase, foldCase, lowerCase, upperCase } from '../src/evaluate/case-fold.js';
import { T, listOf, rowOf } from '../src/types/formula-type.js';

/**
 * Case folding of CONTAIN* (BACKLOG T473, SPEC §9.4): Unicode 16.0 simple
 * lowercase mapping ≡ `lower(t COLLATE pg_c_utf8)` of PostgreSQL 18
 * (checked code point by code point in `fx-functions.int.test.ts`).
 */
describe('foldCase', () => {
  const cases: [string, string, string][] = [
    ['ASCII', 'Hello WORLD 123', 'hello world 123'],
    ['Vietnamese precomposed', 'ĐẶNG VĂN ẤN Ờ Ữ Ỹ', 'đặng văn ấn ờ ữ ỹ'],
    ['Vietnamese already lower', 'thành phố hồ chí minh', 'thành phố hồ chí minh'],
    ['decomposed accents kept (no normalization)', 'É', 'é'],
    ['dotted capital I → plain i (simple mapping, not i̇)', 'İstanbul', 'istanbul'],
    ['dotless i stays', 'ı', 'ı'],
    ['capital I → i (no Turkish rule)', 'I', 'i'],
    ['sharp s stays (never ss)', 'ß', 'ß'],
    ['capital sharp s → ß', 'ẞ', 'ß'],
    ['final sigma: no context rule', 'ΟΔΟΣ', 'οδοσ'],
    ['final sigma stays', 'ς', 'ς'],
    ['Kelvin sign → k', 'K', 'k'],
    ['Angstrom sign → å', 'Å', 'å'],
    ['long s stays (lowercase, not folding)', 'ſ', 'ſ'],
    ['titlecase digraph', 'ǅ', 'ǆ'],
    ['Cyrillic', 'ПРИВЕТ', 'привет'],
    ['Armenian', 'Ա', 'ա'],
    ['Georgian Mtavruli', 'Ა', 'ა'],
    ['Cherokee → small letters', 'Ꭰ', 'ꭰ'],
    ['fullwidth', 'ＡＢＣ', 'ａｂｃ'],
    ['Deseret (astral)', '𐐀', '𐐨'],
    ['Adlam (astral)', '𞤀', '𞤢'],
    ['Unicode 17 letter unknown to PostgreSQL 18 stays', '꟎', '꟎'],
    ['emoji and CJK untouched', '😀 漢字 ÀÁ', '😀 漢字 àá'],
    ['empty', '', ''],
  ];
  it.each(cases)('%s', (_name, input, expected) => {
    expect(foldCase(input)).toBe(expected);
  });

  it('keeps every code point length (simple mapping)', () => {
    const longer: number[] = [];
    for (let code = 0; code <= 0x1ffff; code += 1) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const folded = foldCase(String.fromCodePoint(code));
      if (folded.length !== String.fromCodePoint(folded.codePointAt(0) ?? 0).length) {
        longer.push(code);
      }
    }
    expect(longer).toEqual([]);
  });
});

describe('lowerCase / upperCase (LOWER, UPPER)', () => {
  const cases: [string, string, string, string][] = [
    ['ASCII', 'Hello', 'hello', 'HELLO'],
    ['Vietnamese', 'Đặng Văn Ấn', 'đặng văn ấn', 'ĐẶNG VĂN ẤN'],
    ['dotted and dotless i', 'İı', 'iı', 'İI'],
    ['sharp s', 'ßẞ', 'ßß', 'ßẞ'],
    ['sigma, no final-sigma rule', 'ΟΔΟΣ ος', 'οδοσ ος', 'ΟΔΟΣ ΟΣ'],
    ['titlecase digraph', 'ǅ', 'ǆ', 'Ǆ'],
    ['Cherokee', 'Ꭰꭰ', 'ꭰꭰ', 'ᎠᎠ'],
    ['astral', '𐐀𐐨', '𐐨𐐨', '𐐀𐐀'],
  ];
  it.each(cases)('%s', (_name, input, lower, upper) => {
    expect(lowerCase(input)).toBe(lower);
    expect(upperCase(input)).toBe(upper);
    expect(foldCase(input)).toBe(lower);
  });
});

describe('containFoldsCase', () => {
  const recordId = { kind: 'text', recordIdOf: 'tbl_a' } as const;
  const cases: [string, Parameters<typeof containFoldsCase>[0], boolean][] = [
    ['texts', [listOf(T.text), T.text, T.text], true],
    ['records and texts (titles)', [listOf(rowOf('tbl_a')), T.text], true],
    ['empty values', [listOf(T.text), T.null, listOf(T.null)], true],
    ['users', [listOf(T.user), T.text], false],
    ['a user among texts', [listOf(T.text), T.text, T.user], false],
    ['RECORD_ID()', [listOf(rowOf('tbl_a')), recordId], false],
    ['numbers', [listOf(T.number), T.number], false],
    ['dates', [listOf(T.date), T.datetime], false],
  ];
  it.each(cases)('%s', (_name, types, expected) => {
    expect(containFoldsCase(types)).toBe(expected);
  });
});
