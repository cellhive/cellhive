import { describe, expect, it } from 'vitest';

import {
  createdAtFieldType,
  createdByFieldType,
  DATETIME_OPERATORS,
  FieldValueError,
  MULTI_VALUE_OPERATORS,
  systemTimeOptionsSchema,
  systemUserOptionsSchema,
  updatedAtFieldType,
  updatedByFieldType,
  type UserRef,
} from '../src/index.js';

const vi = { locale: 'vi', timeZone: 'Asia/Ho_Chi_Minh' };
const en = { locale: 'en-US', timeZone: 'America/New_York' };
const A = 'usr_AAAAAAAAAAAAAAA1';
const people: Record<string, UserRef> = { [A]: { id: A, name: 'Nguyễn A', email: 'a@x.vn' } };
const readCtx = { resolveUser: (id: string) => people[id] };

describe.each([
  [createdAtFieldType, 'created_at', '__created_at'],
  [updatedAtFieldType, 'updated_at', '__updated_at'],
] as const)('%s', (definition, type, column) => {
  const options = systemTimeOptionsSchema.parse({});

  it('metadata', () => {
    expect(definition.type).toBe(type);
    expect(definition.readOnly).toBe(true);
    expect(definition.supportsDefaultValue).toBe(false);
    expect(definition.systemColumn).toBe(column);
    expect(definition.pgType(options, { collation: 'und-x-icu' })).toBeNull();
    expect(definition.filterOperators(options)).toEqual(DATETIME_OPERATORS);
    expect(options).toEqual({ style: { format: 'yyyy-MM-dd HH:mm' } });
  });

  it('options', () => {
    expect(systemTimeOptionsSchema.safeParse({ timezone: 'Asia/Ho_Chi_Minh' }).success).toBe(true);
    expect(systemTimeOptionsSchema.safeParse({ default_value: 'x' }).success).toBe(false);
    expect(systemTimeOptionsSchema.safeParse({ timezone: 'Nope/Nope' }).success).toBe(false);
  });

  it('is read-only on every write path', () => {
    expect(definition.validate('2026-09-25T02:00:00.000Z', options)).toEqual({
      ok: false,
      issues: [expect.objectContaining({ code: 'FIELD_READ_ONLY' })],
    });
    expect(definition.typecast('2026-09-25', options, vi)).toEqual({
      ok: false,
      issues: [expect.objectContaining({ code: 'FIELD_READ_ONLY' })],
    });
    expect(() => definition.toStorage('2026-09-25T02:00:00.000Z', options)).toThrow(
      FieldValueError,
    );
  });

  it.each([
    [new Date('2026-09-25T02:00:00.000Z'), '2026-09-25T02:00:00.000Z'],
    ['2026-09-25T02:00:00.000Z', '2026-09-25T02:00:00.000Z'],
    ['2026-09-25 09:00:00+07', '2026-09-25T02:00:00.000Z'],
    ['garbage', null],
    [null, null],
  ])('fromStorage %j', (stored, expected) => {
    expect(definition.fromStorage(stored, options)).toBe(expected);
  });

  it.each([
    [options, vi, '2026-09-25 09:00'],
    [options, en, '2026-09-24 22:00'],
    [
      systemTimeOptionsSchema.parse({
        style: { format: 'dd/MM/yyyy' },
        timezone: 'Asia/Ho_Chi_Minh',
      }),
      en,
      '25/09/2026',
    ],
  ])('formatText %#', (opts, ctx, expected) => {
    expect(definition.formatText('2026-09-25T02:00:00.000Z', opts, ctx)).toBe(expected);
  });

  it('formatText of null is empty', () => {
    expect(definition.formatText(null, options, vi)).toBe('');
  });
});

describe.each([
  [createdByFieldType, 'created_by', '__created_by'],
  [updatedByFieldType, 'updated_by', '__updated_by'],
] as const)('%s', (definition, type, column) => {
  const options = systemUserOptionsSchema.parse({});

  it('metadata', () => {
    expect(definition.type).toBe(type);
    expect(definition.readOnly).toBe(true);
    expect(definition.systemColumn).toBe(column);
    expect(definition.pgType(options, { collation: 'und-x-icu' })).toBeNull();
    expect(definition.filterOperators(options)).toEqual(MULTI_VALUE_OPERATORS);
    expect(systemUserOptionsSchema.safeParse({ multiple: true }).success).toBe(false);
  });

  it('is read-only', () => {
    expect(definition.validate([{ id: A }], options).ok).toBe(false);
    expect(definition.typecast('a@x.vn', options, vi).ok).toBe(false);
    expect(() => definition.toStorage([{ id: A }], options)).toThrow(FieldValueError);
  });

  it.each([
    [A, readCtx, people[A]],
    [A, undefined, { id: A }],
    [null, readCtx, null],
    [42, readCtx, null],
  ])('fromStorage %#', (stored, ctx, expected) => {
    expect(definition.fromStorage(stored, options, ctx)).toEqual(expected);
  });

  it.each([
    [people[A], 'Nguyễn A'],
    [{ id: A }, A],
    [null, ''],
  ])('formatText %#', (value, expected) => {
    expect(definition.formatText(value ?? null, options, vi)).toBe(expected);
  });
});
