import { chunkByRecord } from '../lib/records/commands';

import type { GridField, GridRecord } from './types';
import type { CellChange, EditCommand } from '../lib/records/commands';

/**
 * Commands of the grid (FRONTEND §4.2, §6.1): the undo stack and the
 * mapping of a paste, fill or clear onto cell writes. Pure; the page runs
 * the writes through `RecordEditController`.
 */

// --- undo stack ---------------------------------------------------------------------

/** Steps kept per table (FRONTEND §6.1). */
export const UNDO_LIMIT = 50;

/** A record's version moved from `from` to `to` without changing what older commands expect. */
export interface VersionRebase {
  readonly recordId: string;
  readonly from: number;
  readonly to: number;
}

/**
 * What replaying a command did:
 * - `done`: `inverse` goes on the other stack (redo after an undo);
 * - `dropped`: the command can no longer apply (`409`, records gone): it is discarded;
 * - `kept`: it failed for now (network, rights): it stays where it was.
 */
export type ReplayOutcome =
  | {
      readonly status: 'done';
      readonly inverse: EditCommand | null;
      readonly rebases?: readonly VersionRebase[];
    }
  | { readonly status: 'dropped' }
  | { readonly status: 'kept' };

export interface UndoSnapshot {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** An undo or redo is running: the next one waits (buttons disabled). */
  readonly busy: boolean;
}

const IDLE: UndoSnapshot = { canUndo: false, canRedo: false, busy: false };

function rebaseCommand(command: EditCommand, rebase: VersionRebase): EditCommand {
  if (command.kind !== 'update') return command;
  const matches = (change: CellChange) =>
    change.recordId === rebase.recordId && change.versionAfter === rebase.from;
  if (!command.changes.some(matches)) return command;
  return {
    ...command,
    changes: command.changes.map((change) =>
      matches(change) ? { ...change, versionAfter: rebase.to } : change,
    ),
  };
}

/**
 * Undo and redo stacks of one table (FRONTEND §6.1): at most 50 steps, a
 * new command clears the redo stack, one replay at a time. Replaying is up
 * to the caller (`run`), which answers with a `ReplayOutcome`. An external
 * store for `useSyncExternalStore`.
 */
export class UndoHistory {
  readonly #limit: number;
  #undo: EditCommand[] = [];
  #redo: EditCommand[] = [];
  #busy = false;
  /** Bumped by every new command: an undo that finishes after one does not fill the redo stack. */
  #generation = 0;
  #snapshot: UndoSnapshot = IDLE;
  readonly #listeners = new Set<() => void>();

