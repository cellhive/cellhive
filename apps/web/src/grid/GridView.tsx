import '@glideapps/glide-data-grid/dist/index.css';
import './grid.css';

import { cn, Tooltip } from '@cellhive/ui';
import {
  AllCellRenderers,
  CompactSelection,
  DataEditorCore,
  GridCellKind,
  InnerGridCellKind,
  sprites,
  type CellClickedEventArgs,
  type DataEditorRef,
  type DrawCellCallback,
  type DrawHeaderCallback,
  type EditableGridCell,
  type FillPatternEventArgs,
  type GridCell,
  type GridColumn,
  type GridKeyEventArgs,
  type GridMouseEventArgs,
  type GridSelection,
  type HeaderClickedEventArgs,
  type Item,
  type ProvideEditorCallback,
  type Rectangle,
  type Theme,
} from '@glideapps/glide-data-grid';
import { Maximize2, Plus, Upload } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
} from 'react';
import { useTranslation } from 'react-i18next';

import { buttonKey, buttonViewOf } from '../lib/buttons/model';

import { columnHeaderLabel, useColumnHeaderLabels, type HeaderHint } from './a11y';
import { CellCache, KeyedCache, ObjectCache } from './cell-cache';
import { renderButton } from './cellRenderers/button';
import { loadingCell } from './cellRenderers/common';
import { renderCell } from './cellRenderers/index';
import { convertingColumnTheme, HEADER_ICONS, toGridColumns } from './columns';
import { drawHeaderBadge, hitsHeaderBadge, type HeaderBadge } from './computed-header';
import { attachmentsCellRenderer } from './customCells/attachments';
import { buttonCellRenderer, buttonPillRect, measureButtonText } from './customCells/button';
import { chipsCellRenderer } from './customCells/chips';
import { computedMarkRenderer } from './customCells/computed';
import {
  gapHeight,
  gutterWidth,
  paintCardCell,
  strokeCardCell,
  type CardCellLines,
  type CardColors,
} from './customCells/group-card';
import { groupGutterRenderer, type GutterSource } from './customCells/group-gutter';
import {
  cardCellRenderer,
  groupHeaderRenderer,
  type CardCell,
  type GroupHeaderCell,
  type GroupHeaderColors,
  type PlacedGroupSummary,
} from './customCells/group-header';
import { isLinksCell, linkChipAt, linksCellRenderer } from './customCells/links';
import { progressCellRenderer, ratingCellRenderer } from './customCells/meters';
import { usersCellRenderer } from './customCells/users';
import { groupValueDisplay } from './display/group';
import { editorTakesTyping, editsInPlace, editsWithPicker, isEditableField } from './editors/index';
import { createOverlayEditor, isEditCell } from './editors/overlay';
import { preloadOverlayEditor } from './editors/preload';
import { GroupStickyPath } from './GroupStickyPath';
import { RetryingImageLoader } from './image-loader';
import {
  dataRangeOf,
  type GridGroupRow,
  type GridRowFrame,
  type GridRowKind,
  type GridRowModel,
} from './rows';
import { drawRuleColor, type GridCellPaint, type GridColorPaint } from './rule-colors';
import {
  HEADER_HEIGHT,
  ROW_HEIGHTS,
  useGridAppearance,
  withAlphaHex,
  type GridDensity,
  type GridPalette,
} from './theme';
import { useTreeGridA11y } from './tree/a11y';
import { drawChildCount, drawTreeLead, hitsCaret, treeInset, type TreeColors } from './tree/draw';
import { treeKeyAction } from './tree/keys';
import { stickyTreePath } from './tree/sticky';
import { TreeRowTools, type TreeHover } from './tree/TreeRowTools';
import { TreeStickyPath, type TreeCrumb } from './tree/TreeStickyPath';
import { TypeToEdit } from './type-to-edit';

import type { ClipboardContent } from './clipboard';
import type {
  CellEditHooks,
  GridInteractionHooks,
  GridSelectionRange,
  LinkChipHover,
} from './hooks';
import type { GridTree } from './tree/types';
import type { CellFileAccess, CellRenderContext, GridField, GridRecord } from './types';
import type { LocaleContext } from '@cellhive/field-types';

const CUSTOM_RENDERERS = [
  chipsCellRenderer,
  groupHeaderRenderer,
  cardCellRenderer,
  usersCellRenderer,
  progressCellRenderer,
  ratingCellRenderer,
  linksCellRenderer,
  attachmentsCellRenderer,
  computedMarkRenderer,
  buttonCellRenderer,
];

/** Glide's cell renderers but the row marker (the gutter of the group cards, T320a). */
const BASE_RENDERERS = AllCellRenderers.filter(
  (renderer) => renderer.kind !== InnerGridCellKind.Marker,
);

/** Glide's header sprites plus ours (what `DataEditor` would merge). */
const ALL_SPRITES = { ...sprites, ...HEADER_ICONS };

/** Lines of a data cell in a card row: column separator, row line; the last one ends the card. */
const DATA_LINES: CardCellLines = { right: true, cardRight: false, bottom: true };
const DATA_LAST_LINES: CardCellLines = { right: true, cardRight: true, bottom: true };

/** Glide's horizontal lines are off while grouped: every cell draws its own (card look). */
const NO_LINE = 'rgba(0, 0, 0, 0)';

/** Whether a cell draws its own card (header, spacer, "+" row): `drawCell` leaves it alone. */
function isCardCell(cell: GridCell): boolean {
  if (cell.kind !== GridCellKind.Custom) return false;
  const kind = (cell.data as { kind?: unknown }).kind;
  return kind === 'ob-group' || kind === 'ob-card';
}

const NO_GROUPS: readonly GridGroupRow[] = [];

/** Roots of a tree are titled in medium weight (T417, board "Sub-records dạng cây"). */
const ROOT_THEME: Partial<Theme> = { baseFontStyle: '500 13px' };

/** A record of `records/tree` at depth 0. */
function isTreeRoot(record: GridRecord): boolean {
  const node = (record as { tree?: { depth?: unknown } }).tree;
  return node?.depth === 0;
}

/** Glide's horizontal cell padding (`cellHorizontalPadding`): where the text starts. */
const CELL_PADDING = 8;

/** Ancestors shown only for a filter are drawn at this opacity (T417). */
const DIMMED_ALPHA = 0.5;
const NO_CRUMBS: readonly TreeCrumb[] = [];

/** Height of the sticky parent path of a tree, px (board: 30). */
const TREE_PATH_HEIGHT = 30;

/** Most levels of a tree (SPEC §5.7): "Level 3 / 10". */
const TREE_LEVELS = 10;

/** Width of the row numbers (row markers) for `rows` rows. */
function numberWidth(rows: number): number {
  return Math.max(40, String(rows).length * 8 + 16);
}

/** Rows the grid shows, reported on every scroll (FRONTEND §3.3). */
export interface GridViewport {
  /**
   * First and last visible data row (inclusive; headers of a grouped grid
   * are not rows). Only headers on screen: `lastRow < firstRow`.
   */
  readonly firstRow: number;
  readonly lastRow: number;
  /** The user is dragging the scroll bar: the loader debounces (FRONTEND §3.3). */
  readonly dragging: boolean;
}

/** Imperative actions of the grid for the page (a new record gets the focus). */
export interface GridViewHandle {
  /** Scrolls to a cell and selects it (applied once `row` exists). */
  readonly focusCell: (row: number, column: number) => void;
  /** Gives the keyboard focus back to the grid, keeping its selection (T311: Esc in search). */
  readonly focus: () => void;
  /** Scrolls a row into view without moving the selection or the focus (record panel). */
  readonly scrollToRow: (row: number) => void;
  /**
   * Closes the open cell editor, if any, writing its last draft like a
   * click outside it (T322a: the record panel opens over the grid).
   */
  readonly closeEditor: () => void;
}

/**
 * Where the grid draws its columns (T472): the summary bar under it lines
 * its cells up with them and follows the horizontal scroll.
 */
export interface GridColumnLayout {
  /** Width of the row-number gutter, px. */
  readonly gutter: number;
  /** Columns in display order with their widths, px. */
  readonly columns: readonly { readonly fieldId: string; readonly width: number }[];
  /** Columns that stay in place when scrolling sideways. */
  readonly frozen: number;
  /** The element whose `scrollLeft` moves the other columns (`null` before it mounts). */
  readonly scroller: () => HTMLElement | null;
}

export interface GridViewProps {
  /** Columns in display order; the first (primary field) is frozen. */
  readonly fields: readonly GridField[];
  /** Data rows (records shown). */
  readonly rowCount: number;
  /** The record of a data row, `undefined` while its block loads (skeleton). */
  readonly getRecord: (row: number) => GridRecord | undefined;
  /**
   * Group headers between the data rows (T312, grouped view): the grid
   * draws `rowModel.displayCount` rows; every other prop and hook keeps
   * speaking in data rows. Absent: every row is a data row.
   */
  readonly rowModel?: GridRowModel | undefined;
  /**
   * Data row of a record (grouped grid): when the layout changes (a group
   * collapsed, counted again after an add) the selected cell follows its
   * record instead of staying on a display row that is now another row.
   */
  readonly rowOf?: ((recordId: string) => number | undefined) | undefined;
  /** Changes whenever rows arrive or change, so the canvas redraws. */
  readonly dataVersion: number;
  readonly onViewportChange: (viewport: GridViewport) => void;
  readonly density: GridDensity;
  readonly locale: LocaleContext;
  /** Accessible name of the grid (the table name). */
  readonly label: string;
  /** A new value scrolls back to the first row (the query changed, FRONTEND §3.3). */
  readonly scrollResetKey: string;
  readonly hooks?: GridInteractionHooks;
  readonly handleRef?: Ref<GridViewHandle>;
  /** Column widths by field id (resized columns); others use the type default. */
  readonly widths?: Readonly<Record<string, number>>;
  /** Columns kept in place while scrolling sideways; default 1 (the primary field). */
  readonly freezeColumns?: number;
  /**
   * A "+" after the last column header adds a field (T322a, like Lark and
   * Airtable); absent without the right to change the schema.
   */
  readonly onAddField?: (() => void) | undefined;
  /**
   * The rows are a sub-record tree (T417): every row is a record; the first
   * column draws the indent and the branch caret, ancestors shown only for
   * a filter are dimmed, the parent path sticks while scrolling a branch.
   */
  readonly tree?: GridTree | undefined;
  /**
   * Attachment fields whose images the user may load (T418,
   * `file_download_fields`); absent: files show as type badges only.
   */
  readonly fileAccess?: CellFileAccess | undefined;
  /**
   * Badges of computed column headers (T468) by field id: recompute
   * progress or a field-level error (`computed-header.ts`). A click on an
   * error badge calls `hooks.headerMenu.onHeaderBadge`.
   */
  readonly headerBadges?: ReadonlyMap<string, HeaderBadge> | undefined;
  /**
   * (T554) Notes of column headers by field id (a date reminder): a tip on
   * hover, added to the header's accessible name; a warning crosses out
   * the alarm icon.
   */
  readonly headerHints?: ReadonlyMap<string, HeaderHint> | undefined;
  /** (T472) Told the column layout whenever it changes (gutter, widths, frozen columns). */
  readonly onColumnLayout?: ((layout: GridColumnLayout) => void) | undefined;
  /**
   * (T816) Row and cell colors of the view's color rules: a background
   * under the content and a left mark. Absent: nothing is colored (and
   * glide draws without the cell callback when nothing else needs it).
   */
  readonly colors?: GridColorPaint | undefined;
}

/** The row-number column glide puts before the fields (`rowMarkers`). */
const ROW_MARKER_COLUMNS = 1;

/** Whether one of glide's overlay editors is open (it renders into `#portal`). */
function editorOpen(): boolean {
  const portal = document.getElementById('portal');
  return portal !== null && portal.childElementCount > 0;
}

/** Glide's overlay editors render into `#portal` at the end of `<body>`. */
function ensurePortal(): void {
  if (document.getElementById('portal') !== null) return;
  const portal = document.createElement('div');
  portal.id = 'portal';
  document.body.append(portal);
}

