import { MAX_RECORDS_PER_REQUEST, type RecordDto } from '@cellhive/contracts';

import { isApiError, type ApiError } from '../api/client';

import {
  chunkByRecord,
  type CellChange,
  type CommandSink,
  type DeleteCommand,
  type UpdateCommand,
} from './commands';
import {
  cellKey,
  editReducer,
  INITIAL_EDIT_STATE,
  type CellStatus,
  type EditAction,
  type EditState,
} from './edit-state';
import { registerPendingCells } from './realtime-merge';
import {
  bulkCellErrors,
  classifyWriteError,
  type CellErrorDetail,
  type ConflictAuthor,
} from './write-errors';

import type { recordsApi } from '../api/records';

/**
 * The rows a screen shows (grid blocks, record panel): the edit flow writes
 * optimistic values into it and puts the server's answer back.
 */
export interface RecordCache {
  get: (recordId: string) => RecordDto | undefined;
  /** Sets some cells of a record (optimistic value, rollback). */
  patch: (recordId: string, fields: Readonly<Record<string, unknown>>) => void;
  /** Puts the record as the server returned it (new `version`, computed values). */
  replace: (record: RecordDto) => void;
  /** A created record, shown at the end; returns its row, or `null` when not shown. */
  append: (record: RecordDto) => number | null;
  /**
   * Records that were deleted or left what the user may read: their rows
   * go. An empty list reloads what is shown (rows created or restored whose
   * place is up to the server).
   */
  remove: (recordIds: readonly string[]) => void;
  /** Several `patch`es in one pass (bulk writes); without it `patch` runs per record. */
  patchMany?: (patches: ReadonlyMap<string, Readonly<Record<string, unknown>>>) => void;
  /** Several `replace`s in one pass (bulk writes); without it `replace` runs per record. */
  replaceMany?: (records: readonly RecordDto[]) => void;
  /** Several created records at once (`createRecords`); without it `append` runs per record. */
  appendMany?: (records: readonly RecordDto[]) => void;
}

export type RecordWriteApi = Pick<
  typeof recordsApi,
  'update' | 'get' | 'create' | 'remove' | 'restore'
>;

/** A `409 VERSION_CONFLICT` to explain (FRONTEND §4.1): who wrote what, and the user's value. */
export interface ConflictNotice {
  readonly recordId: string;
  readonly fieldId: string;
  /** The user's value (json read shape), kept for "Write my value". */
  readonly mine: unknown;
  /** The value now on the server. */
  readonly theirs: unknown;
  readonly updatedBy: ConflictAuthor | null;
  readonly updatedAt: string | null;
  /** Writes the user's value again on top of the current version. */
  readonly writeMine: () => void;
}

/** How the screen tells the user about writes that did not go through. */
export interface EditNotifier {
  readonly conflict: (notice: ConflictNotice) => void;
  /** `403`: the role may not make this change. */
  readonly denied: (error: ApiError) => void;
  /** `404`: the record was deleted or is out of reach. */
  readonly notFound: () => void;
  /** Anything else, after the retries; `retry` writes again. */
  readonly failed: (error: unknown, retry: (() => void) | null) => void;
}

/** A cell write: `value` in the json write shape, `display` what the cell shows meanwhile. */
export interface CellWrite {
  readonly recordId: string;
  readonly fieldId: string;
  readonly value: unknown;
  /** Read shape shown optimistically (default: `value`). */
  readonly display?: unknown;
  /** Let the server read the value (a new select option, CONTRACTS §2). */
  readonly typecast?: boolean;
  /**
   * `version` of the record the user edited (when the editor opened). If a
   * change from elsewhere (realtime, T204) made the cached version newer
   * meanwhile, this version is sent, so the server answers `409` instead of
   * the other change being overwritten.
   */
  readonly baseVersion?: number | undefined;
}

/** A cell of a bulk write (`writeCells`). */
export interface BulkCellWrite {
  readonly recordId: string;
  readonly fieldId: string;
  /** Json write shape, or text read by the server with `typecast`. */
  readonly value: unknown;
  /** Read shape shown optimistically (default: `value`). */
  readonly display?: unknown;
  /**
   * The value the cell holds now, for a record that is not on screen (undo
   * of rows scrolled away): the write is sent with `versions` and no
   * optimistic value. Without it such writes are left out.
   */
  readonly before?: unknown;
}

