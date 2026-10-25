import { FIELD_TYPE_NAMES } from '@cellhive/contracts';
import { describe, expect, it } from 'vitest';

import {
  FIELD_TYPE_REGISTRY,
  FIELD_TYPES,
  fieldConfigSchema,
  fieldTypeSchema,
  FILTER_OPERATORS,
  getFieldType,
  IMPLEMENTED_FIELD_TYPES,
  isImplementedFieldType,
  isS1FieldType,
  RESERVED_FIELD_TYPES,
  resolveDefaultValue,
  S1_FIELD_TYPES,
  S4_FIELD_TYPES,
  S5_FIELD_TYPES,
} from '../src/index.js';

const vi = { locale: 'vi', timeZone: 'Asia/Ho_Chi_Minh' };
const OPT = 'opt_New0000000000001';
const OPT2 = 'opt_Done000000000001';
const USR = 'usr_AAAAAAAAAAAAAAA1';

describe('field type names', () => {
  it('lists S1 storage types and reserves S4 names', () => {
    expect(S1_FIELD_TYPES).toEqual([
      'text',
      'number',
      'select',
      'datetime',
      'checkbox',
      'user',
      'created_at',
      'updated_at',
      'created_by',
      'updated_by',
      'auto_number',
    ]);
    expect(S4_FIELD_TYPES).toEqual(['attachment']);
    expect(RESERVED_FIELD_TYPES).toEqual(['link', 'parent', 'lookup', 'formula']);
    expect(S5_FIELD_TYPES).toEqual(['button']);
    expect(FIELD_TYPES).toEqual([
      ...S1_FIELD_TYPES,
      ...RESERVED_FIELD_TYPES,
      ...S4_FIELD_TYPES,
      ...S5_FIELD_TYPES,
    ]);
    expect(isImplementedFieldType('button')).toBe(false);
    expect(IMPLEMENTED_FIELD_TYPES).toEqual([...S1_FIELD_TYPES, ...S4_FIELD_TYPES]);
    expect(fieldTypeSchema.safeParse('formula').success).toBe(true);
    expect(fieldTypeSchema.safeParse('duration').success).toBe(false);
  });

  it.each([
    ['text', true],
    ['auto_number', true],
    ['link', false],
    ['nope', false],
    [1, false],
  ])('isS1FieldType(%j) -> %s', (value, expected) => {
    expect(isS1FieldType(value)).toBe(expected);
  });

  it.each([
    ['text', true],
    ['attachment', true],
    ['link', false],
    ['nope', false],
  ])('isImplementedFieldType(%j) -> %s', (value, expected) => {
    expect(isImplementedFieldType(value)).toBe(expected);
    expect(isS1FieldType('attachment')).toBe(false);
  });

  it('registry covers exactly the implemented types', () => {
    expect(Object.keys(FIELD_TYPE_REGISTRY).sort()).toEqual([...IMPLEMENTED_FIELD_TYPES].sort());
    for (const type of IMPLEMENTED_FIELD_TYPES) {
      const definition = getFieldType(type);
      expect(definition?.type).toBe(type);
      expect(definition?.supportsDefaultValue).toBe(
        ['text', 'number', 'select', 'datetime', 'user'].includes(type),
      );
      for (const op of definition?.filterOperators(definition.optionsSchema.parse({})) ?? []) {
        expect(FILTER_OPERATORS).toContain(op);
      }
    }
    expect(getFieldType('formula')).toBeUndefined();
    expect(getFieldType('lookup')).toBeUndefined();
  });

  it('only types with default_value accept one in options', () => {
    for (const type of IMPLEMENTED_FIELD_TYPES) {
      const definition = FIELD_TYPE_REGISTRY[type];
      expect(definition.optionsSchema.safeParse({ default_value: null }).success).toBe(
        definition.supportsDefaultValue,
      );
    }
  });

  it('read-only types are exactly the system-backed ones and auto_number', () => {
    expect(S1_FIELD_TYPES.filter((type) => FIELD_TYPE_REGISTRY[type].readOnly)).toEqual([
      'created_at',
      'updated_at',
      'created_by',
      'updated_by',
      'auto_number',
    ]);
  });
});

describe('fieldConfigSchema', () => {
  it.each([
    [{ type: 'text' }, { type: 'text', options: { style: { type: 'plain' } } }],
    [
      { type: 'number', options: { style: { type: 'currency', currency_code: 'VND' } } },
      { type: 'number', options: { style: { type: 'currency', currency_code: 'VND' } } },
    ],
    [
      { type: 'checkbox', options: {} },
      { type: 'checkbox', options: {} },
    ],
    [{ type: 'user' }, { type: 'user', options: { multiple: true, notify_on_assign: false } }],
    [
      { type: 'attachment' },
      {
        type: 'attachment',
        options: {
          accept: null,
          max_files: 100,
          blocked_extensions: [
            'exe',
            'msi',
            'bat',
            'cmd',
            'sh',
            'ps1',
            'app',
            'dmg',
            'jar',
            'com',
            'scr',
          ],
        },
      },
    ],
  ])('parses %j', (input, expected) => {
    expect(fieldConfigSchema.parse(input)).toEqual(expected);
  });

  it.each([
    [{ type: 'formula', options: {} }],
    [{ type: 'checkbox', options: { default_value: true } }],
    [{ type: 'number', options: { style: { type: 'currency' } } }],
  ])('rejects %j', (input) => {
    expect(fieldConfigSchema.safeParse(input).success).toBe(false);
  });
});

