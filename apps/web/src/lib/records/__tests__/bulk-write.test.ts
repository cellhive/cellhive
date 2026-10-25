import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../api/client';
import {
  RecordEditController,
  type EditNotifier,
  type RecordCache,
  type RecordWriteApi,
} from '../edit-controller';
import { cellKey } from '../edit-state';
import { bulkCellErrors } from '../write-errors';

import type { EditCommand } from '../commands';
import type { RecordDto } from '@cellhive/contracts';

const TABLE = 'tbl_Tickets000000001';
const TITLE = 'fld_Title00000000001';
const AMOUNT = 'fld_Amount0000000001';
const NOW = '2026-09-24T00:00:00.000Z';

function id(index: number): string {
  return `rec_${String(index).padStart(16, '0')}`;
}

function record(recordId: string, version: number, fields: Record<string, unknown>): RecordDto {
  return { id: recordId as RecordDto['id'], created_at: NOW, updated_at: NOW, version, fields };
}

function problem(status: number, code: ApiError['code'], errors: ApiError['errors'] = []) {
  return new ApiError({ status, code, errors, request_id: 'req_0123456789ABCDEF' });
}

type UpdateItem = Parameters<RecordWriteApi['update']>[1][number];

/** A server that writes what it gets and bumps each record's version. */
function echo(rows: Map<string, RecordDto>) {
  return (_table: string, items: readonly UpdateItem[]) =>
    Promise.resolve({
      records: items.map((item) => {
        const recordId = item.id ?? '';
        const current = rows.get(recordId) ?? record(recordId, 0, {});
        return record(recordId, current.version + 1, { ...current.fields, ...item.fields });
      }),
    });
}

function setup(count: number) {
  const rows = new Map<string, RecordDto>();
  for (let index = 0; index < count; index += 1) {
    rows.set(id(index), record(id(index), 1, { [TITLE]: `T${String(index)}`, [AMOUNT]: index }));
  }
  const patchMany = vi.fn<NonNullable<RecordCache['patchMany']>>((patches) => {
    for (const [recordId, fields] of patches) {
      const row = rows.get(recordId);
      if (row !== undefined) rows.set(recordId, { ...row, fields: { ...row.fields, ...fields } });
    }
  });
  const cache: RecordCache = {
    get: (recordId) => rows.get(recordId),
    patch: (recordId, fields) => {
      patchMany(new Map([[recordId, fields]]));
    },
    replace: (row) => rows.set(row.id, row),
    replaceMany: (records) => {
      for (const row of records) rows.set(row.id, row);
    },
    patchMany,
    append: () => null,
    remove: vi.fn(),
  };
  const api = {
    update: vi.fn<RecordWriteApi['update']>(),
    get: vi.fn<RecordWriteApi['get']>(),
    create: vi.fn<RecordWriteApi['create']>(),
    remove: vi.fn<RecordWriteApi['remove']>(),
    restore: vi.fn<RecordWriteApi['restore']>(),
  };
  const notify = {
    conflict: vi.fn<EditNotifier['conflict']>(),
    denied: vi.fn<EditNotifier['denied']>(),
    notFound: vi.fn<EditNotifier['notFound']>(),
    failed: vi.fn<EditNotifier['failed']>(),
  };
  const commands: EditCommand[] = [];
  const onSchemaTouched = vi.fn();
  const controller = new RecordEditController({
    tableId: TABLE,
    api,
    cache,
    notify,
    onCommand: (command) => commands.push(command),
    onSchemaTouched,
    wait: () => Promise.resolve(),
  });
  return { rows, cache, api, notify, commands, controller, onSchemaTouched, patchMany };
}

