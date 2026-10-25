/**
 * BACKLOG T544: who a record event assigns — the users a `user` field with
 * `notify_on_assign` gained (storage form, CONTRACTS §8), per user with the
 * fields, the actor left out. Pure functions, table-driven.
 */
import { describe, expect, it } from 'vitest';

import {
  addedUsers,
  assignmentsOf,
  storedUsers,
  type StoredChange,
} from '../../src/notifications/listeners/assigned/assignments.js';

import type { JsonValue } from '../../src/db/schema.js';
import type { Id } from '@cellhive/contracts';

const ANN = 'usr_AssignAnn0000001' as Id<'usr'>;
const BOB = 'usr_AssignBob0000001' as Id<'usr'>;
const CAT = 'usr_AssignCat0000001' as Id<'usr'>;
const OWNER = 'fld_AssignOwner00001' as Id<'fld'>;
const REVIEWERS = 'fld_AssignReview0001' as Id<'fld'>;
const PLAIN = 'fld_AssignPlain00001' as Id<'fld'>;

describe('storedUsers', () => {
  const cases: [string, JsonValue, Id<'usr'>[]][] = [
    ['null', null, []],
    ['empty array', [], []],
    ['one user', [ANN], [ANN]],
    ['order kept', [BOB, ANN], [BOB, ANN]],
    ['duplicates dropped', [ANN, BOB, ANN], [ANN, BOB]],
    ['non-user ids dropped', ['rec_AssignRec000001', ANN, 'bob@example.test'], [ANN]],
    ['non-strings dropped', [1, true, null, { id: ANN }, ANN], [ANN]],
    ['a string, not an array', ANN, []],
    ['an object', { id: ANN }, []],
    ['a number', 42, []],
    ['malformed user id', ['usr_short'], []],
  ];
  it.each(cases)('%s', (_label, value, expected) => {
    expect(storedUsers(value)).toEqual(expected);
  });
});

describe('addedUsers', () => {
  const cases: [string, StoredChange, Id<'usr'>[]][] = [
    ['new record: every user', { from: null, to: [ANN, BOB] }, [ANN, BOB]],
    ['set from empty', { from: [], to: [ANN] }, [ANN]],
    ['one added', { from: [ANN], to: [ANN, BOB] }, [BOB]],
    ['replaced (single-user field)', { from: [ANN], to: [BOB] }, [BOB]],
    ['removed only', { from: [ANN, BOB], to: [ANN] }, []],
    ['cleared', { from: [ANN], to: null }, []],
    ['re-ordered', { from: [ANN, BOB], to: [BOB, ANN] }, []],
    ['unchanged', { from: [ANN], to: [ANN] }, []],
    ['added and removed at once', { from: [ANN, BOB], to: [BOB, CAT] }, [CAT]],
    ['order of the value after', { from: [], to: [CAT, ANN, BOB] }, [CAT, ANN, BOB]],
    ['malformed before counts as empty', { from: 'oops', to: [ANN] }, [ANN]],
    ['malformed after adds nobody', { from: [ANN], to: 'oops' }, []],
  ];
  it.each(cases)('%s', (_label, change, expected) => {
    expect(addedUsers(change)).toEqual(expected);
  });
});

describe('assignmentsOf', () => {
  const cases: [
    string,
    Record<string, StoredChange> | undefined,
    Id<'fld'>[],
    Id<'usr'> | null,
    [Id<'usr'>, Id<'fld'>[]][],
  ][] = [
    ['no changes', undefined, [OWNER], null, []],
    ['no flagged field', { [OWNER]: { from: null, to: [ANN] } }, [], null, []],
    ['flagged field not in changes', { [PLAIN]: { from: null, to: [ANN] } }, [OWNER], null, []],
    [
      'a field without the flag is ignored',
      { [PLAIN]: { from: [], to: [ANN] } },
      [OWNER],
      null,
      [],
    ],
    ['one assignment', { [OWNER]: { from: null, to: [ANN] } }, [OWNER], null, [[ANN, [OWNER]]]],
    [
      'two fields, one user: fields in the given order',
      { [REVIEWERS]: { from: [], to: [ANN] }, [OWNER]: { from: [], to: [ANN] } },
      [OWNER, REVIEWERS],
      null,
      [[ANN, [OWNER, REVIEWERS]]],
    ],
    [
      'users in id order',
      { [REVIEWERS]: { from: null, to: [CAT, ANN, BOB] } },
      [REVIEWERS],
      null,
      [
        [ANN, [REVIEWERS]],
        [BOB, [REVIEWERS]],
        [CAT, [REVIEWERS]],
      ],
    ],
    [
      'the actor is left out (assigning yourself)',
      { [OWNER]: { from: null, to: [ANN] }, [REVIEWERS]: { from: [], to: [ANN, BOB] } },
      [OWNER, REVIEWERS],
      ANN,
      [[BOB, [REVIEWERS]]],
    ],
    [
      'the creator of a current_user default is left out',
      { [OWNER]: { from: null, to: [BOB] } },
      [OWNER],
      BOB,
      [],
    ],
    ['removal assigns nobody', { [OWNER]: { from: [ANN], to: null } }, [OWNER], null, []],
    [
      'duplicate flagged ids count once',
      { [OWNER]: { from: null, to: [ANN] } },
      [OWNER, OWNER],
      null,
      [[ANN, [OWNER]]],
    ],
    [
      'inherited keys are not changes',
      Object.create({ [OWNER]: { from: null, to: [ANN] } }) as Record<string, StoredChange>,
      [OWNER],
      null,
      [],
    ],
  ];
  it.each(cases)('%s', (_label, changes, fields, actor, expected) => {
    expect([...assignmentsOf(changes, fields, actor)]).toEqual(expected);
  });
});
