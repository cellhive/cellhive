import { describe, expect, it } from 'vitest';

import {
  chunkByRecord,
  fillSourceRows,
  pasteArea,
  planWrites,
  UNDO_LIMIT,
  UndoHistory,
  type ReplayOutcome,
} from '../commands';
import { toGridField, type GridRecord } from '../types';

import type { EditCommand, UpdateCommand } from '../../lib/records/commands';
import type { FieldDto } from '@cellhive/contracts';

const TABLE = 'tbl_Tickets000000001';
const NOW = '2026-09-24T00:00:00.000Z';

function update(recordId: string, versionAfter: number, versionBefore?: number): UpdateCommand {
  return {
    kind: 'update',
    tableId: TABLE,
    changes: [
      {
        recordId,
        fieldId: 'fld_A000000000000001',
        before: 'old',
        after: 'new',
        ...(versionBefore === undefined ? {} : { versionBefore }),
        versionAfter,
      },
    ],
  };
}

function field(id: string, type = 'text'): FieldDto {
  return {
    id: id as FieldDto['id'],
    table_id: TABLE,
    name: id,
    type,
    options: {},
    is_primary: false,
    required: false,
    unique_values: false,
    description: null,
    position: 0,
    created_at: NOW,
    updated_at: NOW,
  } as FieldDto;
}

function record(id: string, fields: Record<string, unknown> = {}): GridRecord {
  return { id: id as GridRecord['id'], created_at: NOW, updated_at: NOW, version: 1, fields };
}

const inverseOf = (command: EditCommand): ReplayOutcome => ({ status: 'done', inverse: command });

