import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../api/client';
import {
  NETWORK_RETRY_DELAYS_MS,
  RecordEditController,
  sameCellValue,
  SCHEMA_LOCK_RETRY_MS,
  type EditNotifier,
  type RecordCache,
  type RecordWriteApi,
  versionToSend,
} from '../edit-controller';
import { cellKey } from '../edit-state';

import type { EditCommand } from '../commands';
import type { RecordDto } from '@cellhive/contracts';

const TABLE = 'tbl_Orders0000000001';
const R1 = 'rec_A000000000000001';
const R2 = 'rec_B000000000000001';
const AMOUNT = 'fld_Amount0000000001';
const STATUS = 'fld_Status0000000001';
const NOW = '2026-09-24T00:00:00.000Z';

function record(id: string, version: number, fields: Record<string, unknown>): RecordDto {
  return { id: id as RecordDto['id'], created_at: NOW, updated_at: NOW, version, fields };
}

/** Rows of a screen: what the grid would show. */
function memoryCache(initial: RecordDto[]): RecordCache & {
  rows: Map<string, RecordDto>;
  appended: RecordDto[];
  removed: string[][];
} {
  const rows = new Map<string, RecordDto>(initial.map((row) => [row.id, row]));
  const appended: RecordDto[] = [];
  const removed: string[][] = [];
  return {
    rows,
    appended,
    removed,
    get: (id) => rows.get(id),
    patch: (id, fields) => {
      const row = rows.get(id);
      if (row !== undefined) rows.set(id, { ...row, fields: { ...row.fields, ...fields } });
    },
    replace: (row) => {
      rows.set(row.id, row);
    },
    append: (row) => {
      appended.push(row);
      rows.set(row.id, row);
      return rows.size - 1;
    },
    remove: (ids) => {
      removed.push([...ids]);
      for (const id of ids) rows.delete(id);
    },
  };
}

function problem(status: number, code: ApiError['code'], errors: ApiError['errors'] = []) {
  return new ApiError({ status, code, errors, request_id: 'req_0123456789ABCDEF' });
}

function setup(rows = [record(R1, 1, { [AMOUNT]: 10, [STATUS]: 'Mới' })]) {
  const cache = memoryCache(rows);
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
  const waits: number[] = [];
  const onSchemaTouched = vi.fn();
  const controller = new RecordEditController({
    tableId: TABLE,
    api,
    cache,
    notify,
    onCommand: (command) => commands.push(command),
    onSchemaTouched,
    wait: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  });
  return { cache, api, notify, commands, waits, controller, onSchemaTouched };
}

/** The server answer of a successful PATCH of R1. */
function saved(version: number, fields: Record<string, unknown>) {
  return { records: [record(R1, version, fields)] };
}

