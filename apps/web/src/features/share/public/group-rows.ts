import type {
  GridField,
  GridGroupRow,
  GridRowFrame,
  GridRowKind,
  GridRowModel,
} from '../../../grid';

/**
 * Group header rows of a shared grid (T317, FRONTEND §3.3 "Group"): the
 * server returns rows in the order of the view's group levels and
 * `records/group-counts` returns every combination of group values with
 * its row count **in the same order**, so the position of every header is
 * known before the rows load. Through a link groups are never collapsed:
 * data rows are exactly the rows of the record query. With `cards` (the
 * canvas grid, T320a) every group is a card: spacer rows before, between
 * and after the cards like the grid of the app (no "+" rows: read-only).
 * Pure.
 */

export interface GroupCount {
  readonly values: readonly unknown[];
  readonly count: number;
}

interface Segment {
  readonly display: number;
  readonly kind: 'header' | 'rows' | 'gap';
  readonly frame: GridRowFrame;
  /** Header of the segment (headers, rows); the card holding a spacer. */
  readonly group: GridGroupRow | undefined;
  /** Rows: the first data row and how many. */
  readonly data: number;
  length: number;
}

interface Node {
  group: GridGroupRow;
  readonly children: Node[];
  readonly data: number;
}

function sameValue(a: unknown, b: unknown): boolean {
  const empty = (value: unknown) =>
    value === undefined ||
    value === null ||
    value === '' ||
    (Array.isArray(value) && value.length === 0);
  if (empty(a) && empty(b)) return true;
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** Last index `i` of a sorted array with `key(items[i]) <= target`, or -1. */
function lastAtMost<T>(items: readonly T[], target: number, key: (item: T) => number): number {
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

const frame = (depth: number, top: boolean, bottom: boolean): GridRowFrame => ({
  depth,
  top,
  bottom,
});

/**
 * The row model (`GridViewProps.rowModel`) of `recordCount` rows grouped by
 * `levels` (fields, outermost first) with the `groups` of `group-counts`. A
 * header opens at every level whose value (or an outer one) changes. Rows
 * past the counted groups (more than 10 000 groups, or rows added since the
 * counts) follow in the last group.
 */
export function shareRowModel(
  levels: readonly (GridField | undefined)[],
  groups: readonly GroupCount[],
  recordCount: number,
  options: { readonly cards?: boolean } = {},
): GridRowModel {
  const depth = levels.length;
  const cards = options.cards === true;
  const roots: Node[] = [];
  const parents = new Map<string, GridGroupRow>();
  if (depth > 0) {
    const open: Node[] = [];
    let previous: readonly unknown[] | null = null;
    let records = 0;
    for (const group of groups) {
      if (group.count <= 0) continue;
      let changed = 0;
      if (previous !== null) {
        while (changed < depth && sameValue(previous[changed], group.values[changed])) changed += 1;
        if (changed === depth) changed = depth - 1;
      }
      open.length = Math.min(open.length, changed);
      for (let level = changed; level < depth; level += 1) {
        const node: Node = {
          group: {
            key: JSON.stringify(group.values.slice(0, level + 1)),
            level,
            field: levels[level],
            value: group.values[level] ?? null,
            count: 0,
            collapsed: false,
            rest: false,
            nested: level < depth - 1,
          },
          children: [],
          data: records,
        };
        (level === 0 ? roots : (open[level - 1] as Node).children).push(node);
        open.push(node);
      }
      for (const node of open)
        node.group = { ...node.group, count: node.group.count + group.count };
      records += group.count;
      previous = group.values;
    }
  }

  const segments: Segment[] = [];
  const rows: Segment[] = [];
  const headerDisplay = new Map<string, number>();
  let display = 0;
  const push = (segment: Omit<Segment, 'display'>) => {
    const full: Segment = { ...segment, display };
    segments.push(full);
    display += segment.length;
    return full;
  };
  const gap = (depthOf: number, bottom: boolean, owner: GridGroupRow | undefined) => {
    if (cards) {
      push({ kind: 'gap', frame: frame(depthOf, false, bottom), group: owner, data: 0, length: 1 });
    }
  };
  const emit = (node: Node) => {
    const level = node.group.level;
    headerDisplay.set(node.group.key, display);
    push({
      kind: 'header',
      frame: frame(level + 1, true, false),
      group: node.group,
      data: 0,
      length: 1,
    });
    if (node.children.length === 0) {
      rows.push(
        push({
          kind: 'rows',
          frame: frame(level + 1, false, false),
          group: node.group,
          data: node.data,
          length: node.group.count,
        }),
      );
      return;
    }
    node.children.forEach((child, index) => {
      parents.set(child.group.key, node.group);
      if (index > 0) gap(level + 1, false, node.group);
      emit(child);
    });
    gap(level + 1, true, node.group);
  };
  for (const root of roots) {
    gap(0, false, undefined);
    emit(root);
  }
  const counted = rows.reduce((sum, segment) => sum + segment.length, 0);
  const extra = Math.max(0, recordCount - counted);
  const last = rows.at(-1);
  if (last === undefined) {
    rows.push(
      push({
        kind: 'rows',
        frame: frame(0, false, false),
        group: undefined,
        data: 0,
        length: extra,
      }),
    );
  } else if (extra > 0) {
    // Rows added since the counts: at the end of the last group (no spacer after it yet).
    last.length += extra;
    for (const segment of segments.slice(segments.indexOf(last) + 1)) {
      (segment as { display: number }).display += extra;
    }
    display += extra;
  }
  if (roots.length > 0) gap(0, false, undefined);
  const displayCount = display;

  const segmentAt = (row: number) =>
    segments[
      Math.max(
        0,
        lastAtMost(segments, row, (s) => s.display),
      )
    ];
  const rowAt = (row: number): GridRowKind => {
    const segment = segmentAt(row);
    if (segment === undefined) return { kind: 'gap', frame: frame(0, false, false) };
    if (segment.kind === 'header' && segment.group !== undefined) {
      return { kind: 'group', group: segment.group, frame: segment.frame };
    }
    if (segment.kind === 'gap') return { kind: 'gap', frame: segment.frame };
    const index = row - segment.display;
    const isLast = index === segment.length - 1 && segment.group !== undefined;
    return {
      kind: 'data',
      row: segment.data + index,
      number: index + 1,
      frame: isLast ? { ...segment.frame, bottom: true } : segment.frame,
    };
  };
  const rowsAt = (data: number) => rows[lastAtMost(rows, data, (segment) => segment.data)];

  return {
    displayCount,
    dataCount: recordCount,
    depth: Math.max(1, depth),
    rowAt,
    gapDepth: (row) => {
      const segment = segmentAt(row);
      return segment?.kind === 'gap' ? segment.frame.depth : -1;
    },
    displayOf: (data) => {
      const segment = rowsAt(data);
      return segment === undefined ? data : segment.display + (data - segment.data);
    },
    dataAtOrAfter: (row) => {
      const index = lastAtMost(rows, row, (segment) => segment.display);
      const current = rows[index];
      if (current !== undefined && row < current.display + current.length) {
        return current.data + Math.max(0, row - current.display);
      }
      const next = rows[index + 1];
      return next === undefined || next.length === 0 ? undefined : next.data;
    },
    dataAtOrBefore: (row) => {
      for (
        let index = lastAtMost(rows, row, (segment) => segment.display);
        index >= 0;
        index -= 1
      ) {
        const current = rows[index] as Segment;
        if (current.length > 0) {
          return current.data + Math.min(current.length - 1, row - current.display);
        }
      }
      return undefined;
    },
    pathAt: (row) => {
      const path: GridGroupRow[] = [];
      for (let at = segmentAt(row)?.group; at !== undefined; at = parents.get(at.key)) {
        path.unshift(at);
      }
      return path;
    },
    headerDisplay: (key) => headerDisplay.get(key),
  };
}
