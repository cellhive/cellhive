import { RECORD_BLOCK_SIZE } from '../../../lib/query/queries';

import type { RecordDto } from '@cellhive/contracts';

/**
 * Removal of rows from the loaded blocks for the realtime client (FRONTEND
 * §5); patches of `record.updated` are `lib/records/realtime-merge.ts`.
 */

export interface BlockRows {
  readonly index: number;
  readonly records: readonly RecordDto[];
}

export interface RemovalPlan {
  /** New rows of the blocks that changed, by block index. */
  readonly blocks: ReadonlyMap<number, readonly RecordDto[]>;
  /** Records found (and removed) in the loaded blocks: the row count drops by this much. */
  readonly removed: number;
  /**
   * First block whose rows are now incomplete or at the wrong offset
   * (refetch it and every block after it); `null` when nothing changed.
   */
  readonly staleFrom: number | null;
}

/**
 * Removes records from the loaded blocks without leaving holes: the rows of
 * the run of consecutive loaded blocks starting at the first block holding
 * one of them move up, so every row keeps showing the right record. The
 * last block of the run then misses its tail rows (they belong to the next,
 * maybe unloaded, block) and the blocks after the run are at old offsets:
 * both are refetched from `staleFrom`.
 */
export function planRemoval(
  loaded: readonly BlockRows[],
  recordIds: ReadonlySet<string>,
  blockSize = RECORD_BLOCK_SIZE,
): RemovalPlan {
  const sorted = [...loaded].sort((a, b) => a.index - b.index);
  const start = sorted.findIndex((block) =>
    block.records.some((record) => recordIds.has(record.id)),
  );
  const first = sorted[start];
  if (first === undefined) return { blocks: new Map(), removed: 0, staleFrom: null };
  const run: BlockRows[] = [first];
  for (let at = start + 1; at < sorted.length; at += 1) {
    const block = sorted[at];
    const previous = run.at(-1);
    if (block === undefined || previous === undefined || block.index !== previous.index + 1) break;
    // A short block ends the table: nothing comes after it.
    if (previous.records.length < blockSize) break;
    run.push(block);
  }
  const rows = run.flatMap((block) => block.records);
  const kept = rows.filter((record) => !recordIds.has(record.id));
  // Also those in loaded blocks after a gap: they go with the refetch.
  const found = new Set(
    sorted.flatMap((block) =>
      block.records.filter((record) => recordIds.has(record.id)).map((record) => record.id),
    ),
  );
  const removed = found.size;
  const blocks = new Map<number, readonly RecordDto[]>();
  run.forEach((block, position) => {
    blocks.set(block.index, kept.slice(position * blockSize, (position + 1) * blockSize));
  });
  const last = run.at(-1) ?? first;
  // The run ended the table (short last block): nothing further is stale.
  const endsTable = last.records.length < blockSize;
  return { blocks, removed, staleFrom: endsTable ? null : last.index };
}
