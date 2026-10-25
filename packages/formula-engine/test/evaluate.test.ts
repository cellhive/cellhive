import { describe, expect, it } from 'vitest';

import {
  analyze,
  evaluate,
  evaluateValue,
  FormulaError,
  MAX_FORMULA_LENGTH,
  MAX_REGEX_INPUT_LENGTH,
  MAX_REGEX_PATTERN_LENGTH,
  parse,
  resolveNames,
  type EvaluateContext,
  type FormulaRecord,
} from '../src/index.js';

import {
  fixtureDataSource,
  fixtureRecord,
  fixtureSnapshot,
  loadFormulaFixture,
} from './fixtures/formula-fixture.js';
import { countNodes, cpuTimeMs, timingBudgetsApply } from './timing.js';

const { schema } = loadFormulaFixture();
const snapshot = fixtureSnapshot(schema, 'Dữ liệu');
const dataTable = schema.tables[0];
if (dataTable === undefined) throw new Error('fixture without tables');
const resolve = fixtureDataSource(schema);

function row(cells: Record<string, unknown> = {}, id = 'rec_row0000000000000'): FormulaRecord {
  return fixtureRecord(dataTable as NonNullable<typeof dataTable>, id, cells);
}

function context(overrides: Partial<EvaluateContext> = {}): EvaluateContext {
  return {
    snapshot,
    row: row(),
    resolve,
    tz: 'Asia/Ho_Chi_Minh',
    now: '2026-09-28T07:30:00Z',
    ...overrides,
  };
}

function run(formula: string, overrides: Partial<EvaluateContext> = {}) {
  const ast = resolveNames(parse(formula, { form: 'display' }), snapshot);
  return evaluate(ast, context(overrides));
}

describe('long chains of one precedence level (T470, SPEC §9.5)', () => {
  const chain = (operand: string, operator: string, count: number) =>
    Array.from({ length: count }, () => operand).join(operator);
  it.each([
    ['2,000 terms of +', chain('1', '+', 2000), '2000'],
    ['2,000 terms of -', chain('1', '-', 2000), '-1998'],
    ['2,000 factors of *', chain('1', '*', 2000), '1'],
    ['999 texts joined with &', chain('"a"', '&', 999), 'a'.repeat(999)],
    ['499 conditions with &&', chain('TRUE()', '&&', 499), true],
    ['799 conditions with ||', chain('1=2', '||', 799), false],
    ['a chain inside IF', `IF(TRUE(), ${chain('[Số]', '+', 790)}, 0)`, '1580'],
  ])('%s: typechecks and evaluates without overflowing', (_label, formula, expected) => {
    expect(formula.length).toBeLessThanOrEqual(MAX_FORMULA_LENGTH);
    expect(analyze(formula, snapshot, { form: 'display' }).errors).toEqual([]);
    expect(run(formula, { row: row({ Số: 2 }) })).toEqual(expected);
  });

  it('a type error deep in a chain is reported where it is', () => {
    const formula = `${chain('1', '+', 1500)}+"x"+${chain('1', '+', 300)}`;
    const errors = analyze(formula, snapshot, { form: 'display' }).errors;
    expect(errors).toHaveLength(1);
    expect(errors[0]?.start).toBe(formula.indexOf('"x"'));
  });
});

