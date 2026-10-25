import { describe, expect, it } from 'vitest';

import {
  BASE36_ALPHABET,
  BASE62_ALPHABET,
  ID_PREFIX,
  ID_PREFIXES,
  idOf,
  idPrefixSchema,
  isId,
  isShortId,
  newId,
  newShortId,
} from '../src/ids.js';

/** Every prefix listed in CONTRACTS §1.2. */
// prettier-ignore
const CONTRACT_PREFIXES = [
  'org', 'usr', 'grp', 'wsp', 'bse', 'tbl', 'fld', 'rec', 'opt', 'tok', 'sec', 'req', 'ses', 'inv',
  'hal', 'viw', 'rol', 'dsh', 'wgt', 'aut', 'run', 'stp', 'evt', 'att', 'shl', 'hok', 'job', 'aud',
  'idn', 'pwr', 'imp', 'ntf', 'eid', 'uch', 'whr', 'hdl', 'clr',
] as const;

describe('ID prefixes', () => {
  it.each(CONTRACT_PREFIXES)('includes %s', (prefix) => {
    expect(ID_PREFIXES).toContain(prefix);
    expect(idPrefixSchema.safeParse(prefix).success).toBe(true);
  });

  it('has no prefix outside CONTRACTS §1.2 and no duplicates', () => {
    expect([...ID_PREFIXES].sort()).toEqual([...CONTRACT_PREFIXES].sort());
    expect(new Set(Object.values(ID_PREFIX)).size).toBe(ID_PREFIXES.length);
  });
});

describe('newId', () => {
  it.each(CONTRACT_PREFIXES)('generates <%s>_<16 base62>', (prefix) => {
    const id = newId(prefix);
    expect(id).toMatch(new RegExp(`^${prefix}_[0-9A-Za-z]{16}$`));
    expect(isId(prefix, id)).toBe(true);
    expect(idOf(prefix).parse(id)).toBe(id);
  });

  it('generates 10,000 unique, valid IDs', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      const id = newId('rec');
      expect(isId('rec', id)).toBe(true);
      ids.add(id);
    }
    expect(ids.size).toBe(10_000);
  });

  it('only uses the base62 alphabet and covers all of it', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2_000; i++) {
      for (const char of newId('tbl').slice(4)) seen.add(char);
    }
    // BASE62_ALPHABET is in ASCII order, as is a sorted list of the characters seen.
    expect([...seen].sort().join('')).toBe(BASE62_ALPHABET);
  });
});

describe('isId / idOf', () => {
  const valid = 'tbl_A1b2C3d4E5f6G7h8';
  const cases: { name: string; value: unknown; ok: boolean }[] = [
    { name: 'valid table ID', value: valid, ok: true },
    { name: 'field prefix', value: 'fld_A1b2C3d4E5f6G7h8', ok: false },
    { name: 'no prefix', value: 'A1b2C3d4E5f6G7h8', ok: false },
    { name: 'upper-case prefix', value: 'TBL_A1b2C3d4E5f6G7h8', ok: false },
    { name: '15 characters', value: 'tbl_A1b2C3d4E5f6G7h', ok: false },
    { name: '17 characters', value: 'tbl_A1b2C3d4E5f6G7h8x', ok: false },
    { name: 'hyphen (not base62)', value: 'tbl_A1b2C3d4E5f6G7-8', ok: false },
    { name: 'underscore in body', value: 'tbl_A1b2C3d4E5f6G7_8', ok: false },
    { name: 'non-ASCII letter', value: 'tbl_A1b2C3d4E5f6G7hđ', ok: false },
    { name: 'leading whitespace', value: ` ${valid}`, ok: false },
    { name: 'trailing newline', value: `${valid}\n`, ok: false },
    { name: 'empty string', value: '', ok: false },
    { name: 'number', value: 42, ok: false },
    { name: 'null', value: null, ok: false },
  ];

  it.each(cases)('$name → $ok', ({ value, ok }) => {
    expect(isId('tbl', value)).toBe(ok);
    expect(idOf('tbl').safeParse(value).success).toBe(ok);
  });

  it("idOf('tbl') rejects a field ID with a readable message", () => {
    const result = idOf('tbl').safeParse(newId('fld'));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('tbl_');
  });
});

describe('newShortId', () => {
  it('generates 12 lower-case base36 characters', () => {
    for (let i = 0; i < 1_000; i++) {
      const id = newShortId();
      expect(id).toMatch(/^[0-9a-z]{12}$/);
      expect(isShortId(id)).toBe(true);
    }
  });

  it('generates 10,000 unique short IDs', () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => newShortId()));
    expect(ids.size).toBe(10_000);
  });

  it('covers the whole base36 alphabet', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1_000; i++) for (const char of newShortId()) seen.add(char);
    expect(seen.size).toBe(BASE36_ALPHABET.length);
  });

  it.each(['ABCDEFGHIJKL', 'abc', 'abcdefghijklm', 'abcdef_ghijk'])('rejects %s', (value) => {
    expect(isShortId(value)).toBe(false);
  });
});
