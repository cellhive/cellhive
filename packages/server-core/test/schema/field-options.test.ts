import { describe, expect, it } from 'vitest';

import { AppError } from '../../src/errors/app-error.js';
import {
  mergeFieldOptions,
  upsertSelectOptions,
  withNewOptionIds,
} from '../../src/schema/field-options.js';

const A = 'opt_AAAAAAAAAAAAAAA1';
const B = 'opt_BBBBBBBBBBBBBBB1';
const OPT_ID = /^opt_[0-9A-Za-z]{16}$/;

describe('withNewOptionIds', () => {
  it('gives select options without id a fresh id and leaves the rest alone', () => {
    const result = withNewOptionIds('select', {
      multiple: true,
      options: [{ name: 'New' }, { id: A, name: 'Kept' }],
    }) as { multiple: boolean; options: { id: string; name: string }[] };
    expect(result.multiple).toBe(true);
    expect(result.options[0]?.id).toMatch(OPT_ID);
    expect(result.options[1]).toEqual({ id: A, name: 'Kept' });
  });

  it.each([
    ['text', { style: { type: 'url' } }],
    ['select', undefined],
    ['select', { options: 'not a list' }],
  ] as const)('returns %s options %j unchanged', (type, options) => {
    expect(withNewOptionIds(type, options as Record<string, unknown> | undefined)).toBe(options);
  });
});