describe('evaluate: context', () => {
  it.each([
    ['a Date', new Date('2026-09-28T18:00:00Z'), '2026-09-29'],
    ['epoch ms', Date.parse('2026-09-28T16:59:59Z'), '2026-09-28'],
    ['ISO text with offset', '2026-09-28T23:00:00+07:00', '2026-09-28'],
    ['a local date', '2026-09-30', '2026-09-30'],
    ['local text', '2026-09-30 23:59', '2026-09-30'],
  ])('reads now from %s', (_label, now, expected) => {
    expect(run('TODAY()', { now })).toBe(expected);
  });

  it('rejects an unknown time zone and a malformed now', () => {
    expect(() => run('TODAY()', { tz: 'Mars/Olympus' })).toThrow(RangeError);
    expect(() => run('TODAY()', { tz: '' })).toThrow(RangeError);
    expect(() => run('NOW()', { now: 'yesterday' })).toThrow(RangeError);
  });

  it('throws the first type error of an AST that does not typecheck', () => {
    const ast = resolveNames(parse('SUM("a")', { form: 'display' }), snapshot);
    expect(() => evaluate(ast, context())).toThrow(FormulaError);
  });

  it('reuses the typecheck of an AST, per snapshot', () => {
    const ast = resolveNames(parse('[Số] * 2', { form: 'display' }), snapshot);
    expect(evaluate(ast, context({ row: row({ Số: 2 }) }))).toBe('4');
    expect(evaluate(ast, context({ row: row({ Số: 3 }) }))).toBe('6');
    const other = { ...snapshot };
    expect(evaluate(ast, context({ snapshot: other, row: row({ Số: 4 }) }))).toBe('8');
  });

  it('takes node types from analyze', () => {
    const analysis = analyze('[Số] + 1', snapshot, { form: 'display' });
    if (analysis.ast === null) throw new Error('no AST');
    expect(evaluate(analysis.ast, context({ row: row({ Số: 1 }), types: analysis.types }))).toBe(
      '2',
    );
  });

  it('runs without a data source: links keep their cell titles, tables are empty', () => {
    const cells = { Khách: [{ id: 'rec_an00000000000000', title: 'An' }] };
    const without = { resolve: null, row: row(cells) };
    expect(run('[Khách]', without)).toEqual([{ id: 'rec_an00000000000000', title: 'An' }]);
    expect(run('[Khách].[Điểm].SUM()', without)).toBe('0');
    expect(run('COUNTA([Khách hàng].[Tên KH])', without)).toBe('0');
    expect(run('CONTAIN([Khách], "An")', without)).toBe(true);
  });

  it('orders text with the given collation', () => {
    const formula = 'SORT(LIST("Z", "a", "Á", "b"))';
    expect(run(formula)).toEqual(['a', 'Á', 'b', 'Z']);
    expect(run(formula, { locale: 'vi' })).toEqual(['a', 'Á', 'b', 'Z']);
    expect(run('"a" < "B"')).toBe(true);
  });

  it('returns runtime values too', () => {
    const value = evaluateValue(resolveNames(parse('1 / 4'), snapshot), context());
    expect(value instanceof Object && 'coef' in value ? value.toString() : value).toBe('0.25');
  });
});

