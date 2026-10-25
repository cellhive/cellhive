import { describe, expect, it } from 'vitest';

import { analyzeFormula } from '../model/analysis';
import { suggest } from '../model/completions';
import { formulaContext } from '../model/context';
import { matchLabel } from '../model/match';
import { evaluateRows } from '../model/preview';
import { lineColumn, scanFormula } from '../model/scan';
import { activeSignature } from '../model/signature';

import { CUSTOMERS, DONE, id, OPEN, ORDERS, SCHEMA } from './fixture';

import type { RecordDto } from '@cellhive/contracts';

describe('scanFormula', () => {
  it.each([
    ['IF([Tr', ['identifier:IF', 'operator:(', 'open_name:Tr']],
    ['"Hoàn', ['string:Hoàn']],
    ['1 @ 2', ['number:1', 'invalid:@', 'number:2']],
    ['[A] + [B\\]]', ['name:A', 'operator:+', 'name:B]']],
    ['#REF[fld_x] * 2', ['broken_ref:fld_x', 'operator:*', 'number:2']],
    ['', []],
  ])('%s', (source, expected) => {
    expect(scanFormula(source).map((token) => `${token.type}:${token.value}`)).toEqual(expected);
  });

  it('keeps offsets after an invalid character', () => {
    const tokens = scanFormula('1 ; [A]');
    expect(tokens.map((token) => [token.start, token.length])).toEqual([
      [0, 1],
      [2, 1],
      [4, 3],
    ]);
  });

  it('counts lines and columns from 1', () => {
    expect(lineColumn('SUM(\n  [A]', 7)).toEqual({ line: 2, column: 3 });
    expect(lineColumn('SUM(', 4)).toEqual({ line: 1, column: 5 });
  });
});

describe('formulaContext', () => {
  it('resolves each [Name] in its table', () => {
    const { names } = formulaContext(
      '[Đơn hàng].FILTER(CurrentValue.[Khách hàng].CONTAIN([Tên khách hàng])).[Tổng tiền].SUM()',
      SCHEMA,
    );
    expect(names.map((name) => [name.name, name.kind, name.tableId])).toEqual([
      ['Đơn hàng', 'table', ORDERS],
      ['Khách hàng', 'field', ORDERS],
      ['Tên khách hàng', 'field', CUSTOMERS],
      ['Tổng tiền', 'field', ORDERS],
    ]);
  });

  it('prefers a field of the current table over a table of the same name', () => {
    const [ref] = formulaContext('[Trạng thái]', SCHEMA).names;
    expect(ref?.kind).toBe('field');
    expect(ref?.tableId).toBe(CUSTOMERS);
  });

  it('knows CurrentValue and the open calls at the end', () => {
    const context = formulaContext('[Đơn hàng].FILTER(CurrentValue', SCHEMA);
    expect(context.current).toEqual({ tableId: ORDERS, fromTable: true });
    expect(context.open.map((call) => [call.name, call.argument, call.chained])).toEqual([
      ['FILTER', 1, true],
    ]);
    expect(formulaContext('SUM(', SCHEMA).current).toBeNull();
    expect(formulaContext('LIST(1, 2).FILTER(', SCHEMA).current).toBe('value');
  });

  it('collects LET variables', () => {
    expect(formulaContext('LET(rate, 0.1, total, [Số đơn] * rate, ', SCHEMA).variables).toEqual([
      'rate',
      'total',
    ]);
  });
});

describe('matchLabel', () => {
  it.each([
    ['Trạng thái', 'Tr', 0, [0, 2]],
    ['Trạng thái', 'trang', 0, [0, 5]],
    ['Trạng thái', 'thai', 1, [6, 10]],
    ['Đơn hàng', 'don', 0, [0, 3]],
    ['Chi tiết trả hàng', 'tra', 1, [9, 12]],
  ] as const)('%s ~ %s', (label, query, rank, range) => {
    expect(matchLabel(label, query)).toEqual({ rank, range });
  });

  it('refuses what does not match', () => {
    expect(matchLabel('Số đơn', 'xyz')).toBeNull();
  });
});

