import { describe, expect, it } from 'vitest';

import {
  FieldValueError,
  formatLinkTitleList,
  LINK_MAX_PER_CELL,
  linkCellLimit,
  linkFieldType,
  linkIdsOf,
  linkOptionsSchema,
  MULTI_VALUE_OPERATORS,
  parseLinkTitleList,
  RELATION_FIELD_TYPES,
} from '../src/index.js';

const vi = { locale: 'vi', timeZone: 'Asia/Ho_Chi_Minh' };

const TABLE = 'tbl_CCCCCCCCCCCCCCC1';
const A = 'rec_AAAAAAAAAAAAAAA1';
const B = 'rec_BBBBBBBBBBBBBBB2';

const multi = linkOptionsSchema.parse({ link_table: TABLE });
const single = linkOptionsSchema.parse({ link_table: TABLE, allow_multiple: false });

/** `n` distinct record ids. */
function ids(n: number): string[] {
  return Array.from({ length: n }, (_, index) => `rec_${String(index).padStart(16, '0')}`);
}

describe('link options', () => {
  it('defaults', () => {
    expect(multi).toEqual({
      link_table: TABLE,
      bidirectional: false,
      allow_multiple: true,
      record_filter: null,
      symmetric_field_id: null,
    });
  });

  it.each([
    [{ link_table: TABLE, bidirectional: true, bidirectional_link_field_name: 'Orders' }],
    [{ link_table: TABLE, allow_multiple: false }],
    [{ link_table: TABLE, record_filter: { op: 'and', items: [] } }],
    [{ link_table: TABLE, record_filter: null }],
    [{ link_table: TABLE, symmetric_field_id: 'fld_DDDDDDDDDDDDDDD1' }],
  ])('accepts %j', (input) => {
    expect(linkOptionsSchema.safeParse(input).success).toBe(true);
  });

  it.each([
    [{}],
    [{ link_table: 'tbl_bad' }],
    [{ link_table: TABLE, bidirectional_link_field_name: '' }],
    [{ link_table: TABLE, bidirectional_link_field_name: 'x'.repeat(256) }],
    [{ link_table: TABLE, record_filter: [] }],
    [{ link_table: TABLE, unknown: true }],
  ])('rejects %j', (input) => {
    expect(linkOptionsSchema.safeParse(input).success).toBe(false);
  });

  it('limits a cell to 500 links, or 1 without allow_multiple', () => {
    expect(LINK_MAX_PER_CELL).toBe(500);
    expect(linkCellLimit(multi)).toBe(500);
    expect(linkCellLimit(single)).toBe(1);
  });

  it('is listed with the relation types', () => {
    expect(RELATION_FIELD_TYPES.link).toBe(linkFieldType);
    expect(linkFieldType.filterOperators(multi)).toBe(MULTI_VALUE_OPERATORS);
  });
});

describe('link validate', () => {
  it.each([
    [multi, [A, B]],
    [multi, [{ id: A }, { id: B, title: 'ignored' }]],
    [multi, []],
    [multi, null],
    [multi, [A, A]],
    [multi, ids(500)],
    [single, [A]],
    [single, [A, A]],
  ])('accepts %#', (options, value) => {
    expect(linkFieldType.validate(value, options)).toEqual({ ok: true });
  });

  it.each([
    [multi, A, 'EXPECTED_ARRAY', undefined],
    [multi, { id: A }, 'EXPECTED_ARRAY', undefined],
    [multi, ['rec_bad'], 'INVALID_RECORD_ID', undefined],
    [multi, [{ title: 'An Phát' }], 'INVALID_RECORD_ID', undefined],
    [multi, [42], 'INVALID_RECORD_ID', undefined],
    [multi, ids(501), 'TOO_MANY_VALUES', { limit: 500 }],
    [single, [A, B], 'TOO_MANY_VALUES', { limit: 1 }],
  ])('rejects %#', (options, value, code, params) => {
    const result = linkFieldType.validate(value, options);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]?.code).toBe(code);
      expect(result.issues[0]?.params).toEqual(params);
    }
  });
});