describe('evaluate: cell values', () => {
  it.each([
    [
      'select ID → option name',
      '[Trạng thái]',
      { 'Trạng thái': 'opt_shipped000000000' },
      'Đã giao',
    ],
    [
      'unknown select ID kept',
      '[Trạng thái]',
      { 'Trạng thái': 'opt_gone000000000000' },
      'opt_gone000000000000',
    ],
    [
      'multi select',
      '[Nhãn]',
      { Nhãn: ['opt_wholesale0000000', 'opt_vip0000000000000'] },
      ['Sỉ', 'VIP'],
    ],
    ['multi select one value', '[Nhãn]', { Nhãn: 'opt_vip0000000000000' }, ['VIP']],
    ['multi select skips junk', '[Nhãn]', { Nhãn: [1, 'opt_vip0000000000000'] }, ['VIP']],
    ['empty checkbox', '[Có]', {}, false],
    ['checkbox', '[Có]', { Có: true }, true],
    ['number text', '[Số]', { Số: '0012.340' }, '12.34'],
    ['invalid number', '[Số]', { Số: 'abc' }, null],
    ['number from JS number', '[Số]', { Số: 1e21 }, '1000000000000000000000'],
    ['tiny JS number', '[Số]', { Số: 1e-7 }, '0.0000001'],
    ['date text', '[Ngày]', { Ngày: '2026-02-28' }, '2026-02-28'],
    ['date from an instant', '[Ngày]', { Ngày: '2026-02-28T20:00:00Z' }, '2026-03-01'],
    ['date from epoch ms', '[Ngày]', { Ngày: Date.parse('2026-02-28T20:00:00Z') }, '2026-03-01'],
    ['invalid date', '[Ngày]', { Ngày: '28/02/2026' }, null],
    ['non-text date', '[Ngày]', { Ngày: true }, null],
    [
      'datetime',
      '[Thời điểm]',
      { 'Thời điểm': '2026-02-28T20:00:00+07:00' },
      '2026-02-28T13:00:00.000Z',
    ],
    [
      'datetime from a date',
      '[Thời điểm]',
      { 'Thời điểm': '2026-02-28' },
      '2026-02-27T17:00:00.000Z',
    ],
    ['datetime from epoch ms', '[Thời điểm]', { 'Thời điểm': 0 }, '1970-01-01T00:00:00.000Z'],
    ['invalid datetime', '[Thời điểm]', { 'Thời điểm': 'soon' }, null],
    ['non-text datetime', '[Thời điểm]', { 'Thời điểm': {} }, null],
    [
      'users as objects',
      '[Người]',
      { Người: [{ id: 'usr_an00000000000000', name: 'An' }] },
      ['usr_an00000000000000'],
    ],
    ['user junk', '[Người]', { Người: [42] }, [null]],
    ['text from a number', '[Chữ]', { Chữ: 12.5 }, '12.5'],
    ['text from a boolean', '[Chữ]', { Chữ: false }, 'FALSE'],
    ['text from an object', '[Chữ]', { Chữ: { a: 1 } }, null],
    ['boolean junk', '[Có] = TRUE', { Có: 'yes' }, false],
    ['link junk', '[Khách]', { Khách: [42] }, [null]],
  ])('%s', (_label, formula, cells, expected) => {
    expect(run(formula, { row: row(cells) })).toEqual(expected);
  });

  it('reads untyped and computed fields by their JSON kind or result type', () => {
    const extra = {
      ...snapshot,
      tables: snapshot.tables.map((table) =>
        table.id === snapshot.tableId
          ? {
              ...table,
              fields: [
                ...table.fields,
                { id: 'fld_any0000000000000', name: 'Không rõ' },
                {
                  id: 'fld_formula000000000',
                  name: 'Công thức',
                  type: 'formula',
                  resultType: { kind: 'list' as const, element: { kind: 'number' as const } },
                },
                { id: 'fld_files00000000000', name: 'Tệp', type: 'attachment' },
              ],
            }
          : table,
      ),
    };
    const eval1 = (formula: string, fields: Record<string, unknown>) =>
      evaluate(resolveNames(parse(formula, { form: 'display' }), extra), {
        ...context({ snapshot: extra }),
        row: { id: 'rec_row0000000000000', fields },
      });
    expect(eval1('[Không rõ]', { fld_any0000000000000: 5 })).toBe('5');
    expect(eval1('[Không rõ]', { fld_any0000000000000: 'x' })).toBe('x');
    expect(eval1('[Không rõ]', { fld_any0000000000000: [1, 'a', true] })).toEqual(['1', 'a', true]);
    expect(eval1('[Không rõ]', { fld_any0000000000000: { a: 1 } })).toBeNull();
    expect(eval1('"x" & [Không rõ]', { fld_any0000000000000: ['a', 1, null] })).toBe('xa, 1');
    expect(eval1('[Không rõ] < 2', { fld_any0000000000000: '1' })).toBe(true);
    expect(eval1('[Không rõ] < 2', { fld_any0000000000000: true })).toBe(true);
    expect(eval1('[Không rõ] < 2', { fld_any0000000000000: [1] })).toBe(false);
    expect(eval1('[Công thức].SUM()', { fld_formula000000000: ['1.5', 2] })).toBe('3.5');
    const file = { id: 'att_1', name: 'hợp đồng.pdf', size: 10 };
    expect(eval1('[Tệp]', { fld_files00000000000: [file, 'junk'] })).toEqual([file, null]);
    expect(eval1('COUNTA([Tệp])', { fld_files00000000000: [file] })).toBe('1');
    expect(eval1('ARRAYJOIN([Tệp])', { fld_files00000000000: [file, { id: 'x' }] })).toBe(
      'hợp đồng.pdf, ',
    );
  });
});