describe('suggest', () => {
  const labels = (source: string, pos = source.length, explicit = false) =>
    suggest(source, pos, SCHEMA, explicit)?.items.map((item) => `${item.kind}:${item.label}`);

  it('offers fields of the current table first, then tables (decision #3)', () => {
    const result = suggest('IF([Tr', 6, SCHEMA, false);
    expect(result?.from).toBe(3);
    expect(result?.items.map((item) => `${item.kind}:${item.label}`)).toEqual([
      'field:Trạng thái',
      'field:Trưởng nhóm',
      'field:Ngày trở lại',
      'table:Trả hàng',
    ]);
    expect(result?.items[0]?.apply).toBe('[Trạng thái]');
  });

  it('offers the fields of [Table]. then the functions taking a table', () => {
    const items = labels('[Đơn hàng].');
    expect(items?.slice(0, 5)).toEqual([
      'field:Mã đơn',
      'field:Khách hàng',
      'field:Trạng thái',
      'field:Tổng tiền',
      'field:Ngày đặt',
    ]);
    expect(items).toContain('function:FILTER');
    expect(items).toContain('function:COUNTIF');
    expect(items).not.toContain('function:UPPER');
  });

  it('offers the fields of the range after CurrentValue. inside FILTER', () => {
    expect(labels('[Đơn hàng].FILTER(CurrentValue.[')).toEqual([
      'field:Mã đơn',
      'field:Khách hàng',
      'field:Trạng thái',
      'field:Tổng tiền',
      'field:Ngày đặt',
    ]);
  });

  it('inserts a table with a dot and asks again', () => {
    const table = suggest('[Đơn', 4, SCHEMA, false)?.items.find((item) => item.kind === 'table');
    expect(table?.apply).toBe('[Đơn hàng].');
    expect(table?.reopen).toBe(true);
  });

  it('inserts a function with its parentheses and the caret inside', () => {
    const item = suggest('SU', 2, SCHEMA, false)?.items.find((entry) => entry.label === 'SUM');
    expect(item?.apply).toBe('SUM()');
    expect(item?.caret).toBe(4);
    const today = suggest('TOD', 3, SCHEMA, false)?.items.find((entry) => entry.label === 'TODAY');
    expect(today?.caret).toBe(7);
  });

  it('matches without accents', () => {
    expect(labels('[trang')).toEqual(['field:Trạng thái']);
  });

  it('stays quiet in text, after a value and without typing', () => {
    expect(suggest('"Tr', 3, SCHEMA, false)).toBeNull();
    expect(suggest('[Số đơn] ', 9, SCHEMA, false)).toBeNull();
    expect(suggest('1 + ', 4, SCHEMA, false)).toBeNull();
    expect(suggest('1 + ', 4, SCHEMA, true)?.items.length).toBeGreaterThan(10);
  });

  it('offers CurrentValue inside an iteration only', () => {
    expect(labels('[Đơn hàng].FILTER(Cur')).toContain('variable:CurrentValue');
    expect(labels('SUM(Cur')).not.toContain('variable:CurrentValue');
  });
});

describe('activeSignature', () => {
  const text = (source: string) =>
    activeSignature(source, source.length, SCHEMA, 'en')
      ?.parts.map((part) => (part.active ? `<${part.text}>` : part.text))
      .join('');

  it.each([
    ['IF(', 'IF(<condition>, value_if_true, [value_if_false])'],
    ['IF([Số đơn] > 1, ', 'IF(condition, <value_if_true>, [value_if_false])'],
    ['[Đơn hàng].FILTER(', 'range.FILTER(<condition>)'],
    ['SUM(1, 2, ', 'SUM(<number>, …)'],
  ])('%s', (source, expected) => {
    expect(text(source)).toBe(expected);
  });

  it('is absent outside a call', () => {
    expect(activeSignature('1 + 2', 5, SCHEMA, 'en')).toBeNull();
  });
});

