import { describe, expect, it } from 'vitest';

import {
  createBody,
  deletedOptions,
  draftOf,
  needsConversion,
  newOption,
  optionsOf,
  updateBody,
  validateDraft,
  type FieldDraft,
} from '../draft';

import type { FieldDto } from '@cellhive/contracts';

const NOW = '2026-09-24T00:00:00.000Z';
const OPEN = 'opt_Open000000000001';
const DONE = 'opt_Done000000000001';

function field(overrides: Partial<FieldDto>): FieldDto {
  return {
    id: 'fld_Status0000000001',
    table_id: 'tbl_Tickets000000001',
    name: 'Status',
    type: 'select',
    options: {
      multiple: false,
      options: [
        { id: OPEN, name: 'Open', color: 1 },
        { id: DONE, name: 'Done', color: 2 },
      ],
    },
    is_primary: false,
    required: false,
    unique_values: false,
    description: null,
    position: 1,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

const named = (draft: FieldDraft, name: string): FieldDraft => ({ ...draft, name });

describe('createBody', () => {
  it.each<[string, (draft: FieldDraft) => FieldDraft, Record<string, unknown>]>([
    [
      'text with defaults',
      (d) => d,
      { name: 'Title', type: 'text', options: { style: { type: 'plain' }, default_value: null } },
    ],
    [
      'text url, required, unique, description',
      (d) => ({
        ...d,
        text: { style: { type: 'url' }, default_value: 'https://x.test' },
        required: true,
        unique: true,
        description: '  Link  ',
      }),
      {
        name: 'Title',
        type: 'text',
        options: { style: { type: 'url' }, default_value: 'https://x.test' },
        description: 'Link',
        required: true,
        unique_values: true,
      },
    ],
    [
      'currency number',
      (d) => ({
        ...d,
        type: 'number',
        number: { style: { type: 'currency', currency_code: 'VND' }, default_value: 0 },
      }),
      {
        name: 'Title',
        type: 'number',
        options: { style: { type: 'currency', currency_code: 'VND' }, default_value: 0 },
      },
    ],
    [
      'select: new options have no id',
      (d) => ({
        ...d,
        type: 'select',
        select: { multiple: true, options: [newOption(' A ', 3)], defaultOptionId: null },
      }),
      {
        name: 'Title',
        type: 'select',
        options: { multiple: true, options: [{ name: 'A', color: 3 }] },
      },
    ],
    [
      'checkbox has no options; required allowed',
      (d) => ({ ...d, type: 'checkbox', required: true }),
      { name: 'Title', type: 'checkbox', required: true },
    ],
    [
      'created_by: required/unique ignored',
      (d) => ({ ...d, type: 'created_by', required: true, unique: true }),
      { name: 'Title', type: 'created_by' },
    ],
    [
      'user: current user default',
      (d) => ({ ...d, type: 'user', user: { ...d.user, defaultCurrentUser: true } }),
      {
        name: 'Title',
        type: 'user',
        options: {
          multiple: true,
          notify_on_assign: false,
          default_value: [{ $slot: 'current_user' }],
        },
      },
    ],
    [
      'datetime with zone and created-time default',
      (d) => ({
        ...d,
        type: 'datetime',
        datetime: {
          style: { format: 'dd/MM/yyyy HH:mm' },
          timezone: 'Asia/Ho_Chi_Minh',
          default_value: { $slot: 'record_created_time' },
        },
      }),
      {
        name: 'Title',
        type: 'datetime',
        options: {
          style: { format: 'dd/MM/yyyy HH:mm' },
          default_value: { $slot: 'record_created_time' },
          timezone: 'Asia/Ho_Chi_Minh',
        },
      },
    ],
    [
      'auto number rules',
      (d) => ({
        ...d,
        type: 'auto_number',
        autoNumber: {
          style: {
            rules: [
              { type: 'text', text: 'TK-' },
              { type: 'incremental_number', length: 4 },
            ],
          },
        },
      }),
      {
        name: 'Title',
        type: 'auto_number',
        options: {
          style: {
            rules: [
              { type: 'text', text: 'TK-' },
              { type: 'incremental_number', length: 4 },
            ],
          },
        },
      },
    ],
  ])('%s', (_label, change, expected) => {
    expect(createBody(change(named(draftOf(), ' Title ')))).toEqual(expected);
  });
});

describe('validateDraft', () => {
  it.each<[string, (draft: FieldDraft) => FieldDraft, string[]]>([
    ['valid text', (d) => d, []],
    ['empty name', (d) => named(d, '   '), ['name:REQUIRED']],
    ['name too long', (d) => named(d, 'x'.repeat(256)), ['name:TOO_BIG']],
    [
      'duplicate and empty option names',
      (d) => ({
        ...d,
        type: 'select',
        select: {
          multiple: false,
          options: [
            { ...newOption('A', 0), key: 'opt_Key0000000000001' },
            { ...newOption('A', 1), key: 'opt_Key0000000000002' },
            { ...newOption(' ', 2), key: 'opt_Key0000000000003' },
          ],
          defaultOptionId: null,
        },
      }),
      [
        'option.opt_Key0000000000002.name:DUPLICATE_OPTION',
        'option.opt_Key0000000000003.name:REQUIRED',
      ],
    ],
    [
      'deleted options are not checked',
      (d) => ({
        ...d,
        type: 'select',
        select: {
          multiple: false,
          options: [
            { ...newOption('A', 0), id: OPEN, key: OPEN, deleted: true },
            { ...newOption('A', 1), key: 'opt_Key0000000000002' },
          ],
          defaultOptionId: null,
        },
      }),
      [],
    ],
    [
      'empty auto number text rule',
      (d) => ({
        ...d,
        type: 'auto_number',
        autoNumber: { style: { rules: [{ type: 'text', text: '' }] } },
      }),
      ['options.style.rules.0.text:REQUIRED'],
    ],
    [
      'unknown currency',
      (d) => ({
        ...d,
        type: 'number',
        number: { style: { type: 'currency', currency_code: 'ZZZ' } },
      }),
      ['options.style.currency_code:INVALID'],
    ],
  ])('%s', (_label, change, expected) => {
    const { issues } = validateDraft(change(named(draftOf(), 'Title')));
    expect(issues.map((issue) => `${issue.path}:${issue.detail.code}`)).toEqual(expected);
  });

  it('parses the config for the preview when valid', () => {
    const { config } = validateDraft({ ...named(draftOf(), 'N'), type: 'number' });
    expect(config).toMatchObject({ type: 'number', options: { style: { type: 'plain' } } });
  });
});

describe('updateBody', () => {
  it('sends nothing when nothing changed', () => {
    const status = field({});
    expect(updateBody(status, draftOf(status))).toBeNull();
  });

  it('sends only the changed keys', () => {
    const status = field({ description: 'Old' });
    const draft = { ...draftOf(status), name: 'State', description: '', required: true };
    expect(updateBody(status, draft)).toEqual({ name: 'State', description: null, required: true });
  });

  it('keeps option ids on rename/recolor/reorder, adds new ones, drops deleted ones', () => {
    const status = field({});
    const base = draftOf(status);
    const [open, done] = base.select.options;
    if (open === undefined || done === undefined) throw new Error('fixture');
    const draft: FieldDraft = {
      ...base,
      select: {
        ...base.select,
        options: [
          { ...done, name: 'Closed', color: 5 },
          { ...open, deleted: true },
          newOption('Waiting', 3),
        ],
      },
    };
    expect(updateBody(status, draft)).toEqual({
      options: {
        multiple: false,
        options: [
          { id: DONE, name: 'Closed', color: 5 },
          { name: 'Waiting', color: 3 },
        ],
        default_value: null,
      },
    });
    expect(deletedOptions(draft).map((option) => option.id)).toEqual([OPEN]);
  });
});

describe('needsConversion', () => {
  it.each<[string, Partial<FieldDto>, (draft: FieldDraft) => FieldDraft, boolean]>([
    ['same type', {}, (d) => d, false],
    ['other type', {}, (d) => ({ ...d, type: 'text' }), true],
    [
      'select single → multiple',
      {},
      (d) => ({ ...d, select: { ...d.select, multiple: true } }),
      false,
    ],
    [
      'select multiple → single',
      { options: { multiple: true, options: [] } },
      (d) => ({ ...d, select: { ...d.select, multiple: false } }),
      true,
    ],
    [
      'user multiple → single',
      { type: 'user', options: {} },
      (d) => ({ ...d, user: { ...d.user, multiple: false } }),
      true,
    ],
  ])('%s', (_label, overrides, change, expected) => {
    const current = field(overrides);
    expect(needsConversion(current, change(draftOf(current)))).toBe(expected);
  });
});

describe('optionsOf', () => {
  it('gives new select options their key as id only for validation', () => {
    const option = newOption('A', 0);
    const draft: FieldDraft = {
      ...draftOf(),
      type: 'select',
      select: { multiple: false, options: [option], defaultOptionId: null },
    };
    expect(optionsOf(draft)).toMatchObject({ options: [{ name: 'A', color: 0 }] });
    expect(optionsOf(draft, true)).toMatchObject({ options: [{ id: option.key, name: 'A' }] });
  });
});
