import { describe, expect, it } from 'vitest';

import {
  isLinkValue,
  keepKnownTitles,
  linkDisplayValue,
  linkRefsOf,
  linkText,
  linkWriteValue,
  pastedLinkValue,
} from '../values';

const A = 'rec_AAAAAAAAAAAAAAAA';
const B = 'rec_BBBBBBBBBBBBBBBB';
const C = 'rec_CCCCCCCCCCCCCCCC';

describe('link cell values (CONTRACTS §2, T413)', () => {
  it.each([
    [null, []],
    ['An Phát', []],
    [
      [{ id: A, title: 'An Phát' }, { id: B, title: null }, { nope: 1 }, 'x'],
      [
        { id: A, title: 'An Phát' },
        { id: B, title: null },
      ],
    ],
    [[{ id: A }], [{ id: A, title: null }]],
  ])('linkRefsOf(%j)', (value, expected) => {
    expect(linkRefsOf(value)).toEqual(expected);
  });

  it('copies readable titles only, never an id (P20)', () => {
    expect(
      linkText([
        { id: A, title: 'An Phát' },
        { id: B, title: null },
        { id: C, title: 'Bình Minh' },
      ]),
    ).toBe('An Phát, Bình Minh');
    expect(linkText([{ id: B, title: null }])).toBe('');
  });

  it('writes ids in order; an empty choice clears the cell', () => {
    const refs = [
      { id: B, title: null },
      { id: A, title: 'An Phát' },
    ];
    expect(linkWriteValue(refs)).toEqual([B, A]);
    expect(linkWriteValue([])).toBeNull();
    expect(linkDisplayValue(refs)).toEqual(refs);
    expect(linkDisplayValue([])).toBeNull();
  });

  it.each([
    ['An Phát, Bình Minh', ['An Phát', 'Bình Minh']],
    ['  An Phát ,, Bình Minh , ', ['An Phát', 'Bình Minh']],
    ['An Phát\nAn Phát', ['An Phát']],
    [A, [A]],
    [' , ', null],
    ['', null],
  ])('pasted %j', (text, expected) => {
    expect(pastedLinkValue(text)).toEqual(expected);
  });

  it('recognises the read shape of a link cell', () => {
    expect(isLinkValue([{ id: A, title: null }])).toBe(true);
    expect(isLinkValue([{ id: 'usr_AAAAAAAAAAAAAAAA', name: 'x' }])).toBe(false);
    expect(isLinkValue([])).toBe(false);
    expect(isLinkValue('An Phát')).toBe(false);
  });
});

describe('keepKnownTitles: realtime patches with withheld titles (CONTRACTS §7)', () => {
  const before = [
    { id: A, title: 'An Phát' },
    { id: B, title: 'Bình Minh' },
  ];

  it('keeps the titles the cell showed for the same records', () => {
    const after = [
      { id: A, title: null },
      { id: B, title: null },
    ];
    expect(keepKnownTitles(before, after)).toEqual({ value: before, unknownTitles: false });
  });

  it('reports a new record without title (fetched again), keeps known ones', () => {
    const after = [
      { id: A, title: null },
      { id: C, title: null },
    ];
    expect(keepKnownTitles(before, after)).toEqual({
      value: [
        { id: A, title: 'An Phát' },
        { id: C, title: null },
      ],
      unknownTitles: true,
    });
  });

  it('takes readable titles as they come (a rename) and leaves other values alone', () => {
    const after = [{ id: A, title: 'An Phát Group' }];
    expect(keepKnownTitles(before, after).value).toBe(after);
    expect(keepKnownTitles('x', 'y')).toEqual({ value: 'y', unknownTitles: false });
    expect(keepKnownTitles(before, null)).toEqual({ value: null, unknownTitles: false });
  });

  it('a record that was already unreadable stays locked', () => {
    const locked = [{ id: C, title: null }];
    expect(keepKnownTitles(locked, locked)).toEqual({ value: locked, unknownTitles: false });
  });
});