describe('UndoHistory (FRONTEND §6.1)', () => {
  it('undoes the last change, then redoes it; a new change clears redo', async () => {
    const history = new UndoHistory();
    const first = update('rec_1', 2);
    const second = update('rec_2', 5);
    history.push(first);
    history.push(second);
    expect(history.getSnapshot()).toEqual({ canUndo: true, canRedo: false, busy: false });

    const replayed: EditCommand[] = [];
    await history.undo((command) => {
      replayed.push(command);
      return Promise.resolve(inverseOf(update('rec_2', 6)));
    });
    expect(replayed).toEqual([second]);
    expect(history.undoStack).toEqual([first]);
    expect(history.redoStack).toEqual([update('rec_2', 6)]);
    expect(history.getSnapshot()).toMatchObject({ canUndo: true, canRedo: true });

    await history.redo((command) => Promise.resolve(inverseOf({ ...command })));
    expect(history.undoStack).toEqual([first, update('rec_2', 6)]);
    expect(history.redoStack).toEqual([]);

    await history.undo(() => Promise.resolve(inverseOf(update('rec_2', 7))));
    expect(history.getSnapshot().canRedo).toBe(true);
    history.push(update('rec_3', 1));
    expect(history.getSnapshot().canRedo).toBe(false);
  });

  it(`keeps at most ${String(UNDO_LIMIT)} steps, dropping the oldest`, () => {
    const history = new UndoHistory();
    for (let index = 0; index < UNDO_LIMIT + 5; index += 1)
      history.push(update(`rec_${String(index)}`, 1));
    expect(history.undoStack).toHaveLength(UNDO_LIMIT);
    expect(history.undoStack[0]).toEqual(update('rec_5', 1));
  });

  it('drops a command whose replay is refused (409) and keeps one that failed for now', async () => {
    const history = new UndoHistory();
    const kept = update('rec_1', 2);
    const conflicting = update('rec_2', 2);
    history.push(kept);
    history.push(conflicting);
    await history.undo(() => Promise.resolve({ status: 'dropped' }));
    expect(history.undoStack).toEqual([kept]);
    expect(history.redoStack).toEqual([]);
    await history.undo(() => Promise.resolve({ status: 'kept' }));
    expect(history.undoStack).toEqual([kept]);
    // A thrown replay counts as "kept" too.
    await history.undo(() => Promise.reject(new Error('offline')));
    expect(history.undoStack).toEqual([kept]);
  });

  it('runs one replay at a time and ignores empty commands', async () => {
    const history = new UndoHistory();
    history.push({ kind: 'update', tableId: TABLE, changes: [] });
    history.push({ kind: 'create', tableId: TABLE, recordIds: [] });
    expect(history.getSnapshot().canUndo).toBe(false);
    history.push(update('rec_1', 2));
    history.push(update('rec_2', 2));
    let release: (outcome: ReplayOutcome) => void = () => undefined;
    const running = history.undo(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    expect(history.getSnapshot().busy).toBe(true);
    expect(await history.undo(() => Promise.resolve({ status: 'dropped' }))).toBeNull();
    release({ status: 'done', inverse: null });
    await running;
    expect(history.getSnapshot()).toEqual({ canUndo: true, canRedo: false, busy: false });
  });

  it('a change made while an undo runs leaves the redo stack empty', async () => {
    const history = new UndoHistory();
    history.push(update('rec_1', 2));
    await history.undo((command) => {
      history.push(update('rec_9', 1));
      return Promise.resolve(inverseOf(command));
    });
    expect(history.redoStack).toEqual([]);
  });

  it('rebases older commands on the version a replay produced', async () => {
    const history = new UndoHistory();
    // Two edits of one record: v1 → v2, then v2 → v3.
    history.push(update('rec_1', 2, 1));
    history.push(update('rec_1', 3, 2));
    await history.undo(() =>
      Promise.resolve({
        status: 'done',
        inverse: update('rec_1', 4, 3),
        rebases: [{ recordId: 'rec_1', from: 2, to: 4 }],
      }),
    );
    // The first edit now expects version 4 (the record is back where it left it).
    expect(history.undoStack).toEqual([update('rec_1', 4, 1)]);
    expect(history.redoStack).toEqual([update('rec_1', 4, 3)]);
  });
});

describe('chunkByRecord (FRONTEND §4.2)', () => {
  it('keeps the cells of a record together, at most `max` records per chunk', () => {
    const writes = [
      { recordId: 'r1', fieldId: 'a' },
      { recordId: 'r2', fieldId: 'a' },
      { recordId: 'r1', fieldId: 'b' },
      { recordId: 'r3', fieldId: 'a' },
    ];
    expect(chunkByRecord(writes, 2)).toEqual([
      [
        { recordId: 'r1', fieldId: 'a' },
        { recordId: 'r1', fieldId: 'b' },
        { recordId: 'r2', fieldId: 'a' },
      ],
      [{ recordId: 'r3', fieldId: 'a' }],
    ]);
  });

  it('splits 2 500 records into requests of 1 000', () => {
    const writes = Array.from({ length: 2500 }, (_, index) => ({ recordId: `r${String(index)}` }));
    expect(chunkByRecord(writes).map((chunk) => chunk.length)).toEqual([1000, 1000, 500]);
    expect(chunkByRecord([])).toEqual([]);
  });
});

describe('pasteArea', () => {
  const matrix = [
    ['a', 'b'],
    ['c', 'd'],
  ];

  it('puts the copied rectangle at the anchor and counts rows past the end', () => {
    const area = pasteArea(matrix, { firstRow: 9, rows: 1, columns: 1 }, 0, 5, 10);
    expect(area).toMatchObject({ height: 2, width: 2, extraRows: 1, clipped: 0 });
    expect(area.textAt(1, 1)).toBe('d');
  });

  it('clips columns past the last one and reports them as skipped cells', () => {
    const area = pasteArea(matrix, { firstRow: 0, rows: 1, columns: 1 }, 4, 5, 10);
    expect(area).toMatchObject({ height: 2, width: 1, clipped: 2, extraRows: 0 });
  });

  it('fills a larger selection with one copied cell', () => {
    const area = pasteArea([['x']], { firstRow: 2, rows: 3, columns: 2 }, 1, 5, 10);
    expect(area).toMatchObject({ height: 3, width: 2, extraRows: 0 });
    expect(area.textAt(2, 1)).toBe('x');
  });

  it('repeats the rectangle over a selection that is a whole multiple of it', () => {
    const area = pasteArea(matrix, { firstRow: 0, rows: 4, columns: 2 }, 0, 5, 10);
    expect(area).toMatchObject({ height: 4, width: 2 });
    expect(area.textAt(3, 0)).toBe('c');
    // Not a multiple: pasted once.
    expect(pasteArea(matrix, { firstRow: 0, rows: 3, columns: 2 }, 0, 5, 10).height).toBe(2);
  });
});

describe('planWrites (range → bulk payload, skipped cells)', () => {
  const name = toGridField(field('fld_Name000000000001'));
  const status = toGridField(field('fld_Status0000000001'));
  const created = toGridField(field('fld_Created000000001', 'created_at'));
  const canWrite = (column: typeof name) => column !== status;

  it('maps each cell to a write and counts read-only, computed and missing cells', () => {
    const plan = planWrites({
      records: [record('rec_1'), undefined, record('rec_3')],
      fields: [name, status, created],
      canWrite: (column) => canWrite(column) && column !== created,
      value: (row, column) => ({ value: `${String(row)}:${String(column)}` }),
    });
    expect(plan.writes).toEqual([
      { recordId: 'rec_1', fieldId: 'fld_Name000000000001', value: '0:0' },
      { recordId: 'rec_3', fieldId: 'fld_Name000000000001', value: '2:0' },
    ]);
    // rec_1: status + created; missing row: 3 cells; rec_3: status + created.
    expect(plan.skipped).toBe(7);
  });

  it('leaves cells alone when `value` has nothing for them (not counted)', () => {
    const plan = planWrites({
      records: [record('rec_1', { fld_Name000000000001: 'x' }), record('rec_2')],
      fields: [name],
      canWrite: () => true,
      value: (row, _column, column, source) =>
        row === 0 ? undefined : { value: 'x', display: source.fields[column.field.id] ?? 'shown' },
    });
    expect(plan).toEqual({
      writes: [
        { recordId: 'rec_2', fieldId: 'fld_Name000000000001', value: 'x', display: 'shown' },
      ],
      skipped: 0,
    });
  });
});

describe('fillSourceRows (FRONTEND §6.4)', () => {
  it('copies the first row down', () => {
    expect(fillSourceRows({ firstRow: 2, lastRow: 2 }, { firstRow: 2, lastRow: 5 })).toEqual([
      null,
      2,
      2,
      2,
    ]);
  });

  it('repeats a multi-row source down and up, aligned on the source', () => {
    expect(fillSourceRows({ firstRow: 2, lastRow: 3 }, { firstRow: 2, lastRow: 6 })).toEqual([
      null,
      null,
      2,
      3,
      2,
    ]);
    expect(fillSourceRows({ firstRow: 4, lastRow: 5 }, { firstRow: 1, lastRow: 5 })).toEqual([
      5,
      4,
      5,
      null,
      null,
    ]);
  });
});