describe('evaluate: semantics beyond the fixture', () => {
  it.each([
    [
      'text of a user',
      '[Chữ] & FIRST([Người])',
      { Người: ['usr_an00000000000000'] },
      'usr_an00000000000000',
    ],
    ['text of a record', '"KH: " & [Khách].FIRST()', { Khách: ['rec_an00000000000000'] }, 'KH: An'],
    [
      'user compared with a user',
      'FIRST([Người]) = LAST([Người])',
      { Người: ['usr_a', 'usr_a'] },
      true,
    ],
    [
      'row compared with a row',
      '[Khách].FIRST() = [Khách].LAST()',
      { Khách: ['rec_an00000000000000'] },
      true,
    ],
    ['boolean equality', '[Có] = FALSE', {}, true],
    [
      'list against value',
      'CONTAIN([Nhãn], [Chữ])',
      { Nhãn: ['opt_vip0000000000000'], Chữ: 'VIP' },
      true,
    ],
    [
      'MAX of datetimes',
      'MAX([Thời điểm], [Ngày])',
      { 'Thời điểm': '2026-01-01T00:00:00Z', Ngày: '2026-01-02' },
      '2026-01-01T17:00:00.000Z',
    ],
    [
      'datetime minus number',
      '[Thời điểm] - 0.25',
      { 'Thời điểm': '2026-01-01T06:00:00Z' },
      '2026-01-01T00:00:00.000Z',
    ],
    [
      'date past year 9999 (fx.date_add does not check the result)',
      'DATE(9999, 12, 31) + 1',
      {},
      '10000-01-01',
    ],
    ['date shift from out of range', 'DATE(9999, 12, 31) + 1 + 1', {}, null],
    ['datetime out of range', 'TODATE("9999-12-31 23:00") + 1', {}, null],
    ['date shift too large', 'DATE(2000, 1, 1) + POWER(10, 300)', {}, null],
    ['ISERROR of a modulo', 'ISERROR(5 % 0)', {}, true],
    ['ISERROR of a plain field', 'ISERROR([Số])', {}, false],
    ['ISERROR of a failed REGEX', 'ISERROR(REGEXEXTRACT("abc", "[0-9]"))', {}, true],
    ['IF branches are lazy', 'IF(TRUE, 1, 1 / 0)', {}, '1'],
    [
      'SORTBY on a list of records',
      '[Khách].SORTBY(CurrentValue.[Điểm]).[Tên KH]',
      { Khách: ['rec_chi0000000000000', 'rec_an00000000000000', 'rec_binh000000000000'] },
      ['Bình', 'An', 'Chi'],
    ],
    [
      'FILTER over a link',
      '[Khách].FILTER(CurrentValue.[Hạng] = "Vàng").[Tên KH]',
      { Khách: ['rec_an00000000000000', 'rec_binh000000000000'] },
      ['An'],
    ],
    ['member of an empty row', '[Khách].FIRST().[Tên KH]', { Khách: [] }, null],
    ['member of a missing record', '[Khách].[Tên KH]', { Khách: ['rec_zzz0000000000000'] }, [null]],
    [
      'UNIQUE of records',
      'UNIQUE([Khách])',
      { Khách: ['rec_an00000000000000', 'rec_an00000000000000'] },
      [{ id: 'rec_an00000000000000', title: 'An' }],
    ],
    [
      'UNIQUE of dates',
      'UNIQUE(LIST([Ngày], [Ngày B]))',
      { Ngày: '2026-01-01', 'Ngày B': '2026-01-01' },
      ['2026-01-01'],
    ],
    [
      'UNIQUE of users',
      'UNIQUE([Người])',
      { Người: ['usr_a', 'usr_a', 'usr_b'] },
      ['usr_a', 'usr_b'],
    ],
    ['UNIQUE of booleans', 'UNIQUE(LIST(TRUE, TRUE, FALSE))', {}, [true, false]],
    ['UNIQUE of datetimes', 'UNIQUE(LIST(NOW(), NOW()))', {}, ['2026-09-28T07:30:00.000Z']],
    ['TEXT of a boolean', 'TEXT(TRUE, "0")', {}, 'TRUE'],
    ['TEXT with a bad number pattern', 'TEXT(5, "abc")', {}, null],
    [
      'TEXT with every date token (letters in any case, T473)',
      'TEXT(TODATE("2026-03-05 07:08:09"), "YYYY yy YY M D d H HH mm ss")',
      {},
      '2026 26 26 3 5 5 7 07 08 09',
    ],
    ['TEXT of zero with an optional digit (Excel)', 'TEXT(0, "#")', {}, ''],
    ['TODATE of a date', 'TODATE([Ngày])', { Ngày: '2026-01-02' }, '2026-01-01T17:00:00.000Z'],
    [
      'TODATE of a datetime (through its text)',
      'TODATE([Thời điểm])',
      { 'Thời điểm': '2026-01-02T03:04:05.678Z' },
      '2026-01-02T03:04:05.000Z',
    ],
    ['TODATE with an offset (not accepted)', 'TODATE("2026-01-02 10:00+0530")', {}, null],
    ['TODATE with seconds', 'TODATE(" 2026-01-02T10:00:05 ")', {}, '2026-01-02T03:00:05.000Z'],
    ['TODATE with a bad hour', 'TODATE("2026-01-02 24:00")', {}, null],
    ['ENCODEURL of a lone surrogate', 'ENCODEURL([Chữ])', { Chữ: '\ud83d' }, null],
    ['VALUE of a number', 'VALUE([Số])', { Số: 3 }, '3'],
    ['MOD keeps scale', 'MOD(-1.5, 1)', {}, '0.5'],
    ['POWER of a huge exponent', 'POWER(10, 2000000)', {}, null],
    ['POWER overflow', 'POWER(10, 200000)', {}, null],
    ['POWER of a tiny base', 'POWER(0.1, 5)', {}, '0.00001'],
    ['POWER of zero, fractional exponent', 'POWER(0, 0.5)', {}, '0'],
    ['POWER of zero, negative fractional exponent', 'POWER(0, -0.5)', {}, null],
    ['ROUND places are clamped to ±1000', 'ROUND(1.5, 1001)', {}, '1.5'],
    ['ROUND to -1001 places', 'ROUND(123, -1001)', {}, '0'],
    ['LOG in another base', 'LOG(81, 3)', {}, '4'],
    ['EXP beyond e^2302', 'EXP(2303)', {}, null],
    ['EXP below e^-2302', 'EXP(-2303)', {}, '0'],
    ['EXP past the double range', 'LEFT(EXP(1000) & "", 6)', {}, '197007'],
    ['EXP of a tiny exponent', 'ROUND(EXP(-700) * POWER(10, 304), 6)', {}, '0.985968'],
    ['WEEKNUM of another type', 'WEEKNUM(DATE(2026, 1, 1), 3)', {}, null],
    ['SUBSTITUTE with a bad occurrence', 'SUBSTITUTE("aaa", "a", "b", 0)', {}, null],
    ['SUBSTITUTE the first occurrence', 'SUBSTITUTE("aaa", "a", "b", 1)', {}, 'baa'],
    [
      'SUBSTITUTE with an empty search and an occurrence',
      'SUBSTITUTE("aaa", "", "b", 1)',
      {},
      'aaa',
    ],
    ['FIND past the end', 'FIND("", "abc", 5)', {}, '-1'],
    ['FIND with a bad start', 'FIND("a", "abc", 0)', {}, null],
    ['REPLACE past the end', 'REPLACE("abc", 5, 1, "x")', {}, 'abcx'],
    ['RIGHT with a negative count', 'RIGHT("abc", -1)', {}, null],
    ['LEFT of an empty count', 'LEFT("abc", [Số])', {}, null],
    ['DURATION with an empty part', 'DURATION(1, [Số])', {}, '1'],
    ['DURATION with empty days', 'DURATION([Số], 1)', {}, null],
    ['RANK of an empty value', 'RANK([Số], LIST(1))', {}, null],
    ['LARGE with an empty k', 'LARGE(LIST(1), [Số])', {}, null],
    ['NTH with an empty position', 'NTH(LIST(1), [Số])', {}, null],
    ['WORKDAY across years', 'WORKDAY(DATE(9999, 12, 30), 5)', {}, null],
    ['WORKDAY too far', 'WORKDAY(DATE(2000, 1, 1), 5000000)', {}, null],
    ['DATE of an empty month', 'DATE(2000, [Số], 1)', {}, null],
    ['DATE below year 1', 'DATE(0, 1, 1)', {}, null],
    ['EDATE out of range', 'EDATE(DATE(9999, 12, 1), 1)', {}, null],
    ['EOMONTH out of range', 'EOMONTH(DATE(1, 1, 1), -1)', {}, null],
    ['EOMONTH of an empty month count', 'EOMONTH(DATE(2000, 1, 1), [Số])', {}, null],
    ['DATEDIF with an empty unit', 'DATEDIF(DATE(2000, 1, 1), DATE(2001, 1, 1), [Chữ])', {}, null],
    ['NETWORKDAYS with an empty end', 'NETWORKDAYS(DATE(2000, 1, 1), [Ngày])', {}, null],
    ['WEEKDAY of an empty type', 'WEEKDAY(DATE(2000, 1, 1), [Số])', {}, null],
    ['WEEKNUM of an empty date', 'WEEKNUM([Ngày])', {}, null],
    ['DAY of an empty date', 'DAY([Ngày])', {}, null],
    ['HOUR of an empty date', 'HOUR([Thời điểm])', {}, null],
    ['SECOND of a datetime', 'SECOND(NOW())', {}, '0'],
    [
      'DAYS of datetimes across midnight',
      'DAYS(TODATE("2026-01-02 00:10"), TODATE("2026-01-01 23:50"))',
      {},
      '1',
    ],
    ['CEILING of an empty number', 'CEILING([Số])', {}, null],
    ['FLOOR of an empty number', 'FLOOR([Số])', {}, null],
    ['MOD of an empty number', 'MOD([Số], 2)', {}, null],
    ['QUOTIENT of an empty number', 'QUOTIENT([Số], 2)', {}, null],
    ['POWER of an empty number', 'POWER([Số], 2)', {}, null],
    ['LOG of an empty base', 'LOG(10, [Số])', {}, null],
    ['SQRT of an empty number', 'SQRT([Số])', {}, null],
    ['STDEV of equal big numbers', 'STDEV(POWER(10, 20), POWER(10, 20))', {}, '0'],
    ['HYPERLINK of an empty url', 'HYPERLINK([Chữ])', {}, null],
    ['CONTAINTEXT of an empty search', 'CONTAINTEXT("abc", [Chữ])', {}, false],
    ['SPLIT on an empty separator field', 'SPLIT("abc", [Chữ])', {}, null],
    ['REGEXREPLACE on an empty text', 'REGEXREPLACE([Chữ], "a", "b")', {}, null],
    ['REGEXREPLACE keeps $1 literal', 'REGEXREPLACE("ab", "(a)", "$1$1")', {}, '$1$1b'],
    ['POWER of a negative base, integer exponent', 'POWER(-2, 3)', {}, '-8'],
    ['POWER beyond the double range', 'LEFT(POWER(10, 400.5) & "", 5)', {}, '31622'],
    ['PRODUCT overflow', 'PRODUCT(POWER(10, 600), POWER(10, 600))', {}, null],
    ['ARRAYJOIN of an empty value', 'ARRAYJOIN([Nhãn])', {}, ''],
    ['CONTAINSONLY of an empty single value', 'CONTAINSONLY([Chữ], "a")', {}, false],
    ['CONTAINSONLY of a single value', 'CONTAINSONLY("a", "a", "b")', {}, true],
    ['NETWORKDAYS out of range', 'NETWORKDAYS(DATE(2000, 1, 1), DATE(9999, 12, 31) + 1)', {}, null],
    ['EDATE of a datetime out of range', 'EDATE(TODATE("9999-12-31 12:00"), 1)', {}, null],
    ['REGEXEXTRACT on an empty text', 'REGEXEXTRACT([Chữ], "a")', {}, null],
    ['REGEXEXTRACT returns the whole match', 'REGEXEXTRACT("b", "(a)?b")', {}, 'b'],
    ['REGEXREPLACE with \\& and \\\\', 'REGEXREPLACE("ab", "b", "[\\&\\\\\\x]")', {}, 'a[b\\x]'],
    ['REGEXREPLACE with a missing group', 'REGEXREPLACE("ab", "b", "<\\3>")', {}, 'a<>'],
    ['REGEXMATCH invalid in u mode', 'REGEXMATCH("a-b", "\\\\-")', {}, null],
    ['REPLACE of an empty text', 'REPLACE([Chữ], 1, 1, "x")', {}, null],
    ['MID of an empty start', 'MID("abc", [Số], 1)', {}, null],
    ['LOWER of an empty text', 'LOWER([Chữ])', {}, null],
    ['TRIM of an empty text', 'TRIM([Chữ])', {}, null],
    ['FORMAT of an empty template', 'FORMAT([Chữ], 1)', {}, null],
    ['ENCODEURL of an empty text', 'ENCODEURL([Chữ])', {}, null],
    ['CONCATENATE of nothing but empties', 'CONCATENATE([Chữ], [Chữ B])', {}, ''],
  ])('%s', (_label, formula, cells, expected) => {
    expect(run(formula, { row: row(cells) })).toEqual(expected);
  });
});

