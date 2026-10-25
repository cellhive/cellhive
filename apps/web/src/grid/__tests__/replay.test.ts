import { describe, expect, it, vi } from 'vitest';

import { UndoHistory } from '../commands';
import { replayCommand, type ReplayController, type ReplayProblem } from '../undo/replay';

import type { UpdateCommand } from '../../lib/records/commands';
import type { RecordDto } from '@cellhive/contracts';

const TABLE = 'tbl_Tickets000000001';
const OWNER = 'fld_Owner00000000001';
const NOW = '2026-09-24T00:00:00.000Z';
const R1 = 'rec_A000000000000001';

function fakeController(overrides: Partial<ReplayController> = {}): ReplayController {
  return {
    writeCells: vi.fn<ReplayController['writeCells']>(),
    removeRecords: vi.fn<ReplayController['removeRecords']>(),
    restore: vi.fn<ReplayController['restore']>(),
    ...overrides,
  };
}

const user = { id: 'usr_0123456789ABCDEF', name: 'Nguyễn A', email: 'a@x.vn' };
const edit: UpdateCommand = {
  kind: 'update',
  tableId: TABLE,
  changes: [
    {
      recordId: R1,
      fieldId: OWNER,
      before: null,
      after: [user],
      versionBefore: 1,
      versionAfter: 2,
    },
  ],
};

describe('replayCommand (FRONTEND §6.1)', () => {
  it('undo of an update: PATCH of `before` in the write shape with version = versionAfter', async () => {
    const inverse: UpdateCommand = {
      kind: 'update',
      tableId: TABLE,
      changes: [
        {
          recordId: R1,
          fieldId: OWNER,
          before: [user],
          after: null,
          versionBefore: 2,
          versionAfter: 3,
        },
      ],
    };
    const writeCells = vi.fn<ReplayController['writeCells']>().mockResolvedValue({
      commands: [inverse],
      failure: null,
      invalidCells: 0,
      invalidReasons: [],
    });
    const outcome = await replayCommand(fakeController({ writeCells }), edit, () => undefined);
    expect(writeCells).toHaveBeenCalledWith(
      [{ recordId: R1, fieldId: OWNER, value: null, display: null, before: [user] }],
      { versions: new Map([[R1, 2]]), emit: false },
    );
    expect(outcome).toEqual({
      status: 'done',
      inverse,
      rebases: [{ recordId: R1, from: 1, to: 3 }],
    });
  });

  it('redo sends users as [{ id }]', async () => {
    const writeCells = vi
      .fn<ReplayController['writeCells']>()
      .mockResolvedValue({ commands: [], failure: null, invalidCells: 0, invalidReasons: [] });
    const redo: UpdateCommand = {
      ...edit,
      changes: edit.changes.map((change) => ({ ...change, before: change.after, after: null })),
    };
    expect(await replayCommand(fakeController({ writeCells }), redo, () => undefined)).toEqual({
      status: 'done',
      inverse: null,
    });
    expect(writeCells.mock.calls[0]?.[0][0]).toMatchObject({
      value: [{ id: user.id }],
      display: [user],
    });
  });

  it.each([
    ['conflict', 'dropped', 'conflict'],
    ['invalid', 'dropped', 'invalid'],
    ['not_found', 'dropped', null],
    ['denied', 'dropped', null],
    ['failed', 'kept', null],
    ['schema_locked', 'kept', null],
  ] as const)('a %s answer: the step is %s', async (failure, status, problem) => {
    const report = vi.fn<(problem: ReplayProblem) => void>();
    const writeCells = vi
      .fn<ReplayController['writeCells']>()
      .mockResolvedValue({ commands: [], failure, invalidCells: 0, invalidReasons: [] });
    expect(await replayCommand(fakeController({ writeCells }), edit, report)).toEqual({ status });
    if (problem === null) expect(report).not.toHaveBeenCalled();
    else expect(report).toHaveBeenCalledWith(problem);
  });

  it('409 on undo: the command leaves the stack with the message of FRONTEND §6.1', async () => {
    const history = new UndoHistory();
    history.push(edit);
    const problems: ReplayProblem[] = [];
    const controller = fakeController({
      writeCells: vi.fn<ReplayController['writeCells']>().mockResolvedValue({
        commands: [],
        failure: 'conflict',
        invalidCells: 0,
        invalidReasons: [],
      }),
    });
    await history.undo((command) =>
      replayCommand(controller, command, (problem) => problems.push(problem)),
    );
    expect(problems).toEqual(['conflict']);
    expect(history.getSnapshot()).toEqual({ canUndo: false, canRedo: false, busy: false });
  });

  it('undo of a creation deletes the records; redo restores them and rebases', async () => {
    const removeRecords = vi.fn<ReplayController['removeRecords']>().mockResolvedValue({
      kind: 'delete',
      tableId: TABLE,
      recordIds: [R1],
      versions: { [R1]: 4 },
    });
    const restored: RecordDto = {
      id: R1,
      created_at: NOW,
      updated_at: NOW,
      version: 6,
      fields: {},
    };
    const restore = vi.fn<ReplayController['restore']>().mockResolvedValue([restored]);
    const controller = fakeController({ removeRecords, restore });
    const undone = await replayCommand(
      controller,
      { kind: 'create', tableId: TABLE, recordIds: [R1] },
      () => undefined,
    );
    expect(removeRecords).toHaveBeenCalledWith([R1], { emit: false });
    expect(undone).toEqual({
      status: 'done',
      inverse: { kind: 'delete', tableId: TABLE, recordIds: [R1], versions: { [R1]: 4 } },
    });
    if (undone.status !== 'done' || undone.inverse === null) throw new Error('no inverse');
    const redone = await replayCommand(controller, undone.inverse, () => undefined);
    expect(restore).toHaveBeenCalledWith([R1], { emit: false });
    expect(redone).toEqual({
      status: 'done',
      inverse: { kind: 'create', tableId: TABLE, recordIds: [R1] },
      rebases: [{ recordId: R1, from: 4, to: 6 }],
    });
  });

  it('records already gone drop the step; a failed request keeps it', async () => {
    const report = vi.fn<(problem: ReplayProblem) => void>();
    const gone = fakeController({
      restore: vi.fn<ReplayController['restore']>().mockResolvedValue([]),
      removeRecords: vi.fn<ReplayController['removeRecords']>().mockResolvedValue(null),
    });
    expect(
      await replayCommand(gone, { kind: 'delete', tableId: TABLE, recordIds: [R1] }, report),
    ).toEqual({ status: 'dropped' });
    expect(report).toHaveBeenCalledWith('gone');
    expect(
      await replayCommand(gone, { kind: 'create', tableId: TABLE, recordIds: [R1] }, report),
    ).toEqual({ status: 'kept' });
  });
});
