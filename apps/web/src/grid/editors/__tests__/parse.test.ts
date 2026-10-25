import { fieldConfigSchema, type FieldConfig } from '@cellhive/field-types';
import { describe, expect, it } from 'vitest';

import {
  datetimeDraft,
  datetimeInputText,
  formatLocale,
  matchesSearch,
  numberDraft,
  numberInputText,
  selectDraft,
  selectedNames,
  selectedUsers,
  textDraft,
  userDraft,
  valueOfWallTime,
  wallTimeOf,
} from '../parse';

import type { EditorDraft } from '../types';

/** Parsed, defaulted options of a type (typed loosely: each test passes them to its type). */
function optionsOf(type: FieldConfig['type'], options: unknown = {}): never {
  return fieldConfigSchema.parse({ type, options }).options as never;
}

const vi = { locale: 'vi', timeZone: 'Asia/Ho_Chi_Minh' };
const en = { locale: 'en-US', timeZone: 'UTC' };

function value(draft: EditorDraft): unknown {
  if (!draft.ok) throw new Error(`expected a value, got ${draft.issue.code}`);
  return draft.commit.value;
}

function issue(draft: EditorDraft): string {
  if (draft.ok) throw new Error('expected an issue');
  return draft.issue.code;
}

describe('textDraft', () => {
  const plain = optionsOf('text');
  it.each([
    ['abc', 'abc'],
    ['  keeps spaces ', '  keeps spaces '],
    ['line 1\nline 2', 'line 1\nline 2'],
    ['', null],
  ])('%j → %j', (input, expected) => {
    expect(value(textDraft(input, plain))).toBe(expected);
  });
});

describe('numberDraft (typecast semantics in the user locale)', () => {
  const plain = optionsOf('number');
  const vnd = optionsOf('number', { style: { type: 'currency', currency_code: 'VND' } });
  const percent = optionsOf('number', { style: { type: 'plain', percentage: true } });
  const progress = optionsOf('number', { style: { type: 'progress' } });

  it.each([
    ['vi grouping', '1.500.000', plain, vi, 1_500_000],
    ['vi decimal comma', '1,5', plain, vi, 1.5],
    ['en grouping', '1,500.25', plain, en, 1500.25],
    ['currency sign', '1.500.000 ₫', vnd, vi, 1_500_000],
    ['negative', '-42', plain, en, -42],
    ['empty is empty', '   ', plain, en, null],
    ['percent field, plain number is a percent', '20', percent, en, 0.2],
    ['percent field with %', '20%', percent, en, 0.2],
    ['percent field, decimals stay exact', '7', percent, en, 0.07],
    ['progress (percentage by default)', '55', progress, en, 0.55],
  ] as const)('%s: %j', (_name, input, options, ctx, expected) => {
    expect(value(numberDraft(input, options, ctx))).toBe(expected);
  });

  it.each([['abc'], ['12abc'], ['1 2 3'], ['--1']])('refuses %j before any request', (input) => {
    expect(issue(numberDraft(input, plain, en))).toBe('EXPECTED_NUMBER');
  });

  it.each([
    [1_500_000, plain, 'vi', '1500000'],
    [1.5, plain, 'vi', '1,5'],
    [1.5, plain, 'en-US', '1.5'],
    [0.2, percent, 'en-US', '20'],
    [0.07, percent, 'en-US', '7'],
    [null, plain, 'en-US', ''],
  ] as const)('input text of %j', (stored, options, locale, expected) => {
    expect(numberInputText(stored, options, locale)).toBe(expected);
  });
});