/**
 * Keys glide must not handle itself: copy, cut and paste come from the
 * document's clipboard events, Delete/Backspace and Ctrl/⌘+D from
 * `onKeyDown` (T205, `hooks.selection`). Enter, F2 and Space open the
 * editor of the selected cell (Space toggles a check box) unless Space
 * opens the record panel (`hooks.recordDetail`, FRONTEND §6.2).
 */
const KEYBINDINGS = {
  search: false,
  copy: false,
  cut: false,
  paste: false,
  clear: false,
  delete: false,
  downFill: false,
  rightFill: false,
  activateCell: ' |Enter|shift+Enter|F2',
} as const;

const EMPTY_SELECTION: GridSelection = {
  columns: CompactSelection.empty(),
  rows: CompactSelection.empty(),
};

/** Consecutive indexes as `[first, last]` runs. */
function runsOf(indexes: readonly number[]): [number, number][] {
  const runs: [number, number][] = [];
  for (const index of indexes) {
    const last = runs.at(-1);
    if (last !== undefined && last[1] === index - 1) last[1] = index;
    else runs.push([index, index]);
  }
  return runs;
}

/**
 * Cell ranges plus whole selected rows (row markers), in field ids and data
 * rows: group headers (T312) are not rows, a range of headers only is none.
 */
export function selectionRanges(
  selection: GridSelection,
  fields: readonly GridField[],
  rows?: GridRowModel,
): GridSelectionRange[] {
  const ranges =
    selection.current === undefined
      ? []
      : [selection.current.range, ...selection.current.rangeStack];
  const cellRanges = ranges.flatMap((range: Rectangle) => {
    const converted = rectangleRange(range, fields, rows);
    return converted === undefined ? [] : [converted];
  });
  const allFields = fields.map((field) => field.field.id);
  const rowRanges = runsOf(selection.rows.toArray()).flatMap(([first, last]) => {
    const data = dataRangeOf(rows, first, last);
    return data === undefined ? [] : [{ ...data, fieldIds: allFields, wholeRows: true }];
  });
  return [...rowRanges, ...cellRanges];
}

/**
 * The range paste, fill-down and the fill handle act on: the current cell
 * range, else the first run of selected rows (row markers) over every column.
 */
export function primaryRange(
  selection: GridSelection,
  fields: readonly GridField[],
  rows?: GridRowModel,
): GridSelectionRange | undefined {
  const range = selection.current?.range;
  if (range !== undefined) return rectangleRange(range, fields, rows);
  const run = runsOf(selection.rows.toArray())[0];
  if (run === undefined) return undefined;
  const data = dataRangeOf(rows, run[0], run[1]);
  return data === undefined
    ? undefined
    : { ...data, fieldIds: fields.map((field) => field.field.id) };
}

/** A rectangle of display rows as data rows (headers skipped); `undefined` when only headers. */
function rectangleRange(
  range: Rectangle,
  fields: readonly GridField[],
  rows?: GridRowModel,
): GridSelectionRange | undefined {
  const data = dataRangeOf(rows, range.y, range.y + range.height - 1);
  if (data === undefined) return undefined;
  return {
    ...data,
    fieldIds: fields.slice(range.x, range.x + range.width).map((field) => field.field.id),
  };
}

/**
 * Ctrl/⌘+D (FRONTEND §6.2, §6.4): the first row of the range fills the
 * others; a single row takes the value of the row above (as spreadsheets do).
 */
export function fillDownRanges(
  range: GridSelectionRange,
): { source: GridSelectionRange; destination: GridSelectionRange } | undefined {
  if (range.lastRow > range.firstRow) {
    return { source: { ...range, lastRow: range.firstRow }, destination: range };
  }
  if (range.firstRow === 0) return undefined;
  const above = range.firstRow - 1;
  return {
    source: { ...range, firstRow: above, lastRow: above },
    destination: { ...range, firstRow: above },
  };
}

/** Writes clipboard content after the copy event is over (rows had to load first). */
async function writeClipboardLater(content: ClipboardContent): Promise<void> {
  try {
    if (typeof ClipboardItem === 'function') {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([content.text], { type: 'text/plain' }),
          'text/html': new Blob([content.html], { type: 'text/html' }),
        }),
      ]);
      return;
    }
    await navigator.clipboard.writeText(content.text);
  } catch {
    // The browser refused (no user activation left): the clipboard stays as it was.
  }
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}

/** A cell that may be edited: glide opens its overlay (or toggles a check box). */
function editableCell(cell: GridCell): GridCell {
  switch (cell.kind) {
    case GridCellKind.Loading:
      return cell;
    case GridCellKind.Boolean:
      return { ...cell, readonly: false };
    default:
      return { ...cell, allowOverlay: true, readonly: false } as GridCell;
  }
}

