import { describe, expect, it } from 'vitest';

import {
  foldFilter,
  foldTransition,
  type FilterCondition,
  type FilterNode,
  type FoldedFilter,
  type FilterValue,
  type ResolveContext,
  type TransitionImages,
} from '../src/index.js';

import { fld, opt, rec, table, usr } from './fixture.js';

const resolve: ResolveContext = {
  userId: usr.an,
  groupMemberUserIds: [usr.an, usr.binh],
  timeZone: 'Asia/Ho_Chi_Minh',
  now: new Date('2026-09-23T03:00:00.000Z'),
};

const TRUE: FoldedFilter<FilterValue> = { kind: 'constant', value: true };
const FALSE: FoldedFilter<FilterValue> = { kind: 'constant', value: false };
const kept = (filter: FilterNode): FoldedFilter<FilterValue> => ({ kind: 'filter', filter });

const urgent: FilterNode = { field: fld.status, operator: 'is', value: opt.done };
const bigAmount: FilterNode = { field: fld.amount, operator: 'gt', value: 100 };
const titled: FilterNode = { field: fld.title, operator: 'is_not_empty' };

describe('foldFilter', () => {
  const decideStatus = (leaf: { field: string }) => (leaf.field === fld.status ? true : undefined);
  const cases: [string, FilterNode, FoldedFilter<FilterValue>][] = [
    ['a decided leaf', urgent, TRUE],
    ['an undecided leaf is kept', bigAmount, kept(bigAmount)],
    ['and: a true item is dropped', { op: 'and', items: [urgent, bigAmount] }, kept(bigAmount)],
    ['or: a true item decides', { op: 'or', items: [bigAmount, urgent] }, TRUE],
    ['not of a constant', { op: 'not', item: urgent }, FALSE],
    ['not of a kept leaf', { op: 'not', item: bigAmount }, kept({ op: 'not', item: bigAmount })],
    [
      'two kept items stay a group',
      { op: 'or', items: [bigAmount, titled, { op: 'not', item: urgent }] },
      kept({ op: 'or', items: [bigAmount, titled] }),
    ],
    ['an empty and is true', { op: 'and', items: [] }, TRUE],
    ['an empty or is false', { op: 'or', items: [] }, FALSE],
  ];
  it.each(cases)('%s', (_label, node, expected) => {
    expect(foldFilter(node, decideStatus)).toEqual(expected);
  });
});

