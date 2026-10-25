import type { GridField } from './types';

/**
 * Rows of a grouped grid (T312, T320a, FRONTEND §3.3). The grid draws
 * *display rows*: group headers, *data rows*, a "+" row at the end of
 * every expanded group and spacer rows between the group cards.
 * Everything outside the adapter (getRecord, selection ranges, clipboard,
 * editing, the viewport) speaks in data rows — the records shown, in
 * display order, other rows and rows of collapsed groups left out — so a
 * header, a "+" row or a spacer is never a record.
 */

/** A group header drawn as one row (not a record). */
export interface GridGroupRow {
  /** Stable key of the group (field ids and values of its levels): collapse state. */
  readonly key: string;
  /** 0 = outermost level. */
  readonly level: number;
  /** Field of this level; `undefined` for the rows beyond the counted groups. */
  readonly field: GridField | undefined;
  /** Value of this level (json cell format); `null` = empty. */
  readonly value: unknown;
  /** Records in the group (all levels below). */
  readonly count: number;
  readonly collapsed: boolean;
  /** Rows beyond the groups the server counted (more than 10 000 groups). */
  readonly rest: boolean;
  /** The group has nested groups (a level below it). */
  readonly nested: boolean;
}

/**
 * Where a display row sits in the group cards (T320a): each group is a
 * card, nested groups are cards inside it.
 */
export interface GridRowFrame {
  /** Cards around the row: 0 = a spacer between top-level groups (page background). */
  readonly depth: number;
  /** First row of its innermost card (a header: the card's top border). */
  readonly top: boolean;
  /** Last row of its innermost card (the card's bottom border). */
  readonly bottom: boolean;
}

export type GridRowKind =
  | {
      readonly kind: 'data';
      readonly row: number;
      /** 1-based position in its group (row numbers restart in every group, like Lark). */
      readonly number: number;
      readonly frame: GridRowFrame;
    }
  | { readonly kind: 'group'; readonly group: GridGroupRow; readonly frame: GridRowFrame }
  /** "+" at the end of an expanded group: adds a record with the group's values. */
  | { readonly kind: 'add'; readonly group: GridGroupRow; readonly frame: GridRowFrame }
  /** Spacer between group cards. */
  | { readonly kind: 'gap'; readonly frame: GridRowFrame };

export interface GridRowModel {
  /** Rows the grid draws: headers, spacers, "+" rows and rows of expanded groups. */
  readonly displayCount: number;
  /** Records shown (rows of expanded groups). */
  readonly dataCount: number;
  /** Group levels (1…3): the nested cards the row gutter makes room for. */
  readonly depth: number;
  rowAt(display: number): GridRowKind;
  /**
   * Depth of a spacer row (`frame.depth`), `-1` for any other row.
   * Called for every row by the grid's height sums: no allocation, O(1)
   * for rows asked in order.
   */
  gapDepth(display: number): number;
  /** Display row of a data row. */
  displayOf(dataRow: number): number;
  /** First data row at or after a display row, `undefined` past the last one. */
  dataAtOrAfter(display: number): number | undefined;
  /** Last data row at or before a display row, `undefined` before the first one. */
  dataAtOrBefore(display: number): number | undefined;
  /** Groups a display row is in, outermost first (a header is in its own group). */
  pathAt(display: number): readonly GridGroupRow[];
  /** Display row of a group's header (`undefined` when not shown). */
  headerDisplay(key: string): number | undefined;
}

/** Whether a display row is a data row (not a header, a "+" row or a spacer). */
export function isDataKind(kind: GridRowKind): kind is Extract<GridRowKind, { kind: 'data' }> {
  return kind.kind === 'data';
}

/** Data rows of display rows `first`…`last` (inclusive); `undefined` when none is a data row. */
export function dataRangeOf(
  model: GridRowModel | undefined,
  first: number,
  last: number,
): { firstRow: number; lastRow: number } | undefined {
  if (model === undefined) return last < first ? undefined : { firstRow: first, lastRow: last };
  const from = model.dataAtOrAfter(first);
  const to = model.dataAtOrBefore(last);
  if (from === undefined || to === undefined || to < from) return undefined;
  return { firstRow: from, lastRow: to };
}
