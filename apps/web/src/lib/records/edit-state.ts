import type { CellErrorDetail } from './write-errors';

/**
 * Per-cell state of the edit flow (FRONTEND §4.1): a cell is `pending`
 * from the optimistic write until the server answers, and carries an
 * `error` (red border + tooltip) after a refused value until it is edited
 * again. Cells without an entry are plain.
 */
export type CellStatus =
  { readonly status: 'pending' } | { readonly status: 'error'; readonly error: CellErrorDetail };

export interface EditState {
  readonly cells: ReadonlyMap<string, CellStatus>;
  /** `409 SCHEMA_LOCKED`: editing is locked until the schema changes (FRONTEND §4.1). */
  readonly schemaLocked: boolean;
}

export type EditAction =
  | { readonly type: 'pending'; readonly key: string }
  | { readonly type: 'settled'; readonly key: string }
  | { readonly type: 'failed'; readonly key: string; readonly error: CellErrorDetail }
  | { readonly type: 'clearError'; readonly key: string }
  | { readonly type: 'dropRecords'; readonly recordIds: readonly string[] }
  /** Many cells at once (bulk writes): a status, or `null` for a plain cell. */
  | {
      readonly type: 'cells';
      readonly updates: readonly (readonly [key: string, status: CellStatus | null])[];
    }
  | { readonly type: 'schemaLocked'; readonly locked: boolean };

export const INITIAL_EDIT_STATE: EditState = { cells: new Map(), schemaLocked: false };

const SEPARATOR = '\u0000';

/** Key of a cell in `EditState.cells`. */
export function cellKey(recordId: string, fieldId: string): string {
  return `${recordId}${SEPARATOR}${fieldId}`;
}

function recordOf(key: string): string {
  return key.slice(0, key.indexOf(SEPARATOR));
}

function withCell(state: EditState, key: string, status: CellStatus | null): EditState {
  const current = state.cells.get(key);
  if (status === null && current === undefined) return state;
  const cells = new Map(state.cells);
  if (status === null) cells.delete(key);
  else cells.set(key, status);
  return { ...state, cells };
}

/** Pure transitions of the edit state (unit-tested; the controller keeps the store). */
export function editReducer(state: EditState, action: EditAction): EditState {
  switch (action.type) {
    case 'pending':
      return withCell(state, action.key, { status: 'pending' });
    case 'settled':
      return withCell(state, action.key, null);
    case 'failed':
      return withCell(state, action.key, { status: 'error', error: action.error });
    case 'clearError':
      return state.cells.get(action.key)?.status === 'error'
        ? withCell(state, action.key, null)
        : state;
    case 'dropRecords': {
      const ids = new Set(action.recordIds);
      const kept = [...state.cells].filter(([key]) => !ids.has(recordOf(key)));
      return kept.length === state.cells.size ? state : { ...state, cells: new Map(kept) };
    }
    case 'cells': {
      const changed = action.updates.some(([key, status]) =>
        status === null ? state.cells.has(key) : state.cells.get(key) !== status,
      );
      if (!changed) return state;
      const cells = new Map(state.cells);
      for (const [key, status] of action.updates) {
        if (status === null) cells.delete(key);
        else cells.set(key, status);
      }
      return { ...state, cells };
    }
    case 'schemaLocked':
      return state.schemaLocked === action.locked
        ? state
        : { ...state, schemaLocked: action.locked };
  }
}