/** Pending (light dashed accent) or refused (danger border + corner mark) cell. */
function drawCellState(
  ctx: CanvasRenderingContext2D,
  rect: Rectangle,
  status: 'pending' | 'error',
  palette: GridPalette,
): void {
  ctx.save();
  if (status === 'pending') {
    ctx.strokeStyle = withAlphaHex(palette.accent, 0.6);
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(rect.x + 1.5, rect.y + 1.5, rect.width - 3, rect.height - 3);
  } else {
    ctx.strokeStyle = palette.danger;
    ctx.lineWidth = 2;
    ctx.strokeRect(rect.x + 1, rect.y + 1, rect.width - 2, rect.height - 2);
    // Not color alone (FRONTEND §9.2): a corner mark, and the tooltip text.
    ctx.fillStyle = palette.danger;
    ctx.beginPath();
    ctx.moveTo(rect.x + rect.width - 9, rect.y + 2);
    ctx.lineTo(rect.x + rect.width - 2, rect.y + 2);
    ctx.lineTo(rect.x + rect.width - 2, rect.y + 9);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/** Files dragged over a cell that takes them (T418): where to outline, how many files. */
interface DropTarget {
  readonly col: number;
  readonly row: number;
  readonly count: number;
  readonly bounds: Rectangle;
}

/** Files (not text) being dragged: `dataTransfer.types` holds "Files". */
function draggingFiles(dataTransfer: DataTransfer | null): boolean {
  return dataTransfer !== null && Array.from(dataTransfer.types).includes('Files');
}

/** Number of files dragged (known during the drag through `items`). */
function draggedFileCount(dataTransfer: DataTransfer): number {
  const items = Array.from(dataTransfer.items).filter((item) => item.kind === 'file');
  return items.length > 0 ? items.length : dataTransfer.files.length;
}

/** The expand button on the hovered row (T206): screen position and record. */
interface ExpandTarget {
  readonly recordId: string;
  readonly x: number;
  readonly y: number;
  /** Row and first cell of the hovered row (the tree's row tools, T417). */
  readonly row: number;
  readonly cell: Rectangle;
}

/** Side of the expand button, px. */
const EXPAND_SIZE = 24;

/** The "+" of a hovered link cell (T413): opens its link picker. */
interface LinkPlusTarget {
  readonly col: number;
  readonly row: number;
  readonly x: number;
  readonly y: number;
}

/** Side of the "+" of a link cell, px (board "Ô liên kết trong grid"). */
const LINK_PLUS_SIZE = 24;
/** The button stays this long after the pointer leaves the row (to reach it). */
const EXPAND_HIDE_MS = 150;

/**
 * A key that types a character (any script: glide itself only starts
 * editing on printable ASCII, so "đ" or "é" would be dropped).
 */
export function isTypedCharacter(event: {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey?: boolean;
}): boolean {
  if (event.ctrlKey || event.metaKey) return false;
  // One code point (a letter outside the BMP is two UTF-16 units), not a named key.
  return /^.$/su.test(event.key) && event.key.trim() !== '';
}

/** Whether a cell rectangle (screen coordinates) shows inside the grid element. */
export function isCellOnScreen(bounds: Rectangle, area: DOMRect): boolean {
  return (
    bounds.x + bounds.width > area.left &&
    bounds.x < area.right &&
    bounds.y + bounds.height > area.top &&
    bounds.y < area.bottom
  );
}

interface Tip {
  readonly text: string;
  readonly tone: 'error' | 'info';
  readonly x: number;
  readonly y: number;
  readonly source: 'hover' | 'selection' | 'activation';
}

/**
 * The only component that renders glide's `DataEditor` (FRONTEND §1.3).
 * It knows nothing about fetching: rows come from `getRecord`, and the
 * visible range goes out through `onViewportChange`. With `hooks.edit`
 * the cells the user may change open the overlay editors of `editors/`.
 */
export function GridView({
  fields,
  rowCount,
  getRecord: getDataRecord,
  rowModel: model,
  rowOf,
  dataVersion,
  onViewportChange,
  density,
  locale,
  label,
  scrollResetKey,
  hooks,
  handleRef,
  widths,
  freezeColumns = 1,
  onAddField,
  tree,
  fileAccess,
  headerBadges,
  headerHints,
  onColumnLayout,
  colors,
}: GridViewProps) {
  const { t } = useTranslation('grid');
  const appearance = useGridAppearance();
  const editorRef = useRef<DataEditorRef>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const dragging = useRef(false);
  const [selection, setSelection] = useState<GridSelection>(EMPTY_SELECTION);
  const selectionNow = useRef<GridSelection>(EMPTY_SELECTION);
  const [tip, setTip] = useState<Tip | null>(null);
  const pendingFocus = useRef<Item | null>(null);
  /** Characters typed on a cell to start editing it, until its editor has the focus (`typeToEdit`). */
  const [typing] = useState(() => new TypeToEdit());
  /** The synthetic F2 that opens the editor is going through glide (not a user key). */
  const opening = useRef(false);
  /** Cells glide activated (`onCellActivated`): it accepted that F2 and opens the editor. */
  const activations = useRef(0);
  const [expand, setExpand] = useState<ExpandTarget | null>(null);
  const expandHide = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [linkPlus, setLinkPlus] = useState<LinkPlusTarget | null>(null);
  const linkPlusHide = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Key of the chip under the pointer (T413 hover card): reported only when it changes. */
  const hoveredChip = useRef<string | null>(null);
  const linkHooks = hooks?.link;
  const onOpenRecord = hooks?.recordDetail?.onOpenRecord;
  const onCellMenu = hooks?.recordDetail?.onCellMenu;
  /** The pointer is down on the grid: a selection landing on a group header is a click on it. */
  const pointerDown = useRef(false);
  /** Last visible region in display rows (reported again when the rows change, T312). */
  const region = useRef<Rectangle | null>(null);
  /** Headers pinned under the column header (the sticky group path, T320a). */
  const [stickyGroups, setStickyGroups] = useState<readonly GridGroupRow[]>(NO_GROUPS);
  /**
   * Ancestors (ids joined by "/") of the first row on screen of a tree: the
   * sticky parent path (T417). Set only when it changes: scrolling does not
   * render the grid again for every row.
   */
  const [stickyPath, setStickyPath] = useState('');
  /** Record of the selected cell: the selection follows it when the layout changes (T320a). */
  const selectedRecord = useRef<string | undefined>(undefined);

  useEffect(ensurePortal, []);
  const editable = hooks?.edit !== undefined;
  useEffect(() => {
    // The first type-to-edit must not wait for glide's lazy editor code.
    if (editable) preloadOverlayEditor();
  }, [editable]);
  useEffect(
    () => () => {
      typing.end();
    },
    [typing],
  );

  // Display rows (T312, T320a): group headers, "+" rows and spacers are drawn
  // between the data rows. Inside the adapter `getRecord` takes a display row;
  // only a data row has a record.
  const displayCount = model?.displayCount ?? rowCount;
  const getRecord = useCallback(
    (display: number): GridRecord | undefined => {
      if (model === undefined) return getDataRecord(display);
      const kind = model.rowAt(display);
      return kind.kind === 'data' ? getDataRecord(kind.row) : undefined;
    },
    [model, getDataRecord],
  );
  const toDisplay = useCallback((row: number) => model?.displayOf(row) ?? row, [model]);
  const dataOf = useCallback(
    (display: number): number | undefined => {
      if (model === undefined) return display;
      const kind = model.rowAt(display);
      return kind.kind === 'data' ? kind.row : undefined;
    },
    [model],
  );
  const groupAt = useCallback(
    (display: number): GridGroupRow | undefined => {
      if (model === undefined) return undefined;
      const kind = model.rowAt(display);
      return kind.kind === 'group' ? kind.group : undefined;
    },
    [model],
  );
  /** Not a data row: a header, a "+" row or a spacer. */
  const isOtherRow = useCallback(
    (display: number): boolean => model !== undefined && model.rowAt(display).kind !== 'data',
    [model],
  );

  const edit = hooks?.edit;
  const buttonHooks = hooks?.buttons;
  const selectionHooks = hooks?.selection;
  const fileHooks = hooks?.files;
  // The overlay reads these through refs: its editor must stay the same component while open.
  // The document's clipboard listeners read them too.
  const latest = useRef({ fields, getRecord, edit, selectionHooks, model, fileHooks });
  useLayoutEffect(() => {
    latest.current = { fields, getRecord, edit, selectionHooks, model, fileHooks };
  });
  /** Files dragged over a cell that takes them (T418). */
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  const ctx: CellRenderContext = useMemo(
    () => ({
      locale,
      palette: appearance.palette,
      labels: {
        formerMember: t('formerMember'),
        uploadHint: t('files.uploadHint'),
        noAccess: t('link.noAccess'),
        linkCount: (count: number) => t('link.count', { count }),
        computed: {
          locked: t('computed.lockedCell'),
          error: t('computed.errorCell'),
          pending: t('computed.pendingCell'),
        },
        buttonRunning: t('button.running'),
        buttonStates: {
          ready: t('button.readyState'),
          disabled: t('button.disabledState'),
          running: t('button.running'),
        },
      },
      files: fileAccess,
    }),
    [locale, appearance.palette, t, fileAccess],
  );

  const hasMenu = hooks?.headerMenu !== undefined;
  const reminderOff = useMemo(
    () =>
      new Set(
        [...(headerHints ?? new Map<string, HeaderHint>())]
          .filter(([, hint]) => hint.warning)
          .map(([fieldId]) => fieldId),
      ),
    [headerHints],
  );
  const columns = useMemo(
    () =>
      toGridColumns(fields, {
        hasMenu,
        ...(widths === undefined ? {} : { widths }),
        converting: convertingColumnTheme(appearance.palette),
        reminderOff,
      }),
    [fields, hasMenu, widths, appearance.palette, reminderOff],
  );
  const canEditField = edit?.canEditField;
  const headerLabels = useMemo(
    () =>
      fields.map((field) => {
        const text = columnHeaderLabel(field, t, headerBadges?.get(field.field.id));
        const label =
          canEditField !== undefined && !canEditField(field.field.id)
            ? t('header.readOnly', { label: text })
            : text;
        const hint = headerHints?.get(field.field.id);
        return hint === undefined ? label : t('header.withHint', { label, hint: hint.text });
      }),
    [fields, t, canEditField, headerBadges, headerHints],
  );
  useColumnHeaderLabels(container, headerLabels, 0);

  // Cells of a record object are built once; a changed record is a new object.
  // A new render context (theme, locale), new fields or new edit rights start a new cache.

  const treeRoot = tree !== undefined;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const cellCache = useMemo(() => new CellCache(), [ctx, fields, edit?.canEdit, treeRoot]);

  const canEditCell = useCallback(
    (field: GridField, record: GridRecord, hooksEdit: CellEditHooks | undefined): boolean =>
      hooksEdit !== undefined &&
      isEditableField(field) &&
      hooksEdit.canEdit({ recordId: record.id, fieldId: field.field.id }, record),
    [],
  );

  const groups = hooks?.groups;
  const groupSummaries = groups?.summaries;
  const palette = appearance.palette;
  const cardColors = useMemo<CardColors>(
    () => ({
      page: palette.sunken,
      card: palette.surface,
      line: palette.border,
      selected: palette.selected,
    }),
    [palette],
  );
  const headerColors = useMemo<GroupHeaderColors>(
    () => ({ text: palette.text, muted: palette.textMuted, card: cardColors }),
    [palette, cardColors],
  );
  // Columns a header's content spans: the frozen ones (at least the first), so it stays in place.
  const headerSpan = Math.max(1, Math.min(freezeColumns, fields.length));
  const headWidth = columns.slice(0, headerSpan).reduce((sum, column) => sum + column.width, 0);
  const rowWidth = columns.reduce((sum, column) => sum + column.width, 0);
  const numberFormat = useMemo(() => new Intl.NumberFormat(locale.locale), [locale.locale]);
  /** Label of a header (accessible name, tooltip of the sticky path, group menu). */
  const groupLabel = useCallback(
    (group: GridGroupRow) => {
      const display = group.rest
        ? { text: t('group.rest'), chips: null }
        : groupValueDisplay(group.field, group.value, ctx, t('group.empty'));
      const fieldName = group.rest ? '' : (group.field?.field.name ?? '');
      const formatted = numberFormat.format(group.count);
      return {
        display,
        count: t('group.records', { count: group.count, formatted }),
        label: t(group.collapsed ? 'group.a11yCollapsed' : 'group.a11yExpanded', {
          field: fieldName,
          value: display.text,
          count: group.count,
          formatted,
        }),
      };
    },
    [t, ctx, numberFormat],
  );
  /** Header cells of a group object: the head (frozen columns) and the tail (the others). */
  const buildHeaderCells = useCallback(
    (
      group: GridGroupRow,
      frame: GridRowFrame,
    ): { head: GroupHeaderCell; tail: GroupHeaderCell } => {
      const { display, count, label } = groupLabel(group);
      const hasTail = fields.length > headerSpan;
      // T472: the group's summaries over the tail's columns.
      const shown = groupSummaries?.(group);
      const placed: PlacedGroupSummary[] = [];
      if (shown !== undefined && shown.length > 0) {
        const byField = new Map(shown.map((item) => [item.fieldId, item]));
        let x = 0;
        for (let index = headerSpan; index < fields.length; index += 1) {
          const width = columns[index]?.width ?? 0;
          const item = byField.get(fields[index]?.field.id ?? '');
          if (item !== undefined) {
            placed.push({
              x,
              width,
              label: item.label,
              value: item.value ?? '—',
              right: item.right,
            });
          }
          x += width;
        }
      }
      const data = {
        kind: 'ob-group' as const,
        collapsed: group.collapsed,
        nested: group.nested,
        frame,
        chips: display.chips,
        text: display.text,
        empty: !group.rest && (group.value === null || display.chips?.length === 0),
        count,
        headWidth,
        rowWidth,
        hasTail,
        colors: headerColors,
        hits: { menu: null },
        ...(placed.length === 0 ? {} : { summaries: placed }),
      };
      const head: GroupHeaderCell = {
        kind: GridCellKind.Custom,
        allowOverlay: false,
        readonly: true,
        copyData: label,
        span: [0, headerSpan - 1],
        data: { ...data, part: 'head' },
      };
      const tail: GroupHeaderCell = {
        kind: GridCellKind.Custom,
        allowOverlay: false,
        readonly: true,
        copyData: '',
        ...(hasTail ? { span: [headerSpan, fields.length - 1] as [number, number] } : {}),
        // The same hits object: the tail records where an overflowing count lands.
        data: { ...data, part: 'tail', hits: data.hits },
      };
      return { head, tail };
    },
    [groupLabel, headerSpan, headerColors, fields, columns, headWidth, rowWidth, groupSummaries],
  );
  // Built once per group object; new texts, colors or columns: a new cache.
  const headerCache = useMemo(
    () => new ObjectCache<GridGroupRow, { head: GroupHeaderCell; tail: GroupHeaderCell }>(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [buildHeaderCells],
  );
  const headerCells = useCallback(
    (group: GridGroupRow, frame: GridRowFrame) =>
      headerCache.get(group, () => buildHeaderCells(group, frame)),
    [headerCache, buildHeaderCells],
  );
  /** Blank cells of spacers and "+" rows, by frame and column role (few distinct ones). */
  const lastColumn = fields.length - 1;
  const frozenLast = headerSpan - 1;
  // New colors or columns: a new cache.
  const cardCells = useMemo(
    () => new KeyedCache<CardCell>(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cardColors, lastColumn, frozenLast],
  );
  const cardCell = useCallback(
    (frame: GridRowFrame, kind: 'gap' | 'add', col: number, label = ''): CardCell => {
      const right = col === lastColumn || (kind === 'add' && col === frozenLast);
      const key = `${kind}|${String(frame.depth)}|${String(frame.top)}|${String(frame.bottom)}|${String(right)}|${String(col === lastColumn)}|${label}`;
      return cardCells.get(key, () => ({
        kind: GridCellKind.Custom,
        allowOverlay: false,
        readonly: true,
        copyData: label,
        data: {
          kind: 'ob-card',
          frame,
          lines: { right, cardRight: col === lastColumn, bottom: kind === 'add' },
          colors: cardColors,
        },
      }));
    },
    [cardCells, cardColors, lastColumn, frozenLast],
  );

  const getCellContent = useCallback(
    ([col, row]: Item): GridCell => {
      const field = fields[col];
      let record: GridRecord | undefined;
      if (model === undefined) {
        record = getDataRecord(row);
      } else {
        const kind: GridRowKind = model.rowAt(row);
        switch (kind.kind) {
          case 'group': {
            const cells = headerCells(kind.group, kind.frame);
            return col < headerSpan ? cells.head : cells.tail;
          }
          case 'add':
            return cardCell(
              kind.frame,
              'add',
              col,
              col === 0 ? t('group.addRecord', { group: groupLabel(kind.group).display.text }) : '',
            );
          case 'gap':
            return cardCell(kind.frame, 'gap', col);
          case 'data':
            record = getDataRecord(kind.row);
        }
      }
      if (field === undefined || record === undefined) return loadingCell();
      const loaded = record;
      // A button whose click runs (T525): "Running…", not cached (the set changes often).
      if (
        field.button !== undefined &&
        buttonHooks?.running.has(buttonKey(loaded.id, field.field.id))
      ) {
        return renderButton(loaded.fields[field.field.id], field.button, ctx, true);
      }
      return cellCache.get(loaded, col, () => {
        const cell = renderCell(field, loaded.fields[field.field.id], ctx);
        // Link cells open the link picker of the page (T413), never a glide overlay.
        const shown =
          canEditCell(field, loaded, edit) && !editsWithPicker(field) ? editableCell(cell) : cell;
        // A root of a tree (T417, board): its title in medium weight.
        return treeRoot && col === 0 && isTreeRoot(loaded)
          ? { ...shown, themeOverride: ROOT_THEME }
          : shown;
      });
    },
    // `dataVersion` (rows) and `edit` (cell states) give glide a new callback: the canvas redraws.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      fields,
      model,
      getDataRecord,
      cellCache,
      ctx,
      dataVersion,
      edit,
      canEditCell,
      headerCells,
      cardCell,
      groupLabel,
      headerSpan,
      t,
      treeRoot,
      buttonHooks,
    ],
  );

  const cellStateAt = useCallback(
    (col: number, row: number) => {
      const field = fields[col];
      const record = getRecord(row);
      if (field === undefined || record === undefined || edit?.cellState === undefined) {
        return undefined;
      }
      return edit.cellState({ recordId: record.id, fieldId: field.field.id });
    },
    [fields, getRecord, edit],
  );

  // Grouped (T320a): the page background behind the cards, glide's lines off
  // (every cell draws its own), rows as high as data rows but the spacers.
  const grouped = model !== undefined;
  const theme = useMemo<Partial<Theme>>(
    () =>
      grouped
        ? { ...appearance.theme, bgCell: palette.sunken, horizontalBorderColor: NO_LINE }
        : appearance.theme,
    [grouped, appearance.theme, palette.sunken],
  );
  const baseHeight = ROW_HEIGHTS[density];
  const rowHeight = useMemo(
    () =>
      model === undefined
        ? baseHeight
        : (display: number) => {
            const depth = model.gapDepth(display);
            return depth < 0 ? baseHeight : gapHeight(depth);
          },
    [model, baseHeight],
  );
  const hasCellStates = edit?.hasCellStates === true;
  const treeColors = useMemo<TreeColors>(
    () => ({
      guide: palette.border,
      caret: palette.textMuted,
      pill: palette.sunken,
      pillText: palette.textMuted,
    }),
    [palette],
  );
  const fontFamily = appearance.theme.fontFamily ?? 'sans-serif';
  /**
   * A cell of a tree (T417): the first column gets the guides and the
   * caret, its content moves right by the indent, a closed branch shows its
   * child count; every cell of an ancestor shown only for a filter is dimmed.
   */
  const drawTreeCell = useCallback(
    (args: Parameters<DrawCellCallback>[0], drawContent: () => void) => {
      const node = tree?.nodeAt(args.row);
      if (node === undefined) {
        drawContent();
        return;
      }
      const canvas = args.ctx;
      if (node.ancestorOnly) {
        canvas.save();
        canvas.globalAlpha = DIMMED_ALPHA;
      }
      if (args.col === 0) {
        drawTreeLead(canvas, args.rect, node, treeColors);
        const inset = treeInset(node.depth);
        // Glide hands its renderer this rectangle: the content starts after the tree.
        const rect = args.rect as { x: number; width: number };
        rect.x += inset;
        rect.width -= inset;
        try {
          drawContent();
        } finally {
          rect.x -= inset;
          rect.width += inset;
        }
        if (node.childCount > 0 && !node.expanded) {
          const cell = args.cell as { displayData?: unknown; copyData?: unknown };
          const text =
            typeof cell.displayData === 'string'
              ? cell.displayData
              : typeof cell.copyData === 'string'
                ? cell.copyData
                : '';
          canvas.save();
          canvas.font = `${node.depth === 0 ? '500 ' : ''}13px ${fontFamily}`;
          const width = canvas.measureText(text).width;
          canvas.restore();
          drawChildCount(
            canvas,
            args.rect,
            inset + CELL_PADDING + width,
            numberFormat.format(node.childCount),
            `12px ${fontFamily}`,
            treeColors,
          );
        }
      } else {
        drawContent();
      }
      if (node.ancestorOnly) canvas.restore();
    },
    [tree, treeColors, fontFamily, numberFormat],
  );
  const drawCell = useCallback<DrawCellCallback>(
    (args, drawContent) => {
      const content =
        tree === undefined
          ? drawContent
          : () => {
              drawTreeCell(args, drawContent);
            };
      // (T816) The cell's rule color, under its content (a lookup, no allocation).
      let paint: GridCellPaint | null = null;
      if (colors !== undefined && !isCardCell(args.cell)) {
        const field = fields[args.col];
        const record = getRecord(args.row);
        if (field !== undefined && record !== undefined) paint = colors(record, field.field.id);
      }
      if (model === undefined || isCardCell(args.cell)) {
        if (paint !== null) {
          drawRuleColor(args.ctx, args.rect, paint, args.col === 0, args.highlighted);
        }
        content();
      } else {
        const frame = model.rowAt(args.row).frame;
        const lines = args.col === lastColumn ? DATA_LAST_LINES : DATA_LINES;
        paintCardCell(args.ctx, args.rect, frame, lines, cardColors, args.highlighted);
        if (paint !== null) {
          drawRuleColor(args.ctx, args.rect, paint, args.col === 0, args.highlighted);
        }
        content();
        strokeCardCell(args.ctx, args.rect, frame, lines, cardColors);
      }
      if (!hasCellStates) return;
      const state = cellStateAt(args.col, args.row);
      if (state !== undefined) drawCellState(args.ctx, args.rect, state.status, palette);
    },
    [
      model,
      lastColumn,
      cardColors,
      hasCellStates,
      cellStateAt,
      palette,
      tree,
      drawTreeCell,
      colors,
      fields,
      getRecord,
    ],
  );
  // Glide's vertical lines are off while grouped: the column headers draw their separator.
  const hasBadges = headerBadges !== undefined && headerBadges.size > 0;
  const drawHeader = useCallback<DrawHeaderCallback>(
    (args, drawContent) => {
      drawContent();
      const { ctx: canvas, rect } = args;
      // Computed columns (T468): progress ring or error badge at the end of the header.
      const badge = headerBadges?.get(args.column.id ?? '');
      if (badge !== undefined) {
        const { theme: headerTheme } = args;
        drawHeaderBadge(
          {
            ctx: canvas,
            rect,
            theme: headerTheme,
            background: args.isSelected
              ? headerTheme.accentColor
              : args.hasSelectedCell
                ? headerTheme.bgHeaderHasFocus
                : args.isHovered
                  ? headerTheme.bgHeaderHovered
                  : headerTheme.bgHeader,
            menuShown: args.isHovered && args.column.hasMenu === true,
            palette,
          },
          badge,
        );
      }
      if (!grouped) return;
      canvas.save();
      canvas.beginPath();
      canvas.moveTo(rect.x + rect.width - 0.5, rect.y);
      canvas.lineTo(rect.x + rect.width - 0.5, rect.y + rect.height);
      canvas.strokeStyle = palette.border;
      canvas.lineWidth = 1;
      canvas.stroke();
      canvas.restore();
    },
    [palette, headerBadges, grouped],
  );
  // The row gutter (row markers) draws the cards' left side and per-group numbers.
  const gutterSource = useMemo<GutterSource | undefined>(
    () =>
      model === undefined
        ? undefined
        : { model, colors: cardColors, icon: palette.textMuted, accent: palette.accent },
    [model, cardColors, palette.textMuted, palette.accent],
  );
  const renderers = useMemo(
    () => [
      ...BASE_RENDERERS,
      // Glide picks renderers by `kind`: this one only ever gets marker cells.
      groupGutterRenderer(() => gutterSource) as unknown as (typeof BASE_RENDERERS)[number],
    ],
    [gutterSource],
  );
  // Retries a thumbnail the worker has not rendered yet (T421b).
  const imageWindowLoader = useMemo(() => new RetryingImageLoader(), []);

  const provideEditor = useCallback<ProvideEditorCallback<GridCell>>(() => {
    const current = latest.current;
    const cell = selectionNow.current.current?.cell;
    if (cell === undefined || current.edit === undefined) return undefined;
    const [col, row] = cell;
    const field = current.fields[col];
    const record = current.getRecord(row);
    if (field === undefined || record === undefined) return undefined;
    if (editsInPlace(field) || editsWithPicker(field)) return undefined;
    if (!canEditCell(field, record, current.edit)) return undefined;
    const typed = typing.inputFor(col, row);
    const editor = createOverlayEditor(field, record, current.edit.editorContext, typed);
    return editor === undefined
      ? undefined
      : { editor, disablePadding: true, disableStyling: true };
  }, [canEditCell, typing]);

  const onCellEdited = useCallback(([col, row]: Item, value: EditableGridCell) => {
    const current = latest.current;
    const field = current.fields[col];
    const record = current.getRecord(row);
    const hooksEdit = current.edit;
    if (field === undefined || record === undefined || hooksEdit === undefined) return;
    const address = { recordId: record.id, fieldId: field.field.id };
    if (value.kind === GridCellKind.Boolean) {
      hooksEdit.onCommit(address, value.data === true, record);
      return;
    }
    if (!isEditCell(value)) return;
    const draft = value.data.draft;
    if (draft.ok) {
      hooksEdit.onCommit(address, draft.commit.value, record, {
        display: draft.commit.display,
        typecast: draft.commit.typecast,
        baseVersion: value.data.baseVersion,
      });
    } else {
      hooksEdit.onInvalid?.(address, draft.issue);
    }
  }, []);

  const onFinishedEditing = useCallback(() => {
    typing.end();
  }, [typing]);

  /** Reports the data rows of a visible region (headers are not rows, T312). */
  const reportRegion = useCallback(
    (range: Rectangle) => {
      const first = range.y;
      const last = range.y + range.height - 1;
      const data = dataRangeOf(model, first, last);
      const empty = model?.dataAtOrAfter(first) ?? rowCount;
      onViewportChange({
        firstRow: data?.firstRow ?? empty,
        lastRow: data?.lastRow ?? empty - 1,
        dragging: dragging.current,
      });
    },
    [model, rowCount, onViewportChange],
  );
  /**
   * The sticky group path (T320a): headers of the groups around the first
   * row on screen whose header rows have scrolled away. Set only when it
   * changes: scrolling does not render the grid again for every row.
   */
  const updateSticky = useCallback(
    (top: number) => {
      const next =
        model === undefined || top <= 0
          ? NO_GROUPS
          : model.pathAt(top).filter((group) => {
              const display = model.headerDisplay(group.key);
              return display !== undefined && display < top;
            });
      setStickyGroups((current) =>
        current.length === next.length && current.every((group, index) => group === next[index])
          ? current
          : next.length === 0
            ? NO_GROUPS
            : next,
      );
    },
    [model],
  );
  /**
   * The sticky parent path of a tree (T417): the ancestors of the first row
   * shown under it (not one hidden behind the path itself) that scrolled
   * off the screen, and never while a root is the first row (T421b).
   */
  const updateTreePath = useCallback(() => {
    if (tree === undefined) return;
    const start = region.current?.y ?? 0;
    const canvas = container
      ?.querySelector('[data-testid="data-grid-canvas"]')
      ?.getBoundingClientRect();
    /** First row whose middle is below `limit` (the header, or the header and the path). */
    const firstBelow = (limit: number, from: number): number => {
      let row = from;
      for (let step = 0; step < 8; step += 1) {
        const bounds = editorRef.current?.getBounds(0, row);
        if (bounds === undefined || bounds.y + bounds.height / 2 >= limit) break;
        row += 1;
      }
      return row;
    };
    const first = canvas === undefined ? start : firstBelow(canvas.top + HEADER_HEIGHT, start);
    const underPath =
      canvas === undefined
        ? first
        : firstBelow(canvas.top + HEADER_HEIGHT + TREE_PATH_HEIGHT, first);
    setStickyPath(stickyTreePath(tree.nodeAt, first, underPath).join('/'));
  }, [tree, container]);
  const onVisibleRegionChanged = useCallback(
    (range: Rectangle) => {
      setExpand(null);
      setLinkPlus(null);
      if (hoveredChip.current !== null) {
        hoveredChip.current = null;
        linkHooks?.onChipHover?.(null);
      }
      region.current = range;
      updateSticky(range.y);
      if (tree !== undefined) {
        updateTreePath();
        // Smooth scrolling reports the region before the rows settle: once more after.
        requestAnimationFrame(updateTreePath);
      }
      reportRegion(range);
    },
    [reportRegion, updateSticky, linkHooks, tree, updateTreePath],
  );
  useEffect(() => {
    updateSticky(region.current?.y ?? 0);
  }, [updateSticky]);
  // The tree's layout changed (a branch opened, rows arrived): the same screen, another path.
  useEffect(() => {
    updateTreePath();
  }, [updateTreePath, dataVersion]);
  const crumbs = useMemo<readonly TreeCrumb[]>(
    () =>
      tree === undefined || stickyPath === ''
        ? NO_CRUMBS
        : stickyPath.split('/').map((recordId) => ({ recordId, title: tree.titleOf(recordId) })),
    // Titles arrive with the rows (`dataVersion`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tree, stickyPath, dataVersion],
  );
  useTreeGridA11y(container, tree, dataVersion);
  // Groups collapsed or counted again: the same screen shows other data rows.
  useEffect(() => {
    if (model !== undefined && region.current !== null) reportRegion(region.current);
  }, [model, reportRegion]);
  // New tree rows (another query: search, filter; T417) or back to flat rows: they learn
  // what the screen shows.
  useEffect(() => {
    if (region.current !== null) reportRegion(region.current);
  }, [tree, reportRegion]);

  // Dragging the scroll bar thumb: pointer down on the scroller outside its content box.
  useEffect(() => {
    if (container === null) return;
    const onPointerDown = (event: PointerEvent) => {
      pointerDown.current = true;
      // A click while the editor is on its way: the text typed so far is final.
      typing.release();
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.classList.contains('dvn-scroller')) return;
      if (event.offsetX >= target.clientWidth || event.offsetY >= target.clientHeight) {
        dragging.current = true;
      }
    };
    const onPointerUp = () => {
      dragging.current = false;
      pointerDown.current = false;
    };
    // Glide focuses the grid a frame after a click: keys typed at once (type to
    // edit right after a page load) went to the page. The click is handled by now.
    const onGridPointerUp = (event: PointerEvent) => {
      const active = document.activeElement;
      if (event.button !== 0 || (active !== null && container.contains(active))) return;
      if (event.target instanceof Element && event.target.closest('button') !== null) return;
      editorRef.current?.focus();
    };
    container.addEventListener('pointerdown', onPointerDown, { capture: true });
    container.addEventListener('pointerup', onGridPointerUp);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      container.removeEventListener('pointerdown', onPointerDown, { capture: true });
      container.removeEventListener('pointerup', onGridPointerUp);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [container, typing]);

  // Copy, cut and paste while the grid (not an editor or a field of the page) has the focus.
  useEffect(() => {
    if (container === null) return;
    const owns = (event: ClipboardEvent) => {
      const active = document.activeElement;
      return (
        active !== null &&
        container.contains(active) &&
        !isEditableTarget(active) &&
        !isEditableTarget(event.target)
      );
    };
    const onCopyOrCut = (event: ClipboardEvent, cut: boolean) => {
      const handler = latest.current.selectionHooks?.onCopy;
      if (handler === undefined || !owns(event)) return;
      const range = primaryRange(selectionNow.current, latest.current.fields, latest.current.model);
      if (range === undefined || range.fieldIds.length === 0) return;
      // Refused or written below: the browser must not copy whatever it would.
      event.preventDefault();
      const content = handler(range, cut);
      if (content === null) return;
      if (content instanceof Promise) {
        void content.then((ready) => (ready === null ? undefined : writeClipboardLater(ready)));
        return;
      }
      event.clipboardData?.setData('text/plain', content.text);
      event.clipboardData?.setData('text/html', content.html);
    };
    const onCopy = (event: ClipboardEvent) => {
      onCopyOrCut(event, false);
    };
    const onCut = (event: ClipboardEvent) => {
      onCopyOrCut(event, true);
    };
    const onPaste = (event: ClipboardEvent) => {
      const handler = latest.current.selectionHooks?.onPaste;
      if (handler === undefined || !owns(event)) return;
      const range = primaryRange(selectionNow.current, latest.current.fields, latest.current.model);
      if (range === undefined || range.fieldIds.length === 0) return;
      event.preventDefault();
      handler(range, event.clipboardData?.getData('text/plain') ?? '');
    };
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCut);
    document.addEventListener('paste', onPaste);
    return () => {
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCut);
      document.removeEventListener('paste', onPaste);
    };
  }, [container]);

  useEffect(() => {
    editorRef.current?.scrollTo(0, 0, 'vertical');
  }, [scrollResetKey]);

  const select = useCallback(
    (col: number, row: number, scroll = true) => {
      const next: GridSelection = {
        columns: CompactSelection.empty(),
        rows: CompactSelection.empty(),
        current: {
          cell: [col, row],
          range: { x: col, y: row, width: 1, height: 1 },
          rangeStack: [],
        },
      };
      selectionNow.current = next;
      selectedRecord.current = getRecord(row)?.id;
      setSelection(next);
      if (!scroll) return;
      editorRef.current?.scrollTo(col, row);
      editorRef.current?.focus();
    },
    [getRecord],
  );

  /**
   * Opens the editor of a cell as Enter would (T418: the attachment popover
   * after files were dropped or pasted, so their progress shows). The cell
   * is selected first; once glide has the new selection the grid takes the
   * focus (with no selection yet, glide would select the first cell on
   * focus) and gets its activation key.
   */
  const pendingOpen = useRef<Item | null>(null);
  const openCell = useCallback(
    (col: number, row: number) => {
      pendingOpen.current = [col, row];
      select(col, row, false);
      editorRef.current?.scrollTo(col, row);
    },
    [select],
  );
  useEffect(() => {
    const pending = pendingOpen.current;
    const cell = selection.current?.cell;
    if (pending === null || cell?.[0] !== pending[0] || cell[1] !== pending[1]) return;
    pendingOpen.current = null;
    editorRef.current?.focus();
    window.requestAnimationFrame(() => {
      const canvas = container?.querySelector('[data-testid="data-grid-canvas"]');
      if (canvas instanceof HTMLElement && !editorOpen()) {
        canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }));
      }
    });
  }, [selection, container]);

  /** Hands files to the cell at `[col, row]` when it takes them; `true` when it did. */
  const takeFilesAt = useCallback(
    (col: number, row: number, files: readonly File[]): boolean => {
      const hooksFiles = latest.current.fileHooks;
      const field = latest.current.fields[col];
      const record = latest.current.getRecord(row);
      if (hooksFiles === undefined || field === undefined || record === undefined) return false;
      const cell = { recordId: record.id, fieldId: field.field.id };
      if (!hooksFiles.accepts(cell)) return false;
      hooksFiles.onFiles(cell, files);
      openCell(col, row);
      return true;
    },
    [openCell],
  );
  // Files pasted while the grid has the focus (a screenshot, files copied in the file
  // manager) go to the selected attachment cell (T418), before the text paste sees them.
  useEffect(() => {
    if (container === null || fileHooks === undefined) return;
    const onPasteFiles = (event: ClipboardEvent) => {
      const active = document.activeElement;
      if (active === null || !container.contains(active) || isEditableTarget(active)) return;
      const files = Array.from(event.clipboardData?.files ?? []);
      const cell = selectionNow.current.current?.cell;
      if (files.length === 0 || cell === undefined) return;
      if (!takeFilesAt(cell[0], cell[1], files)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener('paste', onPasteFiles, { capture: true });
    return () => {
      document.removeEventListener('paste', onPasteFiles, { capture: true });
    };
  }, [container, fileHooks, takeFilesAt]);

  // Leaving the grid while dragging files: no cell is outlined any more.
  useEffect(() => {
    if (container === null || fileHooks === undefined) return;
    const onLeave = (event: DragEvent) => {
      const next = event.relatedTarget;
      if (next instanceof Node && container.contains(next)) return;
      setDropTarget(null);
    };
    const onEnd = () => {
      setDropTarget(null);
    };
    container.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onEnd);
    window.addEventListener('dragend', onEnd);
    return () => {
      container.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onEnd);
      window.removeEventListener('dragend', onEnd);
    };
  }, [container, fileHooks]);

  const fileDrop =
    fileHooks === undefined
      ? undefined
      : {
          onDragOverCell: ([col, row]: Item, dataTransfer: DataTransfer | null) => {
            const field = fields[col];
            const record = getRecord(row);
            const bounds = editorRef.current?.getBounds(col, row);
            if (
              !draggingFiles(dataTransfer) ||
              dataTransfer === null ||
              field === undefined ||
              record === undefined ||
              bounds === undefined ||
              !fileHooks.accepts({ recordId: record.id, fieldId: field.field.id })
            ) {
              setDropTarget(null);
              return;
            }
            setDropTarget({ col, row, count: draggedFileCount(dataTransfer), bounds });
          },
          onDrop: ([col, row]: Item, dataTransfer: DataTransfer | null) => {
            setDropTarget(null);
            const files = Array.from(dataTransfer?.files ?? []);
            if (files.length > 0) takeFilesAt(col, row, files);
          },
        };

  // The layout changed (a group collapsed or expanded, counted again after an
  // add or a realtime move): the selected cell follows its record — or its
  // header — instead of staying on a display row that is now another row
  // (S3 QA: a record added from "+" ended up with the next group's header selected).
  const previousModel = useRef(model);
  useEffect(() => {
    const previous = previousModel.current;
    previousModel.current = model;
    if (previous === undefined || model === undefined || previous === model) return;
    const cell = selectionNow.current.current?.cell;
    if (cell === undefined) return;
    const was = previous.rowAt(cell[1]);
    let target: number | undefined;
    if (was.kind === 'group') {
      target = model.headerDisplay(was.group.key);
    } else if (was.kind === 'data') {
      const recordId = selectedRecord.current;
      const row = recordId === undefined ? undefined : rowOf?.(recordId);
      target = row === undefined ? undefined : model.displayOf(row);
    }
    if (target === undefined || target >= model.displayCount || target === cell[1]) return;
    select(cell[0], target, false);
  }, [model, rowOf, select]);

  useImperativeHandle(
    handleRef,
    () => ({
      focusCell: (row, column) => {
        if (row < rowCount) select(column, toDisplay(row));
        else pendingFocus.current = [column, row];
      },
      focus: () => {
        editorRef.current?.focus();
      },
      scrollToRow: (row) => {
        if (row < rowCount) editorRef.current?.scrollTo(0, toDisplay(row), 'vertical');
      },
      closeEditor: () => {
        if (!editorOpen()) return;
        // Glide closes its overlay on a mouse down outside it and writes the last draft.
        document.body.dispatchEvent(
          new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
        );
      },
    }),
    [rowCount, select, toDisplay],
  );

  useEffect(() => {
    const target = pendingFocus.current;
    if (target === null || target[1] >= rowCount) return;
    pendingFocus.current = null;
    select(target[0], toDisplay(target[1]));
  }, [rowCount, select, toDisplay]);

  /**
   * (T525) Why a button cell is disabled: its reason, or on a share page
   * (no `buttons` hooks) that buttons only run in the app.
   */
  const shareButtonHint = t('button.shareHint');
  const buttonTipAt = useCallback(
    (col: number, row: number): string | undefined => {
      const field = fields[col];
      const record = getRecord(row);
      if (field?.button === undefined || record === undefined) return undefined;
      if (buttonHooks === undefined) return shareButtonHint;
      const view = buttonViewOf(
        record.fields[field.field.id],
        buttonHooks.running.has(buttonKey(record.id, field.field.id)),
      );
      return view.state === 'disabled' ? buttonHooks.reasonText(view.reason) : undefined;
    },
    [fields, getRecord, buttonHooks, shareButtonHint],
  );

  /** Shows the error of a refused cell under it (hover or keyboard selection). */
  const tipFor = useCallback(
    (col: number, row: number, bounds: Rectangle | undefined, source: Tip['source']) => {
      const state = cellStateAt(col, row);
      if (bounds === undefined) return null;
      const text = buttonTipAt(col, row);
      if (text !== undefined) {
        return {
          text,
          tone: 'info',
          x: bounds.x,
          y: bounds.y + bounds.height + 4,
          source,
        } satisfies Tip;
      }
      if (state?.status !== 'error') {
        // A locked cell or a field-level error (T468) says why it shows no value.
        const computed = fields[col]?.computed;
        if (computed === undefined || (!computed.locked && computed.error === null)) return null;
        if (getRecord(row) === undefined) return null;
        const labels = ctx.labels.computed;
        const text = computed.locked ? labels?.locked : labels?.error;
        if (text === undefined) return null;
        return {
          text,
          tone: 'info',
          x: bounds.x,
          y: bounds.y + bounds.height + 4,
          source,
        } satisfies Tip;
      }
      return {
        text: state.message,
        tone: 'error',
        x: bounds.x,
        y: bounds.y + bounds.height + 4,
        source,
      } satisfies Tip;
    },
    [cellStateAt, fields, getRecord, ctx, buttonTipAt],
  );

  const onSelectionChange = hooks?.selection?.onSelectionChange;
  /**
   * Headers, "+" rows and spacers are not records (T312, T320a): a click on
   * one is no selection (it toggles the group or adds a record,
   * `onCellClicked`). The keyboard stops on a header (Enter/Space toggles
   * it, Shift+F10 opens its menu) and moves over "+" rows and spacers in
   * the same direction (or stays when there is nothing further). Only data
   * rows count as selected rows.
   */
  const skipOtherRows = (next: GridSelection): GridSelection | null => {
    if (model === undefined) return next;
    let result = next;
    const cell = next.current?.cell;
    if (cell !== undefined && isOtherRow(cell[1])) {
      if (pointerDown.current) return null;
      const previous = selectionNow.current.current?.cell[1];
      const step = previous === undefined || cell[1] > previous ? 1 : -1;
      let display = cell[1];
      while (display >= 0 && display < model.displayCount) {
        const kind = model.rowAt(display).kind;
        if (kind === 'data' || kind === 'group') break;
        display += step;
      }
      if (display < 0 || display >= model.displayCount) return null;
      if (display !== cell[1]) {
        result = {
          ...next,
          current: {
            cell: [cell[0], display],
            range: { x: cell[0], y: display, width: 1, height: 1 },
            rangeStack: [],
          },
        };
        editorRef.current?.scrollTo(cell[0], display);
      }
    }
    const rows = result.rows.toArray();
    if (rows.some((row) => isOtherRow(row))) {
      result = {
        ...result,
        rows: rows
          .filter((row) => !isOtherRow(row))
          .reduce((selected, row) => selected.add(row), CompactSelection.empty()),
      };
    }
    return result;
  };

  const onGridSelectionChange = (incoming: GridSelection) => {
    const next = skipOtherRows(incoming);
    if (next === null) return;
    // Keys pressed right after a click must see the new cell before React renders.
    selectionNow.current = next;
    const cell = next.current?.cell;
    selectedRecord.current = cell === undefined ? undefined : getRecord(cell[1])?.id;
    if (cell === undefined || typing.inputFor(cell[0], cell[1]) === undefined) typing.cancel();
    setSelection(next);
    onSelectionChange?.(selectionRanges(next, fields, model));
    setTip(
      cell === undefined
        ? null
        : tipFor(cell[0], cell[1], editorRef.current?.getBounds(cell[0], cell[1]), 'selection'),
    );
  };

  const showExpand = (args: GridMouseEventArgs) => {
    // The tree's row tools (T417) follow the hovered row too.
    if (onOpenRecord === undefined && tree === undefined) return;
    clearTimeout(expandHide.current);
    const row = args.kind === 'cell' ? args.location[1] : -1;
    const record = row >= 0 ? getRecord(row) : undefined;
    const bounds = record === undefined ? undefined : editorRef.current?.getBounds(0, row);
    if (record === undefined || bounds === undefined) {
      // Leaving the rows: a moment to reach the button.
      expandHide.current = setTimeout(() => {
        setExpand(null);
      }, EXPAND_HIDE_MS);
      return;
    }
    const x = bounds.x + bounds.width - EXPAND_SIZE - 4;
    const y = bounds.y + (bounds.height - EXPAND_SIZE) / 2;
    setExpand((current) =>
      current?.recordId === record.id && current.x === x && current.y === y
        ? current
        : { recordId: record.id, x, y, row, cell: bounds },
    );
  };

  useEffect(
    () => () => {
      clearTimeout(expandHide.current);
      clearTimeout(linkPlusHide.current);
    },
    [],
  );

  /**
   * Link cells (T413): the "+" at the end of a hovered cell the user may
   * edit, and the chip under the pointer (for the hover card of the page;
   * locked chips have nothing to show).
   */
  const showLinkTargets = (args: GridMouseEventArgs) => {
    if (linkHooks === undefined) return;
    let plus: LinkPlusTarget | null = null;
    let hover: LinkChipHover | null = null;
    if (args.kind === 'cell') {
      const [col, row] = args.location;
      const field = fields[col];
      const record = getRecord(row);
      if (field !== undefined && record !== undefined && editsWithPicker(field)) {
        if (canEditCell(field, record, edit)) {
          plus = {
            col,
            row,
            x: args.bounds.x + args.bounds.width - LINK_PLUS_SIZE - 6,
            y: args.bounds.y + (args.bounds.height - LINK_PLUS_SIZE) / 2,
          };
        }
        const cell = getCellContent([col, row]);
        if (isLinksCell(cell)) {
          const index = linkChipAt(cell.data, args.localEventX);
          const chip = index === null || index < 0 ? undefined : cell.data.chips[index];
          const hit = cell.data.hits.find((item) => item.index === index);
          if (chip !== undefined && chip.title !== null && hit !== undefined) {
            hover = {
              cell: { recordId: record.id, fieldId: field.field.id },
              recordId: chip.id,
              anchor: {
                x: args.bounds.x + hit.start,
                y: args.bounds.y,
                width: hit.end - hit.start,
                height: args.bounds.height,
              },
              pinned: false,
            };
          }
        }
      }
    }
    clearTimeout(linkPlusHide.current);
    if (plus === null) {
      // Leaving the cell: a moment to reach the button.
      linkPlusHide.current = setTimeout(() => {
        setLinkPlus(null);
      }, EXPAND_HIDE_MS);
    } else {
      const next = plus;
      setLinkPlus((current) =>
        current?.col === next.col &&
        current.row === next.row &&
        current.x === next.x &&
        current.y === next.y
          ? current
          : next,
      );
    }
    const key =
      hover === null ? null : `${hover.cell.recordId}|${hover.cell.fieldId}|${hover.recordId}`;
    if (key !== hoveredChip.current) {
      hoveredChip.current = key;
      linkHooks.onChipHover?.(hover);
    }
  };

  /** Opens the link picker of a link cell the user may edit (T413); `true` when it did. */
  const openLinkPicker = (col: number, row: number, search?: string): boolean => {
    const field = fields[col];
    const record = getRecord(row);
    if (field === undefined || record === undefined || !editsWithPicker(field)) return false;
    if (linkHooks === undefined || !canEditCell(field, record, edit)) return false;
    const bounds = editorRef.current?.getBounds(col, row);
    if (bounds === undefined) return false;
    setLinkPlus(null);
    linkHooks.onOpenPicker({
      cell: { recordId: record.id, fieldId: field.field.id },
      record,
      anchor: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      ...(search === undefined ? {} : { search }),
    });
    return true;
  };

  const onItemHovered = (args: GridMouseEventArgs) => {
    showExpand(args);
    showLinkTargets(args);
    if (args.kind === 'cell') {
      const next = tipFor(args.location[0], args.location[1], args.bounds, 'hover');
      if (next !== null) {
        setTip(next);
        return;
      }
      // A header shows its field and value (the chip alone does not name the field, T320a).
      const group = groupAt(args.location[1]);
      if (group !== undefined) {
        const text = groupLabel(group).label;
        const x = args.bounds.x + args.localEventX;
        const y = args.bounds.y + args.bounds.height + 4;
        setTip((current) =>
          current?.text === text && current.y === y
            ? current
            : { text, tone: 'info', x, y, source: 'hover' },
        );
        return;
      }
    }
    // (T554) A header with a note (date reminder) shows it below the header.
    if (args.kind === 'header') {
      const hint = headerHints?.get(fields[args.location[0]]?.field.id ?? '');
      if (hint !== undefined) {
        const x = args.bounds.x + 8;
        const y = args.bounds.y + args.bounds.height + 4;
        const tone = hint.warning ? 'error' : 'info';
        setTip((current) =>
          current?.text === hint.text && current.y === y && current.x === x
            ? current
            : { text: hint.text, tone, x, y, source: 'hover' },
        );
        return;
      }
    }
    if (tip?.source === 'hover') setTip(null);
  };

  const readOnlyHint = edit === undefined ? hooks?.readOnlyHint : edit.readOnlyHint;
  /** Whether a cell refuses editing; then its hint says why (Enter, F2, typing; FRONTEND §4.1). */
  const explainReadOnly = (col: number, row: number): boolean => {
    const record = getRecord(row);
    const field = fields[col];
    if (record === undefined || field === undefined) return false;
    if (canEditCell(field, record, edit)) return false;
    const bounds = editorRef.current?.getBounds(col, row);
    // A link cell says why (its linked table is not readable, T413).
    const hint =
      edit?.fieldReadOnlyHint?.(field.field.id) ??
      (field.link === undefined ? undefined : linkHooks?.readOnlyHint?.(field.field.id)) ??
      readOnlyHint;
    if (hint !== undefined && bounds !== undefined) {
      setTip({
        text: hint,
        tone: 'info',
        x: bounds.x,
        y: bounds.y + bounds.height + 4,
        source: 'activation',
      });
    }
    return true;
  };

  /** Opens the file viewer of a read-only attachment cell with files (T419); `true` when it did. */
  const viewFiles = (col: number, row: number): boolean => {
    const viewer = hooks?.fileViewer;
    const field = fields[col];
    const record = getRecord(row);
    if (viewer === undefined || field === undefined || record === undefined) return false;
    if (field.config?.type !== 'attachment' || canEditCell(field, record, edit)) return false;
    const value = record.fields[field.field.id];
    if (!Array.isArray(value) || value.length === 0) return false;
    viewer.onViewFiles({ recordId: record.id, fieldId: field.field.id }, record);
    return true;
  };

  /**
   * (T525) Presses the button of a cell: runs it when ready, else shows
   * why not under the cell. `false` when the cell is no button.
   */
  const pressButtonAt = (col: number, row: number): boolean => {
    const field = fields[col];
    const record = getRecord(row);
    if (field?.button === undefined || record === undefined) return false;
    const cell = { recordId: record.id, fieldId: field.field.id };
    const view = buttonViewOf(
      record.fields[field.field.id],
      buttonHooks?.running.has(buttonKey(record.id, field.field.id)) === true,
    );
    if (view.state === 'ready' && buttonHooks !== undefined) {
      setTip(null);
      buttonHooks.onPress(cell, record);
      return true;
    }
    const text = buttonTipAt(col, row);
    const bounds = editorRef.current?.getBounds(col, row);
    if (text !== undefined && bounds !== undefined) {
      setTip({
        text,
        tone: 'info',
        x: bounds.x,
        y: bounds.y + bounds.height + 4,
        source: 'activation',
      });
    }
    return true;
  };

  /** Whether a pointer event at (`x`, `y`) inside a cell of `bounds` hits its button. */
  const hitsButton = (field: GridField, bounds: Rectangle, x: number, y: number): boolean => {
    if (field.button === undefined) return false;
    const padding = appearance.theme.cellHorizontalPadding ?? 8;
    const family = appearance.theme.fontFamily ?? 'sans-serif';
    const pill = buttonPillRect(
      { x: 0, y: 0, width: bounds.width, height: bounds.height },
      measureButtonText(field.button.label, family),
      padding,
    );
    return x >= pill.x && x <= pill.x + pill.width && y >= pill.y && y <= pill.y + pill.height;
  };

  const onCellActivated = ([col, row]: Item) => {
    activations.current += 1;
    // A button cell (T525): clicks and Enter/Space press it, a double click does nothing more.
    if (fields[col]?.button !== undefined) return;
    // Enter, F2, a double click (or a click on the selected cell) on a link cell: its picker.
    if (openLinkPicker(col, row)) return;
    // The same on the files of a read-only attachment cell: the viewer (T419).
    if (viewFiles(col, row)) return;
    if (explainReadOnly(col, row)) return;
    // Type to edit starts its session (with the key) once its F2 is through.
    if (!opening.current) keepKeysForEditor(col, row);
  };

  /**
   * A double click, Enter or F2 opens the editor of a cell: the keys typed
   * until it has the focus are kept for it (T803, `TypeToEdit`).
   */
  const keepKeysForEditor = (col: number, row: number) => {
    const field = fields[col];
    const record = getRecord(row);
    if (field === undefined || record === undefined || container === null) return;
    if (editsInPlace(field) || editsWithPicker(field) || !editorTakesTyping(field)) return;
    if (!canEditCell(field, record, edit)) return;
    const bounds = editorRef.current?.getBounds(col, row);
    if (bounds === undefined) return;
    typing.start({
      host: container,
      col,
      row,
      first: '',
      place: { x: bounds.x, y: bounds.y, height: bounds.height },
      label: field.field.name,
      onAbandon: () => {
        editorRef.current?.focus();
      },
    });
  };

  /**
   * Screen x of a header's content origin (the first frozen column): the
   * tail of an overflowing header scrolls with the columns it spans.
   */
  const headerOrigin = (col: number, row: number): number | undefined => {
    if (col < headerSpan) return editorRef.current?.getBounds(0, row)?.x;
    const tail = editorRef.current?.getBounds(headerSpan, row);
    return tail === undefined ? undefined : tail.x - headWidth;
  };

  /** Where the "N records ▾" of a header is on screen, if the click hit it. */
  const menuAnchorAt = (
    group: GridGroupRow,
    frame: GridRowFrame,
    col: number,
    row: number,
    event: CellClickedEventArgs,
  ): Rectangle | undefined => {
    const menu = headerCells(group, frame).head.data.hits.menu;
    const origin = col < 0 ? undefined : headerOrigin(col, row);
    if (menu === null || origin === undefined) return undefined;
    const x = event.bounds.x + event.localEventX - origin;
    if (x < menu[0] || x > menu[1]) return undefined;
    return {
      x: origin + menu[0],
      y: event.bounds.y,
      width: menu[1] - menu[0],
      height: event.bounds.height,
    };
  };

  const onCellClicked = ([col, row]: Item, event: CellClickedEventArgs) => {
    if (tip?.source === 'activation') setTip(null);
    const clickedField = fields[col];
    if (
      clickedField?.button !== undefined &&
      hitsButton(clickedField, event.bounds, event.localEventX, event.localEventY)
    ) {
      // The button itself (T525): pressed (or why not); the cell is selected as usual.
      pressButtonAt(col, row);
      return;
    }
    if (tree !== undefined && col === 0) {
      // The branch caret (T417): toggles, never starts editing.
      const node = tree.nodeAt(row);
      if (
        node?.recordId !== undefined &&
        node.childCount > 0 &&
        hitsCaret(event.localEventX, node.depth)
      ) {
        event.preventDefault();
        tree.hooks.onToggle(node.recordId, row);
        return;
      }
    }
    if (model === undefined || groups === undefined) return;
    const kind = model.rowAt(row);
    if (kind.kind === 'add') {
      event.preventDefault();
      groups.onAdd?.(kind.group.key);
      return;
    }
    if (kind.kind !== 'group') return;
    event.preventDefault();
    const anchor =
      groups.onMenu === undefined
        ? undefined
        : menuAnchorAt(kind.group, kind.frame, col, row, event);
    if (anchor !== undefined) {
      groups.onMenu?.(kind.group.key, anchor);
      return;
    }
    groups.onToggle(kind.group.key);
  };

  const onGroupMenu = groups?.onMenu;
  const onRowMenu = tree?.hooks.onRowMenu;
  const onCellContextMenu =
    onCellMenu !== undefined || onGroupMenu !== undefined || onRowMenu !== undefined
      ? ([col, row]: Item, event: CellClickedEventArgs) => {
          const kind = model?.rowAt(row);
          if (kind !== undefined && kind.kind !== 'data') {
            // A header's menu (T320a); nothing on "+" rows and spacers.
            event.preventDefault();
            if (kind.kind === 'group') {
              onGroupMenu?.(kind.group.key, {
                x: event.bounds.x + event.localEventX,
                y: event.bounds.y,
                width: 1,
                height: event.bounds.height,
              });
            }
            return;
          }
          const field = fields[col];
          const record = getRecord(row);
          if (field === undefined || record === undefined) return;
          const cellAddress = { recordId: record.id, fieldId: field.field.id };
          if (onRowMenu !== undefined) {
            // A tree (T417): the row menu, which holds the cell menu's items too.
            event.preventDefault();
            onRowMenu(cellAddress, row, event.bounds);
            return;
          }
          if (onCellMenu === undefined) return;
          event.preventDefault();
          onCellMenu(cellAddress, event.bounds);
        }
      : undefined;

  /** Enter/Space toggle a header row, Shift+F10 or the menu key open its menu (T320a). */
  const handleHeaderKey = (event: GridKeyEventArgs, opensMenu: boolean): boolean => {
    const cell = selectionNow.current.current?.cell;
    const group = cell === undefined ? undefined : groupAt(cell[1]);
    if (group === undefined || groups === undefined) return false;
    const toggles =
      (event.key === 'Enter' || event.key === ' ') && !event.ctrlKey && !event.metaKey;
    if (!opensMenu && !toggles) return false;
    event.cancel();
    event.preventDefault();
    event.stopPropagation();
    if (toggles) {
      groups.onToggle(group.key);
    } else {
      const bounds = cell === undefined ? undefined : editorRef.current?.getBounds(0, cell[1]);
      groups.onMenu?.(group.key, bounds ?? event.bounds ?? { x: 0, y: 0, width: 0, height: 0 });
    }
    return true;
  };

  useEffect(() => {
    if (tip?.source !== 'activation') return;
    const timer = window.setTimeout(() => {
      setTip(null);
    }, 4000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [tip]);

  const onHeaderMenuClick = hooks?.headerMenu
    ? (col: number, bounds: Rectangle) => {
        const field = fields[col];
        if (field !== undefined) hooks.headerMenu?.onHeaderMenu(field.field.id, bounds);
      }
    : undefined;
  const onHeaderContextMenu = hooks?.headerMenu
    ? (col: number, event: HeaderClickedEventArgs) => {
        const field = fields[col];
        if (field === undefined) return;
        event.preventDefault();
        hooks.headerMenu?.onHeaderMenu(field.field.id, event.bounds);
      }
    : undefined;
  const headerMenu = hooks?.headerMenu;
  const onHeaderBadge = hooks?.headerMenu?.onHeaderBadge;
  // A click on the error badge of a computed header opens its popover (T468).
  const onHeaderClicked =
    onHeaderBadge === undefined || !hasBadges
      ? undefined
      : (col: number, event: HeaderClickedEventArgs) => {
          const field = fields[col];
          const badge = field === undefined ? undefined : headerBadges.get(field.field.id);
          if (field === undefined || badge?.kind !== 'error') return;
          const { bounds } = event;
          if (!hitsHeaderBadge(bounds, badge, event.localEventX, event.localEventY)) return;
          event.preventDefault();
          onHeaderBadge(field.field.id, bounds);
        };
  const recordDetail = hooks?.recordDetail;
  /** (T525) Enter or Space on a button cell presses it (board "S5 · Button field"). */
  const handleButtonKey = (event: GridKeyEventArgs): boolean => {
    if (event.key !== 'Enter' && event.key !== ' ') return false;
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false;
    const cell = selectionNow.current.current?.cell;
    if (cell === undefined || fields[cell[0]]?.button === undefined) return false;
    if (getRecord(cell[1]) === undefined) return false;
    event.cancel();
    event.preventDefault();
    event.stopPropagation();
    pressButtonAt(cell[0], cell[1]);
    return true;
  };
  /** Keys of FRONTEND §6.2 that act on the selection; `true` when the key was used. */
  const handleSelectionKey = (event: GridKeyEventArgs): boolean => {
    const primary = event.ctrlKey || event.metaKey;
    const consume = () => {
      event.cancel();
      event.preventDefault();
      event.stopPropagation();
    };
    // Space opens the record panel when there is one (T206); else it opens the editor.
    if (event.key === ' ' && !primary && !event.shiftKey && recordDetail !== undefined) {
      const row = selectionNow.current.current?.cell[1];
      const record = row === undefined ? undefined : getRecord(row);
      if (record === undefined) return false;
      consume();
      recordDetail.onOpenRecord(record.id);
      return true;
    }
    const rows = hooks?.rows;
    if (event.key === 'Enter' && event.shiftKey && !primary && rows !== undefined) {
      // Shift+Enter: a new record from the selected row (FRONTEND §6.2, T311).
      const cell = selectionNow.current.current?.cell;
      if (cell === undefined) return false;
      consume();
      const row = dataOf(cell[1]);
      if (row !== undefined) rows.onAddRow(row, cell[0]);
      return true;
    }
    if (selectionHooks === undefined) return false;
    if (
      (event.key === 'Delete' || event.key === 'Backspace') &&
      !primary &&
      selectionHooks.onClear !== undefined
    ) {
      const ranges = selectionRanges(selectionNow.current, fields, model);
      if (ranges.length === 0) return false;
      consume();
      selectionHooks.onClear(ranges);
      return true;
    }
    if (primary && !event.shiftKey && event.key.toLowerCase() === 'd') {
      // Also keeps the browser from bookmarking the page.
      consume();
      const range = primaryRange(selectionNow.current, fields, model);
      const fill = range === undefined ? undefined : fillDownRanges(range);
      if (fill !== undefined) selectionHooks.onFill?.(fill.source, fill.destination);
      return true;
    }
    return false;
  };
  /**
   * Keys of a tree (T417, `tree/keys.ts`): Ctrl/⌘+] / [ and Alt+Shift+→ / ←
   * indent and outdent, → / ← on the first column open and close a branch
   * (← on a leaf goes to its parent). Only here — the grid has the focus and
   * no editor is open — is the browser's ⌘+[ / ⌘+] (Back / Forward) taken.
   */
  const handleTreeKey = (event: GridKeyEventArgs): boolean => {
    const cell = selectionNow.current.current?.cell;
    if (tree === undefined || cell === undefined) return false;
    const node = tree.nodeAt(cell[1]);
    if (node?.recordId === undefined) return false;
    const action = treeKeyAction(
      {
        key: event.key,
        code: event.rawEvent?.code,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
      },
      {
        gridFocused: true,
        editing: editorOpen() || typing.isPending(),
        column: cell[0],
        hasChildren: node.childCount > 0,
        expanded: node.expanded,
        hasParent: node.depth > 0,
      },
    );
    if (action === null) return false;
    event.cancel();
    event.preventDefault();
    event.stopPropagation();
    switch (action) {
      case 'expand':
      case 'collapse':
        tree.hooks.onToggle(node.recordId, cell[1]);
        break;
      case 'parent': {
        let above = cell[1] - 1;
        while (above >= 0 && (tree.nodeAt(above)?.depth ?? 0) >= node.depth) above -= 1;
        if (above >= 0) select(cell[0], above);
        break;
      }
      case 'indent':
        tree.hooks.moves?.onIndent(cell[1]);
        break;
      case 'outdent':
        tree.hooks.moves?.onOutdent(cell[1]);
        break;
    }
    return true;
  };
  const onFill = selectionHooks?.onFill;
  const fillHandle =
    onFill !== undefined && edit !== undefined
      ? {
          fillHandle: true,
          allowedFillDirections: 'vertical' as const,
          onFillPattern: (event: FillPatternEventArgs) => {
            // The page writes the values (one bulk request), not glide cell by cell.
            event.preventDefault();
            const source = rectangleRange(event.patternSource, fields, model);
            const destination = rectangleRange(event.fillDestination, fields, model);
            if (source !== undefined && destination !== undefined) onFill(source, destination);
          },
        }
      : undefined;
  const onKeyDown = (event: GridKeyEventArgs) => {
    if (opening.current) return;
    if (typing.isPending()) {
      // The editor is on its way (its text area has the focus): no grid shortcut
      // (Space → record panel…) may run; a character that still got here is kept.
      event.cancel();
      event.preventDefault();
      event.stopPropagation();
      if (/^.$/su.test(event.key) && !event.ctrlKey && !event.metaKey) typing.append(event.key);
      return;
    }
    if (typing.hasEditor()) {
      // An editor is open: its keys never start typing over the cell again.
      // (The focus goes back to it as soon as the grid takes it.)
      event.cancel();
      typing.focusEditor();
      return;
    }
    // Keyboard access to the header menu (FRONTEND §9.2): Shift+F10 or the menu key on a cell.
    const opensMenu = (event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu';
    if (handleHeaderKey(event, opensMenu)) return;
    const selected = selectionNow.current.current?.cell;
    const column =
      selected?.[0] ??
      (event.location === undefined ? undefined : event.location[0] - ROW_MARKER_COLUMNS);
    if (headerMenu !== undefined && opensMenu && column !== undefined) {
      const field = fields[column];
      if (field === undefined) return;
      event.cancel();
      event.preventDefault();
      headerMenu.onHeaderMenu(field.field.id, event.bounds ?? { x: 0, y: 0, width: 0, height: 0 });
      return;
    }
    if (handleTreeKey(event)) return;
    if (handleButtonKey(event)) return;
    if (handleSelectionKey(event)) return;
    const cell = selected;
    if (cell === undefined || !isTypedCharacter(event)) return;
    const typedField = fields[cell[0]];
    if (typedField !== undefined && editsWithPicker(typedField)) {
      // Typing on a link cell searches its picker (T413).
      event.cancel();
      if (explainReadOnly(cell[0], cell[1])) return;
      event.preventDefault();
      event.stopPropagation();
      openLinkPicker(cell[0], cell[1], event.key);
      return;
    }
    typeToEdit(event, cell);
  };

  /**
   * Type to edit, done here rather than by glide: glide 6.0.3 drops the key
   * when it is not printable ASCII ("đ") and whenever the grid is scrolled
   * sideways past a column while the cell is in a frozen column (its
   * visible-region check compares the frozen column with the scrolled
   * region), so the first letter typed on the primary field was lost.
   * Glide opens the editor through its own activation key (F2); the
   * characters typed until the editor has the focus go to `typing`.
   */
  const typeToEdit = (event: GridKeyEventArgs, [col, row]: Item) => {
    const field = fields[col];
    const record = getRecord(row);
    if (field === undefined || record === undefined) return;
    // Typing a letter on a check box would toggle it: only Space, Enter and clicks do.
    if (editsInPlace(field) || explainReadOnly(col, row)) {
      event.cancel();
      return;
    }
    const canvas = container?.querySelector('[data-testid="data-grid-canvas"]');
    const bounds = event.bounds;
    if (
      !(canvas instanceof HTMLElement) ||
      bounds === undefined ||
      !isCellOnScreen(bounds, canvas.getBoundingClientRect())
    ) {
      return;
    }
    event.cancel();
    event.preventDefault();
    event.stopPropagation();
    opening.current = true;
    const before = activations.current;
    try {
      canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }));
    } finally {
      opening.current = false;
    }
    if (activations.current === before || container === null) return;
    typing.start({
      host: container,
      col,
      row,
      first: event.key,
      place: { x: bounds.x, y: bounds.y, height: bounds.height },
      label: field.field.name,
      onAbandon: () => {
        editorRef.current?.focus();
      },
    });
  };
  const resize = hooks?.columns?.onColumnResize;
  const columnResize = resize
    ? {
        onColumnResize: (column: GridColumn, width: number) => {
          if (column.id !== undefined) resize(column.id, width, false);
        },
        onColumnResizeEnd: (column: GridColumn, width: number) => {
          if (column.id !== undefined) resize(column.id, width, true);
        },
      }
    : undefined;
  const move = hooks?.columns?.onColumnMove;
  // Frozen columns (the primary field first) stay where they are.
  const frozen = Math.min(freezeColumns, fields.length);
  const columnMove = move
    ? {
        onColumnMoved: (from: number, to: number) => {
          const field = fields[from];
          const target = fields[to];
          if (field !== undefined && target !== undefined && from !== to) {
            move(field.field.id, target.field.id);
          }
        },
        // Glide passes indexes that count the row-marker column here.
        onColumnProposeMove: (from: number, to: number) =>
          from - ROW_MARKER_COLUMNS >= frozen && to - ROW_MARKER_COLUMNS >= frozen,
      }
    : undefined;

  // Grouped (T320a): the gutter holds the nested cards' bands and the row number.
  const rowMarkerWidth =
    model === undefined ? numberWidth(rowCount) : gutterWidth(model.depth, numberWidth(rowCount));

  const scrollGrid = (event: React.WheelEvent) => {
    container?.querySelector('.dvn-scroller')?.scrollBy({ left: event.deltaX, top: event.deltaY });
  };
  // The tree's row tools (T417): hovered row, geometry, and keeping the hover while on them.
  const treeHover = useMemo<TreeHover | null>(
    () =>
      expand === null ? null : { recordId: expand.recordId, row: expand.row, cell: expand.cell },
    [expand],
  );
  const getCellBounds = useCallback(
    (col: number, row: number) => editorRef.current?.getBounds(col, row),
    [],
  );
  const firstVisibleRow = useCallback(() => region.current?.y ?? 0, []);
  const scrollerElement = useCallback(
    () => container?.querySelector<HTMLElement>('.dvn-scroller') ?? null,
    [container],
  );
  // The summary bar (T472) follows the columns.
  const layoutListener = useRef(onColumnLayout);
  useEffect(() => {
    layoutListener.current = onColumnLayout;
  });
  const layoutKey = `${String(rowMarkerWidth)}|${String(frozen)}|${columns
    .map((column, index) => `${fields[index]?.field.id ?? ''}:${String(column.width)}`)
    .join(',')}`;
  useEffect(() => {
    layoutListener.current?.({
      gutter: rowMarkerWidth,
      columns: columns.map((column, index) => ({
        fieldId: fields[index]?.field.id ?? String(column.id),
        width: column.width,
      })),
      frozen,
      scroller: scrollerElement,
    });
    // `layoutKey` stands for the gutter, the frozen count and the columns.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey, scrollerElement]);
  const keepExpand = useCallback(() => {
    clearTimeout(expandHide.current);
  }, []);
  const hideExpand = useCallback(() => {
    setExpand(null);
  }, []);

  return (
    <section ref={setContainer} aria-label={label} className="ob-grid relative min-h-0 flex-1">
      <DataEditorCore
        ref={editorRef}
        columns={columns}
        rows={displayCount}
        getCellContent={getCellContent}
        customRenderers={CUSTOM_RENDERERS}
        renderers={renderers}
        headerIcons={ALL_SPRITES}
        imageWindowLoader={imageWindowLoader}
        theme={theme}
        rowHeight={rowHeight}
        headerHeight={HEADER_HEIGHT}
        // Grouped rows (T320a): the gutter numbers rows within their group and
        // shows the check box on hover (whole-row selection).
        rowMarkers={{ kind: model === undefined ? 'number' : 'both', width: rowMarkerWidth }}
        verticalBorder={!grouped}
        {...(grouped || hasBadges ? { drawHeader } : {})}
        {...(onHeaderClicked === undefined ? {} : { onHeaderClicked })}
        spanRangeBehavior="allowPartial"
        freezeColumns={frozen}
        smoothScrollX
        smoothScrollY
        width="100%"
        height="100%"
        keybindings={KEYBINDINGS}
        onPaste={false}
        onVisibleRegionChanged={onVisibleRegionChanged}
        gridSelection={selection}
        onGridSelectionChange={onGridSelectionChange}
        onCellActivated={onCellActivated}
        onItemHovered={onItemHovered}
        onCellClicked={onCellClicked}
        onKeyDown={onKeyDown}
        {...(edit === undefined
          ? { editOnType: false }
          : { provideEditor, onCellEdited, onFinishedEditing, editOnType: true })}
        {...(grouped || hasCellStates || tree !== undefined || colors !== undefined
          ? { drawCell }
          : {})}
        {...(onHeaderMenuClick === undefined ? {} : { onHeaderMenuClick })}
        {...(onHeaderContextMenu === undefined ? {} : { onHeaderContextMenu })}
        {...(onCellContextMenu === undefined ? {} : { onCellContextMenu })}
        {...columnResize}
        {...columnMove}
        {...fillHandle}
        {...fileDrop}
        {...(onAddField === undefined
          ? {}
          : {
              rightElement: (
                <div className="flex h-full w-11 flex-col">
                  <Tooltip content={t('addField')}>
                    <button
                      type="button"
                      data-testid="grid-add-field"
                      aria-label={t('addField')}
                      // As high as the header (HEADER_HEIGHT, 36 px) and drawn like it.
                      className="flex h-9 shrink-0 items-center justify-center border-r border-b border-line bg-surface-sunken text-fg-muted hover:text-accent"
                      onClick={onAddField}
                    >
                      <Plus aria-hidden="true" className="size-4" />
                    </button>
                  </Tooltip>
                </div>
              ),
            })}
      />
      {groups === undefined ? null : (
        <GroupStickyPath
          groups={stickyGroups}
          top={HEADER_HEIGHT + 1}
          rowHeight={baseHeight}
          gutter={rowMarkerWidth}
          headWidth={headWidth}
          describe={groupLabel}
          onToggle={groups.onToggle}
          onWheel={scrollGrid}
        />
      )}
      {tree === undefined ? null : (
        <>
          <TreeStickyPath
            crumbs={crumbs}
            top={HEADER_HEIGHT + 1}
            gutter={rowMarkerWidth}
            maxLevels={TREE_LEVELS}
            onReveal={tree.hooks.onReveal}
            onWheel={scrollGrid}
          />
          <TreeRowTools
            tree={tree}
            hover={treeHover}
            expandLeft={
              expand === null
                ? null
                : onOpenRecord === undefined
                  ? expand.x + EXPAND_SIZE
                  : expand.x
            }
            gutter={rowMarkerWidth}
            rowCount={displayCount}
            getBounds={getCellBounds}
            firstVisibleRow={firstVisibleRow}
            scroller={scrollerElement}
            onKeep={keepExpand}
            onLeave={hideExpand}
          />
        </>
      )}
      {expand === null || onOpenRecord === undefined ? null : (
        // A pointer shortcut; keyboard users open the record with Space (T205).
        <Tooltip content={t('expandRecord')}>
          <button
            type="button"
            tabIndex={-1}
            aria-label={t('expandRecord')}
            className="fixed z-20 flex items-center justify-center rounded-sm border border-line bg-surface text-fg-muted shadow-popover hover:text-fg"
            style={{ left: expand.x, top: expand.y, width: EXPAND_SIZE, height: EXPAND_SIZE }}
            onPointerEnter={() => {
              clearTimeout(expandHide.current);
            }}
            onPointerLeave={() => {
              setExpand(null);
            }}
            // The grid keeps the focus: the record panel gives it back to the grid,
            // not to this pointer shortcut (Enter would reopen the record, T421a).
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            onClick={() => {
              onOpenRecord(expand.recordId);
            }}
          >
            <Maximize2 aria-hidden="true" className="size-3.5" />
          </button>
        </Tooltip>
      )}
      {linkPlus === null || linkHooks === undefined ? null : (
        // A pointer shortcut (board "Ô liên kết trong grid"); keyboard users press Enter.
        <Tooltip content={t('link.add')}>
          <button
            type="button"
            tabIndex={-1}
            aria-label={t('link.add')}
            data-testid="link-cell-add"
            className="fixed z-20 flex items-center justify-center rounded-md border border-line-strong bg-surface text-fg-muted hover:text-fg"
            style={{
              left: linkPlus.x,
              top: linkPlus.y,
              width: LINK_PLUS_SIZE,
              height: LINK_PLUS_SIZE,
            }}
            onPointerEnter={() => {
              clearTimeout(linkPlusHide.current);
            }}
            onPointerLeave={() => {
              setLinkPlus(null);
            }}
            onClick={() => {
              select(linkPlus.col, linkPlus.row, false);
              openLinkPicker(linkPlus.col, linkPlus.row);
            }}
          >
            <Plus aria-hidden="true" className="size-3.5" />
          </button>
        </Tooltip>
      )}
      {dropTarget === null ? null : (
        // Board S4: a dashed accent outline over the cell, "Drop to upload N files".
        <div
          aria-hidden="true"
          data-testid="grid-drop-target"
          className="pointer-events-none fixed z-20 flex items-center justify-center gap-1.5 border-2 border-dashed border-accent bg-accent-soft text-label text-accent"
          style={{
            left: dropTarget.bounds.x,
            top: dropTarget.bounds.y,
            width: dropTarget.bounds.width,
            height: dropTarget.bounds.height,
          }}
        >
          <Upload aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="truncate">
            {t('files.dropHere', { count: Math.max(1, dropTarget.count) })}
          </span>
        </div>
      )}
      <div
        role="status"
        className={cn(
          tip === null
            ? 'sr-only'
            : 'pointer-events-none fixed z-40 max-w-xs rounded-md border bg-surface px-2 py-1 text-label font-normal shadow-popover',
          tip?.tone === 'error' ? 'border-danger text-danger' : 'border-line text-fg',
        )}
        style={tip === null ? undefined : { left: tip.x, top: tip.y }}
      >
        {tip?.text ?? ''}
      </div>
    </section>
  );
}
