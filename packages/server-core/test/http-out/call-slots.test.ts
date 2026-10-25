import { describe, expect, it } from 'vitest';

import { createHttpCallSlots, httpCallSlotsFor } from '../../src/http-out/deliver.js';

describe('httpCallSlotsFor (QA S5c, T616)', () => {
  it.each([
    [1, 1],
    [2, 1],
    [5, 4],
    [16, 15],
  ])('WORKER_CONCURRENCY=%i → %i calls at once', (concurrency, expected) => {
    expect(httpCallSlotsFor(concurrency)).toBe(expected);
  });
});

describe('createHttpCallSlots', () => {
  it('gives at most `max` slots and takes them back', () => {
    const slots = createHttpCallSlots(2);
    expect(slots.tryTake()).toBe(true);
    expect(slots.tryTake()).toBe(true);
    expect(slots.tryTake()).toBe(false);
    slots.free();
    expect(slots.tryTake()).toBe(true);
    expect(slots.tryTake()).toBe(false);
  });

  it('a stray free never creates a slot beyond the maximum', () => {
    const slots = createHttpCallSlots(1);
    slots.free();
    slots.free();
    expect(slots.tryTake()).toBe(true);
    expect(slots.tryTake()).toBe(false);
  });

  it.each([0, -1, Number.NaN])('refuses max = %s', (max) => {
    expect(() => createHttpCallSlots(max)).toThrow(RangeError);
  });
});
