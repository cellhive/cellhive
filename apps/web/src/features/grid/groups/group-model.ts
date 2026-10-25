import { stableQueryHash } from '../../../lib/query/keys';

import type {
  GridField,
  GridGroupRow,
  GridRowFrame,
  GridRowKind,
  GridRowModel,
} from '../../../grid';
import type { RowRange } from '../blocks/block-math';

/**
 * Rows of a grouped grid (T312, T320a, FRONTEND §3.3). Pure.
 *
 * The server returns rows in group order (T302); `POST …/records/group-counts`
 * with the same query gives every group combination in the same order with
 * its row count. From the counts alone the whole layout is known without
 * loading a row: group `g` starts at server offset = sum of the counts
 * before it. Three row spaces:
 *
 * - **server offset** — row of `records/query` (what blocks are made of);
 * - **data row** — the records shown, in order: rows of collapsed groups
 *   are left out (and never fetched);
 * - **display row** — what the grid draws. Every group is a card (Lark):
 *   a spacer before each top-level card, the header, then either the
 *   nested cards (spacers between them and one under the last) or the
 *   group's data rows and a "+" row (`addRows`). A collapsed group is its
 *   header alone.
 *
 * The model is a list of segments (a header, a "+" row, a spacer, or a run
 * of consecutive rows) and every mapping is a binary search over them
 * (a cursor makes rows asked in order O(1)).
 */

/** One group level as counted by the server (field ids, `field_key_type=id`). */
export interface GroupLevel {
  readonly fieldId: string;
  readonly direction: 'asc' | 'desc';
}

/** One group combination of `records/group-counts` (values in json cell format). */
export interface GroupCount {
  readonly values: readonly unknown[];
  readonly count: number;
}

/** A header with what the model needs besides drawing it. */
export interface GroupHeader extends GridGroupRow {
  /** Values of this level and the levels above (pre-filled in a record added to the group). */
  readonly values: readonly unknown[];
  /** Field ids of `values`. */
  readonly fieldIds: readonly string[];
  /** Server offset of the group's first row. */
  readonly offset: number;
}

export interface GroupModelInput {
  readonly levels: readonly GroupLevel[];
  readonly groups: readonly GroupCount[];
  /** More groups exist than counted (`truncated`): rows after them form one "rest" group. */
  readonly truncated?: boolean;
  /** Rows of the query when known (`total`): the size of the rest group. */
  readonly total?: number | null;
  /** Fields by id (the header draws the value like a cell). */
  readonly fields: ReadonlyMap<string, GridField>;
  readonly isCollapsed: (key: string) => boolean;
  /** A "+" row ends every expanded group (the user may add records, T320a). */
  readonly addRows?: boolean;
}

interface SegmentBase {
  readonly display: number;
  readonly frame: GridRowFrame;
}

interface HeaderSegment extends SegmentBase {
  readonly kind: 'header';
  readonly header: GroupHeader;
}

interface RowsSegment extends SegmentBase {
  readonly kind: 'rows';
  readonly data: number;
  readonly offset: number;
  readonly length: number;
  /** The innermost header of these rows. */
  readonly header: GroupHeader;
  /** Frame of the last row (the card's bottom when no "+" row follows). */
  readonly lastFrame: GridRowFrame;
}

interface AddSegment extends SegmentBase {
  readonly kind: 'add';
  readonly header: GroupHeader;
}

interface GapSegment extends SegmentBase {
  readonly kind: 'gap';
  /** The group whose card holds the spacer; `undefined` between top-level groups. */
  readonly owner: GroupHeader | undefined;
}

type Segment = HeaderSegment | RowsSegment | AddSegment | GapSegment;

