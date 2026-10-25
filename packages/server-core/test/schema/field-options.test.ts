import { describe, expect, it } from 'vitest';

import { AppError } from '../../src/errors/app-error.js';
import { mergeFieldOptions, withNewOptionIds } from '../../src/schema/field-options.js';

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
