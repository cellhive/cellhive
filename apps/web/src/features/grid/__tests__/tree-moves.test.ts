import { describe, expect, it } from 'vitest';

import { checkDrop, indentTarget, loadedHeight, outdentTarget } from '../tree/moves';

import type { TreeNode } from '../tree/tree-rows';

/** Rows as [id, depth, ancestors]; offsets are counted among siblings. */
function source(rows: [string, number, string[]][]) {
  const nodes: TreeNode[] = rows.map(([id, depth, ancestors], index) => {
    const parentId = ancestors.at(-1) ?? null;
    let offset = 0;
    for (let above = 0; above < index; above += 1) {
      const other = rows[above];
      if (other !== undefined && (other[2].at(-1) ?? null) === parentId) offset += 1;
    }
    return {
      recordId: id,
      depth,
      parentId,
      ancestors,
      childCount: rows.filter((row) => row[2].at(-1) === id).length,
      expanded: true,
      ancestorOnly: false,
      offset,
    };
  });
  return {
    nodeAt: (row: number) => nodes[row],
    branchEnd: (row: number) => {
      const depth = nodes[row]?.depth ?? 0;
      let end = row;
      while ((nodes[end + 1]?.depth ?? -1) > depth) end += 1;
      return end;
    },
  };
}

// 0 A, 1 a, 2 b (child of a), 3 B, 4 C
const TREE = source([
  ['rec_A', 0, []],
  ['rec_a', 1, ['rec_A']],
  ['rec_b', 2, ['rec_A', 'rec_a']],
  ['rec_B', 0, []],
  ['rec_C', 0, []],
]);

describe('tree moves (T417, BACKLOG S4 design decision 3)', () => {
  it('drops onto a row: a sub-record of it', () => {
    expect(checkDrop(TREE, 3, 0, 'child')).toEqual({ ok: true, parentId: 'rec_A' });
  });

  it('drops between rows: a sibling of the row', () => {
    expect(checkDrop(TREE, 4, 2, 'before')).toEqual({ ok: true, parentId: 'rec_a' });
    expect(checkDrop(TREE, 2, 3, 'after')).toEqual({ ok: true, parentId: null });
  });

  it('refuses a record into its own branch (SUBRECORD_CYCLE)', () => {
    expect(checkDrop(TREE, 0, 2, 'child')).toEqual({ ok: false, problem: 'cycle' });
    expect(checkDrop(TREE, 1, 1, 'child')).toEqual({ ok: false, problem: 'cycle' });
    expect(checkDrop(TREE, 0, 2, 'after')).toEqual({ ok: false, problem: 'cycle' });
  });

  it('says when nothing changes', () => {
    expect(checkDrop(TREE, 1, 0, 'child')).toEqual({ ok: false, problem: 'same' });
    expect(checkDrop(TREE, 3, 4, 'before')).toEqual({ ok: false, problem: 'same' });
  });

  it('refuses more than 10 levels with the branch taken along (SUBRECORD_TOO_DEEP)', () => {
    const chain: [string, number, string[]][] = [];
    for (let depth = 0; depth < 9; depth += 1) {
      chain.push([`rec_${String(depth)}`, depth, chain.map((row) => row[0])]);
    }
    chain.push(['rec_R', 0, []], ['rec_r', 1, ['rec_R']]);
    const deep = source(chain);
    // rec_8 is at depth 8 (level 9): R (with its child) below it would reach level 11.
    expect(checkDrop(deep, 9, 8, 'child')).toEqual({ ok: false, problem: 'depth' });
    expect(loadedHeight(deep, 9)).toBe(1);
    // A leaf fits at level 10.
    expect(checkDrop(deep, 10, 8, 'child')).toEqual({ ok: true, parentId: 'rec_8' });
  });

  it('indents under the previous sibling, not a first child', () => {
    expect(indentTarget(TREE, 3)).toEqual({ ok: true, parentId: 'rec_A' });
    expect(indentTarget(TREE, 4)).toEqual({ ok: true, parentId: 'rec_B' });
    expect(indentTarget(TREE, 0)).toBeUndefined();
    expect(indentTarget(TREE, 2)).toBeUndefined();
  });

  it('outdents to the grandparent, not a root', () => {
    expect(outdentTarget(TREE, 2)).toEqual({ ok: true, parentId: 'rec_A' });
    expect(outdentTarget(TREE, 1)).toEqual({ ok: true, parentId: null });
    expect(outdentTarget(TREE, 0)).toBeUndefined();
  });

  it('cannot check rows still loading', () => {
    expect(checkDrop(TREE, 0, 9, 'child')).toEqual({ ok: false, problem: 'unloaded' });
  });
});
