import { describe, expect, it } from 'vitest';

import {
  cellKey,
  editReducer,
  INITIAL_EDIT_STATE,
  type EditAction,
  type EditState,
} from '../edit-state';

const A = cellKey('rec_A000000000000001', 'fld_Amount0000000001');
const B = cellKey('rec_A000000000000001', 'fld_Status0000000001');
const C = cellKey('rec_B000000000000001', 'fld_Amount0000000001');
const ERROR = { code: 'EXPECTED_NUMBER' };

function run(...actions: EditAction[]): EditState {
  return actions.reduce(editReducer, INITIAL_EDIT_STATE);
}

describe('editReducer (FRONTEND §4.1 cell states)', () => {
  it.each<[string, EditAction[], Record<string, string>]>([
    ['pending while writing', [{ type: 'pending', key: A }], { [A]: 'pending' }],
    [
      'settled cell is plain',
      [
        { type: 'pending', key: A },
        { type: 'settled', key: A },
      ],
      {},
    ],
    [
      'refused value marks the cell',
      [
        { type: 'pending', key: A },
        { type: 'failed', key: A, error: ERROR },
      ],
      { [A]: 'error' },
    ],
    [
      'a new edit replaces the error by pending',
      [
        { type: 'failed', key: A, error: ERROR },
        { type: 'pending', key: A },
      ],
      { [A]: 'pending' },
    ],
    [
      'clearError leaves a pending cell alone',
      [
        { type: 'pending', key: A },
        { type: 'clearError', key: A },
      ],
      { [A]: 'pending' },
    ],
    [
      'clearError removes an error',
      [
        { type: 'failed', key: A, error: ERROR },
        { type: 'clearError', key: A },
      ],
      {},
    ],
    [
      'dropRecords removes every cell of the records',
      [
        { type: 'pending', key: A },
        { type: 'failed', key: B, error: ERROR },
        { type: 'pending', key: C },
        { type: 'dropRecords', recordIds: ['rec_A000000000000001'] },
      ],
      { [C]: 'pending' },
    ],
  ])('%s', (_name, actions, expected) => {
    const state = run(...actions);
    expect(Object.fromEntries([...state.cells].map(([key, cell]) => [key, cell.status]))).toEqual(
      expected,
    );
  });

  it('keeps the same object when nothing changes (no re-render)', () => {
    const state = run({ type: 'pending', key: A });
    expect(editReducer(state, { type: 'settled', key: B })).toBe(state);
    expect(editReducer(state, { type: 'clearError', key: A })).toBe(state);
    expect(editReducer(state, { type: 'dropRecords', recordIds: ['rec_X'] })).toBe(state);
    expect(editReducer(state, { type: 'schemaLocked', locked: false })).toBe(state);
  });

  it('locks and unlocks editing on SCHEMA_LOCKED', () => {
    const locked = run({ type: 'schemaLocked', locked: true });
    expect(locked.schemaLocked).toBe(true);
    expect(editReducer(locked, { type: 'schemaLocked', locked: false }).schemaLocked).toBe(false);
  });
});