/** Empty cell: `null`, `""`, `[]` (CONTRACTS §1.4 `group-counts`: `null`/`""` = empty). */
export function isEmptyGroupValue(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

function normalized(value: unknown): unknown {
  return isEmptyGroupValue(value) ? null : value;
}

/** Key of a group: field ids and values of its levels (the collapse state is kept by key). */
export function groupKey(fieldIds: readonly string[], values: readonly unknown[]): string {
  return stableQueryHash(fieldIds.map((fieldId, index) => [fieldId, normalized(values[index])]));
}

/** Key of the rows beyond the counted groups. */
export const REST_GROUP_KEY = 'rest';

type NodeHeader = Omit<GroupHeader, 'count' | 'collapsed' | 'nested'> & { count: number };

interface Node {
  readonly header: NodeHeader;
  readonly children: Node[];
}

/** Last index `i` with `key(items[i]) <= target` (items sorted by `key`), `-1` when none. */
function lastAtOrBefore<T>(items: readonly T[], target: number, key: (item: T) => number): number {
  let low = 0;
  let high = items.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (key(items[middle] as T) <= target) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

const frameOf = (depth: number, top: boolean, bottom: boolean): GridRowFrame => ({
  depth,
  top,
  bottom,
});

const OUTSIDE: GridRowFrame = frameOf(0, false, false);

export class GroupRowModel implements GridRowModel {
  readonly displayCount: number;
  readonly dataCount: number;
  /** Rows of every group (collapsed ones too). */
  readonly total: number;
  /** Top-level groups (the footer's "M groups"). */
  readonly groupCount: number;
  readonly depth: number;
  readonly levels: readonly GroupLevel[];
  readonly #segments: readonly Segment[];
  readonly #rows: readonly RowsSegment[];
  readonly #headers: ReadonlyMap<string, GroupHeader>;
  readonly #headerDisplay: ReadonlyMap<string, number>;
  /** Parent of each nested group (by key). */
  readonly #parents: ReadonlyMap<string, GroupHeader>;
  /** Segment found last: the grid asks for rows in order (height sums, drawing). */
  #cursor = 0;

  constructor(input: GroupModelInput) {
    this.levels = input.levels;
    const depth = input.levels.length;
    this.depth = Math.max(1, depth);
    const fieldIds = input.levels.map((level) => level.fieldId);
    const roots: Node[] = [];
    const open: Node[] = [];
    let offset = 0;
    for (const group of input.groups) {
      if (group.count <= 0) continue;
      // The first level whose value differs from the previous group closes the headers below it.
      let level = 0;
      while (level < open.length && level < depth) {
        const node = open[level] as Node;
        if (node.header.key !== groupKey(fieldIds.slice(0, level + 1), group.values)) break;
        level += 1;
      }
      open.length = level;
      for (let at = level; at < depth; at += 1) {
        const values = group.values.slice(0, at + 1).map(normalized);
        const fieldId = fieldIds[at] as string;
        const node: Node = {
          header: {
            key: groupKey(fieldIds.slice(0, at + 1), values),
            level: at,
            field: input.fields.get(fieldId),
            value: values[at] ?? null,
            values,
            fieldIds: fieldIds.slice(0, at + 1),
            count: 0,
            offset,
            rest: false,
          },
          children: [],
        };
        (at === 0 ? roots : (open[at - 1] as Node).children).push(node);
        open.push(node);
      }
      for (const node of open) node.header.count += group.count;
      offset += group.count;
    }
    const counted = offset;
    const rest =
      input.truncated === true && input.total !== undefined && input.total !== null
        ? Math.max(0, input.total - counted)
        : 0;
    if (rest > 0) {
      roots.push({
        header: {
          key: REST_GROUP_KEY,
          level: 0,
          field: undefined,
          value: null,
          values: [],
          fieldIds: [],
          count: rest,
          offset: counted,
          rest: true,
        },
        children: [],
      });
    }
    this.total = counted + rest;
    this.groupCount = roots.length;

    const addRows = input.addRows === true;
    const segments: Segment[] = [];
    const rows: RowsSegment[] = [];
    const headers = new Map<string, GroupHeader>();
    const headerDisplay = new Map<string, number>();
    const parents = new Map<string, GroupHeader>();
    let display = 0;
    let data = 0;
    const gap = (cards: number, bottom: boolean, owner: GroupHeader | undefined) => {
      segments.push({ kind: 'gap', display, frame: frameOf(cards, false, bottom), owner });
      display += 1;
    };
    // Every group, shown or inside a collapsed one ("expand subgroups" reaches them).
    const built = new Map<Node, GroupHeader>();
    const register = (node: Node, parent: GroupHeader | undefined) => {
      const collapsed = input.isCollapsed(node.header.key);
      const header: GroupHeader = { ...node.header, collapsed, nested: node.children.length > 0 };
      built.set(node, header);
      headers.set(header.key, header);
      if (parent !== undefined) parents.set(header.key, parent);
      for (const child of node.children) register(child, header);
    };
    for (const root of roots) register(root, undefined);
    const emit = (node: Node) => {
      const header = built.get(node) as GroupHeader;
      const { collapsed } = header;
      const cards = header.level + 1;
      headerDisplay.set(header.key, display);
      segments.push({ kind: 'header', display, header, frame: frameOf(cards, true, collapsed) });
      display += 1;
      if (collapsed) return;
      if (node.children.length === 0) {
        const add = addRows && !header.rest;
        const frame = frameOf(cards, false, false);
        const segment: RowsSegment = {
          kind: 'rows',
          display,
          data,
          offset: header.offset,
          length: header.count,
          header,
          frame,
          lastFrame: add ? frame : frameOf(cards, false, true),
        };
        segments.push(segment);
        rows.push(segment);
        display += header.count;
        data += header.count;
        if (add) {
          segments.push({ kind: 'add', display, header, frame: frameOf(cards, false, true) });
          display += 1;
        }
        return;
      }
      node.children.forEach((child, index) => {
        if (index > 0) gap(cards, false, header);
        emit(child);
      });
      // Padding under the last nested card: the bottom of this card.
      gap(cards, true, header);
    };
    if (roots.length > 0) {
      for (const root of roots) {
        // A spacer before every top-level card (the first one too) and after the last.
        gap(0, false, undefined);
        emit(root);
      }
      gap(0, false, undefined);
    }
    this.#segments = segments;
    this.#rows = rows;
    this.#headers = headers;
    this.#headerDisplay = headerDisplay;
    this.#parents = parents;
    this.displayCount = display;
    this.dataCount = data;
  }

  /** The segment of a display row (`undefined` before the first one). */
  #segmentAt(display: number): Segment | undefined {
    const segments = this.#segments;
    const cursor = this.#cursor;
    const current = segments[cursor];
    if (current !== undefined && display >= current.display) {
      const next = segments[cursor + 1];
      if (next === undefined || display < next.display) return current;
      const after = segments[cursor + 2];
      if (after === undefined || display < after.display) {
        this.#cursor = cursor + 1;
        return next;
      }
    }
    const index = lastAtOrBefore(segments, display, (segment) => segment.display);
    if (index < 0) return undefined;
    this.#cursor = index;
    return segments[index];
  }

  rowAt(display: number): GridRowKind {
    const segment = this.#segmentAt(display);
    if (segment === undefined) return { kind: 'gap', frame: OUTSIDE };
    switch (segment.kind) {
      case 'header':
        return { kind: 'group', group: segment.header, frame: segment.frame };
      case 'add':
        return { kind: 'add', group: segment.header, frame: segment.frame };
      case 'gap':
        return { kind: 'gap', frame: segment.frame };
      case 'rows': {
        const index = display - segment.display;
        return {
          kind: 'data',
          row: segment.data + index,
          number: index + 1,
          frame: index === segment.length - 1 ? segment.lastFrame : segment.frame,
        };
      }
    }
  }

  gapDepth(display: number): number {
    const segment = this.#segmentAt(display);
    return segment?.kind === 'gap' ? segment.frame.depth : -1;
  }

  /** The header of a display row, `undefined` for any other row. */
  headerAt(display: number): GroupHeader | undefined {
    const segment = this.#segmentAt(display);
    return segment?.kind === 'header' ? segment.header : undefined;
  }

  /** The group a "+" row adds to, `undefined` for any other row. */
  addAt(display: number): GroupHeader | undefined {
    const segment = this.#segmentAt(display);
    return segment?.kind === 'add' ? segment.header : undefined;
  }

  pathAt(display: number): GroupHeader[] {
    const segment = this.#segmentAt(display);
    const innermost =
      segment === undefined ? undefined : segment.kind === 'gap' ? segment.owner : segment.header;
    const path: GroupHeader[] = [];
    for (let at = innermost; at !== undefined; at = this.#parents.get(at.key)) path.unshift(at);
    return path;
  }

  #rowsOf(dataRow: number): RowsSegment | undefined {
    const index = lastAtOrBefore(this.#rows, dataRow, (segment) => segment.data);
    const segment = this.#rows[index];
    return segment !== undefined && dataRow < segment.data + segment.length ? segment : undefined;
  }

  displayOf(dataRow: number): number {
    const segment = this.#rowsOf(dataRow);
    return segment === undefined ? this.displayCount : segment.display + (dataRow - segment.data);
  }

  dataAtOrAfter(display: number): number | undefined {
    // The first run of rows that ends at or after `display`.
    const index = lastAtOrBefore(this.#rows, display, (segment) => segment.display);
    const current = this.#rows[index];
    if (current !== undefined && display < current.display + current.length) {
      return current.data + Math.max(0, display - current.display);
    }
    return this.#rows[index + 1]?.data;
  }

  dataAtOrBefore(display: number): number | undefined {
    const index = lastAtOrBefore(this.#rows, display, (segment) => segment.display);
    const current = this.#rows[index];
    if (current === undefined) return undefined;
    return current.data + Math.min(current.length - 1, display - current.display);
  }

  /** Server offset of a data row. */
  offsetOf(dataRow: number): number | undefined {
    const segment = this.#rowsOf(dataRow);
    return segment === undefined ? undefined : segment.offset + (dataRow - segment.data);
  }

  /** Data row of a server offset; `undefined` when its group is collapsed (or past the end). */
  dataRowOf(offset: number): number | undefined {
    const index = lastAtOrBefore(this.#rows, offset, (segment) => segment.offset);
    const segment = this.#rows[index];
    if (segment === undefined || offset >= segment.offset + segment.length) return undefined;
    return segment.data + (offset - segment.offset);
  }

  /**
   * Server rows of data rows `first`…`last` (inclusive) as ranges of
   * consecutive offsets: rows of collapsed groups in between are skipped.
   */
  offsetRanges(first: number, last: number): RowRange[] {
    const ranges: RowRange[] = [];
    if (last < first || this.dataCount === 0) return ranges;
    const from = Math.max(0, first);
    const to = Math.min(this.dataCount - 1, last);
    let index = Math.max(
      0,
      lastAtOrBefore(this.#rows, from, (segment) => segment.data),
    );
    for (; index < this.#rows.length; index += 1) {
      const segment = this.#rows[index] as RowsSegment;
      if (segment.data > to) break;
      const start = Math.max(from, segment.data);
      const end = Math.min(to, segment.data + segment.length - 1);
      if (end < start) continue;
      const range = {
        firstRow: segment.offset + (start - segment.data),
        lastRow: segment.offset + (end - segment.data),
      };
      const previous = ranges.at(-1);
      if (previous !== undefined && previous.lastRow + 1 === range.firstRow) {
        ranges[ranges.length - 1] = { firstRow: previous.firstRow, lastRow: range.lastRow };
      } else {
        ranges.push(range);
      }
    }
    return ranges;
  }

  /** The innermost group of a data row (its values are pre-filled by "add below"). */
  groupOf(dataRow: number): GroupHeader | undefined {
    return this.#rowsOf(dataRow)?.header;
  }

  /** The innermost group containing a server offset (collapsed or not). */
  groupAtOffset(offset: number): GroupHeader | undefined {
    let found: GroupHeader | undefined;
    for (const header of this.#headers.values()) {
      if (offset >= header.offset && offset < header.offset + header.count) {
        if (found === undefined || header.level > found.level) found = header;
      }
    }
    return found;
  }

  header(key: string): GroupHeader | undefined {
    return this.#headers.get(key);
  }

  /** Display row of a header (shown or not: a header inside a collapsed group is not). */
  headerDisplay(key: string): number | undefined {
    return this.#headerDisplay.get(key);
  }

  /** Every group (inside collapsed ones too), outer before inner, in row order. */
  headers(): GroupHeader[] {
    return [...this.#headers.values()];
  }

  /** Keys of the groups nested in a group (every level below it, shown or not). */
  descendants(key: string): string[] {
    const keys: string[] = [];
    for (const [child, parent] of this.#parents) {
      for (
        let at: GroupHeader | undefined = parent;
        at !== undefined;
        at = this.#parents.get(at.key)
      ) {
        if (at.key === key) {
          keys.push(child);
          break;
        }
      }
    }
    return keys;
  }
}