describe('resolveDefaultValue', () => {
  const now = new Date('2026-09-24T18:30:00.000Z'); // 25 Sep 01:30 in Ho Chi Minh City
  const ctx = { now, userId: USR, timeZone: 'Asia/Ho_Chi_Minh' };
  const parse = (input: unknown) => fieldConfigSchema.parse(input);

  it.each([
    ['text constant', parse({ type: 'text', options: { default_value: 'Mới' } }), 'Mới'],
    ['text without default', parse({ type: 'text' }), undefined],
    ['text null default', parse({ type: 'text', options: { default_value: null } }), undefined],
    ['number constant', parse({ type: 'number', options: { default_value: 0 } }), 0],
    [
      'single select',
      parse({
        type: 'select',
        options: { options: [{ id: OPT, name: 'Mới' }], default_value: OPT },
      }),
      OPT,
    ],
    [
      'multi select',
      parse({
        type: 'select',
        options: {
          multiple: true,
          options: [
            { id: OPT, name: 'Mới' },
            { id: OPT2, name: 'Xong' },
          ],
          default_value: [OPT2],
        },
      }),
      [OPT2],
    ],
    [
      'datetime slot',
      parse({
        type: 'datetime',
        options: {
          style: { format: 'dd/MM/yyyy HH:mm' },
          default_value: { $slot: 'record_created_time' },
        },
      }),
      '2026-09-24T18:30:00.000Z',
    ],
    [
      'date-only slot uses the field timezone',
      parse({ type: 'datetime', options: { default_value: { $slot: 'record_created_time' } } }),
      '2026-09-25',
    ],
    [
      'date-only slot with explicit timezone',
      parse({
        type: 'datetime',
        options: { timezone: 'America/New_York', default_value: { $slot: 'record_created_time' } },
      }),
      '2026-09-24',
    ],
    [
      'datetime constant',
      parse({ type: 'datetime', options: { default_value: '2026-01-01' } }),
      '2026-01-01',
    ],
    [
      'user current_user',
      parse({ type: 'user', options: { default_value: [{ $slot: 'current_user' }, { id: USR }] } }),
      [{ id: USR }],
    ],
    ['checkbox has no default', parse({ type: 'checkbox' }), undefined],
    ['auto_number has no default', parse({ type: 'auto_number' }), undefined],
  ])('%s', (_label, config, expected) => {
    expect(resolveDefaultValue(config, ctx)).toEqual(expected);
  });

  it('drops current_user when there is no acting user', () => {
    const config = parse({ type: 'user', options: { default_value: [{ $slot: 'current_user' }] } });
    expect(resolveDefaultValue(config, { ...ctx, userId: null })).toBeUndefined();
  });

  it('every resolved default passes validate', () => {
    const config = parse({
      type: 'datetime',
      options: {
        style: { format: 'yyyy-MM-dd HH:mm' },
        default_value: { $slot: 'record_created_time' },
      },
    });
    const value = resolveDefaultValue(config, ctx);
    expect(FIELD_TYPE_REGISTRY.datetime.validate(value, config.options as never)).toEqual({
      ok: true,
    });
  });
});

/**
 * CONTRACTS §2 — one row per storage type: json write -> storage -> json read -> text.
 */
describe('CONTRACTS §2 round trip', () => {
  const selectOptions = [
    { id: OPT, name: 'Mới' },
    { id: OPT2, name: 'Xong' },
  ];
  it.each([
    ['text', {}, 'abc', 'abc', 'abc', 'abc'],
    [
      'number',
      { style: { type: 'currency', currency_code: 'VND' } },
      1500000,
      1500000,
      1500000,
      '1.500.000 ₫',
    ],
    ['number', { style: { type: 'plain', percentage: true } }, 0.2, 0.2, 0.2, '20%'],
    ['number', { style: { type: 'rating' } }, 3, 3, 3, '★★★☆☆'],
    ['select', { options: selectOptions }, 'Mới', [OPT], 'Mới', 'Mới'],
    ['select', { options: selectOptions }, null, null, null, ''],
    [
      'select',
      { multiple: true, options: selectOptions },
      ['Mới', 'Xong'],
      [OPT, OPT2],
      ['Mới', 'Xong'],
      'Mới, Xong',
    ],
    [
      'datetime',
      { style: { format: 'dd/MM/yyyy HH:mm' }, timezone: 'Asia/Ho_Chi_Minh' },
      '2026-09-25T09:00:00+07:00',
      '2026-09-25T02:00:00.000Z',
      '2026-09-25T02:00:00.000Z',
      '25/09/2026 09:00',
    ],
    [
      'datetime',
      { style: { format: 'dd/MM/yyyy' } },
      '2026-09-25',
      '2026-09-25',
      '2026-09-25',
      '25/09/2026',
    ],
    ['checkbox', {}, true, true, true, '✓'],
    ['checkbox', {}, false, false, false, ''],
    ['user', {}, [{ id: USR }], [USR], [{ id: USR }], USR],
  ] as const)('%s %j', (type, rawOptions, write, stored, read, text) => {
    const definition = FIELD_TYPE_REGISTRY[type];
    const options: unknown = definition.optionsSchema.parse(rawOptions);
    expect(definition.validate(write, options as never)).toEqual({ ok: true });
    const storage = definition.toStorage(write, options as never);
    expect(storage).toEqual(stored);
    const json = definition.fromStorage(storage, options as never);
    expect(json).toEqual(read);
    expect(definition.formatText(json as never, options as never, vi)).toBe(text);
  });
});

describe('FIELD_TYPE_NAMES of @cellhive/contracts', () => {
  it('names exactly the registry types, in the same order', () => {
    expect([...FIELD_TYPE_NAMES]).toEqual([...FIELD_TYPES]);
  });
});