describe('foldTransition', () => {
  interface Case {
    readonly label: string;
    readonly condition: FilterNode;
    readonly images: TransitionImages;
    readonly before: FoldedFilter<FilterValue>;
    readonly after: FoldedFilter<FilterValue>;
  }
  const changed = (
    from: Record<string, unknown>,
    to: Record<string, unknown>,
  ): TransitionImages => ({ before: from, after: to, changed: Object.keys(to) });

  const cases: Case[] = [
    {
      label: 'select: into the value',
      condition: urgent,
      images: changed({ [fld.status]: [opt.new] }, { [fld.status]: [opt.done] }),
      before: FALSE,
      after: TRUE,
    },
    {
      label: 'select: out of the value',
      condition: urgent,
      images: changed({ [fld.status]: [opt.done] }, { [fld.status]: [opt.new] }),
      before: TRUE,
      after: FALSE,
    },
    {
      label: 'null before (cleared cell) → value',
      condition: urgent,
      images: changed({ [fld.status]: null }, { [fld.status]: [opt.done] }),
      before: FALSE,
      after: TRUE,
    },
    {
      label: 'a new record: no before image, the condition is false before',
      condition: urgent,
      images: { before: null, after: { [fld.status]: [opt.done] }, changed: [fld.status] },
      before: FALSE,
      after: TRUE,
    },
    {
      label: 'a new record with an empty cell (not in changes) keeps the leaf for after',
      condition: { op: 'and', items: [urgent, bigAmount] },
      images: { before: null, after: { [fld.status]: [opt.done] }, changed: [fld.status] },
      before: FALSE,
      after: kept(bigAmount),
    },
    {
      label: 'multiple select: has_any_of gains a value',
      condition: { field: fld.tags, operator: 'has_any_of', value: [opt.b] },
      images: changed({ [fld.tags]: [opt.a] }, { [fld.tags]: [opt.a, opt.b] }),
      before: FALSE,
      after: TRUE,
    },
    {
      label: 'multiple select: has_all_of still missing one',
      condition: { field: fld.tags, operator: 'has_all_of', value: [opt.a, opt.b] },
      images: changed({ [fld.tags]: null }, { [fld.tags]: [opt.b] }),
      before: FALSE,
      after: FALSE,
    },
    {
      label: 'link: a record linked',
      condition: { field: fld.customer, operator: 'has_any_of', value: [rec.r1] },
      images: changed({ [fld.customer]: [rec.r2] }, { [fld.customer]: [rec.r2, rec.r1] }),
      before: FALSE,
      after: TRUE,
    },
    {
      label: 'link: emptied',
      condition: { field: fld.customer, operator: 'is_empty' },
      images: changed({ [fld.customer]: [rec.r1] }, { [fld.customer]: null }),
      before: FALSE,
      after: TRUE,
    },
    {
      label: 'user: assigned to the current user ($var resolved as run_as)',
      condition: { field: fld.owner, operator: 'has_any_of', value: [{ $var: 'current_user' }] },
      images: changed({ [fld.owner]: [usr.chi] }, { [fld.owner]: [usr.an] }),
      before: FALSE,
      after: TRUE,
    },
    {
      label: 'number: storage-form string (numeric) crosses the threshold',
      condition: bigAmount,
      images: changed({ [fld.amount]: '100' }, { [fld.amount]: 100.5 }),
      before: FALSE,
      after: TRUE,
    },
    {
      label: 'number: stays above',
      condition: bigAmount,
      images: changed({ [fld.amount]: 150 }, { [fld.amount]: 200 }),
      before: TRUE,
      after: TRUE,
    },
    {
      label: 'date only: becomes today (relative date at event time)',
      condition: { field: fld.due, operator: 'is', value: { $date: { relative: 'today' } } },
      images: changed({ [fld.due]: '2026-09-30' }, { [fld.due]: '2026-09-23' }),
      before: FALSE,
      after: TRUE,
    },
    {
      label: 'datetime: before an exact day',
      condition: {
        field: fld.dueAt,
        operator: 'before',
        value: { $date: { exact: '2026-10-01' } },
      },
      images: changed(
        { [fld.dueAt]: '2026-10-02T08:00:00.000Z' },
        { [fld.dueAt]: '2026-09-02T08:00:00.000Z' },
      ),
      before: FALSE,
      after: TRUE,
    },
    {
      label: 'checkbox: ticked (null reads as false)',
      condition: { field: fld.done, operator: 'is', value: true },
      images: changed({ [fld.done]: null }, { [fld.done]: true }),
      before: FALSE,
      after: TRUE,
    },
    {
      label: 'unchanged field: kept on both sides (current value decides)',
      condition: { op: 'and', items: [urgent, titled] },
      images: changed({ [fld.status]: [opt.new] }, { [fld.status]: [opt.done] }),
      before: FALSE,
      after: kept(titled),
    },
    {
      label: 'no changed field in the condition: both sides identical',
      condition: { op: 'or', items: [bigAmount, titled] },
      images: changed({ [fld.status]: [opt.new] }, { [fld.status]: [opt.done] }),
      before: kept({ op: 'or', items: [bigAmount, titled] }),
      after: kept({ op: 'or', items: [bigAmount, titled] }),
    },
    {
      label: 'not over a changed field',
      condition: { op: 'not', item: urgent },
      images: changed({ [fld.status]: [opt.done] }, { [fld.status]: [opt.new] }),
      before: FALSE,
      after: TRUE,
    },
  ];

  it.each(cases)('$label', ({ condition, images, before, after }) => {
    expect(foldTransition(condition, images, { table, resolve })).toEqual({ before, after });
  });

  it('a field the table does not know is false on both sides', () => {
    const ghost: FilterCondition = { field: 'fld_ghost00000000000', operator: 'is_empty' };
    expect(
      foldTransition(
        ghost,
        { before: { [ghost.field]: 1 }, after: { [ghost.field]: null }, changed: [ghost.field] },
        { table, resolve },
      ),
    ).toEqual({ before: FALSE, after: FALSE });
  });
});