describe('mergeFieldOptions', () => {
  const current = {
    multiple: true,
    options: [
      { id: A, name: 'A' },
      { id: B, name: 'B' },
    ],
    default_value: [A, B],
  };

  it('replaces top-level keys only', () => {
    expect(
      mergeFieldOptions(
        'number',
        { style: { type: 'plain' }, default_value: 1 },
        { default_value: 2 },
      ),
    ).toEqual({ style: { type: 'plain' }, default_value: 2 });
    expect(mergeFieldOptions('select', current, { multiple: true })).toEqual(current);
  });

  it('keeps known ids, adds new options and drops removed ones from default_value', () => {
    const merged = mergeFieldOptions('select', current, {
      options: [{ id: B, name: 'Renamed', color: 4 }, { name: 'C' }],
    }) as typeof current & { options: { id: string; name: string }[] };
    expect(merged.options[0]).toEqual({ id: B, name: 'Renamed', color: 4 });
    expect(merged.options[1]?.id).toMatch(OPT_ID);
    expect(merged.default_value).toEqual([B]);
  });

  it('clears a single default that was removed, unless the patch sets one', () => {
    const single = { multiple: false, options: [{ id: A, name: 'A' }], default_value: A };
    expect(mergeFieldOptions('select', single, { options: [] }).default_value).toBeNull();
    expect(
      mergeFieldOptions('select', single, { options: [{ name: 'X' }], default_value: null })
        .default_value,
    ).toBeNull();
  });

  it('keeps options added concurrently since the base the patch was made from', () => {
    const base = { options: [{ id: A, name: 'A' }] };
    const locked = {
      options: [
        { id: A, name: 'A' },
        { id: B, name: 'Added meanwhile' },
      ],
      default_value: [A, B],
    };
    const merged = mergeFieldOptions(
      'select',
      locked,
      { options: [{ id: A, name: 'A' }, { name: 'Mine' }] },
      base,
    ) as { options: { id: string; name: string }[]; default_value: string[] };
    expect(merged.options.map((option) => option.name)).toEqual(['A', 'Mine', 'Added meanwhile']);
    expect(merged.default_value).toEqual([A, B]);
    // An option the caller saw and left out is still deleted.
    const deleted = mergeFieldOptions(
      'select',
      locked,
      { options: [{ id: B, name: 'B' }] },
      locked,
    );
    expect(deleted.options).toEqual([{ id: B, name: 'B' }]);
  });

  it('refuses ids the field does not have (UNKNOWN_OPTION)', () => {
    let error: unknown;
    try {
      mergeFieldOptions('select', current, {
        options: [
          { id: A, name: 'A' },
          { id: 'opt_ZZZZZZZZZZZZZZZ1', name: 'Z' },
        ],
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [expect.objectContaining({ path: 'options.options[1].id', code: 'UNKNOWN_OPTION' })],
    });
  });
});

/**
 * Quyết định S9 #36 (MCP `update_field`, CONTRACTS §30.7): with
 * `keepUnlisted`, the options of a patch are an upsert computed from the
 * options read under the lock — no option is ever deleted, also one added
 * after the caller read the field.
 */
describe('mergeFieldOptions with keepUnlisted', () => {
  const C = 'opt_CCCCCCCCCCCCCCC1';
  /** Under the lock: B was added by someone else after the caller read [A]. */
  const locked = {
    multiple: false,
    options: [
      { id: A, name: 'A', color: 1 },
      { id: B, name: 'Added meanwhile', color: 2 },
      { id: C, name: 'C' },
    ],
    default_value: B,
  };
  const keep = { keepUnlisted: true } as const;
  type Merged = { options: { id: string; name: string; color?: number }[]; default_value: unknown };

  it.each<[string, unknown[], (string | undefined)[], [string, number | undefined][]]>([
    [
      'an empty list keeps every option',
      [],
      [A, B, C],
      [
        ['A', 1],
        ['Added meanwhile', 2],
        ['C', undefined],
      ],
    ],
    [
      'a name the field has is updated in place, keeping its id',
      [{ name: 'C', color: 7 }],
      [A, B, C],
      [
        ['A', 1],
        ['Added meanwhile', 2],
        ['C', 7],
      ],
    ],
    [
      'a new name is added at the end with a fresh id, nothing else moves',
      [{ name: 'A' }, { name: 'New', color: 3 }],
      [A, B, C, undefined],
      [
        ['A', 1],
        ['Added meanwhile', 2],
        ['C', undefined],
        ['New', 3],
      ],
    ],
    [
      'an item with an id updates that option in place (rename)',
      [{ id: C, name: 'C renamed' }],
      [A, B, C],
      [
        ['A', 1],
        ['Added meanwhile', 2],
        ['C renamed', undefined],
      ],
    ],
  ])('%s', (_case, items, ids, namesAndColors) => {
    const merged = mergeFieldOptions(
      'select',
      locked,
      { options: items },
      // The caller's base, which lacks B: it plays no part in this mode.
      { options: [{ id: A, name: 'A' }] },
      keep,
    ) as unknown as Merged;
    expect(merged.options.map((option) => [option.name, option.color])).toEqual(namesAndColors);
    const known = ids.filter((id): id is string => id !== undefined);
    expect(merged.options.slice(0, known.length).map((option) => option.id)).toEqual(known);
    for (const option of merged.options.slice(known.length)) expect(option.id).toMatch(OPT_ID);
    // Nothing removed: the default stays.
    expect(merged.default_value).toBe(B);
  });

  it('without the mode, the same patch made from the old base would still keep B (concurrent)', () => {
    const merged = mergeFieldOptions(
      'select',
      locked,
      { options: [{ id: A, name: 'A' }] },
      {
        options: [
          { id: A, name: 'A' },
          { id: C, name: 'C' },
        ],
      },
    ) as unknown as Merged;
    // …but C, seen by the caller and left out, is deleted: the mode is what keeps it.
    expect(merged.options.map((option) => option.name)).toEqual(['A', 'Added meanwhile']);
  });

  it('refuses ids the field does not have (UNKNOWN_OPTION), at the input index', () => {
    expect(() =>
      upsertSelectOptions(locked.options, [
        { name: 'X' },
        { id: 'opt_ZZZZZZZZZZZZZZZ1', name: 'Z' },
      ]),
    ).toThrow(
      expect.objectContaining({
        code: 'VALIDATION_FAILED',
        errors: [
          expect.objectContaining({ path: 'options.options[1].id', code: 'UNKNOWN_OPTION' }),
        ],
      }) as Error,
    );
  });

  it('leaves other types and patches without a list alone', () => {
    expect(
      mergeFieldOptions('number', { precision: 1 }, { precision: 2 }, undefined, keep),
    ).toEqual({ precision: 2 });
    expect(mergeFieldOptions('select', locked, { multiple: true }, undefined, keep)).toEqual({
      ...locked,
      multiple: true,
    });
  });
});