describe('RecordEditController (FRONTEND §4.1)', () => {
  it('writes optimistically, sends the version and puts the answer back', async () => {
    const { cache, api, controller, commands } = setup();
    let answer: (value: { records: RecordDto[] }) => void = () => undefined;
    api.update.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const done = controller.commit({ recordId: R1, fieldId: AMOUNT, value: 25 });
    // Optimistic value and pending state before the answer.
    expect(cache.rows.get(R1)?.fields[AMOUNT]).toBe(25);
    expect(controller.isPending(R1, AMOUNT)).toBe(true);
    expect(controller.isPending(R1, STATUS)).toBe(false);
    expect(controller.getSnapshot().cells.get(cellKey(R1, AMOUNT))).toEqual({ status: 'pending' });
    await Promise.resolve();
    expect(api.update).toHaveBeenCalledWith(
      TABLE,
      [{ id: R1, version: 1, fields: { [AMOUNT]: 25 } }],
      { typecast: false },
    );
    answer(saved(2, { [AMOUNT]: 25, [STATUS]: 'Mới', computed: 50 }));
    await done;
    expect(controller.isPending(R1, AMOUNT)).toBe(false);
    expect(cache.rows.get(R1)).toMatchObject({ version: 2, fields: { computed: 50 } });
    expect(controller.getSnapshot().cells.size).toBe(0);
    expect(commands).toEqual([
      {
        kind: 'update',
        tableId: TABLE,
        changes: [
          {
            recordId: R1,
            fieldId: AMOUNT,
            before: 10,
            after: 25,
            versionBefore: 1,
            versionAfter: 2,
          },
        ],
      },
    ]);
  });

  it('sends nothing when the value did not change', async () => {
    const { api, controller } = setup();
    await controller.commit({ recordId: R1, fieldId: AMOUNT, value: 10 });
    await controller.commit({
      recordId: R1,
      fieldId: STATUS,
      value: 'Mới',
      display: 'Mới',
    });
    expect(api.update).not.toHaveBeenCalled();
    expect(sameCellValue([{ id: 'u', name: 'A' }], [{ name: 'A', id: 'u' }])).toBe(true);
    expect(sameCellValue(undefined, null)).toBe(true);
  });

  it('writes to one record one after the other, each with the latest version', async () => {
    const { api, controller, cache } = setup();
    api.update
      .mockResolvedValueOnce(saved(2, { [AMOUNT]: 25, [STATUS]: 'Mới' }))
      .mockResolvedValueOnce(saved(3, { [AMOUNT]: 25, [STATUS]: 'Xong' }));
    const first = controller.commit({ recordId: R1, fieldId: AMOUNT, value: 25 });
    const second = controller.commit({ recordId: R1, fieldId: STATUS, value: 'Xong' });
    // While the first write is answered, the second cell keeps its optimistic value.
    await first;
    expect(cache.rows.get(R1)?.fields[STATUS]).toBe('Xong');
    await second;
    expect(api.update.mock.calls.map(([, records]) => records[0]?.version)).toEqual([1, 2]);
    expect(cache.rows.get(R1)?.version).toBe(3);
  });

  it('sends a new select option with typecast and refreshes the fields', async () => {
    const { api, controller, onSchemaTouched } = setup();
    api.update.mockResolvedValue(saved(2, { [STATUS]: 'Mới lạ' }));
    await controller.commit({ recordId: R1, fieldId: STATUS, value: 'Mới lạ', typecast: true });
    expect(api.update.mock.calls[0]?.[2]).toEqual({ typecast: true });
    expect(onSchemaTouched).toHaveBeenCalledOnce();
  });

  it('409 VERSION_CONFLICT: shows the server value, who wrote it, and writes mine on demand', async () => {
    const { api, controller, cache, notify } = setup();
    api.update.mockRejectedValueOnce(
      problem(409, 'VERSION_CONFLICT', [
        {
          path: 'records[0].version',
          code: 'VERSION_CONFLICT',
          message: 'changed',
          params: {
            current_version: 2,
            updated_at: NOW,
            updated_by: { id: 'usr_0123456789ABCDEF', name: 'Nguyễn Minh Anh' },
          },
        },
      ]),
    );
    api.get.mockResolvedValue(record(R1, 2, { [AMOUNT]: 99, [STATUS]: 'Mới' }));
    await controller.commit({ recordId: R1, fieldId: AMOUNT, value: 25 });
    expect(api.get).toHaveBeenCalledWith(TABLE, R1);
    expect(cache.rows.get(R1)?.fields[AMOUNT]).toBe(99);
    expect(controller.getSnapshot().cells.size).toBe(0);
    const notice = notify.conflict.mock.calls[0]?.[0];
    expect(notice).toMatchObject({
      recordId: R1,
      fieldId: AMOUNT,
      mine: 25,
      theirs: 99,
      updatedBy: { name: 'Nguyễn Minh Anh' },
    });

    api.update.mockResolvedValueOnce(saved(3, { [AMOUNT]: 25 }));
    notice?.writeMine();
    await vi.waitFor(() => {
      expect(cache.rows.get(R1)?.version).toBe(3);
    });
    expect(api.update.mock.calls[1]?.[1]).toEqual([
      { id: R1, version: 2, fields: { [AMOUNT]: 25 } },
    ]);
  });

  it('422: rolls back and marks the cell with the detail code', async () => {
    const { api, controller, cache } = setup();
    api.update.mockRejectedValue(
      problem(422, 'INVALID_CELL_VALUE', [
        { path: `records[0].fields.${AMOUNT}`, code: 'EXPECTED_NUMBER', message: 'x' },
      ]),
    );
    await controller.commit({ recordId: R1, fieldId: AMOUNT, value: 'x' });
    expect(cache.rows.get(R1)?.fields[AMOUNT]).toBe(10);
    expect(controller.getSnapshot().cells.get(cellKey(R1, AMOUNT))).toEqual({
      status: 'error',
      error: { code: 'EXPECTED_NUMBER', message: 'x' },
    });
    // The next valid edit clears the mark.
    api.update.mockResolvedValue(saved(2, { [AMOUNT]: 11 }));
    await controller.commit({ recordId: R1, fieldId: AMOUNT, value: 11 });
    expect(controller.getSnapshot().cells.size).toBe(0);
  });

  it('403: rolls back and explains (field read-only, record rule)', async () => {
    const { api, controller, cache, notify } = setup();
    const error = problem(403, 'RECORD_RULE_VIOLATION');
    api.update.mockRejectedValue(error);
    await controller.commit({ recordId: R1, fieldId: STATUS, value: 'Xong' });
    expect(cache.rows.get(R1)?.fields[STATUS]).toBe('Mới');
    expect(notify.denied).toHaveBeenCalledWith(error);
    expect(controller.getSnapshot().cells.size).toBe(0);
  });

  it('404: the row goes', async () => {
    const { api, controller, cache, notify } = setup();
    api.update.mockRejectedValue(problem(404, 'NOT_FOUND'));
    await controller.commit({ recordId: R1, fieldId: AMOUNT, value: 1 });
    expect(cache.removed).toEqual([[R1]]);
    expect(notify.notFound).toHaveBeenCalledOnce();
  });

  it('a write the user can no longer read afterwards drops the row', async () => {
    const { api, controller, cache, commands } = setup();
    api.update.mockResolvedValue({ records: [] });
    await controller.commit({ recordId: R1, fieldId: AMOUNT, value: 1 });
    expect(cache.removed).toEqual([[R1]]);
    expect(commands).toEqual([]);
  });

  it('network trouble: stays pending through 3 retries (1 s, 3 s, 10 s), then rolls back', async () => {
    const { api, controller, cache, notify, waits } = setup();
    api.update.mockRejectedValue(problem(0, 'NETWORK_ERROR'));
    await controller.commit({ recordId: R1, fieldId: AMOUNT, value: 5 });
    expect(api.update).toHaveBeenCalledTimes(4);
    expect(waits).toEqual([...NETWORK_RETRY_DELAYS_MS]);
    expect(cache.rows.get(R1)?.fields[AMOUNT]).toBe(10);
    const retry = notify.failed.mock.calls[0]?.[1];
    expect(retry).toBeTypeOf('function');

    api.update.mockReset();
    api.update.mockResolvedValue(saved(2, { [AMOUNT]: 5 }));
    retry?.();
    await vi.waitFor(() => {
      expect(cache.rows.get(R1)?.fields[AMOUNT]).toBe(5);
    });
  });

  it('a retry that succeeds settles the cell', async () => {
    const { api, controller, cache } = setup();
    api.update
      .mockRejectedValueOnce(problem(503, 'DEPENDENCY_UNAVAILABLE'))
      .mockResolvedValueOnce(saved(2, { [AMOUNT]: 5 }));
    await controller.commit({ recordId: R1, fieldId: AMOUNT, value: 5 });
    expect(cache.rows.get(R1)?.version).toBe(2);
    expect(controller.getSnapshot().cells.size).toBe(0);
  });

  it('409 SCHEMA_LOCKED: rolls back, locks editing and retries after 5 s', async () => {
    const { api, controller, cache, waits } = setup();
    api.update
      .mockRejectedValueOnce(problem(409, 'SCHEMA_LOCKED'))
      .mockResolvedValueOnce(saved(2, { [AMOUNT]: 5 }));
    await controller.commit({ recordId: R1, fieldId: AMOUNT, value: 5 });
    expect(controller.getSnapshot().schemaLocked).toBe(true);
    expect(waits).toEqual([SCHEMA_LOCK_RETRY_MS]);
    await vi.waitFor(() => {
      expect(cache.rows.get(R1)?.version).toBe(2);
    });
    // A write that went through opens editing again.
    expect(controller.getSnapshot().schemaLocked).toBe(false);
  });

  it('SCHEMA_LOCKED gives up after 3 retries and stays locked until unlock()', async () => {
    const { api, controller } = setup();
    api.update.mockRejectedValue(problem(409, 'SCHEMA_LOCKED'));
    await controller.commit({ recordId: R1, fieldId: AMOUNT, value: 5 });
    await vi.waitFor(() => {
      expect(api.update).toHaveBeenCalledTimes(4);
    });
    expect(controller.getSnapshot().schemaLocked).toBe(true);
    controller.unlock();
    expect(controller.getSnapshot().schemaLocked).toBe(false);
  });

  it('a detached controller ignores late answers', async () => {
    const { api, controller, cache } = setup();
    let answer: (value: { records: RecordDto[] }) => void = () => undefined;
    api.update.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const done = controller.commit({ recordId: R1, fieldId: AMOUNT, value: 5 });
    await Promise.resolve();
    controller.detach();
    answer(saved(2, { [AMOUNT]: 5 }));
    await done;
    expect(cache.rows.get(R1)?.version).toBe(1);
  });

  it('marks and clears client-side invalid values', () => {
    const { controller } = setup();
    controller.markInvalid(R1, AMOUNT, { code: 'EXPECTED_NUMBER' });
    expect(controller.getSnapshot().cells.get(cellKey(R1, AMOUNT))?.status).toBe('error');
    controller.clearError(R1, AMOUNT);
    expect(controller.getSnapshot().cells.size).toBe(0);
  });

  it('creates an empty record at the end and emits a create command', async () => {
    const { api, controller, cache, commands } = setup();
    api.create.mockResolvedValue({ records: [record(R2, 1, {})] });
    const created = await controller.create();
    const [table, input, options] = api.create.mock.calls[0] ?? [];
    expect([table, input]).toEqual([TABLE, [{ fields: {} }]]);
    expect(options?.idempotencyKey).toMatch(/^web-/u);
    expect(created).toEqual({ record: record(R2, 1, {}), row: 1 });
    expect(cache.appended).toHaveLength(1);
    expect(commands).toEqual([{ kind: 'create', tableId: TABLE, recordIds: [R2] }]);
  });

  it('a refused creation is explained (403) and nothing is added', async () => {
    const { api, controller, notify, cache } = setup();
    api.create.mockRejectedValue(problem(403, 'RECORD_RULE_VIOLATION'));
    expect(await controller.create()).toBeNull();
    expect(notify.denied).toHaveBeenCalledOnce();
    expect(cache.appended).toEqual([]);
  });

  it('deletes records in chunks of 1 000 and emits a delete command', async () => {
    const { api, controller, cache, commands } = setup();
    const ids = Array.from(
      { length: 1500 },
      (_, index) => `rec_${String(index).padStart(16, '0')}`,
    );
    api.remove.mockImplementation((_table, chunk) =>
      Promise.resolve({ ids: [...chunk] as RecordDto['id'][] }),
    );
    expect(await controller.remove(ids)).toBe(1500);
    expect(api.remove.mock.calls.map(([, chunk]) => chunk.length)).toEqual([1000, 500]);
    expect(cache.removed).toEqual([ids]);
    expect(commands).toEqual([{ kind: 'delete', tableId: TABLE, recordIds: ids, versions: {} }]);
  });

  it('a refused deletion is explained and removes nothing', async () => {
    const { api, controller, notify, cache } = setup();
    api.remove.mockRejectedValue(problem(403, 'PERMISSION_DENIED'));
    expect(await controller.remove([R1])).toBe(0);
    expect(notify.denied).toHaveBeenCalledOnce();
    expect(cache.removed).toEqual([]);
  });
});

