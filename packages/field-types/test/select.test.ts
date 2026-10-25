import { describe, expect, it } from 'vitest';

import {
  FieldValueError,
  MULTI_VALUE_OPERATORS,
  SINGLE_SELECT_OPERATORS,
  selectFieldType,
  selectOptionsSchema,
} from '../src/index.js';

const vi = { locale: 'vi', timeZone: 'Asia/Ho_Chi_Minh' };

const NEW = 'opt_New0000000000001';
const DOING = 'opt_Doing00000000001';
const DONE = 'opt_Done000000000001';
const COMMA = 'opt_Comma00000000001';

const choices = [
  { id: NEW, name: 'Mới', color: 1 },
  { id: DOING, name: 'Đang xử lý', color: 2 },
  { id: DONE, name: 'Xong' },
  { id: COMMA, name: 'A, B' },
];

const single = selectOptionsSchema.parse({ options: choices });
const multi = selectOptionsSchema.parse({ multiple: true, options: choices });

function manyOptions(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `opt_${String(i).padStart(16, '0')}`,
    name: `Option ${String(i)}`,
  }));
}

describe('select options', () => {
  it('defaults multiple=false and no options', () => {
    expect(selectOptionsSchema.parse({})).toEqual({ multiple: false, options: [] });
  });

  it.each([
    [{ options: choices, default_value: NEW }],
    [{ options: choices, default_value: null }],
    [{ multiple: true, options: choices, default_value: [NEW, DONE] }],
    [{ options: manyOptions(1000) }],
  ])('accepts %#', (input) => {
    expect(selectOptionsSchema.safeParse(input).success).toBe(true);
  });

  it.each([
    ['more than 1000 options', { options: manyOptions(1001) }],
    ['bad option id', { options: [{ id: 'opt_short', name: 'A' }] }],
    ['wrong id prefix', { options: [{ id: 'fld_New0000000000001', name: 'A' }] }],
    ['empty name', { options: [{ id: NEW, name: '   ' }] }],
    [
      'duplicate id',
      {
        options: [
          { id: NEW, name: 'A' },
          { id: NEW, name: 'B' },
        ],
      },
    ],
    [
      'duplicate name',
      {
        options: [
          { id: NEW, name: 'A' },
          { id: DONE, name: 'A' },
        ],
      },
    ],
    ['name looks like an id', { options: [{ id: NEW, name: DONE }] }],
    ['bad color', { options: [{ id: NEW, name: 'A', color: 99 }] }],
    ['default not an option', { options: choices, default_value: 'opt_Missing000000001' }],
    ['array default on single', { options: choices, default_value: [NEW] }],
    ['scalar default on multiple', { multiple: true, options: choices, default_value: NEW }],
    ['default by name', { options: choices, default_value: 'Mới' }],
  ])('rejects %s', (_label, input) => {
    expect(selectOptionsSchema.safeParse(input).success).toBe(false);
  });

  it('trims option names', () => {
    expect(selectOptionsSchema.parse({ options: [{ id: NEW, name: '  Mới ' }] }).options).toEqual([
      { id: NEW, name: 'Mới' },
    ]);
  });
});

describe('select validate', () => {
  it.each([
    ['single name', single, 'Mới'],
    ['single id', single, NEW],
    ['single null', single, null],
    ['single one-element array', single, ['Xong']],
    ['single empty array', single, []],
    ['multi names', multi, ['Mới', 'Xong']],
    ['multi ids and names', multi, [NEW, 'Xong']],
    ['multi null', multi, null],
    ['multi empty', multi, []],
    ['name containing a comma', multi, ['A, B']],
  ])('accepts %s', (_label, options, value) => {
    expect(selectFieldType.validate(value, options)).toEqual({ ok: true });
  });

  it.each([
    ['unknown name', single, 'Khác', 'INVALID_SELECT_OPTION'],
    ['unknown id', single, 'opt_Missing000000001', 'INVALID_SELECT_OPTION'],
    ['name is case-sensitive', single, 'mới', 'INVALID_SELECT_OPTION'],
    ['two values on single', single, ['Mới', 'Xong'], 'TOO_MANY_VALUES'],
    ['number on single', single, 1, 'EXPECTED_STRING'],
    ['scalar on multi', multi, 'Mới', 'EXPECTED_ARRAY'],
    ['number element on multi', multi, ['Mới', 2], 'EXPECTED_STRING'],
    ['unknown element on multi', multi, ['Mới', 'Khác'], 'INVALID_SELECT_OPTION'],
    ['undefined', multi, undefined, 'EXPECTED_ARRAY'],
  ])('rejects %s', (_label, options, value, code) => {
    const result = selectFieldType.validate(value, options);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map((issue) => issue.code)).toContain(code);
  });

  it('reports the offending value in params', () => {
    const result = selectFieldType.validate(['Khác'], multi);
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          code: 'INVALID_SELECT_OPTION',
          message: expect.any(String) as string,
          params: { value: 'Khác' },
        },
      ],
    });
  });
});

