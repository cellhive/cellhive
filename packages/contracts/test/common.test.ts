import { describe, expect, it } from 'vitest';

import { isoDateSchema, isoDateTimeSchema, toIsoDateTime } from '../src/common.js';

describe('isoDateTimeSchema', () => {
  it.each([
    { value: '2026-09-20T03:15:00.000Z', ok: true },
    { value: '2026-09-20T03:15:00Z', ok: true },
    { value: '2026-09-20T03:15:00.000+07:00', ok: false },
    { value: '2026-09-20T03:15:00.000', ok: false },
    { value: '2026-09-20', ok: false },
    { value: '2026-13-20T03:15:00.000Z', ok: false },
    { value: 'yesterday', ok: false },
  ])('$value → $ok', ({ value, ok }) => {
    expect(isoDateTimeSchema.safeParse(value).success).toBe(ok);
  });

  it('accepts what toIsoDateTime emits', () => {
    expect(isoDateTimeSchema.safeParse(toIsoDateTime(new Date())).success).toBe(true);
  });
});

describe('isoDateSchema', () => {
  it.each([
    { value: '2026-09-20', ok: true },
    { value: '2024-02-29', ok: true },
    { value: '2026-02-30', ok: false },
    { value: '2026-9-20', ok: false },
    { value: '2026-09-20T00:00:00Z', ok: false },
  ])('$value → $ok', ({ value, ok }) => {
    expect(isoDateSchema.safeParse(value).success).toBe(ok);
  });
});