describe('RecordEditController.writeCells (FRONTEND §4.2)', () => {
  it('pastes 500 cells as one PATCH with typecast and one command', async () => {
    const { rows, api, controller, commands, onSchemaTouched } = setup(500);
    api.update.mockImplementation(echo(new Map(rows)));
    const writes = Array.from({ length: 500 }, (_, index) => ({
      recordId: id(index),
      fieldId: TITLE,
      value: `New ${String(index)}`,
    }));
    const done = controller.writeCells(writes, { typecast: true });
    // Optimistic and pending right away.
    expect(rows.get(id(7))?.fields[TITLE]).toBe('New 7');
    expect(controller.isPending(id(7), TITLE)).toBe(true);
    const result = await done;
    expect(result).toMatchObject({ failure: null, invalidCells: 0, invalidReasons: [] });
    expect(api.update).toHaveBeenCalledOnce();
    const [, items, options] = api.update.mock.calls[0] ?? [];
    expect(options).toEqual({ typecast: true });
    expect(items).toHaveLength(500);
    expect(items?.[3]).toEqual({ id: id(3), version: 1, fields: { [TITLE]: 'New 3' } });
    expect(commands).toHaveLength(1);
    const command = commands[0];
    expect(command?.kind === 'update' ? command.changes[3] : null).toEqual({
      recordId: id(3),
      fieldId: TITLE,
      before: 'T3',
      after: 'New 3',
      versionBefore: 1,
      versionAfter: 2,
    });
    expect(controller.isPending(id(7), TITLE)).toBe(false);
    expect(controller.getSnapshot().cells.size).toBe(0);
    expect(rows.get(id(7))?.version).toBe(2);
    expect(onSchemaTouched).toHaveBeenCalledOnce();
  });

  it('sends more than 1 000 records in sequential requests, one command each, with progress', async () => {
    const { rows, api, controller, commands } = setup(2300);
    api.update.mockImplementation(echo(new Map(rows)));
    const progress: [number, number][] = [];
    const writes = [...rows.keys()].map((recordId) => ({ recordId, fieldId: AMOUNT, value: 1 }));
    const result = await controller.writeCells(writes, {
      onProgress: (done, total) => progress.push([done, total]),
    });
    expect(result.failure).toBeNull();
    expect(api.update.mock.calls.map(([, items]) => items.length)).toEqual([999, 1000, 300]);
    expect(result.commands).toHaveLength(3);
    // The record that already held 1 has nothing to write: it is left out of the request.
    expect(
      commands.map((command) => (command.kind === 'update' ? command.changes.length : 0)),
    ).toEqual([999, 1000, 300]);
    expect(progress).toEqual([
      [1000, 2300],
      [2000, 2300],
      [2300, 2300],
    ]);
  });

  it('a 422 rolls the whole request back and marks the cells named by errors[].path', async () => {
    const { rows, api, controller, commands } = setup(3);
    api.update.mockRejectedValue(
      problem(422, 'INVALID_CELL_VALUE', [
        {
          path: `records[1].fields.${AMOUNT}`,
          code: 'EXPECTED_NUMBER',
          message: 'Cannot read a number',
        },
      ]),
    );
    const result = await controller.writeCells(
      [0, 1, 2].map((index) => ({
        recordId: id(index),
        fieldId: AMOUNT,
        value: index === 1 ? 'abc' : '100',
        display: index === 1 ? index : 100,
      })),
      { typecast: true },
    );
    expect(result).toEqual({
      commands: [],
      failure: 'invalid',
      invalidCells: 1,
      // Why, once per code: the paste toast says it (T421a).
      invalidReasons: [{ code: 'EXPECTED_NUMBER', message: 'Cannot read a number' }],
    });
    expect([0, 1, 2].map((index) => rows.get(id(index))?.fields[AMOUNT])).toEqual([0, 1, 2]);
    expect(commands).toEqual([]);
    const cells = controller.getSnapshot().cells;
    expect(cells.get(cellKey(id(1), AMOUNT))).toEqual({
      status: 'error',
      error: { code: 'EXPECTED_NUMBER', message: 'Cannot read a number' },
    });
    expect(cells.size).toBe(1);
  });

  it('stops after a refused request: later requests are not sent', async () => {
    const { rows, api, controller, notify } = setup(1500);
    api.update
      .mockImplementationOnce(echo(new Map(rows)))
      .mockRejectedValueOnce(problem(403, 'RECORD_RULE_VIOLATION'));
    const writes = [...rows.keys()].map((recordId) => ({ recordId, fieldId: TITLE, value: 'x' }));
    const result = await controller.writeCells(writes);
    expect(result.failure).toBe('denied');
    expect(result.commands).toHaveLength(1);
    expect(notify.denied).toHaveBeenCalledOnce();
    expect(rows.get(id(1200))?.fields[TITLE]).toBe('T1200');
    expect(rows.get(id(10))?.fields[TITLE]).toBe('x');
  });

  it('undo writes: sends the versions given, a 409 rolls back and reloads', async () => {
    const { rows, api, cache, controller, commands } = setup(2);
    api.update.mockRejectedValue(
      problem(409, 'VERSION_CONFLICT', [
        { path: 'records[0].version', code: 'VERSION_CONFLICT', message: 'changed' },
      ]),
    );
    const result = await controller.writeCells(
      [{ recordId: id(0), fieldId: TITLE, value: 'Before' }],
      { versions: new Map([[id(0), 7]]), emit: false },
    );
    expect(api.update.mock.calls[0]?.[1]).toEqual([
      { id: id(0), version: 7, fields: { [TITLE]: 'Before' } },
    ]);
    expect(result.failure).toBe('conflict');
    expect(rows.get(id(0))?.fields[TITLE]).toBe('T0');
    expect(cache.remove).toHaveBeenCalledWith([]);
    expect(commands).toEqual([]);
  });

  it('writes records that are not on screen when their current value and version are known', async () => {
    const { api, controller } = setup(0);
    api.update.mockResolvedValue({ records: [record(id(9), 5, { [TITLE]: 'Before' })] });
    const result = await controller.writeCells(
      [
        { recordId: id(9), fieldId: TITLE, value: 'Before', before: 'After' },
        // Unknown record without a known value: left out.
        { recordId: id(8), fieldId: TITLE, value: 'x' },
      ],
      { versions: new Map([[id(9), 4]]), emit: false },
    );
    expect(api.update.mock.calls[0]?.[1]).toEqual([
      { id: id(9), version: 4, fields: { [TITLE]: 'Before' } },
    ]);
    expect(result.commands[0]?.changes).toEqual([
      {
        recordId: id(9),
        fieldId: TITLE,
        before: 'After',
        after: 'Before',
        versionBefore: 4,
        versionAfter: 5,
      },
    ]);
  });

  it('retries network trouble with the cells kept pending', async () => {
    const { rows, api, controller } = setup(1);
    api.update
      .mockRejectedValueOnce(problem(503, 'DEPENDENCY_UNAVAILABLE'))
      .mockImplementationOnce(echo(new Map(rows)));
    const result = await controller.writeCells([{ recordId: id(0), fieldId: TITLE, value: 'y' }]);
    expect(result.failure).toBeNull();
    expect(api.update).toHaveBeenCalledTimes(2);
  });
});

