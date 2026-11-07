import { describe, expect, it } from 'vitest';

import { normalizeRows, percentile, sameRows, sameValues, slugOf } from '../ai-eval/scoring.js';

/** BACKLOG T917: the scoring of the manual AI eval (`test/ai-eval/**`), kept honest in CI. */
describe('AI eval scoring (T917)', () => {
  it.each([
    [[], 50, null],
    [[7], 95, 7],
    [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50, 5],
    [[10, 9, 8, 7, 6, 5, 4, 3, 2, 1], 95, 10],
    [[300, 100, 200], 50, 200],
  ] as const)('percentile(%j, %d) = %j', (values, p, expected) => {
    expect(percentile(values, p)).toBe(expected);
  });

  it('compares widget rows by group value and rounded numbers, in any order', () => {
    const expected = [
      [{ value: '2026-08-01', label: 'Aug 2026' }, 200],
      [{ value: '2026-10-01', label: 'Oct 2026' }, 400.0000001],
    ];
    const actual = [
      [{ value: '2026-10-01', label: 'Thg 10 2026' }, 400],
      [{ value: '2026-08-01', label: 'Thg 8 2026' }, 200],
    ];
    expect(sameRows(actual, expected)).toBe(true);
    expect(sameRows(actual, expected, true)).toBe(false);
    expect(sameRows([[{ value: '2026-08-01' }, 201]], [[{ value: '2026-08-01' }, 200]])).toBe(
      false,
    );
    expect(sameRows([[1]], [[1], [2]])).toBe(false);
    expect(sameRows([], [])).toBe(true);
    expect(normalizeRows([[{ b: 1, a: 2.004 }]])).toEqual(['[{"a":2,"b":1}]']);
  });

  it('compares two formula previews record by record', () => {
    const big = { id: 'rec_2', value: 'Lớn' };
    const reference = [{ id: 'rec_1', value: 90 }, big];
    expect(sameValues([...reference].reverse(), reference)).toBe(true);
    expect(sameValues([{ id: 'rec_1', value: 90.001 }, big], reference)).toBe(true);
    expect(sameValues([{ id: 'rec_1', value: 91 }, big], reference)).toBe(false);
    expect(sameValues([], [])).toBe(false);
  });

  it('makes file-safe model names', () => {
    expect(slugOf('qwen2.5:7b-instruct')).toBe('qwen2.5-7b-instruct');
    expect(slugOf('gpt-4.1-mini')).toBe('gpt-4.1-mini');
    expect(slugOf('::')).toBe('model');
  });
});
