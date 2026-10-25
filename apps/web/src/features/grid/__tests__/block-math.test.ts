import { describe, expect, it } from 'vitest';

import {
  blockCount,
  blockOf,
  neededBlocks,
  prefetchBlock,
  scrollDirection,
  shouldDebounce,
} from '../blocks/block-math';
import { LruOrder } from '../blocks/lru';

describe('blockOf / blockCount', () => {
  it.each([
    [0, 0],
    [199, 0],
    [200, 1],
    [399, 1],
    [199_999, 999],
    [-5, 0],
  ])('row %i is in block %i', (row, block) => {
    expect(blockOf(row)).toBe(block);
  });

  it.each([
    [0, 0],
    [1, 1],
    [200, 1],
    [201, 2],
    [200_000, 1000],
  ])('%i rows need %i blocks', (rows, blocks) => {
    expect(blockCount(rows)).toBe(blocks);
  });
});

describe('neededBlocks: visible ± 1 block (FRONTEND §3.3)', () => {
  it.each([
    { name: 'top of the table', range: [0, 30], rows: 200_000, blocks: [0, 1] },
    { name: 'inside block 5', range: [1_050, 1_080], rows: 200_000, blocks: [4, 5, 6] },
    { name: 'across a block edge', range: [390, 420], rows: 200_000, blocks: [0, 1, 2, 3] },
    { name: 'end of the table', range: [199_970, 199_999], rows: 200_000, blocks: [998, 999] },
    { name: 'a small table', range: [0, 9], rows: 10, blocks: [0] },
    { name: 'an empty table', range: [0, 0], rows: 0, blocks: [] },
    { name: 'unknown count', range: [0, 30], rows: null, blocks: [0, 1] },
  ])('$name', ({ range, rows, blocks }) => {
    const [firstRow = 0, lastRow = 0] = range;
    expect(neededBlocks({ firstRow, lastRow }, rows)).toEqual(blocks);
  });

  it('takes the padding as a parameter', () => {
    expect(neededBlocks({ firstRow: 1_050, lastRow: 1_080 }, null, 0)).toEqual([5]);
  });
});

describe('scrollDirection', () => {
  it.each([
    { previous: null, next: 100, direction: 'none' },
    { previous: 100, next: 100, direction: 'none' },
    { previous: 100, next: 130, direction: 'down' },
    { previous: 130, next: 100, direction: 'up' },
  ] as const)('$previous → $next is $direction', ({ previous, next, direction }) => {
    const range = (first: number) => ({ firstRow: first, lastRow: first + 30 });
    expect(scrollDirection(previous === null ? null : range(previous), range(next))).toBe(
      direction,
    );
  });
});

describe('prefetchBlock: next block toward the scroll when < 50 rows from the edge', () => {
  it.each([
    { name: 'down, far from the edge', range: [100, 130], dir: 'down', rows: 200_000, block: null },
    {
      name: 'down, 49 rows left in block 0',
      range: [120, 150],
      dir: 'down',
      rows: 200_000,
      block: 2,
    },
    { name: 'down, 50 rows left', range: [119, 149], dir: 'down', rows: 200_000, block: null },
    {
      name: 'down, beyond the last block',
      range: [199_960, 199_990],
      dir: 'down',
      rows: 200_000,
      block: null,
    },
    {
      name: 'up, near the top of block 5',
      range: [1_010, 1_040],
      dir: 'up',
      rows: 200_000,
      block: 3,
    },
    {
      name: 'up, in block 1 (nothing before block 0)',
      range: [210, 240],
      dir: 'up',
      rows: 200_000,
      block: null,
    },
    { name: 'not scrolling', range: [120, 150], dir: 'none', rows: 200_000, block: null },
    { name: 'down with unknown count', range: [160, 190], dir: 'down', rows: null, block: 2 },
  ] as const)('$name → $block', ({ range, dir, rows, block }) => {
    const [firstRow, lastRow] = range;
    expect(prefetchBlock({ firstRow, lastRow }, dir, rows)).toBe(block);
  });
});

describe('shouldDebounce', () => {
  const at = (first: number) => ({ firstRow: first, lastRow: first + 30 });
  it.each([
    { name: 'first viewport', previous: null, next: 0, dragging: false, debounce: false },
    { name: 'wheel step', previous: 100, next: 140, dragging: false, debounce: false },
    { name: 'dragging the scroll bar', previous: 100, next: 140, dragging: true, debounce: true },
    {
      name: 'jump past the padded blocks',
      previous: 0,
      next: 50_000,
      dragging: false,
      debounce: true,
    },
    {
      name: 'jump of exactly two blocks',
      previous: 0,
      next: 400,
      dragging: false,
      debounce: false,
    },
  ])('$name', ({ previous, next, dragging, debounce }) => {
    expect(shouldDebounce(previous === null ? null : at(previous), at(next), dragging)).toBe(
      debounce,
    );
  });
});

describe('LruOrder', () => {
  it('evicts the least recently used keys beyond the maximum', () => {
    const lru = new LruOrder<number>();
    for (const key of [1, 2, 3, 4, 5]) lru.touch(key);
    lru.touch(1);
    expect(lru.keys()).toEqual([2, 3, 4, 5, 1]);
    expect(lru.evict(3)).toEqual([2, 3]);
    expect(lru.keys()).toEqual([4, 5, 1]);
  });

  it('never evicts kept keys, even above the maximum', () => {
    const lru = new LruOrder<number>();
    for (const key of [1, 2, 3, 4]) lru.touch(key);
    expect(lru.evict(1, new Set([1, 2, 3]))).toEqual([4]);
    expect(lru.keys()).toEqual([1, 2, 3]);
    expect(lru.evict(1, new Set([1, 2, 3]))).toEqual([]);
  });

  it('forgets deleted keys', () => {
    const lru = new LruOrder<string>();
    lru.touch('a');
    lru.touch('b');
    lru.delete('a');
    expect(lru.has('a')).toBe(false);
    expect(lru.size).toBe(1);
  });
});