describe('analyzeFormula', () => {
  it('places the error of an unclosed call at the end', () => {
    const result = analyzeFormula('SUM(', SCHEMA);
    expect(result.diagnostics).toEqual([
      {
        start: 4,
        length: 0,
        code: 'UNEXPECTED_END',
        params: { function: 'SUM' },
        line: 1,
        column: 5,
      },
    ]);
    expect(result.resultType).toBeNull();
  });

  it('types a same-row formula and keeps it in the browser', () => {
    const result = analyzeFormula('IF([Trạng thái] = "Xong", [Doanh thu] * 0.1, 0)', SCHEMA);
    expect(result.diagnostics).toEqual([]);
    expect(result.resultType).toEqual({ kind: 'number', list: false });
    expect(result.analysis.style).toEqual({ type: 'currency', currency_code: 'VND' });
    expect(result.sameRow).toBe(true);
    expect(result.dependencies.map((item) => item.fields)).toEqual([['Trạng thái', 'Doanh thu']]);
  });

  it.each([
    'REGEXMATCH([Tên khách hàng], "^(a+)+$")',
    'IF(REGEXEXTRACT([Tên khách hàng], "\\d+") = "1", 1, 0)',
    'REGEXREPLACE([Tên khách hàng], "([a-z]+ ?)+", "x")',
  ])('T470: a regular expression is previewed by the server, not the tab: %s', (source) => {
    const result = analyzeFormula(source, SCHEMA);
    expect(result.diagnostics).toEqual([]);
    expect(result.sameRow).toBe(false);
  });

  it('T470: a 4,000-character flat sum is analysed without overflowing', () => {
    const source = Array.from({ length: 2000 }, () => '1').join('+');
    const result = analyzeFormula(source, SCHEMA);
    expect(result.diagnostics).toEqual([]);
    expect(result.sameRow).toBe(true);
  });

  it('reports a type error where it is', () => {
    const result = analyzeFormula('SUM([Số đơn] + [Tên khách hàng])', SCHEMA);
    expect(result.diagnostics[0]?.code).toBe('TYPE_MISMATCH');
    expect(result.diagnostics[0]?.start).toBe(15);
  });

  it('sends formulas reading other tables to the server', () => {
    const result = analyzeFormula(
      '[Đơn hàng].FILTER(CurrentValue.[Khách hàng].CONTAIN([Tên khách hàng])).[Tổng tiền].SUM()',
      SCHEMA,
    );
    expect(result.sameRow).toBe(false);
    expect(result.perfWarning).toBe(false);
    expect(result.crossTableFilters).toBe(1);
  });

  it.each([
    // No link, and a function wrapped around CurrentValue.[col] (decision #5).
    ['[Đơn hàng].FILTER(YEAR(CurrentValue.[Ngày đặt]) = 2026).[Tổng tiền].SUM()', true],
    // No link, virtual (TODAY()).
    ['[Đơn hàng].FILTER(CurrentValue.[Ngày đặt] >= TODAY()).[Tổng tiền].SUM()', true],
    // No link, plain comparison, stored: fast enough.
    ['[Đơn hàng].FILTER(CurrentValue.[Trạng thái] = "Xong").[Tổng tiền].SUM()', false],
  ])('warns about slow cross-table scans: %s', (source, warning) => {
    expect(analyzeFormula(source, SCHEMA).perfWarning).toBe(warning);
  });

  it('explains virtual fields', () => {
    const result = analyzeFormula('DAYS(TODAY(), [Ngày trở lại])', SCHEMA);
    expect(result.analysis.compute_mode).toBe('virtual');
    expect(result.analysis.virtual_reason).toEqual({
      kind: 'volatile_function',
      function: 'TODAY',
    });
  });
});

describe('evaluateRows', () => {
  const record = (key: string, fields: Record<string, unknown>): RecordDto =>
    ({
      id: id('rec', key),
      version: 1,
      created_at: '2026-09-01T00:00:00.000Z',
      updated_at: '2026-09-01T00:00:00.000Z',
      fields,
    }) as unknown as RecordDto;

  it('computes each row, option names included', () => {
    const editor = analyzeFormula('IF([Trạng thái] = "Xong", [Doanh thu] * 0.1, 0)', SCHEMA);
    const rows = evaluateRows(
      editor,
      [
        record('a', {
          [id('fld', 'CustName')]: 'An',
          [id('fld', 'CustStatus')]: DONE,
          [id('fld', 'CustRevenue')]: 1500000,
        }),
        record('b', {
          [id('fld', 'CustName')]: 'Bình',
          [id('fld', 'CustStatus')]: OPEN,
          [id('fld', 'CustRevenue')]: 10,
        }),
      ],
      id('fld', 'CustName'),
      'Asia/Ho_Chi_Minh',
      new Date('2026-09-28T00:00:00Z'),
    );
    expect(rows.map((row) => [row.title, row.value])).toEqual([
      ['An', '150000'],
      ['Bình', '0'],
    ]);
  });

  it('leaves a row empty when it errs', () => {
    const editor = analyzeFormula('[Doanh thu] / [Số đơn]', SCHEMA);
    const rows = evaluateRows(
      editor,
      [record('a', { [id('fld', 'CustRevenue')]: 10, [id('fld', 'CustCount')]: 0 })],
      null,
      'UTC',
      new Date(),
    );
    expect(rows[0]?.value).toBeNull();
  });
});
