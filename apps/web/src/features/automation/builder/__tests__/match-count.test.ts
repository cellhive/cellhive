import { describe, expect, it } from 'vitest';

import { countableFilter } from '../model/match-count';

const STATUS = 'fld_Status0000000001';
const PRIORITY = 'fld_Priority00000001';
const isNew = { field: STATUS, operator: 'is', value: 'opt_NewAAAAAAAAAAAAA' };
const isUrgent = { field: PRIORITY, operator: 'is', value: 'opt_UrgentAAAAAAAAAA' };
const changedTo = { field: PRIORITY, operator: 'changed_to', value: 'opt_UrgentAAAAAAAAAA' };
const changed = { field: STATUS, operator: 'changed' };

describe('countableFilter (T1012: what "N records match now" counts)', () => {
  it.each([
    ['no condition', null, null],
    ['the empty condition of record.matches', {}, null],
    ['one condition', { op: 'and', items: [isNew] }, { op: 'and', items: [isNew] }],
    [
      'and, or: kept as they are',
      { op: 'or', items: [isNew, { op: 'and', items: [isUrgent, isNew] }] },
      { op: 'or', items: [isNew, { op: 'and', items: [isUrgent, isNew] }] },
    ],
    ['only changed_to', { op: 'and', items: [changedTo] }, null],
    ['only changed* conditions', { op: 'and', items: [changedTo, changed] }, null],
    [
      'and: changed* counts as true, the rest is counted',
      { op: 'and', items: [changedTo, isNew] },
      { op: 'and', items: [isNew] },
    ],
    [
      'or with a changed*: true whatever the records',
      { op: 'or', items: [changedTo, isNew] },
      null,
    ],
    [
      'a nested or with a changed* drops out of its and',
      { op: 'and', items: [isNew, { op: 'or', items: [changed, isUrgent] }] },
      { op: 'and', items: [isNew] },
    ],
    [
      'a nested and of changed* only drops out of its or… which stays true',
      { op: 'or', items: [isNew, { op: 'and', items: [changed] }] },
      null,
    ],
    [
      'not around a changed*: no meaning at rest',
      { op: 'and', items: [isNew, { op: 'not', item: changed }] },
      null,
    ],
    [
      'not around a plain condition is kept',
      { op: 'and', items: [{ op: 'not', item: isUrgent }] },
      { op: 'and', items: [{ op: 'not', item: isUrgent }] },
    ],
    ['something else', { op: 'and', items: [42] }, null],
  ])('%s', (_, filter, expected) => {
    expect(countableFilter(filter)).toEqual(expected);
  });
});
