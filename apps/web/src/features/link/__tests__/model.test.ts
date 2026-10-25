import { describe, expect, it } from 'vitest';

import { highlightParts, matchRanges } from '../model/highlight';
import * as model from '../model/selection';

const ref = (n: number, title: string | null = `R${String(n)}`) => ({
  id: `rec_${String(n).padStart(16, '0')}`,
  title,
});

describe('picker selection (BACKLOG S4 design decision #1)', () => {
  it('toggles records in order and blocks adding past the limit', () => {
    let selection = model.selectionOf([ref(1)], 2);
    selection = model.toggle(selection, ref(2)).selection;
    expect(selection.refs.map((item) => item.id)).toEqual([ref(1).id, ref(2).id]);
    const blocked = model.toggle(selection, ref(3));
    expect(blocked.blocked).toBe(true);
    expect(blocked.selection).toBe(selection);
    // Removing is always possible, also from a full cell.
    const removed = model.toggle(selection, ref(1));
    expect(removed.blocked).toBe(false);
    expect(removed.selection.refs).toEqual([ref(2)]);
  });

  it('keeps an over-full cell (limit lowered later) but adds nothing to it', () => {
    const selection = model.selectionOf([ref(1), ref(2), ref(3)], 2);
    expect(selection.refs).toHaveLength(3);
    expect(model.isFull(selection)).toBe(true);
    expect(model.toggle(selection, ref(4)).blocked).toBe(true);
  });

  it('drops repeated ids, keeps unreadable records (P20)', () => {
    expect(model.selectionOf([ref(1), ref(1), ref(2, null)], 500).refs).toEqual([
      ref(1),
      ref(2, null),
    ]);
  });

  it.each([
    // [selected, limit, results, blocked, count after]
    [[1], 500, [1, 2, 3], false, 3],
    [[1], 2, [2, 3], true, 1],
    [[1, 2], 3, [1, 2], false, 2],
    [[], 3, [1, 2, 3], false, 3],
  ])('select all of the current results %#', (selected, limit, results, blocked, after) => {
    const selection = model.selectionOf(
      selected.map((n) => ref(n)),
      limit,
    );
    const change = model.selectAll(
      selection,
      results.map((n) => ref(n)),
    );
    expect(change.blocked).toBe(blocked);
    expect(change.selection.refs).toHaveLength(after);
  });

  it('removes the results again and knows when all are chosen', () => {
    const selection = model.selectionOf([ref(1), ref(2), ref(3)], 500);
    expect(model.allSelected(selection, [ref(1), ref(2)])).toBe(true);
    expect(model.allSelected(selection, [ref(4)])).toBe(false);
    expect(model.allSelected(selection, [])).toBe(false);
    expect(model.removeAll(selection, [ref(1), ref(3)]).refs).toEqual([ref(2)]);
  });

  it.each([
    [0, 2, [2, 3, 1]],
    [2, 0, [3, 1, 2]],
    [1, 1, [1, 2, 3]],
    [5, 0, [1, 2, 3]],
  ])('moves %i to %i', (from, to, expected) => {
    const selection = model.selectionOf([ref(1), ref(2), ref(3)], 500);
    expect(model.move(selection, from, to).refs.map((item) => item.title)).toEqual(
      expected.map((n) => `R${String(n)}`),
    );
  });

  it('saves only a change; reports the records added (for "Recent")', () => {
    const initial = [ref(1), ref(2)];
    const same = model.selectionOf(initial, 500);
    expect(model.changed(same, initial)).toBe(false);
    expect(model.changed(model.move(same, 0, 1), initial)).toBe(true);
    const next = model.toggle(model.remove(same, ref(1).id), ref(3)).selection;
    expect(model.changed(next, initial)).toBe(true);
    expect(model.added(next, initial)).toEqual([ref(3).id]);
    expect(model.clear(next).refs).toEqual([]);
    expect(model.choose(next, ref(9)).refs).toEqual([ref(9)]);
  });
});

describe('search highlight like the server search (no accents, any case)', () => {
  it.each([
    ['Siêu thị mini Hoà Bình', 'hoa', [[14, 17]]],
    ['Siêu thị mini Hoà Bình', 'HOÀ BÌNH', [[14, 22]]],
    ['Đông Á', 'dong', [[0, 4]]],
    [
      'Giấy in K80, Giấy in K57',
      'giay in',
      [
        [0, 7],
        [13, 20],
      ],
    ],
    ['An Phát', '', []],
    ['An Phát', 'xyz', []],
  ])('%s / %s', (text, search, expected) => {
    expect(matchRanges(text, search)).toEqual(expected);
  });

  it('cuts the text into plain and matched parts', () => {
    expect(highlightParts('Quán ăn Hoà Hưng', 'hoa')).toEqual([
      { text: 'Quán ăn ', match: false },
      { text: 'Hoà', match: true },
      { text: ' Hưng', match: false },
    ]);
    expect(highlightParts('An Phát', 'q')).toEqual([{ text: 'An Phát', match: false }]);
  });
});
