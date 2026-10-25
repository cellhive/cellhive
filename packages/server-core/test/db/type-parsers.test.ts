import pg from 'pg';
import { describe, expect, it } from 'vitest';

import { isStatementTimeout, OID, sqlStateOf, typeParsers } from '../../src/db/index.js';

function parse(oid: number, text: string): unknown {
  const getTypeParser = typeParsers.getTypeParser as (
    oid: number,
    format: 'text',
  ) => (value: string) => unknown;
  return getTypeParser(oid, 'text')(text);
}

describe('typeParsers', () => {
  const cases: { name: string; oid: number; text: string; expected: unknown }[] = [
    {
      name: 'date stays a calendar string',
      oid: OID.date,
      text: '2026-01-31',
      expected: '2026-01-31',
    },
    {
      name: 'date[] stays strings',
      oid: OID.dateArray,
      text: '{2026-01-31,NULL}',
      expected: ['2026-01-31', null],
    },
    { name: 'int8 → bigint', oid: OID.int8, text: '9007199254740993', expected: 9007199254740993n },
    { name: 'negative int8', oid: OID.int8, text: '-42', expected: -42n },
    {
      name: 'int8[] → bigint[]',
      oid: OID.int8Array,
      text: '{1,NULL,9007199254740993}',
      expected: [1n, null, 9007199254740993n],
    },
    {
      name: 'numeric keeps every digit',
      oid: OID.numeric,
      text: '0.1000000000000000000001',
      expected: '0.1000000000000000000001',
    },
    { name: 'int4 unchanged (number)', oid: 23, text: '42', expected: 42 },
    { name: 'bool unchanged', oid: 16, text: 't', expected: true },
    { name: 'jsonb unchanged (parsed)', oid: 3802, text: '{"a":[1]}', expected: { a: [1] } },
  ];

  it.each(cases)('$name', ({ oid, text, expected }) => {
    expect(parse(oid, text)).toEqual(expected);
  });

  it('does not change the process-wide pg parsers', () => {
    const getTypeParser = pg.types.getTypeParser as (
      oid: number,
      format: 'text',
    ) => (value: string) => unknown;
    expect(getTypeParser(OID.int8, 'text')('1')).toBe('1');
  });
});

describe('pg errors', () => {
  it.each([
    [{ code: '57014', message: 'canceling statement due to statement timeout' }, true],
    [{ code: '57014', message: 'canceling statement due to user request' }, false],
    [{ code: '23505', message: 'duplicate key' }, false],
    [new Error('statement timeout'), false],
    [null, false],
  ])('isStatementTimeout(%j) → %s', (error, expected) => {
    expect(isStatementTimeout(error)).toBe(expected);
  });

  it('sqlStateOf reads only SQLSTATE-shaped codes', () => {
    expect(sqlStateOf({ code: '23505' })).toBe('23505');
    expect(sqlStateOf({ code: 'ECONNREFUSED' })).toBeUndefined();
    expect(sqlStateOf('23505')).toBeUndefined();
  });
});
