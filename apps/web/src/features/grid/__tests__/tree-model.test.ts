import { describe, expect, it } from 'vitest';

import { TreeRowModel, type TreeLevelInput } from '../tree/tree-model';

/**
 * roots: A(0) B(1) C(2) D(3); A expanded with 3 children (a0 a1 a2), a1
 * expanded with 2 (x0 x1); C expanded with 2 (c0 c1).
 *
 * rows: 0 A, 1 a0, 2 a1, 3 x0, 4 x1, 5 a2, 6 B, 7 C, 8 c0, 9 c1, 10 D
 */
const LAYOUT: TreeLevelInput = {
  count: 4,
  expanded: [
    {
      offset: 0,
      recordId: 'rec_A',
      child: {
        count: 3,
        expanded: [{ offset: 1, recordId: 'rec_a1', child: { count: 2, expanded: [] } }],
      },
    },
    { offset: 2, recordId: 'rec_C', child: { count: 2, expanded: [] } },
  ],
};

describe('TreeRowModel (T417, FRONTEND §3.3)', () => {
  const model = new TreeRowModel(LAYOUT);

  it('counts the roots and every expanded branch', () => {
    expect(model.rowCount).toBe(11);
  });

  it.each([
    [0, null, 0, 0],
    [1, 'rec_A', 0, 1],
    [2, 'rec_A', 1, 1],
    [3, 'rec_a1', 0, 2],
    [4, 'rec_a1', 1, 2],
    [5, 'rec_A', 2, 1],
    [6, null, 1, 0],
    [7, null, 2, 0],
    [8, 'rec_C', 0, 1],
    [9, 'rec_C', 1, 1],
    [10, null, 3, 0],
  ] as const)('row %i is offset %s/%i at depth %i', (row, parent, offset, depth) => {
    const place = model.placeOf(row);
    expect(place?.level.parentId).toBe(parent);
    expect(place?.offset).toBe(offset);
    expect(place?.level.depth).toBe(depth);
    expect(model.rowOf(parent, offset)).toBe(row);
  });

  it('asks rows in any order (cursor and binary search agree)', () => {
    const rows = [10, 0, 5, 4, 9, 1, 7];
    const fresh = new TreeRowModel(LAYOUT);
    for (const row of rows) expect(fresh.placeOf(row)).toEqual(model.placeOf(row));
  });

  it('gives the ancestors of a level, root first', () => {
    expect(model.placeOf(3)?.level.ancestors).toEqual(['rec_A', 'rec_a1']);
    expect(model.placeOf(10)?.level.ancestors).toEqual([]);
  });

  it('is out of range before 0 and after the last row', () => {
    expect(model.placeOf(-1)).toBeUndefined();
    expect(model.placeOf(11)).toBeUndefined();
    expect(model.depthOf(11)).toBe(-1);
    expect(model.rowOf('rec_B', 0)).toBeUndefined();
  });

  it('splits a range of rows into each level’s offsets (contiguous across branches)', () => {
    const ranges = model.offsetRanges(0, 10);
    expect(ranges.get(null)).toEqual([{ firstRow: 0, lastRow: 3 }]);
    expect(ranges.get('rec_A')).toEqual([{ firstRow: 0, lastRow: 2 }]);
    expect(ranges.get('rec_a1')).toEqual([{ firstRow: 0, lastRow: 1 }]);
    expect(ranges.get('rec_C')).toEqual([{ firstRow: 0, lastRow: 1 }]);
    const window = model.offsetRanges(4, 7);
    expect(window.get('rec_a1')).toEqual([{ firstRow: 1, lastRow: 1 }]);
    expect(window.get('rec_A')).toEqual([{ firstRow: 2, lastRow: 2 }]);
    expect(window.get(null)).toEqual([{ firstRow: 1, lastRow: 2 }]);
    expect(window.has('rec_C')).toBe(false);
  });

  it('knows where a branch ends', () => {
    expect(model.branchEnd(0)).toBe(5);
    expect(model.branchEnd(2)).toBe(4);
    expect(model.branchEnd(6)).toBe(6);
    expect(model.branchEnd(7)).toBe(9);
    expect(model.branchEnd(1)).toBe(1);
  });

  it('ignores branches outside their level and repeated offsets', () => {
    const odd = new TreeRowModel({
      count: 2,
      expanded: [
        { offset: 5, recordId: 'rec_x', child: { count: 3, expanded: [] } },
        { offset: 0, recordId: 'rec_y', child: { count: 1, expanded: [] } },
        { offset: 0, recordId: 'rec_z', child: { count: 4, expanded: [] } },
      ],
    });
    expect(odd.rowCount).toBe(3);
  });

  it('handles a large flat level without expansions', () => {
    const flat = new TreeRowModel({ count: 50_000, expanded: [] });
    expect(flat.rowCount).toBe(50_000);
    expect(flat.placeOf(49_999)?.offset).toBe(49_999);
  });
});
