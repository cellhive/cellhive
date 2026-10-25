import { describe, expect, it } from 'vitest';

import {
  FieldValueError,
  MULTI_VALUE_OPERATORS,
  parentFieldType,
  parentIdOf,
  parentOptionsSchema,
  RELATION_FIELD_TYPES,
  SUBRECORD_MAX_DEPTH,
} from '../src/index.js';

const vi = { locale: 'vi', timeZone: 'Asia/Ho_Chi_Minh' };
const options = parentOptionsSchema.parse({});

const A = 'rec_AAAAAAAAAAAAAAA1';

describe('parent options', () => {
  it('has no options', () => {
    expect(options).toEqual({});
    expect(parentOptionsSchema.safeParse({ link_table: 'tbl_x' }).success).toBe(false);
  });

  it('is a relation type with a depth limit of 10 levels', () => {
    expect(RELATION_FIELD_TYPES.parent).toBe(parentFieldType);
    expect(SUBRECORD_MAX_DEPTH).toBe(10);
    expect(parentFieldType.filterOperators(options)).toBe(MULTI_VALUE_OPERATORS);
  });
});

describe('parent validate', () => {
  it.each([[A], [{ id: A }], [{ id: A, title: 'ignored' }], [null]])('accepts %j', (value) => {
    expect(parentFieldType.validate(value, options)).toEqual({ ok: true });
  });

  it.each([
    ['rec_bad', 'INVALID_RECORD_ID'],
    [{ id: 'x' }, 'INVALID_RECORD_ID'],
    [{ title: 'Task' }, 'INVALID_RECORD_ID'],
    [[A], 'EXPECTED_STRING'],
    [42, 'EXPECTED_STRING'],
    [true, 'EXPECTED_STRING'],
  ])('rejects %j', (value, code) => {
    const result = parentFieldType.validate(value, options);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.code).toBe(code);
  });
});

describe('parent typecast', () => {
  it.each([
    [null, null],
    [undefined, null],
    ['', null],
    ['  ', null],
    [[], null],
    [A, { id: A }],
    [` ${A} `, { id: A }],
    [{ id: A }, { id: A }],
    [[A], { id: A }],
    ['Task 1', { title: 'Task 1' }],
    ['Task 1, Task 2', { title: 'Task 1, Task 2' }],
    [42, { title: '42' }],
  ])('%j', (input, expected) => {
    expect(parentFieldType.typecast(input, options, vi)).toEqual({
      ok: true,
      value: expected,
      unknownOptions: [],
    });
  });

  it.each([
    [[A, A], 'TOO_MANY_VALUES'],
    [true, 'INVALID_RECORD_ID'],
    [{ id: 'rec_bad' }, 'INVALID_RECORD_ID'],
  ])('rejects %j', (input, code) => {
    const result = parentFieldType.typecast(input, options, vi);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.code).toBe(code);
  });
});

describe('parent storage and text', () => {
  it('stores the id', () => {
    expect(parentFieldType.toStorage(A, options)).toBe(A);
    expect(parentFieldType.toStorage({ id: A }, options)).toBe(A);
    expect(parentFieldType.toStorage(null, options)).toBeNull();
    expect(parentIdOf({ id: A })).toBe(A);
    expect(parentIdOf(undefined)).toBeNull();
    expect(() => parentFieldType.toStorage('rec_bad', options)).toThrow(FieldValueError);
  });

  it('reads the ref the server assembled', () => {
    expect(parentFieldType.fromStorage(null, options)).toBeNull();
    expect(parentFieldType.fromStorage({ id: A, title: 'Task' }, options)).toEqual({
      id: A,
      title: 'Task',
    });
    expect(parentFieldType.fromStorage({ id: A }, options)).toEqual({ id: A, title: null });
    expect(parentFieldType.fromStorage({ bad: true }, options)).toBeNull();
  });

  it('formats a readable title only', () => {
    expect(parentFieldType.formatText({ id: A, title: 'Task' }, options, vi)).toBe('Task');
    expect(parentFieldType.formatText({ id: A, title: null }, options, vi)).toBe('');
    expect(parentFieldType.formatText(null, options, vi)).toBe('');
  });
});