describe('datetime', () => {
  const dayFirst = optionsOf('datetime', { style: { format: 'dd/MM/yyyy' } });
  const monthFirst = optionsOf('datetime', { style: { format: 'MM/dd/yyyy' } });
  const withTime = optionsOf('datetime', {
    style: { format: 'dd/MM/yyyy HH:mm' },
    timezone: 'Asia/Ho_Chi_Minh',
  });

  it('reads dates in the field format whatever the UI language', () => {
    expect(formatLocale(dayFirst, 'en-US')).toBe('en-GB');
    expect(formatLocale(monthFirst, 'vi')).toBe('en-US');
    expect(value(datetimeDraft('25/09/2026', dayFirst, en))).toBe('2026-09-25');
    expect(value(datetimeDraft('09/25/2026', monthFirst, vi))).toBe('2026-09-25');
    expect(value(datetimeDraft('2026-09-25', dayFirst, en))).toBe('2026-09-25');
  });

  it('reads a time in the field zone', () => {
    expect(value(datetimeDraft('25/09/2026 09:00', withTime, en))).toBe('2026-09-25T02:00:00.000Z');
    expect(datetimeInputText('2026-09-25T02:00:00.000Z', withTime, en)).toBe('25/09/2026 09:00');
  });

  it.each([
    ['not a date', dayFirst, 'EXPECTED_DATE'],
    ['31/02/2026', dayFirst, 'EXPECTED_DATE'],
    ['tomorrow', withTime, 'EXPECTED_DATETIME'],
  ] as const)('refuses %j', (input, options, code) => {
    expect(issue(datetimeDraft(input, options, en))).toBe(code);
  });

  it('empty text clears the cell', () => {
    expect(value(datetimeDraft('', dayFirst, en))).toBeNull();
  });

  it('converts calendar picks back and forth', () => {
    const wall = wallTimeOf('2026-09-25T02:00:00.000Z', withTime, en);
    expect(wall).toMatchObject({ year: 2026, month: 9, day: 25, hour: 9, minute: 0 });
    if (wall === null) return;
    expect(valueOfWallTime(wall, withTime, en)).toBe('2026-09-25T02:00:00.000Z');
    expect(valueOfWallTime(wall, dayFirst, en)).toBe('2026-09-25');
    expect(wallTimeOf('2026-09-25', dayFirst, en)).toMatchObject({ year: 2026, day: 25 });
    expect(wallTimeOf(42, dayFirst, en)).toBeNull();
  });
});

describe('selectDraft', () => {
  const options = [
    { id: 'opt_New0000000000001', name: 'Mới' },
    { id: 'opt_Done000000000001', name: 'Xong' },
  ];
  const single = optionsOf('select', { options });
  const multiple = optionsOf('select', { options, multiple: true });

  it('writes option names', () => {
    expect(value(selectDraft(['Mới'], single, false))).toBe('Mới');
    expect(value(selectDraft([], single, false))).toBeNull();
    expect(value(selectDraft(['Mới', 'Xong', 'Mới'], multiple, false))).toEqual(['Mới', 'Xong']);
    expect(value(selectDraft([], multiple, false))).toBeNull();
  });

  it('a new option needs the right to edit options, and is sent with typecast', () => {
    expect(issue(selectDraft(['Mới lạ'], single, false))).toBe('INVALID_SELECT_OPTION');
    const draft = selectDraft(['Mới lạ'], single, true);
    expect(draft).toEqual({
      ok: true,
      commit: { value: 'Mới lạ', display: 'Mới lạ', typecast: true },
    });
  });

  it('reads json values', () => {
    expect(selectedNames('Mới')).toEqual(['Mới']);
    expect(selectedNames(['A', 3, 'B'])).toEqual(['A', 'B']);
    expect(selectedNames(null)).toEqual([]);
  });
});

describe('userDraft', () => {
  const lan = { id: 'usr_Lan0000000000001', name: 'Phạm Ngọc Lan', email: 'lan@x.vn' };
  const huy = { id: 'usr_Huy0000000000001', name: 'Võ Đức Huy', email: 'huy@x.vn' };

  it('writes ids and shows names at once', () => {
    const draft = userDraft([lan, lan, huy], optionsOf('user'));
    expect(draft).toEqual({
      ok: true,
      commit: { value: [{ id: lan.id }, { id: huy.id }], display: [lan, huy], typecast: false },
    });
    expect(value(userDraft([], optionsOf('user')))).toBeNull();
  });

  it('refuses two users in a single-user field', () => {
    expect(issue(userDraft([lan, huy], optionsOf('user', { multiple: false })))).toBe(
      'TOO_MANY_VALUES',
    );
  });

  it('reads json values, former members without a name', () => {
    expect(selectedUsers([{ id: lan.id, name: lan.name }, { id: huy.id }, 'x'])).toEqual([
      { id: lan.id, name: lan.name, email: '' },
      { id: huy.id, name: '', email: '' },
    ]);
  });
});

describe('matchesSearch', () => {
  it.each([
    ['Đang xử lý', 'dang xu', true],
    ['Đang xử lý', 'XỬ LÝ', true],
    ['Phạm Ngọc Lan', 'ngoc', true],
    ['Mới', 'xong', false],
    ['anything', '', true],
  ])('%j contains %j: %s', (text, search, expected) => {
    expect(matchesSearch(text, search)).toBe(expected);
  });
});
