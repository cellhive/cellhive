import { describe, expect, it } from 'vitest';

import {
  FIELD_TYPE_NAMES,
  SHARED_FIELD_OPTION_KEYS,
  shareFileUrl,
  sharedFieldOptions,
} from '../src/index.js';

const TABLE = 'tbl_Customers00000001';
const FIELD = 'fld_Reverse000000001';

/** T409: `meta.fields[].options` through a share link keep display keys only. */
describe('sharedFieldOptions', () => {
  it.each<[string, string, Record<string, unknown>, 'view' | 'form', Record<string, unknown>]>([
    [
      'link: no linked table, reverse field or record filter',
      'link',
      {
        link_table: TABLE,
        bidirectional: true,
        bidirectional_link_field_name: 'Orders',
        allow_multiple: false,
        record_filter: { op: 'and', items: [{ field: FIELD, operator: 'is_not_empty' }] },
        symmetric_field_id: FIELD,
      },
      'view',
      { allow_multiple: false },
    ],
    ['parent: nothing', 'parent', { anything: TABLE }, 'view', {}],
    [
      'attachment in a view: no file rules',
      'attachment',
      { accept: ['image/*'], max_files: 3, blocked_extensions: ['exe'] },
      'view',
      {},
    ],
    [
      'attachment in a form: its upload rules',
      'attachment',
      { accept: ['image/*'], max_files: 3, blocked_extensions: ['exe'] },
      'form',
      { accept: ['image/*'], max_files: 3, blocked_extensions: ['exe'] },
    ],
    [
      'formula: only the style, never the expression (T462)',
      'formula',
      { expression: `{${FIELD}} * 2`, style: { type: 'currency' } },
      'view',
      { style: { type: 'currency' } },
    ],
    [
      'lookup: only the style, never the source (T462)',
      'lookup',
      { from: 'tbl_Customers0000001', select: FIELD, where: {}, aggregate: 'sum', style: null },
      'form',
      { style: null },
    ],
    ['lookup: never the target', 'lookup', { link_field: FIELD, target_field: FIELD }, 'view', {}],
    [
      'user: never default users',
      'user',
      { multiple: false, notify_on_assign: true, default_value: [{ id: 'usr_Someone00000001' }] },
      'form',
      { multiple: false },
    ],
    [
      'text in a view: style only',
      'text',
      { style: { type: 'email' }, default_value: 'x' },
      'view',
      { style: { type: 'email' } },
    ],
    [
      'text in a form: style and default',
      'text',
      { style: { type: 'plain' }, default_value: 'x' },
      'form',
      { style: { type: 'plain' }, default_value: 'x' },
    ],
    [
      'select: its options',
      'select',
      { multiple: true, options: [{ id: 'opt_A', name: 'A' }], default_value: null },
      'view',
      { multiple: true, options: [{ id: 'opt_A', name: 'A' }] },
    ],
    [
      'datetime: format and zone',
      'datetime',
      { style: { format: 'dd/MM/yyyy' }, timezone: 'Asia/Ho_Chi_Minh', default_value: null },
      'view',
      { style: { format: 'dd/MM/yyyy' }, timezone: 'Asia/Ho_Chi_Minh' },
    ],
    ['unknown type: nothing', 'mystery', { style: {} }, 'view', {}],
  ])('%s', (_label, type, options, target, expected) => {
    expect(sharedFieldOptions(type, options, target)).toEqual(expected);
  });

  it.each([null, 'x', 1, [1, 2]])('gives {} for options %j', (options) => {
    expect(sharedFieldOptions('text', options, 'view')).toEqual({});
  });

  it('has an entry for every field type', () => {
    expect(Object.keys(SHARED_FIELD_OPTION_KEYS).sort()).toEqual([...FIELD_TYPE_NAMES].sort());
  });

  it('builds share file URLs', () => {
    expect(shareFileUrl('tok-en_', 'att_X')).toBe('/api/v1/shares/tok-en_/files/att_X');
    expect(shareFileUrl('a/b', 'att_X', true)).toBe('/api/v1/shares/a%2Fb/files/att_X/thumbnail');
  });
});