describe('RecordEditController.createRecords (paste past the last row)', () => {
  it('creates empty records 1 000 per request, one create command each, shown at once', async () => {
    const { api, cache, controller, commands } = setup(0);
    const appendMany = vi.fn<NonNullable<RecordCache['appendMany']>>();
    cache.appendMany = appendMany;
    let next = 0;
    api.create.mockImplementation((_table, records) =>
      Promise.resolve({
        records: records.map(() => record(id(next++), 1, {})),
      }),
    );
    const created = await controller.createRecords(1500);
    expect(created).toHaveLength(1500);
    expect(api.create.mock.calls.map(([, records]) => records.length)).toEqual([1000, 500]);
    expect(api.create.mock.calls[0]?.[1][0]).toEqual({ fields: {} });
    expect(api.create.mock.calls[0]?.[2]?.idempotencyKey).toMatch(/^web-/u);
    expect(commands.map((command) => command.kind)).toEqual(['create', 'create']);
    expect(appendMany).toHaveBeenCalledOnce();
  });

  it('a refused creation reports and answers null', async () => {
    const { api, controller, notify } = setup(0);
    api.create.mockRejectedValue(problem(403, 'PERMISSION_DENIED'));
    expect(await controller.createRecords(3)).toBeNull();
    expect(notify.denied).toHaveBeenCalledOnce();
  });
});

describe('bulkCellErrors', () => {
  it('reads cell and record paths of a bulk 422', () => {
    const error = problem(422, 'INVALID_CELL_VALUE', [
      { path: `records[2].fields.${AMOUNT}`, code: 'EXPECTED_NUMBER', message: 'n' },
      { path: 'records[4].fields["a.b"]', code: 'EXPECTED_STRING', message: 's' },
      { path: 'records[5]', code: 'REQUIRED_FIELD_MISSING', message: 'r' },
      { path: 'filter', code: 'X', message: 'ignored' },
    ]);
    expect(bulkCellErrors(error).map(({ index, fieldId }) => [index, fieldId])).toEqual([
      [2, AMOUNT],
      [4, 'a.b'],
      [5, null],
    ]);
  });
});