describe('link typecast', () => {
  it.each([
    [multi, null, null],
    [multi, '', null],
    [multi, [], null],
    [multi, A, [{ id: A }]],
    [multi, 'An Phát', [{ title: 'An Phát' }]],
    [multi, ' An Phát ', [{ title: 'An Phát' }]],
    [multi, 'An Phát, Bình Minh', [{ title: 'An Phát, Bình Minh' }]],
    [multi, [A, 'An Phát', { id: B }], [{ id: A }, { title: 'An Phát' }, { id: B }]],
    [multi, [A, A, 'x', 'x', ''], [{ id: A }, { title: 'x' }]],
    [multi, 42, [{ title: '42' }]],
  ])('%#: %j', (options, input, expected) => {
    expect(linkFieldType.typecast(input, options, vi)).toEqual({
      ok: true,
      value: expected,
      unknownOptions: [],
    });
  });

  it.each([
    [multi, [{ id: 'rec_bad' }], 'INVALID_RECORD_ID'],
    [multi, [true], 'INVALID_RECORD_ID'],
    [multi, ids(501), 'TOO_MANY_VALUES'],
    [single, ['a', 'b'], 'TOO_MANY_VALUES'],
  ])('rejects %#', (options, input, code) => {
    const result = linkFieldType.typecast(input, options, vi);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.code).toBe(code);
  });
});

describe('link storage and text', () => {
  it('stores distinct ids in the given order', () => {
    expect(linkFieldType.toStorage([B, { id: A }, B], multi)).toEqual([B, A]);
    expect(linkFieldType.toStorage([], multi)).toBeNull();
    expect(linkFieldType.toStorage(null, multi)).toBeNull();
    expect(linkIdsOf([B, { id: A }, 'bad'])).toEqual([B, A]);
  });

  it('refuses an invalid write in toStorage', () => {
    expect(() => linkFieldType.toStorage(ids(501), multi)).toThrow(FieldValueError);
    expect(() => linkFieldType.toStorage([A, B], single)).toThrow(FieldValueError);
  });

  it('reads the refs the server assembled', () => {
    expect(linkFieldType.fromStorage(null, multi)).toBeNull();
    expect(linkFieldType.fromStorage([], multi)).toBeNull();
    expect(
      linkFieldType.fromStorage(
        [{ id: A, title: 'An Phát' }, { id: B, title: null }, { bad: true }],
        multi,
      ),
    ).toEqual([
      { id: A, title: 'An Phát' },
      { id: B, title: null },
    ]);
  });

  it('formats readable titles only', () => {
    expect(
      linkFieldType.formatText(
        [
          { id: A, title: 'An Phát' },
          { id: B, title: null },
          { id: 'rec_CCCCCCCCCCCCCCC3', title: 'Bình Minh' },
        ],
        multi,
        vi,
      ),
    ).toBe('An Phát, Bình Minh');
    expect(linkFieldType.formatText(null, multi, vi)).toBe('');
  });
});

describe('link title lists (T411, CONTRACTS §2, §19)', () => {
  it.each([
    [[], ''],
    [['An Phát'], 'An Phát'],
    [['An Phát', 'Bình Minh'], 'An Phát, Bình Minh'],
    [['Nguyễn, An', 'B'], '"Nguyễn, An", B'],
    [['Công ty "A"'], '"Công ty ""A"""'],
    [['a"b, c', 'd'], '"a""b, c", d'],
  ])('formats %j as %j and reads it back', (titles, text) => {
    expect(formatLinkTitleList(titles)).toBe(text);
    expect(parseLinkTitleList(text)).toEqual(titles);
  });

  it.each([
    ['', []],
    ['   ', []],
    ['A,B', ['A', 'B']],
    ['  A ,  B  ', ['A', 'B']],
    ['A, , B,', ['A', 'B']],
    ['"A, B"', ['A, B']],
    ['"A, B" , C', ['A, B', 'C']],
    // An unclosed quote, or text after the closing quote: plain text to the next comma.
    ['"A, B', ['"A', 'B']],
    ['"A" x, B', ['"A" x', 'B']],
    ['It\'s "fine", ok', ['It\'s "fine"', 'ok']],
    ['""', []],
    ['rec_AAAAAAAAAAAAAAA1, An Phát', ['rec_AAAAAAAAAAAAAAA1', 'An Phát']],
  ])('parses %j', (text, titles) => {
    expect(parseLinkTitleList(text)).toEqual(titles);
  });

  it('quotes titles with commas in cell_format=text', () => {
    expect(
      linkFieldType.formatText(
        [
          { id: A, title: 'Nguyễn, An' },
          { id: B, title: 'Bình Minh' },
        ],
        multi,
        vi,
      ),
    ).toBe('"Nguyễn, An", Bình Minh');
  });
});
