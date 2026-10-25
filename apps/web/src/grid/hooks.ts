import type { ClipboardContent } from './clipboard';
import type { EditorContext, EditorIssue } from './editors/types';
import type { GridGroupRow } from './rows';
import type { GridRecord } from './types';
import type { EditCommand } from '../lib/records/commands';
import type { ButtonDisabledReason } from '@cellhive/contracts';

/**
 * Extension points of `GridView` for the tasks after T202. Each handler is
 * optional; when it is absent the grid behaves read-only for that
 * interaction. The shapes are fixed now so later tasks plug in without
 * reshaping the adapter.
 */

/** A cell addressed by record and field (never by row index: rows move). */
export interface CellAddress {
  readonly recordId: string;
  readonly fieldId: string;
}

/** How a committed value is written besides the value itself. */
export interface CommitOptions {
  /** Read shape shown in the cell until the server answers (default: the value). */
  readonly display?: unknown;
  /** The server has to read the value (new select option, CONTRACTS §2). */
  readonly typecast?: boolean;
  /**
   * `version` of the record when the editor opened. Realtime (T204) may
   * bring a newer version while the editor is open: the write is then
   * checked against what the user saw, so a concurrent change is a
   * conflict instead of being overwritten silently.
   */
  readonly baseVersion?: number;
}

/**
 * What the canvas draws over a cell besides its value (FRONTEND §4.1).
 * Shared contract of the edit flow: the state lives in
 * `lib/records/edit-state.ts` (`EditState.cells`, keyed by `cellKey(recordId,
 * fieldId)`) and is owned by `RecordEditController`; `pending` means a write
 * of the user is in flight and the cell shows its optimistic value. Readers
 * such as the realtime client (T204) ask `RecordEditController.isPending` and
 * skip those cells (FRONTEND §5); only the controller changes the state.
 */
export type CellEditState =
  | { readonly status: 'pending' }
  /** `message` is translated: the tooltip of the red cell. */
  | { readonly status: 'error'; readonly message: string };

/** T203 — cell editing (FRONTEND §4.1). */
export interface CellEditHooks {
  /**
   * Whether the cell may open an editor: type (system, auto number and S4
   * types never), field permission, schema lock, offline. Editors of the
   * `grid/editors/` registry validate with `field-types` before committing.
   */
  readonly canEdit: (cell: CellAddress, record: GridRecord) => boolean;
  /**
   * The user committed a valid value (json write shape, CONTRACTS §2). The
   * handler writes optimistically into the block cache and sends `PATCH`
   * with the record `version`.
   */
  readonly onCommit: (
    cell: CellAddress,
    value: unknown,
    record: GridRecord,
    options?: CommitOptions,
  ) => void;
  /** An editor closed by a click outside held a value it could not read: mark the cell. */
  readonly onInvalid?: (cell: CellAddress, issue: EditorIssue) => void;
  /** Pending / error state of a cell; `undefined` for a plain cell. */
  readonly cellState?: (cell: CellAddress) => CellEditState | undefined;
  /** Some cell has a state: the canvas draws the overlays (skipped otherwise). */
  readonly hasCellStates?: boolean;
  /** Column-level answer of `canEdit` (read-only columns are announced as such). */
  readonly canEditField?: (fieldId: string) => boolean;
  /** Locale, organization and option rights for the overlay editors. */
  readonly editorContext: EditorContext;
  /** Translated hint shown when a read-only cell is activated. */
  readonly readOnlyHint?: string;
  /** T414: why a column is read-only (a field being converted); else `readOnlyHint`. */
  readonly fieldReadOnlyHint?: (fieldId: string) => string | undefined;
}

/**
 * T205 — undo stack (FRONTEND §6.1). The edit flow (`lib/records`) emits a
 * typed command for every successful write, creation and deletion; T205
 * keeps them per table and replays their inverse.
 */
export interface UndoHooks {
  readonly push: (command: EditCommand) => void;
}

export type { EditCommand };

/** A rectangular selection in grid coordinates. */
export interface GridSelectionRange {
  readonly firstRow: number;
  readonly lastRow: number;
  readonly fieldIds: readonly string[];
  /** Whole rows selected through the row markers, not a cell range (T322a: "Delete N records"). */
  readonly wholeRows?: boolean;
}

