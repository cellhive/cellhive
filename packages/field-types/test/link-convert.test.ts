import { describe, expect, it } from 'vitest';

import {
  classifyLinkConversion,
  keptLink,
  LINK_OTHER_TYPE_PLAN,
  parseLinkOptions,
  type LinkConversionPlan,
} from '../src/index.js';

const TBL_A = 'tbl_Aaaaaaaaaaaaaaa1';
const TBL_B = 'tbl_Bbbbbbbbbbbbbbb1';
const FLD_R = 'fld_Rrrrrrrrrrrrrrr1';

const oneWay = parseLinkOptions({ link_table: TBL_A });
const twoWay = parseLinkOptions({
  link_table: TBL_A,
  bidirectional: true,
  bidirectional_link_field_name: 'Orders',
  symmetric_field_id: FLD_R,
});
const single = parseLinkOptions({ link_table: TBL_A, allow_multiple: false });
const twoWaySingle = parseLinkOptions({ ...twoWay, allow_multiple: false });

describe('classifyLinkConversion (ADR-28, CONTRACTS §4)', () => {
  it.each<[string, unknown, unknown, LinkConversionPlan]>([
    ['nothing', oneWay, oneWay, { kind: 'none', change: null, refusal: null }],
    [
      'record_filter only',
      oneWay,
      { ...oneWay, record_filter: { op: 'and', items: [] } },
      { kind: 'none', change: null, refusal: null },
    ],
    [
      'allow_multiple false → true',
      single,
      { ...single, allow_multiple: true },
      { kind: 'none', change: null, refusal: null },
    ],
    [
      'one-way → two-way',
      oneWay,
      { ...oneWay, bidirectional: true, bidirectional_link_field_name: 'Orders' },
      { kind: 'keep', change: 'to_two_way', refusal: null },
    ],
    [
      'two-way → one-way',
      twoWay,
      { ...twoWay, bidirectional: false },
      { kind: 'keep', change: 'to_one_way', refusal: null },
    ],
    [
      'allow_multiple true → false',
      oneWay,
      { ...oneWay, allow_multiple: false },
      { kind: 'truncate', change: 'to_single', refusal: null },
    ],
    [
      'allow_multiple true → false on a two-way link',
      twoWay,
      twoWaySingle,
      { kind: 'truncate', change: 'to_single', refusal: null },
    ],
    [
      'two-way single → one-way single',
      twoWaySingle,
      { ...twoWaySingle, bidirectional: false },
      { kind: 'keep', change: 'to_one_way', refusal: null },
    ],
    [
      'symmetric_field_id and the reverse name are read-only',
      twoWay,
      { ...twoWay, symmetric_field_id: null, bidirectional_link_field_name: 'x' },
      { kind: 'none', change: null, refusal: null },
    ],
    [
      'another linked table',
      oneWay,
      { ...oneWay, link_table: TBL_B },
      { kind: 'forbidden', change: null, refusal: 'link_table' },
    ],
    [
      'two changes at once',
      oneWay,
      { ...oneWay, bidirectional: true, allow_multiple: false },
      { kind: 'forbidden', change: null, refusal: 'several_changes' },
    ],
  ])('%s', (_name, from, to, expected) => {
    expect(classifyLinkConversion(parseLinkOptions(from), parseLinkOptions(to))).toEqual(expected);
  });

  it('link ↔ another type is forbidden', () => {
    expect(LINK_OTHER_TYPE_PLAN).toEqual({
      kind: 'forbidden',
      change: null,
      refusal: 'other_type',
    });
  });
});

describe('keptLink (CONTRACTS §4.2: the first link of the cell)', () => {
  it.each<[string, { id: string; live: boolean }[], string | null]>([
    ['empty cell', [], null],
    [
      'first by position',
      [
        { id: 'a', live: true },
        { id: 'b', live: true },
      ],
      'a',
    ],
    [
      'live links before trashed ones',
      [
        { id: 'a', live: false },
        { id: 'b', live: true },
      ],
      'b',
    ],
    [
      'only trashed links: the first',
      [
        { id: 'a', live: false },
        { id: 'b', live: false },
      ],
      'a',
    ],
  ])('%s', (_name, links, expected) => {
    expect(keptLink(links)?.id ?? null).toBe(expected);
  });
});