describe('evaluate: REGEX limits (BACKLOG S4b #7)', () => {
  it('runs patterns up to the limit and rejects longer ones', () => {
    const ok = 'a'.repeat(MAX_REGEX_PATTERN_LENGTH);
    const long = 'a'.repeat(MAX_REGEX_PATTERN_LENGTH + 1);
    const cells = { Chữ: ok, 'Chữ B': long };
    expect(run('REGEXMATCH([Chữ], [Chữ])', { row: row(cells) })).toBe(true);
    expect(run('REGEXMATCH([Chữ B], [Chữ B])', { row: row(cells) })).toBeNull();
  });

  it('runs on the first 10,000 characters of a text', () => {
    const emoji = '😀'.repeat(MAX_REGEX_INPUT_LENGTH);
    expect(run('REGEXMATCH([Chữ], "😀$")', { row: row({ Chữ: emoji }) })).toBe(true);
    // Only the first 10,000 characters are searched (and kept by REGEXREPLACE).
    expect(run('REGEXMATCH([Chữ], "a")', { row: row({ Chữ: `${emoji}a` }) })).toBe(false);
    expect(run('REGEXREPLACE([Chữ], "a", "b")', { row: row({ Chữ: `${emoji}a` }) })).toBe(emoji);
    expect(run('REGEXEXTRACT([Chữ], "a")', { row: row({ Chữ: `${emoji}a` }) })).toBeNull();
  });

  it('caches compiled patterns without growing without bound', () => {
    for (let i = 0; i < 250; i += 1) {
      expect(run(`REGEXMATCH("x${String(i)}", "x${String(i)}")`)).toBe(true);
    }
    expect(run('REGEXMATCH("x1", "x1")')).toBe(true);
  });
});