/**
 * T205 — selection, clipboard, fill-down, clearing (FRONTEND §4.2, §6).
 * `GridView` turns the `copy` / `cut` / `paste` events (while the grid has
 * the focus), the fill handle, Ctrl/⌘+D and Delete/Backspace into these
 * calls; the page writes through the edit flow.
 */
export interface SelectionHooks {
  readonly onSelectionChange?: (ranges: readonly GridSelectionRange[]) => void;
  /**
   * Copy / cut of the selection (its first range): the clipboard content, a
   * promise of it (rows still loading; written with the async Clipboard
   * API), or `null` to refuse (`base_rule.copy = false`): the clipboard is
   * left unchanged.
   */
  readonly onCopy?: (
    range: GridSelectionRange,
    cut: boolean,
  ) => ClipboardContent | Promise<ClipboardContent | null> | null;
  /** Clipboard text pasted over the selection (its first range); parsed by the handler. */
  readonly onPaste?: (range: GridSelectionRange, text: string) => void;
  /**
   * Fill handle or Ctrl/⌘+D: the values of the `source` rows are copied
   * down (or up) into `destination`, which contains the source; same columns.
   */
  readonly onFill?: (source: GridSelectionRange, destination: GridSelectionRange) => void;
  /** Delete / Backspace: empty the cells of the selection the user may edit. */
  readonly onClear?: (ranges: readonly GridSelectionRange[]) => void;
}

export type { ClipboardContent };

/** T206 — record detail panel (FRONTEND §10.1). */
export interface RecordDetailHooks {
  /**
   * Opens the panel of a record: the expand button shown on the hovered
   * row, Space on a cell (T205, FRONTEND §6.2). Enter keeps opening the
   * cell editor.
   */
  readonly onOpenRecord: (recordId: string) => void;
  /**
   * Right click on a cell: the page shows the cell menu ("Expand record",
   * "View cell history", FRONTEND §10.3) at `anchor` (screen coordinates).
   */
  readonly onCellMenu?: (cell: CellAddress, anchor: HeaderMenuAnchor) => void;
}

