import { RECORD_BLOCK_SIZE } from '../../../lib/query/queries';

/**
 * Block arithmetic of the windowed grid (FRONTEND §3.3). Pure functions:
 * rows are 0-based, ranges inclusive, blocks of `RECORD_BLOCK_SIZE` rows.
 */

/** Blocks kept around the visible ones on each side. */
export const BLOCK_PADDING = 1;
/** Prefetch the next block in the scroll direction within this many rows of a block edge. */
export const PREFETCH_DISTANCE = 50;
/** Blocks kept per grid (6 000 rows); older ones are evicted (LRU). */
export const MAX_CACHED_BLOCKS = 30;
/** Debounce while the scroll bar is dragged or the view jumps (FRONTEND §3.3). */
export const DRAG_DEBOUNCE_MS = 50;

export type ScrollDirection = 'up' | 'down' | 'none';

export interface RowRange {
  readonly firstRow: number;
  readonly lastRow: number;
}

export function blockOf(row: number, blockSize = RECORD_BLOCK_SIZE): number {
  return Math.floor(Math.max(0, row) / blockSize);
}

/** Number of blocks holding `rowCount` rows. */
export function blockCount(rowCount: number, blockSize = RECORD_BLOCK_SIZE): number {
  return Math.ceil(Math.max(0, rowCount) / blockSize);
}

/**
 * Blocks to have loaded for a visible range: the visible blocks ± `padding`,
 * within `[0, blockCount)` when the row count is known (`null` = unknown,
 * e.g. before block 0 answered: then only the visible blocks and after).
 */
export function neededBlocks(
  range: RowRange,
  rowCount: number | null,
  padding = BLOCK_PADDING,
  blockSize = RECORD_BLOCK_SIZE,
): number[] {
  const first = blockOf(Math.min(range.firstRow, range.lastRow), blockSize) - padding;
  let last = blockOf(Math.max(range.firstRow, range.lastRow), blockSize) + padding;
  if (rowCount !== null) last = Math.min(last, blockCount(rowCount, blockSize) - 1);
  const blocks: number[] = [];
  for (let index = Math.max(0, first); index <= last; index += 1) blocks.push(index);
  return blocks;
}

/** Direction of a scroll from the previous visible range to the next one. */
export function scrollDirection(previous: RowRange | null, next: RowRange): ScrollDirection {
  if (previous === null || previous.firstRow === next.firstRow) return 'none';
  return next.firstRow > previous.firstRow ? 'down' : 'up';
}

/**
 * The block to prefetch beyond the needed ones (FRONTEND §3.3): scrolling
 * down with the last visible row less than `PREFETCH_DISTANCE` rows from the
 * end of its block → the block after the padded range; mirrored upwards.
 * `null` when not near an edge, not scrolling, or beyond the table.
 */
export function prefetchBlock(
  range: RowRange,
  direction: ScrollDirection,
  rowCount: number | null,
  padding = BLOCK_PADDING,
  blockSize = RECORD_BLOCK_SIZE,
  distance = PREFETCH_DISTANCE,
): number | null {
  if (direction === 'down') {
    const edgeBlock = blockOf(range.lastRow, blockSize);
    const rowsToEdge = (edgeBlock + 1) * blockSize - 1 - range.lastRow;
    if (rowsToEdge >= distance) return null;
    const target = edgeBlock + padding + 1;
    if (rowCount !== null && target >= blockCount(rowCount, blockSize)) return null;
    return target;
  }
  if (direction === 'up') {
    const edgeBlock = blockOf(range.firstRow, blockSize);
    const rowsToEdge = range.firstRow - edgeBlock * blockSize;
    if (rowsToEdge >= distance) return null;
    const target = edgeBlock - padding - 1;
    return target >= 0 ? target : null;
  }
  return null;
}

/**
 * Whether a viewport change should wait `DRAG_DEBOUNCE_MS`: while the scroll
 * bar is dragged, or when the view jumped past the padded blocks (fast
 * scroll), so intermediate positions do not each start requests.
 */
export function shouldDebounce(
  previous: RowRange | null,
  next: RowRange,
  dragging: boolean,
  blockSize = RECORD_BLOCK_SIZE,
): boolean {
  if (dragging) return true;
  if (previous === null) return false;
  return Math.abs(next.firstRow - previous.firstRow) > blockSize * (BLOCK_PADDING + 1);
}