describe('versions under realtime (T204)', () => {
  it.each([
    {
      name: 'no editor version: the cached one',
      cached: 3,
      base: undefined,
      own: undefined,
      sent: 3,
    },
    { name: 'cache as the editor saw it', cached: 3, base: 3, own: undefined, sent: 3 },
    {
      name: 'changed elsewhere while editing: the version seen',
      cached: 4,
      base: 3,
      own: undefined,
      sent: 3,
    },
    {
      name: "newer from the tab's own writes: the cached one",
      cached: 4,
      base: 3,
      own: 4,
      sent: 4,
    },
    {
      name: 'own write, then a change elsewhere: the version seen',
      cached: 5,
      base: 4,
      own: 4,
      sent: 4,
    },
    { name: 'nothing cached', cached: undefined, base: 3, own: undefined, sent: undefined },
  ])('$name', ({ cached, base, own, sent }) => {
    expect(versionToSend(cached, base, own)).toBe(sent);
  });

  it('a change that arrived while the editor was open is a conflict, not an overwrite', async () => {
    const { cache, api, controller, notify } = setup();
    // Realtime brought version 2 (someone else) after the editor opened at version 1.
    cache.replace(record(R1, 2, { [AMOUNT]: 99, [STATUS]: 'Mới' }));
    api.update.mockRejectedValueOnce(problem(409, 'VERSION_CONFLICT'));
    api.get.mockResolvedValue(record(R1, 2, { [AMOUNT]: 99, [STATUS]: 'Mới' }));
    await controller.commit({ recordId: R1, fieldId: AMOUNT, value: 25, baseVersion: 1 });
    expect(api.update.mock.calls[0]?.[1]).toEqual([
      { id: R1, version: 1, fields: { [AMOUNT]: 25 } },
    ]);
    expect(notify.conflict).toHaveBeenCalledTimes(1);
    // "Write mine" goes on top of the fresh version.
    api.update.mockResolvedValueOnce(saved(3, { [AMOUNT]: 25, [STATUS]: 'Mới' }));
    notify.conflict.mock.calls[0]?.[0].writeMine();
    await vi.waitFor(() => {
      expect(api.update).toHaveBeenCalledTimes(2);
    });
    expect(api.update.mock.calls[1]?.[1]).toEqual([
      { id: R1, version: 2, fields: { [AMOUNT]: 25 } },
    ]);
  });

  it("the tab's own earlier write does not make the next edit a conflict", async () => {
    const { api, controller } = setup();
    api.update.mockResolvedValueOnce(saved(2, { [AMOUNT]: 25, [STATUS]: 'Mới' }));
    await controller.commit({ recordId: R1, fieldId: AMOUNT, value: 25, baseVersion: 1 });
    api.update.mockResolvedValueOnce(saved(3, { [AMOUNT]: 25, [STATUS]: 'Xong' }));
    // Opened at version 1 before the first write answered.
    await controller.commit({ recordId: R1, fieldId: STATUS, value: 'Xong', baseVersion: 1 });
    expect(api.update.mock.calls[1]?.[1]).toEqual([
      { id: R1, version: 2, fields: { [STATUS]: 'Xong' } },
    ]);
  });
});