  constructor(limit = UNDO_LIMIT) {
    this.#limit = limit;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getSnapshot = (): UndoSnapshot => this.#snapshot;

  /** Commands on the undo stack, oldest first (tests, debugging). */
  get undoStack(): readonly EditCommand[] {
    return this.#undo;
  }

  get redoStack(): readonly EditCommand[] {
    return this.#redo;
  }

  /** A new change of the user: it becomes the next undo, and redo is no longer possible. */
  push(command: EditCommand): void {
    if (command.kind === 'update' && command.changes.length === 0) return;
    if (command.kind !== 'update' && command.recordIds.length === 0) return;
    this.#generation += 1;
    this.#undo.push(command);
    if (this.#undo.length > this.#limit) this.#undo.splice(0, this.#undo.length - this.#limit);
    this.#redo = [];
    this.#emit();
  }

  /** Replays the inverse of the last change; `null` when there is nothing to undo or one is running. */
  undo(run: (command: EditCommand) => Promise<ReplayOutcome>): Promise<ReplayOutcome | null> {
    return this.#replay('undo', run);
  }

  redo(run: (command: EditCommand) => Promise<ReplayOutcome>): Promise<ReplayOutcome | null> {
    return this.#replay('redo', run);
  }

  /**
   * A replay brought a record back to the state an older command expects,
   * under a new version: those commands use the new version from now on.
   */
  rebase(rebases: readonly VersionRebase[]): void {
    for (const rebase of rebases) {
      if (rebase.from === rebase.to) continue;
      this.#undo = this.#undo.map((command) => rebaseCommand(command, rebase));
      this.#redo = this.#redo.map((command) => rebaseCommand(command, rebase));
    }
  }

  clear(): void {
    this.#undo = [];
    this.#redo = [];
    this.#emit();
  }

  async #replay(
    direction: 'undo' | 'redo',
    run: (command: EditCommand) => Promise<ReplayOutcome>,
  ): Promise<ReplayOutcome | null> {
    const from = direction === 'undo' ? this.#undo : this.#redo;
    const command = from.at(-1);
    if (this.#busy || command === undefined) return null;
    this.#busy = true;
    this.#emit();
    const generation = this.#generation;
    let outcome: ReplayOutcome;
    try {
      outcome = await run(command);
    } catch {
      outcome = { status: 'kept' };
    }
    this.#busy = false;
    if (outcome.status !== 'kept') this.#remove(direction, command);
    if (outcome.status === 'done') {
      this.rebase(outcome.rebases ?? []);
      const inverse = outcome.inverse;
      if (inverse !== null) {
        if (direction === 'redo') {
          this.#undo.push(inverse);
          if (this.#undo.length > this.#limit) this.#undo.shift();
        } else if (generation === this.#generation) {
          // A change made while the undo ran makes redo meaningless.
          this.#redo.push(inverse);
        }
      }
    }
    this.#emit();
    return outcome;
  }

  #remove(direction: 'undo' | 'redo', command: EditCommand): void {
    const stack = direction === 'undo' ? this.#undo : this.#redo;
    const index = stack.lastIndexOf(command);
    if (index >= 0) stack.splice(index, 1);
  }

  #emit(): void {
    const next: UndoSnapshot = {
      canUndo: this.#undo.length > 0,
      canRedo: this.#redo.length > 0,
      busy: this.#busy,
    };
    const current = this.#snapshot;
    if (
      current.canUndo === next.canUndo &&
      current.canRedo === next.canRedo &&
      current.busy === next.busy
    ) {
      return;
    }
    this.#snapshot = next;
    for (const listener of this.#listeners) listener();
  }
}

// --- cell writes ----------------------------------------------------------------------

/** A cell to write: `value` in the json write shape (or text with `typecast`). */
export interface PlannedWrite {
  readonly recordId: string;
  readonly fieldId: string;
  readonly value: unknown;
  /** Shown in the cell until the server answers (default: `value`). */
  readonly display?: unknown;
}

export { chunkByRecord };

/** Where pasted cells land (FRONTEND §6.3). */
export interface PasteArea {
  /** Rows written from the anchor row (existing and new ones). */
  readonly height: number;
  /** Columns written from the anchor column (clipped to the grid). */
  readonly width: number;
  /** Rows needed beyond the last row of the grid ("Add N rows?", FRONTEND §4.2). */
  readonly extraRows: number;
  /** Cells that fall right of the last column: not written, reported as skipped. */
  readonly clipped: number;
  /** Text for a cell of the area (row, column relative to the anchor). */
  readonly textAt: (row: number, column: number) => string;
}

/**
 * The area a paste covers: the copied rectangle at the anchor (top-left
 * cell of the selection); a single copied cell fills a larger selection,
 * and a selection that is a whole multiple of the copied rectangle repeats
 * it (as spreadsheets do).
 */
export function pasteArea(
  matrix: readonly (readonly string[])[],
  selection: { readonly firstRow: number; readonly rows: number; readonly columns: number },
  anchorColumn: number,
  columnCount: number,
  rowCount: number,
): PasteArea {
  const matrixHeight = Math.max(1, matrix.length);
  const matrixWidth = Math.max(1, matrix[0]?.length ?? 1);
  const repeats =
    selection.rows * selection.columns > 1 &&
    selection.rows % matrixHeight === 0 &&
    selection.columns % matrixWidth === 0;
  const height = repeats ? selection.rows : matrixHeight;
  const fullWidth = repeats ? selection.columns : matrixWidth;
  const width = Math.max(0, Math.min(fullWidth, columnCount - anchorColumn));
  return {
    height,
    width,
    extraRows: Math.max(0, selection.firstRow + height - rowCount),
    clipped: (fullWidth - width) * height,
    textAt: (row, column) => matrix[row % matrixHeight]?.[column % matrixWidth] ?? '',
  };
}

/** Writes of a rectangle of cells and how many cells could not be written. */
export interface WritePlan {
  readonly writes: PlannedWrite[];
  /** Read-only, computed or not loaded cells (reported with a toast, FRONTEND §6.3). */
  readonly skipped: number;
}

/**
 * Maps a rectangle onto writes: row `i` of the rectangle is `records[i]`,
 * column `j` is `fields[j]`. Cells the user may not write (field right,
 * computed or system type) are skipped and counted; `value` returns
 * `undefined` for a cell that is left alone (e.g. inside a fill's source).
 */
export function planWrites(input: {
  readonly records: readonly (GridRecord | undefined)[];
  readonly fields: readonly GridField[];
  readonly canWrite: (field: GridField, record: GridRecord) => boolean;
  readonly value: (
    row: number,
    column: number,
    field: GridField,
    record: GridRecord,
  ) => { value: unknown; display?: unknown } | undefined;
}): WritePlan {
  const writes: PlannedWrite[] = [];
  let skipped = 0;
  input.records.forEach((record, row) => {
    input.fields.forEach((field, column) => {
      if (record === undefined) {
        skipped += 1;
        return;
      }
      const cell = input.value(row, column, field, record);
      if (cell === undefined) return;
      if (!input.canWrite(field, record)) {
        skipped += 1;
        return;
      }
      writes.push({
        recordId: record.id,
        fieldId: field.field.id,
        value: cell.value,
        ...('display' in cell ? { display: cell.display } : {}),
      });
    });
  });
  return { writes, skipped };
}

/** A rectangle of rows (inclusive) in grid coordinates. */
export interface RowSpan {
  readonly firstRow: number;
  readonly lastRow: number;
}

/**
 * Which source row fills each destination row (FRONTEND §6.4): the source
 * rows repeat, aligned on the source (also when dragging upwards); rows of
 * the source itself are left alone (`null`). Fill-down copies values; it
 * never extends a series.
 */
export function fillSourceRows(source: RowSpan, destination: RowSpan): (number | null)[] {
  const height = source.lastRow - source.firstRow + 1;
  const rows: (number | null)[] = [];
  for (let row = destination.firstRow; row <= destination.lastRow; row += 1) {
    if (row >= source.firstRow && row <= source.lastRow) {
      rows.push(null);
      continue;
    }
    rows.push(source.firstRow + ((((row - source.firstRow) % height) + height) % height));
  }
  return rows;
}
