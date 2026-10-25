import { describe, expect, it } from 'vitest';

import { AppError } from '../../src/errors/index.js';
import {
  canonicalColumnOf,
  dataTableName,
  ddlRetryDelayMs,
  deletedColumnName,
  effectiveMaxFields,
  fieldColumnName,
  indexName,
  isRetryableDdlError,
  normalizeSchemaName,
  renamePrefixed,
  schemaLockKey,
  slotDecision,
} from '../../src/schema/index.js';

describe('physical names', () => {
  it('builds t_/f_ names from lowercase base36 short ids only', () => {
    expect(dataTableName('abc123def456')).toBe('t_abc123def456');
    expect(fieldColumnName('000000000000')).toBe('f_000000000000');
    expect(dataTableName()).toMatch(/^t_[0-9a-z]{12}$/);
    expect(fieldColumnName()).toMatch(/^f_[0-9a-z]{12}$/);
    for (const bad of ['ABC123DEF456', 'abc', 'abc123def456x', 'abc"; drop--', '']) {
      expect(() => dataTableName(bad)).toThrow(TypeError);
      expect(() => fieldColumnName(bad)).toThrow(TypeError);
    }
  });

  it.each([
    { at: '1970-01-01T00:00:00Z', expected: 'f_abc123def456__deleted_0' },
    { at: '2026-09-23T10:00:00.999Z', expected: 'f_abc123def456__deleted_1790157600' },
  ])('deleted column name at $at', ({ at, expected }) => {
    const name = deletedColumnName('f_abc123def456', new Date(at));
    expect(name).toBe(expected);
    expect(canonicalColumnOf(name)).toBe('f_abc123def456');
  });

  it('rejects malformed column names', () => {
    expect(() => deletedColumnName('f_x"', new Date())).toThrow(TypeError);
    expect(() => canonicalColumnOf('f_abc123def456')).toThrow(TypeError);
    expect(() => canonicalColumnOf('f_abc123def456__deleted_x')).toThrow(TypeError);
  });

  it('prefixes index names with the table and renames them after compaction', () => {
    const name = indexName('t_aaaaaaaaaaaa', 'f_bbbbbbbbbbbb_trgm');
    expect(name).toBe('t_aaaaaaaaaaaa_f_bbbbbbbbbbbb_trgm');
    expect(name.length).toBeLessThanOrEqual(63);
    expect(renamePrefixed(name, 't_aaaaaaaaaaaa', 't_cccccccccccc')).toBe(
      't_cccccccccccc_f_bbbbbbbbbbbb_trgm',
    );
    expect(() => renamePrefixed(name, 't_cccccccccccc', 't_aaaaaaaaaaaa')).toThrow(TypeError);
    expect(() => indexName('users', 'created_at_idx')).toThrow(TypeError);
  });
});

describe('slot budget (ADR-20)', () => {
  it.each([
    { used: 10, consumed: 1, expected: 'ok' },
    { used: 1398, consumed: 1, expected: 'ok' },
    { used: 1399, consumed: 1, expected: 'compact' },
    { used: 1400, consumed: 1, expected: 'compact' },
    { used: 1549, consumed: 1, expected: 'compact' },
    { used: 1550, consumed: 1, expected: 'locked' },
    { used: 1599, consumed: 1, expected: 'compact' },
    { used: 1600, consumed: 1, expected: 'locked' },
  ] as const)('$used used + $consumed → $expected', ({ used, consumed, expected }) => {
    const decision = slotDecision(used, consumed);
    // 1599 is above the lock threshold: locked wins.
    expect(decision).toBe(used >= 1550 ? 'locked' : expected);
  });

  it('honours custom thresholds and the PostgreSQL hard limit', () => {
    expect(slotDecision(20, 1, { compact: 20, lock: 30 })).toBe('compact');
    expect(slotDecision(30, 1, { compact: 20, lock: 30 })).toBe('locked');
    expect(slotDecision(1500, 200, { compact: 2000, lock: 2000 })).toBe('locked');
  });

  it('caps MAX_FIELDS_PER_TABLE at 1000', () => {
    expect(effectiveMaxFields(500)).toBe(500);
    expect(effectiveMaxFields(1600)).toBe(1000);
    expect(() => effectiveMaxFields(0)).toThrow(RangeError);
  });
});

describe('DDL retry policy', () => {
  it.each([
    { code: '55P03', retry: true },
    { code: '40001', retry: true },
    { code: '40P01', retry: true },
    { code: '23505', retry: false },
    { code: '57014', retry: false },
  ])('SQLSTATE $code → retry $retry', ({ code, retry }) => {
    expect(isRetryableDdlError(Object.assign(new Error('x'), { code }))).toBe(retry);
  });

  it('does not retry non-database errors', () => {
    expect(isRetryableDdlError(new AppError('SCHEMA_LOCKED'))).toBe(false);
    expect(isRetryableDdlError(null)).toBe(false);
  });

  it('backs off linearly with bounded jitter', () => {
    expect(ddlRetryDelayMs(1, () => 0)).toBe(50);
    expect(ddlRetryDelayMs(2, () => 0)).toBe(100);
    expect(ddlRetryDelayMs(1, () => 0.999)).toBe(149);
    expect(ddlRetryDelayMs(1, () => 5)).toBeLessThan(150);
  });

  it('keys the advisory lock by table id', () => {
    expect(schemaLockKey('tbl_A1b2C3d4E5f6G7h8')).toBe('schema:tbl_A1b2C3d4E5f6G7h8');
  });
});

describe('normalizeSchemaName', () => {
  it.each([
    { input: '  Khách hàng  ', expected: 'Khách hàng' },
    { input: 'a"b; DROP TABLE x; --', expected: 'a"b; DROP TABLE x; --' },
    { input: 'Café', expected: 'Café' },
    { input: '😀', expected: '😀' },
  ])('keeps $input as data', ({ input, expected }) => {
    expect(normalizeSchemaName(input)).toBe(expected);
  });

  it.each(['', '   ', 'x'.repeat(256), 'a\u0000b', 'tab\tname', 42])(
    'rejects %j with VALIDATION_FAILED',
    (input) => {
      expect(() => normalizeSchemaName(input)).toThrow(
        expect.objectContaining({ code: 'VALIDATION_FAILED' }),
      );
    },
  );
});
