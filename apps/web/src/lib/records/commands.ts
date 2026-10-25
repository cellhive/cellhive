import { MAX_RECORDS_PER_REQUEST } from '@cellhive/contracts';

/**
 * Record changes as undoable commands (FRONTEND §6.1). The edit flow emits
 * one command per successful write request; the undo stack (T205,
 * `grid/commands.ts`) keeps them per table and replays their inverse:
 * - `update`: `PATCH` with `before` and `version = versionAfter` (`409` →
 *   the command is dropped, the cell changed since);
 * - `create`: soft delete of the created records;
 * - `delete`: `restore` of the deleted records.
 */

/**
 * One cell of an update. Values are in the json read shape, as the cell
 * shows them (CONTRACTS §2); `toWriteValue` gives the shape to send.
 */
export interface CellChange {
  readonly recordId: string;
  readonly fieldId: string;
  readonly before: unknown;
  readonly after: unknown;
  /**
   * `version` of the record before this write, when known. Undoing a
   * command brings the record back to that state, so older commands that
   * expect this version may use the new one (see `UndoHistory.rebase`).
   */
  readonly versionBefore?: number;
  /** `version` of the record after this write (the undo sends it back). */
  readonly versionAfter: number;
}

export interface UpdateCommand {
  readonly kind: 'update';
  readonly tableId: string;
  readonly changes: readonly CellChange[];
}

export interface CreateCommand {
  readonly kind: 'create';
  readonly tableId: string;
  readonly recordIds: readonly string[];
}

export interface DeleteCommand {
  readonly kind: 'delete';
  readonly tableId: string;
  readonly recordIds: readonly string[];
  /** `version` of each record before it was deleted, when known (restoring rebases on it). */
  readonly versions?: Readonly<Record<string, number>>;
}

export type EditCommand = UpdateCommand | CreateCommand | DeleteCommand;

/** Receives every command (T205 pushes it on the undo stack). */
export type CommandSink = (command: EditCommand) => void;

/**
 * Splits writes into requests of at most `max` records (CONTRACTS §6
 * `PAYLOAD_TOO_LARGE`), keeping every cell of a record in one request and
 * the records in first-seen order.
 */
export function chunkByRecord<T extends { readonly recordId: string }>(
  writes: readonly T[],
  max: number = MAX_RECORDS_PER_REQUEST,
): T[][] {
  const byRecord = new Map<string, T[]>();
  for (const write of writes) {
    const cells = byRecord.get(write.recordId);
    if (cells === undefined) byRecord.set(write.recordId, [write]);
    else cells.push(write);
  }
  const chunks: T[][] = [];
  let chunk: T[] = [];
  let records = 0;
  for (const cells of byRecord.values()) {
    if (records === max) {
      chunks.push(chunk);
      chunk = [];
      records = 0;
    }
    chunk.push(...cells);
    records += 1;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A json read value (CONTRACTS §2) in the write shape: users and linked
 * records (`[{ id, name, … }]`) are written as `[{ id }]`; other values are
 * written as they are read.
 */
export function toWriteValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (Array.isArray(value) && value.length > 0 && value.every(isObject)) {
    return value.map((item) => (typeof item['id'] === 'string' ? { id: item['id'] } : item));
  }
  return value;
}