export interface BulkWriteOptions {
  /** Let the server read text values in the base locale (paste, CONTRACTS §2). */
  readonly typecast?: boolean;
  /**
   * The version each record must still have (undo/redo: `versionAfter` of
   * the command); default: the cached version. A mismatch is a conflict.
   */
  readonly versions?: ReadonlyMap<string, number>;
  /** Emit each request as an undo command (default); undo and redo turn it off. */
  readonly emit?: boolean;
  /** Records the cache may not hold (rows just created for a paste). */
  readonly records?: ReadonlyMap<string, RecordDto>;
  /** After each request: records written so far, of all. */
  readonly onProgress?: (done: number, total: number) => void;
}

/** Why a bulk write stopped (the request that failed was rolled back as a whole). */
export type BulkWriteFailure =
  'invalid' | 'conflict' | 'denied' | 'not_found' | 'schema_locked' | 'failed';

export interface BulkWriteResult {
  /** One `update` command per request that went through (none for requests that changed nothing). */
  readonly commands: readonly UpdateCommand[];
  /** `null` when every request went through. */
  readonly failure: BulkWriteFailure | null;
  /** Cells marked in error by a `422`. */
  readonly invalidCells: number;
  /** Why those cells were refused, once per detail code (the paste toast says it, T421a). */
  readonly invalidReasons: readonly CellErrorDetail[];
}

export interface RecordEditOptions {
  readonly tableId: string;
  readonly api: RecordWriteApi;
  readonly cache: RecordCache;
  readonly notify: EditNotifier;
  /** Successful changes as undo commands (FRONTEND §6.1, T205). */
  readonly onCommand?: CommandSink;
  /** A write created select options (`typecast`): the fields are stale. */
  readonly onSchemaTouched?: () => void;
  /** Timer of the retries (tests use fake time). */
  readonly wait?: (ms: number) => Promise<void>;
}

/** Network or server trouble: the write is retried after these delays (FRONTEND §4.1). */
export const NETWORK_RETRY_DELAYS_MS: readonly number[] = [1000, 3000, 10_000];
/** `409 SCHEMA_LOCKED`: retried this often, this long apart. */
export const SCHEMA_LOCK_RETRY_MS = 5000;
export const SCHEMA_LOCK_MAX_RETRIES = 3;

interface Optimistic {
  readonly seq: number;
  readonly recordId: string;
  readonly fieldId: string;
  readonly display: unknown;
}

