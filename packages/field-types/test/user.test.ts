import { describe, expect, it } from 'vitest';

import {
  FieldValueError,
  MULTI_VALUE_OPERATORS,
  userFieldType,
  userOptionsSchema,
  type UserRef,
} from '../src/index.js';

const vi = { locale: 'vi', timeZone: 'Asia/Ho_Chi_Minh' };

const A = 'usr_AAAAAAAAAAAAAAA1';
const B = 'usr_BBBBBBBBBBBBBBB2';

const people: Record<string, UserRef> = {
  [A]: { id: A, name: 'Nguyễn A', email: 'a@x.vn' },
  [B]: { id: B, name: 'Trần B', email: 'b@x.vn' },
};
const byEmail: Record<string, string> = { 'a@x.vn': A, 'b@x.vn': B };

const readCtx = { resolveUser: (id: string) => people[id] };
const storageCtx = { resolveUserEmail: (email: string) => byEmail[email] };

const multi = userOptionsSchema.parse({});
const single = userOptionsSchema.parse({ multiple: false });

describe('user options', () => {
  it('defaults multiple=true, notify_on_assign=false', () => {
    expect(multi).toEqual({ multiple: true, notify_on_assign: false });
  });

  it.each([
    [{ default_value: [{ $slot: 'current_user' }] }],
    [{ default_value: [{ id: A }, { id: B }] }],
    [{ multiple: false, default_value: [{ id: A }] }],
    [{ default_value: null }],
    [{ notify_on_assign: true }],
  ])('accepts %j', (input) => {
    expect(userOptionsSchema.safeParse(input).success).toBe(true);
  });

  it.each([
    [{ multiple: false, default_value: [{ id: A }, { id: B }] }],
    [{ default_value: [{ $slot: 'record_created_time' }] }],
    [{ default_value: [{ id: 'usr_bad' }] }],
    [{ default_value: A }],
  ])('rejects %j', (input) => {
    expect(userOptionsSchema.safeParse(input).success).toBe(false);
  });
});

describe('user validate', () => {
  it.each([
    [multi, [{ id: A }]],
    [multi, [{ email: 'a@x.vn' }, { id: B }]],
    [multi, [{ id: A, name: 'Nguyễn A', email: 'a@x.vn' }]],
    [multi, []],
    [multi, null],
    [single, [{ id: A }]],
  ])('accepts %#', (options, value) => {
    expect(userFieldType.validate(value, options)).toEqual({ ok: true });
  });

  it.each([
    [multi, { id: A }, 'EXPECTED_ARRAY'],
    [multi, A, 'EXPECTED_ARRAY'],
    [multi, [A], 'EXPECTED_USER'],
    [multi, [{}], 'EXPECTED_USER'],
    [multi, [{ id: 'usr_bad' }], 'INVALID_USER_ID'],
    [multi, [{ id: 42 }], 'INVALID_USER_ID'],
    [multi, [{ email: 'not-an-email' }], 'INVALID_EMAIL'],
    [single, [{ id: A }, { id: B }], 'TOO_MANY_VALUES'],
  ])('rejects %#', (options, value, code) => {
    const result = userFieldType.validate(value, options);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.code).toBe(code);
  });
});

describe('user storage', () => {
  it.each([
    [multi, [{ id: A }, { email: 'b@x.vn' }, { id: A }], [A, B]],
    [multi, [], null],
    [multi, null, null],
    [single, [{ email: 'a@x.vn' }], [A]],
  ])('toStorage %#', (options, value, expected) => {
    expect(userFieldType.toStorage(value, options, storageCtx)).toEqual(expected);
  });

  it('toStorage throws USER_NOT_FOUND for an unresolved email', () => {
    expect(() => userFieldType.toStorage([{ email: 'c@x.vn' }], multi, storageCtx)).toThrow(
      FieldValueError,
    );
    try {
      userFieldType.toStorage([{ email: 'c@x.vn' }], multi);
    } catch (error) {
      expect((error as FieldValueError).issues).toEqual([
        expect.objectContaining({ code: 'USER_NOT_FOUND', params: { email: 'c@x.vn' } }),
      ]);
    }
  });

  it.each([
    [[A, B], readCtx, [people[A], people[B]]],
    [[A, 'usr_Gone00000000000X'], readCtx, [people[A], { id: 'usr_Gone00000000000X' }]],
    [[A], undefined, [{ id: A }]],
    [[], readCtx, null],
    [null, readCtx, null],
    ['garbage', readCtx, null],
  ])('fromStorage %#', (stored, ctx, expected) => {
    expect(userFieldType.fromStorage(stored, multi, ctx)).toEqual(expected);
  });

  it('round-trips', () => {
    const stored = userFieldType.toStorage([{ id: A }, { id: B }], multi, storageCtx);
    expect(userFieldType.fromStorage(stored, multi, readCtx)).toEqual([people[A], people[B]]);
  });
});

describe('user typecast', () => {
  it.each([
    [multi, 'a@x.vn, b@x.vn', [{ email: 'a@x.vn' }, { email: 'b@x.vn' }]],
    [multi, `${A}; b@x.vn`, [{ id: A }, { email: 'b@x.vn' }]],
    [multi, [A, { email: 'b@x.vn' }], [{ id: A }, { email: 'b@x.vn' }]],
    [multi, { id: A }, [{ id: A }]],
    [multi, '', null],
    [multi, null, null],
    [multi, undefined, null],
    [single, 'a@x.vn', [{ email: 'a@x.vn' }]],
  ])('%#', (options, input, expected) => {
    expect(userFieldType.typecast(input, options, vi)).toEqual({
      ok: true,
      value: expected,
      unknownOptions: [],
    });
  });

  it.each([
    [multi, 'not an email', 'INVALID_EMAIL'],
    [single, 'a@x.vn, b@x.vn', 'TOO_MANY_VALUES'],
    [multi, 42, 'EXPECTED_USER'],
    [multi, [42], 'EXPECTED_USER'],
  ])('rejects %#', (options, input, code) => {
    const result = userFieldType.typecast(input, options, vi);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.code).toBe(code);
  });
});

describe('user formatText, pgType, operators', () => {
  it.each([
    [[people[A], people[B]], 'Nguyễn A, Trần B'],
    [[{ id: A, email: 'a@x.vn' }], 'a@x.vn'],
    [[{ id: A }], A],
    [null, ''],
  ])('formatText %#', (value, expected) => {
    expect(userFieldType.formatText(value as UserRef[] | null, multi, vi)).toBe(expected);
  });

  it('pgType and operators', () => {
    expect(userFieldType.pgType(multi, { collation: 'und-x-icu' })).toBe('text[]');
    expect(userFieldType.filterOperators(single)).toEqual(MULTI_VALUE_OPERATORS);
  });
});
