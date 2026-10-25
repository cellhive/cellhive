import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { formatIssuePath, zodIssuesToProblemErrors } from '../../src/errors/index.js';

describe('formatIssuePath', () => {
  const cases: { path: PropertyKey[]; expected: string }[] = [
    { path: [], expected: '' },
    { path: ['name'], expected: 'name' },
    { path: ['records', 0, 'fields', 'x'], expected: 'records[0].fields.x' },
    { path: ['records', 0, 'fields', 'Số tiền'], expected: 'records[0].fields.Số tiền' },
    { path: [0, 1], expected: '[0][1]' },
    { path: ['fields', 'a.b'], expected: 'fields["a.b"]' },
    { path: ['fields', 'x[0]'], expected: 'fields["x[0]"]' },
    { path: ['fields', 'say "hi"'], expected: 'fields["say \\"hi\\""]' },
    { path: ['fields', ''], expected: 'fields[""]' },
    { path: [Symbol('tag')], expected: 'tag' },
  ];
  it.each(cases)('$path → $expected', ({ path, expected }) => {
    expect(formatIssuePath(path)).toBe(expected);
  });
});

describe('zodIssuesToProblemErrors', () => {
  const schema = z.strictObject({
    name: z.string().min(2),
    count: z.int().max(10),
    email: z.email(),
    kind: z.enum(['a', 'b']),
    records: z.array(z.object({ fields: z.record(z.string(), z.number()) })),
  });

  function errorsFor(input: unknown) {
    const result = schema.safeParse(input, { reportInput: true });
    if (result.success) throw new Error('expected failure');
    return zodIssuesToProblemErrors(result.error.issues);
  }

  const cases: { name: string; input: unknown; expected: object[] }[] = [
    {
      name: 'missing key → REQUIRED',
      input: { count: 1, email: 'a@b.co', kind: 'a', records: [] },
      expected: [{ path: 'name', code: 'REQUIRED' }],
    },
    {
      name: 'wrong type in a nested record → EXPECTED_NUMBER with dot/bracket path',
      input: {
        name: 'ok',
        count: 1,
        email: 'a@b.co',
        kind: 'a',
        records: [{ fields: { x: 1 } }, { fields: { 'Số tiền': 'nope' } }],
      },
      expected: [
        {
          path: 'records[1].fields.Số tiền',
          code: 'EXPECTED_NUMBER',
          params: { expected: 'number' },
        },
      ],
    },
    {
      name: 'size and format problems carry params',
      input: { name: 'x', count: 11, email: 'bad', kind: 'c', records: [] },
      expected: [
        {
          path: 'name',
          code: 'TOO_SMALL',
          params: { minimum: 2, inclusive: true, origin: 'string' },
        },
        {
          path: 'count',
          code: 'TOO_BIG',
          params: { maximum: 10, inclusive: true, origin: 'number' },
        },
        { path: 'email', code: 'INVALID_FORMAT', params: { format: 'email' } },
        { path: 'kind', code: 'INVALID_VALUE', params: { values: ['a', 'b'] } },
      ],
    },
    {
      name: 'unknown keys → one UNRECOGNIZED_KEY per key',
      input: { name: 'ok', count: 1, email: 'a@b.co', kind: 'a', records: [], extra: 1, more: 2 },
      expected: [
        { path: 'extra', code: 'UNRECOGNIZED_KEY', message: 'Unrecognized key "extra"' },
        { path: 'more', code: 'UNRECOGNIZED_KEY', message: 'Unrecognized key "more"' },
      ],
    },
  ];

  it.each(cases)('$name', ({ input, expected }) => {
    const errors = errorsFor(input);
    expect(errors).toHaveLength(expected.length);
    expected.forEach((item, index) => {
      expect(errors[index]).toMatchObject(item);
      expect(typeof errors[index]?.message).toBe('string');
    });
  });

  it('never copies the received value', () => {
    const secret = 'super-secret-value-123';
    const errors = zodIssuesToProblemErrors(
      z.object({ n: z.number(), e: z.enum(['a']) }).safeParse(
        { n: secret, e: secret },
        {
          reportInput: true,
        },
      ).error?.issues ?? [],
    );
    expect(JSON.stringify(errors)).not.toContain(secret);
  });

  it('uses the code of a custom refinement when it is upper snake case', () => {
    const custom = z.string().refine(() => false, { params: { code: 'NOT_ALLOWED', limit: 3 } });
    const lower = z.string().refine(() => false, { params: { code: 'lower' } });
    expect(zodIssuesToProblemErrors(custom.safeParse('x').error?.issues ?? [])).toEqual([
      { path: '', code: 'NOT_ALLOWED', message: 'Invalid input', params: { limit: 3 } },
    ]);
    expect(zodIssuesToProblemErrors(lower.safeParse('x').error?.issues ?? [])[0]?.code).toBe(
      'INVALID',
    );
  });

  it('reports EXPECTED_<TYPE> (not REQUIRED) when parsed without reportInput', () => {
    const errors = zodIssuesToProblemErrors(
      z.object({ a: z.string() }).safeParse({}).error?.issues ?? [],
    );
    expect(errors).toEqual([
      expect.objectContaining({ path: 'a', code: 'EXPECTED_STRING' }) as unknown,
    ]);
  });
});
