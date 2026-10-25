import { describe, expect, it } from 'vitest';

import { mergeRecordPatch } from '../../../lib/records/realtime-merge';
import { planRemoval } from '../blocks/realtime-patch';

import type { RecordDto } from '@cellhive/contracts';

const NOW = '2026-09-24T00:00:00.000Z';
const A = 'fld_A000000000000001';
const B = 'fld_B000000000000001';

function record(
  version: number,
  fields: Record<string, unknown> = { [A]: 'a', [B]: 'b' },
): RecordDto {
  return { id: 'rec_R000000000000001', created_at: NOW, updated_at: NOW, version, fields };
}

describe('mergeRecordPatch (FRONTEND §5, CONTRACTS §7)', () => {
  it.each([
    {
      name: 'newer version: merged per field',
      held: 3,
      patch: { fields: { [A]: 'x' }, version: 4, recomputed: false },
      pending: [],
      expected: { version: 4, fields: { [A]: 'x', [B]: 'b' } },
    },
    {
      name: 'same version: already applied (own echo)',
      held: 4,
      patch: { fields: { [A]: 'x' }, version: 4, recomputed: false },
      pending: [],
      expected: null,
    },
    {
      name: 'older version: dropped',
      held: 5,
      patch: { fields: { [A]: 'x' }, version: 4, recomputed: false },
      pending: [],
      expected: null,
    },
    {
      name: 'system recomputation at the same version: applied',
      held: 4,
      patch: { fields: { [B]: 7 }, version: 4, recomputed: true },
      pending: [],
      expected: { version: 4, fields: { [A]: 'a', [B]: 7 } },
    },
    {
      name: 'system recomputation for an older version: dropped',
      held: 5,
      patch: { fields: { [B]: 7 }, version: 4, recomputed: true },
      pending: [],
      expected: null,
    },
    {
      name: 'system recomputation for a newer version: applied',
      held: 3,
      patch: { fields: { [B]: 7 }, version: 4, recomputed: true },
      pending: [],
      expected: { version: 4, fields: { [A]: 'a', [B]: 7 } },
    },
    {
      name: 'pending cell kept, others merged, version kept for the conflict check',
      held: 3,
      patch: { fields: { [A]: 'theirs', [B]: 'y' }, version: 4, recomputed: false },
      pending: [A],
      expected: { version: 3, fields: { [A]: 'a', [B]: 'y' } },
    },
    {
      name: 'only pending cells: nothing changes',
      held: 3,
      patch: { fields: { [A]: 'theirs' }, version: 4, recomputed: false },
      pending: [A],
      expected: null,
    },
    {
      name: 'empty patch with a newer version: version moves on',
      held: 3,
      patch: { fields: {}, version: 4, recomputed: false },
      pending: [],
      expected: { version: 4, fields: { [A]: 'a', [B]: 'b' } },
    },
  ])('$name', ({ held, patch, pending, expected }) => {
    const current = record(held);
    const merged = mergeRecordPatch(current, patch, (_, field) =>
      (pending as readonly string[]).includes(field),
    );
    if (expected === null) expect(merged).toBeNull();
    else expect(merged).toEqual({ ...current, ...expected });
  });

  it('never mutates the cached record', () => {
    const current = record(1);
    const frozen = structuredClone(current);
    mergeRecordPatch(current, { fields: { [A]: 'x' }, version: 2, recomputed: false });
    expect(current).toEqual(frozen);
  });
});

function rows(from: number, count: number): RecordDto[] {
  return Array.from({ length: count }, (_, item) => ({
    ...record(1, {}),
    id: `rec_${String(from + item).padStart(16, '0')}`,
  }));
}

function ids(block: readonly RecordDto[] | undefined): number[] {
  return (block ?? []).map((item) => Number(item.id.slice(4)));
}

const BLOCK = 4;

describe('planRemoval', () => {
  it.each([
    {
      name: 'nothing loaded matches',
      loaded: [{ index: 0, records: rows(0, 4) }],
      remove: [9],
      expected: { removed: 0, staleFrom: null, blocks: {} },
    },
    {
      name: 'inside the short last block: no refetch',
      loaded: [
        { index: 0, records: rows(0, 4) },
        { index: 1, records: rows(4, 2) },
      ],
      remove: [4],
      expected: { removed: 1, staleFrom: null, blocks: { 1: [5] } },
    },
    {
      name: 'rows move up across consecutive blocks; the last one is refetched',
      loaded: [
        { index: 0, records: rows(0, 4) },
        { index: 1, records: rows(4, 4) },
      ],
      remove: [1],
      expected: { removed: 1, staleFrom: 1, blocks: { 0: [0, 2, 3, 4], 1: [5, 6, 7] } },
    },
    {
      name: 'a gap ends the run; later loaded blocks are refetched too',
      loaded: [
        { index: 0, records: rows(0, 4) },
        { index: 2, records: rows(8, 4) },
      ],
      remove: [0, 9],
      expected: { removed: 2, staleFrom: 0, blocks: { 0: [1, 2, 3] } },
    },
    {
      name: 'the run starts at the first block holding a removed record',
      loaded: [
        { index: 3, records: rows(12, 4) },
        { index: 4, records: rows(16, 4) },
        { index: 5, records: rows(20, 1) },
      ],
      remove: [17, 20],
      expected: { removed: 2, staleFrom: null, blocks: { 4: [16, 18, 19], 5: [] } },
    },
  ])('$name', ({ loaded, remove, expected }) => {
    const plan = planRemoval(
      loaded,
      new Set(remove.map((row) => `rec_${String(row).padStart(16, '0')}`)),
      BLOCK,
    );
    expect(plan.removed).toBe(expected.removed);
    expect(plan.staleFrom).toBe(expected.staleFrom);
    expect(
      Object.fromEntries([...plan.blocks].map(([index, block]) => [index, ids(block)])),
    ).toEqual(expected.blocks);
  });
});
