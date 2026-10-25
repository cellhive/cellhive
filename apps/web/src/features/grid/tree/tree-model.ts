import type { RowRange } from '../blocks/block-math';

/**
 * Rows of a sub-record tree (T417, FRONTEND §3.3). Pure.
 *
 * The server reads the tree level by level (`POST …/records/tree`, CONTRACTS
 * §1.4): the roots, paged, then the children of every expanded record,
 * paged too. Every level is a list of siblings with its own offsets (what
 * its blocks of 200 are made of). The grid shows them depth first: a record,
 * then — when it is expanded — its children, and so on. Two row spaces:
 *
 * - **level offset** — row of one level (`parent_id` null for the roots, a
 *   record id for the children of that record);
 * - **data row** — what the grid draws, every row a record: the roots with
 *   the rows of their expanded branches in between. No header or spacer
 *   rows: selection, clipboard, fill and undo use the rows as they are.
 *
 * The layout needs no row but the expanded ones: a level's size is its row
 * count (or, before it is loaded, the parent's `children_count`), so the
 * rows of a branch are known before any of them is fetched (skeletons).
 * The model is a list of segments (consecutive offsets of one level) and
 * every mapping is a binary search over them, with a cursor for rows asked
 * in order (glide asks every visible cell of every row per frame).
 */

/** One level of the tree as the loaders know it. */
export interface TreeLevelInput {
  /** Rows of the level (siblings under one parent). */
  readonly count: number;
  /** Expanded rows of the level (records with visible children), by offset. */
  readonly expanded: readonly TreeBranchInput[];
}

/** An expanded record and the level of its children. */
export interface TreeBranchInput {
  /** Offset of the record in its own level. */
  readonly offset: number;
  readonly recordId: string;
  readonly child: TreeLevelInput;
}

/** A level of the model: which parent, how deep, its ancestors. */
export interface TreeLevel {
  /** `null` for the roots. */
  readonly parentId: string | null;
  /** 0 for the roots. */
  readonly depth: number;
  /** Record ids from the root down to `parentId` (empty for the roots). */
  readonly ancestors: readonly string[];
  readonly count: number;
}

/** Where a data row comes from. */
export interface TreeRowPlace {
  readonly level: TreeLevel;
  readonly offset: number;
}

interface Segment {
  /** First data row. */
  readonly start: number;
  readonly length: number;
  readonly level: TreeLevel;
  /** Level offset of the first row. */
  readonly from: number;
}

const ROOT_KEY = '';

function levelKey(parentId: string | null): string {
  return parentId ?? ROOT_KEY;
}

export class TreeRowModel {
  readonly rowCount: number;
  readonly #segments: Segment[] = [];
  /** Segments of every level, by parent id (`''` for the roots), in offset order. */
  readonly #byLevel = new Map<string, Segment[]>();
  readonly #levels = new Map<string, TreeLevel>();
  /** Last segment found (rows asked in order hit it or the next one). */
  #cursor = 0;

  constructor(root: TreeLevelInput) {
    this.rowCount = this.#add(root, null, 0, [], 0);
  }

  /** Levels of the layout (the roots and every expanded branch). */
  levels(): IterableIterator<TreeLevel> {
    return this.#levels.values();
  }

  level(parentId: string | null): TreeLevel | undefined {
    return this.#levels.get(levelKey(parentId));
  }

  /** Level and offset of a data row, `undefined` out of range. */
  placeOf(row: number): TreeRowPlace | undefined {
    const segment = this.#segmentAt(row);
    if (segment === undefined) return undefined;
    return { level: segment.level, offset: segment.from + (row - segment.start) };
  }

  /** Depth of a data row (0 = root), `-1` out of range. */
  depthOf(row: number): number {
    return this.#segmentAt(row)?.level.depth ?? -1;
  }

