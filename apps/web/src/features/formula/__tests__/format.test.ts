import { parse, stripSpans } from '@cellhive/formula-engine';
import { describe, expect, it } from 'vitest';

import { localeResources } from '../../../../test/i18n';
import { formatFormula } from '../model/format';
import { editorMessageKey } from '../model/messages';
import { formulaSegments } from '../model/segments';

import { SCHEMA } from './fixture';

const format = (source: string) => formatFormula(parse(source));

describe('formatFormula (Reformat)', () => {
  it.each([
    ['sum( 1,2 )', 'SUM(1, 2)'],
    ['[A]+[B]*2', '[A] + [B] * 2'],
    ['(1 + 2).SUM()', '(1 + 2).SUM()'],
    [
      '[Đơn hàng].FILTER(CurrentValue.[Khách hàng].CONTAIN([Tên khách hàng]) && CurrentValue.[Trạng thái] = "Hoàn tất").[Tổng tiền].SUM()',
      [
        '[Đơn hàng]',
        '  .FILTER(',
        '    CurrentValue.[Khách hàng].CONTAIN([Tên khách hàng])',
        '    && CurrentValue.[Trạng thái] = "Hoàn tất"',
        '  )',
        '  .[Tổng tiền]',
        '  .SUM()',
      ].join('\n'),
    ],
  ])('%s', (source, expected) => {
    expect(format(source)).toBe(expected);
  });

  it.each([
    'IF([Trạng thái] = "Xong", [Số tiền] * 0.1, 0)',
    '[Đơn hàng].FILTER(CurrentValue.[Khách hàng].CONTAIN([Tên khách hàng]) && CurrentValue.[Trạng thái] = "Hoàn tất").[Tổng tiền].SUM()',
    'IFS([A] > 100000000, "Kim cương", [A] > 50000000, "Vàng", [A] > 10000000, "Bạc", TRUE, "Đồng")',
    '([A] || [B]) && ([C] || [D] || [E]) && [F] = "một chuỗi khá dài để phải xuống dòng"',
    '-[A].SUM() + LET(x, 1, x * 2)',
  ])('keeps the same tree: %s', (source) => {
    expect(stripSpans(parse(format(source)))).toEqual(stripSpans(parse(source)));
  });
});

describe('editor messages', () => {
  it.each([
    [{ code: 'UNEXPECTED_END', params: { function: 'SUM' } }, 'formula:errors.UNCLOSED_CALL'],
    [{ code: 'UNEXPECTED_END', params: {} }, null],
    [{ code: 'UNKNOWN_FIELD', params: { name: 'X' } }, 'formula:errors.UNKNOWN_FIELD_named'],
    [{ code: 'UNKNOWN_FIELD', params: { id: 'fld_x' } }, null],
    [
      { code: 'WRONG_ARGUMENT_COUNT', params: { function: 'IF', min: 2, max: 3, actual: 1 } },
      'formula:errors.WRONG_ARGUMENT_COUNT',
    ],
    [
      { code: 'WRONG_ARGUMENT_COUNT', params: { function: 'ABS', min: 1, max: 1, actual: 2 } },
      'formula:errors.WRONG_ARGUMENT_COUNT_exact',
    ],
    [
      { code: 'WRONG_ARGUMENT_COUNT', params: { function: 'SUM', min: 1, max: null, actual: 0 } },
      'formula:errors.WRONG_ARGUMENT_COUNT_open',
    ],
    [{ code: 'TYPE_MISMATCH', params: {} }, null],
    [
      { code: 'TYPE_MISMATCH', params: { suggestions: ['TEXT'] } },
      'formula:errors.TYPE_MISMATCH_text',
    ],
  ])('%j → %s', (item, key) => {
    expect(editorMessageKey(item)).toBe(key);
  });
});

describe('formulaSegments', () => {
  it('draws names as chips and the rest in colours', () => {
    const source =
      '[Đơn hàng].FILTER(CurrentValue.[Tổng tiền] > 5).[Mã đơn] & "x" & [Nope] & #REF[fld_gone]';
    expect(
      formulaSegments(source, SCHEMA).map(
        (segment) => `${segment.kind}:${segment.label ?? source.slice(segment.from, segment.to)}`,
      ),
    ).toEqual([
      'table:Đơn hàng',
      'punctuation:.',
      'function:FILTER',
      'punctuation:(',
      'current:CurrentValue',
      'punctuation:.',
      'field:Tổng tiền',
      'operator:>',
      'number:5',
      'punctuation:)',
      'punctuation:.',
      'field:Mã đơn',
      'operator:&',
      'string:"x"',
      'operator:&',
      'broken:Nope',
      'operator:&',
      'broken:#REF',
    ]);
  });

  it('shows sample names as plain chips without a schema', () => {
    expect(formulaSegments('[Any].SUM()', null)[0]).toMatchObject({ kind: 'field', label: 'Any' });
  });
});

describe('formula locale files', () => {
  /** Keys of a locale tree, plural forms (`_one`, `_other`) folded into their base key. */
  function keys(tree: unknown, prefix = ''): string[] {
    if (typeof tree !== 'object' || tree === null) return [prefix.replace(/_(one|other)$/u, '')];
    return Object.entries(tree).flatMap(([key, value]) =>
      keys(value, prefix === '' ? key : `${prefix}.${key}`),
    );
  }

  it('has the same keys in en and vi', () => {
    const resources = localeResources();
    const en = new Set(keys(resources['en']?.['formula']));
    const vi = new Set(keys(resources['vi']?.['formula']));
    expect([...en].sort()).toEqual([...vi].sort());
  });
});