describe('select storage', () => {
  it.each([
    [single, 'Mới', [NEW]],
    [single, NEW, [NEW]],
    [single, ['Xong'], [DONE]],
    [single, null, null],
    [single, [], null],
    [multi, ['Xong', 'Mới', NEW], [DONE, NEW]],
    [multi, [], null],
    [multi, null, null],
  ])('toStorage %#', (options, value, expected) => {
    expect(selectFieldType.toStorage(value, options)).toEqual(expected);
  });

  it('toStorage throws on unknown options', () => {
    expect(() => selectFieldType.toStorage('Khác', single)).toThrow(FieldValueError);
  });

  it.each([
    [single, [NEW], 'Mới'],
    [single, null, null],
    [single, [], null],
    [single, ['opt_Deleted000000001'], null],
    [multi, [DONE, NEW], ['Xong', 'Mới']],
    [multi, [DONE, 'opt_Deleted000000001'], ['Xong']],
    [multi, [], null],
    [multi, null, null],
    [multi, 'garbage', null],
  ])('fromStorage %#', (options, stored, expected) => {
    expect(selectFieldType.fromStorage(stored, options)).toEqual(expected);
  });

  it('renaming an option changes the read value without rewriting storage', () => {
    const stored = selectFieldType.toStorage('Mới', single);
    const renamed = selectOptionsSchema.parse({
      options: [{ id: NEW, name: 'New' }, ...choices.slice(1)],
    });
    expect(selectFieldType.fromStorage(stored, renamed)).toBe('New');
  });

  it('round-trips names through ids', () => {
    for (const [options, value] of [
      [single, 'Đang xử lý'],
      [single, null],
      [multi, ['Mới', 'A, B']],
      [multi, null],
    ] as const) {
      const stored = selectFieldType.toStorage(value, options);
      expect(selectFieldType.fromStorage(stored, options)).toEqual(value);
    }
  });
});

describe('select typecast', () => {
  it.each([
    ['single known', single, 'Mới', 'Mới', []],
    ['single trims', single, '  Xong ', 'Xong', []],
    ['single keeps commas', single, 'Khác, Nữa', 'Khác, Nữa', ['Khác, Nữa']],
    ['single unknown', single, 'Khác', 'Khác', ['Khác']],
    ['single number', single, 5, '5', ['5']],
    ['single id', single, NEW, NEW, []],
    ['single array', single, ['Xong'], 'Xong', []],
    ['single empty', single, '', null, []],
    ['single null', single, null, null, []],
    ['multi split', multi, 'Mới, Xong', ['Mới', 'Xong'], []],
    ['multi split unknown', multi, 'Mới, Khác,  ,Khác', ['Mới', 'Khác'], ['Khác']],
    ['multi exact name with comma', multi, 'A, B', ['A, B'], []],
    ['multi array', multi, [' Mới', 7], ['Mới', '7'], ['7']],
    ['multi empty', multi, '', null, []],
    ['multi undefined', multi, undefined, null, []],
  ])('%s', (_label, options, input, value, unknownOptions) => {
    expect(selectFieldType.typecast(input, options, vi)).toEqual({
      ok: true,
      value,
      unknownOptions,
    });
  });

  it.each([
    ['two values on single', single, ['Mới', 'Xong'], 'TOO_MANY_VALUES'],
    ['object on single', single, { name: 'Mới' }, 'EXPECTED_STRING'],
    ['object element', multi, [{ name: 'Mới' }], 'EXPECTED_STRING'],
    ['boolean on multi', multi, true, 'EXPECTED_ARRAY'],
  ])('rejects %s', (_label, options, input, code) => {
    const result = selectFieldType.typecast(input, options, vi);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.code).toBe(code);
  });
});

describe('select formatText, pgType, operators', () => {
  it.each([
    [single, 'Mới', 'Mới'],
    [single, null, ''],
    [multi, ['A', 'B'], 'A, B'],
    [multi, null, ''],
  ])('formatText %#', (options, value, expected) => {
    expect(selectFieldType.formatText(value, options, vi)).toBe(expected);
  });

  it('pgType is text[]', () => {
    expect(selectFieldType.pgType(single, { collation: 'und-x-icu' })).toBe('text[]');
  });

  it('operators depend on multiple', () => {
    expect(selectFieldType.filterOperators(single)).toEqual(SINGLE_SELECT_OPERATORS);
    expect(selectFieldType.filterOperators(multi)).toEqual(MULTI_VALUE_OPERATORS);
    expect(SINGLE_SELECT_OPERATORS).toEqual([
      'is',
      'is_not',
      'is_any_of',
      'is_none_of',
      'is_empty',
      'is_not_empty',
    ]);
    expect(MULTI_VALUE_OPERATORS).toEqual([
      'has_any_of',
      'has_all_of',
      'has_none_of',
      'is_exactly',
      'is_empty',
      'is_not_empty',
    ]);
  });
});