describe('evaluate: performance (T453 acceptance)', () => {
  /** A formula of exactly MAX_FORMULA_LENGTH characters over the row's fields. */
  function longFormula(): string {
    const parts: string[] = [];
    let text = '';
    for (let i = 0; ; i += 1) {
      const part = `IF([Số] > ${String(i)}, [Chữ] & "mức ${String(i)}", TEXT(ROUND([Số B] * 1.5, 2), "0.00"))`;
      const next = `CONCATENATE(${[...parts, part].join(', ')})`;
      if (next.length > MAX_FORMULA_LENGTH) break;
      parts.push(part);
      text = next;
    }
    const padding = MAX_FORMULA_LENGTH - text.length;
    return `${text.slice(0, -1)}${padding > 0 ? `, "${'x'.repeat(Math.max(0, padding - 4))}"` : ''})`;
  }

  /** 200 ms on plain Node; coverage instrumentation (`test:coverage`) slows the interpreter ~4×. */
  const budget = process.env['FORMULA_ENGINE_COVERAGE'] === '1' ? 800 : 200;

  it(`evaluates a ${String(MAX_FORMULA_LENGTH)}-character formula on 1,000 rows in under 200 ms`, () => {
    const source = longFormula();
    expect(source.length).toBe(MAX_FORMULA_LENGTH);
    const analysis = analyze(source, snapshot, { form: 'display' });
    expect(analysis.errors).toEqual([]);
    const ast = analysis.ast as NonNullable<typeof analysis.ast>;
    const rows = Array.from({ length: 1000 }, (_, i) =>
      row({ Số: i % 70, 'Số B': `${String(i)}.25`, Chữ: `dòng ${String(i)}` }),
    );
    const base = context({ types: analysis.types });
    // CPU time, not the wall clock: other processes of a parallel run do not count (QA S5c).
    const pass = (): number =>
      cpuTimeMs(() => {
        for (const item of rows) evaluate(ast, { ...base, row: item });
      });
    // Deterministic part (S4b-review §7.1): the AST stays linear in the source
    // (each node takes at least one character) and every row gets a value, the
    // same on every pass.
    expect(countNodes(ast)).toBeLessThan(source.length);
    const first = rows.map((item) => evaluate(ast, { ...base, row: item }));
    expect(first.every((value) => typeof value === 'string' && value.length > 0)).toBe(true);
    expect(rows.map((item) => evaluate(ast, { ...base, row: item }))).toEqual(first);

    pass(); // warm up
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 5 && best >= budget; i += 1) best = Math.min(best, pass());
    // The clock only counts on a machine that is not overloaded.
    if (timingBudgetsApply()) expect(best).toBeLessThan(budget);
  }, 60_000);
});