function canonical(value: unknown): unknown {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

/** Whether two cell values are the same (key order and `undefined` ignored). */
export function sameCellValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/**
 * The `version` a write sends: the cached one (a write queued behind the
 * user's own writes uses the version they returned) — unless the cache got a
 * newer version from elsewhere (realtime) after the editor opened at
 * `baseVersion`; then `baseVersion`, so the server reports the conflict.
 */
export function versionToSend(
  cached: number | undefined,
  baseVersion: number | undefined,
  own: number | undefined,
): number | undefined {
  if (cached === undefined || baseVersion === undefined || cached <= baseVersion) return cached;
  // Newer than what the user saw: fine when this tab's own writes made it so.
  return own !== undefined && own >= cached ? cached : baseVersion;
}

const defaultWait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

function idempotencyKey(): string {
  return `web-${crypto.randomUUID()}`;
}

/**
 * The record edit flow of FRONTEND §4.1, shared by the grid and the record
 * panel: optimistic value with a `pending` cell, `PATCH` with the record's
 * `version`, the record from the answer put back, and every error of the
 * §4.1 table handled. Writes to one record go one after the other, each
 * with the version the previous one returned; writes to different records
 * run in parallel. The cell states are an external store for
 * `useSyncExternalStore`.
 */
export class RecordEditController {
  readonly #options: RecordEditOptions;
  readonly #wait: (ms: number) => Promise<void>;
  readonly #listeners = new Set<() => void>();
  readonly #chains = new Map<string, Promise<void>>();
  readonly #optimistic = new Map<string, Optimistic>();
  #unregisterPending: (() => void) | null = null;
  /** Last version each record got from this controller's own writes. */
  readonly #ownVersions = new Map<string, number>();
  #state: EditState = INITIAL_EDIT_STATE;
  #seq = 0;
  #disposed = false;

  constructor(options: RecordEditOptions) {
    this.#options = options;
    this.#wait = options.wait ?? defaultWait;
  }

  // --- external store ------------------------------------------------------------

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getSnapshot = (): EditState => this.#state;

  /** The screen shows the records (again): answers are applied. */
  attach(): void {
    this.#disposed = false;
    // Realtime patches leave this flow's pending cells alone (FRONTEND §5).
    this.#unregisterPending ??= registerPendingCells(this.#options.tableId, (recordId, fieldId) =>
      this.isPending(recordId, fieldId),
    );
  }

  /** The screen is gone: late answers and pending retries are ignored. */
  detach(): void {
    this.#disposed = true;
    this.#unregisterPending?.();
    this.#unregisterPending = null;
  }

  #isDetached(): boolean {
    return this.#disposed;
  }

  /**
   * Whether the screen of this controller is still shown (writes are
   * applied). Work that outlives it (an upload finishing after the record
   * panel closed, T418) writes another way.
   */
  get attached(): boolean {
    return !this.#disposed;
  }

  // --- cells ---------------------------------------------------------------------

  /** Writes one cell (FRONTEND §4.1 steps 2–5); resolves once the write is settled. */
  commit(write: CellWrite): Promise<void> {
    return this.#commit(write, 0);
  }

  /**
   * Whether a cell has a write in flight (optimistic value shown). Realtime
   * patches (T204, FRONTEND §5) must not overwrite such a cell until the
   * write settles; the answer of the write puts the server value back.
   */
  isPending(recordId: string, fieldId: string): boolean {
    return this.#optimistic.has(cellKey(recordId, fieldId));
  }

  /** A value the editor could not read (click outside with an invalid draft): mark the cell. */
  markInvalid(recordId: string, fieldId: string, error: CellErrorDetail): void {
    this.#dispatch({ type: 'failed', key: cellKey(recordId, fieldId), error });
  }

  clearError(recordId: string, fieldId: string): void {
    this.#dispatch({ type: 'clearError', key: cellKey(recordId, fieldId) });
  }

  /** The schema changed (`schema.changed`) or the user asked: editing is open again. */
  unlock(): void {
    this.#dispatch({ type: 'schemaLocked', locked: false });
  }

  // --- records -------------------------------------------------------------------

  /**
   * Adds a record (defaults apply on the server) and shows it at the end.
   * `fields` (write shape) are set on creation: the group values of a
   * grouped grid (T312).
   */
  async create(
    fields: Readonly<Record<string, unknown>> = {},
  ): Promise<{ record: RecordDto; row: number | null } | null> {
    const { api, tableId, cache } = this.#options;
    try {
      const response = await api.create(tableId, [{ fields: { ...fields } }], {
        idempotencyKey: idempotencyKey(),
      });
      if (this.#isDetached()) return null;
      const record = response.records[0];
      if (record === undefined) {
        // Created, but outside what the user may read: reload what is shown.
        cache.remove([]);
        return null;
      }
      const row = cache.append(record);
      this.#options.onCommand?.({ kind: 'create', tableId, recordIds: [record.id] });
      return { record, row };
    } catch (error) {
      this.#report(error);
      return null;
    }
  }

  /**
   * Moves records to the trash (soft delete, CONTRACTS §1.4); returns how
   * many. `emit: false` (undo of a creation) emits no command.
   */
  async remove(recordIds: readonly string[], options: { emit?: boolean } = {}): Promise<number> {
    return (await this.removeRecords(recordIds, options))?.recordIds.length ?? 0;
  }

  /**
   * `remove` answering the `delete` command of what went to the trash (ids
   * and versions before), or `null` when a request failed.
   */
  async removeRecords(
    recordIds: readonly string[],
    options: { emit?: boolean } = {},
  ): Promise<DeleteCommand | null> {
    const { api, tableId, cache } = this.#options;
    if (recordIds.length === 0) return { kind: 'delete', tableId, recordIds: [] };
    // Versions before the deletion: restoring it (undo) rebases older commands on them.
    const known = new Map<string, number>();
    for (const id of recordIds) {
      const version = cache.get(id)?.version;
      if (version !== undefined) known.set(id, version);
    }
    try {
      const ids: string[] = [];
      // At most 1 000 ids per request (CONTRACTS §6 `PAYLOAD_TOO_LARGE`).
      for (let start = 0; start < recordIds.length; start += MAX_RECORDS_PER_REQUEST) {
        const chunk = recordIds.slice(start, start + MAX_RECORDS_PER_REQUEST);
        ids.push(...(await api.remove(tableId, chunk)).ids);
      }
      if (this.#isDetached()) return null;
      cache.remove(ids);
      this.#dispatch({ type: 'dropRecords', recordIds: ids });
      const versions: Record<string, number> = {};
      for (const id of ids) {
        const version = known.get(id);
        if (version !== undefined) versions[id] = version;
      }
      const command: DeleteCommand = { kind: 'delete', tableId, recordIds: ids, versions };
      if (ids.length > 0 && options.emit !== false) this.#options.onCommand?.(command);
      return command;
    } catch (error) {
      this.#report(error);
      return null;
    }
  }

  /**
   * Brings records back from the trash (undo of a deletion); answers the
   * restored records, or `null` when a request failed. The rows reload:
   * their place is up to the server.
   */
  async restore(
    recordIds: readonly string[],
    options: { emit?: boolean } = {},
  ): Promise<RecordDto[] | null> {
    const { api, tableId, cache } = this.#options;
    if (recordIds.length === 0) return [];
    try {
      const records: RecordDto[] = [];
      for (let start = 0; start < recordIds.length; start += MAX_RECORDS_PER_REQUEST) {
        const chunk = recordIds.slice(start, start + MAX_RECORDS_PER_REQUEST);
        const response = await api.restore(tableId, chunk, { idempotencyKey: idempotencyKey() });
        records.push(...response.records);
      }
      if (this.#isDetached()) return null;
      cache.remove([]);
      if (records.length > 0 && options.emit !== false) {
        this.#options.onCommand?.({
          kind: 'create',
          tableId,
          recordIds: records.map((record) => record.id),
        });
      }
      return records;
    } catch (error) {
      this.#report(error);
      return null;
    }
  }

  /**
   * Adds `count` empty records (a paste beyond the last row, FRONTEND §4.2),
   * at most 1 000 per request, each request one `create` command. Answers
   * the created records the user can read, or `null` when a request failed
   * (the records of earlier requests stay, with their commands).
   */
  async createRecords(count: number): Promise<RecordDto[] | null> {
    const { api, tableId, cache } = this.#options;
    const created: RecordDto[] = [];
    try {
      for (let start = 0; start < count; start += MAX_RECORDS_PER_REQUEST) {
        const size = Math.min(MAX_RECORDS_PER_REQUEST, count - start);
        const response = await api.create(
          tableId,
          Array.from({ length: size }, () => ({ fields: {} })),
          { idempotencyKey: idempotencyKey() },
        );
        if (this.#isDetached()) return null;
        created.push(...response.records);
        if (response.records.length > 0) {
          this.#options.onCommand?.({
            kind: 'create',
            tableId,
            recordIds: response.records.map((record) => record.id),
          });
        }
      }
    } catch (error) {
      this.#report(error);
      if (created.length > 0) cache.remove([]);
      return null;
    }
    // Many records at once when the cache can (appending each would redraw,
    // or reload a sorted grid, once per record).
    if (cache.appendMany !== undefined) cache.appendMany(created);
    else for (const record of created) cache.append(record);
    return created;
  }

  /**
   * Writes many cells (paste, fill, clear, undo — FRONTEND §4.2): one bulk
   * `PATCH` per at most 1 000 records, sent one after the other. Each
   * request writes its cells optimistically (`pending`: the same contract as
   * `commit`, `isPending` is true until it settles) and becomes one `update`
   * command. A refused request is rolled back as a whole, like the server's
   * transaction: `422` marks the cells named by `errors[].path`, and the
   * requests after it are not sent.
   */
  async writeCells(
    writes: readonly BulkCellWrite[],
    options: BulkWriteOptions = {},
  ): Promise<BulkWriteResult> {
    const commands: UpdateCommand[] = [];
    const total = new Set(writes.map((write) => write.recordId)).size;
    let done = 0;
    let wrote = false;
    let failure: BulkWriteResult['failure'] = null;
    let invalidCells = 0;
    let invalidReasons: readonly CellErrorDetail[] = [];
    for (const chunk of chunkByRecord(writes)) {
      if (this.#isDetached()) break;
      const outcome = await this.#writeChunk(chunk, options);
      if (outcome.kind === 'failed') {
        failure = outcome.failure;
        invalidCells = outcome.invalidCells;
        invalidReasons = outcome.invalidReasons;
        break;
      }
      wrote = true;
      if (outcome.command !== null) commands.push(outcome.command);
      done += new Set(chunk.map((write) => write.recordId)).size;
      options.onProgress?.(done, total);
    }
    if (wrote && options.typecast === true) this.#options.onSchemaTouched?.();
    return { commands, failure, invalidCells, invalidReasons };
  }

  // --- internals -----------------------------------------------------------------

  #dispatch(action: EditAction): void {
    const next = editReducer(this.#state, action);
    if (next === this.#state) return;
    this.#state = next;
    for (const listener of this.#listeners) listener();
  }

  #commit(write: CellWrite, lockAttempt: number): Promise<void> {
    const { cache } = this.#options;
    const record = cache.get(write.recordId);
    if (record === undefined || this.#isDetached()) return Promise.resolve();
    const key = cellKey(write.recordId, write.fieldId);
    const display = 'display' in write ? write.display : write.value;
    const before = record.fields[write.fieldId] ?? null;
    if (write.typecast !== true && sameCellValue(before, display)) {
      this.#dispatch({ type: 'clearError', key });
      return Promise.resolve();
    }
    const seq = ++this.#seq;
    this.#optimistic.set(key, { seq, recordId: write.recordId, fieldId: write.fieldId, display });
    this.#dispatch({ type: 'pending', key });
    cache.patch(write.recordId, { [write.fieldId]: display });
    return this.#enqueue(write.recordId, () =>
      this.#send({ write, key, seq, before, display, lockAttempt }, 0),
    );
  }

  /** Writes of one bulk request: optimistic cells, then the request after earlier writes of its records. */
  #writeChunk(chunk: readonly BulkCellWrite[], options: BulkWriteOptions): Promise<ChunkOutcome> {
    const { cache } = this.#options;
    const jobs: Job[] = [];
    const cleared: [string, null][] = [];
    const patches = new Map<string, Record<string, unknown>>();
    for (const write of chunk) {
      const record = cache.get(write.recordId) ?? options.records?.get(write.recordId);
      const key = cellKey(write.recordId, write.fieldId);
      const display = 'display' in write ? write.display : write.value;
      if (record === undefined) {
        // Not on screen: sent as it is when the caller knows the current value.
        if (!('before' in write) || options.versions?.has(write.recordId) !== true) continue;
        const seq = ++this.#seq;
        this.#optimistic.set(key, {
          seq,
          recordId: write.recordId,
          fieldId: write.fieldId,
          display,
        });
        jobs.push({ write, key, seq, before: write.before ?? null, display, lockAttempt: 0 });
        if (!patches.has(write.recordId)) patches.set(write.recordId, {});
        continue;
      }
      const before = record.fields[write.fieldId] ?? null;
      if (options.typecast !== true && sameCellValue(before, display)) {
        if (this.#state.cells.get(key)?.status === 'error') cleared.push([key, null]);
        continue;
      }
      const seq = ++this.#seq;
      this.#optimistic.set(key, { seq, recordId: write.recordId, fieldId: write.fieldId, display });
      jobs.push({ write, key, seq, before, display, lockAttempt: 0 });
      const fields = patches.get(write.recordId) ?? {};
      fields[write.fieldId] = display;
      patches.set(write.recordId, fields);
    }
    this.#dispatch({
      type: 'cells',
      updates: [...cleared, ...jobs.map((job) => [job.key, PENDING] as const)],
    });
    if (jobs.length === 0) return Promise.resolve({ kind: 'written', command: null });
    this.#patchMany(patches);
    const recordIds = [...patches.keys()];
    return this.#enqueueMany(recordIds, () => this.#sendChunk(jobs, recordIds, options, 0));
  }

  async #sendChunk(
    jobs: readonly Job[],
    recordIds: readonly string[],
    options: BulkWriteOptions,
    attempt: number,
  ): Promise<ChunkOutcome> {
    const { api, tableId, cache } = this.#options;
    if (this.#isDetached())
      return { kind: 'failed', failure: 'failed', invalidCells: 0, invalidReasons: [] };
    const fieldsOf = new Map<string, Record<string, unknown>>();
    for (const job of jobs) {
      const fields = fieldsOf.get(job.write.recordId) ?? {};
      fields[job.write.fieldId] = job.write.value;
      fieldsOf.set(job.write.recordId, fields);
    }
    const versions = new Map<string, number>();
    const request = recordIds.map((recordId) => {
      const version =
        options.versions?.get(recordId) ??
        cache.get(recordId)?.version ??
        options.records?.get(recordId)?.version;
      if (version !== undefined) versions.set(recordId, version);
      return {
        id: recordId as `rec_${string}`,
        ...(version === undefined ? {} : { version }),
        fields: fieldsOf.get(recordId) ?? {},
      };
    });
    let savedRecords: readonly RecordDto[];
    try {
      savedRecords = (await api.update(tableId, request, { typecast: options.typecast === true }))
        .records;
    } catch (error) {
      return this.#failChunk(jobs, recordIds, options, attempt, error);
    }
    if (this.#isDetached())
      return { kind: 'failed', failure: 'failed', invalidCells: 0, invalidReasons: [] };
    const saved = new Map(savedRecords.map((record) => [record.id as string, record]));
    this.#settleMany(jobs);
    // Written, but no longer readable by the user (CONTRACTS §1.1): those rows go.
    const gone = recordIds.filter((recordId) => !saved.has(recordId));
    if (gone.length > 0) {
      cache.remove(gone);
      this.#dispatch({ type: 'dropRecords', recordIds: gone });
    }
    this.#replaceMany([...saved.values()]);
    const changes = jobs.flatMap((job): CellChange[] => {
      const record = saved.get(job.write.recordId);
      if (record === undefined) return [];
      const before = job.before;
      const after = record.fields[job.write.fieldId] ?? null;
      if (sameCellValue(before, after)) return [];
      const versionBefore = versions.get(job.write.recordId);
      return [
        {
          recordId: job.write.recordId,
          fieldId: job.write.fieldId,
          before,
          after,
          ...(versionBefore === undefined ? {} : { versionBefore }),
          versionAfter: record.version,
        },
      ];
    });
    const command: UpdateCommand | null =
      changes.length === 0 ? null : { kind: 'update', tableId, changes };
    if (command !== null && options.emit !== false) this.#options.onCommand?.(command);
    this.#dispatch({ type: 'schemaLocked', locked: false });
    return { kind: 'written', command };
  }

  async #failChunk(
    jobs: readonly Job[],
    recordIds: readonly string[],
    options: BulkWriteOptions,
    attempt: number,
    error: unknown,
  ): Promise<ChunkOutcome> {
    if (this.#isDetached())
      return { kind: 'failed', failure: 'failed', invalidCells: 0, invalidReasons: [] };
    const { cache, notify } = this.#options;
    const failure = classifyWriteError(error, '');
    const failed = (
      kind: BulkWriteFailure,
      invalidCells = 0,
      invalidReasons: readonly CellErrorDetail[] = [],
    ): ChunkOutcome => ({
      kind: 'failed',
      failure: kind,
      invalidCells,
      invalidReasons,
    });
    if (failure.kind === 'transient') {
      const delay = NETWORK_RETRY_DELAYS_MS[attempt];
      if (delay !== undefined) {
        // The cells stay pending while retrying.
        await this.#wait(delay);
        return this.#sendChunk(jobs, recordIds, options, attempt + 1);
      }
    }
    this.#rollbackMany(jobs);
    switch (failure.kind) {
      case 'conflict':
        // Someone changed a record meanwhile: show the current rows.
        cache.remove([]);
        return failed('conflict');
      case 'cell': {
        const marks: [string, CellStatus][] = [];
        for (const item of bulkCellErrors(failure.error)) {
          const recordId = recordIds[item.index];
          if (recordId === undefined) continue;
          for (const job of jobs) {
            if (job.write.recordId !== recordId) continue;
            if (item.fieldId !== null && job.write.fieldId !== item.fieldId) continue;
            marks.push([job.key, { status: 'error', error: item.detail }]);
          }
        }
        if (marks.length === 0) notify.failed(error, null);
        this.#dispatch({ type: 'cells', updates: marks });
        const reasons = new Map<string, CellErrorDetail>();
        for (const [, status] of marks) {
          if (status.status === 'error' && !reasons.has(status.error.code)) {
            reasons.set(status.error.code, status.error);
          }
        }
        return failed('invalid', new Set(marks.map(([key]) => key)).size, [...reasons.values()]);
      }
      case 'denied':
        notify.denied(failure.error);
        return failed('denied');
      case 'not_found':
        cache.remove([]);
        notify.notFound();
        return failed('not_found');
      case 'schema_locked':
        this.#dispatch({ type: 'schemaLocked', locked: true });
        return failed('schema_locked');
      case 'transient':
      case 'fatal':
        notify.failed(error, null);
        return failed('failed');
    }
  }

  /** Ends the pending state of bulk cells (those no newer write took over). */
  #settleMany(jobs: readonly Job[]): Job[] {
    const settled = jobs.filter((job) => this.#optimistic.get(job.key)?.seq === job.seq);
    for (const job of settled) this.#optimistic.delete(job.key);
    this.#dispatch({ type: 'cells', updates: settled.map((job) => [job.key, null] as const) });
    return settled;
  }

  /** Puts bulk cells back as they were (unless a newer write took over). */
  #rollbackMany(jobs: readonly Job[]): void {
    const patches = new Map<string, Record<string, unknown>>();
    for (const job of this.#settleMany(jobs)) {
      const fields = patches.get(job.write.recordId) ?? {};
      fields[job.write.fieldId] = job.before;
      patches.set(job.write.recordId, fields);
    }
    this.#patchMany(patches);
  }

  #patchMany(patches: ReadonlyMap<string, Readonly<Record<string, unknown>>>): void {
    if (patches.size === 0) return;
    const { cache } = this.#options;
    if (cache.patchMany !== undefined) cache.patchMany(patches);
    else for (const [recordId, fields] of patches) cache.patch(recordId, fields);
  }

  /** Records from the server, keeping the optimistic values still pending. */
  #replaceMany(records: readonly RecordDto[]): void {
    if (records.length === 0) return;
    const { cache } = this.#options;
    if (cache.replaceMany === undefined) {
      for (const record of records) this.#replace(record);
      return;
    }
    const pending = new Map<string, Record<string, unknown>>();
    for (const entry of this.#optimistic.values()) {
      const fields = pending.get(entry.recordId) ?? {};
      fields[entry.fieldId] = entry.display;
      pending.set(entry.recordId, fields);
    }
    cache.replaceMany(
      records.map((record) => {
        const fields = pending.get(record.id);
        return fields === undefined
          ? record
          : { ...record, fields: { ...record.fields, ...fields } };
      }),
    );
  }

  /** Runs `task` after every queued write of these records; later writes wait for it. */
  #enqueueMany<T>(recordIds: readonly string[], task: () => Promise<T>): Promise<T> {
    const previous = Promise.all(
      recordIds.map((recordId) => this.#chains.get(recordId) ?? Promise.resolve()),
    );
    const run = previous.then(task);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    for (const recordId of recordIds) this.#chains.set(recordId, tail);
    void tail.then(() => {
      for (const recordId of recordIds) {
        if (this.#chains.get(recordId) === tail) this.#chains.delete(recordId);
      }
    });
    return run;
  }

  #enqueue(recordId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.#chains.get(recordId) ?? Promise.resolve();
    const run = previous.then(task);
    const tail = run.catch(() => undefined);
    this.#chains.set(recordId, tail);
    void tail.then(() => {
      if (this.#chains.get(recordId) === tail) this.#chains.delete(recordId);
    });
    return run;
  }

  async #send(job: Job, attempt: number): Promise<void> {
    const { api, tableId, cache } = this.#options;
    const { write } = job;
    if (this.#isDetached()) return;
    // The latest version known: a write queued behind another uses the version it returned.
    const version = versionToSend(
      cache.get(write.recordId)?.version,
      write.baseVersion,
      this.#ownVersions.get(write.recordId),
    );
    let saved: RecordDto | undefined;
    try {
      const response = await api.update(
        tableId,
        [
          {
            id: write.recordId as `rec_${string}`,
            ...(version === undefined ? {} : { version }),
            fields: { [write.fieldId]: write.value },
          },
        ],
        { typecast: write.typecast === true },
      );
      saved = response.records.find((item) => item.id === write.recordId);
    } catch (error) {
      await this.#fail(job, attempt, error);
      return;
    }
    if (this.#isDetached()) return;
    this.#settle(job);
    if (saved === undefined) {
      // Written, but no longer readable by the user (CONTRACTS §1.1): the row goes.
      cache.remove([write.recordId]);
      this.#dispatch({ type: 'dropRecords', recordIds: [write.recordId] });
    } else {
      this.#ownVersions.set(write.recordId, saved.version);
      this.#replace(saved);
      this.#options.onCommand?.({
        kind: 'update',
        tableId,
        changes: [
          {
            recordId: write.recordId,
            fieldId: write.fieldId,
            before: job.before,
            after: job.display,
            ...(version === undefined ? {} : { versionBefore: version }),
            versionAfter: saved.version,
          },
        ],
      });
    }
    if (write.typecast === true) this.#options.onSchemaTouched?.();
    this.#dispatch({ type: 'schemaLocked', locked: false });
  }

  async #fail(job: Job, attempt: number, error: unknown): Promise<void> {
    if (this.#isDetached()) return;
    const { write } = job;
    const failure = classifyWriteError(error, write.fieldId);
    const retry = () => {
      void this.commit(write);
    };
    switch (failure.kind) {
      case 'transient': {
        const delay = NETWORK_RETRY_DELAYS_MS[attempt];
        if (delay !== undefined) {
          // The cell stays pending while retrying.
          await this.#wait(delay);
          await this.#send(job, attempt + 1);
          return;
        }
        this.#rollback(job);
        this.#options.notify.failed(error, retry);
        return;
      }
      case 'conflict':
        await this.#conflict(job, failure.updatedBy, failure.updatedAt);
        return;
      case 'cell':
        this.#rollback(job);
        this.#dispatch({ type: 'failed', key: job.key, error: failure.detail });
        return;
      case 'denied':
        this.#rollback(job);
        this.#options.notify.denied(failure.error);
        return;
      case 'not_found':
        this.#gone(job);
        return;
      case 'schema_locked':
        this.#rollback(job);
        this.#dispatch({ type: 'schemaLocked', locked: true });
        if (job.lockAttempt < SCHEMA_LOCK_MAX_RETRIES) {
          // Not awaited: the retry queues behind this write of the record.
          void this.#wait(SCHEMA_LOCK_RETRY_MS).then(() => {
            if (!this.#isDetached()) void this.#commit(write, job.lockAttempt + 1);
          });
        }
        return;
      case 'fatal':
        this.#rollback(job);
        this.#options.notify.failed(error, retry);
        return;
    }
  }

  /** `409 VERSION_CONFLICT`: show the server's value and offer to write again. */
  async #conflict(job: Job, updatedBy: ConflictAuthor | null, updatedAt: string | null) {
    const { api, tableId } = this.#options;
    const { write } = job;
    let fresh: RecordDto;
    try {
      fresh = await api.get(tableId, write.recordId);
    } catch (error) {
      if (this.#isDetached()) return;
      if (isApiError(error) && error.status === 404) {
        this.#gone(job);
        return;
      }
      this.#rollback(job);
      this.#options.notify.failed(error, null);
      return;
    }
    if (this.#isDetached()) return;
    this.#settle(job);
    this.#replace(fresh);
    this.#options.notify.conflict({
      recordId: write.recordId,
      fieldId: write.fieldId,
      mine: job.display,
      theirs: fresh.fields[write.fieldId] ?? null,
      updatedBy,
      updatedAt,
      writeMine: () => {
        // On top of the version just fetched: the user chose to overwrite.
        void this.commit({ ...write, baseVersion: undefined });
      },
    });
  }

  /** The record is gone: drop its row and its cell states. */
  #gone(job: Job): void {
    this.#settle(job);
    this.#options.cache.remove([job.write.recordId]);
    this.#dispatch({ type: 'dropRecords', recordIds: [job.write.recordId] });
    this.#options.notify.notFound();
  }

  /** Ends the pending state of a write, unless a newer write of the cell took over. */
  #settle(job: Job): boolean {
    if (this.#optimistic.get(job.key)?.seq !== job.seq) return false;
    this.#optimistic.delete(job.key);
    this.#dispatch({ type: 'settled', key: job.key });
    return true;
  }

  /** Puts the cell back as it was before the write (unless a newer write took over). */
  #rollback(job: Job): void {
    if (!this.#settle(job)) return;
    this.#options.cache.patch(job.write.recordId, { [job.write.fieldId]: job.before });
  }

  /** Puts a record from the server, keeping the optimistic values still pending. */
  #replace(record: RecordDto): void {
    const pending: Record<string, unknown> = {};
    for (const entry of this.#optimistic.values()) {
      if (entry.recordId === record.id) pending[entry.fieldId] = entry.display;
    }
    this.#options.cache.replace(
      Object.keys(pending).length === 0
        ? record
        : { ...record, fields: { ...record.fields, ...pending } },
    );
  }

  #report(error: unknown): void {
    if (this.#isDetached()) return;
    if (isApiError(error) && error.status === 403) this.#options.notify.denied(error);
    else this.#options.notify.failed(error, null);
  }
}

const PENDING: CellStatus = { status: 'pending' };

type ChunkOutcome =
  | { readonly kind: 'written'; readonly command: UpdateCommand | null }
  | {
      readonly kind: 'failed';
      readonly failure: BulkWriteFailure;
      readonly invalidCells: number;
      readonly invalidReasons: readonly CellErrorDetail[];
    };

interface Job {
  readonly write: CellWrite;
  readonly key: string;
  readonly seq: number;
  readonly before: unknown;
  readonly display: unknown;
  readonly lockAttempt: number;
}