  /** Data row of a level offset, `undefined` when that level is not shown. */
  rowOf(parentId: string | null, offset: number): number | undefined {
    const segments = this.#byLevel.get(levelKey(parentId));
    if (segments === undefined) return undefined;
    let low = 0;
    let high = segments.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const segment = segments[middle];
      if (segment === undefined) break;
      if (offset < segment.from) high = middle - 1;
      else if (offset >= segment.from + segment.length) low = middle + 1;
      else return segment.start + (offset - segment.from);
    }
    return undefined;
  }

  /**
   * Rows of `firstRow`…`lastRow` (clipped to the model) as level offset
   * ranges, by parent id (`null` for the roots): what each level loads.
   */
  offsetRanges(firstRow: number, lastRow: number): Map<string | null, RowRange[]> {
    const ranges = new Map<string | null, RowRange[]>();
    const first = Math.max(0, firstRow);
    const last = Math.min(this.rowCount - 1, lastRow);
    if (last < first) return ranges;
    let index = this.#indexAt(first);
    for (; index < this.#segments.length; index += 1) {
      const segment = this.#segments[index];
      if (segment === undefined || segment.start > last) break;
      const from = Math.max(first, segment.start);
      const to = Math.min(last, segment.start + segment.length - 1);
      if (to < from) continue;
      const list = ranges.get(segment.level.parentId) ?? [];
      const range = {
        firstRow: segment.from + (from - segment.start),
        lastRow: segment.from + (to - segment.start),
      };
      const previous = list.at(-1);
      // Offsets of one level are contiguous across the branches in between.
      if (previous !== undefined && previous.lastRow + 1 === range.firstRow) {
        list[list.length - 1] = { firstRow: previous.firstRow, lastRow: range.lastRow };
      } else {
        list.push(range);
      }
      ranges.set(segment.level.parentId, list);
    }
    return ranges;
  }

  /**
   * The last data row of the branch of a row (the row itself when it has
   * no expanded children): where "after this record" ends in the grid.
   */
  branchEnd(row: number): number {
    const depth = this.depthOf(row);
    if (depth < 0) return row;
    let end = row;
    let index = this.#indexAt(row + 1);
    for (; index < this.#segments.length; index += 1) {
      const segment = this.#segments[index];
      if (segment === undefined || segment.level.depth <= depth) break;
      end = segment.start + segment.length - 1;
    }
    return end;
  }

  #add(
    input: TreeLevelInput,
    parentId: string | null,
    depth: number,
    ancestors: readonly string[],
    start: number,
  ): number {
    const level: TreeLevel = { parentId, depth, ancestors, count: Math.max(0, input.count) };
    this.#levels.set(levelKey(parentId), level);
    const own: Segment[] = [];
    this.#byLevel.set(levelKey(parentId), own);
    let row = start;
    let offset = 0;
    const push = (from: number, length: number) => {
      if (length <= 0) return;
      const segment: Segment = { start: row, length, level, from };
      this.#segments.push(segment);
      own.push(segment);
      row += length;
    };
    const branches = [...input.expanded]
      .filter((branch) => branch.offset >= 0 && branch.offset < level.count)
      .sort((a, b) => a.offset - b.offset);
    for (const branch of branches) {
      if (branch.offset < offset) continue; // a repeated offset
      push(offset, branch.offset - offset + 1);
      offset = branch.offset + 1;
      row = this.#add(
        branch.child,
        branch.recordId,
        depth + 1,
        [...ancestors, branch.recordId],
        row,
      );
    }
    push(offset, level.count - offset);
    return row;
  }

  #segmentAt(row: number): Segment | undefined {
    if (row < 0 || row >= this.rowCount) return undefined;
    return this.#segments[this.#indexAt(row)];
  }

  /** Index of the segment holding `row` (the first one after it when none does). */
  #indexAt(row: number): number {
    const segments = this.#segments;
    const cursor = segments[this.#cursor];
    if (cursor !== undefined && row >= cursor.start && row < cursor.start + cursor.length) {
      return this.#cursor;
    }
    const next = segments[this.#cursor + 1];
    if (next !== undefined && row >= next.start && row < next.start + next.length) {
      this.#cursor += 1;
      return this.#cursor;
    }
    let low = 0;
    let high = segments.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const segment = segments[middle];
      if (segment === undefined) break;
      if (row < segment.start) high = middle - 1;
      else if (row >= segment.start + segment.length) low = middle + 1;
      else {
        this.#cursor = middle;
        return middle;
      }
    }
    return low;
  }
}

export const EMPTY_TREE = new TreeRowModel({ count: 0, expanded: [] });
