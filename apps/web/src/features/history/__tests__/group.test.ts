import { describe, expect, it } from 'vitest';

import { canRevert, groupHistory } from '../group';

import type { RecordHistoryEntry } from '@cellhive/contracts';

const USER = { type: 'user', id: 'usr_An00000000000001', name: 'An' } as const;

function entry(
  id: string,
  changes: RecordHistoryEntry['changes'],
  extra: Partial<RecordHistoryEntry> = {},
): RecordHistoryEntry {
  return {
    id: `aud_${id.padStart(16, '0')}`,
    action: 'record.updated',
    created_at: '2026-09-24T00:00:00.000Z',
    actor: USER,
    via: null,
    batch: null,
    changes,
    ...extra,
  };
}

const batch = (id: string, size = 3) => ({ id, size });

describe('groupHistory', () => {
  it.each([
    {
      name: 'entries without a batch stay apart',
      entries: [entry('1', { a: { from: 1, to: 2 } }), entry('2', { a: { from: 0, to: 1 } })],
      groups: [1, 1],
    },
    {
      name: 'consecutive entries of one batch are one item',
      entries: [
        entry('1', { a: { from: 1, to: 2 } }, { batch: batch('req_1') }),
        entry('2', { b: { from: 'x', to: 'y' } }, { batch: batch('req_1') }),
        entry('3', { a: { from: 0, to: 1 } }, { batch: batch('req_2') }),
      ],
      groups: [2, 1],
    },
    {
      name: 'another actor in the same batch id is another item',
      entries: [
        entry('1', { a: { from: 1, to: 2 } }, { batch: batch('req_1') }),
        entry(
          '2',
          { b: { from: 1, to: 2 } },
          { batch: batch('req_1'), actor: { type: 'system', id: null, name: null } },
        ),
      ],
      groups: [1, 1],
    },
    { name: 'no entries', entries: [], groups: [] },
  ])('$name', ({ entries, groups }) => {
    expect(groupHistory(entries).map((item) => item.entries.length)).toEqual(groups);
  });

  it('merges the changes of an item: the oldest `from`, the newest `to`', () => {
    const [item] = groupHistory([
      entry('2', { a: { from: 2, to: 3 }, b: { from: null, to: 'x' } }, { batch: batch('req_1') }),
      entry('1', { a: { from: 1, to: 2 } }, { batch: batch('req_1') }),
    ]);
    expect(item?.key).toBe('aud_0000000000000002');
    expect(item?.changes).toEqual([
      { fieldId: 'a', from: 1, to: 3 },
      { fieldId: 'b', from: null, to: 'x' },
    ]);
  });
});

describe('canRevert', () => {
  const editable = (fieldId: string) => fieldId !== 'locked';
  it.each([
    {
      name: 'an update of editable fields',
      entries: [entry('1', { a: { from: 1, to: 2 } })],
      ok: true,
    },
    {
      name: 'a field the user may not edit',
      entries: [entry('1', { a: { from: 1, to: 2 }, locked: { from: 1, to: 2 } })],
      ok: false,
    },
    {
      name: 'a creation',
      entries: [entry('1', { a: { from: null, to: 2 } }, { action: 'record.created' })],
      ok: false,
    },
    { name: 'a deletion', entries: [entry('1', {}, { action: 'record.deleted' })], ok: false },
    {
      name: 'an item of two entries (a revert names one entry)',
      entries: [
        entry('2', { a: { from: 2, to: 3 } }, { batch: batch('req_1') }),
        entry('1', { a: { from: 1, to: 2 } }, { batch: batch('req_1') }),
      ],
      ok: false,
    },
  ])('$name → $ok', ({ entries, ok }) => {
    const [item] = groupHistory(entries);
    expect(item === undefined ? false : canRevert(item, editable)).toBe(ok);
  });
});