/** Screen position of the header that opened a menu. */
export interface HeaderMenuAnchor {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** T207 — field configuration from the column header (FRONTEND §4.3). */
export interface HeaderMenuHooks {
  /** Menu button of a header, or a right click on it. */
  readonly onHeaderMenu: (fieldId: string, anchor: HeaderMenuAnchor) => void;
  /**
   * T468: a click on the error badge of a computed column header
   * (`GridViewProps.headerBadges`); `anchor` is the header. The keyboard
   * reaches the same details through the header menu.
   */
  readonly onHeaderBadge?: (fieldId: string, anchor: HeaderMenuAnchor) => void;
}

/**
 * T207 — column layout: resize and drag to reorder. Widths and the frozen
 * count come back through `GridViewProps` (`widths`, `freezeColumns`).
 */
export interface ColumnHooks {
  /** While dragging a column edge (live width) and once more when released (`done`). */
  readonly onColumnResize?: (fieldId: string, width: number, done: boolean) => void;
  /**
   * A header dragged onto another column: `fieldId` should take the place
   * of `targetFieldId` (the others shift). Absent: columns cannot be dragged.
   */
  readonly onColumnMove?: (fieldId: string, targetFieldId: string) => void;
}

/**
 * T311 — rows: Shift+Enter on a cell adds a record "below" it (FRONTEND
 * §6.2). Records have no manual order (SPEC §4 `__auto`): the page adds one
 * and selects it where the view's order puts it.
 */
export interface RowHooks {
  readonly onAddRow: (row: number, column: number) => void;
}

/**
 * T312, T320a — group headers of a grouped grid (`GridViewProps.rowModel`).
 * A click on a header (or its chevron in the row gutter), Enter or Space on
 * a header row toggles it; a click on a "+" row adds a record in the group.
 */
export interface GroupHooks {
  readonly onToggle: (groupKey: string) => void;
  readonly onAdd?: (groupKey: string) => void;
  /** Whether a record may be added to a group (its menu's "Add a record"). */
  readonly canAdd?: (group: GridGroupRow) => boolean;
  /**
   * Right click on a header, a click on its "N records ▾", or Shift+F10 /
   * the menu key on a header row: the page shows the group menu at `anchor`.
   */
  readonly onMenu?: (groupKey: string, anchor: HeaderMenuAnchor) => void;
  /**
   * (T472) Summaries a header shows over its columns (the summary bar's
   * functions, for the group); `undefined` while unknown. A new function
   * redraws the headers.
   */
  readonly summaries?: ((group: GridGroupRow) => readonly GroupSummary[] | undefined) | undefined;
}

/** A summary drawn in a group header, in line with its column (T472). */
export interface GroupSummary {
  readonly fieldId: string;
  /** "Sum". */
  readonly label: string;
  /** "1,284,500,000 ₫"; `null`: "—". */
  readonly value: string | null;
  /** Right-aligned (numbers). */
  readonly right: boolean;
}

/** A request to open the link picker of a cell (T413). */
export interface LinkPickerOpen {
  readonly cell: CellAddress;
  readonly record: GridRecord;
  /** Screen rectangle of the cell: the single-link popover opens under it. */
  readonly anchor: HeaderMenuAnchor;
  /** A character typed on the cell: the picker's search starts with it. */
  readonly search?: string;
}

/** The linked record under the pointer in a link cell (T413 hover card). */
export interface LinkChipHover {
  readonly cell: CellAddress;
  readonly recordId: string;
  /** Screen rectangle of the chip. */
  readonly anchor: HeaderMenuAnchor;
  /** A click on the chip (shown at once) rather than a hover (shown after a delay). */
  readonly pinned: boolean;
}

/**
 * T413 — link cells (FRONTEND §6.2): Enter, F2, a double click, a typed
 * character or the "+" shown on the hovered cell open the link picker of
 * the page (`canEdit` of `edit` decides); hovering or clicking a chip
 * reports it for the hover card.
 */
export interface LinkHooks {
  readonly onOpenPicker: (request: LinkPickerOpen) => void;
  /** The chip under the pointer changed; `null` when the pointer left every chip. */
  readonly onChipHover?: (hover: LinkChipHover | null) => void;
  /** Why a link cell cannot be edited (linked table not readable), shown on Enter; else the default hint. */
  readonly readOnlyHint?: (fieldId: string) => string | undefined;
}

/**
 * T418 — files dropped on a cell or pasted (Ctrl/⌘+V) while a cell is
 * selected. `accepts` says which cells take files (attachment fields the
 * user may edit); the grid outlines the cell under the pointer ("Drop to
 * upload N files"), then hands the files over and opens the cell.
 */
export interface FileHooks {
  readonly accepts: (cell: CellAddress) => boolean;
  readonly onFiles: (cell: CellAddress, files: readonly File[]) => void;
}

/**
 * T419 — the file viewer of a read-only grid (share page): Enter, F2, a
 * double click (or a click on the selected cell) on an attachment cell that
 * has files and cannot be edited opens the viewer on them, even where the
 * record detail is off.
 */
export interface FileViewerHooks {
  readonly onViewFiles: (cell: CellAddress, record: GridRecord) => void;
}

/**
 * T525 — button cells (FRONTEND §6.2): a click on the button, Enter or
 * Space on its cell presses it when ready; a disabled one says why (tooltip
 * on hover and on keyboard selection). Absent (share pages): buttons never
 * run and every one says so.
 */
export interface ButtonHooks {
  readonly onPress: (cell: CellAddress, record: GridRecord) => void;
  /** Cells (`buttonKey(recordId, fieldId)`) whose click runs; a new set redraws them. */
  readonly running: ReadonlySet<string>;
  /** Tooltip of a disabled button cell. */
  readonly reasonText: (reason: ButtonDisabledReason) => string;
}

/** Everything `GridView` accepts besides data; all optional. */
export interface GridInteractionHooks {
  readonly buttons?: ButtonHooks;
  readonly link?: LinkHooks;
  readonly rows?: RowHooks;
  readonly groups?: GroupHooks;
  readonly edit?: CellEditHooks;
  /**
   * Hint shown when Enter, F2 or a typed character hits a cell that cannot
   * be edited while the whole grid is read-only (no `edit`, FRONTEND §4.1).
   */
  readonly readOnlyHint?: string;
  /** Not used by `GridView` itself: the edit flow of the page pushes into it. */
  readonly undo?: UndoHooks;
  readonly selection?: SelectionHooks;
  readonly recordDetail?: RecordDetailHooks;
  readonly headerMenu?: HeaderMenuHooks;
  readonly columns?: ColumnHooks;
  readonly files?: FileHooks;
  readonly fileViewer?: FileViewerHooks;
}
