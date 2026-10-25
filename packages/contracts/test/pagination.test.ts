import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  cursorListSchema,
  cursorQuerySchema,
  cursorRecordListSchema,
  offsetListSchema,
  offsetQuerySchema,
  recordListSchema,
  recordOffsetQuerySchema,
} from '../src/pagination.js';

describe('query params', () => {
  // prettier-ignore
  const cases: {
    name: string;
    schema: z.ZodType;
    input: Record<string, unknown>;
    expected: Record<string, unknown> | null;
  }[] = [
    { name: 'offset list defaults', schema: offsetQuerySchema, input: {}, expected: { offset: 0, limit: 50 } },
    { name: 'record list defaults', schema: recordOffsetQuerySchema, input: {}, expected: { offset: 0, limit: 200 } },
    { name: 'cursor list defaults', schema: cursorQuerySchema, input: {}, expected: { limit: 50 } },
    { name: 'coerces query strings', schema: offsetQuerySchema, input: { offset: '20', limit: '10' }, expected: { offset: 20, limit: 10 } },
    { name: 'offset list max 1000', schema: offsetQuerySchema, input: { limit: '1000' }, expected: { offset: 0, limit: 1000 } },
    { name: 'offset list above max', schema: offsetQuerySchema, input: { limit: '1001' }, expected: null },
    { name: 'record list above max', schema: recordOffsetQuerySchema, input: { limit: 1001 }, expected: null },
    { name: 'cursor list max 200', schema: cursorQuerySchema, input: { limit: '200', cursor: 'abc' }, expected: { limit: 200, cursor: 'abc' } },
    { name: 'cursor list above max', schema: cursorQuerySchema, input: { limit: '201' }, expected: null },
    { name: 'limit zero', schema: offsetQuerySchema, input: { limit: '0' }, expected: null },
    { name: 'negative offset', schema: offsetQuerySchema, input: { offset: '-1' }, expected: null },
    { name: 'fractional limit', schema: offsetQuerySchema, input: { limit: '1.5' }, expected: null },
    { name: 'non-numeric limit', schema: offsetQuerySchema, input: { limit: 'ten' }, expected: null },
    { name: 'empty cursor', schema: cursorQuerySchema, input: { cursor: '' }, expected: null },
  ];

  it.each(cases)('$name', ({ schema, input, expected }) => {
    const result = schema.safeParse(input);
    if (expected === null) {
      expect(result.success).toBe(false);
    } else {
      expect(result.success).toBe(true);
      expect(result.data).toEqual(expected);
    }
  });
});

describe('list responses', () => {
  const item = z.object({ id: z.string() });
  const items = [{ id: 'a' }];

  it('offset list', () => {
    const schema = offsetListSchema(item);
    expect(schema.safeParse({ items, total: 1, offset: 0, limit: 50 }).success).toBe(true);
    expect(schema.safeParse({ items, offset: 0, limit: 50 }).success).toBe(false);
  });

  // prettier-ignore
  it.each([
    { name: 'exact total', body: { records: items, total: 123, offset: 0, limit: 200 }, ok: true },
    { name: 'total estimate', body: { records: items, total_estimate: 250_000, offset: 0, limit: 200 }, ok: true },
    // `include_total: false` (grid blocks after the first).
    { name: 'neither', body: { records: items, offset: 0, limit: 200 }, ok: true },
    { name: 'both', body: { records: items, total: 1, total_estimate: 1, offset: 0, limit: 200 }, ok: false },
    { name: 'negative total', body: { records: items, total: -1, offset: 0, limit: 200 }, ok: false },
  ])('record list: $name → $ok', ({ body, ok }) => {
    expect(recordListSchema(item).safeParse(body).success).toBe(ok);
  });

  it.each([
    { body: { items, next_cursor: 'eyJpZCI6MX0' }, ok: true },
    { body: { items, next_cursor: null }, ok: true },
    { body: { items }, ok: false },
    { body: { items, next_cursor: '' }, ok: false },
  ])('cursor list $body → $ok', ({ body, ok }) => {
    expect(cursorListSchema(item).safeParse(body).success).toBe(ok);
  });

  it('cursor record list', () => {
    const schema = cursorRecordListSchema(item);
    expect(schema.safeParse({ records: items, next_cursor: null }).success).toBe(true);
    expect(schema.safeParse({ items, next_cursor: null }).success).toBe(false);
  });
});
