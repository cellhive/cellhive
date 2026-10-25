import { markerCellRenderer, type MarkerCell } from '@glideapps/glide-data-grid';

import { drawChevron, drawPlus, gutterContent, paintGutter, type CardColors } from './group-card';

import type { GridRowModel } from '../rows';

/** What the row gutter of a grouped grid reads while drawing (a ref: the renderer stays the same). */
export interface GutterSource {
  readonly model: GridRowModel;
  readonly colors: CardColors;
  /** Chevron and "+" color. */
  readonly icon: string;
  /** "+" color. */
  readonly accent: string;
}

type MarkerRenderer = typeof markerCellRenderer;

/** Glide's first row number (`rowMarkers.startIndex`): marker `row` = display row + 1. */
const START_INDEX = 1;

/**
 * Glide's row-marker renderer for grouped rows (T320a): the column is the
 * row gutter of the group cards — card bands and borders, the row number
 * *within its group* (Lark restarts at 1 in every group; glide would count
 * headers and spacers), the check box on hover (whole-row selection), a
 * header's chevron and the "+" of a "+" row. Plain grids (no source) keep
 * glide's marker as it is.
 */
export function groupGutterRenderer(source: () => GutterSource | undefined): MarkerRenderer {
  return {
    ...markerCellRenderer,
    getAccessibilityString: (cell: MarkerCell) => {
      const current = source();
      if (current === undefined) return String(cell.row);
      const kind = current.model.rowAt(cell.row - START_INDEX);
      return kind.kind === 'data' ? String(kind.number) : '';
    },
    draw: (args, cell) => {
      const current = source();
      if (current === undefined) {
        markerCellRenderer.draw(args, cell);
        return;
      }
      const { ctx, rect } = args;
      const kind = current.model.rowAt(cell.row - START_INDEX);
      // Under an expanded header with nested groups, the first nested card's top border is the line.
      const rowLine =
        kind.kind === 'data' ||
        (kind.kind === 'group' && (kind.group.collapsed || !kind.group.nested));
      paintGutter(ctx, rect, kind.frame, kind.kind, current.colors, args.highlighted, rowLine);
      const content = gutterContent(rect, kind.frame);
      const middle = content.y + content.height / 2;
      const center = content.x + content.width / 2;
      switch (kind.kind) {
        case 'data': {
          const numbered: MarkerCell = { ...cell, row: kind.number };
          markerCellRenderer.draw({ ...args, rect: content, cell: numbered }, numbered);
          return;
        }
        case 'group':
          drawChevron(ctx, center, middle, kind.group.collapsed, current.icon);
          return;
        case 'add':
          drawPlus(ctx, center, middle, current.accent);
          return;
        case 'gap':
          return;
      }
    },
  };
}
